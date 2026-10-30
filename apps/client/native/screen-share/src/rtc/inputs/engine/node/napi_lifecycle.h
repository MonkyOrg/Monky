#pragma once

// Closing, retiring and cleaning up an engine: libuv workers wait for the native engine and destroy it, the Node
// thread completes the close, and finalizers abandon what the JS side dropped.
// Part of the single napi_engine.cc translation unit, which is the only file that includes it.

#include "napi_event_producer.h"

namespace {

void MaybeCompleteClose(napi_env env, const StateOwner& state);
void StartAutoClose(napi_env env, const StateOwner& state);
void BeginAbandon(const StateOwner& state) noexcept;
void DisposeIdleCleanup(napi_env env, const StateOwner& state);

void StopEvents(const StateOwner& state,
                napi_threadsafe_function_release_mode mode) noexcept {
  if (!state->callbacks_detached.load()) {
    std::fprintf(stderr, "[monky-rtc] Callback access is not fenced; event queue ownership retained.\n");
    return;
  }
  std::lock_guard lock(state->event_mutex);
  if (auto tsfn = std::exchange(state->tsfn, nullptr)) {
    state->event_context = nullptr;
    const auto status = napi_release_threadsafe_function(tsfn, mode);
    if (status != napi_ok && status != napi_closing) {
      std::fprintf(stderr, "[monky-rtc] Failed to release the detached event queue (%d).\n",
                   static_cast<int>(status));
    }
  }
}

MonkyEngineStatus DetachCallbacks(const StateOwner& state,
                                  MonkyEngineError* error) noexcept {
  if (state->callbacks_detached.load()) return MONKY_ENGINE_OK;
  NativeAccess native(*state);
  if (!native.get()) {
    // Retirement cannot exclude new callers until callbacks have been detached.
    return state->callbacks_detached.load() ? MONKY_ENGINE_OK : MONKY_ENGINE_CLOSED;
  }
  const auto status = monky_rtc_engine_detach_callbacks(native.get(), error);
  if (status == MONKY_ENGINE_OK) state->callbacks_detached.store(true);
  return status;
}

NativeResult WaitAndRetire(const StateOwner& state, uint32_t timeout_ms) {
  NativeResult result;
  NativeAccess native(*state);
  if (!native.get()) {
    std::lock_guard lock(state->native_mutex);
    result.closed = state->retired;
    if (!result.closed) {
      result.status = MONKY_ENGINE_CLOSED;
      result.error = Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSED",
                           "There is no native engine to wait for");
    }
    return result;
  }
  result.status = monky_rtc_engine_wait_closed(native.get(), timeout_ms, &result.error);
  if (result.status != MONKY_ENGINE_OK) return result;

  // Never acquire event_mutex before the DLL's callback mutex has been detached.
  result.error = EmptyError();
  result.status = monky_rtc_engine_detach_callbacks(native.get(), &result.error);
  if (result.status != MONKY_ENGINE_OK) return result;
  state->callbacks_detached.store(true);
  auto record = std::make_shared<ClosedRecord>();
  MonkyRtcEngine* engine = native.get();
  {
    std::lock_guard lock(state->native_mutex);
    state->retiring = true;
  }
  native.Reset();
  {
    std::unique_lock lock(state->native_mutex);
    state->native_idle.wait(lock, [&] { return state->native_calls == 0; });
  }
  try {
    record->snapshot = CopyJson([&](char* output, uint32_t capacity, uint32_t* bytes,
                                    MonkyEngineError* error) {
      return monky_rtc_engine_snapshot(engine, output, capacity, bytes, error);
    });
    result.error = EmptyError();
    result.status = monky_rtc_engine_destroy(engine, &result.error);
    {
      std::lock_guard lock(state->native_mutex);
      if (result.status == MONKY_ENGINE_OK) {
        state->engine = nullptr;
        state->retired = record;
        result.closed = std::move(record);
      }
      state->retiring = false;
    }
  } catch (...) {
    std::lock_guard lock(state->native_mutex);
    state->retiring = false;
    throw;
  }
  if (result.closed) {
    StopEvents(state, state->abandoned.load() ? napi_tsfn_abort : napi_tsfn_release);
    WaitForEventDrain(state);
  }
  return result;
}

void WorkerException(NativeResult& result) noexcept {
  result.status = MONKY_ENGINE_FAILURE;
  result.error = Error(MONKY_ENGINE_FAILURE, "ERR_RTC_CLEANUP_WORKER",
                       "A native cleanup worker failed; native ownership is retained");
}

void CloseExecute(napi_env, void* data) noexcept {
  auto& work = *static_cast<CloseWork*>(data);
  try {
    std::unique_lock lock(work.state->worker_mutex);
    work.result = WaitAndRetire(
        work.state, std::min(work.state->options.operation_timeout_ms, kMaxCloseWaitMs));
  } catch (...) {
    WorkerException(work.result);
  }
}

void ClearClosePromise(napi_env env, const StateOwner& state) {
  if (auto reference = std::exchange(state->close_promise, nullptr)) {
    Check(env, napi_delete_reference(env, reference));
  }
}

void CloseComplete(napi_env env, napi_status status, void* data) noexcept {
  std::unique_ptr<CloseWork> work(static_cast<CloseWork*>(data));
  const auto state = work->state;
  state->close_work = nullptr;
  napi_delete_async_work(env, work->work);
  if (state->environment_closing.load()) return;
  try {
    if (!work->result.closed) {
      std::lock_guard lock(state->native_mutex);
      work->result.closed = state->retired;
    }
    if (status != napi_ok && !work->result.closed) WorkerException(work->result);
    if (work->result.closed) {
      state->close_wait_finished = true;
      state->final_record = work->result.closed;
      MaybeCompleteClose(env, state);
      return;
    }
    auto error = ErrorValue(env, work->result.status, work->result.error);
    SetBool(env, error, "nativeOwnershipRetained", true);
    SetBool(env, error, "retryable", work->result.status == MONKY_ENGINE_TIMEOUT);
    const bool observed = state->close_deferred != nullptr;
    Settle(env, state->close_deferred, error, false);
    ClearClosePromise(env, state);
    if (!observed) Emit(env, state, ErrorEnvelope(env, error, true));
  } catch (const JsFailure&) {
    ReportException(env, PendingException(env));
  } catch (...) {
    AllocationException(env);
    ReportException(env, PendingException(env));
  }
}

void StartClose(napi_env env, const StateOwner& state) {
  if (state->close_work || state->close_wait_finished || state->completed) return;
  auto work = std::make_unique<CloseWork>();
  work->state = state;
  Check(env, napi_create_async_work(env, nullptr, Text(env, "MonkyRtcEngine.close"),
                                    CloseExecute, CloseComplete, work.get(), &work->work));
  try {
    NativeAccess native(*state);
    RequireNative(env, native);
    MonkyEngineError error = EmptyError();
    const auto status = monky_rtc_engine_close(native.get(), &error);
    if (status != MONKY_ENGINE_OK && status != MONKY_ENGINE_CLOSED) {
      ThrowNative(env, status, error);
    }
    state->closing = true;
    if (state->ready) {
      auto reason = Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSING",
                          "The engine was closed before readiness could be observed");
      Settle(env, state->ready, ErrorValue(env, reason.status, reason), false);
    }
    Check(env, napi_queue_async_work(env, work->work));
    state->close_work = work.release();
  } catch (...) {
    napi_delete_async_work(env, work->work);
    throw;
  }
}

void StartAutoClose(napi_env env, const StateOwner& state) {
  if (state->abandoned.load() || state->environment_closing.load()) return;
  try {
    StartClose(env, state);
  } catch (const JsFailure&) {
    auto error = PendingException(env);
    Settle(env, state->ready, error, false);
    Emit(env, state, ErrorEnvelope(env, error, true));
  }
}

bool RecordReleaseAdmission(const StateOwner& state, uint64_t id,
                             MonkyEngineStatus status) noexcept {
  std::lock_guard lock(state->event_mutex);
  const auto frame = state->decoded.find(id);
  if (frame == state->decoded.end()) {
    FaultLocked(*state, MONKY_ENGINE_INVALID);
    return status == MONKY_ENGINE_OK;
  }
  if (status == MONKY_ENGINE_OK || frame->second.retirement_notified) {
    frame->second.release_admitted = true;
    if (status != MONKY_ENGINE_OK) {
      FaultLocked(*state, MONKY_ENGINE_INVALID);
      std::fprintf(stderr,
          "[monky-rtc] Native retirement preceded a failed release admission; "
          "its deferred is retained until completion or complete close.\n");
    }
    return true;
  }
  frame->second.releasing = false;
  frame->second.automatic_unused = false;
  return false;
}

void ReleaseUndelivered(const StateOwner& state, uint64_t id) noexcept {
  NativeAccess native(*state);
  if (!native.get()) return;
  {
    std::lock_guard lock(state->event_mutex);
    auto found = state->decoded.find(id);
    if (found == state->decoded.end() || found->second.delivered || found->second.releasing) return;
    found->second.releasing = true;
    found->second.automatic_unused = true;
  }
  MonkyEngineError error = EmptyError();
  const auto status = monky_rtc_engine_release_frame(
      native.get(), id, MONKY_ENGINE_FRAME_UNUSED, &error);
  RecordReleaseAdmission(state, id, status);
  if (status != MONKY_ENGINE_OK) {
    std::fprintf(stderr,
        "[monky-rtc] Could not admit UNUSED for an undelivered frame (status=%d); lease retained.\n",
        static_cast<int>(status));
    std::lock_guard lock(state->event_mutex);
    FaultLocked(*state, status);
  }
}

void ReleaseAbandonedFrames(const StateOwner& state) noexcept {
  uint64_t previous = 0;
  for (;;) {
    uint64_t id = kMaxSafeInteger + 1;
    {
      std::lock_guard lock(state->event_mutex);
      for (const auto& [candidate, frame] : state->decoded) {
        if (candidate > previous && candidate < id && !frame.delivered && !frame.releasing) {
          id = candidate;
        }
      }
    }
    if (id > kMaxSafeInteger) return;
    ReleaseUndelivered(state, id);
    // Attempt each eligible ID once per cleanup iteration, including rejections.
    previous = id;
  }
}

void CleanupExecute(napi_env, void* data) noexcept {
  auto& owner = *static_cast<CleanupOwner*>(data);
  const auto state = owner.state;
  unsigned failures = 0;
  for (;;) {
    try {
      std::unique_lock lock(state->worker_mutex);
      bool has_engine;
      {
        std::lock_guard native_lock(state->native_mutex);
        has_engine = state->engine != nullptr;
        if (!has_engine) owner.result.closed = state->retired;
      }
      if (!has_engine) {
        state->callbacks_detached.store(true);
        StopEvents(state, napi_tsfn_abort);
        WaitForEventDrain(state);
        return;
      }
      MonkyEngineError error = EmptyError();
      const auto detached = DetachCallbacks(state, &error);
      if (detached != MONKY_ENGINE_OK) {
        owner.result.status = detached;
        owner.result.error = error;
      } else {
        StopEvents(state, napi_tsfn_abort);
        // A queued event is not a delivery. Only never-exposed leases permit
        // automatic UNUSED; delivered leases require the parent's external proof.
        ReleaseAbandonedFrames(state);
        NativeAccess native(*state);
        if (native.get()) {
          error = EmptyError();
          const auto status = monky_rtc_engine_close(native.get(), &error);
          if (status != MONKY_ENGINE_OK && status != MONKY_ENGINE_CLOSED) {
            owner.result.status = status;
            owner.result.error = error;
          } else {
            native.Reset();
            owner.result = WaitAndRetire(
                state, std::min(state->options.operation_timeout_ms, uint32_t{12000}));
            if (owner.result.closed) return;
          }
        }
      }
    } catch (...) {
      WorkerException(owner.result);
    }
    if (failures++ % 5 == 0) {
      size_t delivered_unreleased = 0;
      size_t pending_releases = 0;
      if (state->callbacks_detached.load()) {
        std::lock_guard lock(state->event_mutex);
        for (const auto& [id, frame] : state->decoded) {
          if (frame.delivered && !frame.releasing) ++delivered_unreleased;
          if (frame.releasing && !frame.retirement_notified) ++pending_releases;
        }
      }
      std::fprintf(stderr,
          "[monky-rtc] Native cleanup remains pending (status=%d). "
          "%zu delivered leases have no external-release proof; %zu releases await retirement. "
          "Drain genuine Electron allReferencesReleased before environment teardown. "
          "The async hook retains the engine and addon; no live engine is destroyed.\n",
          static_cast<int>(owner.result.status), delivered_unreleased, pending_releases);
    }
    // A blocked driver is not permission to unload code or abandon its ownership.
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
}

void DeleteListener(napi_env env, const StateOwner& state) {
  if (auto listener = std::exchange(state->listener, nullptr)) {
    Check(env, napi_delete_reference(env, listener));
  }
  if (auto prototype = std::exchange(state->buffer_prototype, nullptr)) {
    Check(env, napi_delete_reference(env, prototype));
  }
}

void CleanupComplete(napi_env env, napi_status status, void* data) noexcept {
  auto* owner = static_cast<CleanupOwner*>(data);
  const auto state = owner->state;
  bool has_engine = false;
  {
    std::lock_guard lock(state->native_mutex);
    has_engine = state->engine != nullptr;
  }
  if (status != napi_ok || (!owner->result.closed && has_engine)) {
    // Retain the hook and its State on an unexpected queue cancellation.
    std::fprintf(stderr, "[monky-rtc] Native cleanup work did not complete; environment ownership retained.\n");
    return;
  }
  try {
    if (!state->environment_closing.load() && owner->result.closed) {
      state->close_wait_finished = true;
      state->final_record = owner->result.closed;
      MaybeCompleteClose(env, state);
    }
    ClearClosePromise(env, state);
    DeleteListener(env, state);
  } catch (const JsFailure&) {
    if (!state->environment_closing.load()) ReportException(env, PendingException(env));
  } catch (...) {
    if (!state->environment_closing.load()) {
      AllocationException(env);
      ReportException(env, PendingException(env));
    }
  }
  if (napi_delete_async_work(env, owner->work) != napi_ok) {
    std::fprintf(stderr, "[monky-rtc] Could not dispose cleanup work; environment hook retained.\n");
    return;
  }
  owner->work = nullptr;
  // This is removed only AFTER actual native destruction (or a failed create with no engine).
  if (napi_remove_async_cleanup_hook(owner->hook) != napi_ok) {
    std::fprintf(stderr, "[monky-rtc] Could not remove the completed environment hook; owner retained.\n");
    return;
  }
  state->cleanup = nullptr;
  delete owner;
}

void BeginAbandon(const StateOwner& state) noexcept {
  state->abandoned.store(true);
  // Detach first: taking event_mutex while holding the DLL callback mutex in the
  // opposite order would deadlock a producer copying a borrowed C event.
  MonkyEngineError error = EmptyError();
  const auto detached = DetachCallbacks(state, &error);
  if (detached != MONKY_ENGINE_OK && detached != MONKY_ENGINE_CLOSED) {
    std::fprintf(stderr, "[monky-rtc] Callback detachment will be retried by the cleanup worker.\n");
  }
  if (state->callbacks_detached.load()) StopEvents(state, napi_tsfn_abort);
  auto* owner = state->cleanup;
  if (!owner || owner->queued) return;
  const auto status = napi_queue_async_work(state->env, owner->work);
  if (status == napi_ok) {
    owner->queued = true;
  } else {
    // Do not remove the async hook or delete a possibly live C engine on failure.
    std::fprintf(stderr, "[monky-rtc] Could not queue native cleanup (%d); environment ownership retained.\n",
                 static_cast<int>(status));
  }
}

void EnvironmentCleanup(napi_async_cleanup_hook_handle, void* data) noexcept {
  const auto state = static_cast<CleanupOwner*>(data)->state;
  state->environment_closing.store(true);
  BeginAbandon(state);
}

void WrapperFinalizer(napi_env, void* data, void*) noexcept {
  std::unique_ptr<StateOwner> owner(static_cast<StateOwner*>(data));
  if (!(*owner)->completed) BeginAbandon(*owner);
}

void EventQueueDrained(const StateOwner& state) noexcept {
  {
    std::lock_guard lock(state->event_mutex);
    state->tsfn_finished.store(true);
  }
  state->events_drained.notify_all();
}

void TsfnFinalizer(napi_env, void* data, void*) noexcept {
  auto* context = static_cast<EventContext*>(data);
  const auto state = context->OwnerValue();
  {
    // Older runtimes can finalize independently of the native producer.
    // Fence producer access before allowing the runtime to destroy its handle.
    std::lock_guard lock(state->event_mutex);
    state->tsfn = nullptr;
    state->event_context = nullptr;
  }
  if (context->MarkFinalized()) EventQueueDrained(state);
  context->ReleaseFinalizer();
}

void DisposeIdleCleanup(napi_env env, const StateOwner& state) {
  auto* owner = state->cleanup;
  if (!owner || owner->queued) return;
  Check(env, napi_remove_async_cleanup_hook(owner->hook));
  owner->hook = nullptr;
  const auto status = napi_delete_async_work(env, owner->work);
  state->cleanup = nullptr;
  delete owner;
  Check(env, status);
}

void MaybeCompleteClose(napi_env env, const StateOwner& state) {
  if (state->completed || !state->close_wait_finished || !state->tsfn_finished ||
      !state->final_record || state->environment_closing.load()) return;
  state->completed = true;
  state->closing = true;
  const auto closed_error = Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSED",
      "The engine completed native close; remaining input and decoded leases have safely retired");
  const auto error = ErrorValue(env, closed_error.status, closed_error);
  SetBool(env, error, "nativeOwnershipRetained", false);
  Settle(env, state->ready, error, false);
  for (auto& [id, pending] : state->operations) Settle(env, pending.deferred, error, false);
  state->operations.clear();
  for (auto& [key, pending] : state->audio_inputs) {
    const auto input_error = AudioInputError(
        env, ErrorValue(env, closed_error.status, closed_error), key, false, &pending);
    Settle(env, pending.deferred, input_error, false);
  }
  state->audio_inputs.clear();
  // Lost release-event delivery is safe to settle only after wait_closed/destroy.
  for (auto& [id, release] : state->releases) Settle(env, release.deferred, error, false);
  state->releases.clear();
  {
    std::lock_guard lock(state->event_mutex);
    state->decoded.clear();
    state->unused_transfers.clear();
    state->callbacks.clear();
  }
  if (state->close_deferred) {
    const auto& snapshot = state->final_record->snapshot;
    if (snapshot.status == MONKY_ENGINE_OK) {
      try {
        Settle(env, state->close_deferred, Parse(env, snapshot.json), true);
      } catch (const JsFailure&) {
        Settle(env, state->close_deferred, PendingException(env), false);
      }
    } else {
      Settle(env, state->close_deferred,
             ErrorValue(env, snapshot.status, snapshot.error), false);
    }
  }
  ClearClosePromise(env, state);
  DeleteListener(env, state);
  DisposeIdleCleanup(env, state);
}

}  // namespace
