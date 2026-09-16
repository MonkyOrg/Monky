#include "voice_engine.hpp"

#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace monky::light::media;
using namespace std::chrono_literals;

void Require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

void MustFail(std::future<void> future, const std::string &expected) {
  Require(future.wait_for(10s) == std::future_status::ready,
          "Failed operation did not settle");
  try {
    future.get();
  } catch (const std::exception &error) {
    Require(std::string(error.what()).find(expected) != std::string::npos,
            "Operation failed for an unexpected reason");
    return;
  }
  throw std::runtime_error("Expected operation failure");
}

JoinConfig Configuration() {
  JoinConfig config;
  config.self_user_id = "user";
  config.self_session_id = "user:device";
  config.channel_id = "room";
  config.admitted_participants = {{"user", "user:device"}};
  return config;
}

Callbacks CallbacksWithoutDevice(std::atomic<unsigned> &calls) {
  Callbacks callbacks;
  callbacks.create_audio_device = [&](const webrtc::Environment &) {
    ++calls;
    return webrtc::scoped_refptr<webrtc::AudioDeviceModule>();
  };
  callbacks.notify = [](std::string, nlohmann::json) {
    throw std::runtime_error(
        "No signaling expected before device initialization");
  };
  callbacks.request = [](std::string, nlohmann::json, std::vector<std::string>,
                         RpcCompletion) -> CancelRequest {
    throw std::runtime_error(
        "No SFU requests expected before audio initialization");
  };
  return callbacks;
}
} // namespace

int main() {
  try {
    std::atomic<unsigned> device_calls{0};
    {
      VoiceEngine engine(CallbacksWithoutDevice(device_calls));
      auto invalid = Configuration();
      invalid.admitted_participants.clear();
      MustFail(engine.join(std::move(invalid)), "roster");
      Require(device_calls.load() == 0, "Capture attempted before admission");
      MustFail(engine.join(Configuration()), "returned null");
      Require(device_calls.load() == 1,
              "Null ADM caused fallback or duplicate factory");
      engine.leave().get();
      engine.leave().get();
    }
    {
      auto callbacks = CallbacksWithoutDevice(device_calls);
      callbacks.create_audio_device = [](const webrtc::Environment &)
          -> webrtc::scoped_refptr<webrtc::AudioDeviceModule> {
        throw std::runtime_error("Microphone permission denied");
      };
      VoiceEngine engine(std::move(callbacks));
      MustFail(engine.join(Configuration()), "Microphone permission denied");
      engine.leave().get();
    }
    {
      std::promise<void> entered;
      std::promise<void> release;
      auto entered_future = entered.get_future();
      auto release_future = release.get_future().share();
      auto callbacks = CallbacksWithoutDevice(device_calls);
      callbacks.create_audio_device = [&](const webrtc::Environment &)
          -> webrtc::scoped_refptr<webrtc::AudioDeviceModule> {
        entered.set_value();
        release_future.wait();
        return nullptr;
      };
      VoiceEngine engine(std::move(callbacks));
      auto joined = engine.join(Configuration());
      Require(entered_future.wait_for(10s) == std::future_status::ready,
              "Audio initialization did not start");
      auto left = engine.leave();
      release.set_value();
      MustFail(std::move(joined), "returned null");
      Require(left.wait_for(10s) == std::future_status::ready,
              "Leave during join deadlocked");
      left.get();
    }
    {
      std::promise<void> destroyed;
      auto destroyed_future = destroyed.get_future();
      std::unique_ptr<VoiceEngine> engine;
      auto callbacks = CallbacksWithoutDevice(device_calls);
      callbacks.observe = [&](Event event) {
        if (event.kind == EventKind::admitted) {
          engine.reset();
          destroyed.set_value();
        }
      };
      engine = std::make_unique<VoiceEngine>(std::move(callbacks));
      auto joined = engine->join(Configuration());
      Require(destroyed_future.wait_for(10s) == std::future_status::ready,
              "Destruction in admission observer self-joined");
      MustFail(std::move(joined), "cancelled");
    }
    std::cout << "Native voice lifecycle: admission, null/throwing ADM, "
                 "repeated leave, "
                 "cancellation during initialization, and reentrant "
                 "destruction passed.\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "Native voice lifecycle failure: " << error.what() << '\n';
    return 1;
  }
}
