#include "mf_rtc_internal.h"

#include "api\make_ref_counted.h"

#include <process.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <limits>

namespace monky::native_rtc::mf::detail {
namespace {

DWORD RemainingMilliseconds(SteadyClock::time_point deadline) {
  const auto remaining = deadline - SteadyClock::now();
  if (remaining <= SteadyClock::duration::zero()) return 0;
  const std::int64_t milliseconds = std::chrono::ceil<std::chrono::milliseconds>(remaining).count();
  return static_cast<DWORD>((std::min)(
      milliseconds, static_cast<std::int64_t>(INFINITE - 1)));
}

bool SameDevice(ID3D11Device* first, ID3D11Device* second) {
  if (!first || !second) return false;
  winrt::com_ptr<IUnknown> a, b;
  RequireHr(first->QueryInterface(__uuidof(IUnknown), a.put_void()),
            "ERR_RTC_DEVICE_IDENTITY", "Cannot inspect the first device identity");
  RequireHr(second->QueryInterface(__uuidof(IUnknown), b.put_void()),
            "ERR_RTC_DEVICE_IDENTITY", "Cannot inspect the second device identity");
  return a.get() == b.get();
}

class NativeFrameBuffer : public webrtc::VideoFrameBuffer {
 public:
  NativeFrameBuffer(std::shared_ptr<SharedState> state,
                    std::shared_ptr<NativeLease> lease)
      : state_(std::move(state)), lease_(std::move(lease)) {
    state_->RegisterBuffer(this, lease_);
  }
  NativeFrameBuffer(const NativeFrameBuffer&) = delete;
  NativeFrameBuffer& operator=(const NativeFrameBuffer&) = delete;
  ~NativeFrameBuffer() override { state_->UnregisterBuffer(this); }
  Type type() const override { return Type::kNative; }
  int width() const override { return static_cast<int>(lease_->visible.width); }
  int height() const override { return static_cast<int>(lease_->visible.height); }
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override {
    return lease_->owner->ReadI420(lease_);
  }
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> CropAndScale(
      int x, int y, int crop_width, int crop_height,
      int scaled_width, int scaled_height) override {
    if (x == 0 && y == 0 && crop_width == width() && crop_height == height() &&
        scaled_width == width() && scaled_height == height()) {
      return webrtc::scoped_refptr<webrtc::VideoFrameBuffer>(this);
    }
    lease_->owner->Report(Diagnostic(
        "ERR_RTC_NATIVE_SCALING",
        "Native crop/scale is not implemented; no implicit CPU conversion is performed",
        WEBRTC_VIDEO_CODEC_ERR_PARAMETER));
    return nullptr;
  }
  std::string storage_representation() const override {
    return lease_->decoded ? "Monky MF immutable decoded NV12 lease"
                           : "Monky fenced source NV12 lease";
  }
 private:
  const std::shared_ptr<SharedState> state_;
  const std::shared_ptr<NativeLease> lease_;
};

}  // namespace

AdapterDiagnostic Diagnostic(const char* code, const char* message,
                             std::int32_t status, HRESULT hr) noexcept {
  AdapterDiagnostic result;
  result.codec_status = status;
  result.hresult = hr;
  std::snprintf(result.code.data(), result.code.size(), "%s", code);
  std::snprintf(result.message.data(), result.message.size(), "%s", message);
  return result;
}

void RequireHr(HRESULT hr, const char* code, const char* message) {
  if (FAILED(hr)) throw AdapterError(code, message, WEBRTC_VIDEO_CODEC_ERROR, hr);
}

Event::Event(bool manual_reset)
    : handle_(CreateEventW(nullptr, manual_reset ? TRUE : FALSE, FALSE, nullptr)) {
  if (!handle_) {
    throw AdapterError("ERR_RTC_EVENT", "Cannot create an adapter wake event",
                       WEBRTC_VIDEO_CODEC_ERROR, HRESULT_FROM_WIN32(GetLastError()));
  }
}
Event::~Event() { CloseHandle(handle_); }
void Event::Signal() const noexcept {
  // A failed signal here is an ownership invariant violation, not lost work
  // that can safely be ignored while another thread waits indefinitely.
  if (!SetEvent(handle_)) std::terminate();
}
WorkerSlot::~WorkerSlot() {
  if (const auto handle = thread.load()) CloseHandle(handle);
}

SharedState::SharedState(AdapterOptions requested) : options(std::move(requested)) {
  ValidateOptions(options);
  workers_.reserve(options.maximum_workers);
}

void SharedState::Report(std::uint64_t session, AdapterDiagnostic diagnostic,
                         bool terminal) noexcept {
  diagnostic.session_id = session;
  diagnostic.terminal = terminal;
  std::lock_guard lock(mutex_);
  if (diagnostics_size_ == diagnostics_.size()) {
    diagnostics_begin_ = (diagnostics_begin_ + 1) % diagnostics_.size();
    --diagnostics_size_;
    ++diagnostics_overwritten_;
  }
  diagnostics_[(diagnostics_begin_ + diagnostics_size_) % diagnostics_.size()] = diagnostic;
  ++diagnostics_size_;
}

std::vector<AdapterDiagnostic> SharedState::TakeDiagnostics() {
  std::lock_guard lock(mutex_);
  std::vector<AdapterDiagnostic> result;
  result.reserve(diagnostics_size_);
  for (std::size_t i = 0; i < diagnostics_size_; ++i) {
    result.push_back(diagnostics_[(diagnostics_begin_ + i) % diagnostics_.size()]);
  }
  diagnostics_begin_ = diagnostics_size_ = 0;
  return result;
}

void SharedState::ReapWorkersLocked() {
  std::erase_if(workers_, [](const std::shared_ptr<WorkerSlot>& slot) {
    if (slot->start_failed.load()) return true;
    const auto handle = slot->thread.load();
    if (!handle) return false;
    const auto wait = WaitForSingleObject(handle, 0);
    if (wait == WAIT_FAILED) {
      throw AdapterError("ERR_RTC_THREAD_WAIT", "Cannot observe worker termination",
                         WEBRTC_VIDEO_CODEC_ERROR, HRESULT_FROM_WIN32(GetLastError()));
    }
    return wait == WAIT_OBJECT_0;
  });
}

AdapterSnapshot SharedState::Snapshot() {
  std::lock_guard lock(mutex_);
  ReapWorkersLocked();
  AdapterSnapshot result;
  result.live_workers = workers_.size();
  result.native_buffers = buffers_.size();
  result.diagnostics_overwritten = diagnostics_overwritten_;
  result.encoded_access_units = encoded_access_units.load();
  result.rtc_rejected_access_units = rtc_rejected_access_units.load();
  result.decoded_gpu_frames = decoded_gpu_frames.load();
  result.i420_readbacks = i420_readbacks.load();
  result.i420_failures = i420_failures.load();
  for (const auto& slot : workers_) {
    std::lock_guard snapshot_lock(slot->snapshot_mutex);
    if (slot->encoder) {
      auto encoder = *slot->encoder;
      if (encoder.diagnostic_ledger) {
        encoder.diagnostics = encoder.diagnostic_ledger->Snapshot();
        encoder.encode_requests = encoder.diagnostics->submit.requests;
        encoder.requested_fps = encoder.diagnostics->rates.effective_limiter_fps;
        encoder.rtc_requested_fps = encoder.diagnostics->rates.framerate_fps;
        encoder.requested_bitrate_bps = encoder.diagnostics->rates.policy_bitrate_bps;
      }
      encoder.diagnostic_ledger.reset();
      result.encoders.push_back(std::move(encoder));
    }
    if (slot->decoder) {
      auto decoder = *slot->decoder;
      if (decoder.diagnostic_ledger) decoder.diagnostics = decoder.diagnostic_ledger->Snapshot();
      decoder.diagnostic_ledger.reset();
      result.decoders.push_back(std::move(decoder));
    }
  }
  return result;
}

bool SharedState::WaitForIdle(std::chrono::milliseconds timeout) {
  if (timeout < std::chrono::milliseconds::zero() || timeout > std::chrono::hours(1)) {
    throw AdapterError("ERR_RTC_WAIT_TIMEOUT", "Invalid worker retirement wait");
  }
  std::vector<std::shared_ptr<WorkerSlot>> slots;
  {
    std::lock_guard lock(mutex_);
    ReapWorkersLocked();
    slots = workers_;
  }
  const auto deadline = SteadyClock::now() + timeout;
  for (const auto& slot : slots) {
    if (slot->thread_id.load() == GetCurrentThreadId()) {
      Report(0, Diagnostic("ERR_RTC_SELF_WAIT", "A worker cannot wait for its own exit"));
      return false;
    }
    auto wait = WaitForSingleObject(slot->published.get(), RemainingMilliseconds(deadline));
    if (wait == WAIT_OBJECT_0 && !slot->start_failed.load()) {
      wait = WaitForSingleObject(slot->thread.load(), RemainingMilliseconds(deadline));
    }
    if (wait == WAIT_TIMEOUT) return false;
    if (wait != WAIT_OBJECT_0) {
      Report(0, Diagnostic("ERR_RTC_THREAD_WAIT", "Worker retirement observation failed",
                           WEBRTC_VIDEO_CODEC_ERROR, HRESULT_FROM_WIN32(GetLastError())));
      return false;
    }
  }
  std::lock_guard lock(mutex_);
  ReapWorkersLocked();
  return workers_.empty();
}

std::shared_ptr<WorkerSlot> SharedState::ReserveWorker() {
  std::lock_guard lock(mutex_);
  ReapWorkersLocked();
  if (workers_.size() >= options.maximum_workers) {
    throw AdapterError("ERR_RTC_WORKER_LIMIT",
                       "Worker budget exhausted; stopped sessions and retained buffers still count",
                       WEBRTC_VIDEO_CODEC_ERROR);
  }
  auto result = std::make_shared<WorkerSlot>();
  workers_.push_back(result);
  return result;
}

std::uint64_t SharedState::NextSessionId() {
  std::lock_guard lock(mutex_);
  if (next_session_id_ == (std::numeric_limits<std::uint64_t>::max)()) {
    throw AdapterError("ERR_RTC_SESSION_ID", "Adapter session identifiers exhausted");
  }
  return next_session_id_++;
}

void SharedState::RegisterBuffer(const webrtc::VideoFrameBuffer* buffer,
                                 const std::shared_ptr<NativeLease>& lease) {
  std::lock_guard lock(mutex_);
  if (buffers_.size() >= options.maximum_native_buffers ||
      !buffers_.emplace(buffer, lease).second) {
    throw AdapterError("ERR_RTC_NATIVE_BUFFER_LIMIT",
                       "Native buffer registry is full or the buffer is already registered",
                       WEBRTC_VIDEO_CODEC_MEMORY);
  }
}

void SharedState::UnregisterBuffer(const webrtc::VideoFrameBuffer* buffer) noexcept {
  std::lock_guard lock(mutex_);
  buffers_.erase(buffer);
}

std::shared_ptr<NativeLease> SharedState::Lookup(
    const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const {
  if (!buffer || buffer->type() != webrtc::VideoFrameBuffer::Type::kNative) return nullptr;
  std::lock_guard lock(mutex_);
  const auto found = buffers_.find(buffer.get());
  return found == buffers_.end() ? nullptr : found->second.lock();
}

Budget::Ticket::~Ticket() {
  {
    std::lock_guard lock(owner->mutex_);
    --owner->count_;
    owner->bytes_ -= bytes;
  }
  owner->changed_.notify_all();
}

std::shared_ptr<Budget::Ticket> Budget::Acquire(std::size_t bytes) {
  std::lock_guard lock(mutex_);
  return AcquireLocked(bytes);
}

std::shared_ptr<Budget::Ticket> Budget::AcquireUntil(
    std::size_t bytes, SteadyClock::time_point deadline, const std::function<bool()>& cancelled) {
  std::unique_lock lock(mutex_);
  if (bytes > maximum_bytes_) return nullptr;
  while (!cancelled()) {
    const auto now = SteadyClock::now();
    if (now >= deadline) return nullptr;
    if (auto ticket = AcquireLocked(bytes)) return ticket;
    changed_.wait_until(lock, (std::min)(deadline, now + std::chrono::milliseconds(10)));
  }
  return nullptr;
}

std::shared_ptr<Budget::Ticket> Budget::AcquireLocked(std::size_t bytes) {
  if (count_ >= maximum_count_ || bytes > maximum_bytes_ - bytes_) return nullptr;
  auto result = std::make_shared<Ticket>(shared_from_this(), bytes);
  ++count_;
  bytes_ += bytes;
  return result;
}

NativeLease::NativeLease(std::shared_ptr<Worker> requested_owner,
                         std::shared_ptr<const sv::GpuNv12Frame> requested_frame,
                         std::shared_ptr<const sv::GpuDecodedFrame> requested_decoded,
                         winrt::com_ptr<ID3D11Device> requested_device,
                         winrt::com_ptr<ID3D11DeviceContext4> requested_context,
                         sv::VideoFrameRect requested_visible,
                         std::shared_ptr<sv::MfH264Decoder> requested_decoder)
    : owner(std::move(requested_owner)), frame(std::move(requested_frame)),
      decoded(std::move(requested_decoded)), decoder(std::move(requested_decoder)),
      device(std::move(requested_device)),
      context(std::move(requested_context)), visible(requested_visible) {
  owner->RetainLease();
}

NativeLease::~NativeLease() {
  frame.reset();
  decoded.reset();
  context = nullptr;
  device = nullptr;
  decoder.reset();
  admission.reset();
  owner->ReleaseLease();
}

std::shared_ptr<const sv::GpuNv12Frame> NativeLease::Alias(
    const std::shared_ptr<NativeLease>& self) const {
  return {self, frame.get()};
}

webrtc::scoped_refptr<webrtc::VideoFrameBuffer> MakeNativeBuffer(
    const std::shared_ptr<SharedState>& state,
    std::shared_ptr<NativeLease> lease) {
  return webrtc::make_ref_counted<NativeFrameBuffer>(state, std::move(lease));
}

struct Worker::ReadbackJob {
  std::mutex mutex;
  std::condition_variable completed;
  bool started = false, done = false, cancelled = false;
  std::shared_ptr<NativeLease> lease;
  std::shared_ptr<Budget::Ticket> admission;
  webrtc::scoped_refptr<webrtc::I420BufferInterface> result;
};

struct Worker::ReadbackRetirement {
  std::shared_ptr<NativeLease> lease;
  std::shared_ptr<Budget::Ticket> admission;
  winrt::com_ptr<ID3D11Fence> completion;
  bool signaled = false;
  FenceNotification source_notification, completion_notification;
};

Worker::Worker(std::shared_ptr<SharedState> state)
    : state_(std::move(state)), id_(state_->NextSessionId()),
      readback_budget_(std::make_shared<Budget>(kMaximumReadbacks, 0)) {
  readback_retirements_.reserve(kMaximumReadbacks);
  source_fence_retirements_.reserve(state_->options.maximum_in_flight);
}
Worker::~Worker() = default;

std::int32_t Worker::Start() {
  const auto error = Protect([&] {
    slot_ = state_->ReserveWorker();
    auto baton = std::make_unique<std::shared_ptr<Worker>>(shared_from_this());
    unsigned thread_id = 0;
    const auto handle = _beginthreadex(nullptr, 0, &Worker::Entry, baton.get(), 0, &thread_id);
    if (!handle) {
      const auto native_errno = errno;
      slot_->start_failed.store(true);
      slot_->published.Signal();
      char message[128]{};
      std::snprintf(message, sizeof(message),
                    "Cannot create a bounded MTA adapter worker (_beginthreadex errno=%d)", native_errno);
      throw AdapterError("ERR_RTC_THREAD", message,
                         native_errno == ENOMEM ? WEBRTC_VIDEO_CODEC_MEMORY : WEBRTC_VIDEO_CODEC_ERROR,
                         native_errno == ENOMEM ? E_OUTOFMEMORY : E_FAIL);
    }
    baton.release();
    slot_->thread_id.store(thread_id);
    slot_->thread.store(reinterpret_cast<HANDLE>(handle));
    slot_->published.Signal();
  });
  if (error) {
    if (slot_ && !slot_->thread.load()) {
      slot_->start_failed.store(true);
      slot_->published.Signal();
    }
    Fail(*error);
    started_.Signal();
    media_stopped_.Signal();
    return error->codec_status;
  }
  const auto wait = WaitForSingleObject(
      started_.get(), static_cast<DWORD>(state_->options.operation_timeout.count()));
  if (wait != WAIT_OBJECT_0) {
    const auto failure = Diagnostic(
        "ERR_RTC_WORKER_START_WAIT",
        "Worker startup did not complete; stop requested without killing the native thread",
        wait == WAIT_TIMEOUT ? WEBRTC_VIDEO_CODEC_TIMEOUT : WEBRTC_VIDEO_CODEC_ERROR,
        wait == WAIT_FAILED ? HRESULT_FROM_WIN32(GetLastError()) : S_OK);
    Fail(failure);
    return failure.codec_status;
  }
  return status();
}

void Worker::RecordEncoderSnapshot(EncoderRuntimeSnapshot snapshot) {
  std::lock_guard lock(slot_->snapshot_mutex);
  slot_->encoder = std::move(snapshot);
}

void Worker::RecordDecoderSnapshot(DecoderRuntimeSnapshot snapshot) {
  std::lock_guard lock(slot_->snapshot_mutex);
  slot_->decoder = std::move(snapshot);
}

unsigned __stdcall Worker::Entry(void* argument) {
  std::unique_ptr<std::shared_ptr<Worker>> baton(
      static_cast<std::shared_ptr<Worker>*>(argument));
  auto owner = std::move(*baton);
  baton.reset();
  owner->running_thread_id_.store(GetCurrentThreadId());
  owner->slot_->thread_id.store(GetCurrentThreadId());
  owner->Run();
  return 0;
}

void Worker::RequestStop() noexcept {
  stop_requested_.store(true);
  Wake();
}

bool Worker::IsWorkerThread() const {
  return running_thread_id_.load() == GetCurrentThreadId();
}

std::int32_t Worker::WaitForMediaStop() {
  if (IsWorkerThread()) return status();
  const auto wait = WaitForSingleObject(
      media_stopped_.get(), static_cast<DWORD>(state_->options.operation_timeout.count()));
  if (wait == WAIT_OBJECT_0) return status();
  const auto failure = Diagnostic(
      "ERR_RTC_STOP_PENDING",
      "Native work is still retiring; its thread, core, and leases remain owned",
      wait == WAIT_TIMEOUT ? WEBRTC_VIDEO_CODEC_TIMEOUT : WEBRTC_VIDEO_CODEC_ERROR,
      wait == WAIT_FAILED ? HRESULT_FROM_WIN32(GetLastError()) : S_OK);
  Report(failure);
  return failure.codec_status;
}

void Worker::Report(AdapterDiagnostic diagnostic, bool terminal) const {
  state_->Report(id_, diagnostic, terminal);
}

void Worker::Fail(AdapterDiagnostic diagnostic) {
  std::int32_t expected = WEBRTC_VIDEO_CODEC_OK;
  status_.compare_exchange_strong(expected, diagnostic.codec_status);
  Report(diagnostic, true);
  RequestStop();
  RevokeCallbacks();
}

void Worker::RetainLease() {
  std::lock_guard lock(queue_mutex_);
  if (closing_) throw AdapterError("ERR_RTC_OWNER_CLOSED", "Native readback owner has retired");
  ++retained_;
}
void Worker::ReleaseLease() noexcept {
  if (retained_.fetch_sub(1) == 0) std::terminate();
  Wake();
}

bool Worker::PostMedia(std::function<void()> function,
                       EncoderInputDiagnosticTicket* encoder_diagnostic,
                       DecoderInputDiagnosticTicket* decoder_diagnostic) {
  {
    std::lock_guard lock(queue_mutex_);
    if (closing_ || stopping() || status() != WEBRTC_VIDEO_CODEC_OK ||
        queued_media_ >= state_->options.maximum_pending_frames) return false;
    queue_.push_back({false, std::move(function), encoder_diagnostic, decoder_diagnostic});
    ++queued_media_;
    // Commit diagnostics before the queue becomes visible to the worker.
    // A rejected/throwing post destroys an unposted ticket, not a queued input.
    if (encoder_diagnostic) encoder_diagnostic->Queued();
    if (decoder_diagnostic) decoder_diagnostic->Queued();
  }
  Wake();
  return true;
}

bool Worker::PostReadback(std::function<void()> function) {
  {
    std::lock_guard lock(queue_mutex_);
    if (closing_ || queued_readbacks_ >= kMaximumReadbacks) return false;
    queue_.push_back({true, std::move(function)});
    ++queued_readbacks_;
  }
  Wake();
  return true;
}

std::size_t Worker::CancelQueuedMedia(std::optional<EncoderInputReleaseReason> reason,
                                    std::optional<DecoderInputReleaseReason> decoder_reason) {
  std::lock_guard lock(queue_mutex_);
  const auto count = queued_media_;
  const auto cancellation = reason.value_or(status() != WEBRTC_VIDEO_CODEC_OK
      ? EncoderInputReleaseReason::WorkerError : EncoderInputReleaseReason::Stopped);
  const auto decoder_cancellation = decoder_reason.value_or(status() != WEBRTC_VIDEO_CODEC_OK
      ? DecoderInputReleaseReason::WorkerError : DecoderInputReleaseReason::Stopped);
  std::erase_if(queue_, [cancellation, decoder_cancellation](const Task& task) {
    if (task.readback) return false;
    if (task.encoder_diagnostic) task.encoder_diagnostic->ReleaseAs(cancellation);
    if (task.decoder_diagnostic) task.decoder_diagnostic->ReleaseAs(decoder_cancellation);
    return true;
  });
  queued_media_ = 0;
  return count;
}

bool Worker::TryFinish() {
  if (!stopping() || !CoreFinished() || !readback_retirements_.empty() ||
      !source_fence_retirements_.empty()) return false;
  std::lock_guard lock(queue_mutex_);
  if (retained() || !queue_.empty()) return false;
  closing_ = true;
  return true;
}

DWORD Worker::WaitTimeout(
    bool aborting, const std::optional<SteadyClock::time_point>& stop_deadline) {
  DWORD timeout = !aborting && CorePending()
      ? static_cast<DWORD>(std::chrono::duration_cast<std::chrono::milliseconds>(
            kProgressDeadline).count()) : INFINITE;
  if (stop_deadline && !aborting && !CoreFinished()) {
    timeout = (std::min)(timeout, RemainingMilliseconds(*stop_deadline));
  }
  if (readback_watchdog_) {
    timeout = (std::min)(timeout, RemainingMilliseconds(*readback_watchdog_));
  }
  const auto now = SteadyClock::now();
  for (const auto& readback : readback_retirements_) {
    timeout = (std::min)(timeout, static_cast<DWORD>(readback->source_notification.WaitMilliseconds(now)));
    const auto completion_wait = readback->signaled
        ? readback->completion_notification.WaitMilliseconds(now)
        : static_cast<std::uint32_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(kFenceHealthInterval).count());
    timeout = (std::min)(timeout, static_cast<DWORD>(completion_wait));
  }
  for (const auto& source : source_fence_retirements_)
    timeout = (std::min)(timeout, static_cast<DWORD>(source.notification.WaitMilliseconds(now)));
  return timeout;
}

void Worker::Run() {
  bool apartment = false;
  if (const auto error = Protect([&] {
        if (stopping()) return;
        RequireHr(CoInitializeEx(nullptr, COINIT_MULTITHREADED),
                  "ERR_RTC_MTA", "Cannot initialize the worker MTA");
        apartment = true;
        if (!stopping()) Initialize();
      })) Fail(*error);
  started_.Signal();
  bool stop_begun = false, aborting = false, ignore_core_event = false;
  std::optional<SteadyClock::time_point> stop_deadline;
  for (;;) {
    if (stopping() && !stop_begun) {
      CancelQueuedMedia();
      stop_begun = true;
      stop_deadline = SteadyClock::now() + kStopDrainDeadline;
      if (const auto error = Protect([&] { BeginStopCore(); })) Fail(*error);
    }
    if (!aborting && ((status() != WEBRTC_VIDEO_CODEC_OK) ||
        (stop_deadline && !CoreFinished() && SteadyClock::now() >= *stop_deadline))) {
      aborting = true;
      if (status() == WEBRTC_VIDEO_CODEC_OK) {
        Report(Diagnostic("ERR_RTC_DRAIN_DEADLINE",
                          "Graceful drain expired; requesting cooperative MF abort, not thread termination",
                          WEBRTC_VIDEO_CODEC_TIMEOUT));
      }
      if (const auto error = Protect([&] { AbortCore(); })) Fail(*error);
    }
    if (!stopping()) {
      if (const auto error = Protect([&] { BeforeWork(); })) Fail(*error);
    }
    if (stopping()) CancelQueuedMedia();
    std::optional<Task> task;
    {
      std::lock_guard lock(queue_mutex_);
      if (!queue_.empty()) {
        task = std::move(queue_.front());
        queue_.pop_front();
        if (task->readback) --queued_readbacks_;
        else --queued_media_;
      }
    }
    if (task) {
      if (const auto error = Protect([&] { task->function(); })) Fail(*error);
      task.reset();
    }
    if (!stopping() || !CoreFinished()) {
      if (const auto error = Protect([&] { PumpCore(); })) Fail(*error);
    }
    if (const auto error = Protect([&] { RetireReadbacks(); })) Fail(*error);
    if (stopping() && CoreFinished()) media_stopped_.Signal();
    if (TryFinish()) break;
    if ((stopping() && !stop_begun) ||
        (status() != WEBRTC_VIDEO_CODEC_OK && !aborting)) continue;
    {
      std::lock_guard lock(queue_mutex_);
      if (!queue_.empty()) continue;
    }
    HANDLE handles[]{command_event_.get(),
                     CoreFinished() || ignore_core_event ? nullptr : CoreEvent()};
    const DWORD count = handles[1] && handles[1] != handles[0] ? 2 : 1;
    const auto wait = WaitForMultipleObjects(
        count, handles, FALSE, WaitTimeout(aborting, stop_deadline));
    if (wait == WAIT_FAILED || (wait != WAIT_TIMEOUT && wait >= WAIT_OBJECT_0 + count)) {
      ignore_core_event = true;
      Fail(Diagnostic("ERR_RTC_WORKER_WAIT", "Native event wait failed",
                      WEBRTC_VIDEO_CODEC_ERROR, HRESULT_FROM_WIN32(GetLastError())));
    }
  }
  DestroyCore();
  if (apartment) CoUninitialize();
}

webrtc::scoped_refptr<webrtc::I420BufferInterface> Worker::ReadI420(
    const std::shared_ptr<NativeLease>& lease) {
  webrtc::scoped_refptr<webrtc::I420BufferInterface> result;
  const auto error = Protect([&] {
    if (!lease || lease->owner.get() != this) {
      throw AdapterError("ERR_RTC_READBACK_OWNER", "Readback requires this worker's actual GPU lease");
    }
    auto admission = readback_budget_->Acquire(0);
    if (!admission) {
      throw AdapterError("ERR_RTC_READBACK_QUEUE", "The bounded readback queue is full",
                         WEBRTC_VIDEO_CODEC_MEMORY);
    }
    auto job = std::make_shared<ReadbackJob>();
    job->lease = lease;
    job->admission = std::move(admission);
    if (IsWorkerThread()) {
      PerformReadback(job);
    } else {
      auto owner = shared_from_this();
      if (!PostReadback([owner, job] { owner->PerformReadback(job); })) {
        throw AdapterError("ERR_RTC_READBACK_CLOSED", "The readback owner is closed or full");
      }
    }
    std::unique_lock lock(job->mutex);
    if (!job->completed.wait_for(lock, state_->options.operation_timeout,
                                 [&] { return job->done; })) {
      if (!job->started) job->cancelled = true;
      throw AdapterError("ERR_RTC_READBACK_TIMEOUT",
                         "Readback timed out; in-progress native work and its resources remain owned",
                         WEBRTC_VIDEO_CODEC_TIMEOUT);
    }
    result = job->result;
  });
  if (error) {
    ++state_->i420_failures;
    Report(*error);
  }
  return result;
}

void Worker::PerformReadback(const std::shared_ptr<ReadbackJob>& job) {
  {
    std::lock_guard lock(job->mutex);
    if (job->cancelled) {
      job->done = true;
      job->completed.notify_all();
      return;
    }
    job->started = true;
  }
  std::shared_ptr<ReadbackRetirement> retirement;
  webrtc::scoped_refptr<webrtc::I420BufferInterface> result;
  auto error = Protect([&] {
    retirement = std::make_shared<ReadbackRetirement>();
    retirement->lease = job->lease;
    retirement->admission = job->admission;
    const auto device5 = job->lease->device.as<ID3D11Device5>();
    RequireHr(device5->CreateFence(0, D3D11_FENCE_FLAG_NONE,
                                   __uuidof(ID3D11Fence), retirement->completion.put_void()),
              "ERR_RTC_READBACK_FENCE", "Cannot create a readback retirement fence");
    readback_retirements_.push_back(retirement);
    readback_watchdog_ = SteadyClock::now() + kProgressDeadline;
    const auto& frame = *job->lease->frame;
    const auto source_event = frame.readyFence->SetEventOnCompletion(frame.readyValue, command_event_.get());
    retirement->source_notification.RecordArm(source_event == S_OK, SteadyClock::now());
    if (FAILED(source_event)) retirement->source_notification.ReportArmFailure();
    RequireHr(source_event,
              "ERR_RTC_SOURCE_FENCE", "Cannot await the real source readiness fence");
    const auto image = ReadFrame(*job->lease, retirement->completion.get());
    const auto width = job->lease->visible.width, height = job->lease->visible.height;
    const auto pixels = static_cast<std::size_t>(width) * height;
    if (image.width != width || image.height != height || image.y.size() != pixels ||
        image.u.size() != pixels / 4 || image.v.size() != pixels / 4) {
      throw AdapterError("ERR_RTC_I420_LAYOUT",
                         "Qualified readback did not return the exact visible I420 geometry");
    }
    result = webrtc::I420Buffer::Copy(
        static_cast<int>(width), static_cast<int>(height),
        image.y.data(), static_cast<int>(width),
        image.u.data(), static_cast<int>(width / 2),
        image.v.data(), static_cast<int>(width / 2));
  });
  if (retirement && retirement->completion) {
    // This fence follows even a FAILED qualified ReadI420 on the same immediate
    // context. Keep the core/wake HANDLE and source lease until all prior GPU
    // reads/events retire; a caller-side timeout is not permission to free them.
    const auto completion_error = Protect([&] {
      RequireHr(job->lease->context->Signal(retirement->completion.get(), 2),
                "ERR_RTC_READBACK_RETIREMENT", "Cannot fence readback retirement");
      retirement->signaled = true;
      job->lease->context->Flush();
      const auto completion_event = retirement->completion->SetEventOnCompletion(2, command_event_.get());
      retirement->completion_notification.RecordArm(completion_event == S_OK, SteadyClock::now());
      if (FAILED(completion_event)) retirement->completion_notification.ReportArmFailure();
      RequireHr(completion_event,
                "ERR_RTC_READBACK_RETIREMENT", "Cannot await readback retirement");
    });
    if (completion_error) {
      if (error) Report(*completion_error);
      else error = completion_error;
    }
  }
  if (error) {
    ++state_->i420_failures;
    Report(*error);
    result = nullptr;
  } else {
    ++state_->i420_readbacks;
  }
  {
    std::lock_guard lock(job->mutex);
    job->result = std::move(result);
    job->done = true;
  }
  job->completed.notify_all();
}

void Worker::RetryNotification(FenceNotification& notification, ID3D11Fence* fence,
                               std::uint64_t value) {
  const auto now = SteadyClock::now();
  if (!notification.ShouldArm(now)) return;
  const auto hr = fence->SetEventOnCompletion(value, command_event_.get());
  notification.RecordArm(hr == S_OK, now);
  if (hr != S_OK && notification.ReportArmFailure())
    Report(Diagnostic("ERR_RTC_FENCE_REARM",
                      "GPU event registration failed; bounded polling retains the lease until real completion",
                      WEBRTC_VIDEO_CODEC_ERROR, hr));
}

void Worker::RetireReadbacks() {
  std::erase_if(readback_retirements_, [&](const auto& readback) {
    const auto removed = readback->lease->device->GetDeviceRemovedReason();
    const auto ready = readback->lease->frame->readyFence->GetCompletedValue();
    const auto done = readback->completion->GetCompletedValue();
    const auto source = readback->source_notification.Observe(
        ready, readback->lease->frame->readyValue, FAILED(removed));
    const auto completion = readback->completion_notification.Observe(done, 2, FAILED(removed));
    if (source == FenceObservation::DeviceLost || completion == FenceObservation::DeviceLost) {
      Report(Diagnostic("ERR_RTC_READBACK_DEVICE_LOST",
                        "GPU device loss retired pending readback ownership",
                        WEBRTC_VIDEO_CODEC_ERROR, FAILED(removed) ? removed : DXGI_ERROR_DEVICE_REMOVED));
      return true;
    }
    if (readback->signaled && source == FenceObservation::Complete &&
        completion == FenceObservation::Complete) return true;
    if (source == FenceObservation::Pending)
      RetryNotification(readback->source_notification, readback->lease->frame->readyFence.get(),
                        readback->lease->frame->readyValue);
    if (readback->signaled && completion == FenceObservation::Pending)
      RetryNotification(readback->completion_notification, readback->completion.get(), 2);
    return false;
  });
  for (auto iterator = source_fence_retirements_.begin(); iterator != source_fence_retirements_.end();) {
    auto& source = *iterator;
    const auto removed = source.lease->device->GetDeviceRemovedReason();
    const auto ready = source.lease->frame->readyFence->GetCompletedValue();
    const auto observation = source.notification.Observe(
        ready, source.lease->frame->readyValue, FAILED(removed));
    if (observation == FenceObservation::DeviceLost) {
      Report(Diagnostic("ERR_RTC_SOURCE_DEVICE_LOST",
                        "Device loss retired the pending producer fence",
                        WEBRTC_VIDEO_CODEC_ERROR, FAILED(removed) ? removed : DXGI_ERROR_DEVICE_REMOVED));
    }
    if (observation != FenceObservation::Pending) {
      iterator = source_fence_retirements_.erase(iterator);
    } else {
      RetryNotification(source.notification, source.lease->frame->readyFence.get(),
                        source.lease->frame->readyValue);
      ++iterator;
    }
  }
  if (readback_retirements_.empty() && source_fence_retirements_.empty()) {
    readback_watchdog_.reset();
  } else if (readback_watchdog_ && SteadyClock::now() >= *readback_watchdog_) {
    readback_watchdog_.reset();
    Report(Diagnostic("ERR_RTC_GPU_RETIREMENT_PENDING",
                      "A GPU read/producer event is still outstanding; its bounded owner remains alive",
                      WEBRTC_VIDEO_CODEC_TIMEOUT));
  }
}

bool Worker::SourceReady(const std::shared_ptr<NativeLease>& lease,
                         const std::shared_ptr<Budget::Ticket>& admission) {
  RequireHr(lease->device->GetDeviceRemovedReason(),
            "ERR_RTC_SOURCE_DEVICE_LOST", "The producer device was lost");
  const auto ready = lease->frame->readyFence->GetCompletedValue();
  if (ready == UINT64_MAX) {
    throw AdapterError("ERR_RTC_SOURCE_DEVICE_LOST", "Producer fence reported device loss",
                       WEBRTC_VIDEO_CODEC_ERROR, DXGI_ERROR_DEVICE_REMOVED);
  }
  if (ready >= lease->frame->readyValue) return true;
  const auto found = std::find_if(source_fence_retirements_.begin(),
                                 source_fence_retirements_.end(),
                                 [&](const auto& source) { return source.lease == lease; });
  if (found != source_fence_retirements_.end()) {
    if (SteadyClock::now() - found->waiting_since >= kProgressDeadline) {
      throw AdapterError("ERR_RTC_SOURCE_FENCE_TIMEOUT",
                         "Producer readiness timed out; notification recovery and lease ownership remain active",
                         WEBRTC_VIDEO_CODEC_TIMEOUT);
    }
    return false;
  }
  if (source_fence_retirements_.size() >= state_->options.maximum_in_flight) {
    throw AdapterError("ERR_RTC_SOURCE_FENCE_LIMIT", "Producer fence retirement budget is full");
  }
  // Do not lend the MF core's wake HANDLE to an unfinished producer fence:
  // core Abort may complete before that external fence. This adapter owns the
  // wait and pins its own HANDLE, frame, and admission until actual retirement.
  source_fence_retirements_.push_back({lease, admission, SteadyClock::now(), {}});
  const auto hr = lease->frame->readyFence->SetEventOnCompletion(
      lease->frame->readyValue, command_event_.get());
  auto& notification = source_fence_retirements_.back().notification;
  notification.RecordArm(hr == S_OK, SteadyClock::now());
  readback_watchdog_ = SteadyClock::now() + kProgressDeadline;
  if (FAILED(hr)) {
    notification.ReportArmFailure();
    RequireHr(hr, "ERR_RTC_SOURCE_FENCE", "Cannot await producer readiness");
  }
  return false;
}

void Worker::WaitForFence(ID3D11Fence* fence, std::uint64_t value,
                          ID3D11Device* device) {
  RequireHr(fence->SetEventOnCompletion(value, command_event_.get()),
            "ERR_RTC_GPU_WAIT", "Cannot arm explicit GPU readback completion");
  const auto deadline = SteadyClock::now() + state_->options.operation_timeout;
  for (;;) {
    RequireHr(device->GetDeviceRemovedReason(), "ERR_RTC_DEVICE_LOST", "Readback device was lost");
    const auto completed = fence->GetCompletedValue();
    if (completed == UINT64_MAX) {
      throw AdapterError("ERR_RTC_DEVICE_LOST", "Readback fence reported device loss",
                         WEBRTC_VIDEO_CODEC_ERROR, DXGI_ERROR_DEVICE_REMOVED);
    }
    if (completed >= value) return;
    const auto remaining = RemainingMilliseconds(deadline);
    if (!remaining) {
      throw AdapterError("ERR_RTC_GPU_TIMEOUT", "Explicit readback GPU completion timed out",
                         WEBRTC_VIDEO_CODEC_TIMEOUT);
    }
    const auto wait = WaitForSingleObject(command_event_.get(), remaining);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
      throw AdapterError("ERR_RTC_GPU_WAIT", "Explicit GPU readback wait failed",
                         WEBRTC_VIDEO_CODEC_ERROR, HRESULT_FROM_WIN32(GetLastError()));
    }
  }
}

class SourceWorker final : public Worker {
 public:
  SourceWorker(std::shared_ptr<SharedState> state, ID3D11Device* device,
               ID3D11DeviceContext4* context)
      : Worker(std::move(state)),
        budget_(std::make_shared<Budget>(
            this->state()->options.maximum_in_flight, 256 * 1024 * 1024)) {
    if (!device || !context) {
      throw AdapterError("ERR_RTC_SOURCE_DEVICE", "An existing D3D11 device/context is required");
    }
    device_.copy_from(device);
    context_.copy_from(context);
  }

  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> Wrap(
      std::shared_ptr<const sv::GpuNv12Frame> frame) {
    webrtc::scoped_refptr<webrtc::VideoFrameBuffer> result;
    const auto error = Protect([&] {
      std::unique_lock lock(source_mutex_, std::try_to_lock);
      if (!lock.owns_lock()) {
        throw AdapterError("ERR_RTC_SOURCE_BUSY", "Source publication is busy; producer is not blocked");
      }
      if (stopping() || status() != WEBRTC_VIDEO_CODEC_OK) {
        throw AdapterError("ERR_RTC_SOURCE_CLOSED", "The native source is closed");
      }
      if (!frame || !frame->texture || !frame->readyFence || !frame->readyValue ||
          frame->readyValue == UINT64_MAX || frame->timestampUs < 0 ||
          frame->timestampUs > (std::numeric_limits<std::int64_t>::max)() / 10 ||
          frame->durationUs <= 0 || frame->durationUs > 1000000) {
        throw AdapterError("ERR_RTC_SOURCE_FRAME", "A real, bounded, fenced GPU NV12 lease is required");
      }
      D3D11_TEXTURE2D_DESC desc{};
      frame->texture->GetDesc(&desc);
      if (desc.Format != DXGI_FORMAT_NV12 || desc.Usage != D3D11_USAGE_DEFAULT ||
          desc.CPUAccessFlags || desc.Width < 16 || desc.Height < 16 ||
          desc.Width > 4096 || desc.Height > 4096 || ((desc.Width | desc.Height) & 1) ||
          desc.MipLevels != 1 || desc.SampleDesc.Count != 1 ||
          frame->subresource >= desc.ArraySize) {
        throw AdapterError("ERR_RTC_SOURCE_LAYOUT", "Unsupported native NV12 texture geometry/subresource");
      }
      winrt::com_ptr<ID3D11Device> texture_device, fence_device;
      frame->texture->GetDevice(texture_device.put());
      frame->readyFence->GetDevice(fence_device.put());
      if (!SameDevice(device_.get(), texture_device.get()) ||
          !SameDevice(device_.get(), fence_device.get())) {
        throw AdapterError("ERR_RTC_SOURCE_DEVICE", "Source texture/fence must use this exact device");
      }
      const auto texture_bytes = static_cast<std::uint64_t>(desc.Width) * desc.Height *
          3 / 2 * desc.ArraySize;
      if (texture_bytes > 256ull * 1024 * 1024) {
        throw AdapterError("ERR_RTC_SOURCE_BUDGET", "Underlying NV12 texture exceeds the source GPU budget");
      }
      auto admission = budget_->Acquire(static_cast<std::size_t>(texture_bytes));
      if (!admission) {
        throw AdapterError("ERR_RTC_SOURCE_BUDGET", "Source lease count/GPU byte budget exhausted",
                           WEBRTC_VIDEO_CODEC_MEMORY);
      }
      auto lease = std::make_shared<NativeLease>(
          shared_from_this(), std::move(frame), nullptr, device_, context_,
          sv::VideoFrameRect{0, 0, desc.Width, desc.Height});
      lease->admission = std::move(admission);
      result = MakeNativeBuffer(state(), std::move(lease));
    });
    if (error) Report(*error);
    return result;
  }

 protected:
  void Initialize() override {
    if (context_->GetType() != D3D11_DEVICE_CONTEXT_IMMEDIATE) {
      throw AdapterError("ERR_RTC_SOURCE_CONTEXT", "Native encoding/readback requires an immediate context");
    }
    winrt::com_ptr<ID3D11Device> device;
    context_->GetDevice(device.put());
    if (!SameDevice(device_.get(), device.get())) {
      throw AdapterError("ERR_RTC_SOURCE_DEVICE", "Source context belongs to a different device");
    }
    auto multithread = context_.as<ID3D11Multithread>();
    multithread->SetMultithreadProtected(TRUE);
    if (!multithread->GetMultithreadProtected()) {
      throw AdapterError("ERR_RTC_SOURCE_MULTITHREAD", "D3D11 context protection was not enabled");
    }
  }
  void PumpCore() override {}
  void BeginStopCore() override {}
  void AbortCore() override {}
  bool CoreFinished() const override { return true; }
  bool CorePending() const override { return false; }
  HANDLE CoreEvent() const override { return nullptr; }
  void RevokeCallbacks() override {}
  void DestroyCore() noexcept override {
    std::lock_guard lock(source_mutex_);
    context_ = nullptr;
    device_ = nullptr;
  }
  sv::I420Image ReadFrame(const NativeLease& lease, ID3D11Fence* completion) override {
    const auto& frame = *lease.frame;
    WaitForFence(frame.readyFence.get(), frame.readyValue, device_.get());
    D3D11_TEXTURE2D_DESC desc{};
    frame.texture->GetDesc(&desc);
    desc.ArraySize = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.BindFlags = desc.MiscFlags = 0;
    winrt::com_ptr<ID3D11Texture2D> readback;
    RequireHr(device_->CreateTexture2D(&desc, nullptr, readback.put()),
              "ERR_RTC_SOURCE_I420", "Cannot allocate explicit NV12 staging readback");
    const auto keyed = frame.texture.try_as<IDXGIKeyedMutex>();
    if (keyed) {
      const auto acquired = keyed->AcquireSync(0, 0);
      if (acquired != S_OK) {
        throw AdapterError("ERR_RTC_SOURCE_BUSY", "Source keyed texture is not available for readback",
                           WEBRTC_VIDEO_CODEC_ERROR, acquired);
      }
    }
    context_->CopySubresourceRegion(
        readback.get(), 0, 0, 0, 0, frame.texture.get(), frame.subresource, nullptr);
    const auto signal = context_->Signal(completion, 1);
    context_->Flush();
    const auto released = keyed ? keyed->ReleaseSync(0) : S_OK;
    RequireHr(signal, "ERR_RTC_SOURCE_I420", "Cannot fence explicit source readback");
    RequireHr(released, "ERR_RTC_SOURCE_MUTEX", "Cannot release source keyed mutex");
    WaitForFence(completion, 1, device_.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    RequireHr(context_->Map(readback.get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped),
              "ERR_RTC_SOURCE_I420", "Cannot map completed source NV12 readback");
    struct Unmap {
      ID3D11DeviceContext4* context;
      ID3D11Texture2D* texture;
      ~Unmap() { context->Unmap(texture, 0); }
    } unmap{context_.get(), readback.get()};
    if (!mapped.pData) throw AdapterError("ERR_RTC_SOURCE_I420", "NV12 mapping returned no pixels");
    const auto size = static_cast<std::size_t>(mapped.RowPitch) * (desc.Height + desc.Height / 2);
    return sv::CopyNv12ToI420(
        {static_cast<const std::uint8_t*>(mapped.pData), size}, mapped.RowPitch,
        desc.Width, desc.Height, lease.visible);
  }

 private:
  std::mutex source_mutex_;
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext4> context_;
  const std::shared_ptr<Budget> budget_;
};

}  // namespace monky::native_rtc::mf::detail

namespace monky::native_rtc::mf {

NativeGpuSource::NativeGpuSource(std::shared_ptr<detail::SourceWorker> worker)
    : worker_(std::move(worker)) {}
NativeGpuSource::~NativeGpuSource() { worker_->RequestStop(); }
webrtc::scoped_refptr<webrtc::VideoFrameBuffer> NativeGpuSource::WrapFrame(
    std::shared_ptr<const screen_video::GpuNv12Frame> frame) {
  return worker_->Wrap(std::move(frame));
}
std::int32_t NativeGpuSource::Close() {
  worker_->RequestStop();
  return worker_->WaitForMediaStop();
}

NativeRtcContext::NativeRtcContext(std::shared_ptr<detail::SharedState> state)
    : state_(std::move(state)) {}
NativeRtcContext::~NativeRtcContext() = default;
std::shared_ptr<NativeGpuSource> NativeRtcContext::CreateSource(
    ID3D11Device* device, ID3D11DeviceContext4* context) {
  auto worker = std::make_shared<detail::SourceWorker>(state_, device, context);
  auto source = std::shared_ptr<NativeGpuSource>(new NativeGpuSource(worker));
  const auto status = worker->Start();
  if (status != WEBRTC_VIDEO_CODEC_OK) {
    throw detail::AdapterError("ERR_RTC_SOURCE_START", "Cannot start the native GPU source owner", status);
  }
  return source;
}
std::shared_ptr<const screen_video::GpuNv12Frame> NativeRtcContext::GetGpuFrame(
    const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const {
  const auto lease = state_->Lookup(buffer);
  return lease ? lease->Alias(lease) : nullptr;
}
std::shared_ptr<const screen_video::GpuDecodedFrame> NativeRtcContext::GetDecodedFrame(
    const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const {
  const auto lease = state_->Lookup(buffer);
  return lease && lease->decoded
      ? std::shared_ptr<const screen_video::GpuDecodedFrame>(lease, lease->decoded.get()) : nullptr;
}
std::vector<AdapterDiagnostic> NativeRtcContext::TakeDiagnostics() {
  return state_->TakeDiagnostics();
}
AdapterSnapshot NativeRtcContext::Snapshot() const { return state_->Snapshot(); }
bool NativeRtcContext::WaitForIdle(std::chrono::milliseconds timeout) {
  return state_->WaitForIdle(timeout);
}
FactoryBundle CreateFactoryBundle(const AdapterOptions& options) {
  auto state = std::make_shared<detail::SharedState>(options);
  FactoryBundle result;
  result.context = std::shared_ptr<NativeRtcContext>(new NativeRtcContext(state));
  result.encoder_factory = detail::MakeEncoderFactory(state);
  result.decoder_factory = detail::MakeDecoderFactory(state);
  return result;
}

}  // namespace monky::native_rtc::mf
