'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
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
const preserveAspectRatio = process.argv.includes('--preserve-aspect-ratio');
const gameFallback = process.argv.includes('--game-fallback');
const publisherStop = process.argv.includes('--publisher-stop');
const sourceResize = process.argv.includes('--source-resize');
const sourceReplacement = process.argv.includes('--source-replacement');
assert.ok(!sourceReplacement || (browserReceiver && mode === 'sfu' && audioEnabled
  && !gameFallback && !unsupportedBrowserCodec && !incompatibleViewer && !idleSourceClose
  && !admissionRecovery && !publisherStop && !windowLifecycle && !serverLoss && !sessionNavigation
  && !overlayEnabled && !sourceResize && !debugPublisher),
'Source replacement requires an audio-enabled browser SFU receiver and two owned Normal windows, without other smoke scenarios.');
assert.ok(!unsupportedBrowserCodec || (browserReceiver && mode === 'p2p'), 'The unsupported-codec case requires a browser P2P receiver.');
assert.ok(!incompatibleViewer || (!browserReceiver && mode === 'p2p'), 'Mixed compatibility requires a native primary P2P receiver.');
const debugSymbols = process.argv.find(value => value.startsWith('--debug-symbols='))?.slice('--debug-symbols='.length);
const report = { mode, browserReceiver, audioEnabled, unsupportedBrowserCodec, incompatibleViewer, overlayEnabled, sessionNavigation, serverLoss, admissionRecovery, preserveAspectRatio, gameFallback, publisherStop, sourceResize, sourceReplacement,
  normalMain: true, normalPreload: true, ownedSyntheticSource: true,
  qaFocusHooks: 'owned parent IPC only; normal Main and preload checks unchanged',
  capabilityOverride: browserReceiver ? 'viewer.receive=false (real Chromium receiver, not a macOS hardware test)' : null,
  recordedMedia: false, phases: [] };
const clients = [], roots = [], failures = [], sourceOwners = [];
let server, otherServer, vite, source;
let debuggerProcess, debuggerExited;
let incompatibleSessionId = null;

function phase(name) { report.phases.push(name); console.log(`Native Monky app: ${name}`); }
function processAlive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function startSyntheticSource(label) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(clientRoot, 'native', 'screen-share', 'test', 'nativeAvSource.cjs'),
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
  return owner;
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

function mainFixture({ clientRoot, origin, ownerPid }) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { app, BrowserWindow } = require('electron');
  assert.equal(process.ppid, ownerPid);
  assert.equal(process.connected, true);
  const envelope = JSON.parse(fs.readFileSync(process.env.MONKY_QA_CONFIG, 'utf8'));
  assert.equal(envelope.ownerPid, ownerPid);
  assert.equal(envelope.config.scenario, 'home');
  const metadata = require(path.join(clientRoot, 'package.json'));
  // The real Main still owns profile, launcher-envelope and renderer-frame validation.
  app.setAppPath(clientRoot);
  app.setName(metadata.productName ?? metadata.name);
  app.setVersion(metadata.version);
  const message = input => {
    if (!input || input.runId !== envelope.config.runId || !['qa-focus', 'qa-blur', 'qa-focus-state'].includes(input.type)) return;
    try {
      assert.equal(typeof input.id, 'string');
      assert.equal(input.value, undefined);
      assert.equal(process.connected, true);
      assert.equal(process.ppid, ownerPid);
      const windows = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed());
      const window = windows.find(candidate => candidate.webContents.getURL().startsWith(`${origin}/`)
        && new URL(candidate.webContents.getURL()).searchParams.get('overlay') !== '1');
      assert.ok(window, 'The owned normal Main window is unavailable.');
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
  const requests = new Map();
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    if (value.method === 'Runtime.exceptionThrown') diagnostics.push(value.params.exceptionDetails);
    if (value.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(value.params.type))
      diagnostics.push({ type: value.params.type, args: value.params.args.map(arg => arg.description ?? arg.value) });
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
    async capture(clip) {
      const result = await call('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...clip, scale: 1 },
      });
      assert.equal(typeof result.data, 'string');
      return result.data;
    },
  };
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

async function setupRenderer({ port, password, nickname, browserReceiver, audioEnabled, preserveAspectRatio, gameFallback }) {
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
    screenFps: 120, screenBitrateKbps: 20000, audioBitrateKbps: 128 };
  settingsStore.preferredVideoCodec = 'h264';
  settingsStore.screenShareTelemetryEnabled = true;
  settingsStore.screenShareTelemetryMode = 'complete';
  const initialPreviewPauseWhenUnfocused = settingsStore.screenSharePreviewPauseWhenUnfocused;
  settingsStore.save();
  webRtcManager.setQualityPreset('CUSTOM');
  videoService.setQualityPreset('CUSTOM');
  if (browserReceiver) {
    const capabilities = await webRtcManager.getNativeScreenCapabilities();
    webRtcManager['nativeScreens']['availability'] = Promise.resolve({ ...capabilities, receive: false });
  }
  const auth = await openServerSession('127.0.0.1', port, await window.api.getIdentity(), nickname, password);
  const session = sessionManager.getActive();
  if (!session) throw new Error('The real application did not create its server session.');
  const channel = auth.server.channels.find(value => value.type === 'VOICE');
  await joinCallOnSession(session.key, channel.id);
  document.querySelector(`[data-channel-id="${channel.id}"][data-channel-type="VOICE"]`)?.click();
  const nativeErrors = [];
  const captureFallbacks = [];
  const unbindFallback = appEvents.on('native_screen.capture_fallback', event => {
    captureFallbacks.push({ ...event, at: performance.now() });
  });
  const fallbackToasts = [], seenToasts = new WeakSet(), toastChecks = new Set();
  const toastObserver = new MutationObserver(() => {
    for (const toast of document.querySelectorAll('.chat-copy-toast[role="status"]')) {
      const label = toast.querySelector('.chat-copy-toast-label')?.textContent;
      if (label !== t('screenShare.gameFallback') || seenToasts.has(toast)) continue;
      seenToasts.add(toast);
      const entry = { label, at: performance.now(), visible: false };
      fallbackToasts.push(entry);
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
    async share(ownedHwnd, expectedFailure = false, replace = false) {
      const wait = async (condition, message) => {
        const deadline = performance.now() + 20000;
        while (!condition()) {
          if (performance.now() >= deadline) throw new Error(message);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
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
      const { id: desktopSourceId } = ownedWindowSource(await window.api.getDesktopSources(), ownedHwnd);
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
      if (opening && aspectToggle.checked) throw new Error('A new picker retained another share aspect-ratio preference.');
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
      if (replace && (capture().source.audio !== true || capture().source.shareId === previous.shareId
        || capture().source.instanceId === previous.instanceId || videoService.getNativeScreenCaptures().length !== 1
        || voiceStore.screenAudioShareId !== capture().source.shareId))
        throw new Error('Replace did not transfer the single audio owner to a fresh source instance.');
      return { source: capture().source, self: auth.currentUser.sessionId, desktopSourceId,
        picker: { backend, audio: audioEnabled, preserveAspectRatio, captureKind: gameFallback ? 'game' : 'window',
          refreshed: true, keyboardSelection: true, gameGuideChecked: gameFallback, ownedHwnd, replace } };
    },
    watch() {
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
        sources: remote?.voiceState.nativeScreenShares ?? [],
        watches: voiceStore.getScreenWatchers(), watchButton: !!document.querySelector('.stage-watch-btn'),
        video: video ? { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
          frames: video.getVideoPlaybackQuality().totalVideoFrames, at: performance.now() } : null,
        errors: [...nativeErrors],
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
        browserWatches: [...(webRtcManager['nativeScreens']['call']?.presentations.values() ?? [])]
          .filter(entry => entry.browser && !entry.stopping).length,
        screenOutputContext: webRtcManager['mediaRouter']['audioContexts'].get('screen')?.state ?? null,
        measuredScreenContext: measuredScreenContext?.state ?? null,
        watchStates: [...(webRtcManager['nativeScreens']['call']?.presentations.values() ?? [])].map(entry => entry.state),
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
    capabilities: await webRtcManager.getNativeScreenCapabilities(), profile: videoService.getProfile(),
    previewPauseWhenUnfocused: initialPreviewPauseWhenUnfocused,
    browserVideoCapabilities: browserReceiver ? RTCRtpReceiver.getCapabilities('video') : null };
}

async function run() {
  await fs.mkdir(artifacts);
  phase('starting-owned-source');
  const primarySource = await startSyntheticSource('source');
  source = primarySource.child;
  const sourceReady = primarySource.ready;
  report.sourcePid = source.pid;
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
  await fs.writeFile(mainFixtureFile, `(${mainFixture.toString()})(${JSON.stringify({ clientRoot, origin, ownerPid: process.pid })});\n`,
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
    const child = startOwnedProcess(require('electron'), [mainFixtureFile, `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', '--allow-loopback-in-peer-connection'], {
      cwd: clientRoot, runId, label: `Native Monky ${label}`, timeoutMs: 60000,
      env: isolatedEnvironment(profile, { MONKY_QA_CONFIG: configFile, VITE_DEV_SERVER_URL: origin }),
      onFailure: error => failures.push(error),
    });
    const owned = { child, profile, label, debugPort, runId, cdp: null, overlayCdp: null, diagnostics: [] };
    clients.push(owned);
    const log = await fs.open(path.join(artifacts, `${label}.log`), 'wx');
    child.child.stdout.on('data', value => { void log.write(value); });
    child.child.stderr.on('data', value => { void log.write(value); });
    void child.closed.then(() => log.close());
    await child.ready;
    assert.equal((await child.call('qa-ping')).alive, true);
    owned.cdp = await connectCdp(debugPort, origin, runId, owned.diagnostics);
    await owned.cdp.evaluate(`globalThis.monkyAppSharedPath = ${JSON.stringify(path.join(repo, 'packages', 'shared', 'src', 'index.ts').replaceAll('\\', '/'))}`);
    owned.identity = await owned.cdp.evaluate(`(${setupRenderer.toString()})(${JSON.stringify({
      port, password, nickname: config.nickname, browserReceiver: label === 'incompatible' || browserReceiver && label === 'viewer',
      audioEnabled, preserveAspectRatio, gameFallback,
    })})`);
    report[`${label}Setup`] = owned.identity;
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
    return state.previewState === 'playing' && state.video?.width === 1920
      && state.video.height === 1080 && state.video.frames >= 15;
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
    return value.video?.width === 1920 && value.video.height === 1080 && value.video.frames >= 30;
  }, 'Native frames did not reach the normal Monky stage.', 45000);
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
  const before = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  assert.ok(before.video, `The receiver has no video before the FPS interval: ${JSON.stringify(before.watchStates)}`);
  await delay(3000);
  const after = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  assert.ok(after.video, `The receiver lost video during the FPS interval: ${JSON.stringify(after.watchStates)}`);
  report.stage = { ...after, fps: (after.video.frames - before.video.frames) * 1000 / (after.video.at - before.video.at) };
  report.stageBefore = before;
  const sourceRate = await collectEvidence('sourceRateBeforeAssertion', publisher, viewer);
  report.publishing = sourceRate.publisherStats;
  report.receiving = sourceRate.receiverStats;
  report.senderDiagnostics = sourceRate.senderDiagnostics;
  report.receiverDiagnostics = sourceRate.receiverDiagnostics;
  assert.equal(sourceRate.publisherState.previewPauseWhenUnfocused, false);
  assert.ok(sourceRate.receiverState.captureModes.some(value => value.mode === 'normal' && value.tileKey === publishedTileKey),
    'The spectator did not display the actual capture method for the selected source.');
  assert.ok(report.stage.fps >= 100, `Normal-app presentation reached ${report.stage.fps.toFixed(2)} FPS.`);
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
    assert.match(report.receiverTelemetry.text, /Native decoder FPS \(MF\): [1-9][0-9]*/);
    assert.ok(report.receiverDiagnostics.endpoints.some(endpoint => endpoint.decoders.length));
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
    assert.ok(fps >= 100, `A rejected viewer interrupted compatible playback (${fps.toFixed(2)} FPS).`);
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
  await viewer.cdp.evaluate('nativeAppSmoke.quality("480p30")');
  await until(async () => {
    const value = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    return value.video?.width === 852 && value.video.height === 480 && value.video.frames >= 15;
  }, 'The normal quality control did not change actual decoded dimensions.');
  report.reduced = await viewer.cdp.evaluate('nativeAppSmoke.stats()');
  await until(async () => {
    const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
    return state.previewState === 'playing' && state.video?.width === 852 && state.video.height === 480;
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
  report.reducedSenderTelemetry = await observedTelemetry(publisher, 852, 480);
  report.reducedReceiverTelemetry = await observedTelemetry(viewer, 852, 480);
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

  phase('closing-the-owned-shared-window');
  const id = randomUUID(), response = once(source, 'message');
  source.send({ type: 'source-command', id, command: 'close-source' });
  const [closed] = await within(response, 10000, 'Owned source did not close.');
  assert.equal(closed.id, id); assert.equal(closed.ok, true);
  await until(async () => !(await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).sources.length,
    'Closing the shared window did not remove its real advertisement.');
  await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers.length === 0,
    'Closing the source retained its publisher owner.');
}

const deadline = setTimeout(() => { failures.push(new Error('Native app smoke exceeded its global deadline.')); }, 240000);
void run().catch(error => { failures.push(error); console.error(error); }).finally(async () => {
  phase('closing-owned-applications');
  for (const client of [...clients].reverse()) {
    report[`${client.label}Diagnostics`] = client.diagnostics;
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
        if (sourceReplacement) {
          const errors = (await fs.readFile(destination, 'utf8')).split(/\r?\n/).filter(Boolean)
            .map(line => JSON.parse(line)).filter(entry => entry.category === 'SCREEN_SHARE' && entry.level === 'ERROR');
          (report[`${client.label}ScreenErrors`] ??= []).push(...errors);
          if (errors.length) failures.push(new Error(`${client.label} logged ${errors.length} screen lifecycle errors: `
            + errors.map(entry => entry.data?.error ?? entry.message).join(' / ')));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { failures.push(error); console.error(error); }
    }
    try { if (!client.child.isClosed()) await client.cdp?.evaluate('window.nativeAppSmoke?.cleanup()'); }
    catch (error) { failures.push(error); console.error(error); }
    try { if (!client.child.isClosed()) await client.child.stop(); }
    catch (error) { failures.push(error); console.error(error); }
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
  for (const owner of sourceOwners) {
    owner.stopping = true;
    if (sourceReplacement && owner.ready && owner.child.connected && owner.child.exitCode === null) {
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
