#include "fixture_audio_device.hpp"
#include "protocol.hpp"
#include "voice_engine.hpp"
#include <rtc_base/logging.h>

#include <chrono>
#include <iostream>
#include <map>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace {
using namespace monky::light::media;
using monky::light::test::FixtureAudioDevice;
using namespace std::chrono_literals;

void Require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

template <class F> void WaitFor(F condition, const char *message) {
  const auto deadline = std::chrono::steady_clock::now() + 15s;
  while (!condition()) {
    if (std::chrono::steady_clock::now() >= deadline)
      throw std::runtime_error(message);
    std::this_thread::sleep_for(25ms);
  }
}

struct Bridge {
  std::mutex mutex;
  std::map<std::string, VoiceEngine *> engines;
  std::vector<std::string> errors;
  std::map<std::string, nlohmann::json> device_stats;

  Callbacks ForDevice(webrtc::scoped_refptr<FixtureAudioDevice> device) {
    Callbacks callbacks;
    callbacks.create_audio_device = [device](const webrtc::Environment &)
        -> webrtc::scoped_refptr<webrtc::AudioDeviceModule> { return device; };
    callbacks.notify = [this](std::string type, nlohmann::json payload) {
      if (type != monky::protocol::message::RTC_SIGNAL)
        return;
      const auto signal = payload.at("signalType").get<std::string>();
      if (signal == "offer" || signal == "answer") {
        const auto epoch = payload.at("subscriptionId").get<std::string>();
        Require(epoch.size() == 36 &&
                    epoch.find_first_not_of("0123456789abcdef-") == std::string::npos,
                "SDP is missing its per-connection subscription identifier");
      }
      std::lock_guard lock(mutex);
      auto found =
          engines.find(payload.at("targetSessionId").get<std::string>());
      if (found != engines.end())
        found->second->receive_signal(std::move(payload));
    };
    callbacks.request = [](std::string, nlohmann::json,
                           std::vector<std::string>,
                           RpcCompletion) -> CancelRequest {
      throw std::runtime_error("Unexpected SFU RPC in P2P loopback");
    };
    callbacks.observe = [this](Event event) {
      if (event.kind == EventKind::stats &&
          event.detail == "Native audio device") {
        std::lock_guard lock(mutex);
        device_stats[event.session_id] = std::move(event.stats);
        return;
      }
      if (event.kind != EventKind::failed)
        return;
      std::lock_guard lock(mutex);
      errors.push_back(event.detail);
      std::cerr << "Engine failure: " << event.detail << '\n';
    };
    return callbacks;
  }
};

JoinConfig Configuration(std::string user, std::string session,
                         std::vector<Participant> roster) {
  JoinConfig config;
  config.self_user_id = std::move(user);
  config.self_session_id = std::move(session);
  config.channel_id = "native-loopback";
  config.admitted_participants = std::move(roster);
  config.policy.echo_cancellation = false;
  config.policy.automatic_gain = false;
  config.policy.noise_suppression = NoiseSuppression::off;
  return config;
}
} // namespace

int main() {
  try {
    webrtc::LogMessage::LogToDebug(webrtc::LS_ERROR);
    webrtc::LogMessage::SetLogToStderr(true);
    auto device_a = FixtureAudioDevice::Create();
    auto device_b = FixtureAudioDevice::Create();
    Bridge bridge;
    VoiceEngine a(bridge.ForDevice(device_a));
    VoiceEngine b(bridge.ForDevice(device_b));
    {
      std::lock_guard lock(bridge.mutex);
      bridge.engines = {{"alpha:one", &a}, {"beta:two", &b}};
    }
    const std::vector<Participant> roster{{"alpha", "alpha:one"},
                                          {"beta", "beta:two"}};
    auto config_a = Configuration("alpha", "alpha:one", {roster.front()});
    a.join(config_a).get();
    Require(!device_a->Recording(), "Empty room opened an unused microphone");
    a.update_roster(roster);
    b.join(Configuration("beta", "beta:two", roster)).get();

    WaitFor(
        [&] {
          return device_a->Snapshot().nonzero_playout_callbacks > 25 &&
                 device_b->Snapshot().nonzero_playout_callbacks > 25;
        },
        "Bidirectional decoded PCM did not arrive");
    Require(device_a->Snapshot().output_rms > 0.00001 &&
                device_b->Snapshot().output_rms > 0.00001,
            "Decoded PCM has no energy");

    auto policy = config_a.policy;
    policy.muted = true;
    a.update_policy(policy);
    a.poll_stats();
    WaitFor(
        [&] {
          std::lock_guard lock(bridge.mutex);
          const auto found = bridge.device_stats.find("alpha:one");
          return found != bridge.device_stats.end() &&
                 !found->second.at("recording").get<bool>();
        },
        "Mute did not stop native capture");
    auto muted = device_a->Snapshot();
    std::this_thread::sleep_for(200ms);
    auto receiving = device_a->Snapshot();
    Require(receiving.recording_callbacks == muted.recording_callbacks,
            "Native capture continued while muted");
    Require(receiving.nonzero_playout_callbacks >
                muted.nonzero_playout_callbacks,
            "Muting incorrectly stopped received audio");

    policy.muted = false;
    a.update_policy(policy);
    auto before_unmute = device_b->Snapshot().output_energy;
    WaitFor(
        [&] {
          return device_a->Recording() &&
                 device_b->Snapshot().output_energy > before_unmute + 0.1;
        },
        "Unmute did not restore outgoing decoded audio");

    policy.deafened = true;
    a.update_policy(policy);
    a.poll_stats();
    WaitFor(
        [&] {
          std::lock_guard lock(bridge.mutex);
          const auto found = bridge.device_stats.find("alpha:one");
          return found != bridge.device_stats.end() &&
                 !found->second.at("recording").get<bool>() &&
                 !found->second.at("playing").get<bool>();
        },
        "Deafen did not stop physical input/output");
    auto deafened = device_a->Snapshot();
    std::this_thread::sleep_for(200ms);
    auto stopped = device_a->Snapshot();
    Require(stopped.recording_callbacks == deafened.recording_callbacks &&
                stopped.playout_callbacks == deafened.playout_callbacks,
            "Audio device continued running while deafened");

    policy.deafened = false;
    a.update_policy(policy);
    auto before_undeafen = device_a->Snapshot().output_energy;
    WaitFor(
        [&] {
          return device_a->Recording() && device_a->Playing() &&
                 device_a->Snapshot().output_energy > before_undeafen + 0.1;
        },
        "Undeafen did not restore native duplex audio");

    a.leave().get();
    b.leave().get();
    Require(!device_a->Snapshot().worker_running &&
                !device_b->Snapshot().worker_running,
            "Fixture worker leaked after leave");
    {
      std::lock_guard lock(bridge.mutex);
      bridge.engines.clear();
      Require(bridge.errors.empty(), "Voice engine reported a failure");
    }
    std::cout
        << "Native P2P PCM loopback passed: bidirectional Opus decode, mute "
           "keeps receive, deafen stops both directions, unmute/undeafen, "
           "and device/thread teardown. RMS="
        << device_a->Snapshot().output_rms << '/'
        << device_b->Snapshot().output_rms << '\n';
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "Native voice loopback failure: " << error.what() << '\n';
    return 1;
  }
}
