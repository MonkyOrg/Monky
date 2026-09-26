'use strict';

const { loadRuntime, loadCaptureRuntime, loadThumbnailRuntime } = require('./runtime/runtimeFiles.cjs');
const { NativeThumbnailCapturer } = require('./runtime/nativeThumbnail.cjs');
const { NativeScreenEndpoint } = require('./runtime/nativeEndpoint.cjs');
const { NativeScreenPublisher } = require('./runtime/nativeScreenPublisher.cjs');
const { NativeScreenSubscription } = require('./runtime/nativeScreenSubscription.cjs');
const { createNativeScreenPresentation } = require('./runtime/nativePresentationRenderer.cjs');
const { NativePcmCaptureHub } = require('./runtime/nativePcmCaptureHub.cjs');
const { registerNativeAudioPortReceiver } = require('./runtime/nativeAudioPortRenderer.cjs');
const { NativeScreenPreviewBridge } = require('./runtime/nativeScreenPreviewBridge.cjs');
const { CaptureBridge, probeCaptureCapabilities } = require('./runtime/captureBridge.cjs');
const { validateSource: validateCaptureTarget } = require('./runtime/captureProtocol.cjs');

module.exports = {
  loadRuntime, NativeScreenEndpoint, NativeScreenPublisher, NativeScreenSubscription,
  createNativeScreenPresentation, NativePcmCaptureHub, registerNativeAudioPortReceiver, NativeScreenPreviewBridge,
  CaptureBridge, validateCaptureTarget, loadCaptureRuntime, probeCaptureCapabilities,
  loadThumbnailRuntime, NativeThumbnailCapturer,
};
