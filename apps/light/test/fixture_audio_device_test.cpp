#include "fixture_audio_device.hpp"
#include "fixture_audio_clock.hpp"
#include "media/policy_audio_device.hpp"

#include <api/make_ref_counted.h>
#include <media/engine/adm_helpers.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <future>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace monky::light::test {
namespace {

using namespace std::chrono_literals;

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

class Transport final : public webrtc::AudioTransport {
 public:
  enum class Direction { none, recording, playout };
  struct Counts {
    std::uint64_t recording = 0;
    std::uint64_t playout = 0;
    bool valid = true;
    bool input_nonzero = false;
    bool pull_render_called = false;
  };

  FixtureAudioDevice* device = nullptr;
  bool fail_recording = false;
  bool invalid_playout_count = false;
  bool throw_playout = false;

  ~Transport() override { Release(); }

  int32_t RecordedDataIsAvailable(const void* samples, size_t count, size_t bytes,
                                  size_t channels, uint32_t rate, uint32_t delay,
                                  int32_t drift, uint32_t level, bool key,
                                  uint32_t& new_level) override {
    CheckReentrantQueries();
    std::unique_lock lock(mutex_);
    CheckFormat(count, bytes, channels, rate);
    counts_.valid &= samples != nullptr && delay == 0 && drift == 0 && level == 0 && !key;
    if (samples && count == previous_.size()) {
      const auto* pcm = static_cast<const int16_t*>(samples);
      for (std::size_t i = 0; i < count; ++i) {
        counts_.input_nonzero |= pcm[i] != 0;
        counts_.valid &= pcm[i] >= -2048 && pcm[i] <= 2048;
        if (counts_.recording != 0) counts_.valid &= pcm[i] == previous_[i];
        previous_[i] = pcm[i];
      }
    }
    new_level = 0;
    ++counts_.recording;
    changed_.notify_all();
    MaybeBlock(lock, Direction::recording);
    return fail_recording ? -1 : 0;
  }

  int32_t NeedMorePlayData(size_t count, size_t bytes, size_t channels, uint32_t rate,
                          void* samples, size_t& count_out, int64_t* elapsed,
                          int64_t* ntp) override {
    CheckReentrantQueries();
    std::unique_lock lock(mutex_);
    CheckFormat(count, bytes, channels, rate);
    counts_.valid &= samples != nullptr && elapsed != nullptr && ntp != nullptr;
    if (samples && count == FixtureAudioDevice::kSamplesPerFrame) {
      auto* pcm = static_cast<int16_t*>(samples);
      for (std::size_t i = 0; i < count; ++i) pcm[i] = i % 2 == 0 ? 4096 : -4096;
    }
    count_out = invalid_playout_count ? count + 1 : count;
    if (elapsed) *elapsed = 0;
    if (ntp) *ntp = 0;
    ++counts_.playout;
    changed_.notify_all();
    MaybeBlock(lock, Direction::playout);
    if (throw_playout) throw std::runtime_error("Deliberate test transport failure");
    return 0;
  }

  void PullRenderData(int, int, size_t, size_t, void*, int64_t*, int64_t*) override {
    std::lock_guard lock(mutex_);
    counts_.pull_render_called = true;
  }

  Counts Snapshot() {
    std::lock_guard lock(mutex_);
    return counts_;
  }

  bool WaitFor(std::uint64_t recording, std::uint64_t playout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, 3s, [&] {
      return counts_.recording >= recording && counts_.playout >= playout;
    });
  }

  void Block(Direction direction) {
    std::lock_guard lock(mutex_);
    blocked_direction_ = direction;
    entered_ = false;
  }

  bool WaitBlocked() {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, 3s, [&] { return entered_; });
  }

  void Release() {
    std::lock_guard lock(mutex_);
    blocked_direction_ = Direction::none;
    changed_.notify_all();
  }

 private:
  void CheckFormat(size_t count, size_t bytes, size_t channels, uint32_t rate) {
    counts_.valid &= count == FixtureAudioDevice::kSamplesPerFrame &&
                     bytes == sizeof(int16_t) && channels == FixtureAudioDevice::kChannels &&
                     rate == FixtureAudioDevice::kSampleRate;
  }

  void CheckReentrantQueries() {
    uint32_t volume = 123;
    bool available = true;
    const bool valid = device && device->Initialized() &&
                       device->MicrophoneVolumeIsAvailable(&available) == 0 && !available &&
                       device->MicrophoneVolume(&volume) == -1 && volume == 0 &&
                       device->SetMicrophoneVolume(100) == -1 &&
                       device->RegisterAudioCallback(nullptr) == -1 &&
                       device->StopRecording() == -1 && device->Terminate() == -1;
    std::lock_guard lock(mutex_);
    counts_.valid &= valid;
  }

  void MaybeBlock(std::unique_lock<std::mutex>& lock, Direction direction) {
    if (blocked_direction_ != direction) return;
    entered_ = true;
    changed_.notify_all();
    // A bounded test gate prevents a failed assertion from hanging the runner.
    counts_.valid &= changed_.wait_for(lock, 5s, [&] {
      return blocked_direction_ != direction;
    });
  }

  std::mutex mutex_;
  std::condition_variable changed_;
  Counts counts_;
  std::array<int16_t, FixtureAudioDevice::kSamplesPerFrame> previous_{};
  Direction blocked_direction_ = Direction::none;
  bool entered_ = false;
};

void Prepare(FixtureAudioDevice& device, Transport& transport) {
  transport.device = &device;
  Require(device.RegisterAudioCallback(&transport) == 0, "Register transport");
  Require(device.Init() == 0, "Initialize synthetic ADM");
  Require(device.InitRecording() == 0 && device.InitPlayout() == 0,
          "Initialize synthetic recording/playout");
}

void CheckCapabilities() {
  auto device = FixtureAudioDevice::Create();
  Require(device != nullptr, "Create synthetic ADM");
  Require(!device->Initialized() && !device->Recording() && !device->Playing(),
          "New device must be inactive");
  Require(!device->Snapshot().worker_running, "New device must not own a worker");
  Require(device->InitRecording() == -1 && device->InitPlayout() == -1,
          "Direction initialization requires Init");
  Require(device->StartRecording() == -1 && device->StartPlayout() == -1,
          "Uninitialized device must not start");
  webrtc::AudioDeviceModule::AudioLayer layer = webrtc::AudioDeviceModule::kPlatformDefaultAudio;
  Require(device->ActiveAudioLayer(&layer) == 0 &&
              layer == webrtc::AudioDeviceModule::kDummyAudio,
          "Synthetic layer must not imply hardware");
  Require(device->ActiveAudioLayer(nullptr) == -1, "Validate output pointer");
  Require(device->PlayoutDevices() == 1 && device->RecordingDevices() == 1,
          "Exactly one synthetic input/output");
  char name[webrtc::kAdmMaxDeviceNameSize]{};
  char guid[webrtc::kAdmMaxGuidSize]{};
  Require(device->RecordingDeviceName(0, name, guid) == 0 &&
              std::strstr(name, "synthetic") && std::strstr(guid, "test"),
          "Recording diagnostics must identify test audio");
  Require(device->PlayoutDeviceName(0, name, guid) == 0 &&
              std::strstr(name, "synthetic"), "Playout diagnostics must identify test audio");
  Require(device->RecordingDeviceName(1, name, guid) == -1 && name[0] == '\0',
          "Reject unknown synthetic input");
  Require(device->PlayoutDeviceName(0, nullptr, guid) == -1, "Reject missing device name");
  Require(device->SetRecordingDevice(uint16_t{0}) == 0 &&
              device->SetPlayoutDevice(uint16_t{0}) == 0 &&
              device->SetRecordingDevice(uint16_t{1}) == -1 &&
              device->SetPlayoutDevice(uint16_t{1}) == -1,
          "Only synthetic index zero is supported");
  Require(device->SetPlayoutDevice(webrtc::AudioDeviceModule::kDefaultDevice) == 0 &&
              device->SetPlayoutDevice(webrtc::AudioDeviceModule::kDefaultCommunicationDevice) == 0 &&
              device->SetRecordingDevice(webrtc::AudioDeviceModule::kDefaultDevice) == 0 &&
              device->SetRecordingDevice(
                  webrtc::AudioDeviceModule::kDefaultCommunicationDevice) == 0,
          "M140 Windows default-device selectors must map to the synthetic device");
  bool available = true;
  Require(device->StereoRecordingIsAvailable(&available) == 0 && !available &&
              device->StereoPlayoutIsAvailable(&available) == 0 && !available,
          "Only mono is supported");
  Require(device->SetStereoRecording(true) == -1 && device->SetStereoPlayout(true) == -1 &&
              device->SetStereoRecording(false) == 0 && device->SetStereoPlayout(false) == 0,
          "Reject stereo configuration");
  Require(device->SpeakerVolumeIsAvailable(&available) == 0 && !available &&
              device->MicrophoneMuteIsAvailable(&available) == 0 && !available &&
              device->SpeakerMuteIsAvailable(&available) == 0 && !available,
          "No hardware volume or mute controls");
  Require(device->InitSpeaker() == -1 && device->InitMicrophone() == -1 &&
              !device->SpeakerIsInitialized() && !device->MicrophoneIsInitialized() &&
              device->SetSpeakerMute(true) == -1 && device->SetMicrophoneMute(true) == -1,
          "Uninitialized endpoints and unsupported hardware controls must fail");
  Require(!device->BuiltInAECIsAvailable() && !device->BuiltInAGCIsAvailable() &&
              !device->BuiltInNSIsAvailable() && device->EnableBuiltInAEC(true) == -1 &&
              device->EnableBuiltInAGC(false) == -1 && device->EnableBuiltInNS(true) == -1,
          "Synthetic device does not implement hardware audio effects");
  Require(device->Init() == 0 && device->Init() == 0, "Initialization is idempotent");
  Require(device->InitRecording() == 0 && device->InitPlayout() == 0 &&
              device->StartRecording() == -1 && device->StartPlayout() == -1,
          "No registered transport must fail, never select a real device");
  Require(!device->Snapshot().worker_running, "Failed start must not create a worker");
}

void CheckNativeInitialization() {
  auto device = FixtureAudioDevice::Create();
  webrtc::adm_helpers::Init(device.get());
  Require(device->Initialized() && device->SpeakerIsInitialized() &&
              device->MicrophoneIsInitialized(),
          "The real M140 initialization helper must reach both synthetic endpoints");
  Require(!device->Recording() && !device->Playing() && !device->Snapshot().worker_running,
          "Factory initialization alone must not start synthetic audio");
  bool available = true;
  Require(device->SpeakerVolumeIsAvailable(&available) == 0 && !available &&
              device->MicrophoneVolumeIsAvailable(&available) == 0 && !available,
          "Logical endpoint initialization must not advertise hardware controls");
  Require(device->Terminate() == 0 && !device->SpeakerIsInitialized() &&
              !device->MicrophoneIsInitialized(),
          "Termination must retire logical endpoint initialization");
}

void CheckDuplexAndStop() {
  Transport transport;
  auto device = FixtureAudioDevice::Create();
  Prepare(*device, transport);
  Require(device->PlayoutIsInitialized() && device->RecordingIsInitialized(),
          "Directions report initialized");
  const auto started = std::chrono::steady_clock::now();
  Require(device->StartRecording() == 0 && device->StartRecording() == 0 &&
              device->StartPlayout() == 0, "Start duplex, idempotently");
  Require(transport.WaitFor(8, 8), "Paced duplex callbacks arrive");
  Require(std::chrono::steady_clock::now() - started >= 50ms,
          "Callbacks must be paced, not generated in a busy loop");
  Require(device->Recording() && device->Playing(), "Directions report active");
  Require(device->StopRecording() == 0 && !device->Recording() && device->Playing(),
          "Stopping capture must preserve playout");
  const auto stopped_recording = device->Snapshot();
  Require(transport.WaitFor(8, stopped_recording.playout_callbacks + 3),
          "Playout continues independently");
  Require(device->StopPlayout() == 0 && !device->Playing(), "Stop playout");
  const auto stopped = device->Snapshot();
  Require(!stopped.worker_running, "Stopping both directions must join the worker");
  Require(stopped.recording_callbacks == stopped_recording.recording_callbacks,
          "Stopped recording counters must not advance");
  Require(stopped.recorded_samples == stopped.recording_callbacks * 480 &&
              stopped.playout_samples == stopped.playout_callbacks * 480,
          "Every successful callback contains 480 mono samples");
  Require(stopped.input_energy > 0 && stopped.output_energy > 0 &&
              stopped.nonzero_playout_callbacks == stopped.playout_callbacks &&
              std::abs(stopped.output_rms - 0.125) < 1e-12,
          "Metrics must measure supplied PCM, including normalized RMS");
  Require(stopped.recording_errors == 0 && stopped.playout_errors == 0,
          "Valid transport produces no errors");
  const auto observed = transport.Snapshot();
  Require(observed.valid && observed.input_nonzero && !observed.pull_render_called,
          "Correct format, repeatable nonzero input, callback-safe APIs and AEC render path");
  std::this_thread::sleep_for(40ms);
  Require(device->Snapshot().playout_callbacks == stopped.playout_callbacks &&
              transport.Snapshot().recording == observed.recording,
          "No late callbacks after stop");
  Require(device->StartPlayout() == 0 &&
              transport.WaitFor(observed.recording, observed.playout + 2),
          "A stopped worker can restart");
  Require(device->Terminate() == 0 && device->Terminate() == 0 &&
              !device->Initialized() && !device->PlayoutIsInitialized() &&
              !device->RecordingIsInitialized() && !device->Snapshot().worker_running,
          "Termination joins and resets lifecycle state");
  Require(device->Init() == 0 && device->InitRecording() == 0 &&
              device->StartRecording() == -1, "Termination releases the borrowed transport");
}

void CheckRealtimeCadence(std::chrono::milliseconds stall = 0ms) {
  const std::chrono::steady_clock::time_point epoch{};
  auto clock = AdvanceFixtureAudioDeadline(epoch, epoch + 1ms);
  Require(clock.next == epoch + 10ms && clock.discarded_frames == 0,
          "Normal processing must preserve the device clock");
  clock = {epoch, 0};
  for (int frame = 1; frame <= 4; ++frame) {
    clock = AdvanceFixtureAudioDeadline(clock.next, epoch + 36ms);
    Require(clock.next == epoch + frame * 10ms && clock.discarded_frames == 0,
            "Short scheduler delays must drain buffered PCM, not slow the sample rate");
  }
  clock = AdvanceFixtureAudioDeadline(epoch, epoch + 59ms);
  Require(clock.next == epoch + 10ms && clock.discarded_frames == 0,
          "The synthetic buffer must retain up to five delayed frames");
  clock = AdvanceFixtureAudioDeadline(epoch, epoch + 60ms);
  Require(clock.next == epoch + 70ms && clock.discarded_frames == 6,
          "Buffer overflow must discard old frames and resume on the original clock");
  clock = AdvanceFixtureAudioDeadline(epoch, epoch + 5003ms);
  Require(clock.next == epoch + 5010ms && clock.discarded_frames == 500,
          "A long stall must never produce an unbounded catch-up burst");

  Transport transport;
  auto device = FixtureAudioDevice::Create();
  Prepare(*device, transport);
  if (stall > 0ms) transport.Block(Transport::Direction::recording);
  const auto started = std::chrono::steady_clock::now();
  Require(device->StartRecording() == 0 && device->StartPlayout() == 0,
          "Start realtime synthetic PCM");
  if (stall > 0ms) {
    const bool entered = transport.WaitBlocked();
    if (entered) std::this_thread::sleep_for(stall);
    transport.Release();
    Require(entered, "Inject a bounded stall in the real synthetic audio worker");
  }
  const bool reached = transport.WaitFor(200, 200);
  Require(device->Terminate() == 0, "Release synthetic timing and device worker");
  const auto elapsed = std::chrono::steady_clock::now() - started;
  const auto observed = transport.Snapshot();
  const auto timing = device->Snapshot();
  // The device clock also advances through frames discarded during scheduler stalls.
  const auto scheduled = kFixtureAudioPeriod *
      (std::max(timing.recording_callbacks, timing.playout_callbacks) +
       timing.discarded_clock_frames);
  const bool paced = elapsed + 250ms >= scheduled && elapsed <= scheduled + 600ms;
  if (!reached || !paced) {
    std::cerr << "Synthetic cadence: " << observed.recording << " capture / "
              << observed.playout << " playout callbacks in "
              << std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count()
              << " ms; scheduled=" << scheduled.count()
              << " ms; waiting=" << timing.waiting_ms << " ms; processing="
              << timing.processing_ms << " ms; discarded="
              << timing.discarded_clock_frames << " frames\n";
  }
  Require(reached && paced,
          "Synthetic PCM must maintain its realtime 10 ms device clock");
  Require(stall == 0ms ||
              kFixtureAudioPeriod * timing.discarded_clock_frames >= stall - kFixtureAudioPeriod,
          "A forced stall must discard expired device frames, not slow the clock");
}

void CheckCallbackRemovalAndReplacement() {
  Transport first;
  Transport second;
  auto device = FixtureAudioDevice::Create();
  Prepare(*device, first);
  second.device = device.get();
  first.Block(Transport::Direction::recording);
  Require(device->StartRecording() == 0, "Start blocked recording");
  const bool entered = first.WaitBlocked();
  if (!entered) first.Release();
  Require(entered, "Enter recording callback");
  std::promise<void> started;
  auto started_future = started.get_future();
  auto removal = std::async(std::launch::async, [&] {
    started.set_value();
    return device->RegisterAudioCallback(nullptr);
  });
  started_future.wait();
  const auto status = removal.wait_for(40ms);
  first.Release();
  Require(removal.get() == 0 && status == std::future_status::timeout,
          "Unregister must wait for the in-flight borrowed transport");
  const auto removed = device->Snapshot();
  const auto calls = first.Snapshot().recording;
  std::this_thread::sleep_for(40ms);
  Require(first.Snapshot().recording == calls &&
              device->Snapshot().recording_callbacks == removed.recording_callbacks,
          "Unregistered transport must never receive late callbacks");
  Require(device->Recording(), "Removing callback pauses transport, not recording state");
  Require(device->RegisterAudioCallback(&second) == 0 && second.WaitFor(3, 0),
          "Replacement callback wakes the paced worker");
  Require(device->StopRecording() == 0 && !device->Snapshot().worker_running &&
              first.Snapshot().recording == calls && second.Snapshot().valid,
          "Replaced transport stays detached");
}

void CheckInflightStopAndTerminate(bool terminate) {
  Transport transport;
  auto device = FixtureAudioDevice::Create();
  Prepare(*device, transport);
  transport.Block(Transport::Direction::playout);
  Require(device->StartPlayout() == 0, "Start blocked playout");
  const bool entered = transport.WaitBlocked();
  if (!entered) transport.Release();
  Require(entered, "Enter playout callback");
  auto stopping = std::async(std::launch::async, [&] {
    return terminate ? device->Terminate() : device->StopPlayout();
  });
  const auto status = stopping.wait_for(40ms);
  transport.Release();
  Require(stopping.get() == 0 && status == std::future_status::timeout,
          "Stop/terminate must drain an in-flight callback");
  const auto stopped = device->Snapshot();
  Require(!stopped.worker_running && !device->Playing(), "Worker is joined before return");
  std::this_thread::sleep_for(30ms);
  Require(device->Snapshot().playout_callbacks == stopped.playout_callbacks,
          "No counter updates after draining stop/terminate");
}

void CheckDeviceSelection() {
  const auto catalog = std::make_shared<FixtureDeviceCatalog>();
  catalog->Set({{"mic-a", "Mic A"}, {"mic-b", "Mic B"}}, {{"out-a", "Out A"}, {"out-b", "Out B"}});
  Transport transport;
  auto device = FixtureAudioDevice::Create(catalog);
  const auto listed = media::EnumerateDevices(*device);
  Require(listed.inputs.size() == 2 && listed.inputs[1].id == "mic-b" && listed.inputs[1].name == "Mic B" &&
              listed.outputs.size() == 2 && listed.outputs[0].id == "out-a",
          "Enumeration must report catalog IDs and names");
  webrtc::adm_helpers::Init(device.get());
  auto policy = webrtc::make_ref_counted<media::PolicyAudioDevice>(device);
  transport.device = device.get();
  Require(policy->RegisterAudioCallback(&transport) == 0, "Register policy transport");

  Require(policy->SelectDevices({std::string("mic-b"), std::nullopt}) == 0 &&
              device->Snapshot().selected_input == "mic-b" && device->Snapshot().selected_output == "out-a" &&
              policy->input_selection().id == "mic-b" && policy->input_selection().name == "Mic B" &&
              !policy->input_selection().fallback && policy->output_selection().id.empty(),
          "A present device is selected; nullopt uses the default");
  Require(policy->SetPolicy(true, true) == 0 && policy->StartRecording() == 0 &&
              policy->StartPlayout() == 0 && transport.WaitFor(3, 3),
          "Selected devices start");

  Require(policy->SelectDevices({std::string("mic-a"), std::string("out-b")}) == 0 &&
              device->Recording() && device->Playing() &&
              device->Snapshot().selected_input == "mic-a" && device->Snapshot().selected_output == "out-b",
          "Switching running directions restarts them on the new devices");
  const auto switched = transport.Snapshot();
  Require(transport.WaitFor(switched.recording + 3, switched.playout + 3), "Audio continues after a switch");

  catalog->Set({{"mic-b", "Mic B"}}, {{"out-a", "Out A"}, {"out-b", "Out B"}});
  Require(policy->SelectDevices({std::string("mic-a"), std::string("out-b")}) == 0 &&
              device->Recording() && device->Snapshot().selected_input == "mic-b" &&
              policy->input_selection().fallback && policy->input_selection().id.empty() &&
              policy->input_selection().requested == std::optional<std::string>("mic-a"),
          "A removed device falls back to the default and keeps capturing");
  catalog->Set({{"mic-b", "Mic B"}, {"mic-a", "Mic A"}}, {{"out-a", "Out A"}, {"out-b", "Out B"}});
  Require(policy->SelectDevices({std::string("mic-a"), std::string("out-b")}) == 0 &&
              device->Snapshot().selected_input == "mic-a" && !policy->input_selection().fallback,
          "A reconnected preferred device is selected again");

  Require(policy->SetPolicy(false, true) == 0 && !device->Recording(), "Mute stops capture");
  Require(policy->SelectDevices({std::string("mic-b"), std::string("out-b")}) == 0 &&
              !device->Recording() && device->Snapshot().selected_input == "mic-b",
          "Switching the input while muted must not reopen capture");
  Require(policy->SetPolicy(true, true) == 0 && device->Recording(), "Unmute resumes on the new device");
  Require(policy->SetPolicy(false, false) == 0 && policy->Terminate() == 0, "Release the selection device");
  Require(policy->RegisterAudioCallback(nullptr) == 0, "Detach the policy transport");
}

void CheckFailures() {
  Transport transport;
  auto device = FixtureAudioDevice::Create();
  transport.fail_recording = true;
  transport.invalid_playout_count = true;
  Prepare(*device, transport);
  Require(device->StartRecording() == 0 && device->StartPlayout() == 0 &&
              transport.WaitFor(3, 3), "Start failing test transport");
  Require(device->StopRecording() == 0 && device->StopPlayout() == 0, "Stop failed transport");
  auto counters = device->Snapshot();
  Require(counters.recording_errors == counters.recording_callbacks &&
              counters.playout_errors == counters.playout_callbacks &&
              counters.recorded_samples == 0 && counters.playout_samples == 0 &&
              counters.input_energy == 0 && counters.output_energy == 0,
          "Failed and oversized callbacks cannot claim successful PCM");
  transport.invalid_playout_count = false;
  transport.throw_playout = true;
  Require(device->StartPlayout() == 0 && transport.WaitFor(3, counters.playout_callbacks + 2),
          "Callback exceptions must not kill the worker");
  Require(device->StopPlayout() == 0, "Stop after callback exceptions");
  counters = device->Snapshot();
  Require(counters.playout_errors == counters.playout_callbacks &&
              !counters.worker_running, "Exceptions are counted and cleanup remains safe");
}

void CheckDestruction() {
  Transport transport;
  {
    auto device = FixtureAudioDevice::Create();
    Prepare(*device, transport);
    Require(device->StartRecording() == 0 && device->StartPlayout() == 0 &&
                transport.WaitFor(3, 3), "Start before destructor cleanup");
  }
  const auto calls = transport.Snapshot();
  transport.device = nullptr;
  std::this_thread::sleep_for(40ms);
  Require(transport.Snapshot().recording == calls.recording &&
              transport.Snapshot().playout == calls.playout,
          "Last ref destruction synchronously joins the worker");
}

void CheckTransportDestructionAfterRemoval() {
  auto device = FixtureAudioDevice::Create();
  {
    Transport transport;
    Prepare(*device, transport);
    Require(device->StartRecording() == 0 && device->StartPlayout() == 0 &&
                transport.WaitFor(3, 3), "Start with scoped borrowed transport");
    Require(device->RegisterAudioCallback(nullptr) == 0,
            "Detach before destroying the borrowed transport");
  }
  const auto detached = device->Snapshot();
  std::this_thread::sleep_for(40ms);
  Require(device->Snapshot().recording_callbacks == detached.recording_callbacks &&
              device->Snapshot().playout_callbacks == detached.playout_callbacks,
          "Destroyed transport must not be accessed by the paused worker");
  Require(device->Terminate() == 0 && !device->Snapshot().worker_running,
          "Terminate wakes and joins a worker waiting for a callback");
}

}  // namespace
}  // namespace monky::light::test

int main() {
  try {
    using namespace monky::light::test;
    CheckCapabilities();
    CheckNativeInitialization();
    CheckDuplexAndStop();
    CheckRealtimeCadence();
    CheckRealtimeCadence(std::chrono::milliseconds(700));
    CheckCallbackRemovalAndReplacement();
    CheckInflightStopAndTerminate(false);
    CheckInflightStopAndTerminate(true);
    CheckDeviceSelection();
    CheckFailures();
    CheckDestruction();
    CheckTransportDestructionAfterRemoval();
    std::cout << "Synthetic ADM tests passed: PCM format, energy, pacing and callback lifecycle. "
                 "No physical devices; not a network/codec interoperability test.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Synthetic ADM tests failed: " << error.what() << '\n';
    return 1;
  }
}
