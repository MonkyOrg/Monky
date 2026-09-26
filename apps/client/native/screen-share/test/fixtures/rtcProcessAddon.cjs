'use strict';

const assert = require('node:assert/strict');
const capabilities = () => ({ fixture: 'owned-rtc-process' });
function createEngine(options, emit) {
  if (options.stallExit) process.exit = () => {};
  let copied = 0;
  const started = Number(process.hrtime.bigint() / 1000n);
  const timers = new Set();
  return {
    ready: Promise.resolve(),
    request(id, operation, target, data) {
      if (operation === 'hang') return new Promise(() => {});
      if (operation === 'crash') { process.abort(); return; }
      if (operation === 'exit') { process.exit(37); return; }
      if (operation === 'reject') throw Object.assign(new Error('Fixture rejection'), { code: 'ERR_FIXTURE', status: 6 });
      if (operation === 'playout') emit({ type: 'audio.playout', target: 0, data: {
        epoch: 1, sequence: 0, firstPlayoutFrame: 0, frames: 480, sampleRate: 48000, channels: 2,
        samples: new Float32Array(960).fill(.125),
      } });
      return Promise.resolve({ id, operation, target, data, pid: process.pid });
    },
    cancel() { throw Object.assign(new Error('Already completed'), { code: 'ERR_RTC_UNKNOWN_REQUEST', status: 4 }); },
    releaseFrame(frameId) { return Promise.resolve({ frameId: options.badRelease ? frameId + 1 : frameId, ok: true }); },
    submitEncodedFrame(sourceId, frame) {
      assert.ok(Buffer.isBuffer(frame.data));
      copied++;
      const timer = setTimeout(() => {
        timers.delete(timer);
        emit({ type: 'source.encodedFrameReleased', target: sourceId,
          data: { sourceId, frameId: frame.frameId, nativeCopyRetired: true, networkDeliveryConfirmed: false } });
      }, 20);
      timers.add(timer);
      return { sourceId, frameId: frame.frameId, copied: true, networkDeliveryConfirmed: false };
    },
    submitAudioPacket(sourceId, packet) {
      assert.ok(Buffer.isBuffer(packet.pcm));
      if (packet.epoch === 'pending') return new Promise(() => {});
      return Promise.resolve({ sourceId, epoch: packet.epoch, sequence: packet.sequence,
        frameIndex: packet.frameIndex, frames: packet.frames, ok: true });
    },
    audioClockProbe() { throw new Error('No synthetic clock observations are permitted.'); },
    snapshot: () => ({ fixture: true, copied, pid: process.pid, ...(options.hangNative ? {
      mf: { decoders: [{ sessionId: 1, diagnostics: {
        clock: 'process-steady-clock', observedAtSteadyUs: Number(process.hrtime.bigint() / 1000n),
        operations: { 'core-pump': { inProgress: 1, lastStartSteadyUs: started } },
      } }] },
    } : {}) }),
    close() {
      for (const timer of timers) clearTimeout(timer);
      return Promise.resolve({ fixture: true, closed: true });
    },
  };
}
module.exports = { capabilities, createEngine };
