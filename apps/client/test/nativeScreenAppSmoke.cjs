'use strict';

// Diagnostics are opt-in and use only this fixture's synthetic source and owned viewer.
// --encoded-byte-trace records at most20s/32MiB/2400 packets; CDP trace exports stop at128MiB.
// Viewer diagnostic logs are streamed with a32MiB/file cap; truncation fails the probe.
// --gpu-task-trace is passive15-20s; --video-overlay-counterfactual changes only the viewer,
// never production defaults or the original120fps/explicit60fps qualification thresholds.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { within } = require('../native/screen-share/runtime/nativeDeadline.cjs');

const repo = path.resolve(__dirname, '..', '..', '..');
const clientRoot = path.join(repo, 'apps', 'client');
const artifacts = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
assert.ok(artifacts && path.isAbsolute(artifacts), 'Choose a new, absolute directory for the test report.');
const mode = process.argv.includes('--sfu') ? 'sfu' : 'p2p';
const screenCodec = process.argv.find(value => value.startsWith('--screen-codec='))?.slice('--screen-codec='.length) ?? 'auto';
assert.ok(['h264', 'av1', 'auto'].includes(screenCodec), 'Screen codec must be h264, av1 or auto.');
const browserReceiver = process.argv.includes('--browser-receiver');
const audioEnabled = !process.argv.includes('--video-only');
const debugPublisher = process.argv.includes('--debug-publisher');
const unsupportedBrowserCodec = process.argv.includes('--unsupported-browser-codec');
const incompatibleViewer = process.argv.includes('--incompatible-viewer');
const overlayEnabled = process.argv.includes('--overlay');
const sessionNavigation = process.argv.includes('--session-navigation');
const serverLoss = process.argv.includes('--server-loss');
const windowLifecycle = process.argv.includes('--window-lifecycle');
const idleSourceClose = process.argv.includes('--idle-source-close');
const admissionRecovery = process.argv.includes('--admission-recovery');
assert.ok(!(process.argv.includes('--preserve-aspect-ratio') && process.argv.includes('--stretch')),
  'Choose either --preserve-aspect-ratio or --stretch, not both.');
const preserveAspectRatio = !process.argv.includes('--stretch');
const gameFallback = process.argv.includes('--game-fallback');
const publisherStop = process.argv.includes('--publisher-stop');
const sourceResize = process.argv.includes('--source-resize');
const sourceReplacement = process.argv.includes('--source-replacement');
const fourK120 = process.argv.includes('--4k') || process.argv.includes('--screen-profile=4k120');
const fourK60 = process.argv.includes('--4k60');
assert.ok(!(fourK120 && fourK60), 'Choose either explicit 4K120 or 4K60, never a silent downgrade.');
const fourK = fourK120 || fourK60;
const nativeFullHd60 = process.argv.includes('--native-1080p60');
assert.ok(!(nativeFullHd60 && process.argv.includes('--1080p60')), 'Choose one explicit 1080p60 receiver scenario.');
const fullHd60 = process.argv.includes('--1080p60') || nativeFullHd60;
assert.ok(!fullHd60 || ((nativeFullHd60 ? !browserReceiver : browserReceiver && audioEnabled) && !fourK
  && !process.argv.includes('--source-quality-changes') && !sourceReplacement
  && !incompatibleViewer && !unsupportedBrowserCodec),
  'Use --1080p60 with the audio-enabled browser receiver or --native-1080p60 with native reception, without competing profiles.');
const sourceQualityChanges = process.argv.includes('--source-quality-changes') || fourK;
const strictMediaErrors = sourceQualityChanges || (browserReceiver && !unsupportedBrowserCodec);
const observeSourceClosure = browserReceiver && !sourceQualityChanges && !sourceReplacement && !unsupportedBrowserCodec;
const clockFeedbackStall = process.argv.includes('--clock-feedback-stall');
const cadenceDiagnostics = process.argv.includes('--cadence-diagnostics');
const cadenceFollowup = process.argv.includes('--cadence-followup');
assert.ok(!cadenceFollowup || (fullHd60 && cadenceDiagnostics),
  'Cadence follow-up requires explicit1080p60 and native cadence diagnostics.');
const chromiumReceiveLog = process.argv.includes('--chromium-receive-log');
assert.ok(!chromiumReceiveLog || (fullHd60 && browserReceiver && mode === 'sfu'),
  'Chromium receive logging is scoped to the owned explicit1080p60 SFU viewer.');
const encodedByteTrace = process.argv.includes('--encoded-byte-trace');
assert.ok(!encodedByteTrace || (chromiumReceiveLog && cadenceFollowup),
  'Encoded byte tracing requires the bounded owned-source Chromium cadence diagnostic.');
const gpuTaskTrace = process.argv.includes('--gpu-task-trace');
const videoOverlayCounterfactual = process.argv.includes('--video-overlay-counterfactual');
assert.ok(!videoOverlayCounterfactual || gpuTaskTrace,
  'The viewer-only overlay counterfactual requires the bounded passive GPU trace.');
assert.ok(!gpuTaskTrace || (chromiumReceiveLog && cadenceDiagnostics && !cadenceFollowup && !encodedByteTrace),
  'GPU task tracing requires the SFU60 logging scenario with passive cadence diagnostics, not byte/follow-up sampling.');
const closeAppActive = process.argv.includes('--close-app-active');
const sampleSeconds = Number(process.argv.find(value => value.startsWith('--sample-seconds='))?.slice('--sample-seconds='.length) ?? 3);
assert.ok(Number.isFinite(sampleSeconds) && sampleSeconds >= 3 && sampleSeconds <= 30,
  'Cadence intervals must be explicit and between 3 and 30 seconds.');
assert.ok(!gpuTaskTrace || (sampleSeconds >= 15 && sampleSeconds <= 20),
  'The passive GPU task trace interval must be15-20seconds.');
assert.ok(!closeAppActive || (!sourceReplacement && !serverLoss && !sessionNavigation
  && !incompatibleViewer && !unsupportedBrowserCodec && !windowLifecycle && !idleSourceClose && !overlayEnabled),
  'Active app-close regression requires one owned call without competing lifecycle scenarios.');
const minimum120Fps = Number(process.argv.find(value => value.startsWith('--min-fps='))?.slice('--min-fps='.length) ?? 100);
assert.ok(Number.isFinite(minimum120Fps) && minimum120Fps >= 100 && minimum120Fps <= 120,
  'The 120 FPS presentation threshold must stay between 100 and 120 FPS.');
const minimumPresentationFps = fullHd60 ? 50 : minimum120Fps;
const warmupSeconds = sampleSeconds >= 8 ? 3 : 0;
assert.ok(!sourceQualityChanges || (!browserReceiver && (mode === 'sfu' || fourK) && audioEnabled
  && !sourceReplacement && !gameFallback && !unsupportedBrowserCodec && !incompatibleViewer
  && !idleSourceClose && !admissionRecovery && !publisherStop && !windowLifecycle && !serverLoss
  && !sessionNavigation && !overlayEnabled && !sourceResize && !debugPublisher),
'Source quality changes require an audio-enabled native SFU receiver and the owned Normal window, without other scenarios.');
assert.ok(!clockFeedbackStall || sourceQualityChanges, 'Clock stall requires the owned native source-quality scenario.');
assert.ok(!sourceReplacement || (browserReceiver && mode === 'sfu' && audioEnabled
  && !gameFallback && !unsupportedBrowserCodec && !incompatibleViewer && !idleSourceClose
  && !admissionRecovery && !publisherStop && !windowLifecycle && !serverLoss && !sessionNavigation
  && !overlayEnabled && !sourceResize && !debugPublisher),
'Source replacement requires an audio-enabled browser SFU receiver and two owned Normal windows, without other smoke scenarios.');
assert.ok(!unsupportedBrowserCodec || (browserReceiver && mode === 'p2p'), 'The unsupported-codec case requires a browser P2P receiver.');
assert.ok(!incompatibleViewer || (!browserReceiver && mode === 'p2p'), 'Mixed compatibility requires a native primary P2P receiver.');
const debugSymbols = process.argv.find(value => value.startsWith('--debug-symbols='))?.slice('--debug-symbols='.length);
const report = { mode, screenCodec, fourK, fourK60, fourK120, fullHd60, nativeFullHd60, browserReceiver, audioEnabled, unsupportedBrowserCodec, incompatibleViewer, overlayEnabled, sessionNavigation, serverLoss, admissionRecovery, preserveAspectRatio, gameFallback, publisherStop, sourceResize, sourceReplacement, sourceQualityChanges, clockFeedbackStall, cadenceDiagnostics, cadenceFollowup, chromiumReceiveLog, closeAppActive, sampleSeconds, warmupSeconds,
  normalMain: true, normalPreload: true, ownedSyntheticSource: true,
  qaFocusHooks: 'owned parent IPC only; normal Main and preload checks unchanged',
  receiverSelection: browserReceiver ? 'explicit Chromium preference (not a macOS hardware test)' : 'native',
  recordedMedia: encodedByteTrace, phases: [] };
const clients = [], roots = [], failures = [], sourceOwners = [];
const cadenceFailures = [];
const expectedWindowClosures = new Map(), shutdownDialogs = [];
const shutdownErrors = [];
report.encodedByteTrace = encodedByteTrace;
report.gpuTaskTrace = gpuTaskTrace;
report.videoOverlayCounterfactual = videoOverlayCounterfactual;
const qaActionTimeline = [];
if (gpuTaskTrace) report.qaActionTimeline = qaActionTimeline;
const protocolContracts = require(path.join(repo, 'packages', 'shared', 'dist', 'index.js'));
report.protocolContracts = { version: protocolContracts.PROTOCOL_VERSION,
  minimumClient: protocolContracts.MIN_CLIENT_PROTOCOL, minimumBot: protocolContracts.MIN_BOT_PROTOCOL };
let server, otherServer, vite, source;
let debuggerProcess, debuggerExited;
let incompatibleSessionId = null;

function phase(name) { report.phases.push(name); console.log(`Native Monky app: ${name}`); }
function boundedDiagnosticLog(file, label) {
  const state = { label, bytes: 0, maximumBytes: 32 * 1024 * 1024, truncated: false, failed: false };
  let pending = Promise.resolve();
  return {
    state,
    write(value) {
      if (state.truncated || state.failed) return;
      const available = state.maximumBytes - state.bytes;
      const chunk = value.subarray(0, available);
      if (value.length > available) {
        state.truncated = true;
        failures.push(new Error(`${label} exceeded its32MiB diagnostic bound; log is truncated.`));
      }
      state.bytes += chunk.length;
      pending = pending.then(async () => {
        if (!state.failed) await file.writeFile(chunk);
      }).catch(error => { state.failed = true; failures.push(error); });
    },
    async close() { await pending; await file.close(); },
  };
}

function processAlive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function expectedSourceCloseLog(entry, label, closure) {
  const timestamp = Date.parse(entry.timestamp);
  if (label !== 'publisher' || !closure?.verified || !Number.isFinite(timestamp)
    || timestamp < Date.parse(closure.startedAt) || timestamp > Date.parse(closure.finishedAt)) return null;
  const data = entry.data;
  if (['Native screen publisher failed', 'Native screen source-monitor failed'].includes(entry.message)
    && data?.source === closure.diagnosticSource && data.call === closure.diagnosticCall
    && (!data.pipeline || closure.diagnosticPipelines.includes(data.pipeline))
    && data.error === 'operation-failed' && data.nativeCodes?.length === 1
    && data.nativeCodes[0] === 'ERR_SCREEN_CAPTURE_SOURCE_LOST') return 'native';
  if (entry.message === 'Native screen operation failed'
    && data?.error === closure.nativeError.message) return 'renderer';
  return null;
}

async function startSyntheticSource(label) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let sourceFile = path.join(clientRoot, 'native', 'screen-share', 'test', 'nativeAvSource.cjs');
  if (fourK || process.env.MONKY_TEST_DISPLAY !== undefined) {
    const wrapper = path.join(artifacts, `${label}-${fourK ? '4k' : 'display'}.cjs`);
    await fs.writeFile(wrapper, `(${sourceFixture.toString()})(${JSON.stringify({ sourceFile, ownerPid: process.pid,
      fourK, displayHelper: path.join(__dirname, 'fixtures', 'testDisplay.cjs') })});\n`,
      { flag: 'wx' });
    sourceFile = wrapper;
  }
  const child = spawn(require('electron'), [sourceFile,
    `--profile=${path.join(artifacts, `${label}-profile`)}`, ...(gameFallback ? ['--software-rendering'] : [])],
  { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const owner = { child, label, stopping: false, exited: null, ready: null };
  sourceOwners.push(owner);
  const log = await fs.open(path.join(artifacts, `${label}.log`), 'wx');
  child.stdout.on('data', value => { void log.write(value); });
  child.stderr.on('data', value => { void log.write(value); });
  owner.exited = once(child, 'exit').then(async ([code]) => {
    await log.close();
    if (!owner.stopping) failures.push(new Error(`The owned ${label} exited unexpectedly (${code}).`));
    return code;
  });
  const [ready] = await within(once(child, 'message'), 20000, 'Owned source readiness timed out.');
  assert.equal(ready.type, 'ready');
  assert.equal(ready.pid, child.pid);
  assert.equal(ready.softwareRendering, gameFallback);
  assert.ok(Number.isSafeInteger(ready.hwnd) && ready.hwnd > 0, 'The source child did not prove its own HWND.');
  owner.ready = ready;
  if (fourK) report.synthetic4kSource = ready;
  return owner;
}

function sourceFixture({ sourceFile, ownerPid, fourK, displayHelper }) {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, screen } = require('electron');
  assert.equal(process.ppid, ownerPid);
  let placement;
  try { placement = require(displayHelper).installTestDisplay({ app, screen, BrowserWindow }); }
  catch (error) { console.error('[TestDisplay] Source launch rejected:', error); app.exit(1); return; }
  const send = process.send.bind(process);
  process.send = (message, ...args) => {
    if (message.type !== 'ready') return send(message, ...args);
    void (async () => {
      const windows = BrowserWindow.getAllWindows();
      assert.equal(windows.length, 1);
      const window = windows[0];
      let canvas;
      if (fourK) {
        placement?.windowOptions({ width: 3840, height: 2160 });
        window.setMaximumSize(4096, 2304);
        window.setContentSize(3840, 2160);
        canvas = await window.webContents.executeJavaScript(`(() => {
        const canvas = document.getElementById('source');
        canvas.width = 3840; canvas.height = 2160;
        canvas.getContext('2d').setTransform(3840 / 800, 0, 0, 2160 / 600, 0, 0);
        return { width: canvas.width, height: canvas.height, innerWidth, innerHeight, devicePixelRatio };
        })()`);
      }
      send({ ...message, ...(fourK ? { canvas } : {}), contentSize: window.getContentSize(), bounds: window.getBounds(),
        testDisplay: placement?.snapshot() ?? null }, ...args);
    })().catch(error => { console.error(error); app.exit(1); });
    return true;
  };
  require(sourceFile);
}

async function sourceCommand(command, dimensions = {}, child = source) {
  const id = randomUUID(), response = once(child, 'message');
  child.send({ type: 'source-command', id, command, ...dimensions });
  const [result] = await within(response, 10000, `Owned source command timed out: ${command}`);
  assert.equal(result.id, id); assert.equal(result.ok, true, result.error);
}
async function until(probe, message, timeout = 30000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (failures.length) throw new AggregateError(failures, message);
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
}
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startLoopbackServer(instance, port) {
  assert.ok(instance.httpServer instanceof http.Server);
  const listen = instance.httpServer.listen;
  instance.httpServer.listen = function (requestedPort, host, ...args) {
    assert.equal(requestedPort, port); assert.equal(host, '0.0.0.0');
    return Reflect.apply(listen, this, [port, '127.0.0.1', ...args]);
  };
  instance.lanBroadcaster.start = async () => {};
  await instance.start();
  assert.equal(instance.httpServer.address().address, '127.0.0.1');
}

function mainFixture({ clientRoot, origin, ownerPid, clockFeedbackStall, fourK, cadenceDiagnostics, closeAppActive, observeSourceClosure,
  encodedByteTrace, videoOverlayCounterfactual, artifacts, ownedSource }) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { app, BrowserWindow, dialog, screen } = require('electron');
  assert.equal(process.ppid, ownerPid);
  assert.equal(process.connected, true);
  const envelope = JSON.parse(fs.readFileSync(process.env.MONKY_QA_CONFIG, 'utf8'));
  assert.equal(envelope.ownerPid, ownerPid);
  assert.equal(envelope.config.scenario, 'home');
  let placement;
  try { placement = require(path.join(clientRoot, 'test', 'fixtures', 'testDisplay.cjs')).installTestDisplay({ app, screen, BrowserWindow }); }
  catch (error) { console.error('[TestDisplay] Participant launch rejected:', error); app.exit(1); return; }
  placement?.interceptElectronImports();
  const metadata = require(path.join(clientRoot, 'package.json'));
  // The real Main still owns profile, launcher-envelope and renderer-frame validation.
  app.setAppPath(clientRoot);
  app.setName(metadata.productName ?? metadata.name);
  app.setVersion(metadata.version);
  const endpoints = new Set();
  const byteTrace = { armed: false, startedAt: null, frames: [], bytes: 0,
    maximumBytes: 32 * 1024 * 1024, maximumFrames: 2400, maximumMs: 20000, stopReason: null };
  const byteChunks = [];
  let traceHost, byteSave;
  if (encodedByteTrace && envelope.config.nickname === 'Native QA publisher') {
    const capture = require(path.join(clientRoot, 'native', 'screen-share', 'runtime', 'captureBridge.cjs'));
    const Bridge = capture.CaptureBridge;
    capture.CaptureBridge = class extends Bridge {
      constructor(options, ...rest) {
        let host;
        super({ ...options, onPacket(frame) {
          const result = options.onPacket(frame);
          if (!byteTrace.armed || host !== traceHost || byteTrace.stopReason) return result;
          if (performance.now() - byteTrace.startedAt >= byteTrace.maximumMs) {
            byteTrace.stopReason = '20-second-limit'; return result;
          }
          if (byteTrace.frames.at(-1)?.frameId === frame.frameId) return result;
          if (byteTrace.frames.length >= byteTrace.maximumFrames) {
            byteTrace.stopReason = '2400-frame-limit'; return result;
          }
          if (byteTrace.bytes + frame.data.byteLength > byteTrace.maximumBytes) {
            byteTrace.stopReason = '32-MiB-limit'; return result;
          }
          const bytes = Buffer.from(frame.data);
          const { data, ...metadata } = frame;
          byteTrace.frames.push({ ...metadata, offset: byteTrace.bytes, length: bytes.length,
            observedAt: new Date().toISOString(), onPacketAccepted: result !== false });
          byteChunks.push(bytes); byteTrace.bytes += bytes.length;
          return result;
        } }, ...rest);
        host = this;
      }
      start(target) {
        assert.equal(target.kind, 'window');
        assert.equal(target.hwnd, ownedSource.hwnd);
        assert.equal(target.expectedProcessId, ownedSource.pid);
        return super.start(target);
      }
    };
  }
  let assertEndpointLocallyClosed;
  if (fourK || cadenceDiagnostics || observeSourceClosure) {
    const runtime = require(path.join(clientRoot, 'native', 'screen-share', 'index.cjs'));
    assertEndpointLocallyClosed = require(path.join(clientRoot, 'native', 'screen-share', 'runtime', 'nativeEndpoint.cjs'))
      .assertNativeScreenEndpointLocallyClosed;
    const Endpoint = runtime.NativeScreenEndpoint;
    runtime.NativeScreenEndpoint = class extends Endpoint {
      constructor(options) { super(options); endpoints.add(this); }
    };
  }
  let rootCloseRequested = false;
  if (closeAppActive) {
    const show = dialog.showMessageBox;
    dialog.showMessageBox = function (...args) {
      if (rootCloseRequested) process.send({ type: 'qa-shutdown-dialog', runId: envelope.config.runId,
        options: { title: args.at(-1)?.title, buttons: args.at(-1)?.buttons } });
      return Reflect.apply(show, this, args);
    };
    const logError = console.error;
    const details = (value, depth = 0) => {
      if (!(value instanceof Error)) return typeof value === 'string' ? value.slice(0, 2048) : null;
      return { name: value.name, message: value.message, code: value.code, stack: value.stack,
        ...(depth < 8 ? { cause: value.cause ? details(value.cause, depth + 1) : null,
          errors: value instanceof AggregateError ? value.errors.slice(0, 16).map(error => details(error, depth + 1)) : [] } : {}) };
    };
    console.error = function (...args) {
      if (rootCloseRequested && process.connected)
        process.send({ type: 'qa-shutdown-error', runId: envelope.config.runId, details: args.map(value => details(value)) });
      return Reflect.apply(logError, this, args);
    };
  }
  const message = input => {
    if (!input || input.runId !== envelope.config.runId
      || !['qa-focus', 'qa-blur', 'qa-focus-state', ...(clockFeedbackStall ? ['qa-clock-stall'] : []),
        ...(fourK || cadenceDiagnostics ? ['qa-native-snapshots'] : []),
        ...(observeSourceClosure ? ['qa-native-retired'] : []),
        ...(encodedByteTrace ? ['qa-byte-trace-arm', 'qa-byte-trace-save'] : []),
        ...(videoOverlayCounterfactual ? ['qa-gpu-process-evidence'] : []),
        ...(closeAppActive ? ['qa-root-close'] : [])].includes(input.type)) return;
    try {
      assert.equal(typeof input.id, 'string');
      assert.equal(input.value, undefined);
      assert.equal(process.connected, true);
      assert.equal(process.ppid, ownerPid);
      if (input.type === 'qa-gpu-process-evidence') {
        process.send({ type: 'qa-response', id: input.id, value: {
          at: new Date().toISOString(), pid: process.pid,
          featureStatus: app.getGPUFeatureStatus(), metrics: app.getAppMetrics(),
          switchEnabled: app.commandLine.hasSwitch('disable_direct_composition_video_overlays'),
          windows: BrowserWindow.getAllWindows().filter(window => !window.isDestroyed())
            .map(window => ({ windowId: window.id, rendererPid: window.webContents.getOSProcessId() })),
        } });
        return;
      }
      if (input.type === 'qa-byte-trace-arm') {
        assert.equal(byteTrace.startedAt, null, 'The owned byte trace may only be armed once.');
        assert.equal(byteTrace.armed, false);
        const active = [...endpoints].filter(endpoint => endpoint.role === 'publish'
          && !endpoint.stopRequested && !endpoint.closed && endpoint.flow?.demand
          && endpoint.profile.width === 1920 && endpoint.profile.height === 1080 && endpoint.profile.fps === 60);
        assert.equal(active.length, 1);
        traceHost = active[0].host;
        assert.ok(traceHost);
        Object.assign(byteTrace, { armed: true, startedAt: performance.now(), startedAtUtc: new Date().toISOString(),
          pipelineId: active[0].pipelineId, capturePid: traceHost.child.pid, target: ownedSource });
        process.send({ type: 'qa-response', id: input.id, value: {
          pipelineId: byteTrace.pipelineId, capturePid: byteTrace.capturePid, startedAtUtc: byteTrace.startedAtUtc } });
        return;
      }
      if (input.type === 'qa-byte-trace-save') {
        byteTrace.stopReason ??= 'explicit-save';
        byteTrace.armed = false;
        byteSave ??= (async () => {
          assert.ok(byteTrace.frames.length > 0, 'The armed synthetic capture produced no recorded access units.');
          const binary = path.join(artifacts, 'owned-source-annexb.h264');
          const metadata = path.join(artifacts, 'owned-source-annexb.json');
          await fs.promises.writeFile(binary, Buffer.concat(byteChunks, byteTrace.bytes), { flag: 'wx' });
          await fs.promises.writeFile(metadata, JSON.stringify(byteTrace,
            (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n', { flag: 'wx' });
          byteChunks.length = 0;
          return { binary, metadata, bytes: byteTrace.bytes, frames: byteTrace.frames.length,
            maximumBytes: byteTrace.maximumBytes, maximumFrames: byteTrace.maximumFrames,
            maximumMs: byteTrace.maximumMs, stopReason: byteTrace.stopReason };
        })();
        void byteSave.then(value => process.send({ type: 'qa-response', id: input.id, value }),
          error => process.send({ type: 'qa-response', id: input.id, error: error.stack ?? String(error) }));
        return;
      }
      if (input.type === 'qa-native-retired') {
        const value = [...endpoints].map(endpoint => {
          const snapshot = endpoint.snapshot();
          const retired = snapshot.closed && snapshot.nativeClosed;
          if (retired) assertEndpointLocallyClosed(endpoint);
          return { ...snapshot, source: endpoint.source, localRetirementProven: retired };
        });
        process.send({ type: 'qa-response', id: input.id, value });
        return;
      }
      if (input.type === 'qa-native-snapshots') {
        void Promise.all([...endpoints].filter(endpoint => !endpoint.stopRequested && !endpoint.closed).map(async endpoint => {
          const readStartedAtMs = performance.now();
          const value = cadenceDiagnostics ? await endpoint.stats() : { ...endpoint.snapshot(), rtc: endpoint.engine.snapshot() };
          return { ...value, readStartedAtMs, readCompletedAtMs: performance.now() };
        })).then(value => process.send({ type: 'qa-response', id: input.id, value }),
          error => process.send({ type: 'qa-response', id: input.id, error: error.stack ?? String(error) }));
        return;
      }
      const windows = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed());
      const window = windows.find(candidate => candidate.webContents.getURL().startsWith(`${origin}/`)
        && new URL(candidate.webContents.getURL()).searchParams.get('overlay') !== '1');
      assert.ok(window, 'The owned normal Main window is unavailable.');
      if (input.type === 'qa-root-close') {
        assert.equal(rootCloseRequested, false);
        rootCloseRequested = true;
        process.send({ type: 'qa-response', id: input.id, value: { pid: process.pid, windowId: window.id,
          operation: 'BrowserWindow.close' } });
        setImmediate(() => window.close());
        return;
      }
      if (input.type === 'qa-clock-stall') {
        const before = performance.now();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        process.send({ type: 'qa-response', id: input.id, value: { pid: process.pid, blockedMs: performance.now() - before } });
        return;
      }
      if (input.type === 'qa-focus') {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      } else if (input.type === 'qa-blur') {
        for (const owned of windows) {
          if (owned.isDestroyed()) continue;
          const visible = owned.isVisible();
          // Windows can retain active state after blur() rejects a foreground transfer.
          // A real hide followed by inactive show preserves a visible, unfocused surface.
          owned.hide();
          if (visible) owned.showInactive();
        }
      }
      const focused = BrowserWindow.getFocusedWindow();
      const focusedWindowIds = windows.filter(owned => !owned.isDestroyed() && owned.isFocused()).map(owned => owned.id);
      process.send({ type: 'qa-response', id: input.id, value: {
        mainFocused: window.isFocused(), anyFocused: (!!focused && !focused.isDestroyed()) || focusedWindowIds.length > 0,
        mainWindowId: window.id, focusedWindowId: focused?.id ?? null, focusedWindowIds,
        testDisplay: placement?.snapshot() ?? null,
      } });
    } catch (error) {
      process.send({ type: 'qa-response', id: input.id, error: error.stack ?? String(error) });
    }
  };
  process.on('message', message);
  app.once('will-quit', () => process.removeListener('message', message));
  require(path.join(clientRoot, metadata.main));
}

async function focusOwned(client) {
  await client.child.call('qa-focus');
  await until(async () => (await client.child.call('qa-focus-state')).mainFocused
    && await client.cdp.evaluate('document.hasFocus()'), `The owned ${client.label} window did not acquire real focus.`);
}

async function blurPublisher(publisher, viewer) {
  const transfer = { at: new Date().toISOString(), confirmed: false, last: null };
  (report.focusTransfers ??= []).push(transfer);
  await publisher.child.call('qa-blur');
  await viewer.child.call('qa-focus');
  await until(async () => {
    const [publisherWindow, viewerWindow, publisherDocument, viewerDocument] = await Promise.all([
      publisher.child.call('qa-focus-state'), viewer.child.call('qa-focus-state'),
      publisher.cdp.evaluate('document.hasFocus()'), viewer.cdp.evaluate('document.hasFocus()'),
    ]);
    transfer.last = { publisherWindow, viewerWindow, publisherDocument, viewerDocument };
    return !publisherWindow.anyFocused && !publisherDocument
      && viewerWindow.mainFocused && viewerWindow.anyFocused && viewerDocument;
  }, 'Windows refused the owned inactive-window transition: the viewer must be focused and no publisher window may remain focused.');
  transfer.confirmed = true;
}

async function collectEvidence(name, publisher, viewer) {
  const evidence = { at: new Date().toISOString(), collectionErrors: [] };
  report[name] = evidence;
  const reads = {
    publisherState: () => publisher.cdp.evaluate('nativeAppSmoke.snapshot()'),
    publisherStats: () => publisher.cdp.evaluate('nativeAppSmoke.stats()'),
    publisherFocus: () => publisher.child.call('qa-focus-state'),
    receiverState: () => viewer.cdp.evaluate('nativeAppSmoke.snapshot()'),
    receiverStats: () => viewer.cdp.evaluate('nativeAppSmoke.stats()'),
    senderDiagnostics: () => publisher.cdp.evaluate('nativeAppSmoke.diagnostics()'),
    receiverDiagnostics: () => viewer.cdp.evaluate('nativeAppSmoke.diagnostics()'),
    senderTelemetry: () => publisher.cdp.evaluate('nativeAppSmoke.telemetry()'),
    receiverTelemetry: () => viewer.cdp.evaluate('nativeAppSmoke.telemetry()'),
    browserStats: () => viewer.cdp.evaluate('nativeAppSmoke.browserStats()'),
  };
  const entries = Object.entries(reads);
  const outcomes = await Promise.allSettled(entries.map(async ([key, read]) => { evidence[key] = await read(); }));
  const errors = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'rejected') {
      errors.push(outcome.reason);
      evidence.collectionErrors.push({ field: entries[index][0], error: outcome.reason.stack ?? String(outcome.reason) });
    }
  }
  evidence.sfuScreenProducers = mode === 'sfu'
    ? server.sfuManager.getProducersInChannel(publisher.identity.channelId).filter(producer =>
      producer.producerSessionId === publisher.identity.sessionId
      && ['screen_video', 'screen_audio'].includes(producer.appData.mediaType)) : [];
  evidence.publisherFlows = evidence.publisherStats?.publishers.flatMap(owner => owner.pipelines.map(pipeline => ({
    pipelineId: pipeline.pipelineId, flow: pipeline.endpoint.flow,
  }))) ?? null;
  await fs.writeFile(path.join(artifacts, `${name}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  if (errors.length) throw new AggregateError(errors, `Could not collect ${name} before its assertions.`);
  return evidence;
}

function assertAnnouncedWithoutRemoteMedia(evidence, published) {
  const { publisherStats, publisherState, receiverStats, receiverState } = evidence;
  assert.equal(publisherStats.publishers.length, 1);
  assert.deepEqual(publisherStats.publishers[0].source, published.source);
  assert.equal(publisherStats.publishers[0].viewers, 0);
  assert.equal(publisherState.localNativeSources, 1);
  assert.deepEqual(receiverState.sources, [published.source], 'Local preview changed or removed the announced source.');
  assert.equal(receiverState.video, null, 'An unwatched spectator received video frames.');
  if (receiverStats === null) assert.equal(receiverState.mainCall, null);
  else {
    assert.equal(receiverStats.kind, 'stats');
    assert.deepEqual(receiverStats.subscriptions, []);
    assert.deepEqual(receiverStats.publishers, []);
  }
  assert.equal(receiverState.browserWatches, 0);
  assert.equal(receiverState.screenOutputContext, null);
  assert.deepEqual(evidence.browserStats, []);
  assert.deepEqual(evidence.sfuScreenProducers, [], 'Local preview retained an SFU screen producer.');
  assert.deepEqual(publisherState.errors, []);
  assert.deepEqual(receiverState.errors, []);
}

function assertLocalOnlyPreview(evidence, published) {
  assertAnnouncedWithoutRemoteMedia(evidence, published);
  const owner = evidence.publisherStats.publishers[0];
  assert.equal(owner.previewEnabled, true);
  assert.equal(owner.pipelines.length, 1);
  assert.equal(owner.pipelines[0].viewers, 0);
  const endpoint = owner.pipelines[0].endpoint;
  assert.equal(endpoint.captureState, 'running');
  assert.equal(endpoint.demand, 0);
  assert.equal(endpoint.previewDemand, true);
  assert.equal(endpoint.flow.demand, false);
  assert.equal(endpoint.flow.connected, false);
  assert.equal(endpoint.flow.admitted, 0, 'Local-only preview admitted an encoded frame to RTC.');
  assert.equal(endpoint.flow.retainedNativeCopies, 0);
  assert.ok(endpoint.flow.notWatched > 0, 'Local-only preview never observed actual capture packets.');
  assert.equal(endpoint.routes.peers, 0);
  assert.equal(endpoint.routes.consumers, 0);
  assert.equal(endpoint.audioInput, null, 'Local-only preview started PCM capture.');
  assert.deepEqual(endpoint.errors, []);
  assert.equal(evidence.publisherState.previewState, 'playing');
  assert.equal(evidence.senderDiagnostics.viewers, 0);
  assert.equal(evidence.senderDiagnostics.endpoints.length, 1);
  assert.ok(evidence.senderDiagnostics.endpoints.every(value => value.readErrors === 0 && value.rtp.length === 0),
    'Local-only preview has an RTP publication or unreadable diagnostics.');
}

function assertPausedPreview(evidence, published) {
  assertAnnouncedWithoutRemoteMedia(evidence, published);
  assert.equal(evidence.publisherFocus.anyFocused, false);
  assert.equal(evidence.publisherState.focused, false);
  assert.equal(evidence.publisherState.previewPauseWhenUnfocused, true);
  assert.equal(evidence.publisherState.previewState, 'paused');
  assert.equal(evidence.publisherStats.publishers[0].previewEnabled, false);
  assert.deepEqual(evidence.publisherStats.publishers[0].pipelines, []);
  assert.deepEqual(evidence.senderDiagnostics.endpoints, []);
}

async function connectCdp(port, expectedOrigin, runId, diagnostics, overlayParent = null) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.ok, true);
  const pages = await response.json();
  diagnostics.push({ targets: pages.map(entry => ({ type: entry.type, url: entry.url })) });
  const page = pages.find(entry => entry.type === 'page' && entry.url.startsWith(`${expectedOrigin}/`)
    && (new URL(entry.url).searchParams.get('overlay') === '1') === !!overlayParent);
  assert.ok(page?.webSocketDebuggerUrl, 'The owned Monky document is not available.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  let mediaTraceCompletion, resolveMediaTrace;
  const requests = new Map();
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    if (value.method === 'Tracing.tracingComplete' && resolveMediaTrace) resolveMediaTrace(value.params);
    if (value.method === 'Runtime.exceptionThrown')
      diagnostics.push({ ...value.params.exceptionDetails, timestamp: value.params.timestamp });
    if (value.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(value.params.type))
      diagnostics.push({ type: value.params.type, timestamp: value.params.timestamp,
        args: value.params.args.map(arg => arg.description ?? arg.value) });
    const request = requests.get(value.id);
    if (!request) return;
    requests.delete(value.id);
    if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result);
  });
  socket.on('close', () => {
    for (const request of requests.values()) request.reject(new Error('The owned DevTools connection closed.'));
    requests.clear();
  });
  const call = (method, params) => {
    if (gpuTaskTrace) qaActionTimeline.push({ at: new Date().toISOString(), runId,
      action: method, ...(method === 'Runtime.evaluate' ? {
        operation: params.expression.match(/nativeAppSmoke\.[A-Za-z]+|performance\.mark/)?.[0] ?? 'qa-expression',
      } : {}) });
    const id = ++sequence;
    return within(new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    }), 45000, `Owned DevTools request timed out: ${method}`).finally(() => requests.delete(id));
  };
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await call('Runtime.enable');
  const config = await (overlayParent ? overlayParent.evaluate('window.api.getDevelopmentQaConfig()')
    : evaluate('window.api.getDevelopmentQaConfig()'));
  assert.equal(config.runId, runId, 'Never drive an unrelated DevTools target.');
  if (overlayParent) assert.equal(await evaluate('window.api.getDevelopmentQaConfig()'), null,
    'The real overlay must not acquire the Main document QA authority.');
  return {
    evaluate, close: () => socket.close(),
    async startMediaTrace(requestedCategories = ['webrtc', 'media']) {
      assert.equal(mediaTraceCompletion, undefined);
      const categories = await call('Tracing.getCategories', {});
      assert.ok(categories.categories.includes('media') && categories.categories.includes('webrtc'),
        'The owned Chromium build does not expose the requested media/webrtc trace categories.');
      if (requestedCategories.includes('toplevel'))
        assert.ok(categories.categories.includes('toplevel') && categories.categories.includes('gpu'),
          'The owned Chromium build does not expose GPU/toplevel trace categories.');
      mediaTraceCompletion = new Promise(resolve => { resolveMediaTrace = resolve; });
      try {
        await call('Tracing.start', { categories: requestedCategories.join(','), transferMode: 'ReturnAsStream',
          options: 'record-continuously' });
      } catch (error) {
        mediaTraceCompletion = undefined; resolveMediaTrace = undefined;
        throw error;
      }
      return { requestedCategories, availableCategories: requestedCategories.filter(value => categories.categories.includes(value)) };
    },
    async stopMediaTrace(destination) {
      assert.ok(mediaTraceCompletion);
      let stream, file, bytes = 0;
      const errors = [];
      try {
        await call('Tracing.end', {});
        const completed = await within(mediaTraceCompletion, 15000, 'Owned Chromium media tracing did not complete.');
        stream = completed.stream;
        assert.equal(typeof stream, 'string');
        assert.notEqual(completed.dataLossOccurred, true, 'Chromium reported lost diagnostic trace data.');
        file = await fs.open(destination, 'wx');
        for (;;) {
          const chunk = await call('IO.read', { handle: stream, size: 65536 });
          const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
          bytes += data.length;
          assert.ok(bytes <= 128 * 1024 * 1024, 'Owned media trace exceeded the128MiB diagnostic bound.');
          await file.write(data);
          if (chunk.eof) break;
        }
      } catch (error) {
        errors.push(error);
      } finally {
        if (file) {
          try { await file.close(); } catch (error) { errors.push(error); }
        }
        if (typeof stream === 'string') {
          try { await call('IO.close', { handle: stream }); } catch (error) { errors.push(error); }
        }
        mediaTraceCompletion = undefined; resolveMediaTrace = undefined;
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Owned trace export and cleanup failed.');
      return { destination, bytes };
    },
    async capture(clip) {
      const result = await call('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...clip, scale: 1 },
      });
      assert.equal(typeof result.data, 'string');
      return result.data;
    },
  };
}

async function viewerSystemEvidence(viewer) {
  qaActionTimeline.push({ at: new Date().toISOString(), runId: viewer.runId, action: 'qa-SystemInfo-before' });
  const response = await fetch(`http://127.0.0.1:${viewer.debugPort}/json/version`,
    { signal: AbortSignal.timeout(3000) });
  assert.equal(response.ok, true);
  const version = await response.json();
  const endpoint = new URL(version.webSocketDebuggerUrl);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(Number(endpoint.port), viewer.debugPort);
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  try {
    await within(once(socket, 'open'), 5000, 'Owned browser SystemInfo connection did not open.');
    const call = async method => {
      const id = ++sequence;
      let listener;
      try {
        return await within(new Promise((resolve, reject) => {
          listener = raw => {
            const message = JSON.parse(raw.toString());
            if (message.id !== id) return;
            if (message.error) reject(new Error(`${method}: ${message.error.message}`));
            else resolve(message.result);
          };
          socket.on('message', listener);
          socket.send(JSON.stringify({ id, method }));
        }), 10000, `Owned ${method} timed out.`);
      } finally { socket.off('message', listener); }
    };
    return { at: new Date().toISOString(), version,
      systemInfo: await call('SystemInfo.getInfo'),
      processInfo: await call('SystemInfo.getProcessInfo'),
      app: await viewer.child.call('qa-gpu-process-evidence') };
  } finally {
    socket.close();
    qaActionTimeline.push({ at: new Date().toISOString(), runId: viewer.runId, action: 'qa-SystemInfo-after' });
  }
}

async function previewPixels(client, state, name) {
  // Telemetry text must not count as proof that the standby message was painted.
  const telemetryEnabled = await client.cdp.evaluate('nativeAppSmoke.setTelemetryEnabled(false)');
  let sample, png;
  try {
    sample = await client.cdp.evaluate(`nativeAppSmoke.previewClip(${JSON.stringify(state)})`);
    png = await client.cdp.capture(sample.clip);
  } finally {
    await client.cdp.evaluate(`nativeAppSmoke.setTelemetryEnabled(${JSON.stringify(telemetryEnabled)})`);
  }
  await fs.writeFile(path.join(artifacts, `${name}.png`), Buffer.from(png, 'base64'), { flag: 'wx' });
  const pixels = await client.cdp.evaluate(`(async data => {
    const bytes = Uint8Array.from(atob(data), value => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let bright = 0, red = 0, green = 0, blue = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        red += pixels[index]; green += pixels[index + 1]; blue += pixels[index + 2];
        if (pixels[index] > 160 && pixels[index + 1] > 160 && pixels[index + 2] > 160) bright++;
      }
      const count = pixels.length / 4;
      return { width: bitmap.width, height: bitmap.height, bright, red: red / count, green: green / count, blue: blue / count };
    } finally { bitmap.close(); }
  })(${JSON.stringify(png)})`);
  if (state === 'waiting' || state === 'paused') {
    assert.equal(sample.placeholderVisible, true, 'The empty video covers the standby preview message.');
    assert.ok(pixels.bright >= 20, `The standby preview message is painted black or covered: ${JSON.stringify(pixels)}`);
  } else assert.ok(pixels.red > 150 && pixels.blue > 150 && pixels.green < 100,
    `The actual local preview surface does not display its source pixels: ${JSON.stringify(pixels)}`);
  return pixels;
}

async function setupRenderer({ port, password, nickname, browserReceiver, audioEnabled, preserveAspectRatio, gameFallback, sourceQualityChanges, fourK, fourK60, fullHd60, screenCodec }) {
  const [{ openServerSession, joinCallOnSession, leaveCurrentCall }, { sessionManager }, { webRtcManager },
    { videoService }, { voiceStore }, { settingsStore }, { stopLocalScreenShares },
    { screenAudioService }, { setLanguage, t }, { appEvents }, { QUALITY_PRESETS }, { overlayBridgeService }] = await Promise.all([
    import('/core/serverConnection.ts'), import('/core/SessionManager.ts'), import('/core/WebRtcManager.ts'),
    import('/core/VideoService.ts'), import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'),
    import('/core/screenShareControls.ts'), import('/core/ScreenAudioService.ts'), import('/i18n/index.ts'),
    import('/core/EventBus.ts'), import('/@fs/' + globalThis.monkyAppSharedPath),
    import('/core/OverlayBridgeService.ts'),
  ]);
  setLanguage('en');
  settingsStore.qualityPreset = 'CUSTOM';
  settingsStore.customProfile = { ...QUALITY_PRESETS.ULTRA, screenWidth: 1920, screenHeight: 1080,
    screenFps: fullHd60 ? 60 : 120, screenBitrateKbps: 20000, audioBitrateKbps: 128 };
  if (sourceQualityChanges) Object.assign(settingsStore.customProfile, {
    screenWidth: 1280, screenHeight: 720, screenFps: 30, screenBitrateKbps: 2000,
  });
  if (fourK) Object.assign(settingsStore.customProfile, {
    screenWidth: 3840, screenHeight: 2160, screenFps: fourK60 ? 60 : 120, screenBitrateKbps: 80000,
  });
  settingsStore.preferredVideoCodec = 'h264';
  settingsStore.preferredScreenCodec = screenCodec === 'auto' ? 'h264' : screenCodec;
  settingsStore.screenEncodingStrategy = screenCodec === 'auto' ? 'automatic' : 'manual';
  if (settingsStore.screenEncodingMode !== 'hardware') throw new Error('The fresh application profile must default to Hardware encoding.');
  settingsStore.screenShareTelemetryEnabled = true;
  settingsStore.screenShareTelemetryMode = 'complete';
  const initialPreviewPauseWhenUnfocused = settingsStore.screenSharePreviewPauseWhenUnfocused;
  settingsStore.save();
  webRtcManager.setQualityPreset('CUSTOM');
  videoService.setQualityPreset('CUSTOM');
  settingsStore.setScreenShareReceiver(browserReceiver ? 'chromium' : 'native');
  const auth = await openServerSession('127.0.0.1', port, await window.api.getIdentity(), nickname, password);
  const session = sessionManager.getActive();
  if (!session) throw new Error('The real application did not create its server session.');
  const channel = auth.server.channels.find(value => value.type === 'VOICE');
  await joinCallOnSession(session.key, channel.id);
  document.querySelector(`[data-channel-id="${channel.id}"][data-channel-type="VOICE"]`)?.click();
  const nativeErrors = [];
  const nativeErrorEvents = [];
  const unbindNativeErrors = window.api.onNativeScreenEvent(event => {
    if (event.type === 'error') nativeErrorEvents.push({ ...event, observedAt: new Date().toISOString() });
  });
  const captureFallbacks = [];
  const unbindFallback = appEvents.on('native_screen.capture_fallback', event => {
    captureFallbacks.push({ ...event, at: performance.now() });
  });
  const fallbackToasts = [], sourceStoppingToasts = [], seenToasts = new WeakSet(), toastChecks = new Set();
  const toastObserver = new MutationObserver(() => {
    for (const toast of document.querySelectorAll('.chat-copy-toast[role="status"]')) {
      const label = toast.querySelector('.chat-copy-toast-label')?.textContent;
      if (![t('screenShare.gameFallback'), t('screenShare.sourceStopping')].includes(label) || seenToasts.has(toast)) continue;
      seenToasts.add(toast);
      const entry = { label, at: performance.now(), visible: false };
      (label === t('screenShare.gameFallback') ? fallbackToasts : sourceStoppingToasts).push(entry);
      const check = setTimeout(() => {
        toastChecks.delete(check);
        const rect = toast.getBoundingClientRect();
        entry.visible = toast.isConnected && toast.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
          && rect.right <= innerWidth && rect.bottom <= innerHeight;
      }, 150);
      toastChecks.add(check);
    }
  });
  toastObserver.observe(document.body, { childList: true, subtree: true });
  let measuredScreenContext = null;
  let measuredDummyTrack = null;
  let watchActions = 0;
  const unbind = appEvents.on('native_screen.source_failed', event => nativeErrors.push(event));
  const sharing = () => session.participants.getInVoiceChannel(channel.id)
    .find(value => value.user.sessionId !== auth.currentUser.sessionId && value.voiceState.nativeScreenShares?.length);
  const watchedVideo = () => [...document.querySelectorAll('video.stage-video-element')]
    .find(video => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks().length);
  const ownedWindowSource = (sources, hwnd) => {
    if (!Array.isArray(sources) || !Number.isSafeInteger(hwnd) || hwnd <= 0)
      throw new Error('An owned child HWND and real DesktopSources are required.');
    const prefix = `window:${hwnd}:`;
    const matches = sources.filter(source => source.type === 'window' && typeof source.id === 'string'
      && source.id.startsWith(prefix) && source.id.length > prefix.length);
    if (matches.length !== 1) throw new Error('The owned HWND has no unique enumerated source identity.');
    return matches[0];
  };
  window.nativeAppSmoke = {
    async rejectUnsupported4k120() {
      if (!fourK60) throw new Error('The negative 4K120 test requires explicit 4K60 mode.');
      const before = videoService.getNativeScreenCaptures()[0]?.source;
      if (before?.video.width !== 3840 || before.video.fps !== 60)
        throw new Error('The rejection must preserve a live 4K60 source.');
      const errorsBefore = nativeErrors.length, startedAt = new Date().toISOString();
      let rejection;
      try {
        await window.nativeAppSmoke.changeSourceQuality([
          { width: 3840, height: 2160, fps: 120, maxBitrateKbps: 80000 },
        ]);
      } catch (error) { rejection = error instanceof Error ? error.message : String(error); }
      if (!rejection) throw new Error('4K120 unexpectedly succeeded instead of rejecting the unsupported AMF level.');
      const deadline = performance.now() + 5000;
      while (!document.querySelector('.dialog-card .dialog-message') && performance.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25));
      const notification = document.querySelector('.dialog-card .dialog-message')?.textContent;
      if (!notification) throw new Error('The unsupported quality did not notify the user.');
      document.querySelector('.dialog-card button[data-action="confirm"]')?.click();
      await new Promise(resolve => setTimeout(resolve, 250));
      return { startedAt, finishedAt: new Date().toISOString(), rejected: true, error: rejection,
        notification, events: nativeErrors.slice(errorsBefore), before,
        after: videoService.getNativeScreenCaptures()[0]?.source };
    },
    async changeSourceQuality(profiles) {
      if (!sourceQualityChanges || !Array.isArray(profiles) || !profiles.length || profiles.length > 4)
        throw new Error('Quality changes require the explicitly owned sender scenario.');
      const capture = videoService.getNativeScreenCaptures()[0];
      if (!capture) throw new Error('The owned audible source must already be running.');
      const call = webRtcManager['nativeScreens']['call'];
      const before = { ...capture.source };
      for (const video of profiles) {
        const next = { ...settingsStore.customProfile, screenWidth: video.width, screenHeight: video.height,
          screenFps: video.fps, screenBitrateKbps: video.maxBitrateKbps };
        webRtcManager.assertScreenSharingSettings(next);
        settingsStore.customProfile = next;
        settingsStore.save();
        webRtcManager.setQualityPreset('CUSTOM');
      }
      // The real settings entry point queues asynchronous per-source mutations.
      // Do not await between user choices: the last task must serialize all of them.
      await new Promise(resolve => setTimeout(resolve, 0));
      const pending = call?.sourceTasks.get(capture.source.shareId);
      if (!pending) throw new Error('The live settings changes did not enter the real source mutation queue.');
      await pending;
      const after = videoService.getNativeScreenCaptures()[0]?.source;
      if (!after || webRtcManager['nativeScreens']['call'] !== call || after.shareId !== before.shareId)
        throw new Error('Live settings replaced the call or consent identity.');
      return { before, after, queuedChoices: profiles.length, callId: call.config.callId };
    },
    async share(ownedHwnd, expectedFailure = false, replace = false) {
      const wait = async (condition, message) => {
        const deadline = performance.now() + 20000;
        while (!condition()) {
          if (performance.now() >= deadline) throw new Error(message);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
      const sourceListStarted = performance.now();
      const opening = !document.querySelector('#share-sources-panel');
      const previous = videoService.getNativeScreenCaptures()[0]?.source;
      if (replace && (!previous?.audio || voiceStore.screenAudioShareId !== previous.shareId))
        throw new Error('Replacement requires the currently published, owned audible source.');
      if (opening) {
        const button = document.querySelector('#stage-btn-screen');
        if (!(button instanceof HTMLButtonElement)) throw new Error('The real Share Screen control is missing.');
        button.click();
      }
      await wait(() => document.querySelector('#share-tab-window'), 'The real screen picker did not open.');
      await wait(() => document.querySelector('#share-sources-panel')?.getAttribute('aria-busy') === 'false',
        'The native source capabilities did not settle.');
      const sourceListMs = performance.now() - sourceListStarted;
      const pendingThumbnails = document.querySelectorAll('.source-thumbnail--loading').length;
      const capabilities = await webRtcManager.getNativeScreenCapabilities();
      const kinds = capabilities.captureKinds ?? (capabilities.capture ? ['window'] : []);
      if (document.querySelector('#share-tab-game'))
        throw new Error('Game Capture must be a method of the selected window, not a duplicate source tab.');
      for (const [tab, kind] of [['screen', 'monitor'], ['window', 'window']]) {
        const control = document.querySelector(`#share-tab-${tab}`);
        const supported = (capabilities.capture || capabilities.requiresSelectionProbe === true)
          && (kinds.includes(kind) || kind === 'window' && kinds.includes('game'));
        if (!(control instanceof HTMLButtonElement) || control.disabled === supported ||
          control.getAttribute('role') !== 'tab' || (!supported && !control.title))
          throw new Error('Capture methods must reflect actual native capabilities with an explicit unavailable reason.');
      }
      document.querySelector('#share-tab-window').click();
      const { id: desktopSourceId } = ownedWindowSource(await window.api.getDesktopSources({ metadataOnly: true }), ownedHwnd);
      const card = () => [...document.querySelectorAll('.source-item')].find(item => item.dataset.sourceId === desktopSourceId);
      await wait(card, 'The real picker did not enumerate the owned synthetic window.');
      card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      if (card().getAttribute('aria-pressed') !== 'true') throw new Error('Keyboard source selection was not acknowledged.');
      if (document.querySelector('#share-window-methods')?.hidden !== false)
        throw new Error('Selecting a window did not expose its capture methods.');
      for (const kind of ['window', 'game']) {
        const method = document.querySelector(`#share-method-${kind}`);
        const supported = (capabilities.capture || capabilities.requiresSelectionProbe === true) && kinds.includes(kind);
        if (!(method instanceof HTMLButtonElement) || method.disabled === supported
          || method.getAttribute('aria-pressed') !== String(kind === 'window'))
          throw new Error('Window capture methods must show real capabilities and select Normal by default.');
      }
      if (gameFallback) {
        document.querySelector('#share-method-game').click();
        if (document.querySelector('#share-method-game')?.getAttribute('aria-pressed') !== 'true')
          throw new Error('The real Game Capture method was not selected.');
        const guideButton = document.querySelector('#btn-game-capture-guide');
        if (!(guideButton instanceof HTMLButtonElement)) throw new Error('The game guidance control is missing.');
        guideButton.click();
        const search = document.querySelector('#game-capture-guide-search');
        if (!(search instanceof HTMLInputElement)) throw new Error('The real game guidance search did not open.');
        search.value = 'CS2';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const entries = [...document.querySelectorAll('#game-capture-guide [data-game-guide-entry]')]
          .filter(element => !element.hidden && element.getClientRects().length);
        if (entries.length !== 1 || !entries[0].textContent.includes('Counter-Strike 2'))
          throw new Error('The game guide did not find its documented Counter-Strike alias.');
        document.querySelector('#game-capture-guide-close').click();
        if (document.querySelector('#game-capture-guide') || document.activeElement !== guideButton
          || card()?.getAttribute('aria-pressed') !== 'true'
          || document.querySelector('#share-method-game')?.getAttribute('aria-pressed') !== 'true'
          || videoService.getNativeScreenCaptures().length !== 0)
          throw new Error('Consulting the game guide changed the selected source, method, focus or capture state.');
      }
      const audioToggle = document.querySelector('#chk-share-audio');
      if (!(audioToggle instanceof HTMLInputElement)) throw new Error('The real audio switch is missing.');
      if (replace && (!audioToggle.checked || audioToggle.disabled))
        throw new Error('Replace silently disabled or unchecked the existing audio choice.');
      if (audioToggle.checked !== audioEnabled) audioToggle.closest('.toggle-switch').querySelector('.toggle-slider').click();
      if (audioToggle.checked !== audioEnabled) throw new Error('The audio switch did not select the requested state.');
      const aspectToggle = document.querySelector('.screen-share-picker-card #chk-preserve-aspect-ratio');
      if (!(aspectToggle instanceof HTMLInputElement) || aspectToggle.getAttribute('role') !== 'switch')
        throw new Error('The real aspect-ratio switch is missing.');
      if (opening && !aspectToggle.checked) throw new Error('A new picker must default to preserving the source aspect ratio.');
      if (aspectToggle.checked !== preserveAspectRatio) aspectToggle.closest('.toggle-switch').querySelector('.toggle-slider').click();
      if (aspectToggle.checked !== preserveAspectRatio) throw new Error('The aspect-ratio switch did not select the requested state.');
      const refresh = document.querySelector('.screen-share-picker-card #btn-refresh-sources');
      if (!(refresh instanceof HTMLButtonElement) || refresh.disabled || refresh.getAttribute('aria-controls') !== 'share-sources-panel')
        throw new Error('The real picker refresh control is unavailable.');
      refresh.click();
      await wait(() => !refresh.disabled && document.querySelector('#share-sources-panel')?.getAttribute('aria-busy') === 'false',
        'Explicit source refresh did not settle.');
      if (card()?.getAttribute('aria-pressed') !== 'true'
        || document.querySelector('#chk-preserve-aspect-ratio')?.checked !== preserveAspectRatio
        || document.querySelector('#chk-share-audio')?.checked !== audioEnabled)
        throw new Error('Refresh lost the selected source or its per-share options.');
      const backend = document.querySelector('#share-capture-info')?.dataset.backend;
      const expectedBackend = capabilities.requiresSelectionProbe ? 'probe-pending' : capabilities.capture ? 'native' : 'unavailable';
      if (backend !== expectedBackend || backend === 'unavailable')
        throw new Error('The picker must distinguish verified capture from an explicit selection awaiting its native probe.');
      if (document.querySelector('.screen-share-picker-card [data-settings-section="screen-encoding"], .screen-share-picker-card #select-video-codec'))
        throw new Error('Encoding preferences belong in app settings, not the source picker.');
      const automatic = screenCodec === 'auto';
      const encoding = {
        strategy: automatic ? 'automatic' : 'manual',
        savedStrategy: settingsStore.screenEncodingStrategy,
        savedMode: settingsStore.screenEncodingMode, savedCodec: settingsStore.preferredScreenCodec,
      };
      if (encoding.savedStrategy !== encoding.strategy
        || !automatic && (encoding.savedMode !== 'hardware' || encoding.savedCodec !== screenCodec))
        throw new Error('The picker changed the encoding preferences selected in app settings.');
      const confirm = document.querySelector('#btn-share');
      if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) throw new Error('The real share confirmation is unavailable.');
      if (replace && !confirm.textContent.includes(t('screenShare.confirmSwitch')))
        throw new Error('The real Replace action is not selected.');
      confirm.click();
      const capture = () => videoService.getNativeScreenCaptures().find(value => value.desktopSourceId === desktopSourceId);
      if (expectedFailure) {
        await wait(() => document.querySelector('.dialog-card[role="dialog"] .dialog-message'),
          'The deliberately ambiguous owned source did not show its native rejection.');
        const error = document.querySelector('.dialog-card .dialog-message').textContent;
        if (!error.includes('Stock title matching is ambiguous') || capture())
          throw new Error('Source admission did not report the actual native ambiguity before starting capture.');
        document.querySelector('.dialog-card button[data-action="confirm"]').click();
        await wait(() => !document.querySelector('.dialog-card') && !confirm.disabled,
          'Dismissing a source rejection did not re-enable the existing picker.');
        if (card()?.getAttribute('aria-pressed') !== 'true')
          throw new Error('A rejected source lost its picker selection.');
        return { error, desktopSourceId, audio: audioEnabled };
      }
      await wait(() => !document.querySelector('#share-sources-panel') && capture(), 'Picker confirmation did not announce its native source.');
      if (!automatic && capture().source.codec !== encoding.savedCodec)
        throw new Error('Main source admission did not preserve the explicit codec from app settings.');
      if (settingsStore.screenEncodingStrategy !== encoding.savedStrategy
        || settingsStore.screenEncodingMode !== encoding.savedMode || settingsStore.preferredScreenCodec !== encoding.savedCodec)
        throw new Error('Sharing changed the saved encoding preferences.');
      if (replace && (capture().source.audio !== true || capture().source.shareId === previous.shareId
        || capture().source.instanceId === previous.instanceId || videoService.getNativeScreenCaptures().length !== 1
        || voiceStore.screenAudioShareId !== capture().source.shareId))
        throw new Error('Replace did not transfer the single audio owner to a fresh source instance.');
      return { source: capture().source, self: auth.currentUser.sessionId, desktopSourceId,
        picker: { backend, audio: audioEnabled, preserveAspectRatio, captureKind: gameFallback ? 'game' : 'window',
          refreshed: true, keyboardSelection: true, gameGuideChecked: gameFallback, ownedHwnd, replace, encoding,
          sourceListMs, pendingThumbnails } };
    },
    watch() {
      watchActions++;
      const button = document.querySelector('.stage-watch-btn');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real Watch control is missing.');
      button.click();
    },
    stopSharing() {
      const button = document.querySelector('#stage-btn-stop-share');
      if (!(button instanceof HTMLButtonElement) || button.disabled || !button.getClientRects().length)
        throw new Error('The real publisher Stop control is unavailable.');
      button.click();
    },
    toggleLocalFocus() {
      const capture = videoService.getNativeScreenCaptures()[0];
      if (!capture) throw new Error('The owned local source is missing.');
      const key = `${auth.currentUser.sessionId}:screen:${capture.source.shareId}`;
      const card = [...document.querySelectorAll('.stage-focused-main[data-kind="screen"][data-tile-key]')]
        .find(element => element.dataset.tileKey === key);
      if (!(card instanceof HTMLElement)) throw new Error('The local screen card is missing.');
      card.click();
    },
    quality(quality) {
      const button = document.querySelector('.stage-quality-button');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real quality menu control is missing.');
      button.click();
      if (button.getAttribute('aria-expanded') !== 'true') throw new Error('The real quality control did not open its menu.');
      const menu = document.querySelector(`.stage-quality-menu [data-screen-quality="${quality}"]`);
      if (!(menu instanceof HTMLButtonElement)) throw new Error('The real quality choice is missing.');
      menu.click();
      if (button.getAttribute('aria-expanded') !== 'false') throw new Error('The real quality choice did not close its menu.');
    },
    stopWatching() {
      const button = document.querySelector('.stage-stopwatch-btn');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real Stop Watching control is missing.');
      button.click();
    },
    fullscreen() {
      const button = document.querySelector('.stage-fullscreen-btn');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real fullscreen control is missing.');
      button.click();
    },
    volume(value) {
      const slider = document.querySelector('.stage-screen-volume-slider');
      if (!(slider instanceof HTMLInputElement)) throw new Error('The real screen-volume control is missing.');
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    },
    mute() {
      const button = document.querySelector('.stage-volume-btn');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real screen-mute control is missing.');
      button.click();
    },
    deafen() {
      const button = document.querySelector('#stage-btn-deafen');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real deafen control is missing.');
      button.click();
    },
    snapshot() {
      const remote = sharing(), video = watchedVideo();
      return {
        self: auth.currentUser.sessionId, channelId: voiceStore.currentVoiceChannelId,
        watchActions, localSources: videoService.getNativeScreenCaptures().map(capture => capture.source),
        sources: remote?.voiceState.nativeScreenShares ?? [],
        watches: voiceStore.getScreenWatchers(), watchButton: !!document.querySelector('.stage-watch-btn'),
        video: video ? { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
          frames: video.getVideoPlaybackQuality().totalVideoFrames, at: performance.now() } : null,
        errors: [...nativeErrors],
        nativeErrorEvents: [...nativeErrorEvents],
        sourceStoppingToasts: [...sourceStoppingToasts],
        dialog: document.querySelector('.dialog-card .dialog-message')?.textContent ?? null,
        captureFallbacks: [...captureFallbacks],
        fallbackToasts: [...fallbackToasts],
        captureModes: [...document.querySelectorAll('.stage-capture-mode-badge[data-capture-mode]')]
          .filter(element => !element.hidden && element.getClientRects().length)
          .map(element => ({ mode: element.dataset.captureMode, label: element.textContent.trim(),
            tileKey: element.closest('[data-tile-key]')?.dataset.tileKey ?? null })),
        focusedTiles: [...document.querySelectorAll('.stage-focused-main[data-tile-key]')].map(element => element.dataset.tileKey),
        localCaptureKind: videoService.getNativeScreenCaptures()[0]?.captureKind ?? null,
        fullscreen: !!document.fullscreenElement,
        ui: document.querySelector('#share-sources-panel') ? 'Desktop picker labels and thumbnails are not recorded.'
          : document.body.innerText.slice(0, 4000),
        mainCall: webRtcManager['nativeScreens']['call']?.config.callId ?? null,
        visibleSession: sessionManager.getActive()?.key ?? null, voiceSession: voiceStore.voiceSessionKey,
        localNativeSources: videoService.getNativeScreenCaptures().length,
        localScreenShareIds: [...voiceStore.screenShareIds], screenAudioShareId: voiceStore.screenAudioShareId,
        previewState: document.querySelector('[data-preview-state]')?.dataset.previewState ?? null,
        focused: document.hasFocus(),
        previewPauseWhenUnfocused: settingsStore.screenSharePreviewPauseWhenUnfocused,
        screenEncodingMode: settingsStore.screenEncodingMode, preferredScreenCodec: settingsStore.preferredScreenCodec,
        screenEncodingStrategy: settingsStore.screenEncodingStrategy,
        browserWatches: [...(webRtcManager['nativeScreens']['call']?.presentations.values() ?? [])]
          .filter(entry => entry.browser && !entry.stopping).length,
        screenOutputContext: webRtcManager['mediaRouter']['audioContexts'].get('screen')?.state ?? null,
        measuredScreenContext: measuredScreenContext?.state ?? null,
        watchStates: [...(webRtcManager['nativeScreens']['call']?.presentations.values() ?? [])].map(entry => entry.state),
        presentations: [...(webRtcManager['nativeScreens']['call']?.presentations.values() ?? [])]
          .map(entry => ({ source: entry.source, presentationId: entry.presentationId, stopping: entry.stopping })),
        overlay: {
          open: overlayBridgeService.getIsOpen(), connection: overlayBridgeService['localPeerConnection']?.connectionState ?? null,
          carryingScreen: overlayBridgeService['videoSenders'].some(sender =>
            watchedVideo()?.srcObject?.getVideoTracks().includes(sender.track)),
          onlyDummy: overlayBridgeService['videoSenders'].every(sender => sender.track === overlayBridgeService['dummyTrack']),
          measuredDummy: measuredDummyTrack?.readyState ?? null,
        },
      };
    },
    async stats() {
      const call = webRtcManager['nativeScreens']['call'];
      return call ? await window.api.nativeScreenCommand({ action: 'stats', callId: call.config.callId }) : null;
    },
    async browserStats() {
      const entries = [...(webRtcManager['nativeScreens']['call']?.presentations.values() ?? [])];
      return Promise.all(entries.filter(entry => entry.browser && !entry.stopping).map(async entry => ({
        subscriptionId: entry.browser.subscriptionId, state: entry.state, reports: [...(await entry.browser.stats() ?? [])].map(([, report]) => report),
      })));
    },
    telemetry() {
      return [...document.querySelectorAll('.stage-diagnostics-btn')].filter(button => button.dataset.diagnosticsKey?.includes(':screen:'))
        .map(button => ({ key: button.dataset.diagnosticsKey, text: button.title, hidden: button.hidden }));
    },
    async setTelemetryEnabled(enabled) {
      const previous = settingsStore.screenShareTelemetryEnabled;
      settingsStore.screenShareTelemetryEnabled = enabled;
      settingsStore.save();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return previous;
    },
    setPreviewPauseWhenUnfocused(value) {
      if (typeof value !== 'boolean') throw new Error('Preview focus preference must be boolean.');
      const previous = settingsStore.screenSharePreviewPauseWhenUnfocused;
      settingsStore.screenSharePreviewPauseWhenUnfocused = value;
      settingsStore.save();
      return previous;
    },
    async pixels() {
      const video = watchedVideo();
      if (!video?.videoWidth || !video.videoHeight) throw new Error('No actual received video is available to sample.');
      // A Canvas2D cache can retain the inspected GPU frame after the canvas becomes unreachable.
      const frame = new VideoFrame(video, { timestamp: 0 });
      try {
        const buffer = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
        const layout = await frame.copyTo(buffer, { format: 'RGBA' });
        const width = frame.visibleRect.width, height = frame.visibleRect.height;
        const point = (x, y) => {
          const offset = layout[0].offset + Math.floor(y * height) * layout[0].stride + Math.floor(x * width) * 4;
          return [...buffer.subarray(offset, offset + 4)];
        };
        let firstContentX = null, lastContentX = null;
        for (let x = 0; x < width; x++) {
          if (point(x / width, .5).slice(0, 3).some(value => value > 96)) {
            firstContentX ??= x;
            lastContentX = x;
          }
        }
        return { width, height, firstContentX, lastContentX, left: point(.02, .5), right: point(.98, .5),
          top: point(.5, .04), bottom: point(.5, .96), center: point(.5, .5) };
      } finally { frame.close(); }
    },
    previewClip(state) {
      const capture = videoService.getNativeScreenCaptures()[0];
      const card = capture && [...document.querySelectorAll('[data-kind="screen"]')]
        .find(element => element.dataset.tileKey?.endsWith(':screen:' + capture.source.shareId));
      if (!card || card.dataset.previewState !== state) throw new Error('The local preview is not in its expected state.');
      let area, placeholderVisible = null;
      if (state === 'waiting' || state === 'paused') {
        const placeholder = card.querySelector('.stage-native-thumbnail');
        if (placeholder.hidden) throw new Error('The standby message is hidden.');
        area = placeholder.querySelector('span').getBoundingClientRect();
        placeholderVisible = placeholder.contains(document.elementFromPoint(area.x + area.width / 2, area.y + area.height / 2));
      } else {
        const video = card.querySelector('video.stage-video-element');
        if (!video?.videoWidth || !video.videoHeight) throw new Error('The local preview has no decoded image.');
        const bounds = video.getBoundingClientRect();
        const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
        const width = video.videoWidth * scale, height = video.videoHeight * scale;
        area = { x: bounds.x + (bounds.width - width) / 2 + width * (preserveAspectRatio ? .2 : .02) - 2,
          y: bounds.y + (bounds.height - height) / 2 + height * .5 - 2, width: 4, height: 4 };
      }
      const clip = { x: Math.ceil(area.x), y: Math.ceil(area.y), width: Math.floor(area.width), height: Math.floor(area.height) };
      if (clip.x < 0 || clip.y < 0 || clip.width < 1 || clip.height < 1
        || clip.x + clip.width > innerWidth || clip.y + clip.height > innerHeight)
        throw new Error('Preview sample lies outside the owned viewport.');
      return { clip, placeholderVisible };
    },
    async diagnostics() {
      const local = videoService.getNativeScreenCaptures()[0], remote = sharing();
      const source = local?.source ?? remote?.voiceState.nativeScreenShares?.[0];
      if (!source) return null;
      const value = await webRtcManager.getScreenVideoDiagnostics(local ? auth.currentUser.sessionId : remote.user.sessionId, source.shareId);
      if (!value || value.backend === 'native') return value;
      return { backend: value.backend, source: value.source, profile: value.profile,
        reports: [...(value.reports ?? [])].map(([, report]) => report) };
    },
    async openOverlay() {
      settingsStore.setOverlayConfig({ mode: 'cameras-and-screens', minimalistMode: false,
        hideSelf: true, autoOpenOnLeaveStage: false, focusActiveSpeaker: false });
      if (!(await overlayBridgeService.open())) throw new Error('The real overlay did not open.');
      measuredDummyTrack = overlayBridgeService['dummyTrack'];
    },
    async closeOverlay() { await overlayBridgeService.deactivate(); },
    async browseServer(port, password) {
      await openServerSession('127.0.0.1', port, await window.api.getIdentity(), 'Native QA background call', password);
      if (sessionManager.getActive()?.key === session.key) throw new Error('The second server did not become visible.');
    },
    backgroundQuality(quality) {
      const remote = sharing();
      if (!remote) throw new Error('The actual call lost its screen publication while browsing another server.');
      voiceStore.setScreenQuality(remote.user.sessionId, remote.voiceState.nativeScreenShares[0].shareId, quality);
    },
    async restoreCallView() {
      sessionManager.activate(session.key);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const channelButton = document.querySelector(`[data-channel-id="${channel.id}"][data-channel-type="VOICE"]`);
      if (!channelButton) throw new Error('The original voice channel did not return to the navigation.');
      channelButton.click();
    },
    browserAudioReady() {
      const remote = sharing();
      const pipeline = remote && webRtcManager['mediaRouter']['screenAudioPipelines'].get(remote.user.sessionId);
      return !!pipeline && pipeline.gain.context.state === 'running';
    },
    async browserAudioSignal() {
      const remote = sharing();
      const pipeline = remote && webRtcManager['mediaRouter']['screenAudioPipelines'].get(remote.user.sessionId);
      if (!pipeline || pipeline.gain.context.state !== 'running') throw new Error('The actual browser screen output graph is not running.');
      const context = pipeline.gain.context, split = context.createChannelSplitter(2);
      measuredScreenContext = context;
      const analysers = [context.createAnalyser(), context.createAnalyser()];
      for (const [channel, analyser] of analysers.entries()) { analyser.fftSize = 1024; split.connect(analyser, channel); }
      pipeline.gain.connect(split);
      let frames = 0, nonzeroFrames = 0, left = 0, right = 0;
      const channels = [new Float32Array(1024), new Float32Array(1024)];
      try {
        for (let sample = 0; sample < 35; sample++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          analysers.forEach((analyser, channel) => analyser.getFloatTimeDomainData(channels[channel]));
          for (let frame = 0; frame < channels[0].length; frame++) {
            const l = channels[0][frame], r = channels[1][frame];
            frames++; left += l * l; right += r * r;
            if (Math.abs(l) > 1e-7 || Math.abs(r) > 1e-7) nonzeroFrames++;
          }
        }
      } finally { pipeline.gain.disconnect(split); split.disconnect(); analysers.forEach(analyser => analyser.disconnect()); }
      return { method: 'actual-post-gain-webaudio-samples', frames, nonzeroFrames,
        leftRms: Math.sqrt(left / frames), rightRms: Math.sqrt(right / frames) };
    },
    async cleanup() {
      toastObserver.disconnect();
      for (const check of toastChecks) clearTimeout(check);
      toastChecks.clear();
      unbindFallback();
      unbindNativeErrors();
      unbind();
      await overlayBridgeService.deactivate();
      await stopLocalScreenShares(screenAudioService);
      await webRtcManager['nativeScreens'].close();
      leaveCurrentCall();
      settingsStore.screenSharePreviewPauseWhenUnfocused = initialPreviewPauseWhenUnfocused;
      settingsStore.save();
    },
  };
  return { sessionId: auth.currentUser.sessionId, channelId: channel.id,
    protocol: auth.server.protocol,
    capabilities: await webRtcManager.getNativeScreenCapabilities(), profile: videoService.getProfile(),
    screenEncodingMode: settingsStore.screenEncodingMode, preferredScreenCodec: settingsStore.preferredScreenCodec,
    screenEncodingStrategy: settingsStore.screenEncodingStrategy,
    previewPauseWhenUnfocused: initialPreviewPauseWhenUnfocused,
    browserVideoCapabilities: browserReceiver ? RTCRtpReceiver.getCapabilities('video') : null };
}

function verifyExplicit1080p60(evidence) {
  assert.equal(evidence.publisherStats.publishers.length, 1);
  const owner = evidence.publisherStats.publishers[0];
  assert.deepEqual(owner.source.video, { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 20000 });
  assert.equal(owner.source.audio, audioEnabled);
  assert.equal(owner.pipelines.length, 1);
  assert.deepEqual(owner.pipelines[0].endpoint.profile, owner.source.video);
  const reports = browserReceiver ? evidence.browserStats.flatMap(entry => entry.reports)
    : evidence.receiverDiagnostics.endpoints.flatMap(endpoint => endpoint.rtp.flatMap(entry => entry.reports));
  const rtp = reports.find(row => row.type === 'inbound-rtp' && (row.kind ?? row.mediaType) === 'video');
  assert.ok(rtp && rtp.packetsReceived > 0 && rtp.framesDecoded > 0);
  assert.equal(rtp.frameWidth, 1920);
  assert.equal(rtp.frameHeight, 1080);
  const codec = reports.find(row => row.type === 'codec' && row.id === rtp.codecId);
  assert.equal(codec?.mimeType?.toLowerCase(), `video/${owner.source.codec ?? 'h264'}`);
  const decoded = evidence.receiverState.video;
  assert.equal(decoded?.width, 1920);
  assert.equal(decoded?.height, 1080);
  assert.ok(decoded.frames > 0);
  return { requestedProfile: owner.source.video, admittedProfile: owner.pipelines[0].endpoint.profile,
    rtp, codec, decoded, minimumPresentationFps };
}

async function closeActiveWindow(publisher, viewer, publisherStats) {
  phase('closing-real-main-window-with-active-share-and-viewer');
  assert.equal(publisherStats.publishers.length, 1);
  assert.equal(publisherStats.publishers[0].viewers, 1);
  const capturePids = publisherStats.publishers[0].pipelines.map(value => value.endpoint.capturePid);
  const closureNotifications = [];
  expectedWindowClosures.set(publisher.label, closureNotifications);
  report.activeWindowClose = { before: publisherStats,
    request: await publisher.child.call('qa-root-close'), shutdownDialogs, shutdownErrors, capturePids };
  const closed = await within(publisher.child.closed, 20000, 'BrowserWindow.close did not complete real Main shutdown.');
  report.activeWindowClose.processExit = closed;
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
  assert.equal(shutdownDialogs.length, 0, 'Real Main shutdown displayed a Keep open/retry dialog.');
  assert.equal(closureNotifications.length, 1, 'Only the supervisor notification for the requested process exit is expected.');
  report.activeWindowClose.supervisorNotifications = closureNotifications.map(error => error.message);
  await until(async () => {
    const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    const stats = await viewer.cdp.evaluate('nativeAppSmoke.stats()');
    return state.sources.length === 0 && state.browserWatches === 0 && !state.video && stats.subscriptions.length === 0;
  }, 'Real Main window close retained the spectator media.');
  for (const pid of capturePids) await until(() => !processAlive(pid), `Real Main close retained capture host ${pid}.`);
  report.activeWindowClose.nativeCaptureRetired = true;
}

async function exerciseSourceQualityChanges(publisher, viewer) {
  const ladder = fourK ? [
    { width: 3840, height: 2160, fps: fourK60 ? 60 : 120, maxBitrateKbps: 80000 },
    { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 6000 },
    { width: 3840, height: 2160, fps: fourK60 ? 60 : 120, maxBitrateKbps: 80000 },
  ] : [
    { width: 1280, height: 720, fps: 30, maxBitrateKbps: 2000 },
    { width: 1920, height: 1080, fps: 30, maxBitrateKbps: 3000 },
    { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 3000 },
    { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 },
  ];
  const observations = new Map(), retiredCapturePids = new Set(), performanceFailures = [];
  const observe = stats => {
    for (const owner of stats.publishers) {
      let record = observations.get(owner.source.instanceId);
      if (!record) {
        record = { source: owner.source, capturePids: new Set(), retiredPids: new Set() };
        observations.set(owner.source.instanceId, record);
      }
      for (const pipeline of owner.pipelines) {
        const pid = pipeline.endpoint.capturePid;
        if (Number.isSafeInteger(pid) && pid > 0) record.capturePids.add(pid);
      }
    }
    report.sourceQualityChanges.observedSources = [...observations.values()]
      .map(entry => ({ source: entry.source, capturePids: [...entry.capturePids] }));
  };
  const output = stats => {
    assert.equal(stats.subscriptions.length, 1, 'The native receiver must own exactly one watched subscription.');
    return stats.subscriptions[0].endpoint.audioOutput;
  };
  const initialState = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  const publisherCall = (await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).mainCall;
  const viewerCall = initialState.mainCall, shareId = report.published.source.shareId;
  let current = report.published.source;
  let expectedPublisherEvents = [];
  report.sourceQualityChanges = { ladder, measurements: [], changes: [], nativeReceiverRequired: true,
    initialShareId: shareId, publisherCall, viewerCall, minimum120Fps };
  const ready = async () => {
    await until(async () => {
      const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      assert.deepEqual(state.errors, []);
      const stats = await viewer.cdp.evaluate('nativeAppSmoke.stats()');
      if (stats?.subscriptions.length !== 1 || !stats.subscriptions[0].endpoint?.audioOutput) return false;
      const presentation = state.presentations.find(entry => !entry.stopping && entry.source.instanceId === current.instanceId);
      if (!presentation || stats.subscriptions[0].presentationId !== presentation.presentationId) return false;
      const audio = output(stats);
      return state.sources[0]?.instanceId === current.instanceId && state.video?.width === current.video.width
        && state.video.height === current.video.height && state.video.frames >= 30
        && state.watchStates[0]?.state === 'playing' && audio?.ready && audio.pcmSignal?.nonzeroFrames > 4800;
    }, 'Same-share quality replacement did not automatically resume native video and PCM.', 45000);
  };
  const measure = async label => {
    await ready();
    await delay(500);
    const before = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    const audioBefore = output(await viewer.cdp.evaluate('nativeAppSmoke.stats()'));
    await delay(3000);
    const after = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    const evidence = await collectEvidence(`sourceQuality-${label}`, publisher, viewer);
    observe(evidence.publisherStats);
    const audioAfter = output(evidence.receiverStats);
    const frames = audioAfter.pcmSignal.frames - audioBefore.pcmSignal.frames;
    const pcm = { frames, nonzeroFrames: audioAfter.pcmSignal.nonzeroFrames - audioBefore.pcmSignal.nonzeroFrames,
      leftRms: Math.sqrt((audioAfter.pcmSignal.leftSquareSum - audioBefore.pcmSignal.leftSquareSum) / frames),
      rightRms: Math.sqrt((audioAfter.pcmSignal.rightSquareSum - audioBefore.pcmSignal.rightSquareSum) / frames) };
    assert.equal(audioAfter.epoch, audioBefore.epoch);
    assert.ok(frames > 4800 && pcm.nonzeroFrames > 4800 && pcm.leftRms > 1e-5 && pcm.rightRms > 1e-5,
      `The replacement lost real native stereo PCM: ${JSON.stringify(pcm)}`);
    assert.equal(evidence.publisherStats.publishers.length, 1);
    const owner = evidence.publisherStats.publishers[0];
    assert.deepEqual(owner.source, current);
    assert.equal(owner.viewers, 1);
    assert.equal(owner.pipelines.length, 1);
    const endpoint = owner.pipelines[0].endpoint;
    assert.ok(endpoint.audioInput.submitted > 0);
    assert.deepEqual(endpoint.audioInput.errors, []);
    assert.deepEqual(endpoint.errors, []);
    assert.deepEqual(audioAfter.errors, []);
    assert.equal(evidence.receiverState.browserWatches, 0);
    assert.equal(evidence.receiverDiagnostics.backend, 'native');
    assert.deepEqual(evidence.receiverDiagnostics.source, current);
    assert.deepEqual(evidence.receiverStats.subscriptions[0].endpoint.profile, current.video);
    assert.equal(evidence.receiverState.watchActions, 1, 'Quality must not require another Watch click.');
    assert.deepEqual(evidence.receiverState.watches, initialState.watches);
    assert.equal(evidence.publisherState.mainCall, publisherCall);
    assert.equal(evidence.receiverState.mainCall, viewerCall);
    assert.equal(evidence.publisherState.screenAudioShareId, shareId);
    assert.deepEqual(evidence.publisherState.localScreenShareIds, [shareId]);
    assert.deepEqual(evidence.publisherState.errors, expectedPublisherEvents);
    assert.deepEqual(evidence.receiverState.errors, []);
    assert.equal(evidence.publisherState.dialog, null);
    assert.equal(evidence.receiverState.dialog, null);
    const fps = (after.video.frames - before.video.frames) * 1000 / (after.video.at - before.video.at);
    const measurement = { label, source: current, fps, pcm, audioEpoch: audioAfter.epoch, capturePid: endpoint.capturePid };
    report.sourceQualityChanges.measurements.push(measurement);
    if (fourK) {
      const native = { sender: await publisher.child.call('qa-native-snapshots'),
        receiver: await viewer.child.call('qa-native-snapshots') };
      await fs.writeFile(path.join(artifacts, `native4k-${label}.json`), JSON.stringify(native, null, 2) + '\n', { flag: 'wx' });
      const expectedLevel = current.video.width === 3840 ? current.video.fps === 120 ? '3c' : '34' : '33';
      const minimumSourceLevel = current.video.width === 3840 ? expectedLevel : '2a';
      measurement.nativeVideo = { maximumSourceLevel: expectedLevel, minimumSourceLevel, rtp: [], decoder: null };
      for (const [role, diagnostics] of [['sender', evidence.senderDiagnostics], ['receiver', evidence.receiverDiagnostics]]) {
        const rows = diagnostics.endpoints.flatMap(entry => {
          assert.equal(entry.readErrors, 0);
          return entry.rtp.flatMap(value => value.reports);
        });
        const video = rows.find(row => row.type === (role === 'sender' ? 'outbound-rtp' : 'inbound-rtp')
          && row.kind === 'video' && row.frameWidth === current.video.width && row.frameHeight === current.video.height);
        assert.ok(video, `Actual ${role} RTP dimensions did not prove ${current.video.width}x${current.video.height}.`);
        if (role === 'sender') assert.ok(video.bytesSent > 0 && video.framesSent > 0);
        else assert.ok(video.packetsReceived > 0 && video.bytesReceived > 0);
        const codec = rows.find(row => row.type === 'codec' && row.id === video.codecId);
        assert.ok(codec && /video\/h264/i.test(codec.mimeType));
        const negotiated = /(?:^|;)profile-level-id=4d[0-9a-f]{2}([0-9a-f]{2})(?:;|$)/i.exec(codec.sdpFmtpLine);
        assert.ok(negotiated && parseInt(negotiated[1], 16) >= parseInt(expectedLevel, 16),
          'Negotiated Main profile must admit the actual SPS level, not falsely advertise a lower ceiling.');
        if (negotiated[1].toLowerCase() !== expectedLevel)
          assert.match(codec.sdpFmtpLine, /(?:^|;)level-asymmetry-allowed=1(?:;|$)/);
        measurement.nativeVideo.rtp.push({ role, video, codec });
      }
      const receiver = native.receiver.find(entry => entry.role === 'receive'
        && entry.pipelineId === evidence.receiverStats.subscriptions[0].endpoint.pipelineId);
      const decoder = receiver?.rtc.mf?.decoders.find(entry => entry.core?.gpuFrames > 0);
      assert.ok(decoder, 'The actual MF decoder did not prove decoded GPU frames.');
      measurement.nativeVideo.decoder = decoder.core;
      assert.equal(decoder.core.configured.width, current.video.width);
      assert.equal(decoder.core.configured.height, current.video.height);
      const actualSps = /^4d[0-9a-f]{2}([0-9a-f]{2})$/i.exec(decoder.core.configured.profileLevelId);
      assert.ok(actualSps && parseInt(actualSps[1], 16) >= parseInt(minimumSourceLevel, 16)
        && parseInt(actualSps[1], 16) <= parseInt(expectedLevel, 16),
      'Actual Main SPS must support the resolution/rate and stay within the source level ceiling.');
      assert.equal(decoder.core.errors, 0);
      assert.equal(decoder.core.spsVerified, true);
    }
    try {
      if (current.video.fps === 120) assert.ok(fps >= minimum120Fps,
        `Native ${label} presentation reached ${fps.toFixed(2)} FPS; minimum is ${minimum120Fps}.`);
      else {
        const min = current.video.fps === 60 ? 50 : 25, max = current.video.fps === 60 ? 65 : 35;
        assert.ok(fps >= min && fps <= max, `Native ${label} presentation reached ${fps.toFixed(2)} FPS; expected ${min}-${max}.`);
      }
    } catch (error) {
      // Complete the ladder and cleanup, but never turn a missed threshold into success.
      performanceFailures.push(error);
      report.sourceQualityChanges.performanceFailures = performanceFailures.map(value => value.message);
    }
    return evidence;
  };
  const change = async (profiles, label) => {
    phase(`changing-source-quality-${label}`);
    const before = current, previousInstances = new Set(observations.keys());
    let settled = false;
    const changing = publisher.cdp.evaluate(`nativeAppSmoke.changeSourceQuality(${JSON.stringify(profiles)})`)
      .finally(() => { settled = true; });
    void changing.catch(() => {});
    while (!settled) {
      observe(await publisher.cdp.evaluate('nativeAppSmoke.stats()'));
      await delay(40);
    }
    const changed = await changing;
    current = changed.after;
    assert.equal(current.shareId, before.shareId);
    assert.notEqual(current.instanceId, before.instanceId);
    assert.equal(current.audio, true);
    assert.deepEqual(current.video, profiles.at(-1));
    await ready();
    observe(await publisher.cdp.evaluate('nativeAppSmoke.stats()'));
    const admitted = [...observations.values()].filter(entry => !previousInstances.has(entry.source.instanceId));
    assert.deepEqual(admitted.map(entry => entry.source.video), profiles, 'Every queued quality must cross real serialized admission.');
    for (const entry of observations.values()) {
      if (entry.source.instanceId === current.instanceId) continue;
      for (const pid of entry.capturePids) {
        // Windows may reuse a PID after this exact source's exit was already proved.
        if (entry.retiredPids.has(pid)) continue;
        await until(() => !processAlive(pid), `Quality replacement retained capture host ${pid}.`);
        entry.retiredPids.add(pid);
        retiredCapturePids.add(pid);
      }
    }
    report.sourceQualityChanges.changes.push({ label, before, after: current, queuedChoices: changed.queuedChoices,
      admitted: admitted.map(entry => ({ source: entry.source, capturePids: [...entry.capturePids] })) });
  };
  const initialLabel = fourK ? `4k${fourK60 ? 60 : 120}-80000` : '720p30-2000';
  phase(`measuring-initial-${initialLabel}-native-quality`);
  await measure(initialLabel);
  for (const [index, profile] of ladder.slice(1).entries()) {
    await change([profile], String(index + 1));
    await measure(`step-${index + 1}`);
  }
  if (!fourK) {
    await change(ladder, 'rapid-consecutive');
    await measure('rapid-final');
  }
  if (fourK60) {
    phase('rejecting-unsupported-4k120-with-live-4k60');
    const before = await collectEvidence('unsupported4k120Before', publisher, viewer);
    const rejection = await publisher.cdp.evaluate('nativeAppSmoke.rejectUnsupported4k120()');
    report.sourceQualityChanges.unsupported4k120 = rejection;
    assert.match(rejection.error, /AMF H264 requires level_idc=60.*3840x2160@120.*MaxLevel=52/);
    assert.match(rejection.error, /unsupported; no lower-level or software fallback/);
    assert.deepEqual(rejection.before, current);
    assert.deepEqual(rejection.after, current);
    assert.equal(rejection.events.length, 1, 'A single unsupported request must not cascade into repeated source failures.');
    assert.ok(['unsupported', 'runtime'].includes(rejection.events[0].reason));
    assert.equal(rejection.events[0].shareId, undefined, 'Expected admission rejection must not mark the live source failed.');
    expectedPublisherEvents = rejection.events;
    const after = await measure('rejected-4k120-preserved-4k60');
    assert.equal(after.receiverStats.subscriptions[0].subscriptionId, before.receiverStats.subscriptions[0].subscriptionId);
    assert.equal(after.receiverStats.subscriptions[0].endpoint.pipelineId, before.receiverStats.subscriptions[0].endpoint.pipelineId);
    assert.equal(output(after.receiverStats).activeEpoch, output(before.receiverStats).activeEpoch);
    assert.equal(after.publisherStats.publishers[0].pipelines[0].endpoint.capturePid,
      before.publisherStats.publishers[0].pipelines[0].endpoint.capturePid);
    rejection.preservationVerified = true;
  }
  if (clockFeedbackStall) {
    phase('stalling-only-owned-receiver-main-350ms');
    const before = await collectEvidence('qualityClockBefore', publisher, viewer), audioBefore = output(before.receiverStats);
    const stalled = await viewer.child.call('qa-clock-stall');
    assert.equal(stalled.pid, viewer.child.child.pid);
    assert.ok(stalled.blockedMs >= 350);
    report.sourceQualityChanges.clockStall = { ...stalled, before: audioBefore, after: null };
    await until(async () => {
      const stats = await viewer.cdp.evaluate('nativeAppSmoke.stats()'), audio = output(stats);
      assert.equal(audio.activeEpoch, audioBefore.activeEpoch, 'A queue stall replaced the native output epoch.');
      assert.deepEqual(audio.errors, []);
      return audio.ready && audio.pcmSignal.frames > audioBefore.pcmSignal.frames + 4800
        && audio.rejectedClockObservations > audioBefore.rejectedClockObservations;
    }, 'The controlled stall did not demonstrate rejected stale clock feedback and same-epoch PCM recovery.', 10000);
    const recovered = await collectEvidence('qualityClockRecovered', publisher, viewer), audioAfter = output(recovered.receiverStats);
    assert.equal(recovered.receiverStats.subscriptions[0].subscriptionId, before.receiverStats.subscriptions[0].subscriptionId);
    assert.equal(recovered.receiverStats.subscriptions[0].endpoint.pipelineId, before.receiverStats.subscriptions[0].endpoint.pipelineId);
    report.sourceQualityChanges.clockStall = { ...stalled, before: audioBefore, after: audioAfter };
    assert.equal(recovered.receiverState.sources[0].instanceId, current.instanceId);
    assert.deepEqual(recovered.receiverState.errors, []);
    assert.deepEqual(recovered.publisherState.errors, expectedPublisherEvents);
  }
  if (closeAppActive) {
    const active = await collectEvidence('sourceQualityActiveBeforeClose', publisher, viewer);
    assert.deepEqual(active.publisherState.errors, expectedPublisherEvents);
    assert.deepEqual(active.receiverState.errors, []);
    await closeActiveWindow(publisher, viewer, active.publisherStats);
  } else {
    phase('stopping-quality-scenario-through-real-ui');
    await publisher.cdp.evaluate('nativeAppSmoke.stopSharing()');
    await until(async () => {
      const local = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
      const remote = await viewer.cdp.evaluate('nativeAppSmoke.stats()');
      const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      return local.publishers.length === 0 && remote.subscriptions.length === 0 && state.sources.length === 0;
    }, 'Final quality Stop retained its publisher or native receiver.');
    const retired = await collectEvidence('sourceQualityRetired', publisher, viewer);
    assert.deepEqual(retired.sfuScreenProducers, []);
    assert.deepEqual(retired.publisherState.errors, expectedPublisherEvents);
    assert.deepEqual(retired.receiverState.errors, []);
  }
  for (const entry of observations.values()) for (const pid of entry.capturePids) {
    if (entry.retiredPids.has(pid)) continue;
    await until(() => !processAlive(pid), `Final quality Stop retained capture host ${pid}.`);
    entry.retiredPids.add(pid);
    retiredCapturePids.add(pid);
  }
  report.sourceQualityChanges.retiredCapturePids = [...retiredCapturePids];
  report.sourceQualityChanges.performanceFailures = performanceFailures.map(error => error.message);
  if (performanceFailures.length) throw new AggregateError(performanceFailures, 'Native quality presentation thresholds failed.');
}

async function run() {
  await fs.mkdir(artifacts);
  phase('starting-owned-source');
  const primarySource = await startSyntheticSource('source');
  source = primarySource.child;
  const sourceReady = primarySource.ready;
  report.sourcePid = source.pid;
  report.sourceTestDisplay = sourceReady.testDisplay ?? null;
  const secondarySource = sourceReplacement ? await startSyntheticSource('replacement-source') : null;
  if (secondarySource) {
    assert.notEqual(secondarySource.child.pid, source.pid);
    assert.notEqual(secondarySource.ready.hwnd, sourceReady.hwnd);
    report.sourceReplacementCoverage = {
      actual: 'Normal window A -> Normal window B -> A, twice; separate owned processes and independent real stereo tones',
      monitor: 'Not captured: no isolated synthetic display is provisioned; private desktop capture is forbidden.',
      game: 'Not exercised: no gameplay or game injection.',
      sources: sourceOwners.map(owner => ({ pid: owner.child.pid, hwnd: owner.ready.hwnd })),
    };
  }

  phase('starting-real-server');
  const { MonkyServer } = require(path.join(repo, 'apps', 'server', 'dist', 'server.js'));
  const port = await freePort(), password = randomBytes(24).toString('hex');
  server = await MonkyServer.create({ port, dataDir: path.join(artifacts, 'server'),
    serverName: 'Owned native screen QA', password, voiceMode: mode });
  if (browserReceiver || debugPublisher || incompatibleViewer) {
    const handle = server.wsServer.handleNativeScreenSignal;
    assert.equal(typeof handle, 'function');
    server.wsServer.handleNativeScreenSignal = async function (session, payload, requestId) {
      if ((unsupportedBrowserCodec || session.sessionId === incompatibleSessionId)
        && payload.action === 'control' && payload.control.type === 'answer') {
        payload = structuredClone(payload);
        payload.control.sdp = payload.control.sdp.replace(/;max-recv-level=[0-9a-f]+/gi, '');
      }
      await fs.appendFile(path.join(artifacts, 'owned-screen-signaling.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), sessionId: session.sessionId, payload }) + '\n');
      return Reflect.apply(handle, this, [session, payload, requestId]);
    };
  }
  if (mode === 'sfu') server.sfuManager.setAnnouncedIp('127.0.0.1');
  await startLoopbackServer(server, port);

  const { createServer } = await import('vite');
  vite = await createServer({ configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
    cacheDir: path.join(artifacts, 'vite-cache'),
    server: { host: '127.0.0.1', port: await freePort(), hmr: false, watch: null, strictPort: true, open: false } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const { isolatedEnvironment } = await import(pathToFileURL(path.join(repo, 'scripts', 'qa.js')));
  const { startOwnedProcess } = await import(pathToFileURL(path.join(repo, 'scripts', 'qa', 'process.js')));
  const mainFixtureFile = path.join(artifacts, 'main-fixture.cjs');
  await fs.writeFile(mainFixtureFile, `(${mainFixture.toString()})(${JSON.stringify({
    clientRoot, origin, ownerPid: process.pid, clockFeedbackStall, fourK, cadenceDiagnostics, closeAppActive, observeSourceClosure,
    encodedByteTrace, videoOverlayCounterfactual, artifacts, ownedSource: { pid: sourceReady.pid, hwnd: sourceReady.hwnd } })});\n`,
    { flag: 'wx' });
  const allowed = path.join(repo, '.qa', 'runs');
  await fs.mkdir(allowed, { recursive: true });
  for (const label of ['publisher', 'viewer', ...(incompatibleViewer ? ['incompatible'] : [])]) {
    phase(`opening-normal-${label}`);
    const runId = randomUUID(), root = path.join(allowed, `home-${runId}`), profile = path.join(root, 'client');
    await fs.mkdir(root); roots.push(root);
    for (const child of ['', 'scratch', 'AppData\\Roaming', 'AppData\\Local', 'config', 'cache', 'data', 'cli'])
      await fs.mkdir(path.join(profile, child), { recursive: true });
    const config = { runId, scenario: 'home', smoke: false, nickname: `Native QA ${label}`,
      server: { host: '127.0.0.1', port, name: 'Owned native screen QA', password } };
    const configFile = path.join(root, 'launch.json');
    await fs.writeFile(configFile, JSON.stringify({ ownerPid: process.pid, config }), { flag: 'wx' });
    const debugPort = await freePort();
    const receiveLogArgs = chromiumReceiveLog && label === 'viewer' ? [
      '--enable-logging=stderr',
      '--vmodule=h264_decoder=3,d3d11_video_decoder=3,video_receive_stream2=3,rtp_video_stream_receiver2=3,frame_buffer*=3',
    ] : [];
    if (receiveLogArgs.length) report.chromiumReceiveLogArguments = receiveLogArgs;
    const overlayArgs = videoOverlayCounterfactual && label === 'viewer'
      ? ['--disable_direct_composition_video_overlays'] : [];
    if (overlayArgs.length) report.viewerOverlayArguments = overlayArgs;
    const child = startOwnedProcess(require('electron'), [mainFixtureFile, `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', '--allow-loopback-in-peer-connection',
      ...receiveLogArgs, ...overlayArgs], {
      cwd: clientRoot, runId, label: `Native Monky ${label}`, timeoutMs: 60000,
      env: isolatedEnvironment(profile, { MONKY_QA_CONFIG: configFile, VITE_DEV_SERVER_URL: origin,
        ...(process.env.MONKY_TEST_DISPLAY !== undefined ? { MONKY_TEST_DISPLAY: process.env.MONKY_TEST_DISPLAY } : {}) }),
      onFailure: error => {
        const expected = expectedWindowClosures.get(label);
        if (expected) expected.push(error);
        else failures.push(error);
      },
      onMessage: message => {
        if (message.type === 'qa-shutdown-dialog' && message.runId === runId)
          shutdownDialogs.push({ label, ...message.options });
        if (message.type === 'qa-shutdown-error' && message.runId === runId)
          shutdownErrors.push({ label, details: message.details });
      },
    });
    const owned = { child, profile, label, debugPort, runId, cdp: null, overlayCdp: null, diagnostics: [] };
    if (gpuTaskTrace) {
      const childCall = child.call.bind(child);
      child.call = (...args) => {
        qaActionTimeline.push({ at: new Date().toISOString(), runId, role: label, action: args[0] });
        return childCall(...args);
      };
    }
    clients.push(owned);
    const log = await fs.open(path.join(artifacts, `${label}.log`), 'wx');
    if (chromiumReceiveLog && label === 'viewer') {
      let diagnosticFile;
      try { diagnosticFile = await fs.open(path.join(artifacts, 'viewer-chromium-receive.log'), 'wx'); }
      catch (error) { await log.close(); throw error; }
      const combined = boundedDiagnosticLog(log, 'viewer.log');
      const diagnostic = boundedDiagnosticLog(diagnosticFile, 'viewer-chromium-receive.log');
      report.viewerDiagnosticLogs = [combined.state, diagnostic.state];
      child.child.stdout.on('data', value => combined.write(value));
      child.child.stderr.on('data', value => { combined.write(value); diagnostic.write(value); });
      owned.logsClosed = child.closed.then(async () => {
        const results = await Promise.allSettled([combined.close(), diagnostic.close()]);
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      });
    } else {
      child.child.stdout.on('data', value => { void log.write(value); });
      child.child.stderr.on('data', value => { void log.write(value); });
      void child.closed.then(() => log.close());
    }
    await child.ready;
    assert.equal((await child.call('qa-ping')).alive, true);
    owned.cdp = await connectCdp(debugPort, origin, runId, owned.diagnostics);
    await owned.cdp.evaluate(`globalThis.monkyAppSharedPath = ${JSON.stringify(path.join(repo, 'packages', 'shared', 'src', 'index.ts').replaceAll('\\', '/'))}`);
    owned.identity = await owned.cdp.evaluate(`(${setupRenderer.toString()})(${JSON.stringify({
      port, password, nickname: config.nickname, browserReceiver: label === 'incompatible' || browserReceiver && label === 'viewer',
      audioEnabled, preserveAspectRatio, gameFallback, sourceQualityChanges, fourK, fourK60, fullHd60, screenCodec,
    })})`);
    report[`${label}Setup`] = owned.identity;
    report[`${label}TestDisplay`] = process.env.MONKY_TEST_DISPLAY !== undefined
      ? (await child.call('qa-focus-state')).testDisplay : null;
    if (report.protocolContracts.minimumClient !== undefined) {
      assert.equal(owned.identity.protocol?.version, report.protocolContracts.version);
      assert.equal(owned.identity.protocol?.minimumVersion, report.protocolContracts.minimumClient);
    }
    if (label === 'incompatible') incompatibleSessionId = owned.identity.sessionId;
  }
  const [publisher, viewer] = clients;
  assert.equal(publisher.identity.channelId, viewer.identity.channelId);
  assert.notEqual(publisher.child.child.pid, viewer.child.child.pid);
  if (debugPublisher) {
    assert.equal(process.platform, 'win32');
    assert.ok(debugSymbols && path.isAbsolute(debugSymbols), 'Choose the matching, local native symbol directory.');
    const debuggerExe = path.join(process.env['ProgramFiles(x86)'], 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe');
    await fs.access(debuggerExe);
    await fs.access(debugSymbols);
    const dump = path.join(artifacts, 'publisher-native-crash.dmp');
    const commands = `sxe -c ".echo OWNED_SCREEN_NATIVE_FAILURE; .exr -1; .ecxr; kv; ~*kb; lm; .dump /m ${dump}; qd" 0xc0000409; .echo OWNED_SCREEN_DEBUGGER_READY; g`;
    const log = await fs.open(path.join(artifacts, 'publisher-debugger.log'), 'wx');
    let output = '';
    debuggerProcess = spawn(debuggerExe, ['-G', '-p', String(publisher.child.child.pid), '-c', commands],
      { env: { ...process.env, _NT_SYMBOL_PATH: debugSymbols }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [debuggerProcess.stdout, debuggerProcess.stderr]) stream.on('data', bytes => {
      output += bytes.toString(); void log.write(bytes);
    });
    debuggerExited = once(debuggerProcess, 'exit').then(async () => { await log.close(); });
    await until(() => output.includes('OWNED_SCREEN_DEBUGGER_READY'), 'Debugger did not attach to the owned publisher.', 15000);
  }
  const waitForLocalPreview = () => until(async () => {
    const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
    assert.deepEqual(state.errors, []);
    return state.previewState === 'playing' && state.video?.width === report.published.source.video.width
      && state.video.height === report.published.source.video.height && state.video.frames >= 15;
  }, 'The owned local preview did not display actual source frames without remote demand.', gameFallback ? 75000 : 30000);
  const waitForPausedPreview = () => until(async () => {
    const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
    const stats = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
    return state.previewState === 'paused' && stats.publishers.length === 1 && stats.publishers[0].pipelines.length === 0;
  }, 'Blur with the default preference did not retire all unwatched capture/decoder pipelines.');

  assert.equal(publisher.identity.previewPauseWhenUnfocused, true, 'A fresh profile must pause local preview on blur by default.');
  await focusOwned(publisher);
  let rejectedCallId;
  if (admissionRecovery) {
    phase('rejecting-an-owned-ambiguous-source-without-losing-the-call');
    await sourceCommand('duplicate-title');
    report.admissionRejected = await publisher.cdp.evaluate(`nativeAppSmoke.share(${JSON.stringify(sourceReady.hwnd)}, true)`);
    const rejected = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
    rejectedCallId = rejected.mainCall;
    assert.ok(rejectedCallId, 'Native admission did not exercise a real Main call.');
    assert.equal(rejected.channelId, publisher.identity.channelId);
    assert.equal(rejected.localNativeSources, 0);
    assert.deepEqual(rejected.errors, []);
    assert.equal((await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers.length, 0);
    assert.equal((await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).sources.length, 0);
    await sourceCommand('close-duplicate');
  }

  phase('previewing-an-owned-source-before-watch');
  report.published = await publisher.cdp.evaluate(`nativeAppSmoke.share(${JSON.stringify(sourceReady.hwnd)})`);
  if (screenCodec !== 'auto') assert.equal(report.published.source.codec, screenCodec, 'Explicit codec selection was not preserved.');
  if (admissionRecovery) {
    assert.equal(report.published.desktopSourceId, report.admissionRejected.desktopSourceId);
    assert.equal((await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).mainCall, rejectedCallId,
      'Retry replaced the Main call instead of retiring the rejected source selection.');
    report.admissionRecoveredInSameCall = true;
  }
  await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).watchButton, 'Normal Watch control did not appear.');
  await waitForLocalPreview();
  const initial = await collectEvidence('initialLocalPreview', publisher, viewer);
  assert.equal(initial.publisherFocus.mainFocused, true);
  assert.equal(initial.publisherState.focused, true);
  assert.deepEqual(initial.receiverState.watchStates, []);
  assertLocalOnlyPreview(initial, report.published);
  assert.deepEqual(initial.publisherState.focusedTiles, [`${publisher.identity.sessionId}:screen:${report.published.source.shareId}`],
    'A new local share did not automatically focus its preview.');
  const publishedTileKey = `${publisher.identity.sessionId}:screen:${report.published.source.shareId}`;
  assert.ok(initial.publisherState.captureModes.some(value => value.mode === 'normal' && value.tileKey === publishedTileKey),
    'The actual local capture mode is absent from the preview.');
  if (gameFallback) {
    const endpoint = initial.publisherStats.publishers[0].pipelines[0].endpoint;
    assert.equal(endpoint.captureMode, 'normal');
    assert.equal(initial.publisherState.localCaptureKind, 'window');
    assert.equal(initial.publisherState.captureFallbacks.length, 1);
    assert.equal(initial.publisherState.captureFallbacks[0].shareId, report.published.source.shareId);
    assert.equal(initial.publisherState.fallbackToasts.length, 1, 'Fallback must display exactly one actual toast.');
    assert.equal(initial.publisherState.fallbackToasts[0].visible, true, 'The fallback toast was not visibly rendered.');
    const retirement = endpoint.gameCaptureRetirement;
    assert.equal(retirement?.nativeClosed, true);
    assert.equal(retirement.forcedTermination, false);
    assert.deepEqual(retirement.processExit, retirement.exit);
    assert.ok(retirement.exit && retirement.exit.signal === null);
    assert.deepEqual(retirement.outputEof, { stdout: true, stderr: true });
    assert.equal(retirement.live.packets, 0, 'The Game attempt already emitted a timeline before retry.');
    assert.equal(retirement.live.eof, true);
    assert.notEqual(retirement.helperProcessId, endpoint.capturePid);
    report.gameFallbackRetired = retirement;
  }
  report.idle = initial.publisherStats;
  report.idleDiagnostics = initial.senderDiagnostics;
  report.idlePreviewPixels = await previewPixels(publisher, 'playing', 'preview-local-unwatched');
  await publisher.cdp.evaluate('nativeAppSmoke.toggleLocalFocus()');
  await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).focusedTiles.length === 0,
    'The transmitter could not leave automatic focus through its screen card.');

  phase('pausing-unwatched-preview-on-real-blur');
  await blurPublisher(publisher, viewer);
  await waitForPausedPreview();
  assertPausedPreview(await collectEvidence('defaultBlurPreview', publisher, viewer), report.published);
  report.defaultBlurPixels = await previewPixels(publisher, 'paused', 'preview-blurred');

  phase('keeping-unfocused-preview-with-preference-disabled');
  await publisher.cdp.evaluate('nativeAppSmoke.setPreviewPauseWhenUnfocused(false)');
  await waitForLocalPreview();
  const background = await collectEvidence('backgroundLocalPreview', publisher, viewer);
  assert.equal(background.publisherFocus.anyFocused, false);
  assert.equal(background.publisherState.focused, false);
  assert.equal(background.publisherState.previewPauseWhenUnfocused, false);
  assertLocalOnlyPreview(background, report.published);
  report.backgroundPreviewPixels = await previewPixels(publisher, 'playing', 'preview-background');

  phase('restoring-default-focus-policy');
  await publisher.cdp.evaluate('nativeAppSmoke.setPreviewPauseWhenUnfocused(true)');
  await waitForPausedPreview();
  assertPausedPreview(await collectEvidence('restoredDefaultPreview', publisher, viewer), report.published);
  await focusOwned(publisher);
  await waitForLocalPreview();
  const refocused = await collectEvidence('refocusedLocalPreview', publisher, viewer);
  assert.equal(refocused.publisherFocus.mainFocused, true);
  assert.equal(refocused.publisherState.previewPauseWhenUnfocused, true);
  assertLocalOnlyPreview(refocused, report.published);
  assert.equal(refocused.publisherState.captureFallbacks.length, gameFallback ? 1 : 0,
    'Preview restarts retried Game Capture or duplicated its fallback notice.');
  assert.equal(refocused.publisherState.fallbackToasts.length, gameFallback ? 1 : 0);
  assert.deepEqual(refocused.publisherState.focusedTiles, [], 'Preview state updates overrode a manual choice to leave focus.');
  report.refocusedPreviewPixels = await previewPixels(publisher, 'playing', 'preview-refocused');

  // Cadence/pixel measurements must not depend on which owned window has foreground focus.
  await publisher.cdp.evaluate('nativeAppSmoke.setPreviewPauseWhenUnfocused(false)');
  await blurPublisher(publisher, viewer);
  await waitForLocalPreview();
  if (idleSourceClose) {
    phase('closing-a-local-only-source-without-ever-watching');
    await sourceCommand('close-source');
    await until(async () => !(await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).sources.length
      && (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers.length === 0,
    'Closing an unwatched window retained its announcement.');
    report.idleSourceRetired = true;
    return;
  }
  if (audioEnabled) await sourceCommand('tone-start');

  phase('watching-through-normal-ui');
  if (encodedByteTrace) {
    await viewer.cdp.startMediaTrace();
    viewer.mediaTraceActive = true;
  }
  await viewer.cdp.evaluate('nativeAppSmoke.watch()');
  if (unsupportedBrowserCodec) {
    phase('rejecting-an-insufficient-receive-level');
    await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).watchStates
      .some(state => state.state === 'unavailable' && state.reason === 'unsupported'),
    'An insufficient H.264 receive level did not produce an explicit unsupported error.');
    await until(async () => {
      const stats = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
      return stats.publishers[0].viewers === 0 && stats.publishers[0].pipelines.length === 1
        && stats.publishers[0].pipelines[0].endpoint.audioInput === null;
    }, 'Rejected browser negotiation did not retire its remote publication/PCM and return to local-only preview.');
    await waitForLocalPreview();
    const rejected = await collectEvidence('unsupportedBrowserLocalPreview', publisher, viewer);
    assertLocalOnlyPreview(rejected, report.published);
    assert.equal((await publisher.child.call('qa-ping')).alive, true, 'Rejected codec crashed the publisher.');
    assert.equal((await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).browserWatches, 0);
    report.unsupportedPreviewPixels = await previewPixels(publisher, 'playing', 'preview-after-unsupported-browser');
    await blurPublisher(publisher, viewer);
    await publisher.cdp.evaluate('nativeAppSmoke.setPreviewPauseWhenUnfocused(true)');
    await waitForPausedPreview();
    assertPausedPreview(await collectEvidence('unsupportedBrowserBlurred', publisher, viewer), report.published);
    report.unsupportedCodecRejectedAndRetired = true;
    return;
  }
  await until(async () => {
    const value = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    assert.deepEqual(value.errors, []);
    const failed = value.watchStates.find(watch => watch.state === 'unavailable');
    assert.ok(!failed, `The actual receiver rejected Watch: ${failed?.reason}. See persisted SCREEN_SHARE diagnostics.`);
    return value.video?.width === report.published.source.video.width
      && value.video.height === report.published.source.video.height && value.video.frames >= 30;
  }, 'Native frames did not reach the normal Monky stage.', 45000);
  if (encodedByteTrace)
    report.encodedByteTraceArmed = await publisher.child.call('qa-byte-trace-arm');
  if (sourceQualityChanges) {
    await exerciseSourceQualityChanges(publisher, viewer);
    return;
  }
  if (sourceReplacement) {
    phase('measuring-owned-audio-before-direct-replacement');
    await until(() => viewer.cdp.evaluate('nativeAppSmoke.browserAudioReady()'), 'Initial browser screen audio did not start.');
    const initialSignal = await viewer.cdp.evaluate('nativeAppSmoke.browserAudioSignal()');
    assert.ok(initialSignal.nonzeroFrames > 4800 && initialSignal.leftRms > 1e-5 && initialSignal.rightRms > 1e-5);
    const initial = await collectEvidence('sourceReplacementInitial', publisher, viewer);
    const publisherCall = initial.publisherState.mainCall, viewerCall = initial.receiverState.mainCall;
    let current = report.published, currentSource = primarySource;
    const pcmSessions = new Set(), retiredCapturePids = new Set();
    const assertActiveAudio = evidence => {
      assert.equal(evidence.publisherStats.publishers.length, 1);
      const owner = evidence.publisherStats.publishers[0];
      assert.deepEqual(owner.source, current.source);
      assert.equal(owner.source.audio, true);
      assert.equal(owner.viewers, 1);
      assert.equal(owner.pipelines.length, 1);
      const endpoint = owner.pipelines[0].endpoint;
      assert.ok(Number.isSafeInteger(endpoint.capturePid) && endpoint.capturePid > 0);
      assert.ok(endpoint.audioInput?.submitted > 0, 'The selected PCM input never reached native RTC.');
      assert.deepEqual(endpoint.audioInput.errors, []);
      assert.equal(endpoint.audioInput.capture.state, 'capturing');
      assert.equal(endpoint.audioInput.capture.overflowCount, 0);
      assert.equal(pcmSessions.has(endpoint.audioInput.sessionId), false, 'A replacement reused the retired PCM capture session.');
      pcmSessions.add(endpoint.audioInput.sessionId);
      assert.equal(evidence.publisherState.mainCall, publisherCall);
      assert.equal(evidence.receiverState.mainCall, viewerCall);
      assert.equal(evidence.publisherState.channelId, publisher.identity.channelId);
      assert.equal(evidence.receiverState.channelId, viewer.identity.channelId);
      assert.equal(evidence.publisherState.screenAudioShareId, current.source.shareId);
      assert.deepEqual(evidence.publisherState.localScreenShareIds, [current.source.shareId]);
      assert.deepEqual(evidence.receiverState.sources, [current.source]);
      assert.equal(evidence.receiverState.browserWatches, 1);
      assert.deepEqual(evidence.publisherState.errors, []);
      assert.deepEqual(evidence.receiverState.errors, []);
      assert.equal(evidence.publisherState.dialog, null);
      assert.equal(evidence.receiverState.dialog, null);
      assert.ok(evidence.sfuScreenProducers.some(producer => producer.appData.mediaType === 'screen_audio'));
      for (const diagnostics of [evidence.senderDiagnostics, evidence.receiverDiagnostics]) {
        if (diagnostics?.backend === 'native') assert.ok(diagnostics.endpoints.every(endpoint => endpoint.readErrors === 0));
      }
      return endpoint.capturePid;
    };
    let capturePid = assertActiveAudio(initial);
    report.sourceReplacementCycles = [];
    for (const [index, next] of [secondarySource, primarySource, secondarySource, primarySource].entries()) {
      phase(`replacing-owned-audible-source-${index + 1}`);
      const old = current, oldSource = currentSource, oldCapturePid = capturePid;
      const before = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      assert.ok(before.watches.some(([sessionId, shares]) => sessionId === publisher.identity.sessionId
        && shares.includes(old.source.shareId)), 'The old share must still be watched when Replace is pressed.');
      await focusOwned(publisher);
      current = await publisher.cdp.evaluate(`nativeAppSmoke.share(${JSON.stringify(next.ready.hwnd)}, false, true)`);
      currentSource = next;
      assert.notEqual(current.source.shareId, old.source.shareId);
      assert.notEqual(current.source.instanceId, old.source.instanceId);
      assert.equal(current.source.audio, true);
      await until(async () => {
        const local = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
        const remote = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
        return local.publishers.length === 1 && local.publishers[0].source.instanceId === current.source.instanceId
          && remote.sources.length === 1 && remote.sources[0].instanceId === current.source.instanceId
          && remote.watchButton && remote.watchStates.length === 0 && remote.browserWatches === 0;
      }, 'Replace retained the previous exact publisher or spectator instead of requiring a new explicit Watch.');
      await until(() => !processAlive(oldCapturePid), 'Replace retained the previous owned capture host process.');
      retiredCapturePids.add(oldCapturePid);
      const prepared = await collectEvidence(`sourceReplacementPrepared-${index + 1}`, publisher, viewer);
      assert.equal(prepared.publisherStats.publishers[0].viewers, 0);
      assert.ok(prepared.publisherStats.publishers[0].pipelines.every(pipeline => pipeline.endpoint.audioInput === null));
      assert.deepEqual(prepared.sfuScreenProducers, [], 'Retired source media remained published before a new Watch.');
      assert.deepEqual(prepared.publisherState.errors, []);
      assert.deepEqual(prepared.receiverState.errors, []);
      await focusOwned(viewer);
      await viewer.cdp.evaluate('nativeAppSmoke.watch()');
      await until(async () => {
        const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
        return state.video?.frames >= 30 && state.sources[0]?.instanceId === current.source.instanceId
          && await viewer.cdp.evaluate('nativeAppSmoke.browserAudioReady()');
      }, 'The explicitly watched replacement did not produce frames and a real audio route.');
      // The old process is still sounding; the selected new process is silent.
      // This negative control detects a stale INCLUDE target or system-mix leak.
      await delay(1000);
      const unselectedTone = await viewer.cdp.evaluate('nativeAppSmoke.browserAudioSignal()');
      assert.ok(unselectedTone.leftRms < initialSignal.leftRms * 0.05
        && unselectedTone.rightRms < initialSignal.rightRms * 0.05,
      `Replacement still captured the unselected old process: ${JSON.stringify(unselectedTone)}`);
      await sourceCommand('tone-start', {}, next.child);
      await delay(500);
      const selectedTone = await viewer.cdp.evaluate('nativeAppSmoke.browserAudioSignal()');
      assert.ok(selectedTone.nonzeroFrames > 4800 && selectedTone.leftRms > initialSignal.leftRms * 0.5
        && selectedTone.rightRms > initialSignal.rightRms * 0.5,
      `The replacement lost actual selected-process stereo audio: ${JSON.stringify(selectedTone)}`);
      await sourceCommand('tone-stop', {}, oldSource.child);
      const evidence = await collectEvidence(`sourceReplacementPlaying-${index + 1}`, publisher, viewer);
      capturePid = assertActiveAudio(evidence);
      assert.equal(retiredCapturePids.has(capturePid), false);
      report.sourceReplacementCycles.push({ old: old.source, next: current.source, oldPid: oldSource.child.pid,
        nextPid: next.child.pid, oldCapturePid, capturePid, unselectedTone, selectedTone,
        oldExactSourceRetired: true, oldCapturePidClosed: true, explicitWatch: true });
    }
    phase('stopping-final-replacement-through-real-ui');
    await publisher.cdp.evaluate('nativeAppSmoke.stopSharing()');
    await until(async () => {
      const stats = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
      const remote = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      return stats.publishers.length === 0 && remote.sources.length === 0 && remote.watchStates.length === 0
        && remote.browserWatches === 0 && !processAlive(capturePid);
    }, 'The final Stop retained an owned publisher, capture host or spectator.');
    retiredCapturePids.add(capturePid);
    const final = await collectEvidence('sourceReplacementRetired', publisher, viewer);
    assert.equal(final.publisherState.localNativeSources, 0);
    assert.equal(final.publisherState.screenAudioShareId, null);
    assert.equal(final.receiverState.screenOutputContext, null);
    assert.deepEqual(final.sfuScreenProducers, []);
    assert.deepEqual(final.publisherState.errors, []);
    assert.deepEqual(final.receiverState.errors, []);
    assert.equal(final.publisherState.dialog, null);
    assert.equal(final.receiverState.dialog, null);
    report.sourceReplacementResult = { rounds: 2, swaps: 4, pcmSessions: [...pcmSessions],
      retiredCapturePids: [...retiredCapturePids], initialSignal, sourceScopedAudioConfirmed: true,
      wholeMonitorCaptured: false, gameplayCaptured: false };
    return;
  }
  await until(async () => {
    const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
    return state.previewState === 'playing' && state.video?.width === 1920 && state.video.frames >= 15;
  }, 'The publisher did not display its actual libobs preview.');
  report.localPreview = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
  phase('pausing-local-preview-without-interrupting-a-spectator');
  const watchedPipeline = (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines[0];
  await blurPublisher(publisher, viewer);
  await publisher.cdp.evaluate('nativeAppSmoke.setPreviewPauseWhenUnfocused(true)');
  await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).previewState === 'paused',
    'Local preview did not pause while the publisher was blurred with a real spectator.');
  const spectatorBeforeBlur = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).video?.frames >= spectatorBeforeBlur.video.frames + 30,
    'Pausing only local preview stopped the remote spectator.');
  const watchedBlur = await collectEvidence('watchedPublisherBlur', publisher, viewer);
  assert.equal(watchedBlur.publisherFocus.anyFocused, false);
  assert.equal(watchedBlur.publisherState.previewState, 'paused');
  assert.equal(watchedBlur.publisherStats.publishers[0].pipelines.length, 1);
  const retainedDuringBlur = watchedBlur.publisherStats.publishers[0].pipelines[0];
  assert.equal(retainedDuringBlur.pipelineId, watchedPipeline.pipelineId);
  assert.equal(retainedDuringBlur.endpoint.capturePid, watchedPipeline.endpoint.capturePid);
  assert.equal(retainedDuringBlur.viewers, 1);
  assert.equal(retainedDuringBlur.endpoint.demand, 1);
  assert.equal(retainedDuringBlur.endpoint.previewDemand, false);
  assert.equal(watchedBlur.receiverState.watchStates[0].state, 'playing');
  assert.deepEqual(watchedBlur.publisherState.errors, []);
  report.watchedBlurPixels = await previewPixels(publisher, 'paused', 'preview-paused-with-spectator');
  await publisher.cdp.evaluate('nativeAppSmoke.setPreviewPauseWhenUnfocused(false)');
  await waitForLocalPreview();
  assert.equal((await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines[0].pipelineId,
    watchedPipeline.pipelineId, 'Resuming local preview replaced the spectator pipeline.');
  if (windowLifecycle) {
    phase('minimizing-and-restoring-the-selected-window');
    const pipelineId = (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines[0].pipelineId;
    for (let iteration = 0; iteration < 2; iteration++) {
      await sourceCommand('minimize-source');
      await delay(iteration === 0 ? 11000 : 400);
      const paused = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
      assert.equal(paused.publishers[0].pipelines[0].pipelineId, pipelineId);
      assert.deepEqual((await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).errors, []);
      const before = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      assert.ok(before.video, `Minimizing the source lost receiver playback: ${JSON.stringify(before.watchStates)}`);
      await sourceCommand('restore-source');
      await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).video?.frames >= before.video.frames + 20,
        'The original subscription did not resume after restoring the window.');
    }
    report.windowLifecyclePreserved = true;
  }
  const cadenceRead = async name => {
    const evidence = await collectEvidence(name, publisher, viewer);
    const native = await publisher.child.call('qa-native-snapshots');
    report[`${name}Native`] = native;
    await fs.writeFile(path.join(artifacts, `${name}-native.json`), JSON.stringify(native, null, 2) + '\n', { flag: 'wx' });
    const receiverNative = await viewer.child.call('qa-native-snapshots');
    report[`${name}ReceiverNative`] = receiverNative;
    await fs.writeFile(path.join(artifacts, `${name}-receiver-native.json`), JSON.stringify(receiverNative, null, 2) + '\n', { flag: 'wx' });
    return evidence;
  };
  if (gpuTaskTrace) {
    report.gpuTaskTraceCategories = await viewer.cdp.startMediaTrace(videoOverlayCounterfactual
      ? ['gpu', 'media', 'webrtc', 'blink.user_timing'] : [
      'toplevel', 'toplevel.flow', 'gpu', 'disabled-by-default-gpu.debug', 'renderer.scheduler',
      'sequence_manager', 'ipc', 'mojom', 'media', 'webrtc', 'blink.user_timing',
    ]);
    viewer.mediaTraceActive = true;
    await viewer.cdp.evaluate(`performance.mark('qa-${videoOverlayCounterfactual ? 'D' : 'C'}-before-initial-evidence'); undefined`);
  }
  if (warmupSeconds) {
    phase(`warming-owned-presentation-${warmupSeconds}s`);
    await delay(warmupSeconds * 1000);
  }
  const sampleBefore = cadenceDiagnostics ? await cadenceRead('cadenceBefore')
    : await collectEvidence('steadySampleBefore', publisher, viewer);
  if (cadenceDiagnostics) {
    const proof = report.cadenceBeforeNative.find(endpoint => endpoint.role === 'publish')?.capture?.capability;
    assert.equal(proof?.codec, report.published.source.codec);
    assert.ok(['hardware', 'software'].includes(proof?.mode));
    if (report.published.picker.encoding.strategy === 'manual')
      assert.equal(proof.mode, report.published.picker.encoding.savedMode);
    assert.equal(proof?.hardwareSessionConfirmed, proof.mode === 'hardware',
      'The runtime must not report software encoding as a confirmed hardware session.');
    report.resolvedEncoding = { ...report.published.picker.encoding, encoderId: proof.encoderId,
      runtimeMode: proof.mode, runtimeCodec: proof.codec, hardwareSessionConfirmed: proof.hardwareSessionConfirmed };
  }
  if (videoOverlayCounterfactual) report.viewerSystemBefore = await viewerSystemEvidence(viewer);
  const before = sampleBefore.receiverState;
  assert.ok(before.video, `The receiver has no video before the FPS interval: ${JSON.stringify(before.watchStates)}`);
  if (gpuTaskTrace) {
    await viewer.cdp.evaluate(`performance.mark('qa-${videoOverlayCounterfactual ? 'D' : 'C'}-passive-begin'); undefined`);
    report.gpuTaskPassiveBegin = new Date().toISOString();
  }
  await delay(sampleSeconds * 1000);
  if (gpuTaskTrace) {
    report.gpuTaskPassiveEnd = new Date().toISOString();
    await viewer.cdp.evaluate(`performance.mark('qa-${videoOverlayCounterfactual ? 'D' : 'C'}-passive-end'); undefined`);
  }
  const after = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  assert.ok(after.video, `The receiver lost video during the FPS interval: ${JSON.stringify(after.watchStates)}`);
  report.stage = { ...after, fps: (after.video.frames - before.video.frames) * 1000 / (after.video.at - before.video.at) };
  report.stageBefore = before;
  if (videoOverlayCounterfactual) report.viewerSystemAfter = await viewerSystemEvidence(viewer);
  const sourceRate = await collectEvidence('sourceRateBeforeAssertion', publisher, viewer);
  report.publishing = sourceRate.publisherStats;
  report.receiving = sourceRate.receiverStats;
  report.senderDiagnostics = sourceRate.senderDiagnostics;
  report.receiverDiagnostics = sourceRate.receiverDiagnostics;
  if (fullHd60) report.explicit1080p60 = { initial: verifyExplicit1080p60(sourceRate) };
  if (cadenceDiagnostics) await cadenceRead('cadenceAfter');
  if (report.stage.fps < minimumPresentationFps) {
    cadenceFailures.push(new Error(`Normal-app presentation reached ${report.stage.fps.toFixed(2)} FPS; minimum is ${minimumPresentationFps}.`));
    report.cadenceFailures = cadenceFailures.map(error => error.message);
  }
  if (gpuTaskTrace) {
    await viewer.cdp.evaluate(`performance.mark('qa-${videoOverlayCounterfactual ? 'D' : 'C'}-after-final-evidence'); undefined`);
    viewer.mediaTraceActive = false;
    report.chromiumMediaTrace = await viewer.cdp.stopMediaTrace(path.join(artifacts, 'viewer-media-trace.json'));
  }
  assert.equal(sourceRate.publisherState.previewPauseWhenUnfocused, false);
  assert.ok(sourceRate.receiverState.captureModes.some(value => value.mode === 'normal' && value.tileKey === publishedTileKey),
    'The spectator did not display the actual capture method for the selected source.');
  if (cadenceFollowup) {
    phase('measuring-bounded-stabilization-and-separate-20s-cadence');
    const points = [];
    const readPoint = async () => {
      const [native, state, browser] = await Promise.all([
        publisher.child.call('qa-native-snapshots'),
        viewer.cdp.evaluate('nativeAppSmoke.snapshot()'),
        viewer.cdp.evaluate('nativeAppSmoke.browserStats()'),
      ]);
      assert.equal(native.length, 1);
      assert.equal(native[0].pipelineId, sourceRate.publisherStats.publishers[0].pipelines[0].pipelineId);
      assert.deepEqual(state.errors, []);
      assert.ok(state.video?.width === 1920 && state.video.height === 1080);
      const rtp = browser.flatMap(entry => entry.reports)
        .find(entry => entry.type === 'inbound-rtp' && (entry.kind ?? entry.mediaType) === 'video');
      assert.ok(rtp);
      const point = { at: new Date().toISOString(), native: native[0], video: state.video, rtp };
      points.push(point);
      return point;
    };
    const followup = report.cadenceFollowupResult = { points,
      gate: 'Three consecutive >=50 received/encoded AU per second intervals, with no new PLI/IDR wait',
      maximumGateSeconds: 15, stabilized: false, baselinePreserved: true };
    let previous = await readPoint(), stableIntervals = 0;
    for (let index = 0; index < 15; index++) {
      await delay(1000);
      const current = await readPoint();
      const seconds = (current.rtp.timestamp - previous.rtp.timestamp) / 1000;
      const encodedSeconds = Number(BigInt(current.native.capture.native.qpc)
        - BigInt(previous.native.capture.native.qpc)) / Number(current.native.capture.native.qpcFrequency);
      const stable = seconds > 0 && encodedSeconds > 0
        && (current.rtp.framesReceived - previous.rtp.framesReceived) / seconds >= 50
        && (current.native.flow.observed - previous.native.flow.observed) / encodedSeconds >= 50
        && current.native.flow.awaitingIdr === previous.native.flow.awaitingIdr
        && current.rtp.pliCount === previous.rtp.pliCount;
      stableIntervals = stable ? stableIntervals + 1 : 0;
      previous = current;
      if (stableIntervals === 3) { followup.stabilized = true; break; }
    }
    followup.measurementStartIndex = points.length - 1;
    const start = previous;
    for (let index = 0; index < 20; index++) { await delay(1000); previous = await readPoint(); }
    followup.measurementEndIndex = points.length - 1;
    followup.seconds = (previous.video.at - start.video.at) / 1000;
    followup.fps = (previous.video.frames - start.video.frames) / followup.seconds;
    followup.thresholdPassed = followup.fps >= minimumPresentationFps;
    await fs.writeFile(path.join(artifacts, 'cadence-followup.json'), JSON.stringify(followup, null, 2) + '\n', { flag: 'wx' });
    if (!followup.thresholdPassed)
      cadenceFailures.push(new Error(`Separate follow-up presentation reached ${followup.fps.toFixed(2)} FPS; minimum is ${minimumPresentationFps}.`));
  }
  if (encodedByteTrace) {
    report.encodedByteTraceSaved = await publisher.child.call('qa-byte-trace-save');
    viewer.mediaTraceActive = false;
    report.chromiumMediaTrace = await viewer.cdp.stopMediaTrace(path.join(artifacts, 'viewer-media-trace.json'));
  }
  if (closeAppActive && !fullHd60) {
    await closeActiveWindow(publisher, viewer, sourceRate.publisherStats);
    return;
  }
  report.localCompositorPixels = await previewPixels(publisher, 'playing', 'preview-playing');
  const observedTelemetry = async (client, width, height) => {
    let telemetry;
    await until(async () => {
      telemetry = (await client.cdp.evaluate('nativeAppSmoke.telemetry()'))
        .find(value => !value.hidden && value.text.includes(`RTP resolution: ${width}x${height}`)
          && /\bBitrate: [1-9][0-9]* kbps/.test(value.text));
      return !!telemetry;
    }, `Actual ${client.label} telemetry did not report observed ${width}x${height} RTP.`);
    assert.doesNotMatch(telemetry.text, /Failed to read|Statistics read failures/);
    return telemetry;
  };
  report.senderTelemetry = await observedTelemetry(publisher, 1920, 1080);
  report.receiverTelemetry = await observedTelemetry(viewer, 1920, 1080);
  for (const diagnostics of [report.senderDiagnostics, report.receiverDiagnostics])
    if (diagnostics.backend === 'native') assert.ok(diagnostics.endpoints.every(endpoint => endpoint.readErrors === 0));
  report.scaledPixels = await viewer.cdp.evaluate('nativeAppSmoke.pixels()');
  const assertScaling = pixels => {
    for (const color of [pixels.left, pixels.right]) {
      if (preserveAspectRatio) assert.ok(color.slice(0, 3).every(value => value < 24),
        'The fitted 4:3 source did not retain black side borders.');
      else assert.ok(color[0] > 180 && color[1] < 80 && color[2] > 180,
        'The 4:3 source was letterboxed instead of stretched to its output.');
    }
    const side = preserveAspectRatio ? (pixels.width - pixels.height * 4 / 3) / 2 : 0;
    assert.notEqual(pixels.firstContentX, null);
    assert.notEqual(pixels.lastContentX, null);
    assert.ok(Math.abs(pixels.firstContentX - side) <= 4 &&
      Math.abs(pixels.lastContentX - (pixels.width - side - 1)) <= 4,
    `Encoded content bounds did not preserve the selected geometry: ${JSON.stringify(pixels)}`);
    assert.ok(pixels.top[0] > 180 && pixels.top[1] < 80 && pixels.top[2] < 80);
    assert.ok(pixels.bottom[0] < 80 && pixels.bottom[1] < 80 && pixels.bottom[2] > 180);
    assert.ok(pixels.center.slice(0, 3).every(channel => channel > 180));
  };
  assertScaling(report.scaledPixels);
  report.localDecodedPixels = await publisher.cdp.evaluate('nativeAppSmoke.pixels()');
  assertScaling(report.localDecodedPixels);
  if (!browserReceiver) {
    const reports = report.receiverDiagnostics.endpoints.flatMap(endpoint => endpoint.rtp.flatMap(entry => entry.reports));
    const video = reports.find(row => row.type === 'inbound-rtp' && (row.kind ?? row.mediaType) === 'video');
    const codec = reports.find(row => row.type === 'codec' && row.id === video?.codecId);
    assert.equal(codec?.mimeType?.toLowerCase(), `video/${report.published.source.codec ?? 'h264'}`);
    assert.ok(video.framesDecoded > 0);
    if (report.published.source.codec === 'av1') {
      assert.equal(video.decoderImplementation, 'dav1d');
      assert.doesNotMatch(report.receiverTelemetry.text, /Native decoder FPS \(MF\): [0-9]/);
      assert.ok(report.receiverDiagnostics.endpoints.every(endpoint => endpoint.decoders.length === 0),
        'Software AV1 decoding must not fabricate Media Foundation hardware decoder observations.');
    } else {
      assert.match(report.receiverTelemetry.text, /Native decoder FPS \(MF\): [1-9][0-9]*/);
      assert.ok(report.receiverDiagnostics.endpoints.some(endpoint => endpoint.decoders.length));
    }
    report.nativeDecoder = { codec: report.published.source.codec ?? 'h264', implementation: video.decoderImplementation,
      framesDecoded: video.framesDecoded, mfObservations: report.receiverDiagnostics.endpoints.reduce((count, endpoint) => count + endpoint.decoders.length, 0) };
  }
  if (incompatibleViewer) {
    phase('isolating-an-incompatible-second-viewer');
    const incompatible = clients.find(client => client.label === 'incompatible');
    const pipeline = (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines[0];
    const before = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    await incompatible.cdp.evaluate('nativeAppSmoke.watch()');
    await until(async () => (await incompatible.cdp.evaluate('nativeAppSmoke.snapshot()')).watchStates
      .some(state => state.state === 'unavailable' && state.reason === 'unsupported'),
    'The second viewer did not report its incompatible decoder.');
    await until(async () => {
      const stats = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
      return stats.publishers[0].pipelines.length === 1 && stats.publishers[0].pipelines[0].viewers === 1
        && (await incompatible.cdp.evaluate('nativeAppSmoke.snapshot()')).browserWatches === 0;
    }, 'The incompatible viewer retained or retired a shared pipeline.');
    await delay(1500);
    const after = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    const fps = (after.video.frames - before.video.frames) * 1000 / (after.video.at - before.video.at);
    report.incompatibleViewerIsolation = { fps, before, after,
      incompatible: await incompatible.cdp.evaluate('nativeAppSmoke.snapshot()') };
    const isolated = await collectEvidence('incompatibleRateBeforeAssertion', publisher, viewer);
    const retained = isolated.publisherStats.publishers[0].pipelines[0];
    assert.equal(retained.pipelineId, pipeline.pipelineId);
    assert.equal(retained.endpoint.capturePid, pipeline.endpoint.capturePid, 'An incompatible viewer restarted the shared capture.');
    assert.equal(after.watchStates[0].state, 'playing');
    assert.ok(fps >= minimum120Fps, `A rejected viewer interrupted compatible playback (${fps.toFixed(2)} FPS).`);
    assert.deepEqual(isolated.publisherState.errors, [], 'A viewer-only rejection was reported as a source failure.');
    Object.assign(report.incompatibleViewerIsolation, { pipelinePreserved: true, capturePreserved: true });
  }
  if (audioEnabled) {
    if (browserReceiver) {
      assert.equal(report.receiving.subscriptions.length, 0, 'Browser compatibility must not create a native receiver engine.');
      report.browserReceiving = await viewer.cdp.evaluate('nativeAppSmoke.browserStats()');
      assert.equal(report.browserReceiving.length, 1);
      await until(() => viewer.cdp.evaluate('nativeAppSmoke.browserAudioReady()'), 'The real browser audio graph did not start.');
    } else {
      assert.equal(report.receiving.subscriptions[0].endpoint.audioOutput.ready, true, 'Normal preload AudioWorklet did not start.');
      assert.ok(report.receiving.subscriptions[0].endpoint.audioOutput.pcmSignal.nonzeroFrames > 4800);
    }

    phase('controlling-real-audio');
    const signal = async () => {
      if (browserReceiver) return viewer.cdp.evaluate('nativeAppSmoke.browserAudioSignal()');
      const before = (await viewer.cdp.evaluate('nativeAppSmoke.stats()')).subscriptions[0].endpoint.audioOutput.pcmSignal;
      await delay(700);
      const after = (await viewer.cdp.evaluate('nativeAppSmoke.stats()')).subscriptions[0].endpoint.audioOutput.pcmSignal;
      const frames = after.frames - before.frames;
      assert.ok(frames > 4800);
      return { frames, nonzeroFrames: after.nonzeroFrames - before.nonzeroFrames,
        leftRms: Math.sqrt((after.leftSquareSum - before.leftSquareSum) / frames),
        rightRms: Math.sqrt((after.rightSquareSum - before.rightSquareSum) / frames) };
    };
    const normal = await signal();
    assert.ok(normal.leftRms > 0 && normal.rightRms > 0 && normal.nonzeroFrames > 4800, 'Screen playback did not deliver real stereo samples.');
    await viewer.cdp.evaluate('nativeAppSmoke.volume(50)');
    await delay(500);
    const half = await signal();
    assert.ok(half.leftRms / normal.leftRms > 0.4 && half.leftRms / normal.leftRms < 0.6);
    await viewer.cdp.evaluate('nativeAppSmoke.mute()');
    await delay(500);
    const muted = await signal();
    assert.equal(muted.nonzeroFrames, 0, 'The real mute control did not silence received PCM.');
    await viewer.cdp.evaluate('nativeAppSmoke.mute(); nativeAppSmoke.volume(100); nativeAppSmoke.deafen()');
    await delay(500);
    const deafened = await signal();
    assert.equal(deafened.nonzeroFrames, 0, 'Deafen did not silence native screen audio.');
    await viewer.cdp.evaluate('nativeAppSmoke.deafen()');
    await delay(500);
    const resumed = await signal();
    assert.ok(resumed.nonzeroFrames > 4800);
    report.audioControls = { normal, half, muted, deafened, resumed };
  }

  const overlaySnapshot = `(() => {
    const videos = [...document.querySelectorAll('.overlay-card.has-video:not(.leaving) video')];
    return videos.filter(video => video.videoWidth && video.readyState >= 2).map(video => ({
      width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames,
      state: video.srcObject?.getVideoTracks()[0]?.readyState, paused: video.paused,
      captureMode: video.closest('.overlay-card')?.querySelector('[data-capture-mode]')?.dataset.captureMode ?? null
    }));
  })()`;
  if (overlayEnabled) {
    phase('opening-the-real-overlay');
    await viewer.cdp.evaluate('nativeAppSmoke.openOverlay()');
    await until(async () => {
      const state = (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).overlay;
      return state.open && state.connection === 'connected' && state.carryingScreen;
    }, 'The actual overlay did not attach the screen track to its connected local transport.');
    viewer.overlayCdp = await connectCdp(viewer.debugPort, origin, viewer.runId, viewer.diagnostics, viewer.cdp);
    await until(async () => (await viewer.overlayCdp.evaluate(overlaySnapshot)).some(video => video.frames >= 5),
      'The real overlay did not receive decoded video.');
    report.overlayBefore = await viewer.overlayCdp.evaluate(overlaySnapshot);
    assert.ok(report.overlayBefore.every(video => video.captureMode === 'normal'));
  }

  if (sourceResize) {
    phase('resizing-the-owned-source-with-an-active-spectator');
    report.sourceResizes = [];
    for (const [width, height] of [[640, 480], [1280, 720], [800, 600]]) {
      const before = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      await sourceCommand('resize-source', { width, height });
      await until(async () => {
        const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
        const local = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
        assert.equal(local.dialog, null);
        assert.deepEqual(local.errors, []);
        assert.equal(state.sources[0]?.instanceId, report.published.source.instanceId);
        return state.video?.width === 1920 && state.video.height === 1080
          && state.video.frames >= before.video.frames + 30;
      }, 'Source resize interrupted the selected window, source identity or decoded output.');
      report.sourceResizes.push({ width, height,
        receiver: await viewer.cdp.evaluate('nativeAppSmoke.snapshot()') });
    }
  }

  phase('entering-fullscreen');
  await viewer.cdp.evaluate('nativeAppSmoke.fullscreen()');
  await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).fullscreen, 'Normal fullscreen did not open.');
  phase('changing-real-quality');
  const reducedProfile = protocolContracts.getScreenShareProfile(report.published.source.video, '480p30', report.published.source.codec);
  await viewer.cdp.evaluate('nativeAppSmoke.quality("480p30")');
  await until(async () => {
    const value = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    return value.video?.width === reducedProfile.width && value.video.height === reducedProfile.height && value.video.frames >= 15;
  }, 'The normal quality control did not change actual decoded dimensions.');
  report.reduced = await viewer.cdp.evaluate('nativeAppSmoke.stats()');
  await until(async () => {
    const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
    return state.previewState === 'playing' && state.video?.width === reducedProfile.width && state.video.height === reducedProfile.height;
  }, 'The local preview did not follow the actual active rendition.');
  const reducedBefore = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  await delay(2500);
  const reducedAfter = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  report.reducedSnapshots = { before: reducedBefore, after: reducedAfter };
  report.reducedFps = (reducedAfter.video.frames - reducedBefore.video.frames) * 1000 / (reducedAfter.video.at - reducedBefore.video.at);
  const reducedRate = await collectEvidence('reducedRateBeforeAssertion', publisher, viewer);
  report.reduced = reducedRate.receiverStats;
  report.reducedPublisher = reducedRate.publisherStats;
  report.reducedSenderDiagnostics = reducedRate.senderDiagnostics;
  report.reducedReceiverDiagnostics = reducedRate.receiverDiagnostics;
  assert.equal(reducedRate.publisherState.previewPauseWhenUnfocused, false);
  assert.deepEqual(reducedRate.publisherState.focusedTiles, [], 'A rendition change re-focused the local preview.');
  assert.ok(reducedRate.receiverState.captureModes.some(value => value.mode === 'normal' && value.tileKey === publishedTileKey));
  assert.equal(reducedRate.publisherState.captureFallbacks.length, gameFallback ? 1 : 0);
  assert.equal(reducedRate.publisherState.fallbackToasts.length, gameFallback ? 1 : 0);
  if (browserReceiver) {
    report.browserReduced = reducedRate.browserStats;
    assert.equal(report.reducedPublisher.publishers[0].pipelines[0].endpoint.profile.fps, 30);
  } else assert.equal(report.reduced.subscriptions[0].endpoint.profile.fps, 30);
  assert.ok(report.reducedFps >= 25 && report.reducedFps <= 35, 'Quality did not change actual presentation cadence.');
  assert.equal(reducedAfter.fullscreen, true, 'A quality change destroyed the fullscreen card.');
  report.reducedSenderTelemetry = await observedTelemetry(publisher, reducedProfile.width, reducedProfile.height);
  report.reducedReceiverTelemetry = await observedTelemetry(viewer, reducedProfile.width, reducedProfile.height);
  report.reducedScaledPixels = await viewer.cdp.evaluate('nativeAppSmoke.pixels()');
  assertScaling(report.reducedScaledPixels);
  report.reducedLocalDecodedPixels = await publisher.cdp.evaluate('nativeAppSmoke.pixels()');
  assertScaling(report.reducedLocalDecodedPixels);
  report.reducedLocalPixels = await previewPixels(publisher, 'playing', 'preview-reduced');
  const reducedBitrate = Number(report.reducedSenderTelemetry.text.match(/\bBitrate: ([0-9]+) kbps/)[1]);
  assert.ok(reducedBitrate <= 1875, `480p RTP exceeded its 1500 Kbps ceiling plus packet/burst allowance: ${reducedBitrate} Kbps.`);
  if (overlayEnabled) {
    await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).overlay.carryingScreen,
      'The overlay retained the retired quality instead of the new screen track.');
    report.overlayReduced = await viewer.overlayCdp.evaluate(overlaySnapshot);
    assert.ok(report.overlayReduced.some(video => video.state === 'live' && !video.paused));
  }

  phase('stopping-through-normal-ui');
  await viewer.cdp.evaluate('nativeAppSmoke.stopWatching()');
  await until(async () => {
    const stats = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
    return stats.publishers[0].viewers === 0 && stats.publishers[0].pipelines.length === 1
      && stats.publishers[0].pipelines[0].endpoint.audioInput === null;
  }, 'The last Stop did not retire remote publication/PCM and return to local-only preview.');
  await waitForLocalPreview();
  await until(async () => {
    const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    return state.video === null && state.browserWatches === 0;
  }, 'Stop retained the receiver video or browser watch.');
  const localAfterStop = await collectEvidence('lastStopLocalPreview', publisher, viewer);
  assert.equal(localAfterStop.publisherState.previewPauseWhenUnfocused, false);
  assertLocalOnlyPreview(localAfterStop, report.published);
  assert.equal((await viewer.cdp.evaluate('nativeAppSmoke.stats()')).subscriptions.length, 0);
  assert.equal((await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).browserWatches, 0);
  report.stoppedPreviewPixels = await previewPixels(publisher, 'playing', 'preview-local-after-stop');
  if (browserReceiver) {
    const retired = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    assert.equal(retired.screenOutputContext, null);
    if (audioEnabled) assert.equal(retired.measuredScreenContext, 'closed', 'Stop retained the actual browser output context.');
  }
  if (overlayEnabled) {
    await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).overlay.onlyDummy
      && (await viewer.overlayCdp.evaluate(overlaySnapshot)).length === 0, 'The overlay retained a stopped native screen.');
    report.overlayRetiredWhileOpen = true;
  }
  phase('retiring-unwatched-preview-with-default-blur-policy');
  await blurPublisher(publisher, viewer);
  await publisher.cdp.evaluate('nativeAppSmoke.setPreviewPauseWhenUnfocused(true)');
  await waitForPausedPreview();
  assertPausedPreview(await collectEvidence('lastStopBlurredPreview', publisher, viewer), report.published);
  report.stoppedBlurredPixels = await previewPixels(publisher, 'paused', 'preview-paused-after-stop');
  phase('rewatching');
  await viewer.cdp.evaluate('nativeAppSmoke.watch()');
  await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).video?.frames >= 15,
    'A second normal Watch did not resume playback.');
  const rewatched = await collectEvidence('rewatchedWithLocalPreviewPaused', publisher, viewer);
  assert.equal(rewatched.publisherState.previewPauseWhenUnfocused, true);
  assert.equal(rewatched.publisherState.previewState, 'paused');
  assert.equal(rewatched.publisherFocus.anyFocused, false);
  assert.equal(rewatched.publisherStats.publishers[0].pipelines.length, 1);
  assert.equal(rewatched.publisherStats.publishers[0].pipelines[0].viewers, 1);
  assert.equal(rewatched.publisherStats.publishers[0].pipelines[0].endpoint.previewDemand, false);
  if (overlayEnabled) {
    await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).overlay.carryingScreen
      && (await viewer.overlayCdp.evaluate(overlaySnapshot)).some(video => video.state === 'live'),
    'The existing overlay did not attach the second Watch.');
    phase('closing-overlay-without-ending-playback');
    await viewer.cdp.evaluate('nativeAppSmoke.closeOverlay()');
    const closed = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    assert.equal(closed.overlay.open, false);
    assert.equal(closed.overlay.connection, null);
    assert.equal(closed.overlay.measuredDummy, 'ended', 'Closing overlay retained its own generated dummy capture.');
    assert.equal(closed.watchStates[0].state, 'playing');
    await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).video?.frames >= closed.video.frames + 15,
      'Closing the overlay also interrupted the original stage playback.');
    report.overlayClosedWithStagePlaying = true;
  }

  if (sessionNavigation) {
    phase('browsing-a-different-real-server');
    const otherPort = await freePort(), otherPassword = randomBytes(24).toString('hex');
    otherServer = await MonkyServer.create({ port: otherPort, dataDir: path.join(artifacts, 'other-server'),
      serverName: 'Owned foreground server QA', password: otherPassword, voiceMode: 'p2p' });
    let misplacedSignals = 0;
    const signal = otherServer.wsServer.handleNativeScreenSignal;
    otherServer.wsServer.handleNativeScreenSignal = function (...args) {
      misplacedSignals++;
      return Reflect.apply(signal, this, args);
    };
    await startLoopbackServer(otherServer, otherPort);
    const previous = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    await viewer.cdp.evaluate(`nativeAppSmoke.browseServer(${otherPort}, ${JSON.stringify(otherPassword)})`);
    const away = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    assert.notEqual(away.visibleSession, previous.visibleSession);
    assert.equal(away.voiceSession, previous.voiceSession);
    assert.equal(away.mainCall, previous.mainCall);
    await viewer.cdp.evaluate('nativeAppSmoke.backgroundQuality("source")');
    await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines
      .some(pipeline => pipeline.quality === 'source' && pipeline.viewers === 1),
    'A quality change while browsing another server did not reach the original publisher.');
    await viewer.cdp.evaluate('nativeAppSmoke.restoreCallView()');
    await until(async () => {
      const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      return state.video?.width === 1920 && state.video.height === 1080 && state.video.frames >= 15;
    }, 'The original call did not resume visible playback at the quality selected in the background.');
    assert.equal(misplacedSignals, 0, 'Screen signaling escaped to the foreground server.');
    report.backgroundCallPreserved = true;
  }

  if (publisherStop) {
    report.publisherStopCycles = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      phase(`publisher-stop-while-watched-${cycle + 1}`);
      const before = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
      await publisher.cdp.evaluate('nativeAppSmoke.stopSharing()');
      await until(async () => {
        const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
        assert.equal(state.dialog, null, 'Stopping a watched source must not raise a retirement alert.');
        assert.deepEqual(state.errors, [], 'Publisher Stop must not emit native failure notifications.');
        const stats = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
        return state.localNativeSources === 0 && stats.publishers.length === 0;
      }, 'Publisher Stop retained its native source or audio reservation.');
      await until(async () => {
        const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
        return state.sources.length === 0 && state.watchStates.length === 0;
      }, 'Publisher Stop did not retire the actual spectator subscription.');
      await focusOwned(publisher);
      const restarted = await publisher.cdp.evaluate(`nativeAppSmoke.share(${JSON.stringify(sourceReady.hwnd)})`);
      assert.equal(restarted.source.audio, audioEnabled);
      assert.equal((await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).mainCall, before.mainCall);
      await waitForLocalPreview();
      await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).watchButton,
        'Restarting the same source did not restore the spectator Watch control.');
      await viewer.cdp.evaluate('nativeAppSmoke.watch()');
      await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).video?.frames >= 15,
        'The spectator did not receive the restarted source.');
      report.publisherStopCycles.push(await collectEvidence(`publisherRestart-${cycle + 1}`, publisher, viewer));
    }
  }

  if (serverLoss) {
    phase('losing-the-owned-voice-server');
    await server.stop();
    server = null;
    for (const client of [publisher, viewer]) {
      await until(async () => {
        const state = await client.cdp.evaluate('nativeAppSmoke.snapshot()');
        return state.mainCall === null && state.localNativeSources === 0 && state.watchStates.length === 0;
      }, `Server loss retained ${client.label} native media owners.`);
    }
    report.serverLossRetiredMedia = true;
    return;
  }

  if (closeAppActive && fullHd60) {
    phase('restoring-explicit-1080p60-before-active-close');
    await viewer.cdp.evaluate('nativeAppSmoke.quality("source")');
    await until(async () => {
      const state = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
      return state.video?.width === 1920 && state.video.height === 1080 && state.video.frames >= 15;
    }, 'The full source controls did not restore actual 1080p60 playback before app close.');
    const active = await collectEvidence('explicit1080p60ActiveBeforeClose', publisher, viewer);
    report.explicit1080p60.restored = verifyExplicit1080p60(active);
    assert.deepEqual(active.publisherState.errors, []);
    assert.deepEqual(active.receiverState.errors, []);
    assert.equal(active.publisherState.dialog, null);
    assert.equal(active.receiverState.dialog, null);
    if (browserReceiver && audioEnabled) {
      await until(() => viewer.cdp.evaluate('nativeAppSmoke.browserAudioReady()'), 'Restored source audio did not start.');
      const signal = await viewer.cdp.evaluate('nativeAppSmoke.browserAudioSignal()');
      assert.ok(signal.nonzeroFrames > 4800 && signal.leftRms > 0 && signal.rightRms > 0);
      report.explicit1080p60.restoredAudio = signal;
    }
    await closeActiveWindow(publisher, viewer, active.publisherStats);
    return;
  }
  phase('closing-the-owned-shared-window');
  const sourceCloseBefore = observeSourceClosure ? await collectEvidence('ownedSourceCloseBefore', publisher, viewer) : null;
  let closure;
  if (sourceCloseBefore) {
    const owners = sourceCloseBefore.publisherStats.publishers;
    assert.equal(owners.length, 1);
    assert.deepEqual(sourceCloseBefore.publisherState.errors, []);
    assert.deepEqual(sourceCloseBefore.publisherState.nativeErrorEvents, []);
    assert.deepEqual(sourceCloseBefore.publisherState.sourceStoppingToasts, []);
    const diagnosticId = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
    closure = report.expectedOwnedSourceClose = { startedAt: new Date().toISOString(),
      command: 'close-source', hwnd: sourceReady.hwnd, sourcePid: source.pid, source: owners[0].source,
      diagnosticSource: diagnosticId(owners[0].source.shareId),
      diagnosticCall: diagnosticId(sourceCloseBefore.publisherState.mainCall),
      diagnosticPipelines: owners[0].pipelines.map(value => diagnosticId(value.pipelineId)),
      pipelines: owners[0].pipelines.map(value => ({ pipelineId: value.pipelineId, capturePid: value.endpoint.capturePid })),
      verified: false };
  }
  const id = randomUUID(), response = once(source, 'message');
  if (closure) closure.commandId = id;
  source.send({ type: 'source-command', id, command: 'close-source' });
  const [closed] = await within(response, 10000, 'Owned source did not close.');
  assert.equal(closed.id, id); assert.equal(closed.ok, true);
  await until(async () => !(await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).sources.length,
    'Closing the shared window did not remove its real advertisement.');
  await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers.length === 0,
    'Closing the source retained its publisher owner.');
  if (closure) {
    await until(async () => {
      const snapshots = await publisher.child.call('qa-native-retired');
      const retired = closure.pipelines.map(pipeline => snapshots.find(endpoint => endpoint.pipelineId === pipeline.pipelineId
        && endpoint.source.instanceId === closure.source.instanceId && endpoint.source.shareId === closure.source.shareId));
      if (retired.some(endpoint => !endpoint?.localRetirementProven)) return false;
      closure.retiredEndpoints = retired;
      for (const [index, endpoint] of retired.entries()) {
        const capture = endpoint.captureRetirement;
        assert.equal(capture.nativeClosed, true);
        assert.equal(capture.closed, true);
        assert.equal(capture.forcedTermination, false);
        if (capture.failure) {
          assert.equal(capture.failure.error.code, 'ERR_SCREEN_CAPTURE_SOURCE_LOST');
          assert.equal(capture.failure.hwnd, closure.hwnd);
          assert.equal(capture.failure.processId, closure.sourcePid);
        }
        assert.deepEqual(capture.exit, { code: capture.failure ? 1 : 0, signal: null });
        assert.deepEqual(capture.processExit, capture.exit);
        assert.deepEqual(capture.outputEof, { stdout: true, stderr: true });
        assert.equal(capture.live.eof, true);
        assert.equal(capture.helperProcessId, closure.pipelines[index].capturePid);
        assert.equal(processAlive(capture.helperProcessId), false);
      }
      return true;
    }, 'The exact closed source did not prove native retirement and original capture-host exit.');
    await until(async () => {
      const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
      assert.equal(state.dialog, null, 'Closing the source may show its documented toast, never a modal.');
      return state.sourceStoppingToasts.length === 1 && state.sourceStoppingToasts[0].visible;
    }, 'The source-close notification was not a single visible documented toast.');
    const after = await collectEvidence('ownedSourceCloseAfter', publisher, viewer);
    assert.equal(after.publisherState.errors.length, 1);
    assert.equal(after.publisherState.errors[0].reason, 'source-unavailable');
    assert.equal(after.publisherState.errors[0].shareId, closure.source.shareId);
    assert.equal(after.publisherState.nativeErrorEvents.length, 1);
    closure.nativeError = after.publisherState.nativeErrorEvents[0];
    assert.equal(createHash('sha256').update(closure.nativeError.callId).digest('hex').slice(0, 16), closure.diagnosticCall);
    assert.equal(closure.nativeError.shareId, closure.source.shareId);
    assert.equal(closure.nativeError.sourceInstanceId, closure.source.instanceId);
    assert.equal(closure.nativeError.reason, 'source-unavailable');
    assert.ok(closure.nativeError.observedAt >= closure.startedAt);
    assert.equal(after.publisherState.dialog, null);
    assert.equal(after.receiverState.dialog, null);
    assert.deepEqual(after.receiverState.errors, []);
    assert.deepEqual(after.receiverState.sources, []);
    assert.deepEqual(after.publisherStats.publishers, []);
    assert.deepEqual(after.receiverStats.subscriptions, []);
    assert.equal(after.receiverState.browserWatches, 0);
    assert.deepEqual(after.sfuScreenProducers, []);
    closure.finishedAt = new Date().toISOString();
    closure.verified = true;
  }
}

const deadline = setTimeout(() => { failures.push(new Error('Native app smoke exceeded its global deadline.')); }, 240000);
void run().catch(error => { failures.push(error); console.error(error); }).finally(async () => {
  failures.push(...cadenceFailures);
  phase('closing-owned-applications');
  for (const client of [...clients].reverse()) {
    if (client.mediaTraceActive && !client.child.isClosed()) {
      try {
        client.mediaTraceActive = false;
        report.chromiumMediaTrace = await client.cdp.stopMediaTrace(path.join(artifacts, 'viewer-media-trace.json'));
      } catch (error) { failures.push(error); console.error(error); }
    }
    if (encodedByteTrace && client.label === 'publisher' && report.encodedByteTraceArmed
      && !report.encodedByteTraceSaved && !client.child.isClosed()) {
      try { report.encodedByteTraceSaved = await client.child.call('qa-byte-trace-save'); }
      catch (error) { failures.push(error); console.error(error); }
    }
    report[`${client.label}Diagnostics`] = client.diagnostics;
    if (strictMediaErrors) {
      const errors = client.diagnostics.filter(entry => entry.type === 'error' || typeof entry.exceptionId === 'number');
      report[`${client.label}RendererErrors`] = errors;
      if (errors.length) failures.push(new Error(`${client.label} reported ${errors.length} renderer errors during live quality changes.`));
    }
    if (client.cdp && !client.child.isClosed()) {
      try {
        report[`${client.label}Final`] = await client.cdp.evaluate('window.nativeAppSmoke?.snapshot()');
        report[`${client.label}FinalStats`] = await client.cdp.evaluate('window.nativeAppSmoke?.stats()');
      } catch (error) { failures.push(error); console.error(error); }
    }
    try {
      const logs = path.join(client.profile, 'client-logs');
      for (const file of await fs.readdir(logs)) {
        if (!file.endsWith('.jsonl')) continue;
        const destination = path.join(artifacts, `${client.label}-${file}`);
        await fs.copyFile(path.join(logs, file), destination);
        if (sourceReplacement || strictMediaErrors) {
          const errors = (await fs.readFile(destination, 'utf8')).split(/\r?\n/).filter(Boolean)
            .map(line => JSON.parse(line)).filter(entry => entry.category === 'SCREEN_SHARE' && entry.level === 'ERROR');
          (report[`${client.label}ScreenErrors`] ??= []).push(...errors);
          const rejection = report.sourceQualityChanges.unsupported4k120;
          const expected = errors.filter(entry => fourK60 && client.label === 'publisher' && rejection?.preservationVerified
            && entry.timestamp >= rejection.startedAt && entry.timestamp <= rejection.finishedAt
            && ((['Native screen preflight failed', 'Native screen source-admission failed'].includes(entry.message)
              && entry.data?.stage === 'preflight'
              && entry.data?.nativeCodes?.length === 1
              && entry.data.nativeCodes[0] === 'ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED'
              && entry.data.video?.width === 3840 && entry.data.video?.fps === 120)
              || (entry.message === 'Native screen operation failed' && entry.data?.error === rejection.error)));
          (report[`${client.label}ExpectedPreflightErrors`] ??= []).push(...expected);
          const sourceCloseExpected = report[`${client.label}ExpectedSourceCloseErrors`] ??= [];
          const sourceClose = [];
          for (const entry of errors) {
            const kind = expectedSourceCloseLog(entry, client.label, report.expectedOwnedSourceClose);
            if (kind && !sourceCloseExpected.some(value => value.kind === kind)) {
              sourceCloseExpected.push({ kind, entry });
              sourceClose.push(entry);
            }
          }
          const unexpected = errors.filter(entry => !expected.includes(entry) && !sourceClose.includes(entry));
          if (unexpected.length) failures.push(new Error(`${client.label} logged ${unexpected.length} unexpected screen lifecycle errors: `
            + unexpected.map(entry => entry.data?.error ?? entry.message).join(' / ')));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { failures.push(error); console.error(error); }
    }
    try { if (!client.child.isClosed()) await client.cdp?.evaluate('window.nativeAppSmoke?.cleanup()'); }
    catch (error) { failures.push(error); console.error(error); }
    try { if (!client.child.isClosed()) await client.child.stop(); }
    catch (error) { failures.push(error); console.error(error); }
    if (client.child.isClosed()) await client.logsClosed;
    client.cdp?.close();
    client.overlayCdp?.close();
  }
  if (debuggerProcess) {
    try { await within(debuggerExited, 10000, 'Owned debugger did not terminate with its target.'); }
    catch (error) { failures.push(error); debuggerProcess.kill(); }
  }
  report.ownedProcessClosure = clients.map(client => ({
    role: client.label, pid: client.child.child.pid, closed: client.child.isClosed(),
  }));
  if (report.expectedOwnedSourceClose?.verified
    && (report.publisherExpectedSourceCloseErrors?.length !== 2
      || !report.publisherExpectedSourceCloseErrors.some(value => value.kind === 'native')
      || !report.publisherExpectedSourceCloseErrors.some(value => value.kind === 'renderer'))) {
    failures.push(new Error('Owned source-close proof requires its one exact native diagnostic and corresponding renderer diagnostic.'));
  }
  if (fourK60 && report.sourceQualityChanges.unsupported4k120?.preservationVerified
    && !report.publisherExpectedPreflightErrors?.some(entry =>
      entry.data?.nativeCodes?.includes('ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED'))) {
    failures.push(new Error('The preserved-source negative test lacks its explicit typed AMF preflight rejection log.'));
  }
  for (const owner of sourceOwners) {
    owner.stopping = true;
    if ((sourceReplacement || sourceQualityChanges) && owner.ready && owner.child.connected && owner.child.exitCode === null) {
      try { await sourceCommand('tone-stop', {}, owner.child); }
      catch (error) { failures.push(error); }
    }
    if (owner.child.connected) owner.child.disconnect();
    try {
      const code = await within(owner.exited, 10000, 'Owned source did not terminate.');
      assert.equal(code, 0);
      assert.equal(processAlive(owner.child.pid), false);
      report.ownedProcessClosure.push({ role: owner.label, pid: owner.child.pid, closed: true, code });
    } catch (error) { failures.push(error); owner.child.kill('SIGKILL'); }
  }
  if (sourceQualityChanges) {
    const capturePids = new Set(report.sourceQualityChanges.observedSources?.flatMap(entry => entry.capturePids) ?? []);
    for (const pid of capturePids) {
      try {
        const closed = !processAlive(pid);
        report.ownedProcessClosure.push({ role: 'quality-capture', pid, closed });
        assert.equal(closed, true, `Owned quality capture host ${pid} survived application cleanup.`);
      } catch (error) { failures.push(error); }
    }
  }
  try { await server?.stop(); } catch (error) { failures.push(error); }
  try { await otherServer?.stop(); } catch (error) { failures.push(error); }
  try { await vite?.close(); } catch (error) { failures.push(error); }
  for (const root of roots) {
    try {
      assert.equal(path.dirname(root), path.join(repo, '.qa', 'runs'));
      assert.ok(clients.every(client => client.child.isClosed()), 'Do not delete a live application profile.');
      await fs.rm(root, { recursive: true, maxRetries: 15, retryDelay: 150 });
    } catch (error) { failures.push(error); }
  }
  clearTimeout(deadline);
  report.errors = failures.map(error => error.stack ?? String(error));
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.exitCode = failures.length ? 1 : 0;
});
