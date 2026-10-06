/**
 * Legacy Buffer/48k/stereo API. Acquisition and teardown are shared with the
 * opt-in packet API; this adapter alone retains the historical chunk resampler.
 */
#include "wasapi_loopback.h"
#include "wasapi_capture.h"
#include <audioclient.h>
#include <ks.h>
#include <ksmedia.h>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <cmath>
#include <memory>
#include <winternl.h>

static std::atomic<bool> g_captureRunning{false};
static std::atomic<bool> g_stop{false};
static std::thread g_captureThread;
static Napi::ThreadSafeFunction g_tsfn_win;
static std::mutex g_statusMutex;
static std::condition_variable g_initialized;
static std::string g_lastError;
static std::atomic<int> g_status{0};

static void setError(const std::string& message) {
  std::lock_guard<std::mutex> lock(g_statusMutex);
  g_lastError = message;
  g_status.store(3);
  g_initialized.notify_all();
}

static float sampleToFloat(const BYTE* data, WORD bits, WORD tag) {
  if (tag == WAVE_FORMAT_IEEE_FLOAT) {
    if (bits == 32) { float value; std::memcpy(&value, data, 4); return value; }
    if (bits == 64) { double value; std::memcpy(&value, data, 8); return static_cast<float>(value); }
  }
  if (bits == 16) { int16_t value; std::memcpy(&value, data, 2); return value / 32768.0f; }
  if (bits == 24) {
    uint32_t raw = (uint32_t(data[2]) << 24) | (uint32_t(data[1]) << 16) | (uint32_t(data[0]) << 8);
    int32_t value; std::memcpy(&value, &raw, 4); return value / 2147483648.0f;
  }
  if (bits == 32) { int32_t value; std::memcpy(&value, data, 4); return value / 2147483648.0f; }
  return 0.0f;
}

static void DeliverLegacy(std::vector<uint8_t>* bytes) {
  const napi_status status = g_tsfn_win.NonBlockingCall(bytes,
      [](Napi::Env env, Napi::Function callback, std::vector<uint8_t>* data) {
        std::unique_ptr<std::vector<uint8_t>> owned(data);
        if (env && callback) callback.Call({Napi::Buffer<uint8_t>::Copy(env, data->data(), data->size())});
      });
  if (status != napi_ok) delete bytes;
}

static void CaptureThreadFunc(uint32_t pid, uint32_t mode, uint32_t rate, uint32_t channels) {
  try {
    WORD sourceTag = 0, sourceChannels = 0, bits = 0, blockAlign = 0;
    DWORD sourceRate = 0;
    screen_audio::CaptureSink sink;
    sink.ready = [&](const WAVEFORMATEX* wave) {
      sourceTag = wave->wFormatTag;
      if (sourceTag == WAVE_FORMAT_EXTENSIBLE) {
        if (wave->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX))
          throw screen_audio::Failure("ERR_AUDIO_FORMAT", "Truncated legacy mix format");
        const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wave);
        if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) sourceTag = WAVE_FORMAT_IEEE_FLOAT;
        else if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_PCM) sourceTag = WAVE_FORMAT_PCM;
      }
      sourceChannels = wave->nChannels;
      sourceRate = wave->nSamplesPerSec;
      bits = wave->wBitsPerSample;
      blockAlign = wave->nBlockAlign;
      if (!sourceChannels || !sourceRate || !blockAlign || !rate || !channels)
        throw screen_audio::Failure("ERR_AUDIO_FORMAT", "Invalid legacy mix format");
      std::lock_guard<std::mutex> lock(g_statusMutex);
      g_lastError.clear();
      g_status.store(2);
      g_initialized.notify_all();
      return !g_stop.load();
    };
    sink.packet = [&](const uint8_t* data, uint32_t frames, uint32_t flags, std::optional<uint64_t>, uint64_t) {
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && frames) {
        auto output = std::make_unique<std::vector<uint8_t>>();
        if (sourceTag == WAVE_FORMAT_IEEE_FLOAT && bits == 32 && rate == sourceRate && channels == sourceChannels) {
          output->assign(data, data + size_t(frames) * blockAlign);
        } else {
          const double ratio = double(rate) / sourceRate;
          const uint32_t outFrames = rate == sourceRate ? frames : static_cast<uint32_t>(std::ceil(frames * ratio));
          output->resize(size_t(outFrames) * channels * sizeof(float));
          for (uint32_t i = 0; i < outFrames; ++i) {
            const uint32_t index = (std::min)(frames - 1, rate == sourceRate ? i : uint32_t(i / ratio));
            for (uint32_t ch = 0; ch < channels; ++ch) {
              const BYTE* sample = data + size_t(index) * blockAlign + (ch < sourceChannels ? ch : 0) * (bits / 8);
              const float value = sampleToFloat(sample, bits, sourceTag);
              std::memcpy(output->data() + (size_t(i) * channels + ch) * sizeof(float), &value, sizeof(value));
            }
          }
        }
        DeliverLegacy(output.release());
      }
      return !g_stop.load();
    };
    screen_audio::RunWasapiCapture({pid, mode == 1}, g_stop, sink);
  } catch (const std::exception& error) {
    const bool wasCapturing = g_status.load() == 2;
    setError(error.what());
    if (wasCapturing && !g_stop.load()) DeliverLegacy(new std::vector<uint8_t>());
  } catch (...) {
    setError("Unexpected WASAPI capture failure");
  }
  g_initialized.notify_all();
}

bool platform_is_supported() {
  OSVERSIONINFOEXW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  using RtlGetVersionPtr = NTSTATUS(NTAPI*)(PRTL_OSVERSIONINFOW);
  auto ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return false;
  auto getVersion = reinterpret_cast<RtlGetVersionPtr>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!getVersion) return false;
  getVersion(reinterpret_cast<PRTL_OSVERSIONINFOW>(&version));
  return version.dwMajorVersion > 10 || (version.dwMajorVersion == 10 && version.dwBuildNumber >= 19041);
}

bool platform_start(uint32_t pid, uint32_t mode, int64_t, uint32_t rate, uint32_t channels,
                    Napi::ThreadSafeFunction tsfn) {
  if (g_captureRunning.exchange(true)) return false;
  g_tsfn_win = tsfn;
  g_stop.store(false);
  {
    std::lock_guard<std::mutex> lock(g_statusMutex);
    g_lastError.clear();
    g_status.store(1);
  }
  try {
    g_captureThread = std::thread(CaptureThreadFunc, pid, mode, rate, channels);
  } catch (const std::exception& error) {
    setError(error.what());
    g_captureRunning.store(false);
    return false;
  }
  {
    std::unique_lock<std::mutex> lock(g_statusMutex);
    g_initialized.wait_for(lock, std::chrono::seconds(3), [] { return g_status.load() != 1; });
  }
  if (g_status.load() == 3) {
    g_stop.store(true);
    g_captureThread.join();
    g_captureRunning.store(false);
    return false;
  }
  return true;
}

void platform_stop() {
  g_stop.store(true);
  if (g_captureThread.joinable()) g_captureThread.join();
  g_captureRunning.store(false);
  g_status.store(0);
}

const char* platform_get_last_error() {
  std::lock_guard<std::mutex> lock(g_statusMutex);
  static thread_local std::string copy;
  copy = g_lastError;
  return copy.c_str();
}
int platform_get_status() { return g_status.load(); }

uint32_t platform_pid_for_hwnd(int64_t hwnd) {
  if (!hwnd) return 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd)), &pid);
  return pid;
}
