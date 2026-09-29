'use strict';

// Kept separate so unsupported/missing-addon behavior is testable without loading
// a production addon or performing platform capability discovery.
function createPacketCaptureFactory(binding, platform) {
  return function createPacketCapture(options, onEvent) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || typeof onEvent !== 'function') {
      throw new TypeError('Expected (options, onEvent)');
    }
    if (options.overflowMode !== undefined && !['fail', 'discontinue'].includes(options.overflowMode)) {
      throw new TypeError('overflowMode must be fail or discontinue');
    }
    const supportedPlatform = platform === 'win32' || platform === 'darwin';
    if (supportedPlatform && binding && typeof binding.createPacketCapture === 'function') {
      return binding.createPacketCapture(options, onEvent);
    }
    const error = Object.assign(new Error(supportedPlatform
      ? 'Timestamped native audio capture module is unavailable'
      : 'Timestamped native audio capture requires Windows or macOS'), {
      code: supportedPlatform ? 'ERR_AUDIO_UNAVAILABLE' : 'ERR_AUDIO_UNSUPPORTED',
    });
    const snapshot = Object.freeze({
      sessionId: null, state: 'failed', format: null, capturedPackets: 0,
      capturedFrames: 0, deliveredPackets: 0, queuedPackets: 0, overflowCount: 0,
      overflowMode: options.overflowMode ?? 'fail', droppedPackets: 0, droppedFrames: 0,
      maxQueuedPackets: 32, maxPacketBytes: 1048576, error,
    });
    const ready = Promise.reject(error);
    const closed = Promise.resolve(snapshot);
    queueMicrotask(() => {
      // A consumer callback must not prevent the terminal lifecycle event.
      try { onEvent({ type: 'error', error }); } catch {}
      try { onEvent({ type: 'closed', snapshot }); } catch {}
    });
    return Object.freeze({
      ready, closed, stop: () => closed, snapshot: () => snapshot, getStats: () => snapshot,
    });
  };
}

module.exports = { createPacketCaptureFactory };
