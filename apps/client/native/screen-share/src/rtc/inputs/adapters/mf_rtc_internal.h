#pragma once

#include "mf_rtc_adapters.h"

#include "api\environment\environment.h"
#include "api\video\i420_buffer.h"
#include "api\video_codecs\h264_profile_level_id.h"
#include "modules\video_coding\include\video_error_codes.h"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>

namespace monky::native_rtc::mf::detail {

namespace sv = ::monky::screen_video;
using SteadyClock = std::chrono::steady_clock;
constexpr std::size_t kMaximumAccessUnitBytes = 8 * 1024 * 1024;
constexpr std::size_t kMaximumReadbacks = 2;
constexpr auto kProgressDeadline = std::chrono::seconds(11);
constexpr auto kStopDrainDeadline = std::chrono::seconds(2);
constexpr auto kFenceRetryInterval = std::chrono::milliseconds(100);
constexpr auto kFenceHealthInterval = std::chrono::seconds(1);

class AdapterError : public std::runtime_error {
 public:
  AdapterError(const char* code, const char* message,
               std::int32_t status = WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
               HRESULT hr = S_OK)
      : std::runtime_error(message), code(code), status(status), hresult(hr) {}
  const char* code;
  std::int32_t status;
  HRESULT hresult;
};

AdapterDiagnostic Diagnostic(const char* code, const char* message,
                             std::int32_t status = WEBRTC_VIDEO_CODEC_ERROR,
                             HRESULT hr = S_OK) noexcept;

// The thread/API exception boundary preserves the actual core error. It never
// reports successful work or substitutes software pixels after an exception.
template <typename Function>
std::optional<AdapterDiagnostic> Protect(Function&& function) {
  try {
    std::forward<Function>(function)();
    return std::nullopt;
  } catch (const AdapterError& error) {
    return Diagnostic(error.code, error.what(), error.status, error.hresult);
  } catch (const sv::EncoderError& error) {
    return Diagnostic(error.code.c_str(), error.what(),
                      WEBRTC_VIDEO_CODEC_ENCODER_FAILURE, error.hresult);
  } catch (const sv::DecoderError& error) {
    return Diagnostic(error.code.c_str(), error.what(),
                      WEBRTC_VIDEO_CODEC_ERROR, error.hresult);
  } catch (const winrt::hresult_error& error) {
    return Diagnostic("ERR_RTC_COM", "A native COM operation failed",
                      WEBRTC_VIDEO_CODEC_ERROR, error.code());
  } catch (const std::bad_alloc& error) {
    return Diagnostic("ERR_RTC_MEMORY", error.what(), WEBRTC_VIDEO_CODEC_MEMORY,
                      E_OUTOFMEMORY);
  } catch (const std::exception& error) {
    return Diagnostic("ERR_RTC_CPP", error.what());
  }
}

void RequireHr(HRESULT hr, const char* code, const char* message);

class Event {
 public:
  explicit Event(bool manual_reset = false);
  ~Event();
  Event(const Event&) = delete;
  Event& operator=(const Event&) = delete;
  HANDLE get() const { return handle_; }
  void Signal() const noexcept;
 private:
  HANDLE handle_ = nullptr;
};

struct WorkerSlot {
  ~WorkerSlot();
  Event published{true};
  std::atomic<HANDLE> thread{nullptr};
  std::atomic<unsigned> thread_id{0};
  std::atomic<bool> start_failed{false};
  std::mutex snapshot_mutex;
  std::optional<EncoderRuntimeSnapshot> encoder;
  std::optional<DecoderRuntimeSnapshot> decoder;
};

struct NativeLease;
class Worker;

class SharedState : public std::enable_shared_from_this<SharedState> {
 public:
  explicit SharedState(AdapterOptions options);
  const AdapterOptions options;
  void Report(std::uint64_t session, AdapterDiagnostic diagnostic,
              bool terminal = false) noexcept;
  std::vector<AdapterDiagnostic> TakeDiagnostics();
  AdapterSnapshot Snapshot();
  bool WaitForIdle(std::chrono::milliseconds timeout);
  std::shared_ptr<WorkerSlot> ReserveWorker();
  std::uint64_t NextSessionId();
  void RegisterBuffer(const webrtc::VideoFrameBuffer* buffer,
                      const std::shared_ptr<NativeLease>& lease);
  void UnregisterBuffer(const webrtc::VideoFrameBuffer* buffer) noexcept;
  std::shared_ptr<NativeLease> Lookup(
      const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const;

  std::atomic<std::uint64_t> encoded_access_units{0};
  std::atomic<std::uint64_t> rtc_rejected_access_units{0};
  std::atomic<std::uint64_t> decoded_gpu_frames{0};
  std::atomic<std::uint64_t> i420_readbacks{0};
  std::atomic<std::uint64_t> i420_failures{0};

 private:
  void ReapWorkersLocked();
  mutable std::mutex mutex_;
  std::vector<std::shared_ptr<WorkerSlot>> workers_;
  std::map<const webrtc::VideoFrameBuffer*, std::weak_ptr<NativeLease>> buffers_;
  std::array<AdapterDiagnostic, 64> diagnostics_{};
  std::size_t diagnostics_begin_ = 0, diagnostics_size_ = 0;
  std::uint64_t diagnostics_overwritten_ = 0, next_session_id_ = 1;
};

class Budget : public std::enable_shared_from_this<Budget> {
 public:
  struct Ticket {
    Ticket(std::shared_ptr<Budget> owner, std::size_t bytes)
        : owner(std::move(owner)), bytes(bytes) {}
    ~Ticket();
    Ticket(const Ticket&) = delete;
    Ticket& operator=(const Ticket&) = delete;
    std::shared_ptr<Budget> owner;
    std::size_t bytes;
  };
  Budget(std::size_t count, std::size_t bytes)
      : maximum_count_(count), maximum_bytes_(bytes) {}
  std::shared_ptr<Ticket> Acquire(std::size_t bytes);
  std::shared_ptr<Ticket> AcquireUntil(std::size_t bytes, SteadyClock::time_point deadline,
                                     const std::function<bool()>& cancelled);
 private:
  std::shared_ptr<Ticket> AcquireLocked(std::size_t bytes);
  std::mutex mutex_;
  std::condition_variable changed_;
  const std::size_t maximum_count_, maximum_bytes_;
  std::size_t count_ = 0, bytes_ = 0;
};

// The owner list is worker-only. Leases may drop their last external reference
// on any thread, but only Reap/Reset destroys a retired core on the MTA worker.
// The core parameter permits the same ownership controls without starting MF.
template <typename Core>
class RetiredDecoderSessions {
 public:
  explicit RetiredDecoderSessions(std::size_t maximum_retired) : maximum_retired_(maximum_retired) {}
  void Retire(std::shared_ptr<Core>& current) {
    if (!current || !current->Finished())
      throw AdapterError("ERR_RTC_DECODER_SESSION", "A decoder must finish before session replacement");
    Reap();
    if (current.use_count() > 1) {
      if (retired_.size() >= maximum_retired_)
        throw AdapterError("ERR_RTC_DECODER_OWNERS", "Retired decoder owner budget is exhausted",
                           WEBRTC_VIDEO_CODEC_MEMORY);
      retired_.push_back(std::move(current));
    } else current.reset();
  }
  void Reap() {
    std::erase_if(retired_, [](const auto& core) { return core.use_count() == 1; });
  }
  void Reset() { retired_.clear(); }
  std::size_t Retired() const { return retired_.size(); }
 private:
  const std::size_t maximum_retired_;
  std::vector<std::shared_ptr<Core>> retired_;
};

enum class FenceObservation { Pending, Complete, DeviceLost };

class FenceNotification {
 public:
  FenceObservation Observe(std::uint64_t completed, std::uint64_t required, bool device_lost = false);
  bool ShouldArm(SteadyClock::time_point now) const;
  void RecordArm(bool success, SteadyClock::time_point now);
  std::uint32_t WaitMilliseconds(SteadyClock::time_point now) const;
  bool Armed() const { return armed_; }
  bool ReportArmFailure();
 private:
  bool armed_ = false, complete_ = false, failure_reported_ = false;
  std::optional<SteadyClock::time_point> retry_at_;
};

template <typename Callback>
class CallbackGate {
 public:
  void Register(Callback* callback) {
    std::lock_guard lock(mutex_);
    callback_ = callback;
  }
  void Clear() {
    std::lock_guard lock(mutex_);
    active_ = false;
    callback_ = nullptr;
  }
  std::uint64_t Activate() {
    std::lock_guard lock(mutex_);
    if (++generation_ == 0) {
      throw AdapterError("ERR_RTC_CALLBACK_GENERATION",
                         "Callback generation exhausted");
    }
    active_ = true;
    return generation_;
  }
  void Deactivate(std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    if (generation == generation_) active_ = false;
  }
  bool HasCallback(std::uint64_t generation) const {
    std::lock_guard lock(mutex_);
    return active_ && generation == generation_ && callback_;
  }
  bool IsInvokingOnCurrentThread() const {
    return invoking_thread_.load() == GetCurrentThreadId();
  }
  template <typename Function>
  void Synchronize(Function&& function) {
    std::lock_guard lock(mutex_);
    std::forward<Function>(function)();
  }
  template <typename Function>
  bool Invoke(std::uint64_t generation, Function&& function) {
    // Recursive solely to permit unregister/Release from the callback itself.
    // No worker queue or codec-object mutex is held while calling foreign code.
    std::lock_guard lock(mutex_);
    if (!active_ || generation != generation_ || !callback_) return false;
    const auto previous_thread = invoking_thread_.exchange(GetCurrentThreadId());
    struct RestoreInvocation {
      std::atomic<DWORD>& thread;
      DWORD previous;
      ~RestoreInvocation() { thread.store(previous); }
    } restore{invoking_thread_, previous_thread};
    std::forward<Function>(function)(*callback_);
    return true;
  }
 private:
  mutable std::recursive_mutex mutex_;
  Callback* callback_ = nullptr;
  std::atomic<DWORD> invoking_thread_{0};
  std::uint64_t generation_ = 0;
  bool active_ = false;
};

struct NativeLease {
  NativeLease(std::shared_ptr<Worker> owner,
              std::shared_ptr<const sv::GpuNv12Frame> frame,
              std::shared_ptr<const sv::GpuDecodedFrame> decoded,
              winrt::com_ptr<ID3D11Device> device,
              winrt::com_ptr<ID3D11DeviceContext4> context,
              sv::VideoFrameRect visible,
              std::shared_ptr<sv::MfH264Decoder> decoder = nullptr);
  ~NativeLease();
  NativeLease(const NativeLease&) = delete;
  NativeLease& operator=(const NativeLease&) = delete;
  std::shared_ptr<Worker> owner;
  std::shared_ptr<const sv::GpuNv12Frame> frame;
  std::shared_ptr<const sv::GpuDecodedFrame> decoded;
  std::shared_ptr<sv::MfH264Decoder> decoder;
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext4> context;
  const sv::VideoFrameRect visible;
  std::shared_ptr<Budget::Ticket> admission;
  std::shared_ptr<const sv::GpuNv12Frame> Alias(
      const std::shared_ptr<NativeLease>& self) const;
};

webrtc::scoped_refptr<webrtc::VideoFrameBuffer> MakeNativeBuffer(
    const std::shared_ptr<SharedState>& state,
    std::shared_ptr<NativeLease> lease);

class Worker : public std::enable_shared_from_this<Worker> {
 public:
  explicit Worker(std::shared_ptr<SharedState> state);
  virtual ~Worker();
  std::int32_t Start();
  void RequestStop() noexcept;
  std::int32_t WaitForMediaStop();
  bool IsWorkerThread() const;
  bool stopping() const { return stop_requested_.load(); }
  std::int32_t status() const { return status_.load(); }
  std::uint64_t id() const { return id_; }
  const std::shared_ptr<SharedState>& state() const { return state_; }
  void Wake() const noexcept { command_event_.Signal(); }
  void RetainLease();
  void ReleaseLease() noexcept;
  std::size_t retained() const { return retained_.load(); }
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ReadI420(
      const std::shared_ptr<NativeLease>& lease);
  void Report(AdapterDiagnostic diagnostic, bool terminal = false) const;

 protected:
  void RecordEncoderSnapshot(EncoderRuntimeSnapshot snapshot);
  void RecordDecoderSnapshot(DecoderRuntimeSnapshot snapshot);
  bool PostMedia(std::function<void()> function,
                 EncoderInputDiagnosticTicket* encoder_diagnostic = nullptr,
                 DecoderInputDiagnosticTicket* decoder_diagnostic = nullptr);
  std::size_t CancelQueuedMedia(
      std::optional<EncoderInputReleaseReason> reason = std::nullopt,
      std::optional<DecoderInputReleaseReason> decoder_reason = std::nullopt);
  void Fail(AdapterDiagnostic diagnostic);
  HANDLE command_event() const { return command_event_.get(); }
  virtual void Initialize() {}
  virtual void BeforeWork() {}
  virtual void PumpCore() = 0;
  virtual void BeginStopCore() = 0;
  virtual void AbortCore() = 0;
  virtual bool CoreFinished() const = 0;
  virtual bool CorePending() const = 0;
  virtual HANDLE CoreEvent() const = 0;
  virtual void DestroyCore() noexcept = 0;
  virtual void RevokeCallbacks() = 0;
  virtual sv::I420Image ReadFrame(const NativeLease& lease,
                                 ID3D11Fence* completion) = 0;
  void WaitForFence(ID3D11Fence* fence, std::uint64_t value,
                    ID3D11Device* device);
  bool SourceReady(const std::shared_ptr<NativeLease>& lease,
                   const std::shared_ptr<Budget::Ticket>& admission);

 private:
  friend struct DecoderMappingQueueChecksAccess;
  struct Task {
    bool readback;
    std::function<void()> function;
    // Borrowed from the input already owned by function; never dereference after
    // dispatch, when function may have transferred/destroyed that input.
    EncoderInputDiagnosticTicket* encoder_diagnostic = nullptr;
    DecoderInputDiagnosticTicket* decoder_diagnostic = nullptr;
  };
  struct ReadbackJob;
  struct ReadbackRetirement;
  struct SourceFenceRetirement {
    std::shared_ptr<NativeLease> lease;
    std::shared_ptr<Budget::Ticket> admission;
    SteadyClock::time_point waiting_since;
    FenceNotification notification;
  };
  static unsigned __stdcall Entry(void* argument);
  void Run();
  bool PostReadback(std::function<void()> function);
  void PerformReadback(const std::shared_ptr<ReadbackJob>& job);
  void RetireReadbacks();
  void RetryNotification(FenceNotification& notification, ID3D11Fence* fence,
                         std::uint64_t value);
  bool TryFinish();
  DWORD WaitTimeout(bool aborting,
                    const std::optional<SteadyClock::time_point>& stop_deadline);

  const std::shared_ptr<SharedState> state_;
  const std::uint64_t id_;
  Event command_event_, started_{true}, media_stopped_{true};
  std::shared_ptr<WorkerSlot> slot_;
  std::atomic<DWORD> running_thread_id_{0};
  std::atomic<bool> stop_requested_{false};
  std::atomic<std::int32_t> status_{WEBRTC_VIDEO_CODEC_OK};
  std::atomic<std::size_t> retained_{0};
  std::mutex queue_mutex_;
  std::deque<Task> queue_;
  std::size_t queued_media_ = 0, queued_readbacks_ = 0;
  bool closing_ = false;
  std::shared_ptr<Budget> readback_budget_;
  std::vector<std::shared_ptr<ReadbackRetirement>> readback_retirements_;
  std::vector<SourceFenceRetirement> source_fence_retirements_;
  std::optional<SteadyClock::time_point> readback_watchdog_;
};

struct NegotiatedH264 {
  sv::H264Profile profile;
  std::uint8_t level;
};

void ValidateOptions(const AdapterOptions& options);
std::optional<NegotiatedH264> ParseFormat(
    const webrtc::SdpVideoFormat& format, std::uint8_t maximum_level);
std::vector<webrtc::SdpVideoFormat> SupportedFormats(std::uint8_t maximum_level);
bool IsSupportedLevel(std::uint8_t level);
webrtc::ColorSpace Bt709Limited();
bool IsBt709Limited(const webrtc::ColorSpace& color);

struct EncoderSetup {
  sv::EncoderConfig core;
  std::uint32_t initial_bitrate = 0;
  std::uint32_t maximum_bitrate = 0;
  std::uint32_t keyframe_interval = 0;
  webrtc::VideoContentType content_type = webrtc::VideoContentType::UNSPECIFIED;
};
EncoderSetup MakeEncoderSetup(const webrtc::VideoCodec& codec,
                             const webrtc::VideoEncoder::Settings& settings,
                             NegotiatedH264 negotiated,
                             const AdapterOptions& options);
struct EncoderRates {
  std::uint32_t bitrate = 0;
  double fps = 0;
};
EncoderRates ValidateRates(
    const webrtc::VideoEncoder::RateControlParameters& parameters,
    const EncoderSetup& setup);

class SourceRateLimiter {
 public:
  explicit SourceRateLimiter(double fps) : interval_us_(1000000.0L / fps) {}
  void SetFps(double fps);
  void Reset();
  bool Accept(std::int64_t timestamp_us);
 private:
  long double interval_us_;
  std::optional<long double> next_due_us_;
  std::optional<std::int64_t> last_seen_us_, last_accepted_us_;
};

class RtpTimeline {
 public:
  std::int64_t Push(std::uint32_t timestamp);
 private:
  std::optional<std::uint32_t> last_;
  std::uint64_t ticks_ = 0;
};

struct AccessUnitInfo {
  bool keyframe = false;
  bool has_picture = false;
  std::optional<sv::H264Sps> sps;
};
AccessUnitInfo InspectAccessUnit(std::span<const std::uint8_t> bytes);
void ValidateSps(const sv::H264Sps& sps, NegotiatedH264 negotiated,
                 std::uint32_t maximum_width, std::uint32_t maximum_height);
std::optional<sv::DecoderConfig> PlanDecoderSession(
    const std::optional<sv::H264Sps>& current, const AccessUnitInfo& input,
    std::span<const std::uint8_t> packet, NegotiatedH264 negotiated,
    std::uint32_t maximum_width, std::uint32_t maximum_height,
    std::uint32_t maximum_in_flight, const AdapterOptions& options);

std::unique_ptr<webrtc::VideoEncoderFactory> MakeEncoderFactory(
    const std::shared_ptr<SharedState>& state);
std::unique_ptr<webrtc::VideoDecoderFactory> MakeDecoderFactory(
    const std::shared_ptr<SharedState>& state);

}  // namespace monky::native_rtc::mf::detail
