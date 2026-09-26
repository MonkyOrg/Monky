#include "videoCaptureHost.h"
#include <algorithm>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace monky::screen::mac {
namespace {
constexpr size_t kMaximumFrames = 8;
constexpr size_t kMaximumBytes = 32 * 1024 * 1024;
void Write(const uint8_t* bytes, size_t count) {
  while (count) {
    const auto written = write(3, bytes, count);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) _exit(74);
    bytes += written;
    count -= static_cast<size_t>(written);
  }
}
void Packet(NSDictionary* message, const std::vector<uint8_t>& payload = {}) {
  NSError* error = nil;
  NSData* json = [NSJSONSerialization dataWithJSONObject:message options:0 error:&error];
  if (error || !json || json.length > 65536 || payload.size() > 4 * 1024 * 1024) _exit(74);
  const uint32_t prefix[] = {htonl(0x4d435331), htonl(static_cast<uint32_t>(json.length)),
    htonl(static_cast<uint32_t>(payload.size()))};
  Write(reinterpret_cast<const uint8_t*>(prefix), sizeof(prefix));
  Write(static_cast<const uint8_t*>(json.bytes), json.length);
  Write(payload.data(), payload.size());
}
}
struct VideoCaptureHost::State : std::enable_shared_from_this<State> {
  std::mutex mutex;
  std::condition_variable changed;
  std::deque<EncodedFrame> queue;
  size_t frames = 0, bytes = 0, peak_frames = 0, peak_bytes = 0;
  uint64_t written = 0;
  bool stopping = false, writer_closed = false, owner_closed = false;
  NSString* error_code = nil;
  OSStatus error_status = 0;
  VideoEncoder::Failure notify;
  std::thread writer;
  std::unique_ptr<VideoCapture> capture;
  std::shared_future<void> close;
  std::shared_ptr<std::promise<void>> closing;

  void Fail(const char* code, OSStatus status) {
    {
      std::lock_guard lock(mutex);
      if (error_code) return;
      error_code = @(code); error_status = status; changed.notify_all();
    }
    notify(code, status);
  }
  bool Writable() {
    std::lock_guard lock(mutex);
    if (error_code || stopping || frames >= kMaximumFrames || bytes >= kMaximumBytes) return false;
    ++frames;
    peak_frames = std::max(peak_frames, frames);
    return true;
  }
  void Push(EncodedFrame frame) {
    std::lock_guard lock(mutex);
    if (stopping || !frames || frame.bytes.size() > kMaximumBytes - bytes)
      throw std::runtime_error("ERR_MAC_CAPTURE_OUTPUT_BACKPRESSURE");
    bytes += frame.bytes.size();
    peak_bytes = std::max(peak_bytes, bytes);
    queue.push_back(std::move(frame));
    changed.notify_one();
  }
  void Run() {
    @autoreleasepool {
      Packet(@{@"type": @"hello", @"protocol": @1, @"pid": @(getpid()),
        @"codec": @"h264", @"timebase": @"mach-host-us"});
      for (;;) {
        EncodedFrame frame;
        {
          std::unique_lock lock(mutex);
          changed.wait(lock, [&] { return error_code || stopping || !queue.empty(); });
          if (error_code) {
            NSString* code = error_code; const auto status = error_status;
            lock.unlock();
            Packet(@{@"type": @"failure", @"code": code, @"nativeStatus": @(status)});
            ::close(3);
            return;
          }
          if (queue.empty() && stopping) break;
          frame = std::move(queue.front()); queue.pop_front();
        }
        Packet(@{@"type": @"video", @"id": @(++written), @"timestampUs": @(frame.timestamp_us),
          @"durationUs": @(frame.duration_us), @"keyframe": @(frame.keyframe)}, frame.bytes);
        {
          std::lock_guard lock(mutex);
          --frames; bytes -= frame.bytes.size();
        }
      }
      Packet(@{@"type": @"closed", @"packets": @(written), @"writerDrained": @YES,
        @"retainedFrames": @0, @"retainedBytes": @0});
      ::close(3);
      { std::lock_guard lock(mutex); writer_closed = true; }
    }
  }
};
VideoCaptureHost::VideoCaptureHost(SCContentFilter* filter, EncoderOptions options, bool aspect,
    std::function<void()> verify, VideoEncoder::Failure failure) : state_(std::make_shared<State>()) {
  if (fcntl(3, F_GETFD) == -1) throw std::runtime_error("ERR_MAC_CAPTURE_MEDIA_PIPE");
  const auto owner = state_;
  if (!failure) throw std::runtime_error("ERR_MAC_CAPTURE_FAILURE_OBSERVER");
  owner->notify = std::move(failure);
  const std::weak_ptr<State> weak = owner;
  owner->capture = std::make_unique<VideoCapture>(filter, options, aspect,
    [weak](EncodedFrame packet) {
      if (const auto current = weak.lock()) current->Push(std::move(packet)); else std::terminate();
    },
    [weak](const char* code, OSStatus status) {
      if (const auto current = weak.lock()) current->Fail(code, status); else std::terminate();
    },
    [weak] {
      if (const auto current = weak.lock()) return current->Writable();
      std::terminate();
    }, std::move(verify));
  owner->writer = std::thread([owner] { owner->Run(); });
}
VideoCaptureHost::~VideoCaptureHost() {
  if (state_->writer.joinable()) std::terminate();
}
std::future<void> VideoCaptureHost::Start() {
  std::lock_guard lock(state_->mutex);
  if (state_->closing || !state_->capture) throw VideoError("ERR_MAC_CAPTURE_CLOSING", 0);
  return state_->capture->Start();
}
std::future<void> VideoCaptureHost::SetBitrate(int bitrate) {
  std::lock_guard lock(state_->mutex);
  if (state_->closing || !state_->capture) throw VideoError("ERR_MAC_CAPTURE_CLOSING", 0);
  return state_->capture->SetBitrate(bitrate);
}
std::future<void> VideoCaptureHost::RequestKeyframe() {
  std::lock_guard lock(state_->mutex);
  if (state_->closing || !state_->capture) throw VideoError("ERR_MAC_CAPTURE_CLOSING", 0);
  return state_->capture->RequestKeyframe();
}
std::shared_future<void> VideoCaptureHost::Close() {
  const auto owner = state_;
  std::lock_guard lock(owner->mutex);
  if (owner->close.valid()) return owner->close;
  owner->closing = std::make_shared<std::promise<void>>();
  owner->close = owner->closing->get_future().share();
  std::thread([owner] {
    try {
      std::exception_ptr failure;
      try { owner->capture->Close().get(); } catch (...) { failure = std::current_exception(); }
      if (![owner->capture->Snapshot()[@"nativeClosed"] boolValue]) {
        owner->closing->set_exception(failure ? failure :
          std::make_exception_ptr(std::runtime_error("ERR_MAC_CAPTURE_RETIREMENT")));
        return;
      }
      {
        std::lock_guard lock(owner->mutex);
        owner->stopping = true;
        owner->changed.notify_one();
      }
      owner->writer.join();
      {
        std::lock_guard lock(owner->mutex);
        owner->queue.clear(); owner->frames = 0; owner->bytes = 0;
        owner->owner_closed = true;
      }
      if (!owner->writer_closed) throw std::runtime_error("ERR_MAC_CAPTURE_WRITER_RETIREMENT");
      if (failure) owner->closing->set_exception(failure);
      else owner->closing->set_value();
    } catch (...) { owner->closing->set_exception(std::current_exception()); }
  }).detach();
  return owner->close;
}
NSDictionary* VideoCaptureHost::Snapshot() const {
  std::lock_guard lock(state_->mutex);
  return @{@"writerClosed": @(state_->writer_closed),
    @"nativeClosed": @(state_->owner_closed),
    @"retainedFrames": @(state_->frames), @"retainedBytes": @(state_->bytes),
    @"peakFrames": @(state_->peak_frames), @"peakBytes": @(state_->peak_bytes)};
}
}
