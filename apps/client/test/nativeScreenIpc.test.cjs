'use strict';

// Device-free IPC boundaries; the production publisher/subscription controllers
// run against a modeled endpoint. Native retirement is exercised by nativeAvSmoke.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const shared = require('@monky/shared');
const runtime = require('../native/screen-share/index.cjs');
const sourceFile = path.resolve(__dirname, '..', 'src', 'main', 'nativeScreenSharing.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const load = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname, console, process) { ${compiled}\n})`,
  { filename: sourceFile });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
const audio = { sinkId: 'selected-output', muted: false, volume: 1 };
const monitorTarget = {
  kind: 'monitor', deviceId: String.raw`\\?\DISPLAY#SELECTED#ONE`, deviceName: String.raw`\\.\DISPLAY2`,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
};
const monitorId = `native-monitor:${'a'.repeat(64)}`;

function fixture(t, { gpu, directory, role = 'publisher', platform = 'win32',
  encoder = 'h264_texture_amf', probeFailure, probeFailureBeforeSpawn, probeStop,
  probeVerified = true, probeRetires = true, probeStopReportsFailure = false } = {}) {
  const handlers = new Map(), sent = [], endpoints = [], selections = [], errors = [], captures = [], directories = [];
  const probes = [], removedDirectories = [];
  let target = { kind: 'window', hwnd: 12345, expectedProcessId: 56789,
    expectedProcessCreationTime100ns: '123456789' }, frameDestroyed = false, contentDestroyed = false;
  let windowOpen = true, windowPaused = false, creationTime = '123456789';
  let focused = true;
  let monitor = structuredClone(monitorTarget);
  const frame = { url: 'file:///C:/monky-test/index.html', detached: false, isDestroyed: () => frameDestroyed, postMessage() {} };
  const contents = new EventEmitter();
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => contentDestroyed, getURL: () => contents.mainFrame.url });
  const window = { webContents: contents, isDestroyed: () => false };
  const electron = {
    app: Object.assign(new EventEmitter(), {
      getGPUInfo: async () => assert.fail('Adapter labels cannot establish native hardware availability.'),
      getPath: () => path.join(__dirname, 'modeled-native-profile'),
    }),
    BrowserWindow: { getFocusedWindow: () => focused ? window : null },
    ipcMain: {
      handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    sharedTexture: {}, MessageChannelMain: class {
      constructor() {
        const port = () => Object.assign(new EventEmitter(), {
          start() {}, postMessage() {}, close() { this.emit('close'); },
        });
        this.port1 = port(); this.port2 = port();
      }
    },
  };
  class Probe {
    constructor(options) { this.options = options; this.closed = false; this.stopCalls = 0; probes.push(this); }
    async prepare(selected, signal) {
      signal.throwIfAborted();
      if (probeFailureBeforeSpawn) throw probeFailureBeforeSpawn;
      this.target = structuredClone(selected);
      this.child = Object.assign(new EventEmitter(), { pid: 90000 + probes.indexOf(this) });
      if (gpu) await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        void gpu.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      signal.throwIfAborted();
      if (probeFailure) { this.failure = probeFailure; throw probeFailure; }
      this.prepared = true;
    }
    start() { assert.fail('Source admission cannot start capture or inject a game.'); }
    getCapabilities() {
      return this.prepared ? {
        encoderId: encoder, codec: 'h264', adapterIndex: 0, adapterLuid: '00000000:00000001',
        vendorId: encoder === 'obs_nvenc_h264_tex' ? 0x10de : 0x1002, deviceId: 1,
        probe: encoder === 'obs_nvenc_h264_tex' ? 'nvenc-d3d11-session' : 'obs-amf-test',
        probeVerified, textureInput: true, dynamicBitrate: true, hardwareSessionConfirmed: false, hardwareQualified: false,
      } : null;
    }
    async stop() {
      this.stopCalls++;
      if (probeStop) await probeStop.promise;
      if (!this.closed && probeRetires) {
        this.closed = true;
        const code = this.failure ? 1 : 0;
        this.child?.emit('exit', code, null); this.child?.emit('close', code, null);
      }
      if (this.failure && probeStopReportsFailure) throw this.failure;
      return this.snapshot();
    }
    snapshot() { return { nativeClosed: true, forcedTermination: false }; }
  }
  class Endpoint {
    constructor(options) { this.options = options; this.ready = Promise.resolve(); this.closed = false; endpoints.push(this); }
    async setDemand(count, preview = false) {
      this.demand = count; this.previewDemand = preview;
      if (!count && !preview) await this.close();
    }
    async connectPeer() {}
    async closePeer() {}
    async receiveControl() {}
    async addRemoteProducer() {}
    async removeRemoteProducer() {}
    async setAudioPreferences(preferences) { this.preferences = preferences; }
    async diagnostics() {
      return { pipelineId: this.options.pipelineId, profile: shared.getScreenShareProfile(this.options.source.video, this.options.quality),
        readErrors: 0, rtp: [], decoders: [] };
    }
    async close() { this.closed = true; }
    snapshot() { return { closed: this.closed, nativeClosed: this.closed }; }
  }
  const captureModule = {
    isPacketCaptureSupported: () => true,
    getWindowState: hwnd => {
      assert.equal(hwnd, 12345);
      return windowOpen ? { processId: target.expectedProcessId, processCreationTime100ns: creationTime,
        isIconic: windowPaused, isVisible: !windowPaused, isTopLevel: true } : null;
    },
    getMonitorState: id => monitor && id === monitor.deviceId ? structuredClone(monitor) : null,
    createPacketCapture() { captures.push(true); assert.fail('IPC/source admission cannot itself capture audio.'); },
  };
  const module = { exports: {} };
  load(module.exports, name => {
    if (name === 'electron') return electron;
    if (name === '@monky/screen-share') return { ...runtime, NativeScreenEndpoint: Endpoint, CaptureBridge: Probe,
      loadRuntime: () => ({ capture: { captureKinds: ['window', 'monitor', 'game'],
        encoders: ['h264_texture_amf', 'obs_nvenc_h264_tex'], requiresHardwareProbe: true, hardwareQualified: false } }) };
    if (name === '@monky/screen-audio') return captureModule;
    if (name === 'node:fs/promises') return {
      async mkdir(filename) { directories.push(filename); if (directory) await directory.promise; },
      async lstat() { return { isDirectory: () => true, isSymbolicLink: () => false }; },
      async realpath(filename) { return filename; }, async readdir() { return []; },
      async rm(filename) {
        assert.match(path.basename(filename), /^monky-screen-capture-[a-f0-9]{32}$/);
        assert.ok(directories.includes(filename)); removedDirectories.push(filename);
      },
    };
    return require(name);
  }, module, sourceFile, path.dirname(sourceFile), {
    debug() {},
    error: (...values) => errors.push(values), warn: (...values) => errors.push(values),
  }, { platform, arch: 'x64', pid: process.pid });
  const service = module.exports.setupNativeScreenSharingIpc(window, (id, kind) => {
    selections.push(id);
    if (kind === 'monitor') { assert.equal(id, monitorId); return structuredClone(monitorTarget); }
    assert.match(id, /^window:/);
    return { ...target, kind };
  });
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  const invoke = (input, caller = event()) => handlers.get(shared.NATIVE_SCREEN_IPC.invoke)(caller, input);
  const reply = input => handlers.get(shared.NATIVE_SCREEN_IPC.reply)(event(), input);
  contents.send = (channel, value) => {
    assert.equal(channel, shared.NATIVE_SCREEN_EVENT);
    sent.push(value);
    if ('requestId' in value) queueMicrotask(() => {
      const response = value.type === 'rpc' && value.method === shared.MessageType.SFU_GET_PRODUCERS
        ? { channelId: config.channelId, producers: [] } : null;
      void reply({ callId: value.callId, requestId: value.requestId, ok: true, value: response }).catch(error => errors.push([error]));
    });
  };
  const config = { callId: randomUUID(), sessionId: role, channelId: 'test-channel', mode: 'p2p', iceServers: [] };
  const command = value => invoke({ callId: config.callId, ...value });
  const source = { shareId: 'screen-one', instanceId: randomUUID(), video, audio: true };
  const join = () => invoke({ ...config, action: 'join' });
  const addSource = (shareId = source.shareId, changes = {}) => command({
    action: 'source-add', shareId, desktopSourceId: 'window:12345:0', video, audio: true, audioBitrateKbps: 128, ...changes,
  });
  const participants = () => command({ action: 'participants', participants: [
    { sessionId: 'publisher', nativeScreenShares: [source] }, { sessionId: 'viewer', nativeScreenShares: [] },
  ] });
  const watch = (presentationId = randomUUID()) => command({
    action: 'watch', publisherSessionId: 'publisher', shareId: source.shareId, quality: 'source', presentationId, audio,
  });
  const accepted = signal => command({ action: 'signal', signal: {
    ...signal, fromSessionId: 'publisher', targetSessionId: 'viewer',
    action: 'accepted', generation: 1, backend: 'native',
  } });
  t.after(async () => {
    probeRetires = true;
    gpu?.resolve(); directory?.resolve(); probeStop?.resolve();
    await service.dispose();
    assert.equal(handlers.size, 0);
    assert.equal(contents.listenerCount('did-start-navigation'), 0);
    assert.equal(contents.listenerCount('render-process-gone'), 0);
    assert.equal(contents.listenerCount('destroyed'), 0);
    assert.equal(electron.app.listenerCount('browser-window-focus'), 0);
    assert.equal(electron.app.listenerCount('browser-window-blur'), 0);
  });
  return { service, config, command, invoke, source, join, addSource, participants, watch, accepted,
    frame, contents, event, endpoints, sent, errors, selections, captures, directories, probes, removedDirectories, captureModule,
    replaceMonitor: value => { monitor = value; },
    allowProbeRetirement: () => { probeRetires = true; },
    setProbeFailure: value => { probeFailure = value; },
    replaceTarget: value => { target = value; },
    closeWindow: () => { windowOpen = false; },
    pauseWindow: value => { windowPaused = value; },
    replaceWindowProcess: () => { creationTime = '987654321'; },
    focus: async value => {
      focused = value;
      electron.app.emit(value ? 'browser-window-focus' : 'browser-window-blur');
      await tick(); await tick();
    },
    destroyFrame: () => { frameDestroyed = true; contentDestroyed = true; contents.emit('render-process-gone'); },
  };
}

test('native IPC rejects other WebContents, subframes, unknown payload fields and renderer-supplied HWNDs', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke({ action: 'capabilities' }, { ...f.event(), sender: {} }), /owned main frame/);
  await assert.rejects(f.invoke({ action: 'capabilities' }, { ...f.event(), senderFrame: {} }), /owned main frame/);
  await f.join();
  await assert.rejects(f.addSource('bad-window', { target: { hwnd: 1, expectedProcessId: 2 } }));
  await assert.rejects(f.addSource('monitor', { desktopSourceId: 'screen:0:0' }));
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.selections.length, 0);
});

test('unsupported native platforms report browser-only capabilities without touching GPU or capture', async t => {
  const f = fixture(t, { platform: 'darwin' });
  const result = await f.invoke({ action: 'capabilities' });
  assert.deepEqual(result, { kind: 'capabilities', capabilities: {
    capture: false, captureAudio: false, receive: false, backend: null, reason: 'platform',
  } });
  assert.equal(f.selections.length + f.captures.length + f.endpoints.length, 0);
});

test('static implemented capture kinds permit explicit preparation but are not hardware availability', async t => {
  const f = fixture(t);
  const { capabilities } = await f.invoke({ action: 'capabilities' });
  assert.deepEqual(capabilities, { capture: false, captureAudio: true, receive: true,
    requiresSelectionProbe: true, captureKinds: ['window', 'monitor', 'game'], backend: null, reason: null });
  assert.equal(f.probes.length + f.captures.length + f.endpoints.length, 0);
});

test('announcing a validated window with audio creates neither an encoder nor a PCM capture before Watch', async t => {
  const f = fixture(t);
  await f.join();
  const result = await f.addSource();
  assert.equal(result.kind, 'source');
  assert.equal(result.source.audio, true);
  assert.deepEqual(f.selections, ['window:12345:0']);
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.captures.length, 0);
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0].closed, true);
  assert.deepEqual(f.probes[0].target, { kind: 'window', hwnd: 12345, expectedProcessId: 56789,
    expectedProcessCreationTime100ns: '123456789' });
  assert.equal(f.probes[0].options.video.bitrateKbps, video.maxBitrateKbps);
  assert.equal(f.removedDirectories.length, 1);
  const stats = await f.command({ action: 'stats' });
  assert.equal(stats.publishers.length, 1);
  assert.equal(stats.publishers[0].pipelines.length, 0);
  await f.command({ action: 'source-remove', shareId: result.source.shareId });
  const closed = f.sent.find(value => value.type === 'state' && value.state === 'closed');
  assert.equal(closed.sourceInstanceId, result.source.instanceId);
});

for (const encoder of ['h264_texture_amf', 'obs_nvenc_h264_tex']) {
  test(`${encoder}: only the selected-source probe establishes backend identity`, async t => {
    const f = fixture(t, { encoder });
    await f.join(); await f.participants();
    const { source } = await f.addSource();
    const { capabilities } = await f.invoke({ action: 'capabilities' });
    assert.equal(capabilities.capture, true);
    assert.equal(capabilities.backend, encoder === 'obs_nvenc_h264_tex' ? 'libobs-nvenc' : 'libobs-amf');
    assert.equal(capabilities.requiresSelectionProbe, true, 'Another selection still needs its own probe.');
    await f.command({ action: 'signal', signal: {
      fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
      channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
      subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
    } });
    assert.equal(f.endpoints[0].options.captureEncoder, encoder);
    assert.equal(f.probes[0].closed, true);
  });
}

for (const captureKind of ['window', 'monitor', 'game']) {
  test(`${captureKind}: preview retains the exact target/audio selector without starting PCM`, async t => {
    const f = fixture(t);
    await f.join();
    const { source } = await f.addSource('selected', {
      captureKind, desktopSourceId: captureKind === 'monitor' ? monitorId : `window:12345:${'b'.repeat(64)}`,
    });
    assert.equal(f.probes[0].target.kind, captureKind);
    await f.command({ action: 'preview-start', shareId: source.shareId,
      sourceInstanceId: source.instanceId, presentationId: randomUUID() });
    assert.equal(f.endpoints.length, 1);
    const endpoint = f.endpoints[0];
    assert.equal(endpoint.previewDemand, true); assert.equal(endpoint.demand, 0);
    assert.deepEqual(endpoint.options.target, f.probes[0].target);
    assert.equal(endpoint.options.audio.captureModule.createPacketCapture, f.captureModule.createPacketCapture);
    assert.ok(runtime.NativePcmCaptureHub.matches(endpoint.options.audio.captureHub, endpoint.options.audio.captureModule,
      captureKind === 'monitor' ? { excludePid: process.pid } : { includeWindowId: 12345, expectedProcessId: 56789 }));
    assert.equal(endpoint.options.audio.captureHub.getStats().captureStarts, 0);
    assert.equal(f.captures.length, 0);
  });
}

test('a source kind cannot substitute another target identity before probing', async t => {
  const f = fixture(t);
  await f.join();
  for (const selection of [
    { captureKind: 'window', desktopSourceId: monitorId }, { captureKind: 'game', desktopSourceId: monitorId },
    { captureKind: 'monitor', desktopSourceId: 'window:12345:0' },
    { captureKind: 'monitor', desktopSourceId: 'screen:0:0' },
  ]) await assert.rejects(f.addSource('mismatch', selection), /does not match/);
  assert.equal(f.selections.length + f.probes.length + f.captures.length + f.endpoints.length, 0);
});

test('an unverified probe cannot announce a source or turn static kinds into capture availability', async t => {
  const f = fixture(t, { probeVerified: false });
  await f.join();
  await assert.rejects(f.addSource(), /verified, capture-free hardware probe/);
  const { capabilities } = await f.invoke({ action: 'capabilities' });
  assert.equal(capabilities.capture, false); assert.equal(capabilities.backend, null);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.equal(f.probes[0].closed, true); assert.equal(f.removedDirectories.length, 1);
});

test('encoder probe rejection does not substitute WGC for Game or publish a success-shaped source', async t => {
  const failure = Object.assign(new Error('Modeled unsupported Game encoder'), { code: 'ERR_SCREEN_CAPTURE_ENCODER' });
  const f = fixture(t, { probeFailure: failure });
  await f.join();
  await assert.rejects(f.addSource('selected', { captureKind: 'game' }), /Modeled unsupported Game encoder/);
  assert.equal(f.probes.length, 1); assert.equal(f.probes[0].target.kind, 'game');
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.equal(f.probes[0].closed, true); assert.equal(f.captures.length + f.endpoints.length, 0);
});

test('monitor Stop then rejected window releases its audio reservation and permits retry and call reentry', async t => {
  const f = fixture(t, { probeStopReportsFailure: true });
  await f.join();
  await f.addSource('monitor', { captureKind: 'monitor', desktopSourceId: monitorId });
  await f.command({ action: 'source-remove', shareId: 'monitor' });
  const failure = Object.assign(new Error('The selected window disappeared during native admission.'),
    { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
  f.setProbeFailure(failure);
  await assert.rejects(f.addSource('rejected-window'), error => error === failure);
  assert.equal(f.probes[1].closed, true);
  assert.equal(f.removedDirectories.length, 2);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  f.setProbeFailure(null);
  assert.equal((await f.addSource('retry-window')).kind, 'source');
  await f.command({ action: 'leave' });
  await f.join();
  assert.equal((await f.addSource('after-rejoin')).kind, 'source');
  await f.command({ action: 'leave-local' });
  await f.join();
  assert.equal((await f.addSource('after-reconnect')).kind, 'source');
  assert.equal(f.captures.length + f.endpoints.length, 0, 'Source preparation cannot activate PCM or transport.');
});

test('IPC error serialization keeps the actual nested cleanup failure instead of only AggregateError', async t => {
  const failure = new AggregateError([new Error('Specific native preparation reason')],
    'Modeled aggregate preparation failure');
  const f = fixture(t, { probeFailure: failure });
  await f.join();
  await assert.rejects(f.addSource(), error => {
    assert.match(error.message, /Modeled aggregate preparation failure/);
    assert.match(error.message, /Specific native preparation reason/);
    assert.equal(error.cause, failure);
    return true;
  });
});

test('preparation failure before process creation still awaits the original bridge stop', async t => {
  const probeStop = deferred();
  const f = fixture(t, { probeFailureBeforeSpawn: new Error('Modeled pre-spawn failure'), probeStop });
  await f.join();
  let settled = false;
  const adding = f.addSource();
  void adding.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(adding, /Modeled pre-spawn failure/);
  await tick();
  assert.equal(f.probes[0].child, undefined);
  assert.equal(f.probes[0].stopCalls, 1);
  assert.equal(settled, false);
  assert.equal(f.removedDirectories.length, 0);
  await assert.rejects(f.addSource('another'), /reserve capture audio/);
  probeStop.resolve();
  await rejected;
  assert.equal(f.probes[0].closed, true);
  assert.equal(f.removedDirectories.length, 1);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.equal(f.captures.length + f.endpoints.length, 0);
});

test('Stop aborts an in-flight selected-source probe and waits for its owned process closure', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const adding = f.addSource(), rejected = assert.rejects(adding, { name: 'AbortError' });
  await tick();
  assert.equal(f.probes.length, 1); assert.equal(f.probes[0].closed, false);
  await f.command({ action: 'source-remove', shareId: f.source.shareId });
  await rejected;
  assert.equal(f.probes[0].closed, true); assert.equal(f.removedDirectories.length, 1);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.equal(f.endpoints.length + f.captures.length, 0);
});

test('a resolved nativeClosed snapshot without the original child exit retains source/audio ownership until retry', async t => {
  const f = fixture(t, { probeRetires: false });
  await f.join();
  await assert.rejects(f.addSource(), /original selected-source probe.*retirement/);
  assert.equal(f.probes[0].snapshot().nativeClosed, true);
  assert.equal(f.probes[0].closed, false); assert.equal(f.removedDirectories.length, 0);
  await assert.rejects(f.addSource(), /already exists/);
  await assert.rejects(f.addSource('another'), /reserve capture audio/);
  await assert.rejects(f.command({ action: 'source-remove', shareId: f.source.shareId }), /original selected-source probe/);
  f.allowProbeRetirement();
  await f.command({ action: 'source-remove', shareId: f.source.shareId });
  assert.equal(f.probes[0].closed, true); assert.equal(f.removedDirectories.length, 1);
  assert.equal((await f.addSource()).kind, 'source');
});

test('a selected monitor bounds change or disconnect retires its armed metadata and requires reselection', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource('selected', { captureKind: 'monitor', desktopSourceId: monitorId });
  f.replaceMonitor({ ...monitorTarget, bounds: { ...monitorTarget.bounds, width: 1280 } });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.ok(f.sent.some(value => value.type === 'error' && value.sourceInstanceId === source.instanceId
    && value.reason === 'source-unavailable' && /explicitly/.test(value.message)));
  await assert.rejects(f.addSource('selected', { captureKind: 'monitor', desktopSourceId: monitorId }), /Select it again/);
  f.replaceMonitor(null);
  await assert.rejects(f.addSource('selected', { captureKind: 'monitor', desktopSourceId: monitorId }), /Select it again/);
  assert.equal(f.captures.length + f.endpoints.length, 0);
  assert.equal(f.probes.length, 1);
});

test('retiring a missing or already retired call is idempotent without accepting other operations', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.command({ action: 'leave-local' }), { kind: 'ok' });
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await f.join();
  await f.addSource();
  await f.command({ action: 'leave' });
  assert.deepEqual(await f.command({ action: 'leave' }), { kind: 'ok' });
  assert.deepEqual(await f.command({ action: 'leave-local' }), { kind: 'ok' });
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
});

test('closing the selected window retires its announcement with zero viewers and no capture', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource();
  f.closeWindow();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.ok(f.sent.some(event => event.type === 'state' && event.state === 'closed'
    && event.sourceInstanceId === source.instanceId));
  assert.equal(f.endpoints.length + f.captures.length, 0);
});

test('minimized and hidden windows retain their identity but a reused process does not', async t => {
  const f = fixture(t);
  await f.join();
  await f.addSource();
  f.pauseWindow(true);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  assert.equal(f.errors.length, 0);
  f.pauseWindow(false);
  f.replaceWindowProcess();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.equal(f.endpoints.length + f.captures.length, 0);
});

test('native diagnostics are source-instance scoped and do not start capture when nobody is watching', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource();
  const query = { action: 'diagnostics', publisherSessionId: f.config.sessionId,
    shareId: source.shareId, sourceInstanceId: source.instanceId };
  const diagnostics = await f.command(query);
  assert.deepEqual(diagnostics, { kind: 'diagnostics', sourceInstanceId: source.instanceId,
    presentationId: null, viewers: 0, endpoints: [] });
  assert.equal(f.endpoints.length + f.captures.length, 0);
  for (const stale of [
    { ...query, sourceInstanceId: randomUUID() },
    { ...query, presentationId: randomUUID() },
    { ...query, publisherSessionId: 'someone-else' },
  ]) assert.deepEqual(await f.command(stale), { kind: 'diagnostics-retired' });
  await f.command({ action: 'source-remove', shareId: source.shareId });
  assert.deepEqual(await f.command(query), { kind: 'diagnostics-retired' });
  assert.equal(f.errors.length, 0, 'A superseded metrics request must not become an IPC error.');
});
test('Stop while capability discovery is pending prevents late source admission', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const adding = f.addSource();
  const rejected = assert.rejects(adding, { name: 'AbortError' });
  await f.command({ action: 'source-remove', shareId: f.source.shareId });
  gpu.resolve(); await rejected;
  assert.equal(f.selections.length, 0);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
});

test('leaving during source preparation cannot attach capture to a subsequent call', async t => {
  const directory = deferred(), f = fixture(t, { directory });
  await f.join();
  const adding = f.addSource(), rejected = assert.rejects(adding, { name: 'AbortError' });
  await tick();
  const leaving = f.command({ action: 'leave' });
  directory.resolve(); await leaving; await rejected;
  assert.equal(f.endpoints.length, 0);
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await f.invoke({ action: 'join', ...f.config, callId: randomUUID() });
});

test('window owner changes during asynchronous preparation fail before publication', async t => {
  const directory = deferred(), f = fixture(t, { directory });
  await f.join();
  const adding = f.addSource(), rejected = assert.rejects(adding, /closed or replaced/);
  await tick();
  f.replaceTarget({ hwnd: 12345, expectedProcessId: 56790 });
  directory.resolve(); await rejected;
  assert.equal(f.endpoints.length, 0);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
});

test('pending sources reserve capacity before yielding to asynchronous discovery', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const pending = ['one', 'two', 'replacement'].map(id => f.addSource(id, { audio: false }));
  await assert.rejects(f.addSource('four'), /limit/);
  await assert.rejects(f.addSource('one'), /already exists/);
  gpu.resolve();
  await Promise.all(pending);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 3);
});

test('application audio is reserved before discovery and remains exclusive until source retirement', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const pending = f.addSource('audio-owner');
  await assert.rejects(f.addSource('second-audio'), /reserve capture audio/);
  const silent = f.addSource('silent-window', { audio: false });
  assert.equal(f.captures.length, 0);
  gpu.resolve(); await Promise.all([pending, silent]);
  await assert.rejects(f.addSource('second-audio'), /reserve capture audio/);
  await f.command({ action: 'source-remove', shareId: 'audio-owner' });
  assert.equal((await f.addSource('second-audio')).source.audio, true);
  assert.equal(f.captures.length, 0, 'An audio reservation must not capture before Watch.');
});

test('cancelling pending audio admission releases only its own reservation', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const old = f.addSource('audio-owner'), rejected = assert.rejects(old, { name: 'AbortError' });
  await f.command({ action: 'source-remove', shareId: 'audio-owner' });
  const replacement = f.addSource('audio-owner');
  gpu.resolve(); await rejected; await replacement;
  await assert.rejects(f.addSource('second-audio'), /reserve capture audio/);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
});

test('an authenticated Watch opens the selected source and shares its original capture hub and target', async t => {
  const f = fixture(t);
  await f.join(); await f.participants();
  const { source } = await f.addSource();
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  assert.equal(f.endpoints.length, 1);
  const options = f.endpoints[0].options;
  assert.deepEqual(options.target, { kind: 'window', hwnd: 12345, expectedProcessId: 56789,
    expectedProcessCreationTime100ns: '123456789' });
  assert.ok(options.audio.captureHub instanceof runtime.NativePcmCaptureHub);
  assert.equal(options.audio.output.frame, f.frame);
  assert.equal(options.audio.output.expectedUrl, f.frame.url);
  assert.equal(options.audio.captureHub.getStats().captureStarts, 0);
});

test('a viewer-only codec failure closes that subscription without reporting a source-wide failure', async t => {
  const f = fixture(t);
  await f.join();
  await f.command({ action: 'participants', participants: [
    { sessionId: 'publisher', nativeScreenShares: [] }, { sessionId: 'viewer', nativeScreenShares: [] },
    { sessionId: 'compatible', nativeScreenShares: [] },
  ] });
  const { source } = await f.addSource();
  for (const fromSessionId of ['viewer', 'compatible']) await f.command({ action: 'signal', signal: {
    fromSessionId, targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  assert.equal(f.endpoints.length, 1);
  f.endpoints[0].options.onError(Object.assign(new Error('modeled incompatible decoder'), { code: 'ERR_RTC_ENCODED_FORMAT' }),
    { remoteSessionId: 'viewer' });
  await tick();
  const stats = await f.command({ action: 'stats' });
  assert.equal(stats.publishers[0].viewers, 1);
  assert.equal(stats.publishers[0].pipelines.length, 1);
  assert.equal(f.endpoints[0].closed, false);
  assert.equal(f.sent.some(value => value.type === 'error'), false);
  assert.ok(f.sent.some(value => value.type === 'signal' && value.signal.action === 'closed'
    && value.signal.targetSessionId === 'viewer' && value.signal.reason === 'unsupported'));
  assert.ok(f.errors.some(values => values[0].includes('Screen viewer failed')), 'The failed peer must still be diagnosed.');
});

test('focused local preview starts without spectators, pauses on blur and honors the persisted preference', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource();
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  assert.equal(f.endpoints.length, 1);
  assert.equal(f.endpoints[0].demand, 0);
  assert.equal(f.endpoints[0].previewDemand, true);
  assert.equal(f.sent.some(event => event.type === 'signal' || event.type === 'rpc'), false);
  assert.equal(f.captures.length, 0, 'A local video preview never captures application audio.');
  await f.focus(false);
  assert.equal(f.endpoints[0].closed, true);
  assert.equal(f.sent.findLast(event => event.type === 'preview-state').state, 'paused');
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1, 'Blur must not remove the announcement.');
  await f.command({ action: 'preview-preferences', pauseWhenUnfocused: false });
  assert.equal(f.endpoints.length, 2);
  assert.equal(f.endpoints[1].previewDemand, true);
  assert.equal(f.endpoints[1].demand, 0);
  await f.focus(true); await f.focus(false);
  assert.equal(f.endpoints.length, 2);
  assert.equal(f.endpoints[1].closed, false);
  await f.command({ action: 'preview-preferences', pauseWhenUnfocused: true });
  assert.equal(f.endpoints[1].closed, true);
  await f.focus(true);
  assert.equal(f.endpoints.length, 3);
  assert.equal(f.endpoints[2].previewDemand, true);
});

test('losing application focus pauses only the local preview while an opted-in spectator continues', async t => {
  const f = fixture(t);
  await f.join(); await f.participants();
  const { source } = await f.addSource();
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  const watch = {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  };
  await f.command({ action: 'signal', signal: watch });
  assert.equal(f.endpoints.length, 1);
  await f.focus(false);
  assert.equal(f.endpoints[0].closed, false);
  assert.equal(f.endpoints[0].demand, 1);
  assert.equal(f.endpoints[0].previewDemand, false);
  const { quality: _quality, backend: _backend, ...scope } = watch;
  await f.command({ action: 'signal', signal: { ...scope, action: 'stop' } });
  assert.equal(f.endpoints[0].closed, true);
  assert.equal((await f.command({ action: 'stats' })).publishers[0].pipelines.length, 0);
});

test('source retirement refuses a late preview before any new MessagePort can be created', async t => {
  const f = fixture(t), gate = deferred();
  await f.join(); await f.participants();
  const { source } = await f.addSource();
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  const endpoint = f.endpoints[0];
  endpoint.close = async () => { await gate.promise; endpoint.closed = true; };
  const removing = f.command({ action: 'source-remove', shareId: source.shareId });
  try {
    await assert.rejects(f.command({ action: 'preview-start', shareId: source.shareId,
      sourceInstanceId: source.instanceId, presentationId: randomUUID() }), { name: 'AbortError' });
  } finally { gate.resolve(); await removing; }
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
});

test('mute and volume changed before Accepted are applied before the receiver can admit any audio', async t => {
  const f = fixture(t, { role: 'viewer' });
  await f.join(); await f.participants();
  const watched = await f.watch();
  await f.command({ action: 'watch-audio', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: watched.presentationId, muted: true, volume: .35 });
  assert.equal(f.endpoints.length, 0);
  await f.accepted(f.sent.find(value => value.type === 'signal' && value.signal.action === 'watch').signal);
  assert.equal(f.endpoints.length, 1);
  assert.deepEqual({
    sinkId: f.endpoints[0].options.audio.sinkId, muted: f.endpoints[0].options.audio.muted,
    volume: f.endpoints[0].options.audio.volume,
  }, { sinkId: 'selected-output', muted: true, volume: .35 });
  await f.command({ action: 'watch-audio', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: watched.presentationId, muted: false, volume: 1.5 });
  assert.deepEqual(f.endpoints[0].preferences, { muted: false, volume: 1.5 });
});

test('overlapping Watches reserve identity immediately and an old Stop cannot cancel a replacement', async t => {
  const gpu = deferred(), f = fixture(t, { gpu, role: 'viewer' });
  await f.join(); await f.participants();
  const oldId = randomUUID(), newId = randomUUID();
  const first = f.watch(oldId), old = assert.rejects(first, { name: 'AbortError' });
  const second = f.watch(newId);
  gpu.resolve(); await old;
  const watched = await second;
  assert.equal(watched.presentationId, newId);
  await f.command({ action: 'stop', publisherSessionId: 'publisher', shareId: f.source.shareId, presentationId: oldId });
  assert.equal((await f.command({ action: 'stats' })).subscriptions.length, 1);
  await assert.rejects(f.command({ action: 'watch-audio', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: oldId, muted: false, volume: 1 }), { name: 'AbortError' });
});

test('same-document and child-frame navigation preserve the call; main-document navigation invalidates it immediately', async t => {
  const f = fixture(t);
  await f.join(); await f.addSource();
  f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await tick();
  await f.invoke({ action: 'join', ...f.config, callId: randomUUID() });
});

test('renderer loss retires an idle source without sending cleanup requests into another document', async t => {
  const f = fixture(t);
  await f.join(); await f.addSource();
  const messages = f.sent.length;
  f.destroyFrame();
  await tick();
  assert.equal(f.sent.length, messages);
  assert.equal(f.captures.length, 0);
  assert.equal(f.endpoints.length, 0);
});

test('disconnected leave surfaces the missing remote acknowledgement but releases a locally retired call slot', async t => {
  const f = fixture(t, { role: 'viewer' });
  await f.join(); await f.participants();
  await f.watch();
  await f.accepted(f.sent.find(value => value.type === 'signal' && value.signal.action === 'watch').signal);
  const result = await f.command({ action: 'leave-local' });
  assert.equal(result.kind, 'retired-with-errors');
  assert.equal(result.remoteAcknowledged, false);
  assert.match(result.error, /shutdown reported failures/);
  assert.equal(f.endpoints[0].closed, true);
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await f.invoke({ ...f.config, callId: randomUUID(), action: 'join' });
});
