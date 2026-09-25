#pragma once
#include "engine_shared.h"
#include "mf_h264_decoder.h"
#include "libyuv/convert.h"
#include <mutex>

namespace monky::native_rtc::engine {
class CpuFrameUpload {
 public:
  std::shared_ptr<const screen_video::GpuDecodedFrame> Upload(const webrtc::VideoFrame& input) {
    const auto& buffer = input.video_frame_buffer();
    if (!buffer || buffer->type() != webrtc::VideoFrameBuffer::Type::kI420 ||
        input.width() < 4 || input.width() > 3840 || input.height() < 2 || input.height() > 2160 ||
        (input.width() & 1) || (input.height() & 1))
      throw Error("ERR_RTC_AV1_OUTPUT", "AV1 presentation requires bounded 8-bit I420 frames", MONKY_ENGINE_UNSUPPORTED);
    const auto pixels = buffer->GetI420();
    if (!pixels) throw Error("ERR_RTC_AV1_OUTPUT", "AV1 decoder returned no I420 planes", MONKY_ENGINE_FAILURE);
    const auto width = static_cast<UINT>(input.width()), height = static_cast<UINT>(input.height());
    std::lock_guard lock(mutex_);
    nv12_.resize(static_cast<std::size_t>(width) * height * 3 / 2);
    if (libyuv::I420ToNV12(pixels->DataY(), pixels->StrideY(), pixels->DataU(), pixels->StrideU(),
        pixels->DataV(), pixels->StrideV(), nv12_.data(), width, nv12_.data() + width * height, width,
        width, height) != 0)
      throw Error("ERR_RTC_AV1_OUTPUT", "Cannot convert decoded AV1 planes for presentation", MONKY_ENGINE_FAILURE);
    if (!device_) Initialize();
    Check(device_->GetDeviceRemovedReason(), "AV1 presentation device was removed");
    auto frame = std::make_shared<screen_video::GpuDecodedFrame>();
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width; description.Height = height;
    description.MipLevels = 1; description.ArraySize = 1; description.Format = DXGI_FORMAT_NV12;
    description.SampleDesc.Count = 1; description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA data{nv12_.data(), width, width * height * 3 / 2};
    Check(device_->CreateTexture2D(&description, &data, frame->texture.put()), "Cannot upload decoded AV1 frame");
    Check(context_->Signal(fence_.get(), ++value_), "Cannot fence decoded AV1 upload");
    context_->Flush();
    frame->readyFence = fence_; frame->readyValue = value_;
    frame->codedWidth = width; frame->codedHeight = height; frame->visibleRect = {0, 0, width, height};
    frame->timestampUs = input.timestamp_us();
    return frame;
  }
 private:
  static void Check(HRESULT result, const char* message) {
    if (FAILED(result)) throw Error("ERR_RTC_AV1_PRESENTATION", message, MONKY_ENGINE_FAILURE);
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
  std::mutex mutex_;
  std::vector<std::uint8_t> nv12_;
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext4> context_;
  winrt::com_ptr<ID3D11Fence> fence_;
  std::uint64_t value_ = 0;
};
}
