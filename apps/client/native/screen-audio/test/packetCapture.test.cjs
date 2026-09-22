'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { createPacketCaptureFactory } = require('..\\packet_capture');
const output = process.env.MONKY_PACKET_CAPTURE_TEST_DIR
  || path.resolve(__dirname, '..', 'build', 'packet-tests');
const buildReport = JSON.parse(fs.readFileSync(path.join(output, 'build-report.json'), 'utf8'));
assert.equal(buildReport.nodeVersion, process.versions.node, 'Build the double for this runtime before loading it');
const doublePath = path.join(output, 'capture_double', 'capture_double.node');
// The test binary links the acquisition double, never WASAPI or a production addon.
const binding = require(doublePath);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForTrace(point) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const trace = binding.trace();
    assert.equal(trace.gateErrors, 0, JSON.stringify(trace));
    if (trace[point] === 1) return trace;
    await wait(1);
  }
  assert.fail(`Double did not reach ${point}: ${JSON.stringify(binding.trace())}`);
}

function assertOwnedCleanup(trace, packets = 1) {
  assert.equal(binding.activeWorkers(), 0);
  for (const point of ['tsfnCreated', 'finalizers', 'joins', 'cleanupRemovals',
    'finishes', 'callbackRefDeletes']) {
    assert.equal(trace[point], 1, point);
  }
  assert.equal(trace.packetDeletions, packets);
  assert.equal(trace.eventAllocations, packets + 1);
  assert.equal(trace.eventDeletions, packets + 1);
  for (const point of ['outstandingOwners', 'ownershipViolations', 'releaseErrors',
    'queuedAtFinish', 'pendingAtFinish', 'gateErrors', 'earlyFinish']) {
    assert.equal(trace[point], 0, point);
  }
  assert.equal(binding.legacyStart(), true);
  binding.legacyStop();
}

function createDoubleWorker() {
  return new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const binding = require(workerData);
    const session = binding.createPacketCapture({}, () => {});
    session.ready.then(() => parentPort.postMessage('ready'), () => {});
  `, { eval: true, workerData: doublePath });
}

async function terminateAtGate(mode, point) {
  binding.configure(mode);
  const worker = createDoubleWorker();
  try {
    const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(message, 'ready');
    await waitForTrace(point);
    assert.equal(binding.activeWorkers(), 1);
    const terminated = worker.terminate();
    const gated = await waitForTrace('finalizerReturns');
    assert.equal(gated.cleanupStarts, 1);
    assert.equal(gated.finalizers, 1);
    assert.equal(gated.outstandingOwners, 0);
    assert.equal(gated.releaseAttempts, 1);
    assert.equal(gated.abortCalls, 1);
    assert.equal(gated.napiClosing, 0);
    assert.equal(gated.eventAllocations, mode === 7 ? 2 : 1);
    assert.equal(binding.activeWorkers(), 1, 'Producer must still be held after the Node finalizer');
    binding.releaseGate();
    await terminated;
    return binding.trace();
  } finally {
    binding.releaseGate();
    await worker.terminate();
  }
}

test('compiled production PCM/format/timeline/lease helpers (no device implementation)', () => {
  const result = spawnSync(path.join(output, 'core_controls', 'core_controls.exe'), [], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.hardwareUsed, false);
  assert.ok(report.checks > 2900);
});

test('process-loopback acquisition requests QPC independently and never invents a device counter', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'win', 'wasapi_capture.cpp'), 'utf8');
  assert.match(source, /GetBuffer\(&data, &frames, &flags, nullptr, &qpc100ns\)/u);
  assert.match(source, /sink\.packet\(data, frames, flags, std::nullopt, qpc100ns\)/u);
  assert.doesNotMatch(source, /flags\s*[|=].*TIMESTAMP_ERROR|devicePosition\s*=\s*frameIndex/u);
});

test('unsupported and unavailable remain explicit without native discovery', async () => {
  let calls = 0;
  const forbidden = new Proxy({}, { get() { calls++; throw new Error('No native access permitted'); } });
  const events = [];
  const session = createPacketCaptureFactory(forbidden, 'darwin')({}, (event) => events.push(event));
  await assert.rejects(session.ready, { code: 'ERR_AUDIO_UNSUPPORTED' });
  assert.equal((await session.stop()).state, 'failed');
  assert.equal(calls, 0);
  assert.deepEqual(events.map((event) => event.type), ['error', 'closed']);
  const unavailable = createPacketCaptureFactory(null, 'win32')({}, () => {});
  await assert.rejects(unavailable.ready, { code: 'ERR_AUDIO_UNAVAILABLE' });
});

test('reject invalid options before acquiring any device-free worker', () => {
  for (const options of [{ sampleRate: 48000 }, { channels: 2 }, { includeWindowId: 0 },
    { includeWindowId: -1 }, { includeWindowId: NaN }, { includeWindowId: 1.5 },
    { includeWindowId: Number.MAX_SAFE_INTEGER + 1 }, { excludePid: 2 ** 32 }, { excludePid: '1' }]) {
    assert.throws(() => binding.createPacketCapture(options, () => {}), { code: 'ERR_AUDIO_OPTIONS' });
  }
  assert.equal(binding.activeWorkers(), 0);
});

test('actual NAPI bridge preserves PCM, original rate, real flags, indices and epochs', async () => {
  binding.configure(0);
  const events = [];
  const session = binding.createPacketCapture({ excludePid: undefined, includeWindowId: undefined }, (event) => {
    events.push(event);
    if (event.type === 'packet' && event.sequence === 3) void session.stop();
  });
  const ready = await session.ready;
  assert.equal(ready.state, 'capturing');
  assert.equal(ready.format.sampleRate, 44100);
  const closed = await session.closed;
  assert.equal(binding.activeWorkers(), 0);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.queuedPackets, 0);
  assert.equal(closed.capturedFrames, 8);
  assert.equal(closed.deliveredPackets, 4);
  const packets = events.filter((event) => event.type === 'packet');
  assert.deepEqual(packets.map((packet) => packet.sequence), [0, 1, 2, 3]);
  assert.deepEqual(packets.map((packet) => packet.frameIndex), [0, 2, 4, 6]);
  assert.equal(packets[0].pcm.readFloatLE(0), .25);
  assert.equal(packets[0].pcm.readFloatLE(12), -1);
  assert.equal(packets[0].qpcTimestampUs, 12345678);
  assert.equal(packets[0].devicePosition, 10);
  assert.equal(packets[1].pcm.equals(Buffer.alloc(16)), true);
  assert.equal(packets[1].flags.silent, true);
  assert.equal(packets[0].epoch, packets[1].epoch);
  assert.equal(packets[2].flags.timestampError, true);
  assert.equal(packets[2].devicePosition, null);
  assert.equal(packets[2].qpcTimestampUs, null);
  assert.notEqual(packets[1].epoch, packets[2].epoch);
  assert.notEqual(packets[2].epoch, packets[3].epoch);
  assert.equal(packets[3].flags.dataDiscontinuity, true);
  assert.equal(events[0].type, 'ready');
  assert.equal(events.at(-1).type, 'closed');
  assert.equal(session.stop(), session.stop());
  assert.equal(await session.stop(), closed);
  assert.equal(session.getStats().queuedPackets, 0);
  assert.equal(session.snapshot().state, 'closed');
});

test('QPC-only 7.1 capture keeps one epoch and null counter through the actual NAPI bridge', async () => {
  binding.configure(13);
  const packets = [];
  const session = binding.createPacketCapture({}, (event) => {
    if (event.type !== 'packet') return;
    packets.push(event);
    if (event.sequence === 11) void session.stop();
  });
  await session.ready;
  const closed = await session.closed;
  assert.equal(closed.state, 'closed');
  assert.equal(closed.capturedPackets, 12);
  assert.equal(closed.capturedFrames, 12 * 480);
  assert.equal(closed.deliveredPackets, 12);
  assert.equal(closed.queuedPackets, 0);
  assert.equal(packets.length, 12);
  assert.equal(new Set(packets.map(packet => packet.epoch)).size, 1);
  assert.ok(packets[0].epoch.endsWith(':0'));
  for (const [index, packet] of packets.entries()) {
    assert.deepEqual(packet.format, {
      encoding: 'float32-interleaved', sampleRate: 48000, channels: 8, channelMask: 1599,
      sourceBitsPerSample: 32, sourceValidBitsPerSample: 32,
    });
    assert.equal(packet.sequence, index);
    assert.equal(packet.frameIndex, index * 480);
    assert.equal(packet.frames, 480);
    assert.equal(packet.pcm.length, 480 * 8 * 4);
    assert.equal(packet.devicePosition, null);
    assert.equal(packet.qpcTimestampUs, 66576858724 + index * 10000);
    assert.deepEqual(packet.flags, {
      raw: index === 5 ? 2 : 0, silent: index === 5, dataDiscontinuity: false, timestampError: false,
    });
    if (index === 5) assert.equal(packet.pcm.equals(Buffer.alloc(packet.pcm.length)), true);
    else {
      assert.equal(packet.pcm.readFloatLE(0), .25);
      assert.equal(packet.pcm.readFloatLE(4), -.25);
      assert.equal(packet.pcm.readFloatLE(28), 0);
    }
  }
  assertOwnedCleanup(binding.trace(), 12);
});

test('startup error rejects ready, closes, and releases exclusive ownership', async () => {
  binding.configure(1);
  const events = [];
  const session = binding.createPacketCapture({}, (event) => events.push(event.type));
  await assert.rejects(session.ready, { code: 'ERR_AUDIO_STARTUP' });
  const closed = await session.closed;
  assert.equal(closed.error.code, 'ERR_AUDIO_STARTUP');
  assert.equal(binding.activeWorkers(), 0);
  assert.deepEqual(events, ['error', 'closed']);
  assert.equal(binding.legacyStart(), true);
  binding.legacyStop();
});

test('invalid selected window and unsupported actual format never become success-shaped', async () => {
  for (const [mode, options, code] of [[0, { includeWindowId: 999 }, 'ERR_AUDIO_TARGET'],
    [6, {}, 'ERR_AUDIO_FORMAT']]) {
    binding.configure(mode);
    const session = binding.createPacketCapture(options, () => {});
    await assert.rejects(session.ready, { code });
    assert.equal((await session.closed).error.code, code);
    assert.equal(binding.activeWorkers(), 0);
  }
});

test('stop during pending startup is asynchronous, idempotent and rejects ready', async () => {
  binding.configure(2);
  const session = binding.createPacketCapture({}, () => {});
  const rejected = assert.rejects(session.ready, { code: 'ERR_AUDIO_CANCELLED' });
  await wait(10);
  assert.equal(binding.activeWorkers(), 1);
  const stopped = session.stop();
  assert.equal(stopped, session.stop());
  await Promise.all([rejected, stopped]);
  assert.equal(binding.activeWorkers(), 0);
});

test('bounded overflow preserves ready, structured error and terminal closed under pressure', async () => {
  binding.configure(3);
  const events = [];
  const neverAdmitted = new Promise(() => {});
  const session = binding.createPacketCapture({}, (event) => {
    events.push(event.type);
    if (event.type === 'packet') return neverAdmitted;
  });
  await session.ready;
  const closed = await session.closed;
  assert.equal(closed.error.code, 'ERR_AUDIO_OVERFLOW');
  assert.equal(closed.overflowCount, 1);
  assert.equal(closed.queuedPackets, 0);
  assert.ok(closed.deliveredPackets <= 33);
  assert.deepEqual(events.slice(-2), ['error', 'closed']);
  assert.equal(events[0], 'ready');
  assert.equal(binding.activeWorkers(), 0);
});

test('a full native queue waits for admission instead of terminating a recoverable burst', async () => {
  binding.configure(14);
  const packets = [], events = [];
  let allDelivered;
  const delivered = new Promise(resolve => { allDelivered = resolve; });
  const session = binding.createPacketCapture({}, event => {
    events.push(event.type);
    if (event.type !== 'packet') return;
    packets.push(event);
    return new Promise(resolve => setImmediate(() => {
      if (packets.length === 96) allDelivered();
      resolve();
    }));
  });
  try {
    await session.ready;
    binding.releaseGate();
    await Promise.race([delivered, session.closed]);
    assert.equal(session.getStats().error, null);
    assert.deepEqual(packets.map(packet => packet.sequence), Array.from({ length: 96 }, (_, index) => index));
    assert.equal(new Set(packets.map(packet => packet.epoch)).size, 1);
  } finally {
    binding.releaseGate();
    await session.stop();
  }
  const closed = session.getStats();
  assert.equal(closed.overflowCount, 0);
  assert.equal(closed.queuedPackets, 0);
  assert.deepEqual(events.filter(type => type !== 'packet'), ['ready', 'closed']);
  assertOwnedCleanup(binding.trace(), 96);
});

test('stop cancels a full admission wait without requiring callback promises to settle', async () => {
  binding.configure(14);
  const pending = [];
  let full;
  const filled = new Promise(resolve => { full = resolve; });
  const session = binding.createPacketCapture({}, event => {
    if (event.type !== 'packet') return;
    if (event.sequence === 31) full();
    return new Promise(resolve => pending.push(resolve));
  });
  await session.ready;
  binding.releaseGate();
  await filled;
  assert.equal(session.getStats().queuedPackets, 32);
  assert.equal(binding.legacyStart(), false);
  const stopped = await session.stop();
  assert.equal(stopped.state, 'closed');
  assert.equal(stopped.queuedPackets, 0);
  assert.equal(stopped.overflowCount, 0);
  assert.equal(binding.activeWorkers(), 0);
  assert.equal(binding.legacyStart(), true);
  binding.legacyStop();
  for (const resolve of pending) resolve();
  await wait(1);
  assert.equal(session.getStats().queuedPackets, 0, 'Late receipts must not release capture credits twice.');
  assertOwnedCleanup(binding.trace(), stopped.capturedPackets);
});

test('rejected asynchronous admission is an explicit callback failure with complete cleanup', async () => {
  binding.configure(0);
  const events = [];
  const session = binding.createPacketCapture({}, event => {
    events.push(event.type);
    if (event.type === 'packet') return Promise.reject(new Error('Modeled downstream failure'));
  });
  await session.ready;
  const closed = await session.closed;
  assert.equal(closed.error.code, 'ERR_AUDIO_CALLBACK');
  assert.equal(closed.queuedPackets, 0);
  assert.deepEqual(events.slice(-2), ['error', 'closed']);
  assertOwnedCleanup(binding.trace(), closed.capturedPackets);
});

test('environment cleanup cancels pending admission promises while a producer waits for space', async () => {
  binding.configure(14);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const binding = require(workerData);
    const session = binding.createPacketCapture({}, event => {
      if (event.type !== 'packet') return;
      if (event.sequence === 31) parentPort.postMessage('full');
      return new Promise(() => {});
    });
    session.ready.then(() => binding.releaseGate());
  `, { eval: true, workerData: doublePath });
  try {
    const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(message, 'full');
    await worker.terminate();
    const trace = binding.trace();
    assert.equal(trace.cleanupStarts, 1);
    assertOwnedCleanup(trace, trace.packetDeletions);
  } finally {
    binding.releaseGate();
    await worker.terminate();
  }
});

test('a refilled real TSFN is not a bounded callback burst: PCM waits for downstream admission', async context => {
  const { NativePcmCaptureBridge } = require('..\\..\\screen-share\\runtime\\nativePcmCaptureBridge.cjs');
  const { NativeRtcCommands } = require('..\\..\\screen-share\\runtime\\nativeRtcCommands.cjs');
  binding.configure(15);
  const submitted = [], errors = [], epochs = [];
  let capture, maximumQueued = 0, callbacksInTurn = 0, maximumCallbacksInTurn = 0, checkScheduled = false;
  let complete, failed, pending = 0, maximumNative = 0;
  const completed = new Promise(resolve => { complete = resolve; });
  const failure = new Promise(resolve => { failed = resolve; });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const engine = {
    async request(_id, operation, target, data) {
      await tick();
      if (operation === 'source.createAudio') return { sourceId: 11, kind: 'audio' };
      if (operation === 'source.beginAudioEpoch') { epochs.push(data); return { sourceId: target, epoch: data.epoch }; }
      if (operation === 'source.setEnabled') return { enabled: data.enabled };
      if (operation === 'resource.close') return {};
      assert.fail(operation);
    },
    async submitAudioPacket(sourceId, packet) {
      submitted.push(packet);
      maximumNative = Math.max(maximumNative, ++pending);
      await tick();
      pending--;
      if (submitted.length === 96 && pending === 0) complete();
      return { sourceId, epoch: packet.epoch, sequence: packet.sequence,
        frameIndex: packet.frameIndex, frames: packet.frames, ok: true };
    },
    async close() { await tick(); return { closed: true }; },
  };
  const captureModule = {
    createPacketCapture(options, onEvent) {
      capture = binding.createPacketCapture(options, event => {
        const admission = onEvent(event);
        if (event.type === 'packet') {
          maximumCallbacksInTurn = Math.max(maximumCallbacksInTurn, ++callbacksInTurn);
          if (!checkScheduled) {
            checkScheduled = true;
            setImmediate(() => { callbacksInTurn = 0; checkScheduled = false; });
          }
          const queued = capture.getStats().queuedPackets;
          maximumQueued = Math.max(maximumQueued, queued);
          if (event.sequence < 95) {
            // Refill before Node's dispatcher returns whenever capture still has
            // a credit. Queue occupancy alone does not bound callbacks per turn.
            assert.equal(binding.refill(queued < 32), true);
          }
        }
        return admission;
      });
      return capture;
    },
  };
  const commands = new NativeRtcCommands(engine);
  const bridge = new NativePcmCaptureBridge(engine, commands, captureModule, error => {
    errors.push(error);
    failed();
  }, { timeoutMs: 2000 });
  context.after(async () => {
    binding.releaseGate();
    await bridge.finishAfterEngineClose(commands.closeEngine());
  });
  await bridge.start({}, 'modeled-screen-group');
  bridge.arm();
  binding.releaseGate();
  await Promise.race([completed, failure, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Refilled capture did not make progress')), 3000).unref())]);
  await tick();
  context.diagnostic(JSON.stringify({
    maximumQueued, maximumCallbacksInTurn, maximumNative,
    maximumOutstanding: bridge.getStats().maximumOutstanding,
    captured: bridge.getStats().captured, submitted: submitted.length,
    errors: errors.map(error => error.message), nativeOverflowCount: capture.getStats().overflowCount,
  }));
  assert.deepEqual(errors, []);
  assert.ok(maximumQueued <= 32);
  assert.ok(maximumNative <= 8);
  assert.ok(bridge.getStats().maximumOutstanding <= 40);
  assert.equal(bridge.getStats().captured, 96);
  assert.equal(bridge.getStats().submitted, 96);
  assert.equal(bridge.getStats().retired, 96);
  assert.equal(bridge.getStats().dropped, 0);
  assert.deepEqual(submitted.map(packet => packet.sequence), Array.from({ length: 96 }, (_, index) => index));
  assert.equal(epochs.length, 1);
  for (const [index, packet] of submitted.entries()) {
    assert.equal(packet.epoch, submitted[0].epoch);
    assert.equal(packet.frameIndex, index * 441);
    assert.equal(packet.devicePosition, index * 441);
    assert.equal(packet.qpcTimestampUs, 8000000 + index * 10000);
    assert.equal(packet.flags.raw, 0);
    assert.equal(packet.pcm.readFloatLE(0), .25);
  }
  await bridge.stop();
  assert.equal(capture.getStats().overflowCount, 0);
  assertOwnedCleanup(binding.trace(), 96);
});

test('packet and legacy double share the real production lease without stopping each other', async () => {
  binding.configure(4);
  assert.equal(binding.legacyStart(), true);
  const busy = binding.createPacketCapture({}, () => {});
  await assert.rejects(busy.ready, { code: 'ERR_AUDIO_BUSY' });
  await busy.closed;
  assert.equal(binding.legacyStart(), false);
  binding.legacyStop();
  const session = binding.createPacketCapture({}, () => {});
  await session.ready;
  assert.equal(binding.legacyStart(), false);
  binding.legacyStop(); // An unowned legacy stop must not stop packet acquisition.
  assert.equal(binding.activeWorkers(), 1);
  const second = binding.createPacketCapture({}, () => {});
  await assert.rejects(second.ready, { code: 'ERR_AUDIO_BUSY' });
  await second.closed;
  assert.equal(binding.activeWorkers(), 1);
  await session.stop();
  assert.equal(binding.legacyStart(), true);
  binding.legacyStop();
});

test('runtime failure and callback exception close only after the worker and queue drain', async () => {
  binding.configure(5);
  const failed = binding.createPacketCapture({}, () => {});
  await failed.ready;
  assert.equal((await failed.closed).error.code, 'ERR_AUDIO_WASAPI');
  binding.configure(4);
  const throws = binding.createPacketCapture({}, (event) => {
    if (event.type === 'ready') throw new Error('Consumer callback failure');
  });
  await throws.ready;
  assert.equal((await throws.closed).error.code, 'ERR_AUDIO_CALLBACK');
  assert.equal(binding.activeWorkers(), 0);
});

test('restarts get distinct epochs and callbacks cannot arrive after closed', async () => {
  const firstEpochs = [];
  for (let index = 0; index < 8; index++) {
    binding.configure(0);
    let isClosed = false;
    const session = binding.createPacketCapture({}, (event) => {
      assert.equal(isClosed, false, 'Late native callback');
      if (event.type === 'packet' && event.sequence === 0) {
        firstEpochs.push(event.epoch);
        void session.stop();
      }
      if (event.type === 'closed') isClosed = true;
    });
    await session.ready;
    await session.closed;
    assert.equal(isClosed, true);
  }
  assert.equal(new Set(firstEpochs).size, 8);
  assert.equal(binding.activeWorkers(), 0);
});

test('environment teardown cancels a live double without orphaned work or shared lease', async () => {
  for (const mode of [4, 2, 4, 2]) {
    binding.configure(mode);
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const capture = require(workerData.path);
      const session = capture.createPacketCapture({}, () => {});
      if (workerData.mode === 2) {
        session.ready.catch(() => {});
        setTimeout(() => parentPort.postMessage('ready'), 20);
      } else session.ready.then(() => parentPort.postMessage('ready'));
    `, { eval: true, workerData: { path: doublePath, mode } });
    const [message] = await once(worker, 'message');
    assert.equal(message, 'ready');
    assert.equal(binding.activeWorkers(), 1);
    await worker.terminate();
    assert.equal(binding.activeWorkers(), 0);
    assert.equal(binding.legacyStart(), true);
    binding.legacyStop();
  }
});

test('environment cleanup revokes delivery before a converted packet can access a destroyed TSFN', async (context) => {
  const trace = await terminateAtGate(7, 'packetGates');
  context.diagnostic(`Device-free cleanup revocation: ${JSON.stringify(trace)}`);
  assert.equal(trace.packetGates, 1);
  assert.equal(trace.packetPushes, 0);
  assert.equal(trace.pushesAfterFinalizer, 0);
  assert.equal(trace.napiClosing, 0);
  assert.equal(trace.queueFailures, 0);
  assert.equal(trace.revokedEvents, 1);
  assert.equal(trace.releaseAttempts, 1);
  assert.equal(trace.releaseCalls, 1);
  assert.equal(trace.abortCalls, 1);
  assertOwnedCleanup(trace);
});

test('conversion failure during environment cleanup still releases and joins asynchronously', async () => {
  const trace = await terminateAtGate(8, 'conversionGates');
  assert.equal(trace.conversionGates, 1);
  assert.equal(trace.conversionFailures, 1);
  assert.equal(trace.packetPushes, 0);
  assert.equal(trace.napiClosing, 0);
  assert.equal(trace.releaseAttempts, 1);
  assert.equal(trace.releaseCalls, 1);
  assert.equal(trace.abortCalls, 1);
  assertOwnedCleanup(trace);
});

test('ordinary stop at the converted packet gate performs the one producer release', async () => {
  binding.configure(7);
  const events = [];
  const session = binding.createPacketCapture({}, (event) => events.push(event.type));
  try {
    await session.ready;
    await waitForTrace('packetGates');
    const stopped = session.stop();
    binding.releaseGate();
    assert.equal((await stopped).state, 'closed');
    const trace = binding.trace();
    assert.equal(trace.packetPushes, 1);
    assert.equal(trace.napiClosing, 0);
    assert.equal(trace.cleanupStarts, 0);
    assert.equal(trace.releaseAttempts, 1);
    assert.equal(trace.releaseCalls, 1);
    assert.equal(trace.abortCalls, 0);
    assert.deepEqual(events, ['ready', 'packet', 'closed']);
    assertOwnedCleanup(trace);
  } finally {
    binding.releaseGate();
    await session.stop();
  }
});

test('non-closing enqueue failure keeps its packet caller-owned and releases the producer', async () => {
  binding.configure(9);
  const events = [];
  const session = binding.createPacketCapture({}, (event) => events.push(event.type));
  await session.ready;
  assert.equal((await session.closed).error.code, 'ERR_AUDIO_DELIVERY');
  const trace = binding.trace();
  assert.equal(trace.queueFailures, 1);
  assert.equal(trace.napiClosing, 0);
  assert.equal(trace.releaseAttempts, 1);
  assert.equal(trace.releaseCalls, 1);
  assert.deepEqual(events, ['ready', 'error', 'closed']);
  assertOwnedCleanup(trace);
});

// This deliberately uses a post-finalizer acquisition: never run it on Node 20.
test('actual Node 24 napi_closing consumes the producer without a second release', {
  skip: process.versions.node !== '24.19.0' && 'Post-finalizer ownership is verified on Node 24.19.0 only',
}, async (context) => {
  binding.configure(10);
  const events = [];
  const session = binding.createPacketCapture({}, (event) => events.push(event.type));
  try {
    await session.ready;
    await waitForTrace('packetGates');
    assert.equal(binding.abortDelivery(), true);
    const gated = await waitForTrace('finalizerReturns');
    assert.equal(gated.outstandingOwners, 1);
    assert.equal(gated.releaseAttempts, 0);
    binding.releaseGate();
    assert.equal((await session.closed).error.code, 'ERR_AUDIO_DELIVERY');
    const trace = binding.trace();
    context.diagnostic(`Device-free shutdown ownership: ${JSON.stringify(trace)}`);
    assert.equal(trace.testAborts, 1);
    assert.equal(trace.packetPushes, 1);
    assert.equal(trace.pushesAfterFinalizer, 1);
    assert.equal(trace.napiClosing, 1, 'The real Node TSFN must return napi_closing');
    assert.equal(trace.queueFailures, 1);
    assert.equal(trace.releaseAttempts, 0, 'napi_closing already consumed the producer acquisition');
    assert.equal(trace.releaseCalls, 0);
    assert.equal(trace.cleanupStarts, 0);
    assert.deepEqual(events, ['ready', 'error', 'closed']);
    assertOwnedCleanup(trace);
  } finally {
    binding.releaseGate();
    await session.stop();
  }
});

test('Node 20 cleanup model destroys the TSFN before producer exit and disposes queued data after finalization', async (context) => {
  binding.configure(11);
  const worker = createDoubleWorker();
  try {
    const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(message, 'ready');
    await waitForTrace('legacyQueuedGates');
    await waitForTrace('legacyDeferredEvents');
    const terminated = worker.terminate();
    const gated = await waitForTrace('legacyNativeDestroyed');
    assert.equal(gated.cleanupStarts, 1);
    assert.equal(gated.legacyForcedReclaims, 0,
      `Node20-style destruction must find no producer acquisition: ${JSON.stringify(gated)}`);
    assert.equal(gated.outstandingOwners, 0);
    assert.equal(gated.releaseAttempts, 1);
    assert.equal(gated.abortCalls, 1);
    assert.equal(gated.finalizers, 0);
    assert.equal(gated.joins, 0);
    assert.equal(binding.activeWorkers(), 1);
    binding.releaseGate();
    await terminated;
    const trace = binding.trace();
    context.diagnostic(`Device-free Node20 ordering model: ${JSON.stringify(trace)}`);
    assert.equal(trace.legacyNativeFinalizers, 1);
    assert.equal(trace.legacyNativeDestroyed, 1);
    assert.equal(trace.legacyFinalizeAfterJoin, 1);
    assert.equal(trace.legacyDeferredEvents, 1);
    assert.equal(trace.legacyDisposals, 1);
    assert.equal(trace.pendingAtFinalizer, 1);
    assert.equal(trace.deliveriesAfterFinalizer, 1);
    assert.equal(trace.legacyForcedReclaims, 0);
    assert.equal(trace.packetPushes, 1);
    assert.equal(trace.revokedEvents, 1);
    assert.equal(trace.napiClosing, 0);
    assert.equal(trace.releaseCalls, 1);
    assertOwnedCleanup(trace, 2);
  } finally {
    binding.releaseGate();
    await worker.terminate();
  }
});

test('real TSFN cleanup disposes a pending packet in the runtime finalizer order', async (context) => {
  binding.configure(12);
  const worker = createDoubleWorker();
  try {
    const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(message, 'ready');
    await waitForTrace('packetGates');
    await worker.terminate();
    const trace = binding.trace();
    context.diagnostic(`Device-free actual runtime ordering (${process.versions.node}): ${JSON.stringify(trace)}`);
    assert.equal(trace.cleanupPushCompletions, 1);
    assert.equal(trace.cleanupPushes, 1);
    assert.equal(trace.packetPushes, 1);
    assert.equal(trace.envNullDisposals, 1);
    assert.equal(trace.legacyNativeFinalizers, 0, 'No reordered-finalizer shim in this control');
    assert.equal(trace.testAborts, 0);
    assert.equal(trace.napiClosing, 0);
    assert.equal(trace.releaseAttempts, 1);
    assert.equal(trace.releaseCalls, 1);
    if (process.versions.node === '20.18.2') {
      assert.equal(trace.pendingAtFinalizer, 1);
      assert.equal(trace.deliveriesAfterFinalizer, 1);
    } else if (process.versions.node === '24.19.0') {
      assert.equal(trace.pendingAtFinalizer, 0);
      assert.equal(trace.deliveriesAfterFinalizer, 0);
    }
    assertOwnedCleanup(trace);
  } finally {
    binding.releaseGate();
    await worker.terminate();
  }
});

test('garbage collection stops unreferenced idle and backpressured sessions without pending receipts', () => {
  for (const mode of [4, 14]) {
    const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict');
    const binding = require(process.argv[1]);
    const mode = Number(process.argv[2]);
    binding.configure(mode);
    let interval;
    const closed = new Promise(resolve => {
      const session = binding.createPacketCapture({}, event => {
        if (event.type === 'closed') resolve(event.snapshot);
        if (event.type === 'packet' && mode === 14) {
          if (event.sequence === 31) interval = setInterval(() => global.gc(), 10);
          return new Promise(() => {});
        }
      });
      session.ready.then(() => {
        if (mode === 14) binding.releaseGate();
        else interval = setInterval(() => global.gc(), 10);
      });
    });
    closed.then(snapshot => {
      clearInterval(interval);
      assert.equal(binding.activeWorkers(), 0);
      assert.equal(snapshot.queuedPackets, 0);
      assert.equal(snapshot.state, 'closed');
      console.log('finalizer-clean');
    });
  `, doublePath, String(mode)], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /finalizer-clean/u);
  }
});

test('private compile report never substitutes compilation for a real capture proof', () => {
  const report = buildReport;
  assert.equal(report.hardwareUsed, false);
  assert.equal(report.functionalAddonLoaded, false);
  assert.equal(report.productionAddonUnchanged, true);
});
