#include "presentation.h"
#include "lease_policy.h"

#include <dxgi1_2.h>
#include <objbase.h>

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <exception>
#include <limits>
#include <mutex>
#include <new>
#include <thread>
#include <utility>
#include <vector>

namespace monky::native_rtc::engine::presentation {
namespace {

using Clock = std::chrono::steady_clock;
constexpr auto kGpuPollInterval = std::chrono::milliseconds(2);
constexpr auto kMaximumFenceValue = (std::numeric_limits<std::uint64_t>::max)();
static_assert(policy::kUnused == MONKY_ENGINE_FRAME_UNUSED);
static_assert(policy::kExternalReferencesReleased == MONKY_ENGINE_FRAME_EXTERNAL_REFERENCES_RELEASED);
static_assert(sizeof(MonkyEngineSharedFrame) == 64);

template <std::size_t Size>
void CopyText(char (&destination)[Size], std::string_view source) noexcept {
  const auto count = (std::min)(Size - 1, source.size());
  std::memcpy(destination, source.data(), count);
  destination[count] = '\0';
}

MonkyEngineError Diagnostic(std::string_view code, std::string_view message,
                            MonkyEngineStatus status = MONKY_ENGINE_FAILURE,
                            HRESULT hr = S_OK) noexcept {
  MonkyEngineError error{};
  error.struct_size = sizeof(error);
  error.status = status;
  error.hresult = static_cast<std::int32_t>(hr);
  CopyText(error.code, code);
  CopyText(error.message, message);
  return error;
}

class ContextBatch {
 public:
  explicit ContextBatch(ID3D11Multithread* protection) noexcept : protection_(protection) {
    protection_->Enter();
  }
  ~ContextBatch() { protection_->Leave(); }
  ContextBatch(const ContextBatch&) = delete;
  ContextBatch& operator=(const ContextBatch&) = delete;
 private:
  ID3D11Multithread* protection_;
};

struct DeviceBinding {
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<IUnknown> identity;
  winrt::com_ptr<ID3D11Device5> device5;
  winrt::com_ptr<ID3D11DeviceContext4> context;
  winrt::com_ptr<ID3D11Multithread> protection;
};

struct Slot {
  DeviceBinding binding;
  winrt::com_ptr<ID3D11Texture2D> texture;
  winrt::com_ptr<IDXGIKeyedMutex> mutex;
  winrt::com_ptr<ID3D11Fence> fence;
  HANDLE handle = nullptr;
  std::uint32_t width = 0, height = 0;
  std::uint64_t last_signal = 0, copy_value = 0, reclaim_value = 0;
  bool mutex_held = false;

  Slot() = default;
  Slot(const Slot&) = delete;
  Slot& operator=(const Slot&) = delete;
  ~Slot() { if (handle) CloseHandle(handle); }
};

enum class WaitKind { None, SourceFence, InitialMutex, CopyFence, Reacquire, ReclaimFence };
enum class Work { Idle, Progress, GpuWait };
enum class FenceResult { Pending, Complete, Fault };
enum class ColorSource { Configured, Sps, MediaType };

const char* ColorName(ColorSource source) noexcept {
  switch (source) {
    case ColorSource::Sps: return "sps";
    case ColorSource::MediaType: return "media-type";
    default: return "configured-bt709-limited";
  }
}

struct Metadata {
  std::uint64_t id = 0;
  FrameRoute route;
  std::int64_t timestamp_us = 0, decoded_timestamp_us = 0, duration_us = 0;
  std::uint32_t coded_width = 0, coded_height = 0;
  screen_video::VideoFrameRect visible{};
  ColorSource color_source = ColorSource::Configured;
};

struct Cell {
  // Control fields and accounting are protected by Exporter's mutex. The
  // immutable admitted metadata and all COM ownership are worker-only while active.
  bool active = false, maintenance = false, idle_quarantined = false;
  Metadata metadata;
  policy::Lease lease;
  std::optional<MonkyEngineError> retirement_error;
  std::uint64_t input_bytes = 0, slot_bytes = 0, export_reservation = 0;
  std::uint32_t cached_width = 0, cached_height = 0;
  WaitKind wait = WaitKind::None;
  Clock::time_point wait_started{};
  bool wait_reported = false;

  std::shared_ptr<const screen_video::GpuDecodedFrame> input;
  std::shared_ptr<SharedFrame> output;
  winrt::com_ptr<ID3D11Device> source_device;
  winrt::com_ptr<IUnknown> source_identity;
  bool source_checked = false, slot_prepared = false, destroy_slot_on_retire = false;
  Slot slot;
};

struct Counters {
  std::uint64_t submitted = 0, admitted = 0, rejected_invalid = 0, rejected_closed = 0;
  std::uint64_t rejected_duplicate = 0, dropped_full = 0, dropped_budget = 0, superseded = 0;
  std::uint64_t live_frames = 0, peak_frames = 0, input_leases = 0, input_retirements = 0;
  std::uint64_t input_bytes = 0, slot_bytes = 0, reserved_bytes = 0, peak_pixel_bytes = 0;
  std::uint64_t slots = 0, peak_slots = 0, allocations = 0, slot_reuses = 0, slot_retirements = 0;
  std::uint64_t handles_created = 0, handles_closed = 0, fences_created = 0, devices_borrowed = 0;
  std::uint64_t source_fence_polls = 0, source_fence_waits = 0;
  std::uint64_t initial_mutex_attempts = 0, initial_mutex_waits = 0;
  std::uint64_t gpu_copies = 0, copy_completions = 0, copy_fence_polls = 0, copy_fence_waits = 0;
  std::uint64_t publications = 0, publication_rejections = 0;
  std::uint64_t release_requests = 0, releases_accepted = 0, invalid_releases = 0;
  std::uint64_t duplicate_releases = 0, unknown_releases = 0;
  std::uint64_t reacquire_attempts = 0, reacquire_waits = 0, reacquisitions = 0;
  std::uint64_t reclamation_fences = 0, reclamation_completions = 0;
  std::uint64_t reclamation_fence_polls = 0, reclamation_fence_waits = 0;
  std::uint64_t retired = 0, retired_published = 0, discarded_unpublished = 0, retired_with_error = 0;
  std::uint64_t errors = 0, terminal_errors = 0, quarantines = 0, device_losses = 0;
  std::uint64_t observation_timeouts = 0, callback_failures = 0, coalesced_diagnostics = 0;
  std::uint64_t worker_gpu_waits = 0, worker_idle_waits = 0;
  std::int64_t last_timestamp_us = 0, last_decoded_timestamp_us = 0, last_duration_us = 0;
  ColorSource last_color_source = ColorSource::Configured;
  std::optional<MonkyEngineError> last_error;
};

struct PendingDiagnostic {
  std::uint64_t id = 0, target = 0;
  MonkyEngineError error{};
};

class D3D11Exporter final : public Exporter {
 public:
  D3D11Exporter(const Options& options, Callbacks callbacks)
      : options_(options), callbacks_(std::move(callbacks)), cells_(options.maximum_frames) {
    worker_ = std::thread([this] { Run(); });
  }

  ~D3D11Exporter() override {
    BeginStop();
    // There is deliberately no timeout destruction or detached-thread fallback.
    // The owner must destroy off this worker (normally after WaitClosed succeeds).
    if (!WaitClosed(std::chrono::milliseconds::max())) std::terminate();
  }

  bool Submit(std::uint64_t id, const FrameRoute& route, std::int64_t timestamp_us,
              std::shared_ptr<const screen_video::GpuDecodedFrame> frame) override {
    Metadata metadata;
    std::uint64_t bytes = 0;
    const bool valid = ReadMetadata(id, route, timestamp_us, frame, metadata, bytes);
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) { ++admission_busy_; return false; }
    ++counters_.submitted;
    if (!valid) {
      ++counters_.rejected_invalid;
      throw Error("ERR_PRESENTATION_METADATA", "Real bounded NV12 source metadata is required",
                  MONKY_ENGINE_INVALID);
    }
    if (stopping_ || exited_) { ++counters_.rejected_closed; return false; }
    for (const auto& cell : cells_) {
      if (cell.active && cell.metadata.id == id) {
        ++counters_.rejected_duplicate;
        return false;
      }
    }

    Cell* selected = nullptr;
    unsigned best_score = 0;
    bool vacant = false;
    for (auto& cell : cells_) {
      if (cell.active || cell.maintenance || cell.idle_quarantined) continue;
      vacant = true;
      const auto reservation = bytes > cell.slot_bytes ? bytes - cell.slot_bytes : 0;
      const auto used = PixelBytesLocked();
      if (!policy::FitsBudget(used, bytes, options_.maximum_texture_bytes) ||
          !policy::FitsBudget(used + bytes, reservation, options_.maximum_texture_bytes)) continue;
      const unsigned score = cell.slot_bytes && cell.cached_width == metadata.coded_width &&
          cell.cached_height == metadata.coded_height ? 3u : (!cell.slot_bytes ? 2u : 1u);
      if (!selected || score > best_score) { selected = &cell; best_score = score; }
    }
    if (!selected) {
      if (vacant) { ++counters_.dropped_budget; trim_idle_ = true; }
      else ++counters_.dropped_full;
      ++wake_generation_;
      lock.unlock();
      wake_.notify_one();
      return false;
    }

    for (auto& cell : cells_) {
      if (cell.active && policy::SupersedeQueued(cell.lease, cell.metadata.route, route)) {
        ++counters_.superseded;
        if (!cell.retirement_error)
          cell.retirement_error = Diagnostic("ERR_PRESENTATION_SUPERSEDED",
              "A newer frame superseded queued input; its source fence still gates retirement",
              MONKY_ENGINE_CANCELLED);
      }
    }
    selected->active = true;
    selected->metadata = metadata;
    selected->lease = {};
    selected->input = std::move(frame);
    selected->input_bytes = bytes;
    selected->export_reservation = bytes > selected->slot_bytes ? bytes - selected->slot_bytes : 0;
    counters_.input_bytes += bytes;
    counters_.reserved_bytes += selected->export_reservation;
    ++counters_.admitted;
    ++counters_.input_leases;
    ++counters_.live_frames;
    counters_.peak_frames = (std::max)(counters_.peak_frames, counters_.live_frames);
    UpdatePixelPeakLocked();
    ++wake_generation_;
    lock.unlock();
    wake_.notify_one();
    return true;
  }

  void Release(std::uint64_t id, std::uint32_t reason) override {
    std::unique_lock lock(mutex_);
    std::optional<MonkyEngineError> rejection;
    ++counters_.release_requests;
    Cell* found = nullptr;
    for (auto& cell : cells_) {
      if (cell.active && cell.metadata.id == id) { found = &cell; break; }
    }
    if (!found) {
      ++counters_.unknown_releases;
      rejection = Diagnostic("ERR_PRESENTATION_RELEASE_NOT_FOUND",
          "Release does not identify a retained presentation lease", MONKY_ENGINE_NOT_FOUND);
    } else {
      const auto result = found->lease.Release(reason);
      if (result == policy::ReleaseResult::Accepted) {
        ++counters_.releases_accepted;
      } else if (result == policy::ReleaseResult::Duplicate) {
        ++counters_.duplicate_releases;
        rejection = Diagnostic("ERR_PRESENTATION_RELEASE_DUPLICATE",
            "A retained lease already has a release proof", MONKY_ENGINE_BUSY);
      } else {
        ++counters_.invalid_releases;
        rejection = Diagnostic("ERR_PRESENTATION_RELEASE_INVALID",
            "Release requires UNUSED or EXTERNAL_REFERENCES_RELEASED on a published, nonquarantined lease",
            MONKY_ENGINE_INVALID);
      }
      if (rejection) DeferLocked(id, found ? found->metadata.route.target : 0, *rejection);
    }
    ++wake_generation_;
    lock.unlock();
    wake_.notify_one();
    if (rejection)
      throw Error(rejection->code, rejection->message, rejection->status, rejection->hresult);
  }

  void RetireRoute(const FrameRoute& route) noexcept override {
    {
      std::lock_guard lock(mutex_);
      for (auto& cell : cells_) {
        if (cell.active && policy::RetireRoute(cell.lease, cell.metadata.route, route) &&
            !cell.retirement_error)
          cell.retirement_error = Diagnostic("ERR_PRESENTATION_ROUTE_RETIRED",
              "Unexposed receiver route retired; native GPU completion still gates reuse",
              MONKY_ENGINE_CANCELLED);
      }
      ++wake_generation_;
    }
    wake_.notify_one();
  }

  void RetireTarget(std::uint64_t target) noexcept override {
    {
      std::lock_guard lock(mutex_);
      for (auto& cell : cells_) {
        if (cell.active && cell.metadata.route.target == target && cell.lease.Stop() &&
            !cell.retirement_error)
          cell.retirement_error = Diagnostic("ERR_PRESENTATION_TARGET_RETIRED",
              "Unexposed target retired; external leases remain independently owned",
              MONKY_ENGINE_CANCELLED);
      }
      ++wake_generation_;
    }
    wake_.notify_one();
  }

  void BeginStop() noexcept override {
    {
      std::lock_guard lock(mutex_);
      StopLocked();
      ++wake_generation_;
    }
    wake_.notify_one();
  }

  bool WaitClosed(std::chrono::milliseconds timeout) override {
    std::unique_lock lock(mutex_);
    if (worker_id_ == std::this_thread::get_id()) return false;
    if (timeout == std::chrono::milliseconds::max()) {
      closed_.wait(lock, [this] { return exited_; });
    } else if (!closed_.wait_for(lock, (std::max)(timeout, std::chrono::milliseconds::zero()),
                                 [this] { return exited_; })) {
      return false;
    }
    lock.unlock();
    std::lock_guard join_lock(join_mutex_);
    if (worker_.joinable()) worker_.join();
    return true;
  }

  Json Snapshot() const override {
    Counters count;
    bool stopping, exited, mta, terminal;
    std::uint64_t source_pending = 0, source_ready = 0, copies = 0, publishing = 0;
    std::uint64_t external = 0, reacquiring = 0, reclaiming = 0, quarantined = 0, idle = 0;
    std::uint64_t idle_quarantined = 0;
    {
      std::lock_guard lock(mutex_);
      count = counters_;
      stopping = stopping_; exited = exited_; mta = mta_initialized_; terminal = terminal_;
      for (const auto& cell : cells_) {
        if (cell.idle_quarantined) ++idle_quarantined;
        if (!cell.active) { if (cell.slot_bytes) ++idle; continue; }
        switch (cell.lease.CurrentPhase()) {
          case policy::Phase::SourcePending: ++source_pending; break;
          case policy::Phase::SourceReady: ++source_ready; break;
          case policy::Phase::CopyPending: ++copies; break;
          case policy::Phase::Copied:
          case policy::Phase::Publishing: ++publishing; break;
          case policy::Phase::Published: ++external; break;
          case policy::Phase::Reacquiring: ++reacquiring; break;
          case policy::Phase::ReclaimUnsignaled:
          case policy::Phase::ReclaimPending: ++reclaiming; break;
          case policy::Phase::Quarantined: ++quarantined; break;
          case policy::Phase::Retirable: break;
        }
      }
    }
    Json result{
        {"state", exited ? "closed" : terminal ? "retaining-after-terminal-error" :
                         stopping ? "stopping" : !mta ? "starting" :
                         count.live_frames ? "active" : "waiting-for-real-frames"},
        {"workerExited", exited}, {"mtaInitialized", mta}, {"stopping", stopping},
        {"terminalDiagnostic", terminal}, {"maximumFrames", options_.maximum_frames},
        {"maximumTextureBytes", options_.maximum_texture_bytes},
        {"observationTimeoutMs", options_.observation_timeout.count()},
        {"byteAccounting", "estimated NV12 coded pixel bytes; source slice + pooled export + allocation reservations, not measured VRAM"},
        {"format", "NV12"}, {"colorSpace", "BT709-limited"},
        {"ntHandleOwnership", "exporter-owned; borrowed by SharedFrame; Electron duplicates"},
        {"sourceDevicePolicy", "borrow original protected device; never create or reopen private input"},
        {"deviceLossPolicy", "quarantine and retain; UINT64_MAX is never completion"},
        {"zeroCopy", false}, {"cpuPixelTransfers", 0}, {"devicesCreated", 0},
        {"submitted", count.submitted}, {"admitted", count.admitted},
        {"droppedAdmissionBusy", admission_busy_.load()},
        {"rejectedInvalid", count.rejected_invalid}, {"rejectedClosed", count.rejected_closed},
        {"rejectedDuplicate", count.rejected_duplicate}, {"droppedFull", count.dropped_full},
        {"droppedBudget", count.dropped_budget}, {"superseded", count.superseded},
        {"retainedFrames", count.live_frames}, {"peakRetainedFrames", count.peak_frames},
        {"retainedInputLeases", count.input_leases}, {"inputLeaseRetirements", count.input_retirements},
        {"estimatedInputPixelBytes", count.input_bytes}, {"estimatedExportPixelBytes", count.slot_bytes},
        {"reservedExportPixelBytes", count.reserved_bytes}, {"peakEstimatedPixelBytes", count.peak_pixel_bytes},
        {"estimatedTotalPixelBytes", count.input_bytes + count.slot_bytes + count.reserved_bytes},
        {"slots", count.slots}, {"peakSlots", count.peak_slots}, {"allocations", count.allocations},
        {"slotReuses", count.slot_reuses}, {"slotRetirements", count.slot_retirements},
        {"handlesCreated", count.handles_created}, {"handlesClosed", count.handles_closed},
        {"fencesCreated", count.fences_created}, {"sourceDeviceBindings", count.devices_borrowed},
        {"sourceFencePolls", count.source_fence_polls}, {"sourceFenceWaits", count.source_fence_waits},
        {"initialMutexAttempts", count.initial_mutex_attempts}, {"initialMutexWaits", count.initial_mutex_waits},
        {"gpuCopies", count.gpu_copies}, {"copyCompletions", count.copy_completions},
        {"copyFencePolls", count.copy_fence_polls}, {"copyFenceWaits", count.copy_fence_waits},
        {"published", count.publications}, {"publicationRejected", count.publication_rejections},
        {"releaseRequests", count.release_requests}, {"releaseProofsAccepted", count.releases_accepted},
        {"invalidReleases", count.invalid_releases}, {"duplicateReleases", count.duplicate_releases},
        {"unknownReleases", count.unknown_releases}, {"reacquireAttempts", count.reacquire_attempts},
        {"reacquireWaits", count.reacquire_waits}, {"reacquisitions", count.reacquisitions},
        {"reclamationFences", count.reclamation_fences}, {"reclamationCompletions", count.reclamation_completions},
        {"reclamationFencePolls", count.reclamation_fence_polls},
        {"reclamationFenceWaits", count.reclamation_fence_waits},
        {"retired", count.retired}, {"retiredPublished", count.retired_published},
        {"retiredWithError", count.retired_with_error},
        {"discardedUnpublished", count.discarded_unpublished}, {"quarantines", count.quarantines},
        {"errors", count.errors}, {"terminalErrors", count.terminal_errors},
        {"deviceLosses", count.device_losses}, {"observationTimeouts", count.observation_timeouts},
        {"callbackFailures", count.callback_failures}, {"coalescedDiagnostics", count.coalesced_diagnostics},
        {"workerGpuWaits", count.worker_gpu_waits}, {"workerIdleWaits", count.worker_idle_waits},
        {"lastTimestampUs", count.last_timestamp_us}, {"lastDecodedTimestampUs", count.last_decoded_timestamp_us},
        {"lastDurationUs", count.last_duration_us}, {"lastColorSource", ColorName(count.last_color_source)},
        {"phases", {{"sourcePending", source_pending}, {"sourceReady", source_ready},
          {"copyPending", copies}, {"publishing", publishing}, {"external", external},
          {"reacquiring", reacquiring}, {"reclaimPending", reclaiming}, {"quarantined", quarantined},
          {"idleSlots", idle}, {"quarantinedIdleSlots", idle_quarantined}}}};
    if (count.last_error) {
      result["lastError"] = {{"code", count.last_error->code}, {"message", count.last_error->message},
          {"status", count.last_error->status}, {"hresult", count.last_error->hresult}};
    }
    return result;
  }

 private:
  static bool ReadMetadata(std::uint64_t id, const FrameRoute& route, std::int64_t timestamp_us,
                           const std::shared_ptr<const screen_video::GpuDecodedFrame>& frame,
                           Metadata& result, std::uint64_t& bytes) noexcept {
    if (!id || id > kMaxId || !route.Valid(kMaxId) || !frame || !frame->texture ||
        !frame->readyFence || !frame->readyValue || frame->readyValue == kMaximumFenceValue ||
        timestamp_us < -static_cast<std::int64_t>(kMaxId) ||
        timestamp_us > static_cast<std::int64_t>(kMaxId) ||
        frame->colorSpace.fullRange || frame->codedWidth > D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION ||
        frame->codedHeight > D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION) return false;
    bytes = policy::Nv12PixelBytes(frame->codedWidth, frame->codedHeight);
    const auto& crop = frame->visibleRect;
    if (!bytes || !crop.width || !crop.height || ((crop.x | crop.y) & 1u) ||
        crop.width > frame->codedWidth ||
        crop.height > frame->codedHeight || crop.x > frame->codedWidth - crop.width ||
        crop.y > frame->codedHeight - crop.height) return false;
    ColorSource source;
    if (frame->colorSpace.source == "sps") source = ColorSource::Sps;
    else if (frame->colorSpace.source == "media-type") source = ColorSource::MediaType;
    else if (frame->colorSpace.source == "configured-bt709-limited") source = ColorSource::Configured;
    else return false;
    result = {id, route, timestamp_us, frame->timestampUs, frame->durationUs,
              frame->codedWidth, frame->codedHeight, crop, source};
    return true;
  }

  std::uint64_t PixelBytesLocked() const noexcept {
    return counters_.input_bytes + counters_.slot_bytes + counters_.reserved_bytes;
  }
  void UpdatePixelPeakLocked() noexcept {
    counters_.peak_pixel_bytes = (std::max)(counters_.peak_pixel_bytes, PixelBytesLocked());
  }
  policy::Lease LeaseState(const Cell& cell) const {
    std::lock_guard lock(mutex_);
    return cell.lease;
  }
  void StopLocked() noexcept {
    stopping_ = true;
    ++wake_generation_;
    for (auto& cell : cells_) {
      if (cell.active && cell.lease.Stop() && !cell.retirement_error)
        cell.retirement_error = Diagnostic("ERR_PRESENTATION_CANCELLED",
            "Unpublished frame cancelled; actual source/copy retirement is still required",
            MONKY_ENGINE_CANCELLED);
    }
  }
  void DeferLocked(std::uint64_t id, std::uint64_t target, const MonkyEngineError& error) noexcept {
    if (!pending_diagnostic_) pending_diagnostic_ = PendingDiagnostic{id, target, error};
    else ++counters_.coalesced_diagnostics;
  }
  void Report(std::uint64_t target, std::uint64_t id, const MonkyEngineError& error,
              bool terminal) noexcept {
    {
      std::lock_guard lock(mutex_);
      ++counters_.errors;
      counters_.last_error = error;
      if (terminal) {
        ++counters_.terminal_errors;
        terminal_ = true;
        StopLocked();
      }
    }
    try { callbacks_.error(target, id, error, terminal); }
    catch (...) {
      std::fputs("[monky-rtc] Presentation error callback threw; native ownership is retained.\n", stderr);
      std::lock_guard lock(mutex_);
      ++counters_.callback_failures;
      terminal_ = true;
      StopLocked();
      counters_.last_error = Diagnostic("ERR_PRESENTATION_ERROR_CALLBACK",
          "Error callback threw; exporter retains ownership and stops new publication");
    }
  }
  void Cancel(Cell& cell, const MonkyEngineError& error) {
    std::lock_guard lock(mutex_);
    cell.lease.Stop();
    if (!cell.retirement_error) cell.retirement_error = error;
  }
  void Quarantine(Cell& cell, const MonkyEngineError& error) noexcept {
    {
      std::lock_guard lock(mutex_);
      if (cell.lease.IsQuarantined()) return;
      cell.lease.Quarantine();
      cell.wait = WaitKind::None;
      cell.retirement_error = error;
      ++counters_.quarantines;
    }
    Report(cell.metadata.route.target, cell.metadata.id, error, true);
  }
  void Unexpected(Cell& cell, const MonkyEngineError& error) noexcept {
    const auto lease = LeaseState(cell);
    if (lease.CopyWasSubmitted() || lease.KeyWasReleased() || lease.PublicationStarted()) {
      Quarantine(cell, error);
    } else {
      cell.destroy_slot_on_retire = true;
      Cancel(cell, error);
    }
  }

  bool CheckDevice(Cell& cell, ID3D11Device* device) {
    const auto hr = device->GetDeviceRemovedReason();
    if (hr == S_OK) return true;
    {
      std::lock_guard lock(mutex_);
      ++counters_.device_losses;
    }
    Quarantine(cell, Diagnostic("ERR_PRESENTATION_DEVICE_LOST",
        "Source device is not healthy; resources remain quarantined rather than being declared complete",
        MONKY_ENGINE_FAILURE, hr));
    return false;
  }

  void EndWait(Cell& cell) {
    std::lock_guard lock(mutex_);
    cell.wait = WaitKind::None;
    cell.wait_reported = false;
  }
  void NoteWait(Cell& cell, WaitKind kind) {
    bool expired = false;
    {
      std::lock_guard lock(mutex_);
      const auto now = Clock::now();
      if (cell.wait != kind) {
        cell.wait = kind;
        cell.wait_started = now;
        cell.wait_reported = false;
      }
      if (!cell.wait_reported &&
          std::chrono::duration_cast<std::chrono::milliseconds>(now - cell.wait_started) >=
              options_.observation_timeout) {
        cell.wait_reported = true;
        ++counters_.observation_timeouts;
        expired = true;
      }
    }
    if (expired) {
      const auto error = Diagnostic("ERR_PRESENTATION_GPU_OBSERVATION_TIMEOUT",
          "GPU observation deadline expired; ownership is retained until real completion, never reclaimed by timeout",
          MONKY_ENGINE_TIMEOUT);
      {
        std::lock_guard lock(mutex_);
        if (!cell.retirement_error) cell.retirement_error = error;
      }
      Report(cell.metadata.route.target, cell.metadata.id, error, true);
    }
  }
  FenceResult PollFence(Cell& cell, ID3D11Fence* fence, std::uint64_t value,
                        ID3D11Device* device, WaitKind kind) {
    if (!CheckDevice(cell, device)) return FenceResult::Fault;
    const auto observation = policy::ObserveFence(fence->GetCompletedValue(), value);
    {
      std::lock_guard lock(mutex_);
      if (kind == WaitKind::SourceFence) ++counters_.source_fence_polls;
      else if (kind == WaitKind::CopyFence) ++counters_.copy_fence_polls;
      else ++counters_.reclamation_fence_polls;
      if (observation == policy::FenceObservation::Pending) {
        if (kind == WaitKind::SourceFence) ++counters_.source_fence_waits;
        else if (kind == WaitKind::CopyFence) ++counters_.copy_fence_waits;
        else ++counters_.reclamation_fence_waits;
      }
    }
    if (observation == policy::FenceObservation::Complete) {
      EndWait(cell);
      return FenceResult::Complete;
    }
    if (observation == policy::FenceObservation::Pending) {
      NoteWait(cell, kind);
      return FenceResult::Pending;
    }
    if (observation == policy::FenceObservation::DeviceLost) {
      std::lock_guard lock(mutex_);
      ++counters_.device_losses;
    }
    Quarantine(cell, Diagnostic("ERR_PRESENTATION_FENCE_AMBIGUOUS",
        "Fence reported device loss or an invalid target; retain all still-owned resources without inventing completion"));
    return FenceResult::Fault;
  }

  bool CheckSource(Cell& cell) {
    const auto& frame = *cell.input;
    frame.texture->GetDevice(cell.source_device.put());
    winrt::com_ptr<ID3D11Device> fence_device;
    frame.readyFence->GetDevice(fence_device.put());
    winrt::com_ptr<IUnknown> fence_identity;
    if (!cell.source_device || !fence_device ||
        cell.source_device->QueryInterface(__uuidof(IUnknown), cell.source_identity.put_void()) != S_OK ||
        fence_device->QueryInterface(__uuidof(IUnknown), fence_identity.put_void()) != S_OK ||
        cell.source_identity.get() != fence_identity.get()) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_SOURCE_FENCE_DEVICE",
          "The private source and its ready fence must have the same canonical D3D11 device identity"));
      return false;
    }
    cell.source_checked = true;
    D3D11_TEXTURE2D_DESC desc{};
    frame.texture->GetDesc(&desc);
    if (desc.Format != DXGI_FORMAT_NV12 || desc.Usage != D3D11_USAGE_DEFAULT ||
        desc.CPUAccessFlags != 0 || desc.MipLevels != 1 || desc.ArraySize == 0 ||
        desc.SampleDesc.Count != 1 || desc.SampleDesc.Quality != 0 ||
        frame.subresource >= desc.ArraySize || desc.Width != cell.metadata.coded_width ||
        desc.Height != cell.metadata.coded_height) {
      Cancel(cell, Diagnostic("ERR_PRESENTATION_SOURCE_LAYOUT",
          "Source must be DEFAULT NV12 with a valid actual slice and exact coded geometry",
          MONKY_ENGINE_UNSUPPORTED));
    }
    return true;
  }

  bool BindSource(Cell& cell, DeviceBinding& binding) {
    binding.device = cell.source_device;
    binding.identity = cell.source_identity;
    winrt::com_ptr<ID3D11DeviceContext> immediate;
    binding.device->GetImmediateContext(immediate.put());
    auto hr = immediate
        ? binding.device->QueryInterface(__uuidof(ID3D11Device5), binding.device5.put_void()) : E_UNEXPECTED;
    if (hr == S_OK)
      hr = immediate->QueryInterface(__uuidof(ID3D11DeviceContext4), binding.context.put_void());
    if (hr == S_OK)
      hr = immediate->QueryInterface(__uuidof(ID3D11Multithread), binding.protection.put_void());
    if (hr == S_OK && (!binding.device5 || !binding.context || !binding.protection)) hr = E_UNEXPECTED;
    if (hr != S_OK) {
      Cancel(cell, Diagnostic("ERR_PRESENTATION_DEVICE_INTERFACES",
          "Original source device requires Device5, Context4, and existing multithread protection",
          MONKY_ENGINE_UNSUPPORTED, hr));
      return false;
    }
    winrt::com_ptr<ID3D11Device> context_device;
    winrt::com_ptr<IUnknown> context_identity;
    binding.context->GetDevice(context_device.put());
    if (!context_device ||
        context_device->QueryInterface(__uuidof(IUnknown), context_identity.put_void()) != S_OK ||
        context_identity.get() != binding.identity.get()) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_CONTEXT_DEVICE",
          "Immediate context identity does not match the original private texture device"));
      return false;
    }
    if (!binding.protection->GetMultithreadProtected() ||
        (binding.device->GetCreationFlags() & D3D11_CREATE_DEVICE_SINGLETHREADED)) {
      Cancel(cell, Diagnostic("ERR_PRESENTATION_CONTEXT_UNPROTECTED",
          "MF must already protect its shared immediate context; exporter will not alter the decoder",
          MONKY_ENGINE_UNSUPPORTED));
      return false;
    }
    {
      std::lock_guard lock(mutex_);
      ++counters_.devices_borrowed;
    }
    return CheckDevice(cell, binding.device.get());
  }

  bool DestroySlot(Cell& cell, bool reserve_replacement = false) {
    auto& slot = cell.slot;
    if (slot.mutex_held) {
      HRESULT hr = E_UNEXPECTED;
      if (slot.mutex && slot.binding.protection && slot.binding.context &&
          slot.binding.protection->GetMultithreadProtected()) {
        ContextBatch batch(slot.binding.protection.get());
        hr = slot.mutex->ReleaseSync(0);
        slot.binding.context->Flush();
      }
      if (hr != S_OK) {
        {
          std::lock_guard lock(mutex_);
          cell.idle_quarantined = true;
        }
        Report(cell.metadata.route.target, cell.metadata.id,
            Diagnostic("ERR_PRESENTATION_IDLE_KEY_RELEASE",
                "An idle producer-owned mutex could not be released; retain its texture and handle",
                MONKY_ENGINE_FAILURE, hr), true);
        return false;
      }
      slot.mutex_held = false;
    }
    if (slot.handle) {
      if (!CloseHandle(slot.handle)) {
        const auto error = Diagnostic("ERR_PRESENTATION_HANDLE_CLOSE",
            "Cannot close exporter-owned idle NT handle; retain the slot and keep shutdown pending",
            MONKY_ENGINE_FAILURE, HRESULT_FROM_WIN32(GetLastError()));
        {
          std::lock_guard lock(mutex_);
          cell.idle_quarantined = true;
        }
        Report(cell.metadata.route.target, cell.metadata.id, error, true);
        return false;
      }
      slot.handle = nullptr;
      std::lock_guard lock(mutex_);
      ++counters_.handles_closed;
    }
    // Only idle or positively retired slots reach here; never ClearState on the
    // decoder's shared context, and never release a published mutex on stop.
    slot.fence = nullptr;
    slot.mutex = nullptr;
    slot.texture = nullptr;
    slot.binding = {};
    slot.width = slot.height = 0;
    slot.last_signal = slot.copy_value = slot.reclaim_value = 0;
    slot.mutex_held = false;
    {
      std::lock_guard lock(mutex_);
      if (cell.slot_bytes) {
        if (reserve_replacement) {
          counters_.reserved_bytes += cell.slot_bytes;
          cell.export_reservation += cell.slot_bytes;
        }
        counters_.slot_bytes -= cell.slot_bytes;
        --counters_.slots;
        ++counters_.slot_retirements;
      }
      cell.slot_bytes = 0;
      cell.cached_width = cell.cached_height = 0;
    }
    return true;
  }

  bool PrepareSlot(Cell& cell) {
    DeviceBinding binding;
    if (!BindSource(cell, binding)) return false;
    auto& slot = cell.slot;
    const auto width = cell.metadata.coded_width, height = cell.metadata.coded_height;
    if (slot.texture && slot.mutex && slot.fence && slot.handle && slot.mutex_held &&
        slot.binding.identity.get() == binding.identity.get() &&
        slot.width == width && slot.height == height && slot.last_signal < kMaximumFenceValue - 2) {
      cell.slot_prepared = true;
      std::lock_guard lock(mutex_);
      ++counters_.slot_reuses;
      return true;
    }

    // The cell's old slot is idle. Reserve its replacement before dropping its
    // accounting, so concurrent Submit cannot spend the incoming copy's budget.
    const auto bytes = policy::Nv12PixelBytes(width, height);
    {
      std::lock_guard lock(mutex_);
      const auto covered = cell.slot_bytes + cell.export_reservation;
      if (covered < bytes) {
        cell.lease.Stop();
        cell.retirement_error = Diagnostic("ERR_PRESENTATION_BUDGET_INVARIANT",
            "Export allocation lacks its bounded admission reservation");
        return false;
      }
    }
    // Maintenance of an active cell cannot be selected by another Submit.
    if (!DestroySlot(cell, true)) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_IDLE_SLOT_RETAINED",
          "Replacement cannot destroy an idle handle; admitted input and slot remain retained"));
      return false;
    }
    {
      std::lock_guard lock(mutex_);
      counters_.reserved_bytes -= cell.export_reservation - bytes;
      cell.export_reservation = bytes;
    }
    slot.binding = std::move(binding);
    slot.width = width;
    slot.height = height;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_NV12;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    auto hr = slot.binding.device->CreateTexture2D(&desc, nullptr, slot.texture.put());
    if (slot.texture) {
      std::lock_guard lock(mutex_);
      counters_.reserved_bytes -= cell.export_reservation;
      cell.export_reservation = 0;
      cell.slot_bytes = bytes;
      counters_.slot_bytes += bytes;
      cell.cached_width = width; cell.cached_height = height;
      ++counters_.slots; ++counters_.allocations;
      counters_.peak_slots = (std::max)(counters_.peak_slots, counters_.slots);
      UpdatePixelPeakLocked();
    }
    if (hr == S_OK && !slot.texture) hr = E_UNEXPECTED;
    if (hr == S_OK)
      hr = slot.texture->QueryInterface(__uuidof(IDXGIKeyedMutex), slot.mutex.put_void());
    if (hr == S_OK) {
      hr = slot.binding.device5->CreateFence(0, D3D11_FENCE_FLAG_NONE,
                                             __uuidof(ID3D11Fence), slot.fence.put_void());
      if (hr == S_OK) {
        std::lock_guard lock(mutex_);
        ++counters_.fences_created;
      }
      if (hr == S_OK && !slot.fence) hr = E_UNEXPECTED;
    }
    if (hr == S_OK) {
      winrt::com_ptr<IDXGIResource1> resource;
      hr = slot.texture->QueryInterface(__uuidof(IDXGIResource1), resource.put_void());
      if (hr == S_OK)
        hr = resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                                           nullptr, &slot.handle);
      if (slot.handle) {
        std::lock_guard lock(mutex_);
        ++counters_.handles_created;
      }
      if (hr == S_OK && !slot.handle) hr = E_UNEXPECTED;
    }
    if (hr == S_OK && !slot.mutex) hr = E_UNEXPECTED;
    if (hr != S_OK) {
      cell.destroy_slot_on_retire = true;
      if (CheckDevice(cell, slot.binding.device.get()))
        Cancel(cell, Diagnostic("ERR_PRESENTATION_EXPORT_ALLOCATION",
            "Cannot create the real single-slice keyed NV12 NT export; no pixel fallback is permitted",
            hr == E_NOINTERFACE || hr == DXGI_ERROR_UNSUPPORTED || hr == E_INVALIDARG
                ? MONKY_ENGINE_UNSUPPORTED : MONKY_ENGINE_FAILURE, hr));
      return false;
    }
    cell.slot_prepared = true;
    return true;
  }

  Work Acquire(Cell& cell, bool reclaim) {
    auto& slot = cell.slot;
    if (!CheckDevice(cell, slot.binding.device.get())) return Work::Idle;
    {
      std::lock_guard lock(mutex_);
      if (reclaim) ++counters_.reacquire_attempts;
      else ++counters_.initial_mutex_attempts;
    }
    const auto hr = slot.mutex->AcquireSync(0, 0);
    if (hr == S_OK) {
      slot.mutex_held = true;
      EndWait(cell);
      bool recorded = true;
      if (reclaim) {
        std::lock_guard lock(mutex_);
        recorded = cell.lease.MutexReacquired();
        if (recorded) ++counters_.reacquisitions;
      }
      if (!recorded) {
        Quarantine(cell, Diagnostic("ERR_PRESENTATION_REACQUIRE_STATE",
            "Native reacquisition has no matching external release proof"));
        return Work::Idle;
      }
      return Work::Progress;
    }
    if (hr == static_cast<HRESULT>(WAIT_TIMEOUT) || hr == DXGI_ERROR_WAIT_TIMEOUT) {
      {
        std::lock_guard lock(mutex_);
        if (reclaim) ++counters_.reacquire_waits;
        else ++counters_.initial_mutex_waits;
      }
      NoteWait(cell, reclaim ? WaitKind::Reacquire : WaitKind::InitialMutex);
      return Work::GpuWait;
    }
    Quarantine(cell, Diagnostic("ERR_PRESENTATION_KEYED_MUTEX",
        hr == static_cast<HRESULT>(WAIT_ABANDONED)
            ? "Keyed mutex was abandoned; ownership is ambiguous and the slot is permanently quarantined"
            : "Keyed mutex did not return S_OK; retain the slot instead of recycling ambiguous GPU ownership",
        MONKY_ENGINE_FAILURE, hr));
    return Work::Idle;
  }

  bool BeginCopy(Cell& cell) {
    auto& slot = cell.slot;
    if (!slot.binding.protection->GetMultithreadProtected()) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_PROTECTION_LOST",
          "Shared immediate-context protection changed; no unprotected GPU work will be issued"));
      return false;
    }
    if (!cell.output) cell.output = std::make_shared<SharedFrame>();
    {
      std::lock_guard lock(mutex_);
      if (!cell.lease.CopySubmitted()) return false;
    }
    slot.copy_value = ++slot.last_signal;
    HRESULT hr;
    {
      ContextBatch batch(slot.binding.protection.get());
      // originalSubresource belongs to the former MFT array, NOT this input.
      slot.binding.context->CopySubresourceRegion(slot.texture.get(), 0, 0, 0, 0,
          cell.input->texture.get(), cell.input->subresource, nullptr);
      hr = slot.binding.context->Signal(slot.fence.get(), slot.copy_value);
      slot.binding.context->Flush();
    }
    {
      std::lock_guard lock(mutex_);
      ++counters_.gpu_copies;
    }
    if (hr != S_OK) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_COPY_SIGNAL",
          "Producer copy may be in flight without a valid fence signal; retain its original input owner and export",
          MONKY_ENGINE_FAILURE, hr));
      return false;
    }
    return true;
  }

  void RetireInput(Cell& cell) {
    if (!cell.input || !LeaseState(cell).InputMayRetire()) return;
    // The alias can own the decoder/NativeLease, not merely a COM texture. Its
    // destructor must run on this worker, after our read, before display latency.
    cell.input.reset();
    cell.source_identity = nullptr;
    cell.source_device = nullptr;
    std::lock_guard lock(mutex_);
    counters_.input_bytes -= cell.input_bytes;
    cell.input_bytes = 0;
    --counters_.input_leases;
    ++counters_.input_retirements;
  }

  bool ReleaseKey(Cell& cell) {
    auto& slot = cell.slot;
    if (!CheckDevice(cell, slot.binding.device.get())) return false;
    if (!slot.mutex_held || !slot.binding.protection->GetMultithreadProtected()) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_KEY_RELEASE_OWNERSHIP",
          "Publication requires owned key zero and the original protected immediate context"));
      return false;
    }
    HRESULT hr;
    {
      ContextBatch batch(slot.binding.protection.get());
      hr = slot.mutex->ReleaseSync(0);
      slot.binding.context->Flush();
    }
    if (hr != S_OK) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_KEY_RELEASE",
          "ReleaseSync(0) did not return S_OK; publication and unsafe slot reuse are forbidden",
          MONKY_ENGINE_FAILURE, hr));
      return false;
    }
    slot.mutex_held = false;
    bool recorded;
    {
      std::lock_guard lock(mutex_);
      recorded = cell.lease.KeyZeroReleased();
    }
    if (!recorded) Quarantine(cell, Diagnostic("ERR_PRESENTATION_KEY_RELEASE_STATE",
        "Released key zero has no completed producer-copy state"));
    return recorded;
  }

  void Publish(Cell& cell) {
    auto& frame = *cell.output;
    const auto& metadata = cell.metadata;
    frame.id = metadata.id;
    frame.route = metadata.route;
    frame.texture = cell.slot.texture;
    frame.ready_fence = cell.slot.fence;
    frame.ready_value = cell.slot.copy_value;
    frame.info = {};
    frame.info.struct_size = sizeof(frame.info);
    frame.info.abi_version = MONKY_ENGINE_ABI_VERSION;
    frame.info.texture_nt_handle = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(cell.slot.handle));
    frame.info.coded_width = metadata.coded_width;
    frame.info.coded_height = metadata.coded_height;
    frame.info.visible_x = metadata.visible.x;
    frame.info.visible_y = metadata.visible.y;
    frame.info.width = metadata.visible.width;
    frame.info.height = metadata.visible.height;
    frame.info.timestamp_us = metadata.timestamp_us;
    frame.info.pixel_format = MONKY_ENGINE_PIXEL_FORMAT_NV12;
    frame.info.flags = MONKY_ENGINE_SHARED_GPU_COPY | MONKY_ENGINE_SHARED_COPY_COMPLETE |
        MONKY_ENGINE_SHARED_KEYED_MUTEX_ZERO | MONKY_ENGINE_SHARED_RECLAIM_FENCE;
    frame.info.gpu_copy_count = 1;
    {
      std::lock_guard lock(mutex_);
      if (!cell.lease.BeginPublication()) return;
    }
    bool accepted;
    try { accepted = callbacks_.ready(cell.output); }
    catch (...) {
      {
        std::lock_guard lock(mutex_);
        ++counters_.callback_failures;
      }
      // A throw is NOT false: an outside consumer might already have imported.
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_READY_CALLBACK",
          "Ready callback threw after publication began; outside visibility is ambiguous, so retain the lease"));
      return;
    }
    {
      std::lock_guard lock(mutex_);
      cell.lease.FinishPublication(accepted);
      if (accepted) {
        ++counters_.publications;
        counters_.last_timestamp_us = metadata.timestamp_us;
        counters_.last_decoded_timestamp_us = metadata.decoded_timestamp_us;
        counters_.last_duration_us = metadata.duration_us;
        counters_.last_color_source = metadata.color_source;
      } else {
        ++counters_.publication_rejections;
        if (!cell.retirement_error)
          cell.retirement_error = Diagnostic("ERR_PRESENTATION_READY_REJECTED",
              "Ready callback rejected the event without an outside consumer; native reclamation still gates retirement",
              MONKY_ENGINE_QUEUE_FULL);
      }
    }
  }

  bool SignalReclamation(Cell& cell) {
    auto& slot = cell.slot;
    if (!CheckDevice(cell, slot.binding.device.get())) return false;
    if (!slot.mutex_held || !slot.binding.protection->GetMultithreadProtected()) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_RECLAIM_OWNERSHIP",
          "Reclamation requires reacquired key zero and the original protected immediate context"));
      return false;
    }
    slot.reclaim_value = ++slot.last_signal;
    HRESULT hr;
    {
      ContextBatch batch(slot.binding.protection.get());
      hr = slot.binding.context->Signal(slot.fence.get(), slot.reclaim_value);
      slot.binding.context->Flush();
    }
    if (hr != S_OK) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_RECLAIM_SIGNAL",
          "Reacquisition did not obtain a valid new reclamation fence signal; retain rather than infer GPU completion",
          MONKY_ENGINE_FAILURE, hr));
      return false;
    }
    {
      std::lock_guard lock(mutex_);
      cell.lease.ReclaimSignaled();
      ++counters_.reclamation_fences;
    }
    return true;
  }

  void Retire(Cell& cell) {
    if (!LeaseState(cell).CanRetire()) return;
    RetireInput(cell);
    cell.output.reset();
    cell.source_identity = nullptr;
    cell.source_device = nullptr;
    bool destroy;
    {
      std::lock_guard lock(mutex_);
      destroy = stopping_ || cell.destroy_slot_on_retire;
    }
    if (destroy && !DestroySlot(cell)) {
      Quarantine(cell, Diagnostic("ERR_PRESENTATION_RETIRE_SLOT_RETAINED",
          "GPU use completed but slot handle retirement failed; retain the lease instead of emitting completion"));
      return;
    }
    Completion completion;
    {
      std::lock_guard lock(mutex_);
      completion = {cell.metadata.id, cell.metadata.route, cell.lease.Published(), cell.retirement_error};
      counters_.reserved_bytes -= cell.export_reservation;
      cell.export_reservation = 0;
      cell.active = false;
      cell.metadata = {};
      cell.lease = {};
      cell.retirement_error.reset();
      cell.wait = WaitKind::None;
      cell.wait_reported = false;
      cell.source_checked = cell.slot_prepared = cell.destroy_slot_on_retire = false;
      --counters_.live_frames;
      ++counters_.retired;
      if (completion.error) ++counters_.retired_with_error;
      if (completion.published) ++counters_.retired_published;
      else ++counters_.discarded_unpublished;
    }
    try { callbacks_.retired(completion); }
    catch (...) {
      {
        std::lock_guard lock(mutex_);
        ++counters_.callback_failures;
      }
      Report(completion.route.target, completion.id, Diagnostic("ERR_PRESENTATION_RETIRED_CALLBACK",
          "Retirement was genuine, but its completion callback threw"), true);
    }
  }

  Work Process(Cell& cell) {
    auto lease = LeaseState(cell);
    if (lease.IsQuarantined()) return Work::Idle;
    if (!cell.source_checked && !CheckSource(cell)) return Work::Idle;
    if (!lease.SourceIsComplete()) {
      const auto result = PollFence(cell, cell.input->readyFence.get(), cell.input->readyValue,
                                     cell.source_device.get(), WaitKind::SourceFence);
      if (result != FenceResult::Complete)
        return result == FenceResult::Pending ? Work::GpuWait : Work::Idle;
      std::lock_guard lock(mutex_);
      cell.lease.SourceCompleted();
    }
    lease = LeaseState(cell);
    if (lease.Cancelled() && !lease.CopyWasSubmitted()) {
      Retire(cell);
      return Work::Progress;
    }
    if (!lease.CopyWasSubmitted()) {
      if (!cell.slot_prepared && !PrepareSlot(cell))
        return LeaseState(cell).IsQuarantined() ? Work::Idle : Work::Progress;
      if (LeaseState(cell).Cancelled()) return Work::Progress;
      if (!cell.slot.mutex_held) {
        const auto acquired = Acquire(cell, false);
        if (acquired != Work::Progress) return acquired;
      }
      BeginCopy(cell);
      return LeaseState(cell).IsQuarantined() ? Work::Idle : Work::Progress;
    }
    if (!lease.CopyIsComplete()) {
      const auto result = PollFence(cell, cell.slot.fence.get(), cell.slot.copy_value,
                                     cell.slot.binding.device.get(), WaitKind::CopyFence);
      if (result != FenceResult::Complete)
        return result == FenceResult::Pending ? Work::GpuWait : Work::Idle;
      {
        std::lock_guard lock(mutex_);
        cell.lease.CopyCompleted();
        ++counters_.copy_completions;
      }
      RetireInput(cell);
    }
    lease = LeaseState(cell);
    if (lease.CanRetire()) { Retire(cell); return Work::Progress; }
    if (!lease.KeyWasReleased()) {
      if (!ReleaseKey(cell)) return Work::Idle;
      return Work::Progress;
    }
    if (!lease.PublicationStarted() && !lease.PublicationFinished()) {
      Publish(cell);
      return LeaseState(cell).IsQuarantined() ? Work::Idle : Work::Progress;
    }
    if (lease.CanReacquire()) {
      const auto acquired = Acquire(cell, true);
      if (acquired != Work::Progress) return acquired;
      return Work::Progress;
    }
    if (lease.HasReacquired() && !lease.HasReclaimSignal()) {
      SignalReclamation(cell);
      return LeaseState(cell).IsQuarantined() ? Work::Idle : Work::Progress;
    }
    if (lease.HasReclaimSignal()) {
      const auto result = PollFence(cell, cell.slot.fence.get(), cell.slot.reclaim_value,
                                     cell.slot.binding.device.get(), WaitKind::ReclaimFence);
      if (result != FenceResult::Complete)
        return result == FenceResult::Pending ? Work::GpuWait : Work::Idle;
      {
        std::lock_guard lock(mutex_);
        cell.lease.ReclaimCompleted();
        ++counters_.reclamation_completions;
      }
      Retire(cell);
      return Work::Progress;
    }
    return Work::Idle;
  }

  void TrimIdleSlots() {
    for (auto& cell : cells_) {
      {
        std::lock_guard lock(mutex_);
        if (cell.active || cell.maintenance || cell.idle_quarantined || !cell.slot_bytes) continue;
        cell.maintenance = true;
      }
      DestroySlot(cell);
      {
        std::lock_guard lock(mutex_);
        cell.maintenance = false;
      }
    }
  }

  void Run() noexcept {
    const auto apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool initialized = apartment == S_OK || apartment == S_FALSE;
    {
      std::lock_guard lock(mutex_);
      worker_id_ = std::this_thread::get_id();
      mta_initialized_ = initialized;
      if (!initialized) {
        StopLocked();
        for (auto& cell : cells_) {
          if (cell.active) { cell.lease.Quarantine(); ++counters_.quarantines; }
        }
      }
    }
    if (!initialized)
      Report(0, 0, Diagnostic("ERR_PRESENTATION_MTA",
          "Cannot initialize owned MTA worker; any already admitted input remains retained",
          MONKY_ENGINE_FAILURE, apartment), true);

    for (;;) {
      std::uint64_t generation;
      bool trim;
      std::optional<PendingDiagnostic> diagnostic;
      {
        std::lock_guard lock(mutex_);
        generation = wake_generation_;
        trim = std::exchange(trim_idle_, false) || stopping_;
        diagnostic = std::exchange(pending_diagnostic_, std::nullopt);
      }
      if (diagnostic) Report(diagnostic->target, diagnostic->id, diagnostic->error, false);
      bool progress = false, gpu_wait = false;
      for (auto& cell : cells_) {
        {
          std::lock_guard lock(mutex_);
          if (!cell.active || cell.lease.IsQuarantined()) continue;
        }
        try {
          const auto work = Process(cell);
          progress = progress || work == Work::Progress;
          gpu_wait = gpu_wait || work == Work::GpuWait;
        } catch (const std::bad_alloc&) {
          Unexpected(cell, Diagnostic("ERR_PRESENTATION_ALLOCATION",
              "Bounded presentation metadata allocation failed; no ambiguous GPU lease is discarded",
              MONKY_ENGINE_FAILURE, E_OUTOFMEMORY));
          progress = true;
        } catch (...) {
          Unexpected(cell, Diagnostic("ERR_PRESENTATION_WORKER",
              "Presentation worker failed unexpectedly; retain any possibly submitted GPU use"));
          progress = true;
        }
      }
      if (trim && initialized) TrimIdleSlots();
      std::unique_lock lock(mutex_);
      bool retained_idle = false;
      for (const auto& cell : cells_) retained_idle = retained_idle || cell.idle_quarantined;
      if (stopping_ && !counters_.live_frames && !counters_.slots && !retained_idle) break;
      if (progress || generation != wake_generation_) continue;
      if (gpu_wait) {
        ++counters_.worker_gpu_waits;
        // No SetEventOnCompletion registrations: no event HANDLE can outlive
        // its owner or be closed while a driver still retains that registration.
        wake_.wait_for(lock, kGpuPollInterval, [this, generation] { return generation != wake_generation_; });
      } else {
        ++counters_.worker_idle_waits;
        // Published external leases and quarantined failures have no poll timer.
        wake_.wait(lock, [this, generation] { return generation != wake_generation_; });
      }
    }
    if (initialized) CoUninitialize();
    {
      std::lock_guard lock(mutex_);
      exited_ = true;
    }
    closed_.notify_all();
  }

  const Options options_;
  const Callbacks callbacks_;
  std::vector<Cell> cells_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable wake_, closed_;
  Counters counters_;
  std::atomic<std::uint64_t> admission_busy_{0};
  std::optional<PendingDiagnostic> pending_diagnostic_;
  bool stopping_ = false, exited_ = false, terminal_ = false, mta_initialized_ = false, trim_idle_ = false;
  std::uint64_t wake_generation_ = 0;
  std::thread::id worker_id_{};
  std::thread worker_;
};

}  // namespace

std::unique_ptr<Exporter> CreateExporter(const Options& options, Callbacks callbacks) {
  if (!options.maximum_frames || options.maximum_frames > 64 || !options.maximum_texture_bytes ||
      options.maximum_texture_bytes > 256ull * 1024 * 1024 ||
      options.observation_timeout <= std::chrono::milliseconds::zero() ||
      options.observation_timeout > std::chrono::milliseconds(60000) ||
      !callbacks.ready || !callbacks.retired || !callbacks.error) {
    throw Error("ERR_PRESENTATION_OPTIONS",
        "Exporter requires 1..64 frames, 1..256MiB logical pixels, a 1..60000ms timeout, and all callbacks",
        MONKY_ENGINE_INVALID);
  }
  return std::make_unique<D3D11Exporter>(options, std::move(callbacks));
}

}  // namespace monky::native_rtc::engine::presentation
