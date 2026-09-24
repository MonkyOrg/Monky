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
const { finished } = require('node:stream/promises');
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
const nvencProbeDiagnostic = 'NVENC nvEncGetEncodeCaps NV_ENC_CAPS_WIDTH_MAX(16) status=8(NV_ENC_ERR_INVALID_PARAM)'
  + ' value=-1 required=1920 capsVersion=1073807361; api=12.2'
  + '; nvEncGetEncodeGUIDCount(status=0,count=2); nvEncGetEncodeGUIDs(status=0,returned=2,H264=1)'
  + '; nvEncGetEncodeProfileGUIDCount(status=0,count=3); nvEncGetEncodeProfileGUIDs(status=0,returned=3,Main=1)'
  + '; nvEncGetInputFormatCount(status=0,count=4); nvEncGetInputFormats(status=0,returned=4,NV12=1)'
  + '; NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE=1'
  + '; NVENC nvEncDestroyEncoder status=20(NV_ENC_ERR_RESOURCE_NOT_REGISTERED) retirement=unconfirmed';
const h264ColorDiagnostic = 'External H264 must retain the admitted BT.709 limited-range mode:'
  + ' fullRange=1, primaries=6, transfer=6, matrix=6';
const audio = { sinkId: 'selected-output', muted: false, volume: 1 };
const monitorTarget = {
  kind: 'monitor', deviceId: String.raw`\\?\DISPLAY#SELECTED#ONE`, deviceName: String.raw`\\.\DISPLAY2`,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
};
const monitorId = `native-monitor:${'a'.repeat(64)}`;

function fixture(t, { gpu, directory, role = 'publisher', platform = 'win32',
  encoder = 'h264_texture_amf', probeFailure, probeFailureBeforeSpawn, probeStop,
  probeVerified = true, probeRetires = true, probeStopReportsFailure = false, logger, packetCapture } = {}) {
  const handlers = new Map(), sent = [], endpoints = [], selections = [], errors = [], captures = [], directories = [];
  const probes = [], removedDirectories = [], logs = [], ports = [];
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
        ports.push(this);
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
    async close() {
      if (this.closed) return;
      this.closed = true;
      this.options.onState({ type: 'closed' });
    }
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
    createPacketCapture(selection, onEvent) {
      captures.push(selection);
      if (packetCapture) return packetCapture(selection, onEvent);
      assert.fail('IPC/source admission cannot itself capture audio.');
    },
  };
  const module = { exports: {} };
  load(module.exports, name => {
    if (name === 'electron') return electron;
    if (name === './i18n') return { mt: key => key };
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
  }, { write: entry => { logs.push(structuredClone(entry)); logger?.write(entry); } });
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
  return { service, config, command, invoke, reply, source, join, addSource, participants, watch, accepted,
    frame, contents, event, endpoints, sent, errors, selections, captures, directories, probes, removedDirectories, captureModule, logs, ports,
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

function persistentLogger(t, { saveDialog } = {}) {
  const directory = path.join(__dirname, `native-log-test-${randomUUID()}`);
  fs.mkdirSync(directory);
  const exportPath = path.join(directory, 'export.jsonl');
  const filename = path.resolve(__dirname, '..', 'src', 'main', 'clientLogger.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const dialogResult = { canceled: false, filePath: exportPath };
  const loadLogger = vm.runInThisContext(`(function(exports, require, module) { ${code}\n})`, { filename });
  loadLogger(module.exports, name => name === 'electron' ? {
    app: { getPath: () => directory }, dialog: { showSaveDialog: async () => {
      if (saveDialog) await saveDialog();
      return dialogResult;
    } },
  } : require(name), module);
  const logger = new module.exports.ClientLogger();
  t.after(async () => {
    const stream = logger.writeStream;
    logger.shutdown();
    if (stream) await finished(stream);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { logger, directory, exportPath, dialogResult };
}

test('native IPC rejects other WebContents, subframes, unknown payload fields and renderer-supplied HWNDs', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke({ action: 'capabilities' }, { ...f.event(), sender: {} }), /owned main frame/);
  await assert.rejects(f.invoke({ action: 'capabilities' }, { ...f.event(), senderFrame: {} }), /owned main frame/);
  await f.join();
  await assert.rejects(f.addSource('bad-window', { target: { hwnd: 1, expectedProcessId: 2 } }));
  await assert.rejects(f.addSource('monitor', { desktopSourceId: 'screen:0:0' }));
  for (const preserveAspectRatio of [null, 0, 'true', {}])
    await assert.rejects(f.addSource('bad-scaling', { preserveAspectRatio }));
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.selections.length, 0);
});

test('failed preflight before source creation persists only selected diagnostics and exports immediately', async t => {
  const { logger, exportPath } = persistentLogger(t);
  logger.setConfig({ enabled: true });
  const secret = 'TURN-password-private-source-title-SDP';
  const native = Object.assign(new Error(secret), { code: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE' });
  const f = fixture(t, { logger, probeFailureBeforeSpawn: new AggregateError([native], secret) });
  f.config.iceServers = [{ urls: ['turn:private.example'], username: secret, credential: secret }];
  await f.join();
  await assert.rejects(f.addSource(secret, { captureKind: 'game' }), /TURN-password/);
  assert.equal(f.sent.some(event => event.type === 'error'), false, 'Admission failed before a source event exists.');
  assert.equal(f.endpoints.length, 0);
  const failure = f.logs.find(entry => entry.message === 'Native screen source-admission failed');
  assert.equal(failure.data.stage, 'preflight');
  assert.equal(failure.data.captureKind, 'game');
  assert.deepEqual(failure.data.video, video);
  assert.deepEqual(failure.data.nativeCodes, ['ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE']);
  assert.equal(f.logs.filter(entry => entry.level === 'ERROR').length, 1, 'The IPC wrapper must not duplicate the same error.');
  await assert.rejects(f.invoke({ action: 'join', password: secret, iceServers: secret }));
  await f.command({ action: 'leave' });
  const exported = await logger.exportLogs();
  assert.equal(exported.success, true);
  const text = fs.readFileSync(exportPath, 'utf8');
  assert.match(text, /SCREEN_SHARE/);
  assert.match(text, /ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE/);
  assert.match(text, /call-retirement-result/);
  assert.doesNotMatch(text, /TURN-password|private\.example|password|stack|desktopSourceId/);
  assert.equal(f.removedDirectories.length, 1);
});

test('disabled persistent logging writes no lifecycle events and does not replay them when reenabled', async t => {
  const { logger, directory, exportPath } = persistentLogger(t);
  const initial = logger.writeStream;
  logger.setConfig({ enabled: false });
  if (initial) await finished(initial);
  const f = fixture(t, { logger });
  await f.join(); await f.addSource(); await f.command({ action: 'leave' });
  await f.join();
  f.setProbeFailure(new AggregateError([
    Object.assign(new Error(nvencProbeDiagnostic), { code: 'ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE' }),
    Object.assign(new Error(h264ColorDiagnostic), { code: 'ERR_RTC_ENCODED_COLOR' }),
  ], 'private credential'));
  await assert.rejects(f.addSource('disabled-native-diagnostics'));
  await f.command({ action: 'leave' });
  const logsDirectory = path.join(directory, 'client-logs');
  const content = () => fs.readdirSync(logsDirectory).filter(name => name.endsWith('.jsonl'))
    .map(name => fs.readFileSync(path.join(logsDirectory, name), 'utf8')).join('');
  assert.equal(content(), '');
  logger.setConfig({ enabled: true });
  await f.join();
  await f.command({ action: 'leave' });
  assert.equal((await logger.exportLogs()).success, true);
  const text = fs.readFileSync(exportPath, 'utf8');
  assert.match(text, /call-joined/);
  assert.doesNotMatch(text, /source-admission|source-admitted|preflight|nativeDiagnostics|nvEnc|h264-color/);
});

test('nested NVENC and H264 failures export exact allowlisted native measurements without message content', async t => {
  const { logger, exportPath } = persistentLogger(t);
  logger.setConfig({ enabled: true });
  const secret = 'PRIVATE_CREDENTIAL_SDP_PATH';
  const nvenc = Object.assign(new Error(`${nvencProbeDiagnostic}; password=${secret}; C:\\${secret}`),
    { code: 'ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE' });
  const color = Object.assign(new Error(`${h264ColorDiagnostic}; credential=${secret}`),
    { code: 'ERR_RTC_ENCODED_COLOR' });
  const error = new Error(secret, { cause: new AggregateError([nvenc, new Error(secret, { cause: color })], secret) });
  const f = fixture(t, { logger, probeFailure: error });
  await f.join();
  await assert.rejects(f.addSource(), /PRIVATE_CREDENTIAL/);
  const failure = f.logs.find(entry => entry.message === 'Native screen source-admission failed');
  assert.deepEqual(failure.data.nativeCodes, ['ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE', 'ERR_RTC_ENCODED_COLOR']);
  const diagnostics = failure.data.nativeDiagnostics;
  assert.deepEqual(diagnostics.find(value => value.operation === 'nvEncGetEncodeCaps'), {
    kind: 'nvenc-operation', operation: 'nvEncGetEncodeCaps', status: 8, value: -1, required: 1920,
    capsVersion: 1073807361, capability: 'NV_ENC_CAPS_WIDTH_MAX', capabilityId: 16,
  });
  assert.deepEqual(diagnostics.find(value => value.kind === 'nvenc-api'), { kind: 'nvenc-api', major: 12, minor: 2 });
  for (const [operation, count] of [
    ['nvEncGetEncodeGUIDCount', 2], ['nvEncGetEncodeProfileGUIDCount', 3], ['nvEncGetInputFormatCount', 4],
  ]) assert.deepEqual(diagnostics.find(value => value.operation === operation),
    { kind: 'nvenc-operation', operation, status: 0, count });
  for (const [operation, returned, flag] of [
    ['nvEncGetEncodeGUIDs', 2, 'H264'], ['nvEncGetEncodeProfileGUIDs', 3, 'Main'], ['nvEncGetInputFormats', 4, 'NV12'],
  ]) assert.deepEqual(diagnostics.find(value => value.operation === operation),
    { kind: 'nvenc-operation', operation, status: 0, returned, [flag]: true });
  assert.deepEqual(diagnostics.find(value => value.kind === 'nvenc-capability'),
    { kind: 'nvenc-capability', capability: 'NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE', value: 1 });
  assert.deepEqual(diagnostics.find(value => value.operation === 'nvEncDestroyEncoder'),
    { kind: 'nvenc-operation', operation: 'nvEncDestroyEncoder', status: 20, retirementConfirmed: false });
  assert.deepEqual(diagnostics.find(value => value.kind === 'h264-color'),
    { kind: 'h264-color', fullRange: true, primaries: 6, transfer: 6, matrix: 6 });
  await f.command({ action: 'leave' });
  assert.equal((await logger.exportLogs()).success, true);
  const text = fs.readFileSync(exportPath, 'utf8');
  const exported = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .find(entry => entry.message === 'Native screen source-admission failed');
  assert.deepEqual(exported.data.nativeDiagnostics, diagnostics);
  assert.doesNotMatch(text, /PRIVATE_CREDENTIAL|password|credential|NV_ENC_ERR_INVALID_PARAM|External H264/);
});

test('native diagnostics ignore hostile identifiers and malformed numbers while keeping safe classifications', async t => {
  const f = fixture(t);
  await f.join();
  for (const [index, message] of [
    'NVENC PRIVATE_PASSWORD status=8 value=123; PRIVATE_CAPABILITY=8; api=private.credential',
    'External H264 must retain the admitted BT.709 limited-range mode: fullRange=0, primaries=999, transfer=6, matrix=6',
    'PRIVATE_PASSWORD SDP v=0 ice-pwd=private',
  ].entries()) {
    f.setProbeFailure(new Error(message));
    await assert.rejects(f.addSource(`unknown-diagnostic-${index}`));
    const failure = f.logs.findLast(entry => entry.message === 'Native screen source-admission failed');
    assert.equal(failure.data.error, 'operation-failed');
    assert.equal(failure.data.nativeDiagnostics, undefined);
  }
  f.setProbeFailure(new Error('NVENC nvEncGetEncodeCaps PRIVATE_CAPABILITY(16) status=8(PRIVATE_PASSWORD)'
    + ' value=999999999999999 required=12PRIVATE_PASSWORD capsVersion=4294967296; api=12.2'));
  await assert.rejects(f.addSource('hostile-fields'));
  assert.deepEqual(f.logs.findLast(entry => entry.message === 'Native screen source-admission failed').data.nativeDiagnostics, [
    { kind: 'nvenc-operation', operation: 'nvEncGetEncodeCaps', status: 8 },
    { kind: 'nvenc-api', major: 12, minor: 2 },
  ]);
  f.setProbeFailure(new Error(h264ColorDiagnostic.replace('fullRange=1', 'fullRange=absent').replace('primaries=6', 'primaries=absent')));
  await assert.rejects(f.addSource('absent-color'));
  assert.deepEqual(f.logs.findLast(entry => entry.message === 'Native screen source-admission failed').data.nativeDiagnostics, [
    { kind: 'h264-color', fullRange: null, primaries: null, transfer: 6, matrix: 6 },
  ]);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_|ice-pwd|private\.credential|999999999999999/);
});

test('export keeps logging active while Save As is open and flushes those events into the saved file', async t => {
  const opened = deferred(), closeDialog = deferred();
  const { logger, exportPath } = persistentLogger(t, { saveDialog: () => {
    opened.resolve();
    return closeDialog.promise;
  } });
  logger.setConfig({ enabled: true });
  const f = fixture(t, { logger });
  await f.join();
  const stream = logger.writeStream;
  const exporting = logger.exportLogs();
  await opened.promise;
  try {
    assert.equal(logger.writeStream, stream);
    assert.equal(stream.writableEnded, false);
    await f.addSource('during-save-dialog');
    await f.command({ action: 'leave' });
  } finally { closeDialog.resolve(); }
  assert.equal((await exporting).success, true);
  const text = fs.readFileSync(exportPath, 'utf8');
  assert.match(text, /source-admitted/);
  assert.match(text, /call-retirement-result/);
  assert.equal(logger.writeStream, stream);
});

test('persistent screen logs use existing rotation and report export write failures', async t => {
  const { logger, directory, exportPath, dialogResult } = persistentLogger(t);
  const oldPath = path.join(directory, 'client-logs', 'session-old.jsonl');
  fs.writeFileSync(oldPath, 'old'.repeat(200));
  logger.setConfig({ enabled: true, maxSizeBytes: 100 });
  assert.equal(fs.existsSync(oldPath), false);
  const f = fixture(t, { logger });
  await f.join(); await f.command({ action: 'leave' });
  dialogResult.filePath = path.join(directory, 'missing-directory', 'export.jsonl');
  assert.equal((await logger.exportLogs()).success, false, 'An asynchronous output error is not a successful export.');
  dialogResult.filePath = exportPath;
  assert.equal((await logger.exportLogs()).success, true);
  assert.match(fs.readFileSync(exportPath, 'utf8'), /call-retirement-result/);
});

test('publisher diagnostics correlate profiles, demand, fallback and teardown without per-frame or polling logs', async t => {
  const f = fixture(t);
  await f.join(); await f.participants();
  const { source } = await f.addSource('game-diagnostics', { captureKind: 'game' });
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  const endpoint = f.endpoints[0];
  endpoint.options.onState({ type: 'capture', state: 'starting' });
  endpoint.options.onState({ type: 'capture', state: 'running' });
  endpoint.options.onState({ type: 'capture-fallback' });
  endpoint.options.onState({ type: 'capture-fallback' });
  endpoint.options.onState({ type: 'capture-mode', capture: { mode: 'normal', ready: true } });
  const before = f.logs.length;
  for (let index = 0; index < 100; index++) {
    endpoint.options.onState({ type: 'capture', state: 'running' });
    endpoint.options.onState({ type: 'frame' });
    endpoint.options.onPreview({ data: new Uint8Array([1]), timestampUs: index, keyframe: true });
    await f.command({ action: 'stats' });
    await f.command({ action: 'diagnostics', publisherSessionId: f.config.sessionId, shareId: source.shareId,
      sourceInstanceId: source.instanceId });
  }
  assert.equal(f.logs.length, before);
  const signal = { fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID() };
  await f.command({ action: 'signal', signal: { ...signal, action: 'watch', quality: '480p30', backend: 'native' } });
  const pipelines = f.logs.filter(entry => entry.message === 'Native screen pipeline-create');
  assert.equal(pipelines.length, 2);
  assert.deepEqual(pipelines.map(entry => entry.data.quality), ['source', '480p30']);
  assert.deepEqual(pipelines[1].data.video, shared.getScreenShareProfile(video, '480p30'));
  assert.equal(pipelines[1].data.captureKind, 'window');
  assert.notEqual(pipelines[0].data.pipeline, pipelines[1].data.pipeline);
  assert.equal(pipelines[0].data.source, pipelines[1].data.source);
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen capture-fallback').length, 1);
  await f.focus(false);
  assert.ok(f.logs.some(entry => entry.message === 'Native screen preview-state' && entry.data.state === 'paused'));
  await f.command({ action: 'signal', signal: { ...signal, action: 'stop' } });
  assert.deepEqual(f.logs.filter(entry => entry.message === 'Native screen viewer-demand').map(entry => entry.data.action),
    ['watch', 'stop']);
  await f.command({ action: 'leave' });
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen pipeline-state' && entry.data.type === 'closed').length, 2);
  assert.ok(f.logs.some(entry => entry.message === 'Native screen source-retirement-result' && !entry.data.retained));
  assert.ok(f.logs.some(entry => entry.message === 'Native screen call-retirement-result' && !entry.data.retained));
});

test('receiver lifecycle records watch, playing and unwatch once without logging frames or peer payloads', async t => {
  const f = fixture(t, { role: 'viewer' });
  await f.join(); await f.participants();
  const watched = await f.watch();
  await f.accepted(f.sent.find(event => event.type === 'signal' && event.signal.action === 'watch').signal);
  const endpoint = f.endpoints[0];
  const peer = { remoteSessionId: 'private-peer', status: 'open', nativeState: { connectionState: 'connected',
    sdp: 'secret-sdp' }, error: { message: 'secret-password' }, credential: 'secret-credential' };
  endpoint.options.onState({ type: 'peer', state: peer });
  for (let index = 0; index < 100; index++) {
    endpoint.options.onState({ type: 'peer', state: peer });
    endpoint.options.onState({ type: 'frame' });
  }
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen pipeline-state' && entry.data.type === 'peer').length, 1);
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen subscription-state' && entry.data.state === 'playing').length, 1);
  await f.command({ action: 'stop', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: watched.presentationId });
  assert.ok(f.logs.some(entry => entry.message === 'Native screen unwatch-requested'));
  assert.ok(f.logs.some(entry => entry.message === 'Native screen subscription-retirement-result' && entry.data.closed));
  assert.doesNotMatch(JSON.stringify(f.logs), /secret-|private-peer|sdp|credential/);
});

test('asynchronous capture and preview failures persist bounded diagnostics without changing source ownership', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource();
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  const endpoint = f.endpoints[0];
  for (let index = 0; index < 100; index++)
    endpoint.options.onDiagnostic(Object.assign(new Error(`secret-${index}`), { code: 'ERR_SCREEN_CAPTURE_TEST' }));
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen capture-diagnostic failed').length, 1);
  f.ports[0].port1.emit('message', { data: { password: 'secret-preview' } });
  await tick();
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen preview failed').length, 1);
  assert.ok(f.logs.some(entry => entry.message === 'Native screen preview-state' && entry.data.state === 'unavailable'));
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  assert.equal(f.sent.some(event => event.type === 'error'), false);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret-|password/);
  assert.equal(f.ports[0].port1.listenerCount('message'), 0);
  assert.equal(endpoint.closed, true);
});

test('a failed diagnostic sink cannot bypass native ownership guards or prevent teardown', async t => {
  const f = fixture(t, { logger: { write() { throw new Error('modeled disk failure'); } } });
  await f.join();
  const { source } = await f.addSource();
  await assert.rejects(f.addSource(), /already exists/);
  await f.command({ action: 'source-remove', shareId: source.shareId });
  await f.command({ action: 'leave' });
  assert.equal(f.removedDirectories.length, 1);
  assert.equal((await f.command({ action: 'leave' })).kind, 'ok');
  assert.equal(f.errors.filter(values => values[0] === '[NativeScreen] Persistent diagnostic sink failed; media ownership is unchanged.').length, 1);
  assert.equal(f.errors.some(values => values.some(value => value instanceof Error && value.message === 'modeled disk failure')), false);
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

for (const mode of ['p2p', 'sfu']) {
  for (const captureKind of ['window', 'game']) {
    test(`${mode}/${captureKind}: own-window audio is rejected before probing and does not poison the next share`, async t => {
      const f = fixture(t);
      f.config.mode = mode;
      await f.join();
      const target = { kind: captureKind, hwnd: 12345, expectedProcessId: process.pid,
        expectedProcessCreationTime100ns: '123456789' };
      f.replaceTarget(target);
      await assert.rejects(f.addSource('own', { captureKind }), {
        code: 'ERR_AUDIO_TARGET', message: 'screenShare.ownWindowAudioUnavailable',
      });
      assert.equal(f.probes.length, 0);
      assert.equal(f.endpoints.length, 0);
      assert.equal(f.captures.length, 0);
      const silent = await f.addSource('own', { captureKind, audio: false });
      assert.equal(silent.source.audio, false);
      await f.command({ action: 'source-remove', shareId: 'own' });
      f.replaceTarget({ ...target, expectedProcessId: process.pid + 1 });
      const game = await f.addSource('game', { captureKind });
      assert.equal(game.source.audio, true, 'Another application can share audio without leaving the call.');
      assert.equal(f.captures.length, 0, 'Admission must not capture real audio.');
    });
  }
}

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
  assert.equal(f.probes[0].options.video.scaleMode, 'stretch');
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
    assert.equal(f.endpoints[0].options.preserveAspectRatio, false);
    assert.equal(f.probes[0].closed, true);
  });
}

for (const captureKind of ['window', 'monitor', 'game']) {
  test(`${captureKind}: preview retains the exact target/audio selector without starting PCM`, async t => {
    const f = fixture(t);
    await f.join();
    const { source } = await f.addSource('selected', {
      captureKind, preserveAspectRatio: true,
      desktopSourceId: captureKind === 'monitor' ? monitorId : `window:12345:${'b'.repeat(64)}`,
    });
    assert.equal(f.probes[0].target.kind, captureKind);
    assert.equal(f.probes[0].options.video.scaleMode, 'fit');
    assert.equal(Object.hasOwn(source, 'preserveAspectRatio'), false, 'Scaling is local publisher policy, not a wire field.');
    await f.command({ action: 'preview-start', shareId: source.shareId,
      sourceInstanceId: source.instanceId, presentationId: randomUUID() });
    assert.equal(f.endpoints.length, 1);
    const endpoint = f.endpoints[0];
    assert.equal(endpoint.options.preserveAspectRatio, true);
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

test('nested Game Capture failures preserve an actionable IPC code without changing the public reason', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource('game', { captureKind: 'game' });
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  const gameFailure = Object.assign(new Error('Selected game supplied no frames.'),
    { code: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE' });
  const failure = new AggregateError([new Error('Retirement detail')],
    'Capture failed', { cause: new Error('Wrapper', { cause: gameFailure }) });
  gameFailure.cause = failure;
  f.endpoints[0].options.onError(failure);
  await tick(); await tick();
  const event = f.sent.find(value => value.type === 'error' && value.shareId === source.shareId);
  assert.ok(event);
  assert.equal(event.code, 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE');
  assert.equal(event.reason, 'capture-failed');
  assert.match(event.message, /Selected game supplied no frames/);
  assert.ok(event.message.length <= 4096);
  assert.equal(shared.nativeScreenEventSchema.safeParse({ ...event, code: 'UNKNOWN' }).success, false);
});

test('AMF level rejection uses unsupported while retaining bounded required/maximum native measurements', async t => {
  const message = 'AMF H264 requires level_idc=60 for 3840x2160@120; selected adapter/runtime reports MaxLevel=52.'
    + ' This rendition is unsupported; no lower-level or software fallback was applied.';
  const native = Object.assign(new Error(message), { code: 'ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED' });
  const failure = new AggregateError([native], 'PRIVATE_PATH_CREDENTIAL');
  native.cause = failure;
  const f = fixture(t, { probeFailure: failure });
  await f.join();
  await assert.rejects(f.addSource(), /MaxLevel=52/);
  const diagnostic = f.logs.find(entry => entry.message === 'Native screen source-admission failed');
  assert.deepEqual(diagnostic.data.nativeDiagnostics, [
    { kind: 'amf-h264-level', requiredLevel: 60, maximumLevel: 52, width: 3840, height: 2160, fps: 120 },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_PATH_CREDENTIAL/);
  f.setProbeFailure(null);
  const { source } = await f.addSource();
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  f.endpoints[0].options.onError(failure);
  await tick(); await tick();
  const event = f.sent.find(value => value.type === 'error' && value.shareId === source.shareId);
  assert.equal(event.reason, 'unsupported');
  assert.match(event.message, /level_idc=60.*MaxLevel=52/);
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
test('diagnostics of a mapped publisher awaiting real retirement are explicitly unavailable', async t => {
  const f = fixture(t), gate = deferred();
  await f.join();
  const { source } = await f.addSource();
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  const endpoint = f.endpoints[0], close = endpoint.close.bind(endpoint);
  let closing = false;
  endpoint.close = async () => { closing = true; await gate.promise; return close(); };
  const removing = f.command({ action: 'source-remove', shareId: source.shareId });
  try {
    await tick();
    assert.equal(closing, true);
    assert.deepEqual(await f.command({ action: 'diagnostics', publisherSessionId: f.config.sessionId,
      shareId: source.shareId, sourceInstanceId: source.instanceId }), { kind: 'diagnostics-retired' });
    assert.equal(f.errors.length, 0);
  } finally { gate.resolve(); await removing; }
});

test('pending diagnostics cannot return an old source after same-share quality replacement', async t => {
  const f = fixture(t), gate = deferred();
  await f.join();
  const { source } = await f.addSource();
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  const endpoint = f.endpoints[0], diagnostics = endpoint.diagnostics.bind(endpoint);
  endpoint.diagnostics = async () => { await gate.promise; return diagnostics(); };
  const query = { action: 'diagnostics', publisherSessionId: f.config.sessionId,
    shareId: source.shareId, sourceInstanceId: source.instanceId };
  const pending = f.command(query);
  const fresh = (await f.addSource(source.shareId, {
    replacesSourceInstanceId: source.instanceId, video: { ...video, fps: 30 },
  })).source;
  gate.resolve();
  assert.deepEqual(await pending, { kind: 'diagnostics-retired' });
  assert.equal((await f.command({ ...query, sourceInstanceId: fresh.instanceId })).kind, 'diagnostics');
  assert.equal((await f.command({ action: 'stats' })).publishers[0].source.instanceId, fresh.instanceId);
  assert.equal(f.errors.length, 0);
});

test('pending receive diagnostics cannot outlive Stop or contaminate a fresh Watch', async t => {
  const f = fixture(t, { role: 'viewer' }), gate = deferred();
  await f.join(); await f.participants();
  const watched = await f.watch();
  await f.accepted(f.sent.find(event => event.type === 'signal' && event.signal.action === 'watch').signal);
  const endpoint = f.endpoints[0], diagnostics = endpoint.diagnostics.bind(endpoint);
  endpoint.diagnostics = async () => { await gate.promise; return diagnostics(); };
  const query = { action: 'diagnostics', publisherSessionId: 'publisher', shareId: f.source.shareId,
    sourceInstanceId: f.source.instanceId, presentationId: watched.presentationId };
  const pending = f.command(query);
  await f.command({ action: 'stop', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: watched.presentationId });
  const fresh = await f.watch();
  gate.resolve();
  assert.deepEqual(await pending, { kind: 'diagnostics-retired' });
  assert.equal((await f.command({ ...query, presentationId: fresh.presentationId })).kind, 'diagnostics');
  assert.equal((await f.command({ action: 'stats' })).subscriptions.length, 1);
  assert.equal(f.errors.length, 0);
});

test('active diagnostic failures remain visible rather than becoming a retirement reply', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource();
  await f.command({ action: 'preview-start', shareId: source.shareId,
    sourceInstanceId: source.instanceId, presentationId: randomUUID() });
  f.endpoints[0].diagnostics = async () => { throw new Error('Malformed active native snapshot.'); };
  await assert.rejects(f.command({ action: 'diagnostics', publisherSessionId: f.config.sessionId,
    shareId: source.shareId, sourceInstanceId: source.instanceId }), /Malformed active native snapshot/);
  assert.ok(f.logs.some(entry => entry.level === 'ERROR' && entry.data.action === 'diagnostics'));
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

test('audio replacement reserves only the exact same-call source and failed preflight leaves its owner intact', async t => {
  const f = fixture(t);
  await f.join();
  const old = (await f.addSource('old-audio', { captureKind: 'game' })).source;
  for (const changes of [
    { replacesAudioShareId: 'missing' }, { replacesAudioShareId: old.shareId, audio: false },
  ]) await assert.rejects(f.addSource('invalid', changes), /existing audible source/);
  const otherCallId = randomUUID();
  await f.invoke({ ...f.config, callId: otherCallId, action: 'join' });
  await assert.rejects(f.invoke({
    action: 'source-add', callId: otherCallId, shareId: 'cross-call', desktopSourceId: monitorId,
    captureKind: 'monitor', video, audio: true, audioBitrateKbps: 128, replacesAudioShareId: old.shareId,
  }), /existing audible source/);
  await f.invoke({ action: 'leave', callId: otherCallId });
  f.setProbeFailure(new Error('Replacement preflight failed'));
  await assert.rejects(f.addSource('new-audio', {
    captureKind: 'monitor', desktopSourceId: monitorId, replacesAudioShareId: old.shareId,
  }), /preflight failed/);
  f.setProbeFailure(null);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  assert.equal(f.sent.some(event => event.shareId === old.shareId && event.state === 'closed'), false);
  await f.addSource('new-audio', {
    captureKind: 'monitor', desktopSourceId: monitorId, replacesAudioShareId: old.shareId,
  });
  await assert.rejects(f.addSource('third-audio', { replacesAudioShareId: old.shareId }), /reserve capture audio/);
  assert.equal(f.captures.length, 0);
  await f.command({ action: 'source-remove', shareId: 'new-audio' });
  await assert.rejects(f.addSource('unrelated-audio'), /reserve capture audio/);
});

test('same-share quality preflight preserves the running instance on failure and retires it only after acceptance', async t => {
  const f = fixture(t);
  await f.join();
  let current = (await f.addSource()).source;
  await f.command({ action: 'preview-start', shareId: current.shareId,
    sourceInstanceId: current.instanceId, presentationId: randomUUID() });
  const first = f.endpoints[0];
  const selected = { width: 1280, height: 720, fps: 30, maxBitrateKbps: 3000 };
  f.setProbeFailure(new Error('Modeled unsupported encoder profile'));
  await assert.rejects(f.addSource(current.shareId, {
    replacesSourceInstanceId: current.instanceId, video: selected,
  }), /unsupported encoder profile/);
  assert.equal(first.closed, false);
  assert.equal(f.sent.some(event => event.state === 'closed' && event.sourceInstanceId === current.instanceId), false);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  f.setProbeFailure(null);
  for (const nextVideo of [selected, { ...selected, fps: 120 }, { ...selected, fps: 120, maxBitrateKbps: 20000 }, video]) {
    const old = current, endpoint = f.endpoints.at(-1);
    current = (await f.addSource(old.shareId, { replacesSourceInstanceId: old.instanceId, video: nextVideo })).source;
    assert.equal(current.shareId, old.shareId);
    assert.notEqual(current.instanceId, old.instanceId);
    assert.equal(current.audio, true);
    assert.equal(endpoint.closed, true);
    assert.deepEqual(current.video, nextVideo);
    assert.equal(f.sent.filter(event => event.state === 'closed' && event.sourceInstanceId === old.instanceId).length, 1);
    await f.command({ action: 'preview-start', shareId: current.shareId,
      sourceInstanceId: current.instanceId, presentationId: randomUUID() });
    assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  }
  await assert.rejects(f.addSource(current.shareId, {
    replacesSourceInstanceId: first.options.source.instanceId, video: selected,
  }), /exact existing source/);
  await assert.rejects(f.addSource(current.shareId, {
    replacesSourceInstanceId: current.instanceId, desktopSourceId: monitorId, captureKind: 'monitor', video: selected,
  }), /exact existing source/);
  assert.equal(f.endpoints.at(-1).closed, false);
});

test('Stop during same-share quality preflight aborts the reservation before retiring the exact old source', async t => {
  const gpu = deferred(), nextProbe = deferred(), f = fixture(t, { gpu });
  await f.join();
  gpu.resolve();
  const old = (await f.addSource()).source;
  await f.command({ action: 'preview-start', shareId: old.shareId,
    sourceInstanceId: old.instanceId, presentationId: randomUUID() });
  gpu.promise = nextProbe.promise;
  const pending = assert.rejects(f.addSource(old.shareId, {
    replacesSourceInstanceId: old.instanceId, video: { ...video, fps: 30 },
  }), { name: 'AbortError' });
  await tick();
  assert.equal(f.endpoints[0].closed, false);
  await f.command({ action: 'source-remove', shareId: old.shareId });
  await pending;
  nextProbe.resolve();
  await tick();
  assert.equal(f.endpoints[0].closed, true);
  assert.equal(f.endpoints.length, 1);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  assert.equal(f.sent.filter(event => event.state === 'closed' && event.sourceInstanceId === old.instanceId).length, 1);
});

test('quality replacement with an unacknowledged old audio retirement cannot admit a second owner', async t => {
  const f = fixture(t);
  await f.join();
  const old = (await f.addSource()).source;
  await f.command({ action: 'preview-start', shareId: old.shareId,
    sourceInstanceId: old.instanceId, presentationId: randomUUID() });
  const endpoint = f.endpoints[0], hub = endpoint.options.audio.captureHub, close = hub.close.bind(hub);
  hub.close = async () => { throw new Error('Modeled retained PCM owner'); };
  await assert.rejects(f.addSource(old.shareId, {
    replacesSourceInstanceId: old.instanceId, video: { ...video, fps: 30 },
  }), /retirement reported failures/);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  assert.equal(endpoint.closed, true);
  assert.equal(hub.getStats().closed, false);
  assert.equal(f.endpoints.length, 1);
  hub.close = close;
  await f.command({ action: 'source-remove', shareId: old.shareId });
  assert.equal(hub.getStats().closed, true);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
});

test('replacement preview cannot activate PCM before the prior owner retires', async t => {
  const f = fixture(t);
  await f.join();
  const old = (await f.addSource('old-audio')).source;
  const next = (await f.addSource('new-audio', {
    captureKind: 'monitor', desktopSourceId: monitorId, replacesAudioShareId: old.shareId,
  })).source;
  await assert.rejects(f.command({
    action: 'preview-start', shareId: next.shareId, sourceInstanceId: next.instanceId, presentationId: randomUUID(),
  }), /previous screen audio owner must retire/);
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.captures.length, 0);
  assert.equal(f.sent.some(event => event.shareId === old.shareId && event.state === 'closed'), false);
});

test('cancelling replacement admission releases its reservation without cancelling the old audio owner', async t => {
  const f = fixture(t);
  await f.join();
  const old = (await f.addSource('old-audio')).source;
  const replacement = { captureKind: 'monitor', desktopSourceId: monitorId, replacesAudioShareId: old.shareId };
  const pending = f.addSource('new-audio', replacement);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await f.command({ action: 'source-remove', shareId: 'new-audio' });
  await rejected;
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  assert.equal(f.sent.some(event => event.shareId === old.shareId && event.state === 'closed'), false);
  const retried = (await f.addSource('new-audio', replacement)).source;
  assert.equal(retried.audio, true);
  assert.equal(f.captures.length, 0);
});

test('same-call game/window to monitor swaps retire PCM, reset selectors and reject stale deliveries', async t => {
  const active = new Set(), nativeCaptures = [];
  let stopFailure = false, captureFailure = false;
  const f = fixture(t, { packetCapture(selection, onEvent) {
    assert.equal(active.size, 0, 'Exclusive PCM acquisition cannot overlap during a source swap');
    const closed = deferred();
    const capture = {
      selection, onEvent, closed: false,
      getStats: () => ({ state: capture.closed ? 'closed' : 'capturing' }),
    };
    active.add(capture); nativeCaptures.push(capture);
    const ready = { type: 'ready', sessionId: randomUUID(), format: { sampleRate: 48000, channels: 2 } };
    if (!captureFailure) onEvent(ready);
    return {
      ready: captureFailure ? Promise.reject(new Error('Selected PCM acquisition failed')) : Promise.resolve(ready),
      closed: closed.promise, getStats: capture.getStats,
      async stop() {
        if (stopFailure) throw new Error('PCM worker retirement failed');
        capture.closed = true; active.delete(capture); closed.resolve();
      },
    };
  } });
  const watch = source => f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  await f.join(); await f.participants();
  let previous = null, previousEndpoint = null, previousPackets = null;
  for (const [index, kind] of ['game', 'monitor', 'window', 'monitor', 'game'].entries()) {
    const source = (await f.addSource(`swap-${index}`, {
      captureKind: kind, desktopSourceId: kind === 'monitor' ? monitorId : 'window:12345:0',
      ...(previous ? { replacesAudioShareId: previous.shareId } : {}),
    })).source;
    assert.equal(nativeCaptures.length, index, 'Admission/preflight alone never opens a PCM capture');
    if (previous) {
      const oldCapture = nativeCaptures.at(-1);
      const oldCount = previousPackets.length;
      if (index === 1) {
        stopFailure = true;
        await assert.rejects(f.command({ action: 'source-remove', shareId: previous.shareId }), /retirement reported failures/);
        assert.equal(active.size, 1, 'Failed retirement retains the real PCM obligation');
        assert.equal((await f.command({ action: 'stats' })).publishers.length, 2);
        stopFailure = false;
      }
      await f.command({ action: 'source-remove', shareId: previous.shareId });
      assert.equal(oldCapture.closed, true);
      assert.equal(previousEndpoint.options.audio.captureHub.getStats().closed, true);
      oldCapture.onEvent({ type: 'packet', sequence: 999, pcm: Buffer.alloc(8) });
      assert.equal(previousPackets.length, oldCount, 'Detached subscribers cannot receive late old-source PCM');
    }
    await watch(source);
    const endpoint = f.endpoints.at(-1);
    const selection = kind === 'monitor' ? { excludePid: process.pid }
      : { includeWindowId: 12345, expectedProcessId: 56789 };
    assert.equal(endpoint.options.source.instanceId, source.instanceId);
    assert.notEqual(source.instanceId, previous?.instanceId);
    assert.equal(endpoint.options.target.kind, kind);
    assert.ok(runtime.NativePcmCaptureHub.matches(endpoint.options.audio.captureHub, endpoint.options.audio.captureModule, selection));
    assert.notEqual(endpoint.options.audio.captureHub, previousEndpoint?.options.audio.captureHub);
    const packets = [];
    const subscription = endpoint.options.audio.captureHub.subscribe(selection, event => packets.push(event));
    await subscription.ready;
    const capture = nativeCaptures.at(-1);
    assert.deepEqual(capture.selection, selection);
    const packet = { type: 'packet', sequence: 1, pcm: Buffer.from([1, 2, 3, 4]) };
    capture.onEvent(packet);
    assert.equal(packets.at(-1), packet, 'The production hub forwards the modeled packet payload unchanged');
    if (previous) {
      await f.command({ action: 'source-remove', shareId: previous.shareId });
      assert.equal(active.size, 1, 'A late old Stop cannot stop the replacement capture');
    }
    previous = source; previousEndpoint = endpoint; previousPackets = packets;
  }
  await f.command({ action: 'source-remove', shareId: previous.shareId });
  assert.equal(active.size, 0);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
  captureFailure = true;
  const failed = (await f.addSource('failed-audio', { captureKind: 'monitor', desktopSourceId: monitorId })).source;
  await watch(failed);
  const failedSubscription = f.endpoints.at(-1).options.audio.captureHub.subscribe({ excludePid: process.pid }, () => {});
  await assert.rejects(failedSubscription.ready, /Selected PCM acquisition failed/);
  await tick();
  assert.ok(f.sent.some(event => event.type === 'error' && event.shareId === failed.shareId
    && event.sourceInstanceId === failed.instanceId), 'PCM readiness failure must reach the real source error boundary');
  await f.command({ action: 'source-remove', shareId: failed.shareId });
  assert.equal(active.size, 0);
  assert.equal(new Set(f.logs.filter(entry => entry.message === 'Native screen source-admitted')
    .map(entry => entry.data.call)).size, 1, 'All swaps remain in the original native call');
});

test('shutdown preparation keeps the real Main RPC bridge live until native retirement, then accepts only retired-call goodbye', async t => {
  const f = fixture(t, { role: 'viewer' });
  f.config.mode = 'sfu';
  await f.join(); await f.participants(); await f.watch();
  await f.accepted(f.sent.find(value => value.type === 'signal' && value.signal.action === 'watch').signal);
  const endpoint = f.endpoints[0], close = endpoint.close.bind(endpoint), send = f.contents.send;
  let pending;
  f.contents.send = (channel, value) => {
    if (value.type === 'rpc' && value.method === shared.MessageType.SFU_CLOSE_WEBRTC_TRANSPORT) {
      pending = value;
      f.sent.push(value);
    } else send(channel, value);
  };
  endpoint.close = async () => {
    await endpoint.options.rpc(shared.MessageType.SFU_CLOSE_WEBRTC_TRANSPORT,
      { channelId: f.config.channelId, transportId: 'owned-transport' });
    await close();
  };
  const preparing = f.service.prepareShutdown();
  await tick();
  assert.ok(pending);
  assert.equal(endpoint.closed, false);
  await assert.rejects(f.invoke({ ...f.config, callId: randomUUID(), action: 'join' }), { name: 'AbortError' });
  await f.reply({ callId: pending.callId, requestId: pending.requestId, ok: true,
    value: { channelId: f.config.channelId, transportId: 'owned-transport' } });
  await preparing;
  assert.equal(endpoint.closed, true);
  assert.equal((await f.command({ action: 'leave' })).kind, 'ok');
  assert.equal((await f.command({ action: 'leave-local' })).kind, 'ok');
  await assert.rejects(f.invoke({ action: 'leave', callId: randomUUID() }), { name: 'AbortError' });
  await assert.rejects(f.join(), { name: 'AbortError' });
  await f.service.prepareShutdown();
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen call-retirement').length, 1);
});

test('native admission freeze retains control notifications and reply ownership until renderer quiescence', async t => {
  const f = fixture(t);
  await f.join(); await f.participants();
  f.service.freezeAdmissions();
  assert.equal((await f.command({ action: 'producer-remove', producerId: 'retiring-producer' })).kind, 'ok');
  await f.participants();
  await assert.rejects(f.addSource(), { name: 'AbortError' });
  await assert.rejects(f.join(), { name: 'AbortError' });
  assert.ok(f.logs.some(entry => entry.message === 'Native screen command-cancelled'
    && entry.data.action === 'source-add'));
  assert.equal((await f.command({ action: 'leave' })).kind, 'ok');
  await f.service.prepareShutdown();
  assert.equal((await f.command({ action: 'leave' })).kind, 'ok');
  await assert.rejects(f.invoke({ action: 'leave', callId: randomUUID() }), { name: 'AbortError' });
});

test('shutdown preparation retries retained owners without dropping the renderer or admitting new work', async t => {
  const f = fixture(t, { role: 'viewer' });
  await f.join(); await f.participants(); await f.watch();
  await f.accepted(f.sent.find(value => value.type === 'signal' && value.signal.action === 'watch').signal);
  const endpoint = f.endpoints[0], close = endpoint.close.bind(endpoint);
  let retained = true;
  endpoint.close = async () => {
    if (retained) throw new Error('Original native owner has not retired');
    await close();
  };
  await assert.rejects(f.service.prepareShutdown(), /preparation failed/);
  assert.equal(endpoint.closed, false);
  await assert.rejects(f.join(), { name: 'AbortError' });
  retained = false;
  await f.service.prepareShutdown();
  assert.equal(endpoint.closed, true);
  assert.equal((await f.command({ action: 'leave' })).kind, 'ok');
});

for (const initiallyRetained of [false, true]) {
  test(`disconnection during shutdown requires original local closure proof (retained=${initiallyRetained})`, async t => {
    const f = fixture(t, { role: 'viewer' });
    await f.join(); await f.participants(); await f.watch();
    await f.accepted(f.sent.find(value => value.type === 'signal' && value.signal.action === 'watch').signal);
    const endpoint = f.endpoints[0], close = endpoint.close.bind(endpoint), send = f.contents.send;
    let retained = initiallyRetained, pending;
    endpoint.close = async () => {
      if (retained) throw new Error('Original GPU/PCM ownership remains unresolved');
      await close();
    };
    f.contents.send = (channel, value) => {
      if (value.type === 'signal' && value.signal.action === 'stop') pending = value;
      else send(channel, value);
    };
    const prepared = f.service.prepareShutdown().then(() => null, error => error);
    await tick();
    assert.ok(pending);
    if (retained) {
      await assert.rejects(f.command({ action: 'leave-local' }), /shutdown reported failures/);
      assert.match((await prepared).message, /preparation failed/);
      assert.equal(endpoint.closed, false);
      retained = false;
      await f.service.prepareShutdown();
    } else {
      const result = await f.command({ action: 'leave-local' });
      assert.equal(result.kind, 'retired-with-errors');
      assert.equal(await prepared, null);
    }
    assert.equal(endpoint.closed, true);
    assert.ok(f.logs.some(entry => entry.message === 'Native screen shutdown-locally-retired'
      && entry.data.remoteAcknowledged === false));
  });
}

test('global application shutdown Retry retires the retained PCM subscriber after a failed stop with real closure', async t => {
  let stopCalls = 0;
  const closed = deferred();
  const f = fixture(t, { packetCapture(_selection, onEvent) {
    const ready = { type: 'ready', sessionId: randomUUID(), format: { sampleRate: 48000, channels: 2 } };
    onEvent(ready);
    return {
      ready: Promise.resolve(ready), closed: closed.promise,
      getStats: () => ({ state: stopCalls ? 'closed' : 'capturing' }),
      async stop() {
        stopCalls++;
        closed.resolve();
        throw new Error('PCM stop reported failure after the actual worker retired');
      },
    };
  } });
  await f.join(); await f.participants();
  const source = (await f.addSource()).source;
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  const hub = f.endpoints[0].options.audio.captureHub;
  const subscription = hub.subscribe({ includeWindowId: 12345, expectedProcessId: 56789 }, () => {});
  await subscription.ready;
  await assert.rejects(f.service.dispose(), /cleanup did not finish/);
  assert.equal(hub.getStats().closed, false);
  assert.equal(hub.getStats().captureClosed, true);
  await f.service.dispose();
  assert.equal(hub.getStats().closed, true);
  assert.equal(subscription.getStats().detached, true);
  assert.equal(stopCalls, 1);
  assert.ok(f.logs.some(entry => entry.message === 'Native screen call-retirement-result' && entry.data.retained));
  assert.ok(f.logs.some(entry => entry.message === 'Native screen call-retirement-result' && !entry.data.retained));
});

test('global shutdown rejects a new call while its existing native owner is still draining', async t => {
  const f = fixture(t), gate = deferred();
  await f.join(); await f.participants();
  const source = (await f.addSource()).source;
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  const endpoint = f.endpoints[0], close = endpoint.close.bind(endpoint);
  endpoint.close = async () => { await gate.promise; await close(); };
  const closing = f.service.dispose();
  await tick();
  try {
    await assert.rejects(f.invoke({ ...f.config, callId: randomUUID(), action: 'join' }), { name: 'AbortError' });
    assert.equal(endpoint.closed, false);
  } finally { gate.resolve(); await closing; }
  assert.equal(endpoint.closed, true);
});

test('global shutdown keeps unresolved native ownership blocked across Retry and records its sanitized identity', async t => {
  const f = fixture(t);
  await f.join(); await f.participants();
  const source = (await f.addSource()).source;
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  const endpoint = f.endpoints[0], close = endpoint.close.bind(endpoint);
  let released = false;
  endpoint.close = async () => {
    if (!released) throw new Error('Original native engine is still retained');
    await close();
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.service.dispose(), /cleanup did not finish/);
      assert.equal(endpoint.closed, false);
    }
    const owner = f.logs.find(entry => entry.message === 'Native screen retained-source-owner');
    assert.equal(owner.data.phase, 'publisher-retirement');
    assert.equal(owner.data.publisherClosed, false);
    assert.match(owner.data.source, /^[a-f0-9]{16}$/);
    assert.notEqual(owner.data.source, source.shareId);
  } finally { released = true; await f.service.dispose(); }
  assert.equal(endpoint.closed, true);
});

test('global shutdown aborts a pending selected-source probe without late media admission', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const pending = assert.rejects(f.addSource(), { name: 'AbortError' });
  await tick();
  await f.service.dispose();
  await pending;
  gpu.resolve();
  await tick();
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.probes[0].closed, true);
  assert.equal(f.removedDirectories.length, 1);
});

test('global shutdown drains an in-flight quality replacement without admitting its new source', async t => {
  const f = fixture(t), gate = deferred();
  await f.join();
  const old = (await f.addSource()).source;
  await f.command({ action: 'preview-start', shareId: old.shareId,
    sourceInstanceId: old.instanceId, presentationId: randomUUID() });
  const prototype = f.probes[0].constructor.prototype, prepare = prototype.prepare;
  t.mock.method(prototype, 'prepare', async function(target, signal) {
    await prepare.call(this, target, signal);
    await gate.promise;
    signal.throwIfAborted();
  });
  const replacing = assert.rejects(f.addSource(old.shareId, {
    replacesSourceInstanceId: old.instanceId, video: { ...video, fps: 60 },
  }), { name: 'AbortError' });
  await tick();
  const stopping = f.service.dispose();
  gate.resolve();
  await Promise.all([stopping, replacing]);
  assert.equal(f.endpoints.length, 1);
  assert.equal(f.endpoints[0].closed, true);
  assert.equal(f.probes.every(probe => probe.closed), true);
  assert.equal(f.logs.filter(entry => entry.message === 'Native screen source-admitted').length, 1);
  assert.ok(f.logs.some(entry => entry.message === 'Native screen call-retirement-result' && !entry.data.retained));
});

test('global shutdown and a source-gone monitor share the same pending endpoint retirement', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t), gate = deferred();
  await f.join(); await f.participants();
  const source = (await f.addSource()).source;
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  const endpoint = f.endpoints[0], close = endpoint.close.bind(endpoint);
  let stops = 0;
  endpoint.close = async () => { stops++; await gate.promise; await close(); };
  f.closeWindow();
  t.mock.timers.tick(250);
  const closing = f.service.dispose();
  await tick();
  assert.equal(endpoint.closed, false);
  gate.resolve();
  await closing;
  assert.equal(endpoint.closed, true);
  assert.equal(stops, 1);
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

test('Game fallback emits one local notice, preserves its announcement/audio hub and starts future profiles in Normal', async t => {
  const f = fixture(t);
  await f.join(); await f.participants();
  const { source } = await f.addSource('game-fallback', { captureKind: 'game', preserveAspectRatio: true });
  const presentationId = randomUUID();
  await f.command({ action: 'preview-start', shareId: source.shareId, sourceInstanceId: source.instanceId, presentationId });
  const endpoint = f.endpoints[0];
  const original = endpoint.options.target;
  endpoint.options.onState({ type: 'capture-fallback' });
  endpoint.options.onState({ type: 'capture-fallback' });
  assert.equal(f.sent.filter(event => event.type === 'capture-fallback').length, 1);
  assert.equal(f.sent.some(event => event.type === 'error'), false);
  assert.equal((await f.command({ action: 'stats' })).publishers[0].source.instanceId, source.instanceId);
  assert.equal(f.sent.some(event => event.type === 'capture-mode'), false, 'A fallback attempt has not confirmed Normal yet.');
  endpoint.options.onState({ type: 'capture-mode', capture: { mode: 'normal', ready: true } });
  for (let index = 0; index < 3; index++)
    endpoint.options.onPreview({ data: new Uint8Array([1]), timestampUs: 1000 + index, keyframe: true });
  assert.deepEqual(f.sent.filter(event => event.type === 'capture-mode'), [{
    type: 'capture-mode', callId: f.config.callId, publisherSessionId: 'publisher',
    shareId: source.shareId, sourceInstanceId: source.instanceId, presentationId, mode: 'normal',
  }]);
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: '480p30', backend: 'native',
  } });
  const next = f.endpoints[1];
  assert.deepEqual(next.options.target, { ...original, kind: 'window' });
  assert.equal(next.options.preserveAspectRatio, true);
  assert.equal(next.options.audio.captureHub, endpoint.options.audio.captureHub);
  f.replaceWindowProcess();
  assert.throws(next.options.assertSourceCurrent, { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
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
