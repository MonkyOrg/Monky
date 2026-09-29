#include "presentation.h"
#include <IOSurface/IOSurface.h>
#include <condition_variable>
#include <map>
#include <mutex>

namespace monky::native_rtc::engine::presentation {
namespace {
class SurfaceExporter final : public Exporter {
 public:
  SurfaceExporter(Options options, Callbacks callbacks)
      : options_(options), callbacks_(std::move(callbacks)) {
    if (!options.maximum_frames || options.maximum_frames > 64 || !options.maximum_texture_bytes ||
        !callbacks_.ready || !callbacks_.retired || !callbacks_.error)
      throw Error("ERR_RTC_MAC_PRESENTATION_OPTIONS", "Invalid IOSurface ownership options");
  }
  ~SurfaceExporter() override {
    if (!frames_.empty()) std::terminate();
  }
  bool Submit(std::uint64_t id, const FrameRoute& route, std::int64_t timestamp,
              std::shared_ptr<const DecodedFrame> pixel) override {
    if (!pixel || !pixel->pixel || !route.Valid(kMaxId) || !id || id > kMaxId ||
        timestamp < -1 || timestamp > static_cast<int64_t>(kMaxId))
      throw Error("ERR_RTC_MAC_PRESENTATION_FRAME", "Invalid IOSurface frame metadata");
    const auto surface = CVPixelBufferGetIOSurface(pixel->pixel);
    const auto width = CVPixelBufferGetWidth(pixel->pixel), height = CVPixelBufferGetHeight(pixel->pixel);
    if (!surface || width < 4 || width > 3840 || height < 2 || height > 2160 ||
        (width & 1) || (height & 1) ||
        CVPixelBufferGetPixelFormatType(pixel->pixel) != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
      throw Error("ERR_RTC_MAC_PRESENTATION_FORMAT", "Native presentation requires bounded IOSurface NV12");
    auto frame = std::make_shared<SharedFrame>();
    frame->id = id; frame->route = route; frame->pixel = std::move(pixel);
    frame->info = {sizeof(MonkyEngineSharedFrame), MONKY_ENGINE_ABI_VERSION,
      IOSurfaceGetID(surface), static_cast<uint32_t>(width), static_cast<uint32_t>(height),
      0, 0, static_cast<uint32_t>(width), static_cast<uint32_t>(height), timestamp,
      MONKY_ENGINE_PIXEL_FORMAT_NV12, MONKY_ENGINE_SHARED_IOSURFACE, 0, 0};
    const auto bytes = IOSurfaceGetAllocSize(surface);
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || frames_.size() >= options_.maximum_frames ||
          bytes > options_.maximum_texture_bytes || bytes_ > options_.maximum_texture_bytes - bytes) return false;
      if (frames_.contains(id)) throw Error("ERR_RTC_MAC_PRESENTATION_ID", "Duplicate IOSurface lease");
      auto cell = std::make_shared<Cell>(frame, surface, bytes);
      frames_.emplace(id, std::move(cell));
      bytes_ += bytes;
      maximum_frames_ = std::max(maximum_frames_, frames_.size());
    }
    bool published = false;
    try { published = callbacks_.ready(frame); }
    catch (...) {
      FinishPublish(id, false);
      throw;
    }
    FinishPublish(id, published);
    return true;
  }
  void Release(std::uint64_t id, std::uint32_t reason) override {
    if (reason != MONKY_ENGINE_FRAME_UNUSED && reason != MONKY_ENGINE_FRAME_EXTERNAL_REFERENCES_RELEASED)
      throw Error("ERR_RTC_MAC_PRESENTATION_PROOF", "IOSurface release requires external-reference proof");
    bool retiring;
    {
      std::lock_guard lock(mutex_);
      const auto found = frames_.find(id);
      if (found == frames_.end() || found->second->release_requested)
        throw Error("ERR_RTC_MAC_PRESENTATION_ID", "Unknown or already released IOSurface lease");
      found->second->release_requested = true;
      retiring = !found->second->publishing;
      if (retiring) found->second->retiring = true;
    }
    if (retiring) Retire(id);
  }
  void RetireRoute(const FrameRoute&) noexcept override {
    // Engine route identity gates ready callbacks. Already published surfaces
    // stay leased until Chromium proves that its GPU references are retired.
  }
  void RetireTarget(std::uint64_t) noexcept override {}
  void BeginStop() noexcept override {
    std::lock_guard lock(mutex_);
    stopping_ = true;
    changed_.notify_all();
  }
  bool WaitClosed(std::chrono::milliseconds timeout) override {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] { return stopping_ && frames_.empty(); });
  }
  Json Snapshot() const override {
    std::lock_guard lock(mutex_);
    return {{"backend", "IOSurface"}, {"stopping", stopping_}, {"closed", stopping_ && frames_.empty()},
        {"outstandingFrames", frames_.size()}, {"outstandingBytes", bytes_},
        {"maximumOutstandingFrames", maximum_frames_}, {"gpuCopies", 0}, {"retiredFrames", retired_}};
  }
 private:
  struct Cell {
    std::shared_ptr<const SharedFrame> frame;
    IOSurfaceRef surface;
    size_t bytes;
    bool publishing = true, published = false, release_requested = false, retiring = false;
    Cell(std::shared_ptr<const SharedFrame> value, IOSurfaceRef texture, size_t size)
        : frame(std::move(value)), surface(texture), bytes(size) {
      CFRetain(surface);
      IOSurfaceIncrementUseCount(surface);
    }
    ~Cell() {
      IOSurfaceDecrementUseCount(surface);
      CFRelease(surface);
    }
  };
  void FinishPublish(uint64_t id, bool published) {
    bool retiring;
    {
      std::lock_guard lock(mutex_);
      auto& cell = *frames_.at(id);
      cell.publishing = false;
      cell.published = published;
      retiring = !cell.retiring && (!published || cell.release_requested);
      if (retiring) cell.retiring = true;
    }
    if (retiring) Retire(id);
  }
  void Retire(uint64_t id) {
    Completion completion;
    {
      std::lock_guard lock(mutex_);
      const auto found = frames_.find(id);
      if (found == frames_.end()) throw Error("ERR_RTC_MAC_PRESENTATION_ID", "Unknown IOSurface retirement");
      completion = {id, found->second->frame->route, found->second->published, std::nullopt};
      bytes_ -= found->second->bytes;
      frames_.erase(found);
      ++retired_;
      changed_.notify_all();
    }
    callbacks_.retired(completion);
  }
  const Options options_;
  const Callbacks callbacks_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::map<uint64_t, std::shared_ptr<Cell>> frames_;
  size_t bytes_ = 0, maximum_frames_ = 0;
  uint64_t retired_ = 0;
  bool stopping_ = false;
};
}
std::unique_ptr<Exporter> CreateExporter(const Options& options, Callbacks callbacks) {
  return std::make_unique<SurfaceExporter>(options, std::move(callbacks));
}
}
