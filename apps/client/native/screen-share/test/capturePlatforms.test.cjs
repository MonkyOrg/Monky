'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const protocol = require('../runtime/captureProtocol.cjs');
const { CaptureBridge } = require('../runtime/captureBridge.cjs');
const { bindGameSource, bindMonitorSource } = require('../scripts/captureSourceBindings.cjs');
const { fingerprint } = require('../scripts/buildTools.cjs');

const runId = 'a'.repeat(32);
const video = { width: 1280, height: 720, fps: 60, bitrateKbps: 5000 };
const windowTarget = Object.freeze({
  kind: 'window', hwnd: 19, expectedProcessId: 10, expectedProcessCreationTime100ns: '123456789',
});
const gameTarget = Object.freeze({ ...windowTarget, kind: 'game' });
const monitorTarget = Object.freeze({
  kind: 'monitor', deviceId: String.raw`\\?\DISPLAY#OWNED-FIXTURE#{1234}`,
  deviceName: String.raw`\\.\DISPLAY2`, bounds: Object.freeze({ x: -1920, y: 0, width: 1920, height: 1080 }),
});
const key = { title: 'Owned fixture', className: 'MonkyCaptureFixture', executable: 'fixture.exe' };
const retirement = { outputStopped: true, callbacksQuiesced: true, sourceReleased: true,
  encoderReleased: true, obsShutdownReturned: true };

function capability(encoder) {
  const selected = protocol.ENCODERS[encoder];
  return { encoderId: encoder, codec: selected.codec, adapterIndex: 0, adapterLuid: '456',
    vendorId: selected.vendorId ?? 0x8086, deviceId: 123,
    probe: selected.probe, probeVerified: true, textureInput: selected.mode === 'hardware', dynamicBitrate: true };
}

function message(target, encoder, type = 'prepared', selectedVideo = video) {
  const started = type === 'ready' || type === 'stats';
  return {
    schemaVersion: 2, type, runId, sequence: type === 'prepared' ? 0 : type === 'ready' ? 1 : 2,
    helperProcessId: 42, hwnd: target.kind === 'monitor' ? 0 : target.hwnd,
    processId: target.kind === 'monitor' ? 0 : target.expectedProcessId,
    processCreationTime100ns: target.kind === 'monitor' ? '0' : target.expectedProcessCreationTime100ns,
    qpc: started ? '1002' : '1000', qpcFrequency: '10000000',
    target: structuredClone(target), capability: capability(encoder),
    configuration: protocol.configuration(selectedVideo, encoder, target.kind),
    sourceKey: target.kind === 'monitor' ? null : key,
    hookedKey: started && target.kind !== 'monitor' ? key : null,
    observation: {
      state: type === 'prepared' ? 'prepared' : type === 'stopped' ? 'stopped' : 'running',
      sourceAttached: started, sourceWidth: started ? target.kind === 'monitor' ? target.bounds.width : 800 : null,
      sourceHeight: started ? target.kind === 'monitor' ? target.bounds.height : 600 : null,
      outputPackets: started ? 1 : 0, outputBytes: started ? 5 : 0, keyframes: started ? 1 : 0, bufferedBytes: 0,
      firstPts: started ? '0' : null, lastPts: started ? '0' : null, lastDts: started ? '0' : null,
      timebaseNumerator: started ? 1 : null, timebaseDenominator: started ? 60 : null,
      firstPacketQpc: started ? '1001' : null, obsTotalFrames: started ? 1 : 0, obsLaggedFrames: 0,
      sourceFrames: null, sourceFrameTimestamp: null, sourceContinuity: null,
    },
    ...(type === 'stopped' ? { retirement } : {}),
  };
}

test('targets bind exact windows/process births and monitor device interfaces/physical bounds', () => {
  for (const target of [windowTarget, gameTarget, monitorTarget, { hwnd: 19, expectedProcessId: 10 }]) {
    assert.equal(protocol.validateSource(target), target);
    const clone = protocol.cloneSource(target);
    assert.deepEqual(clone, target);
    assert.equal(Object.isFrozen(clone), true);
    if (clone.kind === 'monitor') assert.equal(Object.isFrozen(clone.bounds), true);
  }
  for (const invalid of [
    { kind: 'game', hwnd: 19, expectedProcessId: 10 },
    { ...gameTarget, expectedProcessCreationTime100ns: '0' },
    { ...gameTarget, expectedProcessCreationTime100ns: '0123' },
    { ...gameTarget, expectedProcessCreationTime100ns: 123 },
    { ...gameTarget, expectedProcessCreationTime100ns: '18446744073709551616' },
    { ...windowTarget, hwnd: Number.MAX_SAFE_INTEGER + 1 },
    { ...monitorTarget, monitorIndex: 0 }, { ...monitorTarget, deviceId: '0' },
    { ...monitorTarget, deviceId: String.raw`\\.\DISPLAY2` },
    { ...monitorTarget, deviceId: monitorTarget.deviceId + '\0' },
    { ...monitorTarget, deviceId: monitorTarget.deviceId + '\t' },
    { ...monitorTarget, deviceId: monitorTarget.deviceId + '\u00e9' },
    { ...monitorTarget, deviceId: String.raw`\\?\DISPLAY#` + 'x'.repeat(128) },
    { ...monitorTarget, deviceName: String.raw`\\.\DISPLAY0` },
    { ...monitorTarget, bounds: { x: 0, y: 0, width: 0, height: 1080 } },
    { ...monitorTarget, bounds: { x: 0x7fffffff, y: 0, width: 1920, height: 1080 } },
    { ...monitorTarget, bounds: { ...monitorTarget.bounds, primary: true } },
    { ...monitorTarget, hwnd: 19 }, { ...windowTarget, kind: 'desktop' },
  ]) assert.throws(() => protocol.validateSource(invalid));
  assert.deepEqual(protocol.argumentsForTarget(gameTarget), [
    '--hwnd=19', '--pid=10', '--kind=game', '--process-created=123456789',
  ]);
  const argumentsForMonitor = protocol.argumentsForTarget(monitorTarget);
  assert.ok(argumentsForMonitor.includes('--monitor-x=-1920'));
  assert.ok(argumentsForMonitor.includes(`--monitor-id=${monitorTarget.deviceId}`));
  assert.equal(argumentsForMonitor.some(value => /(?:hwnd|pid|primary|index)=/u.test(value)), false);
});

test('codec and encoding-mode schemas cannot be relabelled or enabled without a probe', () => {
  for (const target of [windowTarget, monitorTarget, gameTarget])
    for (const encoder of Object.keys(protocol.ENCODERS)) {
      const prepared = message(target, encoder), ready = message(target, encoder, 'ready');
      const expected = { source: target, video, runId, helperProcessId: 42, encoder };
      protocol.validateMessage(prepared, expected); protocol.validateMessage(ready, expected);
      protocol.validateProgress(prepared, ready);
      for (const corrupt of [
        value => { value.capability.probeVerified = false; },
        value => { value.capability.textureInput = !value.capability.textureInput; },
        value => { value.capability.dynamicBitrate = false; },
        value => { value.capability.vendorId = protocol.ENCODERS[encoder].mode === 'hardware' ? 0x8086 : -1; },
        value => { value.capability.codec = value.capability.codec === 'av1' ? 'h264' : 'av1'; },
        value => { value.capability.adapterIndex = 1; },
        value => { value.capability.probe = 'vendor-name'; },
        value => { value.capability.hardwareQualified = true; },
        value => { value.configuration.rateControl = encoder === 'h264_texture_amf' ? 'CBR' : 'VBR_LAT'; },
        value => { value.configuration.encoderId = 'x264'; },
        value => { value.configuration.method = target.kind === 'game' ? 'wgc' : 'game-hook'; },
        value => { value.target.kind = 'any-fullscreen'; },
        value => { value.processCreationTime100ns = '5'; },
        value => { value.capability = null; },
      ]) {
        const copy = structuredClone(prepared); corrupt(copy);
        assert.throws(() => protocol.validateMessage(copy, expected));
      }
      const changed = structuredClone(ready);
      changed.target = target.kind === 'monitor'
        ? { ...changed.target, bounds: { ...changed.target.bounds, width: 1280 } }
        : { ...changed.target, expectedProcessCreationTime100ns: '456' };
      assert.throws(() => protocol.validateProgress(prepared, changed));
    }
  for (const encoder of ['x264', 'ffmpeg_nvenc', 'obs_nvenc_h264_soft', 'av1', 'jim_nvenc', '', null, ['h264_texture_amf']])
    assert.throws(() => protocol.validateEncoder(encoder));
  assert.equal(protocol.validateEncoder('auto'), 'auto');
});

test('capture scaling is explicit, defaults to stretch and cannot silently change after admission', () => {
  assert.deepEqual(protocol.normalizedVideo(video), { ...video, scaleMode: 'stretch' });
  for (const target of [windowTarget, monitorTarget, gameTarget]) {
    for (const scaleMode of ['stretch', 'fit']) {
      const selectedVideo = { ...video, scaleMode };
      const prepared = message(target, 'h264_texture_amf', 'prepared', selectedVideo);
      const ready = message(target, 'h264_texture_amf', 'ready', selectedVideo);
      const expected = { source: target, video: selectedVideo, runId, helperProcessId: 42 };
      protocol.validateMessage(prepared, expected); protocol.validateMessage(ready, expected);
      protocol.validateProgress(prepared, ready);
      ready.configuration.scaleMode = scaleMode === 'fit' ? 'stretch' : 'fit';
      assert.throws(() => protocol.validateMessage(ready, expected));
      assert.throws(() => protocol.validateProgress(prepared, ready));
      delete prepared.configuration.scaleMode;
      assert.throws(() => protocol.validateMessage(prepared, expected));
    }
  }
  for (const scaleMode of [undefined, null, '', 'crop', 'Fit', true, 1, {}])
    assert.throws(() => protocol.validateVideo({ ...video, scaleMode }));
});

test('minimized games and temporarily unavailable monitor frames remain distinct from source disappearance', () => {
  for (const target of [gameTarget, monitorTarget]) {
    const ready = message(target, 'obs_nvenc_h264_tex', 'ready');
    const paused = message(target, 'obs_nvenc_h264_tex', 'stats');
    paused.observation.sourceAttached = false;
    protocol.validateMessage(paused, { source: target, video, runId, helperProcessId: 42 });
    protocol.validateProgress(ready, paused);
    const error = structuredClone(paused);
    error.type = 'error'; error.observation.state = 'failed'; error.retirement = retirement;
    error.error = { code: target.kind === 'monitor' ? 'ERR_SCREEN_CAPTURE_MONITOR_LOST' : 'ERR_SCREEN_CAPTURE_SOURCE_LOST',
      message: 'Owned source identity disappeared; no fallback source was selected.' };
    protocol.validateMessage(error);
  }
});

test('bridge preserves discriminated targets and only reports hardware-session confirmation after real readiness', async () => {
  for (const target of [windowTarget, monitorTarget, gameTarget]) {
    const selectedVideo = { ...video, scaleMode: target.kind === 'game' ? 'fit' : 'stretch' };
    const child = new EventEmitter();
    child.pid = 42; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_bytes, _encoding, done) { done(); } });
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(),
      new Writable({ write(_bytes, _encoding, done) { done(); } })];
    const directory = path.resolve(__dirname, 'owned-capture-fixture'), errors = [];
    const bridge = new CaptureBridge({
      host: { kind: 'verified-native-screen-capture-host', executable: path.join(directory, 'host.exe'), sha256: 'a'.repeat(64) },
      runtime: { kind: 'verified-stock-obs-runtime', version: '32.1.1', stockDirectory: directory, binaryDirectory: directory },
      runId, runDirectory: path.join(directory, `monky-screen-capture-${runId}`), video: selectedVideo, encoder: 'obs_nvenc_h264_tex',
      onError: error => errors.push(error), onPacket() {}, onNotice() {},
    }, {
      spawnProcess(_executable, args) {
        for (const argument of protocol.argumentsForTarget(target)) assert.ok(args.includes(argument));
        assert.ok(args.includes('--encoder=obs_nvenc_h264_tex'));
        assert.ok(args.includes(`--scale-mode=${selectedVideo.scaleMode}`));
        queueMicrotask(() => child.stdout.write(JSON.stringify(message(target, 'obs_nvenc_h264_tex', 'prepared', selectedVideo)) + '\n'));
        return child;
      },
    });
    try {
      assert.equal(bridge.getCapabilities(), null);
      await bridge.prepare(target);
      assert.deepEqual(bridge.source, target);
      assert.deepEqual(bridge.getCapabilities(), { ...capability('obs_nvenc_h264_tex'),
        mode: 'hardware', hardwareSessionConfirmed: false, hardwareQualified: false });
      const foreign = target.kind === 'monitor'
        ? { ...target, bounds: { ...target.bounds, x: 0 } } : { ...target, kind: target.kind === 'game' ? 'window' : 'game' };
      await assert.rejects(bridge.start(foreign));
      assert.equal(bridge.started, false);
      const start = bridge.start(target);
      child.stdout.write(JSON.stringify(message(target, 'obs_nvenc_h264_tex', 'ready', selectedVideo)) + '\n');
      await start;
      assert.equal(bridge.getCapabilities().hardwareSessionConfirmed, true);
      assert.equal(bridge.getCapabilities().hardwareQualified, false);
      assert.deepEqual(errors, []);
    } finally {
      bridge.detach();
      for (const stream of child.stdio) stream.destroy();
    }
  }
});

test('source specializations preserve pinned vendors and bind before stock Game Capture can inject or render', () => {
  const vendor = path.join(__dirname, '..', 'src', 'vendor', 'obs');
  const manifest = require('../src/vendor/obs/sources.json');
  for (const [name, specialize] of [['game-capture', bindGameSource], ['duplicator-monitor-capture', bindMonitorSource]]) {
    const parts = ['plugins', 'win-capture', `${name}.c`], filename = path.join(vendor, ...parts);
    const pin = manifest.files.find(value => value.path === path.win32.join(...parts));
    assert.ok(pin);
    assert.deepEqual(fingerprint(filename), { bytes: pin.bytes, sha256: pin.sha256 });
    const original = fs.readFileSync(filename, 'utf8'), bound = specialize(original);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    assert.match(bound, /#include "sourceBinding\.h"/u);
    assert.match(bound, /identity_valid/u);
    if (name === 'game-capture') {
      const selectedWindow = bound.slice(bound.indexOf('static void get_selected_window('), bound.indexOf('static void try_hook('));
      assert.match(selectedWindow, /monky_game_window\(\)/u);
      assert.doesNotMatch(selectedWindow, /ms_find_window|FindWindow|GetForegroundWindow/u);
      assert.match(bound, /monky_open_bound_game_process\(open_process_proc/u);
      assert.match(bound, /monky_game_identity_matches\(gc->next_window, gc->process_id, gc->target_process\)/u);
      assert.match(bound, /!obs_data_get_bool\(settings, "anti_cheat_hook"\)/u);
    } else assert.match(bound, /monky_monitor_matches\(capture->handle, capture->monitor_id, capture->method\)/u);
    assert.throws(() => specialize(original.replace(name === 'game-capture'
      ? 'return open_process_proc(desired_access, inherit_handle, process_id);'
      : '\tcapture->source = source;', 'changed upstream implementation')));
  }
  const startup = fs.readFileSync(path.join(__dirname, '..', 'src', 'capture', 'wgc-plugin-main.c'), 'utf8');
  assert.doesNotMatch(startup, /update_info_create|ENABLE_COMPAT_UPDATES|init_hook_files|CreateThread/u);
  assert.match(startup, /if \(game_enabled\)/u);
  assert.match(startup, /load_graphics_offsets\(false, false, NULL\)/u);
  const files = require('../src/capture/runtime-additions.json');
  assert.equal(files.obsRevision, manifest.revision);
  assert.ok(files.files.some(file => file.path === 'obs-plugins\\64bit\\obs-nvenc.dll'));
  assert.ok(files.dependencies.some(file => file.path === 'include\\ffnvcodec\\nvEncodeAPI.h'));
});

test('WGC cadence specialization covers creation and device recovery without changing pinned sources', () => {
  const { configureWinrtSource } = require('../scripts/captureSourceBindings.cjs');
  const filename = path.join(__dirname, '..', 'src', 'vendor', 'obs', 'libobs-winrt', 'winrt-capture.cpp');
  const manifest = require('../src/vendor/obs/sources.json');
  const pin = manifest.files.find(value => value.path === 'libobs-winrt\\winrt-capture.cpp');
  assert.deepEqual(fingerprint(filename), { bytes: pin.bytes, sha256: pin.sha256 });
  const original = fs.readFileSync(filename, 'utf8');
  const specialized = configureWinrtSource(original);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  assert.equal(specialized.match(/MonkyConfigureWgcCadence\(session\);/gu).length, 2);
  assert.throws(() => configureWinrtSource(original.replace('frame_pool.CreateCaptureSession(item)', 'changed()')));
  const cadence = fs.readFileSync(path.join(__dirname, '..', 'src', 'capture', 'wgcCadence.h'), 'utf8');
  assert.match(cadence, /IsPropertyPresent/u);
  assert.match(cadence, /video\.fps_den \/ video\.fps_num \/ 2/u);
  assert.match(cadence, /session\.MinUpdateInterval/u);
});
