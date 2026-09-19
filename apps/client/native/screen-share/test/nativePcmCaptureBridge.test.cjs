'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativePcmCaptureBridge } = require('../runtime/nativePcmCaptureBridge.cjs');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const format = {
  encoding: 'float32-interleaved', sampleRate: 44100, channels: 2, channelMask: 3,
  sourceBitsPerSample: 32, sourceValidBitsPerSample: 32,
};

function fixture({ autoReady = true, holdInputs = false, createSource, timeoutMs = 50 } = {}) {
  const commandsSeen = [], submissions = [], errors = [], nativeSources = new Set(), nativeEpochs = new Map();
  const ready = defer(), closed = defer();
  let callback, captureCalls = 0, captureStops = 0, nextSequence = 0, nextFrame = 0;
  let captured = false;
  const snapshot = () => ({ sessionId: 'capture-session', state: captured ? 'capturing' : 'closed', format });
  const receipt = (sourceId, packet) => ({
    sourceId, epoch: packet.epoch, sequence: packet.sequence,
    frameIndex: packet.frameIndex, frames: packet.frames, ok: true,
  });
  const engine = {
    ready: Promise.resolve(), closed: false,
    async request(_id, operation, target, data) {
      commandsSeen.push({ operation, target, data });
      if (operation === 'source.createAudio') {
        const result = createSource ? await createSource(data) : { sourceId: 11, kind: 'audio' };
        nativeSources.add(result.sourceId);
        return result;
      }
      if (operation === 'source.setEnabled') {
        assert.ok(!data.enabled || nativeEpochs.has(target), 'A native source must have its actual epoch before activation.');
        return { enabled: data.enabled };
      }
      if (operation === 'source.beginAudioEpoch') {
        nativeEpochs.set(target, data.epoch);
        return { sourceId: target, epoch: data.epoch };
      }
      if (operation === 'resource.close') { nativeSources.delete(target); return {}; }
      assert.fail(`Unexpected PCM command ${operation}`);
    },
    submitAudioPacket(sourceId, packet) {
      assert.equal(nativeEpochs.get(sourceId), packet.epoch);
      const pending = defer(), identity = receipt(sourceId, packet);
      submissions.push({ sourceId, packet, identity, pending });
      if (!holdInputs) pending.resolve(identity);
      return pending.promise;
    },
    async close() {
      this.closed = true;
      nativeSources.clear();
      for (const item of submissions) item.pending.resolve(item.identity);
      return { closed: true };
    },
  };
  const commands = new NativeRtcCommands(engine);
  const emitReady = () => {
    captured = true;
    callback({ type: 'ready', sessionId: 'capture-session', format });
    ready.resolve(snapshot());
  };
  const capture = {
    ready: ready.promise, closed: closed.promise, getStats: snapshot,
    async stop() {
      captureStops++;
      captured = false;
      ready.reject(new DOMException('Capture stopped', 'AbortError'));
      callback({ type: 'closed', snapshot: snapshot() });
      closed.resolve(snapshot());
      return closed.promise;
    },
  };
  const captureModule = {
    createPacketCapture(_options, onEvent) {
      captureCalls++;
      callback = onEvent;
      if (autoReady) emitReady();
      return capture;
    },
  };
  const bridge = new NativePcmCaptureBridge(engine, commands, captureModule, error => errors.push(error), { timeoutMs });
  return {
    bridge, engine, commands, capture, captureModule, submissions, commandsSeen, errors, nativeSources,
    captureCalls: () => captureCalls, captureStops: () => captureStops,
    emitReady, emit: event => callback(event),
    async packet(overrides = {}) {
      const frames = overrides.frames ?? 441;
      const packet = {
        type: 'packet', sessionId: 'capture-session', format, epoch: 'capture-session:1',
        pcm: Buffer.alloc(frames * (overrides.format?.channels ?? format.channels) * 4), frames,
        sequence: nextSequence++, frameIndex: nextFrame,
        devicePosition: nextFrame, qpcTimestampUs: 8000000 + Math.round(nextFrame * 1000000 / format.sampleRate),
        flags: { raw: 0, silent: false, dataDiscontinuity: false, timestampError: false },
        ...overrides,
      };
      nextFrame += frames;
      callback(packet);
      await tick();
      return packet;
    },
    async activate(overrides = {}) {
      const enabled = bridge.enable();
      const original = await this.packet(overrides);
      await enabled;
      return original;
    },
    start: signal => bridge.start({ includeWindowId: 100 }, 'screen-group', signal),
    retire(index, overrides = {}) {
      const item = submissions[index];
      item.pending.resolve({ ...item.identity, ...overrides });
    },
    reject(index, additions = {}) {
      const item = submissions[index];
      const error = Object.assign(new Error('Native PCM processing failed'), item.identity, {
        ok: false, nativeOwnershipRetained: false, processingPending: false, ...additions,
      });
      item.pending.reject(error);
      return error;
    },
  };
}

test('PCM bridge construction is inert and accepts only matching command/engine ownership', () => {
  const f = fixture();
  assert.equal(f.captureCalls(), 0);
  assert.equal(f.commandsSeen.length, 0);
  assert.throws(() => new NativePcmCaptureBridge(f.engine, new NativeRtcCommands({ request() {} }),
    f.captureModule, () => {}), /requires its engine/u);
});

test('a replaceable instance verifier cannot retire an outstanding PCM processing identity', async t => {
  const f = fixture({ holdInputs: true });
  await f.start();
  await f.activate();
  t.after(async () => { await f.bridge.finishAfterEngineClose(f.commands.closeEngine()); });
  f.commands.assertEngineClosed = () => {};
  await assert.rejects(f.bridge.finishAfterEngineClose(Promise.resolve({ closed: true })), /has not been proven/u);
  assert.equal(f.bridge.getStats().engineRetired, false);
  assert.equal(f.bridge.getStats().outstanding, 1);
  assert.equal(f.nativeSources.size, 1);
});

test('a shadowed public engine getter cannot admit a foreign registry into PCM capture', () => {
  const f = fixture(), foreign = new NativeRtcCommands({ request: async () => ({}) });
  Object.defineProperty(foreign, 'engine', { value: f.engine });
  assert.throws(() => new NativePcmCaptureBridge(f.engine, foreign, f.captureModule, () => {}),
    /requires its engine/u);
  assert.equal(f.captureCalls(), 0);
});

test('the source starts disabled and its first forwarded packet keeps the actual capture indices', async () => {
  const f = fixture();
  const info = await f.start();
  assert.equal(info.kind, 'audio');
  assert.equal(f.bridge.getStats().enabled, false);
  assert.equal(Object.hasOwn(f.commandsSeen[0].data.format, 'encoding'), false);
  await f.packet();
  assert.equal(f.submissions.length, 0);
  const original = await f.activate();
  const epoch = f.commandsSeen.find(command => command.operation === 'source.beginAudioEpoch');
  assert.equal(epoch.data.firstSequence, original.sequence);
  assert.equal(epoch.data.firstFrameIndex, original.frameIndex);
  assert.equal(epoch.data.epoch, original.epoch);
  assert.ok(f.commandsSeen.indexOf(epoch)
    < f.commandsSeen.findIndex(command => command.operation === 'source.setEnabled'));
  assert.equal(f.submissions[0].packet, original);
  assert.equal(f.submissions[0].packet.format.sampleRate, 44100);
  assert.equal(f.submissions[0].packet.qpcTimestampUs, original.qpcTimestampUs);
  assert.equal(f.bridge.getStats().dropped, 1);
  await f.bridge.stop();
  assert.equal(f.nativeSources.size, 0);
});

test('consecutive packets share one native resampler epoch instead of resetting it per packet', async () => {
  const f = fixture();
  await f.start();
  await f.activate();
  await f.packet();
  await f.packet();
  assert.equal(f.commandsSeen.filter(command => command.operation === 'source.beginAudioEpoch').length, 1);
  assert.equal(f.bridge.getStats().retired, 3);
  const stats = f.bridge.getStats();
  assert.equal(stats.previousPacket.sequence, 1);
  assert.equal(stats.lastPacket.sequence, 2);
  assert.equal(stats.lastPacket.devicePosition - stats.previousPacket.devicePosition, stats.previousPacket.frames);
  stats.lastPacket.sequence = 99;
  assert.equal(f.bridge.getStats().lastPacket.sequence, 2);
  await f.bridge.stop();
});

test('activation stays pending until an original packet initializes the native source, with no invented PCM or epoch', async () => {
  const f = fixture();
  await f.start();
  let settled = false;
  const activating = f.bridge.enable().then(result => { settled = true; return result; });
  await tick();
  assert.equal(settled, false);
  assert.equal(f.bridge.getStats().enabled, false);
  assert.equal(f.bridge.getStats().epoch, null);
  assert.equal(f.commandsSeen.some(command => command.operation === 'source.setEnabled'), false);
  assert.equal(f.submissions.length, 0);
  await f.packet({ sequence: 22, frameIndex: 8192, devicePosition: 8192 });
  assert.equal(await activating, true);
  assert.equal(f.bridge.getStats().enabled, true);
  assert.equal(f.submissions[0].packet.sequence, 22);
  assert.equal(f.submissions[0].packet.frameIndex, 8192);
  await f.bridge.stop();
});

test('production arming does not fabricate PCM or fail a healthy but silent source', async () => {
  const f = fixture({ timeoutMs: 10 });
  await f.start();
  f.bridge.arm();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.bridge.getStats().armed, true);
  assert.equal(f.bridge.getStats().enabled, false);
  assert.equal(f.bridge.getStats().epoch, null);
  assert.equal(f.submissions.length, 0);
  assert.deepEqual(f.errors, []);
  await f.packet();
  assert.equal(f.bridge.getStats().enabled, true);
  assert.equal(f.submissions.length, 1);
  await f.bridge.stop();
});

test('Stop cancels activation waiting for original PCM without a guessed epoch or source-enable request', async () => {
  const f = fixture();
  await f.start();
  const rejected = assert.rejects(f.bridge.enable(), { name: 'AbortError' });
  await f.bridge.stop();
  await rejected;
  assert.equal(f.commandsSeen.some(command => command.operation === 'source.beginAudioEpoch'
    || command.operation === 'source.setEnabled'), false);
  assert.equal(f.nativeSources.size, 0);
  assert.deepEqual(f.errors, []);
});

test('a late native activation acknowledgement cannot publish the first queued packet after Stop', async () => {
  const f = fixture(), enabled = defer(), originalRequest = f.engine.request.bind(f.engine);
  f.engine.request = async (id, operation, target, data) => {
    const result = await originalRequest(id, operation, target, data);
    if (operation === 'source.setEnabled') return enabled.promise;
    return result;
  };
  await f.start();
  const cancelled = assert.rejects(f.bridge.enable(), { name: 'AbortError' });
  await f.packet();
  assert.equal(f.bridge.getStats().queued, 1);
  const stopping = f.bridge.stop();
  await tick();
  enabled.resolve({ enabled: true });
  await cancelled;
  const stopped = await stopping;
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.outstanding, 0);
  assert.equal(stopped.dropped, 1);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.nativeSources.size, 0);
  assert.deepEqual(f.errors, []);
});

test('missing initial PCM has an explicit bounded activation failure, not a successful-looking ready source', async () => {
  const f = fixture({ timeoutMs: 25 });
  await f.start();
  await assert.rejects(f.bridge.enable(), /first actual capture epoch/u);
  assert.equal(f.bridge.getStats().enabled, false);
  assert.equal(f.errors.length, 1);
  await f.bridge.stop();
});

test('silence and timestamp errors preserve original flags and never acquire synthetic clock anchors', async () => {
  const f = fixture();
  await f.start();
  await f.activate({ flags: { raw: 2, silent: true, dataDiscontinuity: false, timestampError: false } });
  await f.packet({
    epoch: 'capture-session:2', qpcTimestampUs: null, devicePosition: null,
    flags: { raw: 4, silent: false, dataDiscontinuity: false, timestampError: true },
  });
  assert.equal(f.submissions[0].packet.flags.silent, true);
  assert.ok(f.submissions[0].packet.pcm.every(value => value === 0));
  assert.equal(f.submissions[1].packet.qpcTimestampUs, null);
  assert.equal(f.submissions[1].packet.devicePosition, null);
  assert.equal(f.submissions[1].packet.flags.raw, 4);
  assert.equal(Object.hasOwn(f.submissions[1].packet, 'ntpTimeMs'), false);
  await f.bridge.stop();
});

test('a new real capture epoch waits for the preceding native processing receipt', async () => {
  const f = fixture({ holdInputs: true });
  await f.start();
  await f.activate();
  await f.packet({ epoch: 'capture-session:2', flags: { raw: 1, silent: false, dataDiscontinuity: true, timestampError: false } });
  assert.equal(f.submissions.length, 1);
  assert.equal(f.commandsSeen.filter(command => command.operation === 'source.beginAudioEpoch').length, 1);
  f.retire(0);
  await tick();
  assert.equal(f.submissions.length, 2);
  assert.equal(f.commandsSeen.filter(command => command.operation === 'source.beginAudioEpoch').length, 2);
  f.retire(1);
  await f.bridge.stop();
});

test('duplicate capture sequence does not replace the original pending processing record', async () => {
  const f = fixture({ holdInputs: true });
  await f.start();
  const first = await f.activate();
  await f.packet({ sequence: first.sequence, frameIndex: first.frameIndex });
  assert.equal(f.submissions.length, 1);
  assert.equal(f.bridge.getStats().outstanding, 1);
  assert.match(f.errors[0].message, /Duplicate or reordered/u);
  assert.equal(f.captureStops(), 1);
  f.retire(0);
  await f.bridge.stop();
});

test('correlated rejection retires processing without pretending the packet was delivered', async () => {
  const f = fixture({ holdInputs: true });
  await f.start();
  await f.activate();
  const error = f.reject(0);
  await tick();
  assert.equal(f.bridge.getStats().outstanding, 0);
  assert.equal(f.errors[0], error);
  await f.bridge.stop();
});

test('processingPending=true is not retirement even though the JS buffer was copied synchronously', async () => {
  const f = fixture({ holdInputs: true });
  await f.start();
  await f.activate();
  f.reject(0, { processingPending: true });
  await tick();
  assert.equal(f.bridge.getStats().outstanding, 1);
  assert.ok([...f.bridge.packets.values()].every(record => record.packet === null));
  await assert.rejects(f.bridge.stop(), /processing retirement remains unproven/u);
  await f.bridge.finishAfterEngineClose(f.commands.closeEngine());
  assert.equal(f.bridge.getStats().outstanding, 0);
});

test('a wrong retirement identity remains owned through source-close ACK and a forged full-close Promise', async () => {
  const f = fixture({ holdInputs: true });
  await f.start();
  await f.activate();
  f.retire(0, { sourceId: 99 });
  await tick();
  assert.equal(f.bridge.getStats().outstanding, 1);
  await assert.rejects(f.bridge.stop(), /processing retirement remains unproven/u);
  assert.equal(f.nativeSources.size, 0, 'Source close does not prove a lost per-packet receipt');
  await assert.rejects(f.bridge.finishAfterEngineClose(Promise.resolve({ closed: true })), /not been proven/u);
  assert.equal(f.bridge.getStats().outstanding, 1);
  await f.bridge.finishAfterEngineClose(f.commands.closeEngine());
  assert.equal(f.bridge.getStats().outstanding, 0);
});

test('eight-packet pressure is bounded and stops capture without discarding existing native obligations', async () => {
  const f = fixture({ holdInputs: true });
  await f.start();
  await f.activate();
  for (let index = 1; index < 9; index++) await f.packet();
  assert.equal(f.submissions.length, 8);
  assert.equal(f.bridge.getStats().maximumOutstanding, 8);
  assert.equal(f.bridge.getStats().outstanding, 8);
  assert.match(f.errors[0].message, /eight-packet bound/u);
  assert.equal(f.captureStops(), 1);
  for (let index = 0; index < 8; index++) f.retire(index);
  await f.bridge.stop();
});

test('aborting startup preserves the caller reason and cannot create a source from late capture readiness', async () => {
  const f = fixture({ autoReady: false });
  const controller = new AbortController(), reason = new Error('Caller stopped the selected screen');
  const started = f.start(controller.signal);
  controller.abort(reason);
  await assert.rejects(started, error => error === reason);
  f.emitReady();
  await tick();
  assert.equal(f.commandsSeen.length, 0);
  assert.equal(f.captureStops(), 1);
});

test('a late-created audio source after cancellation is closed by its original owner', async () => {
  const source = defer();
  const f = fixture({ createSource: () => source.promise });
  const controller = new AbortController();
  const started = f.start(controller.signal);
  const rejected = assert.rejects(started, { name: 'AbortError' });
  await tick();
  controller.abort();
  source.resolve({ sourceId: 77, kind: 'audio' });
  await rejected;
  assert.ok(f.commandsSeen.some(command => command.operation === 'resource.close' && command.target === 77));
  assert.equal(f.nativeSources.size, 0);
});

test('an unsupported captured format remains the original startup error, not a generic cancellation', async () => {
  const original = Object.assign(new Error('Native RTC does not support this channel layout'), { code: 'ERR_AUDIO_FORMAT' });
  const f = fixture({ createSource: () => Promise.reject(original) });
  await assert.rejects(f.start(), error => error === original);
  assert.equal(f.captureStops(), 1);
  assert.equal(f.nativeSources.size, 0);
});

test('invalid PCM selection is rejected before capture, without a system-wide fallback', async () => {
  const f = fixture();
  for (const options of [{ includeWindowId: 0 }, { excludePid: process.pid + 1 }, { sampleRate: 48000 }]) {
    await assert.rejects(f.bridge.start(options, 'screen-group'), /Invalid native PCM capture selection/u);
  }
  assert.equal(f.captureCalls(), 0);
});

test('foreign session, shared buffers and invented timestamps fail before native submission', async () => {
  for (const overrides of [
    { sessionId: 'another-capture' },
    { pcm: Buffer.from(new SharedArrayBuffer(441 * 2 * 4)) },
    { qpcTimestampUs: 123, flags: { raw: 4, silent: false, dataDiscontinuity: false, timestampError: true } },
  ]) {
    const f = fixture();
    await f.start();
    const rejected = assert.rejects(f.bridge.enable(), /Invalid original PCM/u);
    await f.packet(overrides);
    await rejected;
    assert.equal(f.submissions.length, 0);
    assert.match(f.errors[0].message, /Invalid original PCM/u);
    await f.bridge.stop();
  }
});

test('stopped capture is one-shot; publication mute/watch must not invent another capture epoch', async () => {
  const f = fixture();
  await f.start();
  await f.activate();
  await f.bridge.stop();
  await assert.rejects(f.bridge.enable(), /unavailable/u);
  await assert.rejects(f.start(), /cannot be reused/u);
  assert.equal(f.captureCalls(), 1);
});

test('owned source close may cancel an epoch operation without treating an unsubmitted packet as a media failure', async () => {
  const f = fixture(), beginning = defer();
  const request = f.engine.request.bind(f.engine);
  f.engine.request = async (id, operation, target, data) => {
    if (operation === 'source.beginAudioEpoch') return beginning.promise;
    const result = await request(id, operation, target, data);
    if (operation === 'resource.close') {
      beginning.reject(Object.assign(new Error('Operation cancelled by source close'), { code: 'ERR_RTC_CANCELLED' }));
    }
    return result;
  };
  await f.start();
  const cancelled = assert.rejects(f.bridge.enable(), { name: 'AbortError' });
  await f.packet();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.bridge.getStats().queued, 1);
  const stopped = await f.bridge.stop();
  await cancelled;
  assert.equal(stopped.outstanding, 0);
  assert.equal(stopped.cancelledBeforeAdmission, 1);
  assert.deepEqual(f.errors, []);
});

test('cancellation outside owned shutdown is still an error, not a successful packet retirement', async () => {
  const f = fixture();
  const request = f.engine.request.bind(f.engine);
  f.engine.request = (id, operation, target, data) => operation === 'source.beginAudioEpoch'
    ? Promise.reject(Object.assign(new Error('Unexpected epoch cancellation'), { code: 'ERR_RTC_CANCELLED' }))
    : request(id, operation, target, data);
  await f.start();
  const rejected = assert.rejects(f.bridge.enable(), { code: 'ERR_RTC_CANCELLED' });
  await f.packet();
  await rejected;
  assert.equal(f.bridge.getStats().cancelledBeforeAdmission, 0);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.errors[0].code, 'ERR_RTC_CANCELLED');
  await f.bridge.stop();
});
