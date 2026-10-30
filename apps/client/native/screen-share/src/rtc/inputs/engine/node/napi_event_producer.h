#pragma once

// Everything the native engine runs off the Node thread: queueing its events into the thread-safe function and
// faulting the queue. Nothing here touches napi_env.
// Part of the single napi_engine.cc translation unit, which is the only file that includes it.

#include "napi_state.h"

namespace {

napi_status QueueEventLocked(State& state, void* data) noexcept {
  auto* context = state.event_context;
  if (!state.tsfn || !context) return napi_closing;
  context->RetainPending();
  const auto status = napi_call_threadsafe_function(state.tsfn, data, napi_tsfn_nonblocking);
  if (status == napi_closing) {
    // Some runtimes consumed the producer ref while returning this status.
    // Neither cleanup nor another producer may touch/release this handle again.
    state.tsfn = nullptr;
    state.event_context = nullptr;
  }
  if (status != napi_ok) (void)context->ReleasePending();
  return status;
}

void FaultLocked(State& state, MonkyEngineStatus status) noexcept {
  MonkyEngineStatus expected = MONKY_ENGINE_OK;
  state.delivery_fault.compare_exchange_strong(expected, status);
  if (!state.tsfn) return;
  (void)QueueEventLocked(state, nullptr);
}

void WaitForEventDrain(const StateOwner& state) {
  std::unique_lock lock(state->event_mutex);
  state->events_drained.wait(lock, [&] { return state->tsfn_finished.load(); });
}

void RememberUnusedTransferLocked(State& state, uint64_t id, uint64_t target) {
  // Monotonic IDs permit bounded history when the DLL suppresses these events.
  // A completion older than this history faults rather than guessing ownership.
  if (state.unused_transfers.size() >= kEventQueueSize) {
    state.unused_transfers.erase(state.unused_transfers.begin());
  }
  state.unused_transfers.emplace(id, target);
}

MonkyEngineStatus __cdecl NativeEvent(void* user, const MonkyEngineEvent* event) noexcept {
  auto& state = *static_cast<State*>(user);
  try {
    std::lock_guard lock(state.event_mutex);
    if (!state.tsfn || state.abandoned.load()) return MONKY_ENGINE_CLOSED;
    if (!event || event->struct_size != sizeof(MonkyEngineEvent)) {
      FaultLocked(state, MONKY_ENGINE_INVALID);
      return MONKY_ENGINE_INVALID;
    }
    const bool needs_id =
        (event->kind == MONKY_ENGINE_EVENT_OPERATION ||
         event->kind == MONKY_ENGINE_EVENT_REQUEST ||
         event->kind == MONKY_ENGINE_EVENT_FRAME ||
         event->kind == MONKY_ENGINE_EVENT_FRAME_RELEASED ||
         event->kind == MONKY_ENGINE_EVENT_AUDIO_INPUT_RELEASED ||
         event->kind == MONKY_ENGINE_EVENT_AUDIO_OUTPUT);
    if (event->abi_version != MONKY_ENGINE_ABI_VERSION || event->reserved ||
        event->reserved2 || event->kind < MONKY_ENGINE_EVENT_READY ||
        event->kind > MONKY_ENGINE_EVENT_AUDIO_OUTPUT || !event->json ||
        !event->json_bytes || event->json_bytes > kMaxJsonBytes ||
        event->target > kMaxSafeInteger || event->id > kMaxSafeInteger ||
        (needs_id && !event->id) ||
        std::memchr(event->json, '\0', event->json_bytes)) {
      FaultLocked(state, MONKY_ENGINE_INVALID);
      return MONKY_ENGINE_INVALID;
    }
    auto copied = std::make_unique<QueuedEvent>();
    copied->kind = event->kind;
    copied->target = event->target;
    copied->id = event->id;
    copied->json.assign(event->json, event->json_bytes);
    bool frame_inserted = false;
    bool callback_inserted = false;
    if (event->kind == MONKY_ENGINE_EVENT_FRAME) {
      if (state.decoded.find(event->id) != state.decoded.end() ||
          state.unused_transfers.find(event->id) != state.unused_transfers.end()) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      }
      // Actual retirement can be notified before release_frame returns to Node.
      // Keep its deferred on the main thread, but do not count that native slot.
      const auto retained = std::count_if(state.decoded.begin(), state.decoded.end(),
          [](const auto& entry) { return !entry.second.retirement_notified; });
      if (static_cast<size_t>(retained) >= state.options.max_decoded_frames ||
          state.decoded.size() >= state.options.max_decoded_frames + kEventQueueSize) {
        RememberUnusedTransferLocked(state, event->id, event->target);
        return MONKY_ENGINE_QUEUE_FULL;
      }
      frame_inserted = state.decoded.emplace(event->id, DecodedLease{event->target}).second;
      if (!frame_inserted) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      }
    } else if (event->kind == MONKY_ENGINE_EVENT_FRAME_RELEASED) {
      auto frame = state.decoded.find(event->id);
      if (frame == state.decoded.end()) {
        const auto unused = state.unused_transfers.find(event->id);
        if (unused == state.unused_transfers.end() || unused->second != event->target) {
          FaultLocked(state, MONKY_ENGINE_INVALID);
          return MONKY_ENGINE_INVALID;
        }
        copied->unused_transfer = true;
      } else if (frame->second.target != event->target || !frame->second.releasing ||
                 frame->second.retirement_notified) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      } else {
        // Only producer-side bookkeeping is touched here, never a napi_deferred.
        // If queueing fails, close must complete before the main-thread map settles.
        frame->second.retirement_notified = true;
      }
    } else if (event->kind == MONKY_ENGINE_EVENT_REQUEST) {
      // A respond may unblock a replacement callback before returning to Node.
      const auto waiting = std::count_if(state.callbacks.begin(), state.callbacks.end(),
          [](const auto& entry) { return !entry.second.responding; });
      if (static_cast<size_t>(waiting) >= state.options.max_pending_operations) {
        FaultLocked(state, MONKY_ENGINE_QUEUE_FULL);
        return MONKY_ENGINE_QUEUE_FULL;
      }
      callback_inserted = state.callbacks.emplace(event->id, CallbackLease{event->target}).second;
      if (!callback_inserted) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      }
    }
    const bool unused_transfer = copied->unused_transfer;
    const auto status = QueueEventLocked(state, copied.get());
    if (status == napi_ok) {
      if (unused_transfer) state.unused_transfers.erase(event->id);
      copied.release();
      return MONKY_ENGINE_OK;
    }
    if (frame_inserted) {
      state.decoded.erase(event->id);
      if (status == napi_queue_full) RememberUnusedTransferLocked(state, event->id, event->target);
    }
    if (callback_inserted) state.callbacks.erase(event->id);
    if (status == napi_closing) {
      state.tsfn = nullptr;
      return MONKY_ENGINE_CLOSED;
    }
    const auto failure = status == napi_queue_full ? MONKY_ENGINE_QUEUE_FULL
                                                  : MONKY_ENGINE_FAILURE;
    // A rejected decoded event transfers no lease to Node: the DLL retires it
    // and counts a drop. Losing control/input/frame-release events requires close.
    if (event->kind != MONKY_ENGINE_EVENT_FRAME || status != napi_queue_full)
      FaultLocked(state, failure);
    return failure;
  } catch (...) {
    // No C++ exception, wait or JavaScript execution may cross the DLL callback.
    std::lock_guard lock(state.event_mutex);
    FaultLocked(state, MONKY_ENGINE_FAILURE);
    return MONKY_ENGINE_FAILURE;
  }
}

}  // namespace
