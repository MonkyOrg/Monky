'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const protocol = require('../runtime/captureProtocol.cjs');
const { probeCaptureCapabilities } = require('../runtime/captureBridge.cjs');

const runId = 'a'.repeat(32);
const video = Object.freeze({ width: 1280, height: 720, fps: 60, bitrateKbps: 5000 });
const retirement = Object.freeze({
  outputStopped: true, callbacksQuiesced: true, sourceReleased: true, encoderReleased: true, obsShutdownReturned: true,
});
const directory = path.resolve(__dirname, 'owned-encoder-probe-fixture');
const options = {
  host: { kind: 'verified-native-screen-capture-host', executable: path.join(directory, 'host.exe'), sha256: 'a'.repeat(64) },
  runtime: { kind: 'verified-stock-obs-runtime', version: '32.1.1', stockDirectory: directory, binaryDirectory: directory },
  runId, runDirectory: path.join(directory, `monky-screen-capture-${runId}`), video,
};

function capability(encoder) {
  return { encoderId: encoder, codec: 'h264', adapterIndex: 0, adapterLuid: '456',
    vendorId: protocol.ENCODERS[encoder].vendorId, deviceId: 123,
    probe: protocol.ENCODERS[encoder].probe, probeVerified: true, textureInput: true, dynamicBitrate: true };
}

function message(encoder, type = 'prepared', initialized = true, selectedVideo = video) {
  return {
    schemaVersion: 1, kind: 'encoder-probe', type, runId, sequence: type === 'stopped' ? 1 : 0,
    helperProcessId: 42, qpc: type === 'prepared' ? '1000' : '1001', qpcFrequency: '10000000',
    video: { ...selectedVideo }, captureKinds: initialized ? ['window', 'monitor', 'game'] : [],
    capability: initialized ? capability(encoder) : null, encoderInitialized: initialized,
    sourceCaptured: false, outputPackets: 0,
    ...(type === 'prepared' ? {} : { retirement: { ...retirement } }),
    ...(type === 'error' ? { error: { code: 'ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION', message: 'Synthetic driver refusal.' } } : {}),
  };
}

function fixture(settings = {}) {
  const encoder = settings.encoder ?? 'obs_nvenc_h264_tex';
  const selectedVideo = settings.scaleMode ? { ...video, scaleMode: settings.scaleMode } : video;
  const child = new EventEmitter(), commands = [], kills = [], seen = [];
  let closed = false, spawned = false, preparedSent = false, errorSent = false, finishQueued = false;
  child.pid = 42; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const finish = (code = settings.exitCode ?? (errorSent ? 1 : 0), signal = null) => {
    if (finishQueued) return;
    finishQueued = true;
    child.stdout.end(); child.stderr.end();
    setImmediate(() => {
      closed = true;
      child.emit('exit', code, signal); child.emit('close', code, signal);
    });
  };
  const send = value => { seen.push(structuredClone(value)); child.stdout.write(JSON.stringify(value) + '\n'); };
  child.stdin = new Writable({
    write(bytes, _encoding, done) {
      const command = bytes.toString('ascii');
      commands.push(command); done();
      assert.equal(command, '1 stop\n');
      if (settings.hangOnStop) return;
      queueMicrotask(() => {
        if (!errorSent) {
          const stopped = message(encoder, 'stopped', preparedSent, selectedVideo);
          settings.corruptStopped?.(stopped);
          send(stopped);
        }
        if (!settings.holdExit) finish();
      });
    },
  });
  child.stdio = [child.stdin, child.stdout, child.stderr];
  child.kill = signal => { kills.push({ pid: child.pid, signal }); finish(null, signal); return true; };
  const dependencies = {
    deadlines: { prepare: 100, stop: 50, exit: 50 },
    spawnProcess(executable, args, spawnOptions) {
      spawned = true;
      assert.equal(executable, options.host.executable);
      assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(spawnOptions.windowsHide, true);
      assert.equal(args.length, 10); assert.ok(args.includes('--probe=encoder'));
      assert.ok(args.includes(`--scale-mode=${settings.scaleMode ?? 'stretch'}`));
      assert.equal(args.some(value => /^--(?:hwnd|pid|kind|process-created|monitor-)/u.test(value)), false);
      settings.checkArguments?.(args);
      queueMicrotask(() => {
        settings.afterSpawn?.();
        if (settings.neverPrepare) return;
        if (settings.nativeError) {
          errorSent = true;
          send(message(encoder, 'error', false, selectedVideo));
        } else {
          const prepared = message(encoder, 'prepared', true, selectedVideo);
          settings.corruptPrepared?.(prepared);
          preparedSent = true; send(prepared);
        }
      });
      return child;
    },
  };
  return { child, commands, kills, seen, dependencies, finish,
    get closed() { return closed; }, get spawned() { return spawned; },
    async dispose() {
      if (spawned && !finishQueued) finish();
      await new Promise(resolve => setImmediate(resolve));
      for (const stream of child.stdio) stream.destroy();
      assert.equal(child.listenerCount('close'), 0);
      assert.equal(child.stdout.listenerCount('data'), 0);
      assert.equal(child.stderr.listenerCount('data'), 0);
    },
  };
}

test('source-free probe proves encoder initialization and returns only after clean retirement and process exit', async () => {
  for (const [encoder, scaleMode] of Object.keys(protocol.ENCODERS).flatMap(encoder => [[encoder, undefined], [encoder, 'fit']])) {
    const selectedVideo = scaleMode ? { ...video, scaleMode } : video;
    const f = fixture({ encoder, scaleMode, holdExit: true,
      checkArguments: args => assert.ok(args.includes(`--encoder=${encoder}`)) });
    try {
      let resolved = false;
      const pending = probeCaptureCapabilities({ ...options, encoder, video: selectedVideo }, undefined, f.dependencies)
        .then(result => { resolved = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(f.commands, ['1 stop\n']);
      assert.equal(resolved, false); assert.equal(f.closed, false);
      f.finish();
      const result = await pending;
      assert.equal(f.closed, true);
      assert.deepEqual(result, {
        ...capability(encoder), encoderInitialized: true, hardwareSessionConfirmed: false,
        hardwareQualified: false, sourceCaptured: false, captureKinds: ['window', 'monitor', 'game'],
        video: { ...video, scaleMode: scaleMode ?? 'stretch' },
      });
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.captureKinds), true);
      assert.equal(Object.isFrozen(result.video), true);
      assert.equal(Object.hasOwn(result, 'target'), false);
      assert.deepEqual(f.kills, []);
    } finally { await f.dispose(); }
  }
});

test('encoder probe auto selection reports the verified encoder without requesting a hidden source', async () => {
  const f = fixture({ checkArguments: args => assert.ok(args.includes('--encoder=auto')) });
  try {
    const result = await probeCaptureCapabilities(options, undefined, f.dependencies);
    assert.equal(result.encoderId, 'obs_nvenc_h264_tex');
    assert.equal(result.probeVerified, true); assert.equal(result.encoderInitialized, true);
    assert.deepEqual(f.commands, ['1 stop\n']);
  } finally { await f.dispose(); }
});

test('encoder probe rejects source options and invalid profiles before starting any process', async () => {
  const f = fixture();
  try {
    for (const extra of [{ target: {} }, { kind: 'window' }, { hwnd: 19 }, { monitorIndex: 0 },
      { video: { ...video, width: 854 } }, { encoder: 'x264' }])
      await assert.rejects(probeCaptureCapabilities({ ...options, ...extra }, undefined, f.dependencies));
    assert.equal(f.spawned, false);
  } finally { await f.dispose(); }
});

test('probe protocol rejects static vendor evidence, source activity and foreign or changing identities', () => {
  const prepared = message('obs_nvenc_h264_tex'), stopped = message('obs_nvenc_h264_tex', 'stopped');
  const expected = { source: null, runId, helperProcessId: 42, video, encoder: 'obs_nvenc_h264_tex' };
  protocol.validateEncoderProbeMessage(prepared, expected);
  protocol.validateEncoderProbeMessage(stopped, expected);
  protocol.validateEncoderProbeProgress(prepared, stopped);
  for (const corrupt of [
    value => { value.encoderInitialized = false; },
    value => { value.capability = null; },
    value => { value.capability.probeVerified = false; },
    value => { value.capability.probe = 'vendor-name'; },
    value => { value.capability.adapterIndex = 1; },
    value => { value.captureKinds = ['window', 'monitor', 'game', 'camera']; },
    value => { value.sourceCaptured = true; },
    value => { value.outputPackets = 1; },
    value => { value.target = null; },
    value => { value.hwnd = 0; },
    value => { value.helperProcessId = 43; },
    value => { value.runId = 'b'.repeat(32); },
    value => { value.kind = 'window'; },
    value => { value.type = 'ready'; },
    value => { value.video.fps = 30; },
    value => { value.hardwareQualified = true; },
  ]) {
    const copy = structuredClone(prepared); corrupt(copy);
    assert.throws(() => protocol.validateEncoderProbeMessage(copy, expected));
  }
  for (const corrupt of [
    value => { value.capability.adapterLuid = '457'; },
    value => { value.encoderInitialized = false; },
    value => { value.video.width = 1920; },
    value => { value.qpc = '999'; },
    value => { value.type = 'prepared'; },
  ]) {
    const copy = structuredClone(stopped); corrupt(copy);
    assert.throws(() => protocol.validateEncoderProbeProgress(prepared, copy));
  }
  assert.throws(() => protocol.validateEncoderProbeProgress(stopped, stopped));
});

test('native encoder refusal remains an error after verified source-free cleanup', async () => {
  const f = fixture({ nativeError: true });
  try {
    await assert.rejects(probeCaptureCapabilities(options, undefined, f.dependencies),
      { code: 'ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION', message: 'Synthetic driver refusal.' });
    assert.equal(f.closed, true); assert.deepEqual(f.kills, []);
  } finally { await f.dispose(); }
});

test('cancellation before spawn or during preparation never becomes probe availability', async () => {
  for (const beforeSpawn of [true, false]) {
    const controller = new AbortController();
    const f = fixture({ neverPrepare: true, afterSpawn: () => controller.abort() });
    try {
      if (beforeSpawn) controller.abort();
      await assert.rejects(probeCaptureCapabilities(options, controller.signal, f.dependencies), { name: 'AbortError' });
      assert.equal(f.spawned, !beforeSpawn);
      if (!beforeSpawn) {
        assert.equal(f.closed, true); assert.deepEqual(f.commands, ['1 stop\n']);
        assert.equal(f.seen.at(-1).encoderInitialized, false);
      }
      assert.deepEqual(f.kills, []);
    } finally { await f.dispose(); }
  }
});

test('unconfirmed initialization, incorrect requested encoder and malformed retirement never return capabilities', async () => {
  for (const settings of [
    { corruptPrepared: value => { value.encoderInitialized = false; } },
    { encoder: 'h264_texture_amf' },
    { corruptStopped: value => { value.retirement.encoderReleased = false; } },
    { exitCode: 1 },
  ]) {
    const f = fixture(settings);
    try {
      await assert.rejects(probeCaptureCapabilities({ ...options, encoder: 'obs_nvenc_h264_tex' }, undefined, f.dependencies));
      assert.equal(f.closed, true); assert.deepEqual(f.kills, []);
    } finally { await f.dispose(); }
  }
});

test('probe timeout terminates only its owned helper and never reports verified retirement', async () => {
  const f = fixture({ neverPrepare: true, hangOnStop: true });
  try {
    await assert.rejects(probeCaptureCapabilities(options, undefined, {
      ...f.dependencies, deadlines: { prepare: 10, stop: 10, exit: 10 },
    }), error => error instanceof AggregateError && /retirement/u.test(error.message));
    assert.deepEqual(f.kills, [{ pid: 42, signal: 'SIGTERM' }]);
    assert.equal(f.closed, true);
  } finally { await f.dispose(); }
});

test('native encoder-only mode reuses initialization without selecting, creating or starting a source', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'capture', 'host.cpp'), 'utf8');
  assert.match(host, /int Execute\(\) noexcept \{\s*try \{\s*watchdog_ = [^\n]+\n\s*if \(!arguments_\.encoderProbe\) \{\s*target_ = BindTarget\(arguments_\);/u);
  assert.equal((host.match(/BindTarget\(/gu) ?? []).length, 2);
  assert.doesNotMatch(host.slice(host.indexOf('int wmain(')), /BindTarget\(/u);
  assert.match(host, /const bool gameHooks = !arguments_\.encoderProbe && arguments_\.kind == CaptureKind::Game/u);
  assert.match(host, /ValidateCommandMode\(arguments_, \*command\)/u);
  assert.match(host, /if \(!arguments_\.encoderProbe\) \{\s*live_ =/u);
  const preparation = host.slice(host.indexOf('    if (arguments_.encoderProbe) {\n      BeginStage(NativeStage::EncoderProbe);'),
    host.indexOf('    if (life_.Prepared())'));
  assert.match(preparation, /BindMainCanvas\(\);[\s\S]*CreateEncoderOutput\(\);[\s\S]*InitializeEncoder\(\);/u);
  assert.doesNotMatch(preparation, /StartSource|SourceSettings|BindTarget|obs_output_start|begin_data_capture|load_graphics_offsets/u);
  assert.match(host, /Require\(!arguments_\.encoderProbe, "Encoder probing cannot create a capture source"/u);
  assert.match(host, /Require\(!host\.arguments_\.encoderProbe, "Encoder probing cannot start data capture"/u);
});

test('capture waits for the first encoded packet before requesting lazy NVENC parameter sets', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'capture', 'host.cpp'), 'utf8');
  const initialization = host.slice(host.indexOf('  void InitializeEncoder() {'), host.indexOf('  void CheckProbeIsolation() {'));
  assert.doesNotMatch(initialization, /obs_encoder_get_extra_data|SetPrefix/u);
  const start = host.slice(host.indexOf('  static bool __cdecl OutputStart('), host.indexOf('  static void __cdecl OutputStop('));
  assert.match(start, /InitializeEncoder\(\);[\s\S]*obs_output_begin_data_capture/u);
  const callback = host.slice(host.indexOf('  static void __cdecl EncodedPacket('), host.indexOf('\n private:', host.indexOf('  static void __cdecl EncodedPacket(')));
  assert.match(callback, /if \(packet->keyframe\) \{[\s\S]*obs_encoder_get_extra_data[\s\S]*extra && size > 0 && size <= kMaxPacketBytes/u);
  assert.match(callback, /CompleteH264Keyframe[\s\S]*Count\(\) == 0\) host\.buffer_\.SetPrefix\(parameterSets\);[\s\S]*host\.buffer_\.Add[\s\S]*host\.live_->Packet/u);
});

test('AMF declares input primaries and verifies the exact fixed option without relaxing H264 colour admission', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'capture', 'host.cpp'), 'utf8');
  assert.match(host, /const auto options = EncoderProfileOptions\(capability_\.encoder, arguments_\.video\);[\s\S]*obs_data_set_string\(encoderSettings_, "ffmpeg_opts", options\.c_str\(\)\)/u);
  assert.match(host, /obs_data_get_string\(settings\.value, nvenc \? "opts" : "ffmpeg_opts"\), 64\) ==\s*EncoderProfileOptions\(capability_\.encoder, arguments_\.video\)/u);
});
