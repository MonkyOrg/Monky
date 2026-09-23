#include "wasapi_capture.h"
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <memory>

namespace screen_audio {
using Microsoft::WRL::ComPtr;

namespace {
class Handle {
 public:
  explicit Handle(HANDLE value) : value_(value) {
    if (!value || value == INVALID_HANDLE_VALUE)
      throw Failure("ERR_AUDIO_RESOURCE", "Cannot create capture handle");
  }
  ~Handle() { CloseHandle(value_); }
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

void Check(HRESULT hr, const char* operation) {
  if (FAILED(hr)) throw Failure("ERR_AUDIO_WASAPI", std::string(operation) + ": " + std::to_string(hr));
}

struct ComApartment {
  ComApartment() { Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "CoInitializeEx(MTA)"); }
  ~ComApartment() { CoUninitialize(); }
};

class Completion : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
    IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
 public:
  Completion() : event(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activated = E_FAIL;
    hr = operation->GetActivateResult(&activated, &client);
    if (SUCCEEDED(hr)) hr = activated;
    SetEvent(event.get());
    return S_OK;
  }
  Handle event;
  HRESULT hr = E_PENDING;
  ComPtr<IUnknown> client;
};

struct AudioStop {
  IAudioClient* client;
  bool started = false;
  ~AudioStop() { if (started) client->Stop(); }
};
struct TaskPriority {
  HANDLE task;
  TaskPriority() {
    DWORD index = 0;
    task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &index);
  }
  ~TaskPriority() { if (task) AvRevertMmThreadCharacteristics(task); }
};
struct BufferRelease {
  IAudioCaptureClient* client;
  UINT32 frames;
  bool released = false;
  ~BufferRelease() { if (!released) client->ReleaseBuffer(frames); }
  void Release() { released = true; Check(client->ReleaseBuffer(frames), "ReleaseBuffer"); }
};
}  // namespace

CaptureTarget ResolvePacketTarget(uint32_t excludedPid, int64_t windowId) {
  if (!excludedPid) excludedPid = GetCurrentProcessId();
  if (excludedPid != GetCurrentProcessId())
    throw Failure("ERR_AUDIO_TARGET", "Packet mode must exclude its own host process tree");
  if (!windowId) return {excludedPid, false};
  const HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(windowId));
  DWORD pid = 0;
  if (!IsWindow(window) || !GetWindowThreadProcessId(window, &pid) || !pid)
    throw Failure("ERR_AUDIO_TARGET", "The selected window has no live owning process");
  // INCLUDE cannot express an additional EXCLUDE. Reject our own tree instead
  // of accidentally feeding Monky's playback back into a capture.
  Handle processes(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  std::vector<std::pair<uint32_t, uint32_t>> parents;
  if (!Process32FirstW(processes.get(), &entry))
    throw Failure("ERR_AUDIO_TARGET", "Cannot verify the target process tree");
  do { parents.emplace_back(entry.th32ProcessID, entry.th32ParentProcessID); }
  while (Process32NextW(processes.get(), &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES)
    throw Failure("ERR_AUDIO_TARGET", "Cannot finish the target process snapshot");
  ValidateIncludedProcess(pid, excludedPid, parents);
  DWORD verified = 0;
  if (!IsWindow(window) || !GetWindowThreadProcessId(window, &verified) || verified != pid)
    throw Failure("ERR_AUDIO_TARGET", "The selected window changed during target resolution");
  return {pid, true};
}

void RunWasapiCapture(CaptureTarget target, std::atomic<bool>& stop, const CaptureSink& sink) {
  ComApartment apartment;
  if (stop.load()) return;
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = target.pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = target.include
      ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
      : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT variant{};
  variant.vt = VT_BLOB;
  variant.blob.cbSize = sizeof(params);
  variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
  auto completion = Microsoft::WRL::Make<Completion>();
  if (!completion) throw Failure("ERR_AUDIO_RESOURCE", "Cannot allocate activation callback");
  ComPtr<IActivateAudioInterfaceAsyncOperation> activation;
  Check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient), &variant, completion.Get(), &activation), "ActivateAudioInterfaceAsync");
  const auto deadline = GetTickCount64() + 5000;
  for (;;) {
    DWORD waited = WaitForSingleObject(completion->event.get(), 50);
    if (waited == WAIT_OBJECT_0) break;
    if (stop.load()) return;
    if (waited != WAIT_TIMEOUT || GetTickCount64() >= deadline)
      throw Failure("ERR_AUDIO_STARTUP", "WASAPI activation failed or timed out");
  }
  Check(completion->hr, "GetActivateResult");
  if (stop.load()) return;
  Handle event(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  ComPtr<IAudioClient> client;
  Check(completion->client.As(&client), "QueryInterface(IAudioClient)");
  completion->client.Reset();
  activation.Reset();
  completion.Reset();
  // Declare cleanup after the event, so WASAPI stops before its event is closed.
  AudioStop audioStop{client.Get()};
  WAVEFORMATEX* rawFormat = nullptr;
  {
    ComPtr<IMMDeviceEnumerator> enumerator;
    Check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        IID_PPV_ARGS(&enumerator)), "Create endpoint enumerator");
    ComPtr<IMMDevice> endpoint;
    Check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &endpoint), "GetDefaultAudioEndpoint");
    ComPtr<IAudioClient> render;
    Check(endpoint->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
        reinterpret_cast<void**>(render.GetAddressOf())), "Activate render endpoint");
    Check(render->GetMixFormat(&rawFormat), "GetMixFormat");
  }
  std::unique_ptr<WAVEFORMATEX, decltype(&CoTaskMemFree)> format(rawFormat, CoTaskMemFree);
  if (!format) throw Failure("ERR_AUDIO_FORMAT", "WASAPI returned no mix format");
  Check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0, format.get(), nullptr),
      "IAudioClient::Initialize");
  Check(client->SetEventHandle(event.get()), "SetEventHandle");
  ComPtr<IAudioCaptureClient> capture;
  Check(client->GetService(IID_PPV_ARGS(&capture)), "GetService(IAudioCaptureClient)");
  if (stop.load()) return;
  TaskPriority priority;
  Check(client->Start(), "IAudioClient::Start");
  audioStop.started = true;
  if (!sink.ready(format.get())) return;
  while (!stop.load()) {
    DWORD waited = WaitForSingleObject(event.get(), 100);
    if (waited == WAIT_TIMEOUT) continue;
    if (waited != WAIT_OBJECT_0) throw Failure("ERR_AUDIO_WASAPI", "Capture event wait failed");
    UINT32 length = 0;
    Check(capture->GetNextPacketSize(&length), "GetNextPacketSize");
    while (length && !stop.load()) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      UINT64 qpc100ns = 0;
      // Process loopback is not endpoint-bound. Request only the independent
      // QPC anchor; an unrequested stream/device counter remains unavailable.
      Check(capture->GetBuffer(&data, &frames, &flags, nullptr, &qpc100ns), "GetBuffer");
      BufferRelease buffer{capture.Get(), frames};
      const bool keepGoing = sink.packet(data, frames, flags, std::nullopt, qpc100ns);
      buffer.Release();
      if (!keepGoing) return;
      Check(capture->GetNextPacketSize(&length), "GetNextPacketSize");
    }
  }
}

}  // namespace screen_audio
