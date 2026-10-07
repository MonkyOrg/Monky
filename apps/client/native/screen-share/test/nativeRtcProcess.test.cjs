'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const { ProcessEngine } = require('../runtime/nativeRtc/engine/node/process.cjs');
const { LiveSenderFlow } = require('../runtime/encodedSender.cjs');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');
const { NativeAudioOutputOwner } = require('../runtime/nativeAudioOutputOwner.cjs');

const engines = new Set();
function fixture(options = {}) {
  const events = [];
  const engine = new ProcessEngine({
    filename: path.join(__dirname, 'fixtures', 'rtcProcessAddon.cjs'),
    capabilities: { fixture: 'owned-rtc-process' },
    options: { operationTimeoutMs: 1000, ...options }, onEvent: event => events.push(event),
  });
  engines.add(engine);
  return { engine, events };
}

async function nextEvent(events, type, timeoutMs = 5000) {
  for (const deadline = Date.now() + timeoutMs; ; await new Promise(resolve => setTimeout(resolve, 5))) {
    const event = events.find(candidate => candidate.type === type);
    if (event) return event;
    assert.ok(Date.now() < deadline, `No ${type} event within ${timeoutMs} ms.`);
  }
}

// A failed assertion skips the test's own close, and its live owned host would keep this file
// running until the CI job times out. Reap it here and report the leak instead.
afterEach(async () => {
  const running = [...engines].filter(engine => !engine.hostExited);
  engines.clear();
  if (!running.length) return;
  const exited = Promise.all(running.map(engine => engine.exitState.promise));
  if (await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(resolve, 1000, false))])) return;
  for (const engine of running) if (!engine.hostExited) engine.fail(new Error('Test ended with its RTC host running.'));
  await exited;
  assert.fail(`${running.length} owned RTC host(s) were still running when the test ended.`);
});

test('a burst of audio clock feedback retains only the latest observation without exhausting RTC IPC credits', async () => {
  const { engine } = fixture({ feedbackDelayMs: 60, operationTimeoutMs: 2000 });
  const commands = new NativeRtcCommands(engine), errors = [];
  const owner = new NativeAudioOutputOwner(engine, commands, {
    async start(config) { await owner.configureOutput(config); return config; },
    async stop() {},
    async enqueue() { assert.fail('This device-free test cannot receive PCM.'); },
  }, error => errors.push(error));
  try {
    await engine.ready;
    await owner.start('owned-output');
    const feedback = [];
    for (let index = 0; index < 1000; index++) {
      const result = owner.feedback({ epoch: 1, available: false });
      feedback.push(result);
      void Promise.resolve(result).catch(() => {});
    }
    assert.equal(engine.snapshot().process.pendingCalls, 1);
    const results = await Promise.all(feedback);
    assert.equal(results.filter(result => result === true).length, 2);
    assert.equal(results.filter(result => result === false).length, 998);
    assert.equal(owner.getStats().coalescedFeedback, 998);
    assert.equal(engine.snapshot().process.pendingCalls, 0);
    assert.deepEqual(errors, []);
    await owner.stop();
  } finally {
    await owner.finishAfterEngineClose(commands.closeEngine());
  }
});

test('IOSurface IDs become Main-local leases and survive host death until external references retire', async () => {
  const surfaces = require('./fixtures/rtcProcessSurfaces.cjs');
  for (const crash of [false, true]) {
    const events = [];
    const engine = new ProcessEngine({
      filename: path.join(__dirname, 'fixtures', 'rtcProcessAddonMac.cjs'),
      handlesFile: path.join(__dirname, 'fixtures', 'rtcProcessSurfaces.cjs'),
      capabilities: { fixture: 'owned-rtc-process', decodedOutput: 'NV12_IOSURFACE_LEASE' },
      options: { operationTimeoutMs: 2000 }, onEvent: event => events.push(event),
    });
    try {
      await engine.ready;
      await engine.request(1, 'surface', 0, {});
      const frame = events.find(event => event.type === 'frame');
      assert.deepEqual(Object.keys(frame.data.textureInfo.handle), ['ioSurface']);
      assert.equal(frame.data.textureInfo.handle.ioSurface.readBigUInt64LE(), 0x12345678n);
      assert.equal(surfaces.leases.size, 1);
      assert.equal(engine.leases.size, 1);
      if (crash) {
        engine.child.kill();
        await engine.exitState.promise;
        assert.equal(surfaces.leases.size, 1, 'OS exit cannot revoke Main/Chromium IOSurface ownership.');
      }
      const receipt = await engine.releaseFrame(1, 'all-references-released');
      assert.equal(receipt.ok, true);
      assert.equal(surfaces.leases.size, 0);
      await engine.close();
    } finally {
      if (!engine.hostExited) { engine.child.kill(); await engine.exitState.promise; }
      if (engine.leases.has(1)) await engine.releaseFrame(1, 'unused');
      await engine.close();
    }
  }
});

test('RTC addon executes exclusively in an owned OS process; close waits for exit and new engine recovers', async () => {
  for (let index = 0; index < 2; index++) {
    const { engine } = fixture();
    await engine.ready;
    assert.notEqual(engine.child.pid, process.pid);
    const reply = await engine.request(1, 'echo', 0, { value: 'not pixels' });
    assert.equal(reply.pid, engine.child.pid);
    assert.equal(require.cache[path.join(__dirname, 'fixtures', 'rtcProcessAddon.cjs')], undefined);
    assert.equal((await engine.close()).process.exited, true);
    assert.equal(engine.pending.size, 0);
  }
});

test('native abort kills only its RTC host, rejects pending PCM with real OS-disposal proof, and recovers', async () => {
  const { engine, events } = fixture();
  await engine.ready;
  const pending = engine.request(1, 'hang', 0, {});
  const pcm = engine.submitAudioPacket(2, { pcm: Buffer.alloc(16), epoch: 'pending',
    sequence: 3, frameIndex: 12, frames: 2 });
  const rejection = assert.rejects(pending, { code: 'ERR_RTC_HOST_EXIT', hostExited: true });
  const pcmRejection = assert.rejects(pcm, error => {
    assert.equal(error.nativeOwnershipRetained, false);
    assert.equal(error.processingPending, false);
    assert.equal(error.sourceId, 2);
    assert.equal(error.epoch, 'pending');
    assert.equal(error.frames, 2);
    return true;
  });
  await assert.rejects(engine.request(4, 'crash', 0, {}), { code: 'ERR_RTC_HOST_EXIT' });
  await Promise.all([rejection, pcmRejection]);
  assert.equal(events.filter(event => event.type === 'error' && event.data.hostExited).length, 1);
  assert.equal((await engine.close()).process.externalTextureLeases, 0);
  const replacement = fixture().engine;
  await replacement.ready;
  assert.equal((await replacement.request(1, 'echo', 0, {})).pid, replacement.child.pid);
  await replacement.close();
});

test('owned host termination does not substitute for Chromium external-reference retirement', async () => {
  const { engine } = fixture();
  await engine.ready;
  let closed = 0, retired;
  engine.leases.set(77, {
    handle: { close: () => { closed++; } }, proof: null,
    released: { promise: new Promise(resolve => { retired = resolve; }), resolve: () => retired() },
  });
  engine.child.kill();
  await engine.exitState.promise;
  let complete = false;
  const closing = engine.close().then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 0);
  assert.equal(complete, false);
  const result = await engine.releaseFrame(77, 'all-references-released');
  assert.equal(result.hostExited, true);
  assert.equal(result.gpuRetirementConfirmed, false);
  await closing;
  assert.equal(closed, 1);
});

test('video admission waits for the native acknowledgement without a JavaScript frame queue', async () => {
  const { engine, events } = fixture();
  await engine.ready;
  let writable;
  const canWrite = new Promise(resolve => { writable = resolve; });
  const flow = new LiveSenderFlow({ engine, sourceId: 2, initialBitrateKbps: 1000, fps: 60,
    onError: assert.fail, onWritable: writable });
  flow.setDemand(true); flow.setConnected(true);
  const frame = { frameId: 1, data: Buffer.alloc(32), keyframe: true };
  assert.equal(flow.packet(frame), false);
  assert.equal(flow.snapshot().admitted, 0);
  assert.equal(flow.packet(frame), false);
  await canWrite;
  assert.equal(flow.snapshot().admitted, 1);
  assert.equal(flow.packet(frame), undefined);
  assert.equal((await engine.refreshSnapshot()).copied, 1);
  flow.released(await nextEvent(events, 'source.encodedFrameReleased'));
  await flow.close();
  const commands = new NativeRtcCommands(engine);
  await commands.closeEngine();
  flow.finishAfterEngineClose(commands);
  assert.equal(flow.inFlight.size, 0);
});

test('unresponsive RTC requests are bounded and terminate only their owned host', async () => {
  const { engine } = fixture({ operationTimeoutMs: 100 });
  await engine.ready;
  const pending = [];
  for (let i = 0; i < 128; i++) pending.push(engine.request(i + 1, 'hang', 0, {}));
  const settled = Promise.allSettled(pending);
  assert.throws(() => engine.request(129, 'hang', 0, {}), { status: 3 });
  let ticked = false;
  setTimeout(() => { ticked = true; }, 10);
  const results = await settled;
  assert.equal(ticked, true, 'Main event loop must never synchronously wait for native work.');
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.hostExited));
  await engine.close();
  assert.equal(engine.bytesPending, 0);
});

test('PCM IPC capacity rejects before admission with correlated non-ownership, never queues a ninth packet', async () => {
  const { engine } = fixture();
  await engine.ready;
  const packet = sequence => ({ pcm: Buffer.alloc(16), epoch: 'pending',
    sequence, frameIndex: sequence * 2, frames: 2 });
  const inputs = Array.from({ length: 8 }, (_, sequence) => engine.submitAudioPacket(3, packet(sequence)));
  const settled = Promise.allSettled(inputs);
  await assert.rejects(engine.submitAudioPacket(3, packet(0)), {
    code: 'ERR_RTC_AUDIO_DUPLICATE', processingPending: true,
  });
  await assert.rejects(engine.submitAudioPacket(3, packet(8)), error => {
    assert.equal(error.status, 3);
    assert.equal(error.sourceId, 3);
    assert.equal(error.sequence, 8);
    assert.equal(error.nativeOwnershipRetained, false);
    assert.equal(error.processingPending, false);
    return true;
  });
  assert.equal(engine.audioPending, 8);
  engine.child.kill();
  await settled;
  await engine.close();
  assert.equal(engine.audioPending, 0);
});

test('a saturated ordinary IPC queue cannot prevent retirement of an already-owned texture', async () => {
  const { engine } = fixture({ operationTimeoutMs: 2000 });
  await engine.ready;
  let closed = 0, released;
  engine.leases.set(91, {
    handle: { close: () => { closed++; } }, proof: null,
    released: { promise: new Promise(resolve => { released = resolve; }), resolve: () => released() },
  });
  const requests = Array.from({ length: 128 }, (_, index) => engine.request(index + 1, 'hang', 0, {}));
  const settled = Promise.allSettled(requests);
  try {
    assert.throws(() => engine.request(129, 'hang', 0, {}), { status: 3 });
    const receipt = await engine.releaseFrame(91, 'unused');
    assert.deepEqual(receipt, { frameId: 91, ok: true });
    assert.equal(engine.hostExited, undefined);
    assert.equal(engine.leases.size, 0);
    assert.equal(closed, 1);
  } finally {
    engine.child.kill();
    await engine.exitState.promise;
    await settled;
    if (engine.leases.has(91)) await engine.releaseFrame(91, 'unused');
    await engine.close();
  }
});

test('retirement IPC credits are separately bounded and returned only by real completion or host exit', async () => {
  const { engine } = fixture({ operationTimeoutMs: 2000, holdRetirementRequests: true });
  await engine.ready;
  const ordinary = Array.from({ length: 128 }, (_, index) => engine.request(index + 1, 'hang', 0, {}));
  const retirement = Array.from({ length: 64 }, (_, index) => engine.request(index + 129, 'resource.close', index + 1, {}));
  const settled = Promise.allSettled([...ordinary, ...retirement]);
  try {
    assert.equal(engine.pending.size, 192);
    assert.equal(engine.retirementPending, 64);
    assert.throws(() => engine.request(193, 'resource.close', 65, {}), { status: 3 });
    assert.throws(() => engine.request(194, 'echo', 0, {}), { status: 3 });
    assert.equal(engine.retirementPending, 64);
    assert.ok(engine.retirementBytes > 0 && engine.retirementBytes < 64 * 1024);
  } finally {
    engine.child.kill();
    await settled;
    await engine.close();
  }
  assert.equal(engine.retirementPending, 0);
  assert.equal(engine.retirementBytes, 0);
  assert.equal(engine.bytesPending, 0);
});

test('closing before readiness still initializes and reaps only its owned RTC process', async () => {
  const { engine, events } = fixture();
  await engine.close();
  assert.equal(engine.hostExited, true);
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('periodic snapshots cannot access native state while an acknowledged close is still draining', async () => {
  const { engine, events } = fixture({
    operationTimeoutMs: 2000, rejectSnapshotDuringClose: true, closeDelayMs: 650,
  });
  try {
    await engine.ready;
    const result = await engine.close();
    assert.equal(result.closed, true);
    assert.equal(result.process.exited, true);
    assert.equal(events.some(event => event.type === 'error'), false);
  } finally {
    if (!engine.hostExited) { engine.child.kill(); await engine.exitState.promise; }
  }
});

test('deserialized native PCM retains samples in a dedicated renderer-valid buffer', async () => {
  const { engine, events } = fixture();
  await engine.ready;
  await engine.request(1, 'playout', 0, {});
  const data = events.find(event => event.type === 'audio.playout').data;
  assert.equal(data.samples.byteOffset, 0);
  assert.equal(data.samples.buffer.byteLength, 3840);
  assert.ok(data.samples.every(value => value === .125));
  const scope = { epoch: 1, portId: 'owned-audio-port' };
  assert.equal(require('@monky/shared').isNativeScreenAudioPortMessage({
    ...scope, type: 'event', event: 'pcm', data,
  }, scope, 'main'), true);
  await engine.close();
});

test('a completed request winning the cancellation race does not kill the RTC host', async () => {
  const { engine } = fixture();
  await engine.ready;
  await engine.request(1, 'echo', 0, {});
  engine.cancel(1);
  await engine.request(2, 'echo', 0, {});
  assert.equal(engine.failure, undefined);
  await engine.close();
});

test('termination dispatch failure never throws into Main or fabricates OS retirement', async () => {
  const { engine } = fixture();
  await engine.ready;
  const kill = engine.child.kill.bind(engine.child);
  engine.child.kill = () => { throw new Error('owned termination unavailable'); };
  assert.doesNotThrow(() => engine.fail(new Error('native timeout')));
  assert.equal(engine.hostExited, undefined);
  assert.match(engine.killFailure, /unavailable/u);
  engine.child.kill = kill;
  kill();
  await engine.close();
  assert.equal(engine.hostExited, true);
});

test('a stalled native worker is contained even while its JS host still answers requests', async () => {
  const { engine } = fixture({ operationTimeoutMs: 100, hangNative: true });
  await engine.ready;
  await engine.request(1, 'echo', 0, {});
  let closed = 0, retired;
  engine.leases.set(91, {
    handle: { close: () => { closed++; } }, proof: null,
    released: { promise: new Promise(resolve => { retired = resolve; }), resolve: () => retired() },
  });
  await engine.exitState.promise;
  assert.match(engine.failure.detail, /core-pump/u);
  assert.equal(closed, 0, 'Native operation timeout cannot retire Chromium references.');
  await engine.releaseFrame(91, 'all-references-released');
  await engine.close();
  assert.equal(closed, 1);
});

test('native close acknowledgement without OS exit retains ownership until the owned host is reaped', async () => {
  const { engine } = fixture({ operationTimeoutMs: 100, stallExit: true });
  await engine.ready;
  const result = await engine.close();
  assert.equal(engine.closeAcknowledged, true);
  assert.equal(result.process.exited, true);
  assert.match(engine.failure.message, /did not exit/u);
});

test('OS exit cannot masquerade as a reusable input GPU frame retirement', async () => {
  const { engine } = fixture();
  await engine.ready;
  // Model a retained external input reader without creating or borrowing GPU pixels.
  engine.inputFrames.set('1:2', { sourceId: 1, frameId: 2 });
  engine.child.kill();
  await engine.exitState.promise;
  await assert.rejects(engine.close(), {
    code: 'ERR_RTC_GPU_INPUT_RETIREMENT', nativeOwnershipRetained: true, hostExited: true,
  });
  assert.equal(engine.inputFrames.size, 1);
});

test('an uncorrelated child frame receipt retains the Main HANDLE until a genuine retirement proof', async () => {
  const { engine } = fixture({ badRelease: true });
  await engine.ready;
  let closed = 0, retired;
  engine.leases.set(5, {
    handle: { close: () => { closed++; } }, proof: null,
    released: { promise: new Promise(resolve => { retired = resolve; }), resolve: () => retired() },
  });
  await assert.rejects(engine.releaseFrame(5, 'all-references-released'), /different frame/u);
  assert.equal(closed, 0);
  assert.equal(engine.leases.size, 1);
  engine.child.kill();
  await engine.exitState.promise;
  const result = await engine.releaseFrame(5, 'all-references-released');
  assert.equal(result.frameId, 5);
  assert.equal(result.gpuRetirementConfirmed, false);
  await engine.close();
  assert.equal(closed, 1);
});

const handlesFile = path.join(__dirname, '..', 'bin', 'win32-x64', 'monky_native_handles.node');
test('kernel-only HANDLE helper rejects forged/closed owners and invalid handles without loading RTC', {
  skip: process.platform !== 'win32' || !fs.existsSync(handlesFile),
}, () => {
  const handles = require(handlesFile);
  for (const pid of [0, -1, NaN, Infinity, 1.5, 0x100000000])
    assert.throws(() => handles.openProcess(pid), { code: 'ERR_RTC_HANDLE' });
  const owner = handles.openProcess(process.pid);
  try {
    assert.throws(() => owner.duplicate(Buffer.alloc(8)), { code: 'ERR_RTC_HANDLE' });
    assert.throws(() => owner.duplicate(Buffer.alloc(7)), { code: 'ERR_RTC_HANDLE' });
    assert.throws(() => owner.close.call({}), { code: 'ERR_RTC_HANDLE' });
  } finally { owner.close(); }
  assert.doesNotThrow(() => owner.close());
  assert.throws(() => owner.duplicate(Buffer.alloc(8)), { code: 'ERR_RTC_HANDLE' });
  assert.equal(Object.keys(require.cache).some(filename => filename.endsWith('monky_screen_rtc.node')), false);
});
