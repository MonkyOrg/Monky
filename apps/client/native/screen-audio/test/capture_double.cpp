#include "..\src\win\wasapi_capture.h"
#include <napi.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <thread>
#include <unordered_map>
#include <uv.h>
#include <ks.h>
#include <ksmedia.h>

namespace screen_audio {
Napi::Value CreatePacketCapture(const Napi::CallbackInfo&);
static std::atomic<int> scenario{0}, activeWorkers{0};
static std::unique_ptr<CaptureLease> legacy;

namespace packet_capture_test {
enum Metric : size_t {
  tsfnCreated, packetGates, conversionGates, packetPushes, pushesAfterFinalizer,
  napiClosing, queueFailures, releaseAttempts, releaseCalls, releaseErrors,
  ownershipViolations, eventAllocations, eventDeletions, packetDeletions,
  cleanupStarts, finalizers, finalizerReturns, joins, cleanupRemovals,
  finishes, queuedAtFinish, conversionFailures, callbackRefDeletes, gateErrors,
  abortCalls, testAborts, pendingAtFinalizer, pendingAtFinish, deliveriesAfterFinalizer,
  revokedEvents, legacyQueuedGates, legacyDeferredEvents, legacyNativeFinalizers,
  legacyNativeDestroyed, legacyForcedReclaims, legacyFinalizeAfterJoin, legacyDisposals,
  earlyFinish, cleanupPushCompletions, cleanupPushes, envNullDisposals, metricCount
};
constexpr const char* metricNames[] = {
  "tsfnCreated", "packetGates", "conversionGates", "packetPushes", "pushesAfterFinalizer",
  "napiClosing", "queueFailures", "releaseAttempts", "releaseCalls", "releaseErrors",
  "ownershipViolations", "eventAllocations", "eventDeletions", "packetDeletions",
  "cleanupStarts", "finalizers", "finalizerReturns", "joins", "cleanupRemovals",
  "finishes", "queuedAtFinish", "conversionFailures", "callbackRefDeletes", "gateErrors",
  "abortCalls", "testAborts", "pendingAtFinalizer", "pendingAtFinish", "deliveriesAfterFinalizer",
  "revokedEvents", "legacyQueuedGates", "legacyDeferredEvents", "legacyNativeFinalizers",
  "legacyNativeDestroyed", "legacyForcedReclaims", "legacyFinalizeAfterJoin", "legacyDisposals",
  "earlyFinish", "cleanupPushCompletions", "cleanupPushes", "envNullDisposals"
};
static_assert(std::size(metricNames) == metricCount);
static std::mutex traceMutex;
static std::condition_variable gate;
static std::array<uint64_t, metricCount> metrics{};
static std::unordered_map<napi_threadsafe_function, bool> producerOwned;
static bool gateOpen = false;
static uint64_t refillPermits = 0;

struct LegacyDelivery {
  napi_env env;
  napi_threadsafe_function function = nullptr;
  napi_finalize finalize;
  void* finalizeData;
  napi_threadsafe_function_call_js deliver;
  void* context;
  std::vector<void*> packets, deferred;
  uv_timer_t afterJoin{};
  bool nativeReturned = false, disposed = false, timerClosed = true;
};
static std::unique_ptr<LegacyDelivery> legacyDelivery;

void Observe(const char* point, size_t value) noexcept {
  std::unique_lock<std::mutex> lock(traceMutex);
  for (size_t index = 0; index < metricCount; ++index) {
    if (std::strcmp(point, metricNames[index]) == 0) {
      metrics[index] += value;
      if (index == cleanupStarts && scenario.load() == 12) {
        // Hold only this test Worker's cleanup hook until a real native enqueue
        // completes. Node cannot dispatch it while its JS thread is in this hook.
        gateOpen = true;
        gate.notify_all();
        if (!gate.wait_for(lock, std::chrono::seconds(5),
            [] { return metrics[cleanupPushCompletions] == 1; })) ++metrics[gateErrors];
      }
      return;
    }
  }
  std::terminate();
}

static void DisposeLegacy(LegacyDelivery& bridge) noexcept {
  bridge.finalize(bridge.env, bridge.finalizeData, bridge.context);
  bridge.finalizeData = nullptr;
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    if (metrics[finishes]) ++metrics[earlyFinish];
  }
  for (void* event : bridge.deferred) {
    bridge.deliver(nullptr, nullptr, bridge.context, event);
    Observe("legacyDisposals", 1);
  }
  bridge.deferred.clear();
  std::lock_guard<std::mutex> lock(traceMutex);
  bridge.disposed = true;
}

static void LegacyFinalize(napi_env env, void* data, void*) noexcept {
  auto& bridge = *static_cast<LegacyDelivery*>(data);
  bool reclaim = false;
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    ++metrics[legacyNativeFinalizers];
    auto owner = producerOwned.find(bridge.function);
    reclaim = owner != producerOwned.end() && owner->second;
    if (reclaim) {
      owner->second = false;
      ++metrics[legacyForcedReclaims];
    }
  }
  // Model Node 20's destruction despite outstanding acquisitions. On Node 24,
  // consume a leftover test reference so a broken implementation fails safely.
  if (reclaim && napi_release_threadsafe_function(bridge.function, napi_tsfn_release) != napi_ok)
    Observe("gateErrors", 1);
  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || uv_timer_init(loop, &bridge.afterJoin) != 0) {
    Observe("gateErrors", 1);
    DisposeLegacy(bridge);
    return;
  }
  bridge.timerClosed = false;
  bridge.afterJoin.data = &bridge;
  const auto close = [](uv_handle_t* handle) {
    auto& bridge = *static_cast<LegacyDelivery*>(handle->data);
    std::lock_guard<std::mutex> lock(traceMutex);
    bridge.timerClosed = true;
  };
  if (uv_timer_start(&bridge.afterJoin, [](uv_timer_t* timer) {
    auto& bridge = *static_cast<LegacyDelivery*>(timer->data);
    bool joined = false;
    {
      std::lock_guard<std::mutex> lock(traceMutex);
      if (!bridge.nativeReturned) {
        bridge.nativeReturned = true;
        ++metrics[legacyNativeDestroyed];
      }
      joined = metrics[joins] == 1;
      if (joined) ++metrics[legacyFinalizeAfterJoin];
    }
    if (!joined) return;
    uv_timer_stop(timer);
    uv_close(reinterpret_cast<uv_handle_t*>(timer), [](uv_handle_t* handle) {
      auto& bridge = *static_cast<LegacyDelivery*>(handle->data);
      std::lock_guard<std::mutex> lock(traceMutex);
      bridge.timerClosed = true;
    });
    // Force the dangerous Node-20 ordering: work completion, addon finalizer,
    // then env-null queued-data callbacks. No Electron or device is involved.
    DisposeLegacy(bridge);
  }, 0, 1) != 0) {
    Observe("gateErrors", 1);
    uv_close(reinterpret_cast<uv_handle_t*>(&bridge.afterJoin), close);
    DisposeLegacy(bridge);
  }
}

static void LegacyDeliver(napi_env env, napi_value callback, void* context, void* data) noexcept {
  auto& bridge = *static_cast<LegacyDelivery*>(context);
  bool defer = false;
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    const auto packet = std::find(bridge.packets.begin(), bridge.packets.end(), data);
    defer = !env || packet != bridge.packets.end();
    if (packet != bridge.packets.end()) bridge.packets.erase(packet);
    if (defer) {
      bridge.deferred.push_back(data);
      ++metrics[legacyDeferredEvents];
    }
  }
  if (!defer) bridge.deliver(env, callback, bridge.context, data);
}

napi_status Create(napi_env env, napi_value callback, napi_value name, void* finalizeData,
    napi_finalize finalize, void* context, napi_threadsafe_function_call_js deliver,
    napi_threadsafe_function* result) {
  if (scenario.load() != 11)
    return napi_create_threadsafe_function(env, callback, nullptr, name, kMaxQueuedPackets + 1,
        1, finalizeData, finalize, context, deliver, result);
  auto bridge = std::make_unique<LegacyDelivery>();
  bridge->env = env;
  bridge->finalize = finalize;
  bridge->finalizeData = finalizeData;
  bridge->context = context;
  bridge->deliver = deliver;
  bridge->packets.reserve(kMaxQueuedPackets + 1);
  bridge->deferred.reserve(kMaxQueuedPackets + 1);
  const auto status = napi_create_threadsafe_function(env, callback, nullptr, name,
      kMaxQueuedPackets + 1, 1, bridge.get(), LegacyFinalize, bridge.get(), LegacyDeliver, result);
  if (status == napi_ok) {
    bridge->function = *result;
    legacyDelivery = std::move(bridge);
  }
  return status;
}

void Created(napi_threadsafe_function function) {
  std::lock_guard<std::mutex> lock(traceMutex);
  producerOwned[function] = true;
  ++metrics[tsfnCreated];
}

static bool Owns(napi_threadsafe_function function) {
  const auto found = producerOwned.find(function);
  if (found != producerOwned.end() && found->second) return true;
  ++metrics[ownershipViolations];
  return false;
}

static void WaitAtGate(Metric point) {
  std::unique_lock<std::mutex> lock(traceMutex);
  ++metrics[point];
  gate.wait(lock, [] { return gateOpen; });
}

void BeforeQueue(bool packet) noexcept {
  // Outside the production handle guard: model a producer still converting PCM.
  if (packet && (scenario.load() == 7 || scenario.load() == 10 || scenario.load() == 12))
    WaitAtGate(packetGates);
}

napi_status Push(napi_threadsafe_function function, void* event, bool packet) noexcept {
  const bool injectedFailure = packet && scenario.load() == 9;
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    if (!Owns(function)) return napi_invalid_arg;
    if (packet && !injectedFailure) {
      ++metrics[packetPushes];
      if (metrics[finalizerReturns]) ++metrics[pushesAfterFinalizer];
      if (scenario.load() == 11) legacyDelivery->packets.push_back(event);
    }
  }
  // Never hold the test mutex across Node calls or finalizers.
  const auto status = injectedFailure ? napi_generic_failure
      : napi_call_threadsafe_function(function, event, napi_tsfn_nonblocking);
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    if (status == napi_closing) {
      producerOwned[function] = false;
      ++metrics[napiClosing];
    }
    if (status != napi_ok) {
      ++metrics[queueFailures];
      if (packet && scenario.load() == 11) {
        auto& packets = legacyDelivery->packets;
        const auto failed = std::find(packets.begin(), packets.end(), event);
        if (failed != packets.end()) packets.erase(failed);
      }
    }
    if (packet && scenario.load() == 12) {
      ++metrics[cleanupPushCompletions];
      if (status == napi_ok) ++metrics[cleanupPushes];
    }
  }
  if (packet && scenario.load() == 12) gate.notify_all();
  if (packet && scenario.load() == 15) gate.notify_all();
  return status;
}

napi_status Release(napi_threadsafe_function function, napi_threadsafe_function_release_mode mode) noexcept {
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    ++metrics[releaseAttempts];
    // Make a regression a deterministic assertion instead of dereferencing freed memory.
    if (!Owns(function)) return napi_invalid_arg;
    producerOwned[function] = false;
    ++metrics[releaseCalls];
    if (mode == napi_tsfn_abort) ++metrics[abortCalls];
  }
  const auto status = napi_release_threadsafe_function(function, mode);
  if (status != napi_ok) Observe("releaseErrors", 1);
  return status;
}

void Finalized(napi_env env) noexcept {
  bool needsFence = false;
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    ++metrics[finalizers];
    needsFence = (metrics[cleanupStarts] && (scenario.load() == 7 || scenario.load() == 8)) ||
        scenario.load() == 10;
  }
  if (!needsFence) return;
  uv_loop_t* loop = nullptr;
  auto fence = std::unique_ptr<uv_idle_t>(new (std::nothrow) uv_idle_t{});
  if (!fence || napi_get_uv_event_loop(env, &loop) != napi_ok ||
      uv_idle_init(loop, fence.get()) != 0) {
    Observe("gateErrors", 1);
    return;
  }
  // A later close callback proves Node's Finalize/MaybeDelete returned.
  uv_close(reinterpret_cast<uv_handle_t*>(fence.release()), [](uv_handle_t* handle) {
    std::unique_ptr<uv_idle_t> owned(reinterpret_cast<uv_idle_t*>(handle));
    Observe("finalizerReturns", 1);
  });
}

static bool Reset() {
  std::lock_guard<std::mutex> lock(traceMutex);
  if (legacyDelivery && (!legacyDelivery->disposed || !legacyDelivery->timerClosed)) return false;
  legacyDelivery.reset();
  metrics.fill(0);
  producerOwned.clear();
  gateOpen = false;
  refillPermits = 0;
  return true;
}

static void ReleaseGate() {
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    gateOpen = true;
  }
  gate.notify_all();
}

static void WaitForRefill(uint64_t count, const std::atomic<bool>& stop) {
  std::unique_lock<std::mutex> lock(traceMutex);
  while (refillPermits < count && !stop.load())
    gate.wait_for(lock, std::chrono::milliseconds(1));
}

static bool Refill(bool wait) {
  std::unique_lock<std::mutex> lock(traceMutex);
  const auto count = ++refillPermits;
  gate.notify_all();
  return !wait || gate.wait_for(lock, std::chrono::seconds(2),
      [&] { return metrics[packetPushes] > count; });
}

static bool AbortDelivery(napi_env env) {
  const napi_node_version* version = nullptr;
  if (napi_get_node_version(env, &version) != napi_ok || version->major != 24 ||
      version->minor != 19 || version->patch != 0) return false;
  napi_threadsafe_function function = nullptr;
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    if (scenario.load() != 10 || metrics[packetGates] != 1 || gateOpen ||
        metrics[cleanupStarts] || metrics[finalizers]) return false;
    for (const auto& entry : producerOwned) if (entry.second) function = entry.first;
  }
  if (!function || napi_acquire_threadsafe_function(function) != napi_ok) return false;
  // Abort only the extra test acquisition, leaving the producer's real one live.
  const auto status = napi_release_threadsafe_function(function, napi_tsfn_abort);
  if (status == napi_ok) Observe("testAborts", 1);
  return status == napi_ok;
}

static Napi::Object Snapshot(Napi::Env env) {
  std::array<uint64_t, metricCount> copy;
  uint32_t owners = 0;
  {
    std::lock_guard<std::mutex> lock(traceMutex);
    copy = metrics;
    for (const auto& entry : producerOwned) if (entry.second) ++owners;
  }
  auto result = Napi::Object::New(env);
  for (size_t index = 0; index < metricCount; ++index)
    result.Set(metricNames[index], Napi::Number::New(env, static_cast<double>(copy[index])));
  result.Set("outstandingOwners", Napi::Number::New(env, owners));
  return result;
}
}  // namespace packet_capture_test

CaptureTarget ResolvePacketTarget(uint32_t, int64_t windowId) {
  if (windowId == 999) throw Failure("ERR_AUDIO_TARGET", "Double: invalid window");
  return {0, false};
}

void RunWasapiCapture(CaptureTarget, std::atomic<bool>& stop, const CaptureSink& sink) {
  struct Active {
    Active() { activeWorkers.fetch_add(1); }
    ~Active() { activeWorkers.fetch_sub(1); }
  } active;
  const int mode = scenario.load();
  if (mode == 1) throw Failure("ERR_AUDIO_STARTUP", "Double: startup failure");
  if (mode == 2) {
    while (!stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    return;
  }
  if (mode == 13) {
    WAVEFORMATEXTENSIBLE wave{};
    wave.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    wave.Format.cbSize = sizeof(wave) - sizeof(WAVEFORMATEX);
    wave.Format.nChannels = 8;
    wave.Format.nSamplesPerSec = 48000;
    wave.Format.wBitsPerSample = 32;
    wave.Format.nBlockAlign = 32;
    wave.Format.nAvgBytesPerSec = 48000 * 32;
    wave.Samples.wValidBitsPerSample = 32;
    wave.dwChannelMask = 1599;
    wave.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    if (!sink.ready(&wave.Format)) return;
    std::vector<float> pcm(480 * 8);
    for (size_t frame = 0; frame < 480; ++frame) {
      pcm[frame * 8] = .25f;
      pcm[frame * 8 + 1] = -.25f;
    }
    for (uint64_t i = 0; i < 12 && !stop.load(); ++i) {
      const auto flags = i == 5 ? kSilent : 0;
      if (!sink.packet(flags ? nullptr : reinterpret_cast<const uint8_t*>(pcm.data()),
          480, flags, std::nullopt, 665768587240ULL + i * 100000)) return;
    }
    while (!stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    return;
  }
  WAVEFORMATEX wave{};
  wave.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  wave.nChannels = 2;
  wave.nSamplesPerSec = 44100;
  wave.wBitsPerSample = 32;
  wave.nBlockAlign = 8;
  wave.nAvgBytesPerSec = 44100 * 8;
  if (mode == 6) wave.nBlockAlign = 1;
  if (!sink.ready(&wave)) return;
  const float pcm[] = {.25f, -.5f, .75f, -1.0f};
  if (mode == 14 || mode == 15) {
    packet_capture_test::WaitAtGate(packet_capture_test::packetGates);
    std::vector<float> samples(441 * 2, .25f);
    for (uint64_t i = 0; i < 96 && !stop.load(); ++i) {
      if (!sink.packet(reinterpret_cast<const uint8_t*>(samples.data()), 441, 0,
          i * 441, 80000000ULL + i * 100000)) return;
      if (mode == 15 && i != 95) packet_capture_test::WaitForRefill(i + 1, stop);
    }
  } else if (mode == 8) {
    packet_capture_test::WaitAtGate(packet_capture_test::conversionGates);
    const float invalid[] = {std::numeric_limits<float>::quiet_NaN(), 0, 0, 0};
    try {
      sink.packet(reinterpret_cast<const uint8_t*>(invalid), 2, 0, 10, 123456789);
    } catch (const Failure& error) {
      if (error.code == "ERR_AUDIO_PCM") packet_capture_test::Observe("conversionFailures", 1);
      throw;
    }
  } else if (mode == 3) {
    for (uint32_t i = 0; i < 100000 && !stop.load(); ++i)
      if (!sink.packet(reinterpret_cast<const uint8_t*>(pcm), 2, 0, i * 2, uint64_t(i) * 100)) return;
  } else if (mode == 11) {
    if (!sink.packet(reinterpret_cast<const uint8_t*>(pcm), 2, 0, 10, 123456789)) return;
    packet_capture_test::WaitAtGate(packet_capture_test::legacyQueuedGates);
    if (!sink.packet(reinterpret_cast<const uint8_t*>(pcm), 2, 0, 12, 123457789)) return;
  } else if (mode == 7 || mode == 9 || mode == 10 || mode == 12) {
    if (!sink.packet(reinterpret_cast<const uint8_t*>(pcm), 2, 0, 10, 123456789)) return;
  } else if (mode != 4) {
    if (!sink.packet(reinterpret_cast<const uint8_t*>(pcm), 2, 0, 10, 123456789)) return;
    if (!sink.packet(nullptr, 2, kSilent, 12, 123457789)) return;
    if (!sink.packet(reinterpret_cast<const uint8_t*>(pcm), 2, kTimestampError, UINT64_MAX, UINT64_MAX)) return;
    if (!sink.packet(reinterpret_cast<const uint8_t*>(pcm), 2, kDiscontinuity, 0, 123458789)) return;
  }
  if (mode == 5) throw Failure("ERR_AUDIO_WASAPI", "Double: device lost");
  while (!stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
}
}  // namespace screen_audio

static Napi::Object InitDouble(Napi::Env env, Napi::Object exports) {
  using namespace screen_audio;
  exports.Set("createPacketCapture", Napi::Function::New(env, CreatePacketCapture));
  exports.Set("configure", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    if (activeWorkers.load() || !packet_capture_test::Reset()) {
      Napi::Error::New(info.Env(), "Cannot reset an active acquisition double").ThrowAsJavaScriptException();
      return info.Env().Undefined();
    }
    scenario.store(info[0].As<Napi::Number>().Int32Value());
    return info.Env().Undefined();
  }));
  exports.Set("trace", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return packet_capture_test::Snapshot(info.Env());
  }));
  exports.Set("releaseGate", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    packet_capture_test::ReleaseGate();
    return info.Env().Undefined();
  }));
  exports.Set("refill", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), packet_capture_test::Refill(info[0].As<Napi::Boolean>().Value()));
  }));
  exports.Set("abortDelivery", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), packet_capture_test::AbortDelivery(info.Env()));
  }));
  exports.Set("activeWorkers", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), activeWorkers.load());
  }));
  exports.Set("legacyStart", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    if (legacy) return Napi::Boolean::New(info.Env(), false);
    auto candidate = std::make_unique<CaptureLease>(CaptureOwner::legacy);
    if (!candidate->held()) return Napi::Boolean::New(info.Env(), false);
    legacy = std::move(candidate);
    return Napi::Boolean::New(info.Env(), true);
  }));
  exports.Set("legacyStop", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    legacy.reset();
    return info.Env().Undefined();
  }));
  return exports;
}

// This module only exports functions. No WASAPI implementation is linked.
NODE_API_MODULE(audio_capture_double, InitDouble)
