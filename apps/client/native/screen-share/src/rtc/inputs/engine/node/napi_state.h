#pragma once

// The per-engine state every thread shares, the records it owns, and the delivery of one event to the JS listener
// (Node thread only).
// Part of the single napi_engine.cc translation unit, which is the only file that includes it.

#include "napi_values.h"

#include "audio/monky_rtc_audio.h"
#include "event_queue.h"

namespace {

struct State;
using EventContext = monky::native_rtc::node::EventQueueContext<std::shared_ptr<State>>;
struct CloseWork;
struct CleanupOwner;

struct JsonResult {
  MonkyEngineStatus status = MONKY_ENGINE_OK;
  MonkyEngineError error = EmptyError();
  std::string json;
};

template <typename Copy>
JsonResult CopyJson(Copy&& copy) {
  JsonResult result;
  uint32_t required = 0;
  result.status = copy(nullptr, 0, &required, &result.error);
  if (result.status != MONKY_ENGINE_BUFFER_TOO_SMALL && result.status != MONKY_ENGINE_OK) {
    return result;
  }
  for (unsigned attempt = 0; attempt != 4; ++attempt) {
    if (required < 3 || required > kMaxJsonBytes + 1) break;
    std::vector<char> bytes(required, static_cast<char>(0xff));
    uint32_t written = 0;
    result.error = EmptyError();
    result.status = copy(bytes.data(), required, &written, &result.error);
    if (result.status == MONKY_ENGINE_BUFFER_TOO_SMALL) {
      required = written;
      continue;
    }
    if (result.status != MONKY_ENGINE_OK) return result;
    if (written < 3 || written > bytes.size() || bytes[written - 1] != '\0' ||
        std::memchr(bytes.data(), '\0', written - 1)) break;
    result.json.assign(bytes.data(), written - 1);
    return result;
  }
  result.status = MONKY_ENGINE_FAILURE;
  result.error = Error(MONKY_ENGINE_FAILURE, "ERR_RTC_JSON_BUFFER",
                       "The DLL returned an invalid, oversized or unstable JSON buffer");
  return result;
}

struct ClosedRecord {
  JsonResult snapshot;
};

struct NativeResult {
  MonkyEngineStatus status = MONKY_ENGINE_OK;
  MonkyEngineError error = EmptyError();
  std::shared_ptr<ClosedRecord> closed;
};

struct PendingOperation {
  napi_deferred deferred = nullptr;
  std::string operation;
  uint64_t receiver = 0;
  bool enabled = false;
};

struct PendingRelease {
  napi_deferred deferred = nullptr;
  uint64_t target = 0;
};
using AudioInputKey = std::tuple<uint64_t, std::string, uint64_t>;
struct PendingAudioInput {
  napi_deferred deferred = nullptr;
  uint64_t frame_index = 0;
  uint32_t frames = 0;
};
napi_value AudioInputError(napi_env env, napi_value error, const AudioInputKey& key, bool pending,
                          const PendingAudioInput* span = nullptr) {
  DefineNumber(env, error, "sourceId", static_cast<double>(std::get<0>(key)));
  Define(env, error, "epoch", Text(env, std::get<1>(key).data(), std::get<1>(key).size()));
  DefineNumber(env, error, "sequence", static_cast<double>(std::get<2>(key)));
  if (span) {
    DefineNumber(env, error, "frameIndex", static_cast<double>(span->frame_index));
    DefineNumber(env, error, "frames", static_cast<double>(span->frames));
  }
  DefineBool(env, error, "ok", false);
  DefineBool(env, error, "nativeOwnershipRetained", false);
  DefineBool(env, error, "processingPending", pending);
  return error;
}

struct DecodedLease {
  uint64_t target = 0;
  bool delivered = false;
  bool releasing = false;
  bool release_admitted = false;
  bool automatic_unused = false;
  bool retirement_notified = false;
};

struct CallbackLease {
  uint64_t target = 0;
  uint64_t request = 0;
  bool responding = false;
};

struct State {
  explicit State(napi_env environment, const MonkyEngineOptions& configuration)
      : env(environment), options(configuration) {}

  napi_env env;
  MonkyEngineOptions options;

  // This mutex protects access admission, never an RTC call, join or wait.
  std::mutex native_mutex;
  std::condition_variable native_idle;
  MonkyRtcEngine* engine = nullptr;
  size_t native_calls = 0;
  bool retiring = false;
  std::shared_ptr<ClosedRecord> retired;
  std::atomic<bool> callbacks_detached{false};
  std::mutex worker_mutex;

  // All producer access AND TSFN release use this same mutex.
  std::mutex event_mutex;
  std::condition_variable events_drained;
  napi_threadsafe_function tsfn = nullptr;
  EventContext* event_context = nullptr;
  std::unordered_map<uint64_t, DecodedLease> decoded;
  // Bounded tombstones only, not owned leases: rejected FRAME callbacks leave
  // UNUSED retirement with the DLL, which may suppress their completion event.
  std::map<uint64_t, uint64_t> unused_transfers;
  std::unordered_map<uint64_t, CallbackLease> callbacks;
  std::atomic<MonkyEngineStatus> delivery_fault{MONKY_ENGINE_OK};
  std::atomic<bool> abandoned{false};
  std::atomic<bool> environment_closing{false};

  // The fields below are accessed only on Node's main thread.
  napi_ref listener = nullptr;
  napi_ref buffer_prototype = nullptr;
  napi_deferred ready = nullptr;
  bool ready_seen = false;
  bool closing = false;
  bool completed = false;
  std::atomic<bool> tsfn_finished{false};
  bool close_wait_finished = false;
  bool delivery_fault_reported = false;
  std::unordered_map<uint64_t, PendingOperation> operations;
  std::map<AudioInputKey, PendingAudioInput> audio_inputs;
  std::unordered_map<uint64_t, PendingRelease> releases;
  napi_deferred close_deferred = nullptr;
  napi_ref close_promise = nullptr;
  CloseWork* close_work = nullptr;
  CleanupOwner* cleanup = nullptr;
  std::shared_ptr<ClosedRecord> final_record;
};

using StateOwner = std::shared_ptr<State>;

class NativeAccess {
 public:
  explicit NativeAccess(State& state) : state_(state) {
    std::lock_guard lock(state_.native_mutex);
    if (!state_.retiring && state_.engine) {
      engine_ = state_.engine;
      ++state_.native_calls;
    }
  }
  NativeAccess(const NativeAccess&) = delete;
  NativeAccess& operator=(const NativeAccess&) = delete;
  ~NativeAccess() { Reset(); }
  MonkyRtcEngine* get() const noexcept { return engine_; }
  void Reset() noexcept {
    if (!engine_) return;
    {
      std::lock_guard lock(state_.native_mutex);
      --state_.native_calls;
      engine_ = nullptr;
    }
    state_.native_idle.notify_all();
  }
 private:
  State& state_;
  MonkyRtcEngine* engine_ = nullptr;
};

void RequireNative(napi_env env, const NativeAccess& native) {
  if (!native.get()) {
    ThrowNative(env, MONKY_ENGINE_CLOSED,
                Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSED",
                      "The engine is closed or its final native retirement is in progress"));
  }
}

struct QueuedEvent {
  uint32_t kind = 0;
  uint64_t target = 0;
  uint64_t id = 0;
  bool unused_transfer = false;
  std::string json;
};

struct CloseWork {
  StateOwner state;
  napi_async_work work = nullptr;
  NativeResult result;
};

struct CleanupOwner {
  StateOwner state;
  napi_async_cleanup_hook_handle hook = nullptr;
  napi_async_work work = nullptr;
  bool queued = false;
  NativeResult result;
};

bool Emit(napi_env env, const StateOwner& state, napi_value event,
          uint64_t frame_id = 0, uint64_t target = 0) {
  if (!state->listener || state->environment_closing.load() || state->abandoned.load()) return false;
  napi_value listener;
  Check(env, napi_get_reference_value(env, state->listener, &listener));
  const auto receiver = Undefined(env);
  if (frame_id) {
    bool valid = false;
    {
      std::lock_guard lock(state->event_mutex);
      const auto frame = state->decoded.find(frame_id);
      if (state->closing || state->abandoned.load() || state->environment_closing.load() ||
          (frame != state->decoded.end() && frame->second.releasing)) return false;
      valid = frame != state->decoded.end() && frame->second.target == target &&
              !frame->second.delivered;
      // The listener can import the HANDLE and then throw. Once invoked it is
      // conservatively external, even if the call does not return successfully.
      if (valid) frame->second.delivered = true;
    }
    if (!valid) ContractFailure(env, "Invalid or duplicate decoded lease delivery");
  }
  napi_value result;
  const auto status = napi_call_function(env, receiver, listener, 1, &event, &result);
  if (status == napi_pending_exception) {
    ReportException(env, PendingException(env));
  } else {
    Check(env, status);
  }
  return true;
}

napi_value ErrorEnvelope(napi_env env, napi_value error, bool retained) {
  napi_value envelope = Object(env);
  Set(env, envelope, "type", Text(env, "error"));
  SetNumber(env, envelope, "target", 0);
  napi_value data = Object(env);
  for (const auto* key : {"code", "message", "status", "hresult"}) {
    Set(env, data, key, Get(env, error, key));
  }
  SetBool(env, data, "terminal", true);
  SetBool(env, data, "nativeOwnershipRetained", retained);
  Set(env, envelope, "data", data);
  return envelope;
}

}  // namespace
