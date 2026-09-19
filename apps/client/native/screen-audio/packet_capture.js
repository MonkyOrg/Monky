'use strict';

// Kept separate so unsupported/missing-addon behavior is testable without loading
// a production addon or performing platform capability discovery.
function createPacketCaptureFactory(binding, platform) {
  return function createPacketCapture(options, onEvent) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || typeof onEvent !== 'function') {
      throw new TypeError('Expected (options, onEvent)');
    }
    if (platform === 'win32' && binding && typeof binding.createPacketCapture === 'function') {
      return binding.createPacketCapture(options, onEvent);
    }
    const error = Object.assign(new Error(platform === 'win32'
      ? 'Timestamped native audio capture module is unavailable'
      : 'Timestamped WASAPI capture is only supported on Windows'), {
      code: platform === 'win32' ? 'ERR_AUDIO_UNAVAILABLE' : 'ERR_AUDIO_UNSUPPORTED',
    });
    const snapshot = Object.freeze({
      sessionId: null, state: 'failed', format: null, capturedPackets: 0,
      capturedFrames: 0, deliveredPackets: 0, queuedPackets: 0, overflowCount: 0,
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
