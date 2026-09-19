'use strict';

const { isPresentationId } = require('./presentationRoute.cjs');

function registerTextureReceiver(sharedTexture, { getSink, onError }) {
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
    let frame;
    try {
      const minimumTimestamp = metadata?.presentationId === undefined ? 0 : -1;
      if (!Number.isSafeInteger(metadata?.timestampUs) || metadata.timestampUs < minimumTimestamp
        || !Number.isSafeInteger(metadata?.frameId) || metadata.frameId <= 0
        || (metadata.presentationId !== undefined && !isPresentationId(metadata.presentationId))) {
        throw new Error('Invalid native frame metadata.');
      }
      const sink = getSink(metadata);
      if (!sink) return;
      frame = importedSharedTexture.getVideoFrame();
      await sink.acceptFrame(frame, metadata.timestampUs, metadata);
    } catch (error) {
      onError(error);
    } finally {
      frame?.close();
      importedSharedTexture.release();
    }
  });
}

module.exports = { registerTextureReceiver };
