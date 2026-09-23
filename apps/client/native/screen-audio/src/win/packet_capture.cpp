#include "wasapi_capture.h"
#include <napi.h>
#include <algorithm>
#include <memory>
#include <mutex>
#include <limits>
#include <thread>
#include <condition_variable>
#include <utility>
#include <uv.h>

namespace screen_audio {
#ifdef MONKY_PACKET_CAPTURE_TEST
namespace packet_capture_test {
napi_status Create(napi_env env, napi_value callback, napi_value name, void* finalizeData,
    napi_finalize finalize, void* context, napi_threadsafe_function_call_js deliver,
    napi_threadsafe_function* result);
void Created(napi_threadsafe_function function);
void BeforeQueue(bool packet) noexcept;
void Observe(const char* point, size_t value = 1) noexcept;
void Finalized(napi_env env) noexcept;
napi_status Push(napi_threadsafe_function function, void* event, bool packet) noexcept;
napi_status Release(napi_threadsafe_function function, napi_threadsafe_function_release_mode mode) noexcept;
}
#endif
namespace {

inline std::atomic<uint64_t> nextSession{1};

void NapiCheck(napi_status status) {
  if (status != napi_ok) throw Failure("ERR_AUDIO_NAPI", "Node-API operation failed");
}
napi_value Object(napi_env env) { napi_value value; NapiCheck(napi_create_object(env, &value)); return value; }
napi_value String(napi_env env, const std::string& text) {
  napi_value value; NapiCheck(napi_create_string_utf8(env, text.c_str(), text.size(), &value)); return value;
}
napi_value Number(napi_env env, uint64_t number) {
  napi_value value; NapiCheck(napi_create_double(env, static_cast<double>(number), &value)); return value;
}
napi_value Boolean(napi_env env, bool boolean) {
  napi_value value; NapiCheck(napi_get_boolean(env, boolean, &value)); return value;
}
napi_value Null(napi_env env) { napi_value value; NapiCheck(napi_get_null(env, &value)); return value; }
void Set(napi_env env, napi_value object, const char* key, napi_value value) {
  NapiCheck(napi_set_named_property(env, object, key, value));
}
napi_value FormatValue(napi_env env, const Format& f) {
  auto value = Object(env);
  Set(env, value, "encoding", String(env, "float32-interleaved"));
  Set(env, value, "sampleRate", Number(env, f.sampleRate));
  Set(env, value, "channels", Number(env, f.channels));
  Set(env, value, "channelMask", f.channelMask ? Number(env, f.channelMask) : Null(env));
  Set(env, value, "sourceBitsPerSample", Number(env, f.bits));
  Set(env, value, "sourceValidBitsPerSample", Number(env, f.validBits));
  return value;
}

struct DeliveryCredit;

struct State {
  explicit State(napi_env env) : env(env), lease(CaptureOwner::packet),
      sessionId(std::to_string(nextSession.fetch_add(1))) {}
  napi_env env;
  CaptureLease lease;
  const std::string sessionId;
  std::atomic<bool> stop{false};
  std::atomic<uint64_t> packets{0}, frames{0}, delivered{0}, overflows{0};
  PacketBudget budget;
  // JS-thread-only admission receipts. They do not own native RTC processing.
  std::vector<std::shared_ptr<DeliveryCredit>> deliveryCredits;
  std::atomic<size_t> pendingEvents{0};
  uint32_t excludedPid = 0;
  uint32_t expectedPid = 0;
  int64_t windowId = 0;
  std::mutex mutex;
  Format format;
  bool hasFormat = false;
  std::string errorCode, errorMessage, status = "starting";
  std::thread worker;
  uv_loop_t* loop = nullptr;
  uv_work_t joinWork{};
  bool joinQueued = false;
  std::mutex threadMutex;
  std::condition_variable threadPublished;
  bool threadDecided = false;
  // Cleanup can revoke the producer acquisition before Node destroys its TSFN.
  // Never hold this guard during acquisition, conversion, callbacks or joining.
  std::mutex tsfnMutex;
  napi_threadsafe_function tsfn = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  napi_ref callback = nullptr;
  napi_deferred ready = nullptr, closed = nullptr;
  bool workDone = false, deliveryFinalized = false, finished = false, envClosing = false, readySettled = false;

  void Fail(const std::string& code, const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex);
    if (errorCode.empty()) { errorCode = code; errorMessage = message; }
    stop.store(true);
    budget.Wake();
  }
};
using Shared = std::shared_ptr<State>;

struct DeliveryCredit {
  std::weak_ptr<State> owner;
  napi_ref promise = nullptr;
  bool held = true;
};

void ReleaseCredit(std::shared_ptr<DeliveryCredit> credit) noexcept {
  if (!credit->held) return;
  credit->held = false;
  if (auto state = credit->owner.lock()) {
    if (credit->promise) {
      napi_delete_reference(state->env, credit->promise);
      credit->promise = nullptr;
    }
    state->budget.Release();
    auto& credits = state->deliveryCredits;
    credits.erase(std::remove(credits.begin(), credits.end(), credit), credits.end());
  }
}

struct CreditCallback {
  std::shared_ptr<DeliveryCredit> credit;
  bool rejected;
};

napi_value AcknowledgeDelivery(napi_env env, napi_callback_info info) noexcept {
  void* data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data) != napi_ok) return nullptr;
  auto& callback = *static_cast<CreditCallback*>(data);
  if (auto state = callback.credit->owner.lock()) {
    if (callback.credit->held && callback.rejected && !state->stop.load())
      state->Fail("ERR_AUDIO_CALLBACK", "The packet capture admission acknowledgement rejected");
  }
  ReleaseCredit(callback.credit);
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value CreditHandler(napi_env env, const std::shared_ptr<DeliveryCredit>& credit, bool rejected) {
  auto data = std::make_unique<CreditCallback>(CreditCallback{credit, rejected});
  napi_value callback;
  NapiCheck(napi_create_function(env, "acknowledgeAudioAdmission", NAPI_AUTO_LENGTH,
      AcknowledgeDelivery, data.get(), &callback));
  NapiCheck(napi_add_finalizer(env, callback, data.get(), [](napi_env, void* data, void*) {
    delete static_cast<CreditCallback*>(data);
  }, nullptr, nullptr));
  data.release();
  return callback;
}

void AwaitAdmission(napi_env env, napi_value promise, const std::shared_ptr<DeliveryCredit>& credit) {
  NapiCheck(napi_create_reference(env, promise, 1, &credit->promise));
  napi_value then, ignored;
  NapiCheck(napi_get_named_property(env, promise, "then", &then));
  napi_value callbacks[] = {CreditHandler(env, credit, false), CreditHandler(env, credit, true)};
  NapiCheck(napi_call_function(env, promise, then, 2, callbacks, &ignored));
}

void ReleaseProducer(State& state, napi_threadsafe_function_release_mode mode = napi_tsfn_release) noexcept {
  std::lock_guard<std::mutex> lock(state.tsfnMutex);
  const auto function = std::exchange(state.tsfn, nullptr);
  if (!function) return;
#ifdef MONKY_PACKET_CAPTURE_TEST
  packet_capture_test::Release(function, mode);
#else
  napi_release_threadsafe_function(function, mode);
#endif
}

napi_value ErrorValue(napi_env env, const std::string& code, const std::string& message) {
  napi_value error;
  NapiCheck(napi_create_error(env, String(env, code), String(env, message), &error));
  return error;
}
napi_value Snapshot(State& state) {
  const auto env = state.env;
  auto value = Object(env);
  std::lock_guard<std::mutex> lock(state.mutex);
  Set(env, value, "sessionId", String(env, state.sessionId));
  Set(env, value, "state", String(env, state.status));
  Set(env, value, "format", state.hasFormat ? FormatValue(env, state.format) : Null(env));
  Set(env, value, "capturedPackets", Number(env, state.packets.load()));
  Set(env, value, "capturedFrames", Number(env, state.frames.load()));
  Set(env, value, "deliveredPackets", Number(env, state.delivered.load()));
  Set(env, value, "queuedPackets", Number(env, state.budget.queued()));
  Set(env, value, "overflowCount", Number(env, state.overflows.load()));
  Set(env, value, "maxQueuedPackets", Number(env, kMaxQueuedPackets));
  Set(env, value, "maxPacketBytes", Number(env, kMaxPacketBytes));
  Set(env, value, "error", state.errorCode.empty() ? Null(env) : ErrorValue(env, state.errorCode, state.errorMessage));
  return value;
}

// Callback exceptions stop capture explicitly; never escape through a C ABI.
napi_value Call(State& state, napi_value callback, napi_value event) {
  napi_value result = nullptr;
  const auto status = napi_call_function(state.env, Null(state.env), callback, 1, &event, &result);
  if (status == napi_pending_exception) {
    napi_value ignored;
    napi_get_and_clear_last_exception(state.env, &ignored);
    state.Fail("ERR_AUDIO_CALLBACK", "The packet capture event callback threw");
  } else if (status != napi_ok) {
    state.Fail("ERR_AUDIO_CALLBACK", "Cannot invoke the packet capture event callback");
  }
  return status == napi_ok ? result : nullptr;
}

void Finish(State& state) noexcept {
  if (state.finished || !state.workDone || !state.deliveryFinalized || state.pendingEvents.load()) return;
  state.finished = true;
  // Callback promises only reserve admission space; capture shutdown cannot
  // wait for RTC processing, which is retired separately by each subscriber.
  while (!state.deliveryCredits.empty()) ReleaseCredit(state.deliveryCredits.back());
  // Both the MTA work and the TSFN queue are gone before exclusivity is released.
  state.lease.Release();
  if (!state.envClosing) {
    try {
      std::string code, message;
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        if (!state.readySettled && state.errorCode.empty()) {
          state.errorCode = "ERR_AUDIO_CANCELLED";
          state.errorMessage = "Capture stopped before acquisition became ready";
        }
        code = state.errorCode;
        message = state.errorMessage;
        state.status = code.empty() ? "closed" : "failed";
      }
      if (!state.readySettled) {
        NapiCheck(napi_reject_deferred(state.env, state.ready, ErrorValue(state.env, code, message)));
        state.readySettled = true;
      }
      napi_value callback;
      NapiCheck(napi_get_reference_value(state.env, state.callback, &callback));
      if (!code.empty()) {
        auto event = Object(state.env);
        Set(state.env, event, "type", String(state.env, "error"));
        Set(state.env, event, "error", ErrorValue(state.env, code, message));
        Call(state, callback, event);
      }
      auto snapshot = Snapshot(state);
      // Resolve before calling user code so an exception cannot strand stop().
      NapiCheck(napi_resolve_deferred(state.env, state.closed, snapshot));
      auto event = Object(state.env);
      Set(state.env, event, "type", String(state.env, "closed"));
      Set(state.env, event, "snapshot", snapshot);
      Call(state, callback, event);
    } catch (...) {
      // Environment teardown/OOM must not unwind into libuv.
    }
  }
  if (state.callback) {
    napi_delete_reference(state.env, state.callback);
    state.callback = nullptr;
#ifdef MONKY_PACKET_CAPTURE_TEST
    packet_capture_test::Observe("callbackRefDeletes");
#endif
  }
  if (state.cleanup) {
    napi_remove_async_cleanup_hook(state.cleanup);
    state.cleanup = nullptr;
#ifdef MONKY_PACKET_CAPTURE_TEST
    packet_capture_test::Observe("cleanupRemovals");
#endif
  }
#ifdef MONKY_PACKET_CAPTURE_TEST
  packet_capture_test::Observe("finishes");
  packet_capture_test::Observe("queuedAtFinish", state.budget.queued());
  packet_capture_test::Observe("pendingAtFinish", state.pendingEvents.load());
#endif
}

struct Event {
  explicit Event(Shared owner) : owner(std::move(owner)) {
#ifdef MONKY_PACKET_CAPTURE_TEST
    packet_capture_test::Observe("eventAllocations");
#endif
  }
#ifdef MONKY_PACKET_CAPTURE_TEST
  ~Event() {
    packet_capture_test::Observe("eventDeletions");
    if (!ready) packet_capture_test::Observe("packetDeletions");
  }
#endif
  // Node 20 runs the TSFN finalizer before disposing leftover env-null events.
  // Each event keeps its context alive independently of the TSFN finalizer.
  Shared owner;
  bool ready = false;
  Format format;
  Timing timing;
  uint32_t frames = 0;
  std::vector<float> pcm;
};

void Deliver(napi_env env, napi_value callback, void*, void* data) noexcept {
  std::unique_ptr<Event> event(static_cast<Event*>(data));
  auto& state = *event->owner;
  bool admissionPending = false;
  state.pendingEvents.fetch_sub(1);
#ifdef MONKY_PACKET_CAPTURE_TEST
  if (!env) packet_capture_test::Observe("envNullDisposals");
  if (state.deliveryFinalized) packet_capture_test::Observe("deliveriesAfterFinalizer");
#endif
  if (!env || !callback || state.envClosing) {
    if (!event->ready) state.budget.Release();
    const auto owner = event->owner;
    event.reset();
    Finish(*owner);
    return;
  }
  try {
    auto value = Object(env);
    Set(env, value, "type", String(env, event->ready ? "ready" : "packet"));
    Set(env, value, "sessionId", String(env, state.sessionId));
    Set(env, value, "format", FormatValue(env, event->format));
    if (event->ready) {
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        state.status = "capturing";
      }
      NapiCheck(napi_resolve_deferred(env, state.ready, Snapshot(state)));
      state.readySettled = true;
    } else {
      const auto& timing = event->timing;
      Set(env, value, "frames", Number(env, event->frames));
      Set(env, value, "sequence", Number(env, timing.sequence));
      Set(env, value, "frameIndex", Number(env, timing.frameIndex));
      Set(env, value, "epoch", String(env, state.sessionId + ":" + std::to_string(timing.epoch)));
      Set(env, value, "devicePosition", timing.devicePosition ? Number(env, *timing.devicePosition) : Null(env));
      Set(env, value, "qpcTimestampUs", timing.qpcTimestampUs ? Number(env, *timing.qpcTimestampUs) : Null(env));
      auto flags = Object(env);
      Set(env, flags, "raw", Number(env, timing.flags));
      Set(env, flags, "silent", Boolean(env, (timing.flags & kSilent) != 0));
      Set(env, flags, "dataDiscontinuity", Boolean(env, (timing.flags & kDiscontinuity) != 0));
      Set(env, flags, "timestampError", Boolean(env, (timing.flags & kTimestampError) != 0));
      Set(env, value, "flags", flags);
      napi_value buffer;
      NapiCheck(napi_create_buffer_copy(env, event->pcm.size() * sizeof(float), event->pcm.data(), nullptr, &buffer));
      Set(env, value, "pcm", buffer);
      state.delivered.fetch_add(1);
    }
    const auto result = Call(state, callback, value);
    if (!event->ready && result) {
      bool isPromise = false;
      NapiCheck(napi_is_promise(env, result, &isPromise));
      if (isPromise) {
        auto credit = std::make_shared<DeliveryCredit>();
        credit->owner = event->owner;
        state.deliveryCredits.push_back(credit);
        admissionPending = true;
        try { AwaitAdmission(env, result, credit); }
        catch (...) { ReleaseCredit(credit); throw; }
      }
    }
  } catch (const std::exception& error) {
    state.Fail("ERR_AUDIO_DELIVERY", error.what());
  } catch (...) {
    state.Fail("ERR_AUDIO_DELIVERY", "Cannot deliver PCM packet");
  }
  bool exceptionPending = false;
  if (napi_is_exception_pending(env, &exceptionPending) == napi_ok && exceptionPending) {
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
  }
  if (!event->ready && !admissionPending) state.budget.Release();
}

bool Queue(State& state, std::unique_ptr<Event> event) {
  const bool packet = !event->ready;
#ifdef MONKY_PACKET_CAPTURE_TEST
  packet_capture_test::BeforeQueue(packet);
#endif
  // A refilled TSFN can dispatch more than its capacity in one turn. Wait for
  // actual admission outside tsfnMutex so Stop/cleanup can always revoke it.
  if (packet && !state.budget.Acquire() && !state.budget.WaitForSlot(state.stop)) {
    if (state.stop.load()) return false;
    state.overflows.fetch_add(1);
    throw Failure("ERR_AUDIO_OVERFLOW",
        "Bounded PCM delivery queue overflowed; capture admission timed out");
  }
  napi_status result = napi_ok;
  bool revoked = false;
  {
    std::lock_guard<std::mutex> lock(state.tsfnMutex);
    revoked = !state.tsfn;
    if (!revoked) {
      state.pendingEvents.fetch_add(1);
#ifdef MONKY_PACKET_CAPTURE_TEST
      result = packet_capture_test::Push(state.tsfn, event.get(), packet);
#else
      result = napi_call_threadsafe_function(state.tsfn, event.get(), napi_tsfn_nonblocking);
#endif
      // napi_closing consumes this acquisition and may delete the handle before
      // returning. Cleanup and the producer must both stop accessing it.
      if (result == napi_closing) state.tsfn = nullptr;
      if (result != napi_ok) state.pendingEvents.fetch_sub(1);
    }
  }
  if (revoked || result != napi_ok) {
    if (packet) state.budget.Release();
    if (revoked) {
#ifdef MONKY_PACKET_CAPTURE_TEST
      packet_capture_test::Observe("revokedEvents");
#endif
      return false;
    }
    throw Failure("ERR_AUDIO_DELIVERY", "Cannot enqueue capture event");
  }
  event.release();
  return true;
}

void Execute(Shared shared) noexcept {
  auto& state = *shared;
  try {
    if (!state.lease.held()) throw Failure("ERR_AUDIO_BUSY", "Already capturing (legacy or packet mode)");
    if (!state.stop.load()) {
      const auto target = ResolvePacketTarget(state.excludedPid, state.windowId);
      if (state.expectedPid && target.pid != state.expectedPid)
        throw Failure("ERR_AUDIO_TARGET", "The selected window no longer belongs to the expected process");
      Format format;
      Timeline timeline;
      CaptureSink sink;
      sink.ready = [&](const WAVEFORMATEX* wave) {
        format = ParseWasapiFormat(wave, sizeof(WAVEFORMATEX) + wave->cbSize);
        {
          std::lock_guard<std::mutex> lock(state.mutex);
          state.format = format;
          state.hasFormat = true;
        }
        if (state.stop.load()) return false;
        auto event = std::make_unique<Event>(shared);
        event->ready = true;
        event->format = format;
        return Queue(state, std::move(event));
      };
      sink.packet = [&](const uint8_t* data, uint32_t frames, uint32_t flags,
                        std::optional<uint64_t> position, uint64_t qpc) {
        auto event = std::make_unique<Event>(shared);
        event->format = format;
        event->frames = frames;
        event->timing = timeline.Next(frames, flags, position, qpc, format.sampleRate);
        const size_t bytes = PacketBytes(format, frames);
        event->pcm = Convert(format, data, flags & kSilent ? 0 : bytes, frames, flags);
        state.packets.fetch_add(1);
        state.frames.fetch_add(frames);
        return Queue(state, std::move(event)) && !state.stop.load();
      };
      RunWasapiCapture(target, state.stop, sink);
    }
  } catch (const Failure& error) {
    state.Fail(error.code, error.what());
  } catch (const std::exception& error) {
    state.Fail("ERR_AUDIO_CAPTURE", error.what());
  } catch (...) {
    state.Fail("ERR_AUDIO_CAPTURE", "Unexpected native capture failure");
  }
  ReleaseProducer(state);
}

void Complete(uv_work_t* work, int) noexcept {
  std::unique_ptr<Shared> shared(static_cast<Shared*>(work->data));
  auto& state = **shared;
  state.workDone = true;
#ifdef MONKY_PACKET_CAPTURE_TEST
  packet_capture_test::Observe("joins");
#endif
  napi_handle_scope scope = nullptr;
  if (!state.envClosing) napi_open_handle_scope(state.env, &scope);
  Finish(state);
  if (scope) napi_close_handle_scope(state.env, scope);
}
void Join(uv_work_t* work) noexcept {
  auto& state = **static_cast<Shared*>(work->data);
  {
    std::unique_lock<std::mutex> lock(state.threadMutex);
    state.threadPublished.wait(lock, [&] { return state.threadDecided; });
  }
  if (state.worker.joinable()) state.worker.join();
}
void FinalizeDelivery(napi_env env, void* data, void*) noexcept {
  std::unique_ptr<Shared> shared(static_cast<Shared*>(data));
  auto& state = **shared;
  state.deliveryFinalized = true;
#ifdef MONKY_PACKET_CAPTURE_TEST
  packet_capture_test::Observe("pendingAtFinalizer", state.pendingEvents.load());
  packet_capture_test::Finalized(env);
#else
  (void)env;
#endif
  Finish(state);
}
void Cleanup(napi_async_cleanup_hook_handle, void* data) noexcept {
  auto& state = *static_cast<State*>(data);
  state.envClosing = true;
  state.stop.store(true);
  state.budget.Wake();
#ifdef MONKY_PACKET_CAPTURE_TEST
  packet_capture_test::Observe("cleanupStarts");
#endif
  // Registered after the TSFN, this runs before Node's internal cleanup hook.
  // Node 20 does not retain a finalized TSFN for outstanding producer threads.
  ReleaseProducer(state, napi_tsfn_abort);
}
void FinalizeSession(napi_env, void* data, void*) noexcept {
  std::unique_ptr<Shared> shared(static_cast<Shared*>(data));
  (*shared)->stop.store(true);
  (*shared)->budget.Wake();
}

Shared Unwrap(napi_env env, napi_callback_info info, napi_value& self) {
  size_t argc = 0;
  NapiCheck(napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr));
  Shared* shared = nullptr;
  NapiCheck(napi_unwrap(env, self, reinterpret_cast<void**>(&shared)));
  if (!shared) throw Failure("ERR_AUDIO_SESSION", "Invalid capture session receiver");
  return *shared;
}
napi_value Stop(napi_env env, napi_callback_info info) {
  try {
    napi_value self;
    auto state = Unwrap(env, info, self);
    state->stop.store(true);
    state->budget.Wake();
    napi_value promise;
    NapiCheck(napi_get_named_property(env, self, "closed", &promise));
    return promise;
  } catch (const std::exception& error) { napi_throw_error(env, "ERR_AUDIO_SESSION", error.what()); return nullptr; }
}
napi_value GetSnapshot(napi_env env, napi_callback_info info) {
  try {
    napi_value self;
    return Snapshot(*Unwrap(env, info, self));
  } catch (const std::exception& error) { napi_throw_error(env, "ERR_AUDIO_SESSION", error.what()); return nullptr; }
}

uint64_t Option(napi_env env, napi_value options, const char* key, uint64_t maximum) {
  bool has = false;
  NapiCheck(napi_has_named_property(env, options, key, &has));
  if (!has) return 0;
  napi_value value;
  NapiCheck(napi_get_named_property(env, options, key, &value));
  napi_valuetype type;
  NapiCheck(napi_typeof(env, value, &type));
  if (type == napi_undefined) return 0;
  double number = 0;
  if (type != napi_number || napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || std::floor(number) != number || number <= 0 || number > double(maximum))
    throw Failure("ERR_AUDIO_OPTIONS", std::string(key) + " must be a positive safe integer in range");
  return static_cast<uint64_t>(number);
}

}  // namespace

Napi::Value CreatePacketCapture(const Napi::CallbackInfo& info) {
  const napi_env env = info.Env();
  Shared state;
  napi_value session = nullptr;
  bool queued = false;
  try {
    if (info.Length() != 2 || !info[0].IsObject() || info[0].IsArray() || !info[1].IsFunction())
      throw Failure("ERR_AUDIO_OPTIONS", "Expected (options, onEvent)");
    auto options = info[0].As<Napi::Object>();
    if (options.Has("sampleRate") || options.Has("channels"))
      throw Failure("ERR_AUDIO_OPTIONS", "Packet mode preserves the original WASAPI format");
    const uint32_t excludedPid = static_cast<uint32_t>(Option(env, options, "excludePid", UINT32_MAX));
    const int64_t windowId = static_cast<int64_t>(Option(env, options, "includeWindowId", kSafeInteger));
    const uint32_t expectedPid = static_cast<uint32_t>(Option(env, options, "expectedProcessId", UINT32_MAX));
    if (expectedPid && !windowId)
      throw Failure("ERR_AUDIO_OPTIONS", "expectedProcessId requires an explicit included window");
    state = std::make_shared<State>(env);
    state->excludedPid = excludedPid;
    state->windowId = windowId;
    state->expectedPid = expectedPid;
    session = Object(env);
    napi_value ready, closed;
    NapiCheck(napi_create_promise(env, &state->ready, &ready));
    NapiCheck(napi_create_promise(env, &state->closed, &closed));
    const napi_property_descriptor properties[] = {
      {"ready", nullptr, nullptr, nullptr, nullptr, ready, napi_enumerable, nullptr},
      {"closed", nullptr, nullptr, nullptr, nullptr, closed, napi_enumerable, nullptr},
      {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"snapshot", nullptr, GetSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getStats", nullptr, GetSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    NapiCheck(napi_define_properties(env, session, 5, properties));
    auto wrap = std::make_unique<Shared>(state);
    NapiCheck(napi_wrap(env, session, wrap.get(), FinalizeSession, nullptr, nullptr));
    wrap.release();
    NapiCheck(napi_create_reference(env, info[1], 1, &state->callback));
    auto delivery = std::make_unique<Shared>(state);
    // At most 32 PCM events plus one ready event. Error/closed run after the
    // worker AND the TSFN drain, outside this data queue.
#ifdef MONKY_PACKET_CAPTURE_TEST
    NapiCheck(packet_capture_test::Create(env, info[1], String(env, "PacketCapture"),
        delivery.get(), FinalizeDelivery, state.get(), Deliver, &state->tsfn));
#else
    NapiCheck(napi_create_threadsafe_function(env, info[1], nullptr, String(env, "PacketCapture"),
        kMaxQueuedPackets + 1, 1, delivery.get(), FinalizeDelivery, state.get(), Deliver, &state->tsfn));
#endif
    delivery.release();
#ifdef MONKY_PACKET_CAPTURE_TEST
    packet_capture_test::Created(state->tsfn);
#endif
    NapiCheck(napi_add_async_cleanup_hook(env, Cleanup, state.get(), &state->cleanup));
    if (!state->lease.held()) {
      state->Fail("ERR_AUDIO_BUSY", "Already capturing (legacy or packet mode)");
      state->workDone = true;
      ReleaseProducer(*state);
      queued = true;
      return Napi::Value(env, session);
    }
    NapiCheck(napi_get_uv_event_loop(env, &state->loop));
    auto work = std::make_unique<Shared>(state);
    state->joinWork.data = work.get();
    // Reserve the owned asynchronous join BEFORE starting capture. A scheduler
    // failure therefore cannot leave an unjoinable/orphaned capture thread.
    // Unlike napi_async_work, raw libuv work allows Worker environment cleanup
    // hooks to request stop while this long-lived capture is running.
    if (uv_queue_work(state->loop, &state->joinWork, Join, Complete) != 0)
      throw Failure("ERR_AUDIO_RESOURCE", "Cannot reserve asynchronous capture cleanup");
    state->joinQueued = true;
    work.release();
    state->worker = std::thread(Execute, state);
    {
      std::lock_guard<std::mutex> lock(state->threadMutex);
      state->threadDecided = true;
    }
    state->threadPublished.notify_one();
    queued = true;
    return Napi::Value(env, session);
  } catch (const std::exception& error) {
    const auto* failure = dynamic_cast<const Failure*>(&error);
    const std::string code = failure ? failure->code : "ERR_AUDIO_CAPTURE";
    const bool canReport = state && session && state->tsfn && code != "ERR_AUDIO_NAPI";
    if (state && !queued) {
      state->Fail(code, error.what());
      state->envClosing = !canReport;
      state->workDone = !state->joinQueued;
      {
        std::lock_guard<std::mutex> lock(state->threadMutex);
        state->threadDecided = true;
      }
      state->threadPublished.notify_one();
      if (state->tsfn) ReleaseProducer(*state);
      else { state->deliveryFinalized = true; Finish(*state); }
    }
    if (canReport) return Napi::Value(env, session);
    napi_throw_error(env, code.c_str(), error.what());
    return info.Env().Undefined();
  }
}

}  // namespace screen_audio
