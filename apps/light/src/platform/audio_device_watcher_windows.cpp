#include "platform/audio_device_watcher.hpp"

#include <windows.h>
#include <mmdeviceapi.h>
#include <objbase.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <system_error>

namespace monky::light {
namespace {

[[noreturn]] void failCom(HRESULT result, const char* operation) {
  throw std::system_error(static_cast<int>(result), std::system_category(), operation);
}

class NotificationClient final : public IMMNotificationClient {
 public:
  explicit NotificationClient(AudioDevicesChanged changed) : changed_(std::move(changed)) {}

  void stop() {
    // Waits for an in-flight notification; Core Audio does not promise that
    // unregistration drains callbacks already dispatched on its threads.
    std::lock_guard lock(mutex_);
    active_ = false;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const auto remaining = --references_;
    if (remaining == 0) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** object) override {
    if (!object) return E_POINTER;
    if (id == __uuidof(IUnknown) || id == __uuidof(IMMNotificationClient)) {
      *object = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { return notify(); }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return notify(); }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { return notify(); }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override { return notify(); }
  // Property changes (volume, format, names) are frequent and do not alter selection.
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  ~NotificationClient() = default;

  HRESULT notify() {
    std::lock_guard lock(mutex_);
    if (!active_) return S_OK;
    try {
      changed_();
    } catch (...) {
      // Exceptions must not cross the COM boundary; the next notification retries.
    }
    return S_OK;
  }

  std::atomic<ULONG> references_ = 1;
  std::mutex mutex_;
  bool active_ = true;
  AudioDevicesChanged changed_;
};

struct Watcher final {
  CO_MTA_USAGE_COOKIE apartment = nullptr;
  IMMDeviceEnumerator* enumerator = nullptr;
  NotificationClient* client = nullptr;

  ~Watcher() {
    if (enumerator && client) enumerator->UnregisterEndpointNotificationCallback(client);
    if (client) {
      client->stop();
      client->Release();
    }
    if (enumerator) enumerator->Release();
    if (apartment) CoDecrementMTAUsage(apartment);
  }
};

}  // namespace

StopWatchingAudioDevices watchAudioDevices(AudioDevicesChanged changed) {
  if (!changed) throw std::invalid_argument("Audio device watcher requires a callback");
  auto watcher = std::make_shared<Watcher>();
  // Keeps an MTA available for this thread's COM calls without changing its apartment.
  if (const auto result = CoIncrementMTAUsage(&watcher->apartment); FAILED(result)) {
    failCom(result, "Enter the audio device notification apartment");
  }
  if (const auto result = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
                                           __uuidof(IMMDeviceEnumerator),
                                           reinterpret_cast<void**>(&watcher->enumerator));
      FAILED(result)) {
    failCom(result, "Create the audio device enumerator");
  }
  watcher->client = new NotificationClient(std::move(changed));
  if (const auto result = watcher->enumerator->RegisterEndpointNotificationCallback(watcher->client);
      FAILED(result)) {
    watcher->client->Release();
    watcher->client = nullptr;
    failCom(result, "Register audio device notifications");
  }
  return [watcher]() mutable { watcher.reset(); };
}

}  // namespace monky::light
