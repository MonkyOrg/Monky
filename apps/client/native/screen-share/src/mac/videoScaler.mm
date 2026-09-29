#include "videoScaler.h"
#import <CoreImage/CoreImage.h>
#import <Metal/Metal.h>
#include <algorithm>
#include <cmath>

namespace monky::screen::mac {
struct VideoScaler::State {
  int width, height;
  bool preserve;
  CIContext* context = nil;
  CVPixelBufferPoolRef pool = nullptr;
  CGColorSpaceRef color = nullptr;
  State(int w, int h, bool aspect) : width(w), height(h), preserve(aspect) {}
  ~State() {
    if (pool) CVPixelBufferPoolRelease(pool);
    if (color) CGColorSpaceRelease(color);
  }
  void Prepare() {
    if (context) return;
    const auto device = MTLCreateSystemDefaultDevice();
    if (!device) throw VideoError("ERR_MAC_VIDEO_METAL_UNAVAILABLE", 0);
    color = CGColorSpaceCreateWithName(kCGColorSpaceITUR_709);
    if (!color) throw VideoError("ERR_MAC_VIDEO_SCALE_COLOR", 0);
    NSDictionary* attributes = @{
      (__bridge NSString*)kCVPixelBufferWidthKey: @(width),
      (__bridge NSString*)kCVPixelBufferHeightKey: @(height),
      (__bridge NSString*)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
      (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey: @YES,
      (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey: @{},
    };
    const auto status = CVPixelBufferPoolCreate(kCFAllocatorDefault, nullptr,
      (__bridge CFDictionaryRef)attributes, &pool);
    if (status != kCVReturnSuccess) throw VideoError("ERR_MAC_VIDEO_SCALE_POOL", status);
    context = [CIContext contextWithMTLDevice:device options:@{
      kCIContextUseSoftwareRenderer: @NO, kCIContextCacheIntermediates: @NO,
      kCIContextWorkingColorSpace: (__bridge id)color,
      kCIContextOutputColorSpace: (__bridge id)color,
    }];
    if (!context) throw VideoError("ERR_MAC_VIDEO_SCALE_CONTEXT", 0);
  }
};
VideoScaler::VideoScaler(int width, int height, bool preserve_aspect_ratio)
    : state_(std::make_unique<State>(width, height, preserve_aspect_ratio)) {}
VideoScaler::~VideoScaler() = default;
CVPixelBufferRef VideoScaler::Render(CVPixelBufferRef input, CGRect content) {
  auto& self = *state_;
  const auto input_width = CVPixelBufferGetWidth(input), input_height = CVPixelBufferGetHeight(input);
  if (!std::isfinite(content.origin.x) || !std::isfinite(content.origin.y) ||
      !std::isfinite(content.size.width) || !std::isfinite(content.size.height) ||
      content.origin.x < 0 || content.origin.y < 0 || content.size.width < 1 || content.size.height < 1 ||
      CGRectGetMaxX(content) > input_width || CGRectGetMaxY(content) > input_height)
    throw VideoError("ERR_MAC_VIDEO_CONTENT_RECT", 0);
  if (content.origin.x == 0 && content.origin.y == 0 &&
      content.size.width == self.width && content.size.height == self.height &&
      input_width == static_cast<size_t>(self.width) && input_height == static_cast<size_t>(self.height))
    return CVPixelBufferRetain(input);
  self.Prepare();
  CVPixelBufferRef output = nullptr;
  const auto status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, self.pool,
    (__bridge CFDictionaryRef)@{(__bridge NSString*)kCVPixelBufferPoolAllocationThresholdKey: @16}, &output);
  if (status != kCVReturnSuccess) throw VideoError("ERR_MAC_VIDEO_SCALE_BUFFER", status);
  try {
    CVBufferSetAttachment(output, kCVImageBufferColorPrimariesKey,
      kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(output, kCVImageBufferTransferFunctionKey,
      kCVImageBufferTransferFunction_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(output, kCVImageBufferYCbCrMatrixKey,
      kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    // SCK rectangles are top-left; Core Image operates in bottom-left pixel coordinates.
    const auto crop = CGRectMake(content.origin.x, input_height - CGRectGetMaxY(content),
      content.size.width, content.size.height);
    CIImage* image = [[CIImage imageWithCVPixelBuffer:input] imageByCroppingToRect:crop];
    image = [image imageByApplyingTransform:CGAffineTransformMakeTranslation(-crop.origin.x, -crop.origin.y)];
    double sx = self.width / content.size.width, sy = self.height / content.size.height;
    if (self.preserve) sx = sy = std::min(sx, sy);
    image = [image imageByApplyingTransform:CGAffineTransformMakeScale(sx, sy)];
    image = [image imageByApplyingTransform:CGAffineTransformMakeTranslation(
      (self.width - content.size.width * sx) / 2, (self.height - content.size.height * sy) / 2)];
    const auto bounds = CGRectMake(0, 0, self.width, self.height);
    CIImage* background = [[CIImage imageWithColor:CIColor.blackColor] imageByCroppingToRect:bounds];
    CIRenderDestination* destination = [[CIRenderDestination alloc] initWithPixelBuffer:output];
    destination.colorSpace = self.color;
    NSError* error = nil;
    CIRenderTask* task = [self.context startTaskToRender:[image imageByCompositingOverImage:background]
      fromRect:bounds toDestination:destination atPoint:CGPointZero error:&error];
    if (!task || error) throw VideoError("ERR_MAC_VIDEO_SCALE_SUBMIT", static_cast<OSStatus>(error.code));
    if (![task waitUntilCompletedAndReturnError:&error] || error)
      throw VideoError("ERR_MAC_VIDEO_SCALE_COMPLETE", static_cast<OSStatus>(error.code));
    return output;
  } catch (...) {
    CVPixelBufferRelease(output);
    throw;
  }
}
}
