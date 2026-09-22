'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const protocol = require('../runtime/captureProtocol.cjs');
const { CaptureBridge } = require('../runtime/captureBridge.cjs');
const { HEADER_BYTES, MAGIC, LiveFrames, parseHeader } = require('../runtime/capturePackets.cjs');

const profiles = [
  { width: 1920, height: 1080, fps: 120, bitrateKbps: 5000 },
  { width: 1920, height: 1080, fps: 60, bitrateKbps: 4000 },
  { width: 1280, height: 720, fps: 60, bitrateKbps: 2500 },
  { width: 852, height: 480, fps: 30, bitrateKbps: 1000 },
];
const runId = 'a'.repeat(32);
const source = { hwnd: 19, expectedProcessId: 10 };
const key = { title: 'Owned synthetic source', className: 'MonkyScreenTest', executable: 'test.exe' };
const retirement = { outputStopped: true, callbacksQuiesced: true, sourceReleased: true,
  encoderReleased: true, obsShutdownReturned: true };
const closed = packets => ({ kind: 'closed', runId, packets, writtenPackets: packets, retainedFrames: 0,
  retainedBytes: 0, peakFrames: 1, peakBytes: 1024, workerDrained: true });

function notice(sequence, value, kind = 2) {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0); header.writeUInt32LE(kind, 4);
  header.writeUInt32LE(HEADER_BYTES, 8); header.writeUInt32LE(bytes.length, 12);
  header.writeBigUInt64LE(BigInt(sequence), 16);
  return Buffer.concat([header, bytes]);
}

function packet(sequence, frameId, fps) {
  const header = Buffer.alloc(HEADER_BYTES), data = Buffer.from([0, 0, 0, 1, frameId === 1 ? 0x65 : 0x41]);
  const timestamp = 1000000n + BigInt(frameId) * 1000000n / BigInt(fps);
  header.writeUInt32LE(MAGIC, 0); header.writeUInt32LE(1, 4);
  header.writeUInt32LE(HEADER_BYTES, 8); header.writeUInt32LE(data.length, 12);
  header.writeBigUInt64LE(BigInt(sequence), 16); header.writeBigUInt64LE(BigInt(frameId), 24);
  header.writeBigUInt64LE(timestamp * 10n, 32); header.writeBigUInt64LE(10000000n, 40);
  header.writeBigInt64LE(timestamp, 48); header.writeBigInt64LE(BigInt(frameId - 1), 56);
  header.writeBigInt64LE(BigInt(frameId - 2), 64); header.writeBigInt64LE(timestamp, 72);
  header.writeUInt32LE(1, 80); header.writeUInt32LE(fps, 84);
  header.writeUInt32LE(frameId === 1 ? 1 : 0, 88); header.writeUInt32LE(1000, 92);
  return Buffer.concat([header, data]);
}

function observation(video, type, sequence) {
  const started = type !== 'prepared', active = type === 'ready' || type === 'stats';
  return {
    schemaVersion: 1, type, runId, sequence, helperProcessId: 42, hwnd: source.hwnd,
    processId: source.expectedProcessId, processCreationTime100ns: '123456789', qpc: String(1000000 + sequence),
    qpcFrequency: '10000000', configuration: protocol.configuration(video),
    sourceKey: key, hookedKey: started ? key : null,
    observation: {
      state: type === 'prepared' ? 'prepared' : type === 'stopped' ? 'stopped' : 'running',
      sourceAttached: active, sourceWidth: started ? 800 : null, sourceHeight: started ? 600 : null,
      outputPackets: started ? 1 : 0, outputBytes: started ? 5 : 0, keyframes: started ? 1 : 0,
      bufferedBytes: 0, firstPts: started ? '0' : null, lastPts: started ? '0' : null,
      lastDts: started ? '-1' : null, timebaseNumerator: started ? 1 : null,
      timebaseDenominator: started ? video.fps : null, firstPacketQpc: started ? '1000001' : null,
      obsTotalFrames: started ? 1 : 0, obsLaggedFrames: 0, sourceFrames: null,
      sourceFrameTimestamp: null, sourceContinuity: null,
    },
    ...(type === 'stopped' ? { retirement } : {}),
  };
}

function admissionFailure(target = source, video = profiles[0]) {
  return {
    schemaVersion: 1, kind: 'capture-admission-error', type: 'error', runId, sequence: 0, helperProcessId: 42,
    qpc: '1000000', qpcFrequency: '10000000', target: structuredClone(target), video: { ...video }, encoder: 'auto',
    captureStarted: false, observation: { outputPackets: 0 }, retirement: { ...retirement },
    error: { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST', message: 'Selected window is no longer available.' },
  };
}

test('failed source admission identifies only the requested target and cannot fabricate initialization or packets', () => {
  for (const target of [
    source, { kind: 'window', ...source, expectedProcessCreationTime100ns: '123' },
    { kind: 'game', ...source, expectedProcessCreationTime100ns: '123' },
    { kind: 'monitor', deviceId: String.raw`\\?\DISPLAY#OWNED#ONE`, deviceName: String.raw`\\.\DISPLAY1`,
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  ]) {
    const message = admissionFailure(target);
    const expected = { source: target, video: profiles[0], runId, helperProcessId: 42, encoder: 'auto' };
    assert.equal(protocol.validateMessage(message, expected), message);
    for (const corrupt of [
      value => { value.helperProcessId++; }, value => { value.runId = 'b'.repeat(32); },
      value => { value.captureStarted = true; }, value => { value.observation.outputPackets = 1; },
      value => { value.target = { hwnd: 999, expectedProcessId: 888 }; },
      value => { value.video.fps--; }, value => { value.encoder = 'obs_nvenc_h264_tex'; },
      value => { value.retirement.encoderReleased = 'true'; }, value => { value.capability = {}; },
      value => { value.type = 'prepared'; }, value => { value.qpc = '0'; },
    ]) {
      const changed = structuredClone(message); corrupt(changed);
      assert.throws(() => protocol.validateMessage(changed, expected));
    }
    assert.throws(() => protocol.validateProgress(message, message), /first and terminal/);
    assert.throws(() => protocol.validateProgress(observation(profiles[0], 'prepared', 0), message), /first and terminal/);
  }
});

test('source admission rejection proves native retirement only with its full terminal, media EOF and exact child exit', async () => {
  for (const corrupt of [null, 'target', 'encoderReleased', 'media', 'exit']) {
    const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(_bytes, _encoding, done) { done(); } }) });
    const media = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, media, new PassThrough()];
    const directory = path.join(__dirname, 'capture-runtime-fixture');
    const failure = admissionFailure();
    if (corrupt === 'target') failure.target.hwnd++;
    if (corrupt === 'encoderReleased') failure.retirement.encoderReleased = false;
    const bridge = new CaptureBridge({
      host: { kind: 'verified-native-screen-capture-host', executable: path.join(directory, 'host.exe'), sha256: 'a'.repeat(64) },
      runtime: { kind: 'verified-stock-obs-runtime', version: '32.1.1', stockDirectory: directory, binaryDirectory: directory },
      runId, runDirectory: path.join(directory, `monky-screen-capture-${runId}`), video: profiles[0],
      onError() {}, onPacket() { assert.fail('A rejected source cannot capture media.'); }, onNotice() {},
    }, {
      spawnProcess() {
        queueMicrotask(() => {
          media.write(notice(1, { kind: 'hello', runId, processId: 42, protocol: 1,
            transmitterReencode: false, timestampSemantics: 'obs-system-pts' }));
          child.stdout.end(JSON.stringify(failure) + '\n');
          if (corrupt !== 'media') media.write(notice(2, { ...closed(0), failure: failure.error }, 3));
          media.end(); child.stderr.end();
          const code = corrupt === 'exit' ? 0 : 1;
          setImmediate(() => { child.emit('exit', code, null); child.emit('close', code, null); });
        });
        return child;
      },
    });
    try {
      await assert.rejects(bridge.prepare(source));
      await assert.rejects(bridge.stop());
      const snapshot = bridge.snapshot();
      assert.equal(snapshot.nativeClosed, corrupt === null);
      assert.equal(snapshot.forcedTermination, false);
      assert.equal(snapshot.events.prepared, 0);
      assert.equal(snapshot.events.ready, 0);
      assert.equal(snapshot.live.packets, 0);
      assert.equal(bridge.getCapabilities(), null);
      if (!corrupt) assert.equal(snapshot.failure.error.code, 'ERR_SCREEN_CAPTURE_SOURCE_LOST');
    } finally {
      bridge.detach();
      for (const stream of child.stdio) stream.destroy();
    }
  }
});

test('cancelling before PREPARED still verifies the requested terminal response and exact native retirement', async () => {
  for (const corrupt of [null, 'runId', 'sequence', 'encoderReleased']) {
    const video = profiles[0], errors = [], controller = new AbortController();
    const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough() });
    const media = new PassThrough(), feedback = new PassThrough();
    child.stdin = new Writable({
      write(bytes, _encoding, done) {
        const [sequence, verb] = bytes.toString().trim().split(' ');
        assert.equal(verb, 'stop');
        const terminal = observation(video, 'prepared', Number(sequence));
        terminal.type = 'stopped'; terminal.observation.state = 'stopped'; terminal.retirement = { ...retirement };
        if (corrupt === 'runId') terminal.runId = 'b'.repeat(32);
        if (corrupt === 'sequence') terminal.sequence++;
        if (corrupt === 'encoderReleased') terminal.retirement.encoderReleased = false;
        child.stdout.end(JSON.stringify(terminal) + '\n');
        media.end(notice(2, closed(0), 3));
        child.stderr.end();
        setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
        done();
      },
    });
    child.stdio = [child.stdin, child.stdout, child.stderr, media, feedback];
    const directory = path.join(__dirname, 'capture-runtime-fixture');
    const bridge = new CaptureBridge({
      host: { kind: 'verified-native-screen-capture-host', executable: path.join(directory, 'host.exe'), sha256: 'a'.repeat(64) },
      runtime: { kind: 'verified-stock-obs-runtime', version: '32.1.1', stockDirectory: directory, binaryDirectory: directory },
      runId, runDirectory: path.join(directory, `monky-screen-capture-${runId}`), video,
      onError: error => errors.push(error), onPacket() { assert.fail('Preparation cannot capture media.'); }, onNotice() {},
    }, {
      spawnProcess() {
        queueMicrotask(() => media.write(notice(1, { kind: 'hello', runId, processId: 42, protocol: 1,
          transmitterReencode: false, timestampSemantics: 'obs-system-pts' })));
        return child;
      },
    });
    try {
      const preparing = assert.rejects(bridge.prepare(source, controller.signal), { name: 'AbortError' });
      controller.abort(new DOMException('Owner stopped before preparation.', 'AbortError'));
      await preparing;
      if (corrupt) await assert.rejects(bridge.stop(), /retirement/);
      else await bridge.stop();
      const snapshot = bridge.snapshot();
      assert.equal(snapshot.events.prepared, 0);
      assert.equal(snapshot.events.ready, 0);
      assert.equal(snapshot.live.packets, 0);
      assert.equal(snapshot.nativeClosed, corrupt === null);
      assert.equal(snapshot.forcedTermination, false);
      assert.deepEqual(snapshot.exit, { code: 0, signal: null });
      assert.equal(errors[0].name, 'AbortError');
    } finally {
      bridge.detach();
      for (const stream of child.stdio) stream.destroy();
    }
  }
});

test('all capture profiles validate their actual geometry, frame clock and stretch without recording', () => {
  for (const video of profiles) {
    let previous;
    for (const [sequence, type] of ['prepared', 'ready', 'stats', 'stopped'].entries()) {
      const value = observation(video, type, sequence);
      protocol.validateMessage(value, { source, runId, helperProcessId: 42, video });
      if (previous) protocol.validateProgress(previous, value);
      previous = value;
    }
    const value = observation(video, 'stats', 90000);
    value.observation.outputPackets = 200000;
    value.observation.outputBytes = 999999999;
    protocol.validateMessage(value);
    const failure = observation(video, 'stopped', 90001);
    failure.type = 'error'; failure.observation.state = 'failed';
    failure.error = { code: 'ERR_SCREEN_CAPTURE_VIDEO', message: 'Synthetic encoder failure' };
    protocol.validateMessage(failure);
    failure.retirement = { ...failure.retirement, encoderReleased: false };
    protocol.validateMessage(failure);
    failure.retirement.encoderReleased = 'true';
    assert.throws(() => protocol.validateMessage(failure));
    for (const corrupt of [
      copy => { copy.configuration.scaleMode = 'crop'; },
      copy => { copy.configuration.width++; },
      copy => { copy.configuration.fpsNumerator = 121; },
      copy => { copy.observation.timebaseDenominator++; },
      copy => { copy.observation.bufferedBytes = 1; },
      copy => { copy.recording = {}; },
    ]) {
      const copy = structuredClone(value); corrupt(copy);
      assert.throws(() => protocol.validateMessage(copy));
    }
  }
  assert.equal(protocol.command(90001, 'stats'), '90001 stats\n');
  assert.throws(() => protocol.validateVideo({ ...profiles[3], width: 854 }));
  assert.throws(() => protocol.command(Number.MAX_SAFE_INTEGER + 1, 'stop'));
});

test('each profile runs beyond diagnostic packet limits with bounded framing and the selected duration', () => {
  for (const { fps } of profiles) {
    let last;
    const parser = new LiveFrames(value => { if (value.type === 'packet') last = value.frame; }, fps);
    parser.push(notice(1, { kind: 'hello' }));
    for (let frame = 1; frame <= 20001; frame++) {
      parser.push(packet(frame + 1, frame, fps));
      assert.equal(parser.pending.length, 0);
    }
    parser.push(notice(20003, closed(20001), 3)); parser.end();
    assert.equal(parser.packets, 20001);
    assert.equal(last.durationUs, Math.floor(1000000 / fps));
    assert.equal(last.timebaseDenominator, fps);
    assert.equal(Object.hasOwn(parser.lastFrame, 'data'), false);
    assert.throws(() => parseHeader(packet(1, 1, fps).subarray(0, HEADER_BYTES), fps === 30 ? 60 : 30));
  }
});

test('framing preserves exact compressed ownership across backpressure, fragmentation and retirement', () => {
  let allowed = false;
  const admitted = [], parser = new LiveFrames(value => {
    if (value.type !== 'packet') return;
    if (!allowed) return false;
    admitted.push(value.frame);
  }, 60);
  const pending = Buffer.concat([packet(2, 1, 60), packet(3, 2, 60), notice(4, closed(2), 3)]);
  assert.equal(parser.push(Buffer.concat([notice(1, { kind: 'hello' }), pending])), false);
  assert.deepEqual(parser.pending, pending);
  assert.equal(parser.sequence, 1); assert.equal(parser.packets, 0);
  assert.equal(parser.drain(), false); assert.deepEqual(admitted, []);
  allowed = true; assert.equal(parser.drain(), true); parser.end();
  assert.deepEqual(admitted.map(frame => frame.frameId), [1, 2]);
  assert.deepEqual(admitted[0].data, packet(2, 1, 60).subarray(HEADER_BYTES));
  assert.throws(() => parser.push(notice(5, {})), /after retirement/);
  const fragmented = new LiveFrames(() => {}, 30), bytes = notice(1, closed(0), 3);
  for (const byte of bytes) fragmented.push(Buffer.from([byte]));
  fragmented.end();
  const replay = new LiveFrames(() => {}, 30); replay.push(notice(1, {}));
  assert.throws(() => replay.push(notice(1, {})), /lost or replayed/);
  const split = new LiveFrames(() => {}, 30); split.push(bytes.subarray(0, 10));
  assert.throws(() => split.end(), /split packet/);
});

test('capture runs past 1 MiB and 256 commands without retaining completed requests or unbounded logs', async () => {
  const video = profiles[0], errors = [], child = new EventEmitter();
  child.pid = 42;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const media = new PassThrough();
  const feedback = new Writable({ write(_bytes, _encoding, done) { done(); } });
  const emit = (type, sequence) => child.stdout.write(JSON.stringify(observation(video, type, sequence)) + '\n');
  child.stdin = new Writable({
    write(bytes, _encoding, done) {
      const [id, verb] = bytes.toString().trim().split(' '), sequence = Number(id);
      if (verb === 'start') { media.write(packet(2, 1, video.fps)); emit('ready', sequence); }
      else if (verb === 'stats') emit('stats', sequence);
      else {
        emit('stopped', sequence); media.end(notice(3, closed(1), 3));
        child.stdout.end(); child.stderr.end();
        setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
      }
      done();
    },
  });
  child.stdio = [child.stdin, child.stdout, child.stderr, media, feedback];
  const fixture = path.join(__dirname, 'capture-runtime-fixture');
  const bridge = new CaptureBridge({
    host: { kind: 'verified-native-screen-capture-host', executable: path.join(fixture, 'host.exe'), sha256: 'a'.repeat(64) },
    runtime: { kind: 'verified-stock-obs-runtime', version: '32.1.1', stockDirectory: fixture, binaryDirectory: fixture },
    runId, runDirectory: path.join(fixture, `monky-screen-capture-${runId}`), video,
    onError: error => errors.push(error), onPacket() {}, onNotice() {},
  }, {
    spawnProcess(_executable, args) {
      assert.equal(args.length, 10); assert.ok(args.includes('--width=1920') && args.includes('--fps=120'));
      assert.ok(args.includes('--scale-mode=stretch'));
      queueMicrotask(() => {
        media.write(notice(1, { kind: 'hello', runId, processId: 42, protocol: 1,
          transmitterReencode: false, timestampSemantics: 'obs-system-pts' }));
        emit('prepared', 0);
      });
      return child;
    },
  });
  try {
    await bridge.prepare(source); await bridge.start(source);
    for (let index = 0; index < 1200; index++) {
      await bridge.getStats();
      assert.equal(bridge.requests.size, 0); assert.equal(bridge.pending.size, 0);
    }
    assert.ok(bridge.outputBytes > 1024 * 1024);
    for (let index = 0; index < 32; index++) child.stderr.write('x'.repeat(65536));
    assert.equal(Buffer.byteLength(bridge.stderr), 65536);
    assert.ok(bridge.outputBytes > 1024 * 1024 && bridge.sequence > 256);
    const result = await bridge.stop();
    assert.equal(result.nativeClosed, true); assert.equal(bridge.bindings.length, 0);
    assert.deepEqual(errors, []); assert.equal(result.live.queuedJavaScriptFrames, 0);
  } finally {
    bridge.detach();
    for (const stream of child.stdio) stream.destroy();
  }
});
