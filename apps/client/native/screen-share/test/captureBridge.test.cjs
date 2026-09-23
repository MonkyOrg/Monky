'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const { CaptureBridge } = require('../runtime/captureBridge.cjs');
const artifactDirectory = path.join(__dirname, 'capture-runtime-fixture');
const manifest = { directory: 'obs' };

function fixture(onPacket = () => {}) {
  const runId = '1'.repeat(32), errors = [], notices = [], commands = [];
  const runtime = { kind: 'verified-stock-obs-runtime', version: '32.1.1', artifactDirectory,
    stockDirectory: path.join(artifactDirectory, manifest.directory, 'stock'),
    binaryDirectory: path.join(artifactDirectory, manifest.directory, 'stock', 'bin', '64bit') };
  const bridge = new CaptureBridge({
    host: { kind: 'verified-native-screen-capture-host', executable: path.join(artifactDirectory, 'model-live-host.exe'), sha256: 'a'.repeat(64) },
    runtime, runId, runDirectory: path.join(artifactDirectory, `monky-screen-capture-${runId}`), video: { width: 1920, height: 1080, fps: 120, bitrateKbps: 5000 },
    onError: error => errors.push(error), onNotice: value => { notices.push(value); }, onPacket,
  });
  const child = new EventEmitter();
  child.pid = 42;
  child.stdio = [null, null, null, new PassThrough(), new Writable({
    write(chunk, _encoding, done) { commands.push(chunk.toString('ascii')); done(); },
  })];
  bridge.child = child; bridge.attachLive(child);
  bridge.receiveLive({ type: 'notice', value: { kind: 'hello', runId, processId: 42, protocol: 1,
    transmitterReencode: false, timestampSemantics: 'obs-system-pts' } });
  bridge.prepared = {};
  const acknowledge = (sequence, verb, value) => bridge.receiveLive({ type: 'notice', value: verb === 'bitrate'
    ? { kind: 'bitrate-settings', sequence, bitrateKbps: value, settingsAccepted: true, hardwareApplicationConfirmed: false, fpsApplied: null }
    : { kind: 'idr-request', sequence, mode: 'next-real-idr', keyframeConfirmed: false, maximumWaitMs: 1500 } });
  const close = async () => {
    await bridge.stop(); child.emit('close'); bridge.detach();
    child.stdio[3].destroy(); child.stdio[4].destroy();
  };
  return { bridge, errors, notices, commands, acknowledge, close };
}

test('live feedback crosses a writable stream with matched bounded acknowledgements', async () => {
  const f = fixture();
  const rate = f.bridge.setBitrate(15000); const idr = f.bridge.requestKeyFrame();
  assert.deepEqual(f.commands, ['1 bitrate 15000\n', '2 idr 0\n']);
  f.acknowledge(1, 'bitrate', 15000); f.acknowledge(2, 'idr');
  assert.equal((await rate).hardwareApplicationConfirmed, false);
  assert.equal((await idr).keyframeConfirmed, false);
  assert.equal(f.bridge.liveRequests.size, 0);
  await f.close(); assert.deepEqual(f.errors, []);
});

test('first-frame readiness excludes minimized time but still times out an available source', async () => {
  const f = fixture();
  let paused = true;
  f.bridge.isSourcePaused = () => paused;
  f.bridge.deadlines.start = 50;
  let ready;
  const response = new Promise(resolve => { ready = resolve; });
  const observed = f.bridge.observeRequest(response, 'start');
  await new Promise(resolve => setTimeout(resolve, 130));
  paused = false;
  ready({ actualFrame: true });
  assert.deepEqual(await observed, { actualFrame: true });
  await assert.rejects(f.bridge.observeRequest(new Promise(() => {}), 'start'), /while the selected window was available/);
  await f.close();
});

test('stop rejects pending feedback but accepts its already-in-flight acknowledgement until actual child close', async () => {
  const f = fixture();
  const waiting = assert.rejects(f.bridge.requestKeyFrame(), { name: 'AbortError' });
  await f.bridge.stop(); await waiting;
  assert.equal(f.bridge.liveRequests.size, 1);
  f.acknowledge(1, 'idr'); assert.equal(f.bridge.liveRequests.size, 0);
  await f.close(); assert.deepEqual(f.errors, []);
});

test('original compressed admission is synchronous, preserves the bytes and cannot enqueue a hidden JS promise', async () => {
  const data = Buffer.from([0, 0, 0, 1, 0x65]), frames = [];
  const f = fixture(frame => { frames.push(frame); });
  f.bridge.receiveLive({ type: 'packet', frame: { frameId: 1, data } });
  assert.equal(frames[0].data, data); await f.close();
  const asynchronous = fixture(() => Promise.resolve());
  assert.throws(() => asynchronous.bridge.receiveLive({ type: 'packet', frame: { frameId: 1, data } }), /synchronous/);
  await asynchronous.close();
});

test('invalid stock rate steps, foreign acknowledgements and excessive pending feedback fail explicitly', async () => {
  const f = fixture();
  for (const value of [0, 49, 51, 20050, NaN]) assert.throws(() => f.bridge.setBitrate(value));
  assert.throws(() => f.acknowledge(99, 'idr'), /Unsolicited/);
  const retired = [];
  for (let index = 0; index < 4; index++) retired.push(assert.rejects(f.bridge.requestKeyFrame(), { name: 'AbortError' }));
  assert.throws(() => f.bridge.requestKeyFrame(), /queue exceeded/);
  await f.close(); await Promise.all(retired);
  assert.equal(f.bridge.liveRequests.size, 0);
});

test('a native release resumes the pipe only after the bounded framer has consumed its blocked packet', async () => {
  const f = fixture();
  f.bridge.liveFrames.push = () => false;
  f.bridge.child.stdio[3].emit('data', Buffer.from([1]));
  assert.equal(f.bridge.packetBackpressured, true);
  assert.equal(f.bridge.child.stdio[3].isPaused(), true);
  f.bridge.liveFrames.drain = () => false;
  f.bridge.resumePackets(); assert.equal(f.bridge.child.stdio[3].isPaused(), true);
  f.bridge.liveFrames.drain = () => true;
  f.bridge.resumePackets();
  assert.equal(f.bridge.packetBackpressured, false);
  assert.equal(f.bridge.child.stdio[3].isPaused(), false);
  await f.close();
});

test('owner cancellation still requires native teardown, exact process exit and live EOF before capture OFF', async () => {
  for (const corrupt of [null, 'sourceReleased', 'exit', 'eof', 'liveEof']) {
    const f = fixture(), controller = new AbortController();
    controller.abort(new DOMException('Owner stopped.', 'AbortError'));
    Object.assign(f.bridge, {
      prepareStarted: true, signal: controller.signal, firstError: controller.signal.reason,
      closed: true, exit: { code: 0, signal: null }, processExit: { code: 0, signal: null },
      eof: { stdout: true, stderr: true }, liveEof: true, exited: Promise.resolve(),
      stopped: { retirement: { outputStopped: true, callbacksQuiesced: true, sourceReleased: true,
        encoderReleased: true, obsShutdownReturned: true }, observation: { outputPackets: 0 } },
    });

    f.bridge.liveFrames.closed = { packets: 0 };
    if (corrupt === 'sourceReleased') f.bridge.stopped.retirement.sourceReleased = false;
    else if (corrupt === 'exit') f.bridge.exit.code = 1;
    else if (corrupt === 'eof') f.bridge.eof.stdout = false;
    else if (corrupt === 'liveEof') f.bridge.liveEof = false;
    if (corrupt) {
      await assert.rejects(f.bridge.stop(), /retirement/);
      assert.equal(f.bridge.snapshot().nativeClosed, false);
    } else {
      const result = await f.bridge.stop();
      assert.equal(result.nativeClosed, true); assert.equal(result.cancelled, true);
      assert.equal(result.closeReason, 'requested-after-error');
    }
    f.bridge.child.emit('close'); f.bridge.detach();
    f.bridge.child.stdio[3].destroy(); f.bridge.child.stdio[4].destroy();
  }
});

test('native failure crosses the media pipe before control EOF without losing its cause or faking retirement', async () => {
  for (const corrupt of [null, 'encoderReleased', 'exit', 'liveEof']) {
    const f = fixture();
    const failure = { code: 'ERR_SCREEN_CAPTURE_VIDEO', message: 'Native geometry was not accepted.' };
    f.bridge.receiveLive({ type: 'closed', value: { kind: 'closed', runId: f.bridge.runId, failure } });
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].code, failure.code);
    assert.equal(f.errors[0].message, failure.message);
    Object.assign(f.bridge, {
      prepareStarted: true, closed: true, exit: { code: 1, signal: null }, processExit: { code: 1, signal: null },
      eof: { stdout: true, stderr: true }, liveEof: true, exited: Promise.resolve(),
      failure: { type: 'error', error: failure, retirement: { outputStopped: true, callbacksQuiesced: true,
        sourceReleased: true, encoderReleased: true, obsShutdownReturned: true }, observation: { outputPackets: 0 } },
    });
    f.bridge.liveFrames.closed = { packets: 0, failure };
    if (corrupt === 'encoderReleased') f.bridge.failure.retirement.encoderReleased = false;
    else if (corrupt === 'exit') f.bridge.exit.code = 0;
    else if (corrupt === 'liveEof') f.bridge.liveEof = false;
    if (corrupt) {
      await assert.rejects(f.bridge.stop(), error => error instanceof AggregateError
        && error.errors[0].code === failure.code);
      assert.equal(f.bridge.nativeClosed, false);
    } else {
      await assert.rejects(f.bridge.stop(), { code: failure.code, message: failure.message });
      assert.equal(f.bridge.nativeClosed, true);
      assert.equal(f.bridge.closeReason, 'failed');
    }
    f.bridge.detach();
    f.bridge.child.stdio[3].destroy(); f.bridge.child.stdio[4].destroy();
  }
});
