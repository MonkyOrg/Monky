#pragma once
#include "engine_shared.h"
#include "mf_h264_decoder.h"
#include "decoder_diagnostics.h"
#include "receive_frame_policy.h"
#include "libyuv/convert.h"
#include <mutex>

namespace monky::native_rtc::engine {
class CpuFrameUpload {
 public:
  std::shared_ptr<const screen_video::GpuDecodedFrame> Upload(const webrtc::VideoFrame& input) {
    const auto& buffer = input.video_frame_buffer();
    const auto size = CpuUploadSize(input.width(), input.height());
    if (!buffer || buffer->type() != webrtc::VideoFrameBuffer::Type::kI420 || !size)
      throw Error("ERR_RTC_AV1_OUTPUT", "AV1 presentation requires bounded 8-bit I420 frames", MONKY_ENGINE_UNSUPPORTED);
    const auto pixels = buffer->GetI420();
    if (!pixels) throw Error("ERR_RTC_AV1_OUTPUT", "AV1 decoder returned no I420 planes", MONKY_ENGINE_FAILURE);
    const auto width = static_cast<UINT>(size->width), height = static_cast<UINT>(size->height);
    std::lock_guard lock(mutex_);
    if (!device_) Initialize();
    Check(device_->GetDeviceRemovedReason(), "AV1 presentation device was removed");
    const auto begin = Clock::now();
    const screen_video::SurfaceSize layout{width, height};
    auto surface = surfaces_->Take(layout);
    if (!surface) surface = Allocate(width, height);
    // A WRITE map waits for a copy that still reads this staging texture.
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Check(context_->Map(surface->staging.get(), 0, D3D11_MAP_WRITE, 0, &mapped), "Cannot map the AV1 upload surface");
    // Mapped NV12 puts the UV plane right after RowPitch * Height bytes, as ReadI420 reads it.
    auto* const luma = static_cast<std::uint8_t*>(mapped.pData);
    const auto pitch = static_cast<int>(mapped.RowPitch);
    const bool converted = luma && mapped.RowPitch >= width &&
        libyuv::I420ToNV12(pixels->DataY(), pixels->StrideY(), pixels->DataU(), pixels->StrideU(),
            pixels->DataV(), pixels->StrideV(), luma, pitch,
            luma + static_cast<std::size_t>(mapped.RowPitch) * height, pitch, width, height) == 0;
    context_->Unmap(surface->staging.get(), 0);
    if (!converted)
      throw Error("ERR_RTC_AV1_OUTPUT", "Cannot convert decoded AV1 planes for presentation", MONKY_ENGINE_FAILURE);
    context_->CopyResource(surface->texture.get(), surface->staging.get());
    Check(context_->Signal(fence_.get(), ++value_), "Cannot fence decoded AV1 upload");
    context_->Flush();
    auto frame = screen_video::RecycledFrame(surfaces_, std::move(*surface), layout);
    frame->readyFence = fence_; frame->readyValue = value_;
    frame->codedWidth = width; frame->codedHeight = height; frame->visibleRect = {0, 0, width, height};
    frame->timestampUs = input.timestamp_us();
    upload_.Observe(begin, Clock::now());
    return frame;
  }

  // Surfaces kept for streams that ended would otherwise stay until the engine closes.
  void Clear() noexcept { surfaces_->Clear(); }

  // The CPU cost of presenting software-decoded frames, beside the MF decoder's copyOutput.
  Json Snapshot() const {
    std::lock_guard lock(mutex_);
    return {{"uploads", upload_.count}, {"surfaceAllocations", allocations_},
            {"keptSurfaces", surfaces_->Kept()}, {"upload", TimingSnapshot(upload_)}};
  }
 private:
  using Clock = screen_video::TimingAggregate::Clock;
  // An AV1 stream keeps one or two frames alive at a time, so four kept
  // surfaces cover two streams of the same size without retaining more.
  static constexpr std::size_t kKeptSurfaces = 4;

  static void Check(HRESULT result, const char* message) {
    if (FAILED(result)) throw Error("ERR_RTC_AV1_PRESENTATION", message, MONKY_ENGINE_FAILURE);
  }
  screen_video::DecodedSurface Allocate(UINT width, UINT height) {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width; description.Height = height;
    description.MipLevels = 1; description.ArraySize = 1; description.Format = DXGI_FORMAT_NV12;
    description.SampleDesc.Count = 1; description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    screen_video::DecodedSurface surface;
    Check(device_->CreateTexture2D(&description, nullptr, surface.texture.put()),
          "Cannot allocate an AV1 presentation surface");
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    Check(device_->CreateTexture2D(&description, nullptr, surface.staging.put()), "Cannot allocate an AV1 upload surface");
    ++allocations_;
    return surface;
  }
  void Initialize() {
    winrt::com_ptr<ID3D11Device> device;
    winrt::com_ptr<ID3D11DeviceContext> context;
    const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    Check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels, 2, D3D11_SDK_VERSION, device.put(), nullptr, context.put()), "Cannot create AV1 presentation device");
    auto device5 = device.try_as<ID3D11Device5>();
    auto context4 = context.try_as<ID3D11DeviceContext4>();
    auto protection = context.try_as<ID3D11Multithread>();
    if (!device5 || !context4 || !protection)
      throw Error("ERR_RTC_AV1_PRESENTATION", "D3D11 fence support is unavailable", MONKY_ENGINE_UNSUPPORTED);
    protection->SetMultithreadProtected(TRUE);
    winrt::com_ptr<ID3D11Fence> fence;
    Check(device5->CreateFence(0, D3D11_FENCE_FLAG_NONE, __uuidof(ID3D11Fence), fence.put_void()),
          "Cannot create AV1 presentation fence");
    device_ = std::move(device); context_ = std::move(context4); fence_ = std::move(fence);
  }
  mutable std::mutex mutex_;
  std::shared_ptr<screen_video::DecodedSurfaces> surfaces_ =
      std::make_shared<screen_video::DecodedSurfaces>(kKeptSurfaces);
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext4> context_;
  winrt::com_ptr<ID3D11Fence> fence_;
  std::uint64_t value_ = 0, allocations_ = 0;
  screen_video::TimingAggregate upload_;
};
}
