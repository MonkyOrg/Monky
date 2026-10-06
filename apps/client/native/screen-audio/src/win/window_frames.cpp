// Counts the frames Windows composes for a window's own content. Browsers stop
// painting a fully covered window, but some keep painting it; only the content
// frame rate tells those cases apart. The cursor is excluded because moving it
// over the window makes Windows compose frames even when the content is frozen.
#include <napi.h>
#include <windows.h>
#include <unknwn.h>
#include <inspectable.h>
#include <d3d11.h>
#include <dxgi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
namespace capture = winrt::Windows::Graphics::Capture;
namespace directx = winrt::Windows::Graphics::DirectX;
using winrt::Windows::Foundation::Metadata::ApiInformation;

enum class ProbeState : int { Starting, Running, Failed, Closed };

struct FrameProbe {
  napi_env owner = nullptr;
  HWND hwnd = nullptr;
  HANDLE stop = nullptr;
  std::atomic<int> state{static_cast<int>(ProbeState::Starting)};
  std::atomic<uint64_t> frames{0};
  std::atomic<bool> finished{false};
  std::mutex errorMutex;
  std::string error;
  std::thread thread;

  ~FrameProbe() {
    if (stop) CloseHandle(stop);
  }

  void Fail(std::string message) {
    {
      std::lock_guard<std::mutex> lock(errorMutex);
      error = std::move(message);
    }
    state = static_cast<int>(ProbeState::Failed);
  }
};

std::mutex g_mutex;
std::map<uint32_t, std::shared_ptr<FrameProbe>> g_probes;
std::vector<std::shared_ptr<FrameProbe>> g_retired;
uint32_t g_nextId = 1;
constexpr size_t kMaxProbes = 8;

std::string HresultMessage(const std::string& stage, HRESULT code) {
  char hex[16];
  std::snprintf(hex, sizeof(hex), "0x%08lX", static_cast<unsigned long>(code));
  return stage + " (" + hex + ")";
}

winrt::com_ptr<ID3D11Device> CreateDevice() {
  winrt::com_ptr<ID3D11Device> device;
  for (const auto type : {D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP}) {
    if (SUCCEEDED(D3D11CreateDevice(nullptr, type, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                    D3D11_SDK_VERSION, device.put(), nullptr, nullptr)))
      return device;
    device = nullptr;
  }
  return nullptr;
}

void RunProbe(std::shared_ptr<FrameProbe> probe) {
  bool apartment = false;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    apartment = true;
  } catch (...) {
  }
  try {
    if (!capture::GraphicsCaptureSession::IsSupported()) {
      probe->Fail("Windows Graphics Capture is unavailable");
    } else if (!ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession",
                                                  L"IsCursorCaptureEnabled")) {
      probe->Fail("Windows Graphics Capture cannot exclude the cursor");
    } else {
      const auto d3d = CreateDevice();
      if (!d3d) throw winrt::hresult_error(E_FAIL, L"D3D11 device creation failed");
      winrt::com_ptr<::IInspectable> inspectable;
      winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(d3d.as<IDXGIDevice>().get(), inspectable.put()));
      const auto device = inspectable.as<directx::Direct3D11::IDirect3DDevice>();
      const auto interop = winrt::get_activation_factory<capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
      capture::GraphicsCaptureItem item{nullptr};
      winrt::check_hresult(interop->CreateForWindow(probe->hwnd, winrt::guid_of<capture::GraphicsCaptureItem>(),
                                                    winrt::put_abi(item)));
      auto pool = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
          device, directx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item.Size());
      const auto arrived = pool.FrameArrived([probe](capture::Direct3D11CaptureFramePool const& sender, auto&&) {
        if (auto frame = sender.TryGetNextFrame()) {
          probe->frames.fetch_add(1);
          frame.Close();
        }
      });
      const auto closed = item.Closed([probe](auto&&, auto&&) {
        probe->state = static_cast<int>(ProbeState::Closed);
        SetEvent(probe->stop);
      });
      auto session = pool.CreateCaptureSession(item);
      session.IsCursorCaptureEnabled(false);
      if (ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
        try {
          if (ApiInformation::IsTypePresent(L"Windows.Graphics.Capture.GraphicsCaptureAccess"))
            capture::GraphicsCaptureAccess::RequestAccessAsync(capture::GraphicsCaptureAccessKind::Borderless).get();
          session.IsBorderRequired(false);
        } catch (...) {
          // Older builds keep the capture border; counting frames still works.
        }
      }
      session.StartCapture();
      int expected = static_cast<int>(ProbeState::Starting);
      probe->state.compare_exchange_strong(expected, static_cast<int>(ProbeState::Running));
      WaitForSingleObject(probe->stop, INFINITE);
      pool.FrameArrived(arrived);
      item.Closed(closed);
      session.Close();
      pool.Close();
    }
  } catch (const winrt::hresult_error& error) {
    probe->Fail(HresultMessage(winrt::to_string(error.message()), error.code()));
  } catch (const std::exception& error) {
    probe->Fail(error.what());
  } catch (...) {
    probe->Fail("Window frame probe failed");
  }
  if (apartment) winrt::uninit_apartment();
  probe->finished = true;
}

// Joins retired probe threads that already released their capture session.
void ReapRetired() {
  std::vector<std::shared_ptr<FrameProbe>> done;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    for (auto it = g_retired.begin(); it != g_retired.end();) {
      if ((*it)->finished) {
        done.push_back(*it);
        it = g_retired.erase(it);
      } else {
        ++it;
      }
    }
  }
  for (const auto& probe : done)
    if (probe->thread.joinable()) probe->thread.join();
}

void StopEnvProbes(void* data) {
  const auto env = static_cast<napi_env>(data);
  std::vector<std::shared_ptr<FrameProbe>> stopping;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    for (auto it = g_probes.begin(); it != g_probes.end();) {
      if (it->second->owner == env) {
        stopping.push_back(it->second);
        it = g_probes.erase(it);
      } else {
        ++it;
      }
    }
    for (auto it = g_retired.begin(); it != g_retired.end();) {
      if ((*it)->owner == env) {
        stopping.push_back(*it);
        it = g_retired.erase(it);
      } else {
        ++it;
      }
    }
  }
  for (const auto& probe : stopping) SetEvent(probe->stop);
  for (const auto& probe : stopping) {
    if (!probe->thread.joinable()) continue;
    // A capture that cannot shut down must not hang process exit.
    if (WaitForSingleObject(probe->thread.native_handle(), 2000) == WAIT_OBJECT_0) probe->thread.join();
    else probe->thread.detach();
  }
}

bool ReadId(const Napi::CallbackInfo& info, const char* message, double max, double& value) {
  const auto env = info.Env();
  if (info.Length() != 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
    return false;
  }
  value = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(value) || value < 1 || value > max || std::floor(value) != value) {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

const char* StateName(ProbeState state) {
  switch (state) {
    case ProbeState::Running: return "running";
    case ProbeState::Failed: return "failed";
    case ProbeState::Closed: return "closed";
    default: return "starting";
  }
}
}  // namespace

// Starts counting the content frames of a top-level window on a background
// thread. Returns the probe id, or null when the window no longer exists.
Napi::Value platform_start_window_frame_probe(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  double value = 0;
  if (!ReadId(info, "A positive safe-integer HWND is required", 9007199254740991.0, value)) return env.Undefined();
  const auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(value));
  if (!IsWindow(hwnd) || GetAncestor(hwnd, GA_ROOT) != hwnd) return env.Null();
  ReapRetired();
  auto probe = std::make_shared<FrameProbe>();
  probe->owner = env;
  probe->hwnd = hwnd;
  probe->stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!probe->stop) {
    Napi::Error::New(env, HresultMessage("CreateEvent failed", HRESULT_FROM_WIN32(GetLastError())))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_probes.size() >= kMaxProbes) {
    Napi::Error::New(env, "Too many window frame probes are running").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    probe->thread = std::thread(RunProbe, probe);
  } catch (const std::exception& error) {
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const auto id = g_nextId++;
  g_probes.emplace(id, std::move(probe));
  return Napi::Number::New(env, id);
}

// Snapshot of a probe: { state, frames, error }, or null for an unknown id.
Napi::Value platform_get_window_frame_probe(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  double value = 0;
  if (!ReadId(info, "A positive window frame probe id is required", 4294967295.0, value)) return env.Undefined();
  std::shared_ptr<FrameProbe> probe;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    const auto found = g_probes.find(static_cast<uint32_t>(value));
    if (found == g_probes.end()) return env.Null();
    probe = found->second;
  }
  auto result = Napi::Object::New(env);
  result.Set("state", StateName(static_cast<ProbeState>(probe->state.load())));
  result.Set("frames", Napi::Number::New(env, static_cast<double>(probe->frames.load())));
  std::lock_guard<std::mutex> lock(probe->errorMutex);
  result.Set("error", probe->error.empty() ? env.Null() : Napi::String::New(env, probe->error));
  return result;
}

// Stops a probe without waiting for its capture session to close.
Napi::Value platform_stop_window_frame_probe(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  double value = 0;
  if (!ReadId(info, "A positive window frame probe id is required", 4294967295.0, value)) return env.Undefined();
  bool stopped = false;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    const auto found = g_probes.find(static_cast<uint32_t>(value));
    if (found != g_probes.end()) {
      SetEvent(found->second->stop);
      g_retired.push_back(found->second);
      g_probes.erase(found);
      stopped = true;
    }
  }
  ReapRetired();
  return Napi::Boolean::New(env, stopped);
}

void platform_register_window_frame_probes(Napi::Env env) {
  napi_add_env_cleanup_hook(env, StopEnvProbes, static_cast<napi_env>(env));
}
