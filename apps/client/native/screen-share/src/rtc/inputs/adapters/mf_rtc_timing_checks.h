#pragma once

#include "mf_rtc_internal.h"

#include <cmath>
#include <thread>

namespace monky::native_rtc::mf {
namespace timing_checks_detail {

using Clock = screen_video::EncoderTimingAggregate::Clock;

// Actual adapter event/worker dispatch, with a one-notice CPU fixture instead
// of an MFT. No encoder, GPU, capture, RTC engine or media factory is created.
class DelayedWorker final : public detail::Worker {
 public:
  explicit DelayedWorker(std::shared_ptr<detail::SharedState> state) : Worker(std::move(state)) {}
  bool Block() {
    return PostMedia([this] {
      blocked_.Signal();
      if (WaitForSingleObject(release_.get(), 5000) != WAIT_OBJECT_0)
        throw std::runtime_error("CPU timing fixture dispatch gate expired");
    });
  }
  bool WaitBlocked() { return WaitForSingleObject(blocked_.get(), 5000) == WAIT_OBJECT_0; }
  void Release() { release_.Signal(); }
  Clock::time_point Queue(Clock::time_point entered) {
    std::lock_guard lock(mutex_);
    if (queued_) throw std::runtime_error("CPU fixture exceeded its one-notice bound");
    queued_ = Clock::now();
    callback_.Observe(entered, *queued_);
    available_.Signal();
    return *queued_;
  }
  bool WaitDispatched() { return WaitForSingleObject(dispatched_.get(), 5000) == WAIT_OBJECT_0; }
  screen_video::EncoderTimingAggregate Dispatch() {
    std::lock_guard lock(mutex_);
    return dispatch_;
  }
  std::optional<Clock::time_point> DispatchedAt() {
    std::lock_guard lock(mutex_);
    return dispatched_at_;
  }

 protected:
  void PumpCore() override {
    std::lock_guard lock(mutex_);
    if (!queued_) return;
    dispatched_at_ = Clock::now();
    dispatch_.Observe(*queued_, *dispatched_at_);
    queued_.reset();
    EncoderRuntimeSnapshot snapshot;
    snapshot.session_id = id();
    snapshot.core.scheduling.haveOutput = callback_;
    snapshot.core.scheduling.haveOutputDispatch = dispatch_;
    RecordEncoderSnapshot(std::move(snapshot));
    dispatched_.Signal();
  }
  void BeginStopCore() override { finished_ = true; }
  void AbortCore() override { finished_ = true; }
  bool CoreFinished() const override { return finished_; }
  bool CorePending() const override { return false; }
  HANDLE CoreEvent() const override { return available_.get(); }
  void DestroyCore() noexcept override {}
  void RevokeCallbacks() override {}
  screen_video::I420Image ReadFrame(const detail::NativeLease&, ID3D11Fence*) override {
    throw std::runtime_error("CPU timing fixture cannot read pixels");
  }

 private:
  detail::Event available_, dispatched_{true}, blocked_{true}, release_{true};
  std::mutex mutex_;
  std::optional<Clock::time_point> queued_, dispatched_at_;
  screen_video::EncoderCallbackTiming callback_;
  screen_video::EncoderTimingAggregate dispatch_;
  bool finished_ = false;
};

}  // namespace timing_checks_detail

template <typename Check>
void RunEncoderSchedulingChecks(Check&& check) {
  using namespace timing_checks_detail;
  using screen_video::EncoderTimingAggregate;
  using screen_video::MeasureEncoderCall;
  EncoderTimingAggregate timing;
  check(timing.count == 0 && timing.totalMs == 0 && !timing.MeanMs() && !timing.MaximumMs(),
        "Unobserved encoder stage acquired a zero-latency observation");
  const auto zero = Clock::now();
  timing.Observe(zero, zero);
  check(timing.count == 1 && timing.MeanMs() == 0 && timing.MaximumMs() == 0,
        "Observed zero duration was confused with missing stage evidence");
  timing.Observe(zero, zero - std::chrono::microseconds(1));
  check(timing.count == 1 && timing.invalidIntervals == 1,
        "A backwards diagnostic interval became an accepted latency");

  EncoderTimingAggregate call;
  unsigned invocations = 0;
  Clock::time_point entered, returning;
  const auto result = MeasureEncoderCall(call, [&] {
    ++invocations;
    entered = Clock::now();
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    returning = Clock::now();
    return E_FAIL;
  });
  const auto inside = std::chrono::duration<double, std::milli>(returning - entered).count();
  check(result == E_FAIL && invocations == 1 && call.count == 1 && call.totalMs >= inside &&
        call.MeanMs() == call.MaximumMs(), "Call timer omitted blocking work or changed the HRESULT/invocation count");
  bool preserved_failure = false;
  try {
    MeasureEncoderCall(call, [&] {
      ++invocations;
      throw std::runtime_error("Preserved call failure");
    });
  } catch (const std::runtime_error& error) {
    preserved_failure = std::string_view(error.what()) == "Preserved call failure";
  }
  check(preserved_failure && invocations == 2 && call.count == 2 && std::isfinite(call.totalMs),
        "A throwing invocation was lost or counted more than once");
  EncoderTimingAggregate sink;
  check(!MeasureEncoderCall(sink, [] { return false; }) && sink.count == 1,
        "Packet-sink refusal was converted to success or counted as another encoded output");

  screen_video::EncoderCallbackTiming cadence;
  const auto first_entry = Clock::now(), first_queue = Clock::now();
  cadence.Observe(first_entry, first_queue);
  check(cadence.callbacks == 1 && cadence.arrivalInterval.count == 0 &&
        !cadence.arrivalInterval.MeanMs() && cadence.callbackToQueue.count == 1,
        "First callback invented an inter-arrival interval");
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
  const auto second_entry = Clock::now(), second_queue = Clock::now();
  cadence.Observe(second_entry, second_queue);
  const auto interval = std::chrono::duration<double, std::milli>(second_entry - first_entry).count();
  check(cadence.callbacks == 2 && cadence.arrivalInterval.count == 1 &&
        cadence.arrivalInterval.totalMs == interval && cadence.callbackToQueue.count == 2,
        "MF callback cadence was measured at worker handling rather than callback entry");

  auto state = std::make_shared<detail::SharedState>(AdapterOptions{});
  auto worker = std::make_shared<DelayedWorker>(state);
  const auto retire = [&] {
    worker->Release();
    worker->RequestStop();
    const auto stopped = worker->WaitForMediaStop();
    return state->WaitForIdle(std::chrono::seconds(5)) && stopped == WEBRTC_VIDEO_CODEC_OK;
  };
  try {
    check(worker->Start() == WEBRTC_VIDEO_CODEC_OK && worker->Block() && worker->WaitBlocked(),
          "CPU encoder timing fixture did not reach its controlled worker delay");
    const auto callback_entry = Clock::now();
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const auto queued = worker->Queue(callback_entry);
    check(worker->Dispatch().count == 0 && !worker->Dispatch().MeanMs() &&
          !worker->DispatchedAt(), "Queued callback/getter fabricated worker dispatch before the gate opened");
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
    const auto released = Clock::now();
    worker->Release();
    check(worker->WaitDispatched(), "Existing worker event loop did not dispatch the queued CPU notice");
    const auto dispatch = worker->Dispatch();
    const auto lower_bound = std::chrono::duration<double, std::milli>(released - queued).count();
    check(worker->DispatchedAt() && *worker->DispatchedAt() >= released &&
          dispatch.count == 1 && dispatch.totalMs >= lower_bound && dispatch.invalidIntervals == 0,
          "Callback-to-worker timing excluded deliberate worker backlog");
    auto snapshot = state->Snapshot();
    check(snapshot.encoders.size() == 1 && snapshot.encoders.front().session_id == worker->id(),
          "Timing observation was not bound to its actual worker snapshot");
    const auto& scheduling = snapshot.encoders.front().core.scheduling;
    const auto preparation = std::chrono::duration<double, std::milli>(queued - callback_entry).count();
    check(scheduling.haveOutput.callbacks == 1 &&
          scheduling.haveOutput.callbackToQueue.totalMs == preparation &&
          scheduling.haveOutputDispatch.totalMs == dispatch.totalMs &&
          scheduling.haveOutput.arrivalInterval.count == 0 && scheduling.needInput.callbacks == 0 &&
          scheduling.processInput.count == 0 && scheduling.processOutput.count == 0 &&
          snapshot.encoders.front().core.outputs == 0,
          "Per-encoder snapshot conflated callback preparation, dispatch, unobserved calls or encoded output");
    snapshot.encoders.front().core.scheduling.haveOutputDispatch.totalMs = -1;
    check(state->Snapshot().encoders.front().core.scheduling.haveOutputDispatch.totalMs == dispatch.totalMs,
          "Reading/mutating a diagnostic snapshot changed the worker's timing state");
    check(retire(), "Device-free timing worker did not retire through its existing lifecycle");
    check(state->Snapshot().encoders.empty(), "Timing diagnostics outlived their worker slot");
  } catch (...) {
    (void)retire();
    throw;
  }
}

}  // namespace monky::native_rtc::mf
