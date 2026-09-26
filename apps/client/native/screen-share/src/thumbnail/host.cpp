#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
#include <cstdio>
#include <cstring>
#include <optional>
#include "contract.h"
#include "lifetime.h"

using namespace monky::thumbnail;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

namespace {
std::uint64_t Creation(HANDLE process) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  Require(GetProcessTimes(process, &creation, &exit, &kernel, &user), "ERR_DESKTOP_PREVIEW_IDENTITY");
  return (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
}
struct MonitorSearch {
  const Arguments& arguments;
  HMONITOR match = nullptr;
  unsigned matches = 0, visited = 0;
  bool failed = false;
};
BOOL CALLBACK FindMonitor(HMONITOR monitor, HDC, LPRECT, LPARAM data) noexcept {
  auto& search = *reinterpret_cast<MonitorSearch*>(data);
  if (++search.visited > 64) { search.failed = true; return FALSE; }
  MONITORINFOEXW info{}; info.cbSize = sizeof(info);
  DISPLAY_DEVICEW device{}; device.cb = sizeof(device);
  if (!GetMonitorInfoW(monitor, &info) ||
      !EnumDisplayDevicesW(info.szDevice, 0, &device, EDD_GET_DEVICE_INTERFACE_NAME)) {
    search.failed = true; return FALSE;
  }
  if (search.arguments.deviceId == device.DeviceID) {
    ++search.matches; search.match = monitor;
    const auto& a = search.arguments;
    if (a.deviceName != info.szDevice || a.left != info.rcMonitor.left || a.top != info.rcMonitor.top ||
        a.width != static_cast<std::uint32_t>(info.rcMonitor.right - info.rcMonitor.left) ||
        a.height != static_cast<std::uint32_t>(info.rcMonitor.bottom - info.rcMonitor.top)) search.failed = true;
  }
  return TRUE;
}
struct Target {
  const Arguments& arguments;
  Handle process;
  HWND window = nullptr;
  HMONITOR monitor = nullptr;
  explicit Target(const Arguments& a) : arguments(a) {
    if (a.window) {
      window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(a.hwnd));
      DWORD pid = 0;
      Require(IsWindow(window) && GetWindowThreadProcessId(window, &pid) && pid == a.pid,
          "ERR_DESKTOP_PREVIEW_IDENTITY");
      process.value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, a.pid);
      Require(process.value != nullptr, "ERR_DESKTOP_PREVIEW_IDENTITY");
      Verify();
      monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONULL);
      Require(monitor != nullptr, "ERR_DESKTOP_PREVIEW_UNAVAILABLE");
    } else {
      monitor = ResolveMonitor();
      Verify();
    }
  }
  HMONITOR ResolveMonitor() const {
    MonitorSearch search{arguments};
    Require(EnumDisplayMonitors(nullptr, nullptr, FindMonitor, reinterpret_cast<LPARAM>(&search)) &&
        !search.failed && search.matches == 1, "ERR_DESKTOP_PREVIEW_IDENTITY");
    return search.match;
  }
  void Verify() const {
    if (!arguments.window) {
      Require(ResolveMonitor() == monitor, "ERR_DESKTOP_PREVIEW_IDENTITY");
      return;
    }
    DWORD pid = 0;
    Require(IsWindow(window) && GetWindowThreadProcessId(window, &pid) && pid == arguments.pid &&
        GetAncestor(window, GA_ROOT) == window &&
        WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT && Creation(process.value) == arguments.creation,
        "ERR_DESKTOP_PREVIEW_IDENTITY");
    DWORD affinity = 0, cloaked = 0;
    Require(GetWindowDisplayAffinity(window, &affinity), "ERR_DESKTOP_PREVIEW_UNAVAILABLE");
    Require(affinity == WDA_NONE, "ERR_DESKTOP_PREVIEW_PROTECTED");
    Require(SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) &&
        !cloaked && IsWindowVisible(window) && !IsIconic(window), "ERR_DESKTOP_PREVIEW_UNAVAILABLE");
  }
};
void Deadline(std::uint64_t deadline) {
  Require(GetTickCount64() < deadline, "ERR_DESKTOP_PREVIEW_TIMEOUT");
}
winrt::com_ptr<IDXGIAdapter1> AdapterFor(HMONITOR monitor) {
  winrt::com_ptr<IDXGIFactory1> factory;
  winrt::check_hresult(CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void()));
  winrt::com_ptr<IDXGIAdapter1> selected;
  unsigned matches = 0;
  for (UINT index = 0; index < 64; ++index) {
    winrt::com_ptr<IDXGIAdapter1> adapter;
    const auto found = factory->EnumAdapters1(index, adapter.put());
    if (found == DXGI_ERROR_NOT_FOUND) break;
    winrt::check_hresult(found);
    Require(index < 63, "ERR_DESKTOP_PREVIEW_DEVICE");
    for (UINT outputIndex = 0; outputIndex < 64; ++outputIndex) {
      winrt::com_ptr<IDXGIOutput> output;
      const auto result = adapter->EnumOutputs(outputIndex, output.put());
      if (result == DXGI_ERROR_NOT_FOUND) break;
      winrt::check_hresult(result);
      Require(outputIndex < 63, "ERR_DESKTOP_PREVIEW_DEVICE");
      DXGI_OUTPUT_DESC description{};
      winrt::check_hresult(output->GetDesc(&description));
      if (description.AttachedToDesktop && description.Monitor == monitor) { ++matches; selected = adapter; }
    }
  }
  Require(matches == 1 && selected, "ERR_DESKTOP_PREVIEW_DEVICE");
  return selected;
}
struct Capture {
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  Direct3D11CaptureFrame frame{nullptr};
  ~Capture() {
    try { Close(); } catch (...) {}
  }
  void Close() {
    if (frame) { frame.Close(); frame = nullptr; }
    if (session) { session.Close(); session = nullptr; }
    if (pool) { pool.Close(); pool = nullptr; }
    item = nullptr;
  }
};
struct Pixels {
  std::uint32_t width = 0, height = 0;
  std::vector<std::uint8_t> bytes;
};
void Drain(ID3D11Device* device, ID3D11DeviceContext* context, std::uint64_t deadline) {
  D3D11_QUERY_DESC description{D3D11_QUERY_EVENT, 0};
  winrt::com_ptr<ID3D11Query> query;
  winrt::check_hresult(device->CreateQuery(&description, query.put()));
  context->End(query.get());
  context->Flush();
  while (true) {
    Deadline(deadline);
    const auto status = context->GetData(query.get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (status == S_OK) break;
    winrt::check_hresult(status);
    Require(status == S_FALSE, "ERR_DESKTOP_PREVIEW_READBACK");
    Sleep(2);
  }
  winrt::check_hresult(device->GetDeviceRemovedReason());
}
Pixels Read(const Target& target, std::uint64_t deadline) {
  Require(GraphicsCaptureSession::IsSupported(), "ERR_DESKTOP_PREVIEW_UNSUPPORTED");
  const bool borderlessSupported =
      winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired") &&
      winrt::Windows::Foundation::Metadata::ApiInformation::IsTypePresent(
        L"Windows.Graphics.Capture.GraphicsCaptureAccess");
  Require(borderlessSupported, "ERR_DESKTOP_PREVIEW_BORDER_UNSUPPORTED");
  const auto borderAccess = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless).get();
  const bool borderlessAllowed =
      borderAccess == winrt::Windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus::Allowed;
  // Setting IsBorderRequired(false) alone is ignored when access was denied.
  // Do not start a preview session at all in that case.
  Require(borderlessAllowed, "ERR_DESKTOP_PREVIEW_BORDER_PERMISSION");
  Deadline(deadline);
  const auto adapter = AdapterFor(target.monitor);
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext> context;
  winrt::check_hresult(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
  winrt::com_ptr<IInspectable> inspectable;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), inspectable.put()));
  auto runtimeDevice = inspectable.as<IDirect3DDevice>();
  Capture capture;
  const auto interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  if (target.window)
    winrt::check_hresult(interop->CreateForWindow(target.window, winrt::guid_of<GraphicsCaptureItem>(),
        winrt::put_abi(capture.item)));
  else winrt::check_hresult(interop->CreateForMonitor(target.monitor, winrt::guid_of<GraphicsCaptureItem>(),
        winrt::put_abi(capture.item)));
  const auto size = capture.item.Size();
  Require(size.Width > 0 && size.Height > 0 &&
      static_cast<std::uint64_t>(size.Width) * size.Height * 4 <= kMaximumPixelBytes,
      "ERR_DESKTOP_PREVIEW_DIMENSIONS");
  if (!target.window) Require(static_cast<unsigned>(size.Width) == target.arguments.width &&
      static_cast<unsigned>(size.Height) == target.arguments.height, "ERR_DESKTOP_PREVIEW_IDENTITY");
  target.Verify();
  capture.pool = Direct3D11CaptureFramePool::CreateFreeThreaded(runtimeDevice,
      DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size);
  capture.session = capture.pool.CreateCaptureSession(capture.item);
  if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
      L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled"))
    capture.session.IsCursorCaptureEnabled(false);
  Deadline(deadline);
  StartBorderlessPreview(capture.session, borderlessSupported, borderlessAllowed);
  while (!capture.frame) {
    Deadline(deadline);
    target.Verify();
    capture.frame = capture.pool.TryGetNextFrame();
    if (!capture.frame) Sleep(5);
  }
  const auto actual = capture.frame.ContentSize();
  Require(actual.Width == size.Width && actual.Height == size.Height, "ERR_DESKTOP_PREVIEW_CHANGED");
  auto access = capture.frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  winrt::com_ptr<ID3D11Texture2D> texture;
  winrt::check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
  D3D11_TEXTURE2D_DESC description{};
  texture->GetDesc(&description);
  Require(description.Width >= static_cast<unsigned>(size.Width) && description.Height >= static_cast<unsigned>(size.Height) &&
      description.Format == DXGI_FORMAT_B8G8R8A8_UNORM && description.SampleDesc.Count == 1,
      "ERR_DESKTOP_PREVIEW_READBACK");
  description.Width = static_cast<UINT>(size.Width); description.Height = static_cast<UINT>(size.Height);
  description.MipLevels = 1; description.ArraySize = 1; description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0; description.CPUAccessFlags = D3D11_CPU_ACCESS_READ; description.MiscFlags = 0;
  winrt::com_ptr<ID3D11Texture2D> staging;
  winrt::check_hresult(device->CreateTexture2D(&description, nullptr, staging.put()));
  const D3D11_BOX box{0, 0, 0, description.Width, description.Height, 1};
  context->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, texture.get(), 0, &box);
  Drain(device.get(), context.get(), deadline);
  Pixels result{description.Width, description.Height, {}};
  result.bytes.resize(static_cast<std::size_t>(result.width) * result.height * 4);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  winrt::check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped));
  const auto rowBytes = static_cast<std::size_t>(result.width) * 4;
  if (!mapped.pData || mapped.RowPitch < rowBytes) {
    context->Unmap(staging.get(), 0);
    throw Failure("ERR_DESKTOP_PREVIEW_READBACK");
  }
  for (unsigned row = 0; row < result.height; ++row)
    std::memcpy(result.bytes.data() + row * rowBytes,
        static_cast<const std::uint8_t*>(mapped.pData) + static_cast<std::size_t>(row) * mapped.RowPitch, rowBytes);
  context->Unmap(staging.get(), 0);
  target.Verify();
  capture.Close();
  access = nullptr; texture = nullptr; staging = nullptr;
  context->ClearState();
  Drain(device.get(), context.get(), deadline);
  return result;
}
std::vector<std::uint8_t> Png(const Pixels& pixels, const Arguments& arguments) {
  const auto [width, height] = Dimensions(pixels.width, pixels.height, arguments.maxWidth, arguments.maxHeight);
  winrt::com_ptr<IWICImagingFactory> factory;
  winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
      __uuidof(IWICImagingFactory), factory.put_void()));
  winrt::com_ptr<IWICBitmap> bitmap;
  winrt::check_hresult(factory->CreateBitmapFromMemory(pixels.width, pixels.height, GUID_WICPixelFormat32bppBGRA,
      pixels.width * 4, static_cast<UINT>(pixels.bytes.size()), const_cast<BYTE*>(pixels.bytes.data()), bitmap.put()));
  winrt::com_ptr<IWICBitmapScaler> scaler;
  winrt::check_hresult(factory->CreateBitmapScaler(scaler.put()));
  winrt::check_hresult(scaler->Initialize(bitmap.get(), width, height, WICBitmapInterpolationModeFant));
  winrt::com_ptr<IWICFormatConverter> converted;
  winrt::check_hresult(factory->CreateFormatConverter(converted.put()));
  winrt::check_hresult(converted->Initialize(scaler.get(), GUID_WICPixelFormat24bppBGR,
      WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  winrt::com_ptr<IStream> stream;
  winrt::check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
  winrt::com_ptr<IWICBitmapEncoder> encoder;
  winrt::check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
  winrt::check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
  winrt::com_ptr<IWICBitmapFrameEncode> frame;
  winrt::check_hresult(encoder->CreateNewFrame(frame.put(), nullptr));
  winrt::check_hresult(frame->Initialize(nullptr));
  winrt::check_hresult(frame->SetSize(width, height));
  auto format = GUID_WICPixelFormat24bppBGR;
  winrt::check_hresult(frame->SetPixelFormat(&format));
  Require(format == GUID_WICPixelFormat24bppBGR, "ERR_DESKTOP_PREVIEW_PNG");
  winrt::check_hresult(frame->WriteSource(converted.get(), nullptr));
  winrt::check_hresult(frame->Commit()); winrt::check_hresult(encoder->Commit());
  STATSTG status{}; winrt::check_hresult(stream->Stat(&status, STATFLAG_NONAME));
  Require(status.cbSize.QuadPart > 8 && status.cbSize.QuadPart <= kMaximumPngBytes, "ERR_DESKTOP_PREVIEW_PNG");
  std::vector<std::uint8_t> result(static_cast<std::size_t>(status.cbSize.QuadPart));
  LARGE_INTEGER start{}; winrt::check_hresult(stream->Seek(start, STREAM_SEEK_SET, nullptr));
  ULONG read = 0; winrt::check_hresult(stream->Read(result.data(), static_cast<ULONG>(result.size()), &read));
  Require(read == result.size(), "ERR_DESKTOP_PREVIEW_PNG");
  return result;
}
std::vector<std::uint8_t> Run(const Arguments& arguments) {
  Target target(arguments);
  const auto deadline = GetTickCount64() + kDeadlineMs;
  auto pixels = Read(target, deadline);
  auto result = Png(pixels, arguments);
  target.Verify();
  Deadline(deadline);
  return result;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  bool apartment = false;
  std::optional<Lifetime> lifetime;
  try {
    std::vector<std::wstring_view> values;
    for (int index = 1; index < argc; ++index) values.emplace_back(argv[index]);
    const auto arguments = Parse(values);
    lifetime.emplace();
    Require(SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
        "ERR_DESKTOP_PREVIEW_DPI");
    winrt::init_apartment(winrt::apartment_type::multi_threaded); apartment = true;
    const auto bytes = Run(arguments);
    winrt::uninit_apartment(); apartment = false;
    DWORD written = 0;
    Require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
        written == bytes.size(), "ERR_DESKTOP_PREVIEW_OUTPUT");
    return 0;
  } catch (const Failure& error) {
    if (apartment) winrt::uninit_apartment();
    std::fprintf(stderr, "%s\n", error.what());
  } catch (const winrt::hresult_error& error) {
    if (apartment) winrt::uninit_apartment();
    std::fprintf(stderr, "ERR_DESKTOP_PREVIEW_NATIVE HRESULT=0x%08lX\n", static_cast<unsigned long>(error.code().value));
  } catch (...) {
    if (apartment) winrt::uninit_apartment();
    std::fputs("ERR_DESKTOP_PREVIEW_NATIVE\n", stderr);
  }
  return 1;
}
