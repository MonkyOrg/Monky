#pragma once

#include "receive_frame_policy.h"

#include <new>

namespace monky::native_rtc::engine {

template <typename Check>
void RunReceiveFramePolicyChecks(Check check) {
  const auto size = [](int width, int height) { return CpuUploadSize(width, height); };
  check(size(1920, 1080) && size(1920, 1080)->width == 1920 && size(1920, 1080)->height == 1080,
        "An even decoded size was changed for upload");
  check(size(1919, 1079) && size(1919, 1079)->width == 1918 && size(1919, 1079)->height == 1078,
        "An odd AV1 render size must lose its last column and row, not the frame");
  check(size(3841, 2161) && size(3841, 2161)->width == 3840 && size(3841, 2161)->height == 2160,
        "The upload bound applies to the presented size");
  check(!size(3, 2) && !size(4, 1) && !size(3842, 2160) && !size(3840, 2162) && !size(-4, 2),
        "An unpresentable decoded size was admitted");

  using Action = ReceiveFailureAction;
  const auto start = std::chrono::steady_clock::time_point{} + std::chrono::hours(1);
  const auto at = [&](long long milliseconds) { return start + std::chrono::milliseconds(milliseconds); };
  ReceiveFailurePolicy policy;
  check(policy.Reject(MONKY_ENGINE_INVALID, at(0)) == Action::kDropAndReport,
        "The first refused frame must be dropped and reported, not close the engine");
  check(policy.Reject(MONKY_ENGINE_UNSUPPORTED, at(100)) == Action::kDrop,
        "A refusal streak must be reported once, not per frame");
  policy.Presented();
  check(policy.Reject(MONKY_ENGINE_INVALID, at(200)) == Action::kDropAndReport,
        "A presented frame must end the refusal streak");
  check(policy.Reject(MONKY_ENGINE_INVALID, at(2199)) == Action::kDrop,
        "A refusal streak closed the engine before it persisted");
  check(policy.Reject(MONKY_ENGINE_INVALID, at(2200)) == Action::kClose,
        "Refusals that persist must close the engine instead of showing nothing forever");
  ReceiveFailurePolicy fresh;
  for (const auto status : {MONKY_ENGINE_FAILURE, MONKY_ENGINE_TIMEOUT, MONKY_ENGINE_QUEUE_FULL, MONKY_ENGINE_CLOSED})
    check(fresh.Reject(status, at(0)) == Action::kClose, "A device, allocation or engine failure was dropped as one frame");

  // The path every received frame takes in the engine, with the engine's effects recorded instead.
  struct Seen { int reports = 0, closes = 0, failures = 0; std::uint64_t target = 0; };
  const auto record = [](Seen& seen) {
    return ReceivedFrameFailures::Effects{
        [&seen](const FrameRoute& route, const Error&) { ++seen.reports; seen.target = route.target; },
        [&seen](const Error&) { ++seen.closes; },
        [&seen] { ++seen.failures; }};
  };
  const auto refused = [](MonkyEngineStatus status) {
    return [status] { throw Error("ERR_RTC_GPU_OUTPUT", "Unsupported decoded output", status); };
  };
  const FrameRoute route{7, 3, 1};
  Seen streak;
  ReceivedFrameFailures receiving(record(streak));
  receiving.Admit(route, at(0), refused(MONKY_ENGINE_UNSUPPORTED));
  check(streak.reports == 1 && streak.target == 7 && !streak.closes && !streak.failures && receiving.Rejected() == 1,
        "A received frame refused for its content closed the engine instead of being dropped and reported");
  receiving.Admit(route, at(1999), refused(MONKY_ENGINE_INVALID));
  check(streak.reports == 1 && !streak.closes && !streak.failures && receiving.Rejected() == 2,
        "A refusal streak must be reported once and keep the engine open while it lasts under 2 s");
  receiving.Admit(route, at(2000), refused(MONKY_ENGINE_INVALID));
  check(streak.reports == 1 && streak.closes == 1 && !streak.failures && receiving.Rejected() == 2,
        "Received frames refused for 2 s must close the engine");

  Seen recovered;
  ReceivedFrameFailures recovering(record(recovered));
  recovering.Admit(route, at(0), refused(MONKY_ENGINE_INVALID));
  recovering.Admit(route, at(1000), [&] { recovering.Presented(); });
  recovering.Admit(route, at(2500), refused(MONKY_ENGINE_INVALID));
  check(recovered.reports == 2 && !recovered.closes && !recovered.failures && recovering.Rejected() == 2,
        "A presented frame must start a new refusal streak instead of closing the engine");

  Seen device, broken;
  ReceivedFrameFailures failing(record(device)), throwing(record(broken));
  failing.Admit(route, at(0), refused(MONKY_ENGINE_FAILURE));
  check(device.closes == 1 && !device.reports && !device.failures && failing.Rejected() == 0,
        "A device failure on a received frame must close the engine");
  throwing.Admit(route, at(0), [] { throw std::bad_alloc(); });
  check(broken.failures == 1 && !broken.closes && !broken.reports && throwing.Rejected() == 0,
        "An exception that is not an engine Error must close the engine");
}

}  // namespace monky::native_rtc::engine
