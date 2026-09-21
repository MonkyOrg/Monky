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
assert.ok(!unsupportedBrowserCodec || (browserReceiver && mode === 'p2p'), 'The unsupported-codec case requires a browser P2P receiver.');
assert.ok(!incompatibleViewer || (!browserReceiver && mode === 'p2p'), 'Mixed compatibility requires a native primary P2P receiver.');
const debugSymbols = process.argv.find(value => value.startsWith('--debug-symbols='))?.slice('--debug-symbols='.length);
const report = { mode, browserReceiver, audioEnabled, unsupportedBrowserCodec, incompatibleViewer, overlayEnabled, sessionNavigation, serverLoss,
  normalMain: true, normalPreload: true, ownedSyntheticSource: true,
  capabilityOverride: browserReceiver ? 'viewer.receive=false (real Chromium receiver, not a macOS hardware test)' : null,
  recordedMedia: false, phases: [] };
const clients = [], roots = [], failures = [];
let server, otherServer, vite, source, sourceExited, sourceStopping = false;
let debuggerProcess, debuggerExited;
let incompatibleSessionId = null;

function phase(name) { report.phases.push(name); console.log(`Native Monky app: ${name}`); }
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
  if (state === 'waiting') {
    assert.equal(sample.placeholderVisible, true, 'The empty video covers the standby preview message.');
    assert.ok(pixels.bright >= 20, `The standby preview message is painted black or covered: ${JSON.stringify(pixels)}`);
  } else assert.ok(pixels.red > 150 && pixels.blue > 150 && pixels.green < 100,
    `The actual local preview surface does not display its source pixels: ${JSON.stringify(pixels)}`);
  return pixels;
}

async function setupRenderer({ port, password, nickname, browserReceiver, audioEnabled }) {
  const [{ openServerSession, joinCallOnSession, leaveCurrentCall }, { sessionManager }, { webRtcManager },
    { videoService }, { voiceStore }, { settingsStore }, { stopLocalScreenShares },
    { screenAudioService }, { setLanguage }, { appEvents }, { QUALITY_PRESETS }, { overlayBridgeService }] = await Promise.all([
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
  let measuredScreenContext = null;
  let measuredDummyTrack = null;
  const unbind = appEvents.on('native_screen.source_failed', event => nativeErrors.push(event));
  const sharing = () => session.participants.getInVoiceChannel(channel.id)
    .find(value => value.user.sessionId !== auth.currentUser.sessionId && value.voiceState.nativeScreenShares?.length);
  const watchedVideo = () => [...document.querySelectorAll('video.stage-video-element')]
    .find(video => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks().length);
  window.nativeAppSmoke = {
    async share(desktopSourceId) {
      const wait = async (condition, message) => {
        const deadline = performance.now() + 20000;
        while (!condition()) {
          if (performance.now() >= deadline) throw new Error(message);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
      const button = document.querySelector('#stage-btn-screen');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real Share Screen control is missing.');
      button.click();
      await wait(() => document.querySelector('#share-tab-window'), 'The real screen picker did not open.');
      const monitorTab = document.querySelector('#share-tab-screen');
      if (!monitorTab?.disabled || !monitorTab.textContent.includes('Coming soon'))
        throw new Error('The monitor alternative must remain disabled and labeled.');
      document.querySelector('#share-tab-window').click();
      const card = () => [...document.querySelectorAll('.source-item')].find(item => item.dataset.sourceId === desktopSourceId);
      await wait(card, 'The real picker did not enumerate the owned synthetic window.');
      card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      if (card().getAttribute('aria-pressed') !== 'true') throw new Error('Keyboard source selection was not acknowledged.');
      const audioToggle = document.querySelector('#chk-share-audio');
      if (!(audioToggle instanceof HTMLInputElement)) throw new Error('The real audio switch is missing.');
      if (audioToggle.checked !== audioEnabled) audioToggle.closest('.toggle-switch').querySelector('.toggle-slider').click();
      if (audioToggle.checked !== audioEnabled) throw new Error('The audio switch did not select the requested state.');
      const backend = document.querySelector('#share-capture-info')?.dataset.backend;
      if (backend !== 'native') throw new Error('The real picker did not qualify the native backend.');
      const confirm = document.querySelector('#btn-share');
      if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) throw new Error('The real share confirmation is unavailable.');
      confirm.click();
      const capture = () => videoService.getNativeScreenCaptures().find(value => value.desktopSourceId === desktopSourceId);
      await wait(() => !document.querySelector('#share-sources-panel') && capture(), 'Picker confirmation did not announce its native source.');
      return { source: capture().source, self: auth.currentUser.sessionId, picker: { backend, audio: audioEnabled, keyboardSelection: true } };
    },
    watch() {
      const button = document.querySelector('.stage-watch-btn');
      if (!(button instanceof HTMLButtonElement)) throw new Error('The real Watch control is missing.');
      button.click();
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
        fullscreen: !!document.fullscreenElement,
        ui: document.querySelector('#share-sources-panel') ? 'Desktop picker labels and thumbnails are not recorded.'
          : document.body.innerText.slice(0, 4000),
        mainCall: webRtcManager['nativeScreens']['call']?.config.callId ?? null,
        visibleSession: sessionManager.getActive()?.key ?? null, voiceSession: voiceStore.voiceSessionKey,
        localNativeSources: videoService.getNativeScreenCaptures().length,
        previewState: document.querySelector('[data-preview-state]')?.dataset.previewState ?? null,
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
        return { width, height, left: point(.02, .5), right: point(.98, .5),
          top: point(.5, .04), bottom: point(.5, .96), center: point(.5, .5) };
      } finally { frame.close(); }
    },
    previewClip(state) {
      const capture = videoService.getNativeScreenCaptures()[0];
      const card = capture && [...document.querySelectorAll('[data-kind="screen"]')]
        .find(element => element.dataset.tileKey?.endsWith(':screen:' + capture.source.shareId));
      if (!card || card.dataset.previewState !== state) throw new Error('The local preview is not in its expected state.');
      let area, placeholderVisible = null;
      if (state === 'waiting') {
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
        area = { x: bounds.x + (bounds.width - width) / 2 + width * .02 - 2,
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
      unbind();
      await overlayBridgeService.deactivate();
      await stopLocalScreenShares(screenAudioService);
      await webRtcManager['nativeScreens'].close();
      leaveCurrentCall();
    },
  };
  return { sessionId: auth.currentUser.sessionId, channelId: channel.id,
    capabilities: await webRtcManager.getNativeScreenCapabilities(), profile: videoService.getProfile(),
    browserVideoCapabilities: browserReceiver ? RTCRtpReceiver.getCapabilities('video') : null };
}

async function run() {
  await fs.mkdir(artifacts);
  phase('starting-owned-source');
  const sourceEnv = { ...process.env };
  delete sourceEnv.ELECTRON_RUN_AS_NODE;
  source = spawn(require('electron'), [path.join(clientRoot, 'native', 'screen-share', 'test', 'nativeAvSource.cjs'),
    `--profile=${path.join(artifacts, 'source-profile')}`], { env: sourceEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const sourceLog = await fs.open(path.join(artifacts, 'source.log'), 'wx');
  source.stdout.on('data', value => { void sourceLog.write(value); });
  source.stderr.on('data', value => { void sourceLog.write(value); });
  sourceExited = once(source, 'exit').then(async ([code]) => {
    await sourceLog.close();
    if (!sourceStopping) failures.push(new Error(`The owned source exited unexpectedly (${code}).`));
    return code;
  });
  const [sourceReady] = await within(once(source, 'message'), 20000, 'Owned source readiness timed out.');
  assert.equal(sourceReady.type, 'ready');
  assert.equal(sourceReady.pid, source.pid);
  report.sourcePid = source.pid;

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
    const child = startOwnedProcess(require('electron'), [clientRoot, `--user-data-dir=${profile}`,
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
      port, password, nickname: config.nickname, browserReceiver: label === 'incompatible' || browserReceiver && label === 'viewer', audioEnabled,
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
  phase('announcing-without-capture');
  report.published = await publisher.cdp.evaluate(`nativeAppSmoke.share(${JSON.stringify(`window:${sourceReady.hwnd}:0`)})`);
  await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).watchButton, 'Normal Watch control did not appear.');
  report.idle = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
  assert.equal(report.idle.publishers.length, 1);
  assert.equal(report.idle.publishers[0].pipelines.length, 0, 'Announcement started native media before Watch.');
  await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.telemetry()'))
    .some(value => !value.hidden && value.text.includes('Waiting for viewers')), 'Idle native telemetry did not report demand zero.');
  report.idleDiagnostics = await publisher.cdp.evaluate('nativeAppSmoke.diagnostics()');
  assert.equal(report.idleDiagnostics.viewers, 0);
  assert.deepEqual(report.idleDiagnostics.endpoints, []);
  report.idlePreviewPixels = await previewPixels(publisher, 'waiting', 'preview-standby');
  const sourceCommand = async command => {
    const id = randomUUID(), response = once(source, 'message');
    source.send({ type: 'source-command', id, command });
    const [result] = await within(response, 10000, `Owned source command timed out: ${command}`);
    assert.equal(result.id, id); assert.equal(result.ok, true, result.error);
  };
  if (idleSourceClose) {
    phase('closing-without-ever-capturing');
    await sourceCommand('close-source');
    await until(async () => !(await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).sources.length
      && (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers.length === 0,
    'Closing an unwatched window retained its announcement.');
    report.idleSourceRetired = true;
    return;
  }
  if (audioEnabled) {
    source.send({ type: 'source-command', id: randomUUID(), command: 'tone-start' });
    const [tone] = await within(once(source, 'message'), 10000, 'Owned tone did not start.');
    assert.equal(tone.ok, true);
  }

  phase('watching-through-normal-ui');
  await viewer.cdp.evaluate('nativeAppSmoke.watch()');
  if (unsupportedBrowserCodec) {
    phase('rejecting-an-insufficient-receive-level');
    await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).watchStates
      .some(state => state.state === 'unavailable' && state.reason === 'unsupported'),
    'An insufficient H.264 receive level did not produce an explicit unsupported error.');
    await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines.length === 0,
      'Rejected browser negotiation retained a native pipeline.');
    assert.equal((await publisher.child.call('qa-ping')).alive, true, 'Rejected codec crashed the publisher.');
    assert.equal((await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).browserWatches, 0);
    report.unsupportedCodecRejectedAndRetired = true;
    return;
  }
  await until(async () => {
    const value = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
    assert.deepEqual(value.errors, []);
    return value.video?.width === 1920 && value.video.height === 1080 && value.video.frames >= 30;
  }, 'Native frames did not reach the normal Monky stage.', 45000);
  await until(async () => {
    const state = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
    return state.previewState === 'playing' && state.video?.width === 1920 && state.video.frames >= 15;
  }, 'The publisher did not display its actual libobs preview.');
  report.localPreview = await publisher.cdp.evaluate('nativeAppSmoke.snapshot()');
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
      await sourceCommand('restore-source');
      await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).video?.frames >= before.video.frames + 20,
        'The original subscription did not resume after restoring the window.');
    }
    report.windowLifecyclePreserved = true;
  }
  const before = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  await delay(3000);
  const after = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  report.stage = { ...after, fps: (after.video.frames - before.video.frames) * 1000 / (after.video.at - before.video.at) };
  assert.ok(report.stage.fps >= 100, `Normal-app presentation reached ${report.stage.fps.toFixed(2)} FPS.`);
  report.localCompositorPixels = await previewPixels(publisher, 'playing', 'preview-playing');
  report.receiving = await viewer.cdp.evaluate('nativeAppSmoke.stats()');
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
  report.senderDiagnostics = await publisher.cdp.evaluate('nativeAppSmoke.diagnostics()');
  report.receiverDiagnostics = await viewer.cdp.evaluate('nativeAppSmoke.diagnostics()');
  for (const diagnostics of [report.senderDiagnostics, report.receiverDiagnostics])
    if (diagnostics.backend === 'native') assert.ok(diagnostics.endpoints.every(endpoint => endpoint.readErrors === 0));
  report.stretchedPixels = await viewer.cdp.evaluate('nativeAppSmoke.pixels()');
  const assertStretch = pixels => {
    for (const color of [pixels.left, pixels.right])
      assert.ok(color[0] > 180 && color[1] < 80 && color[2] > 180, 'The 4:3 source was letterboxed instead of stretched to its output.');
    assert.ok(pixels.top[0] > 180 && pixels.top[1] < 80 && pixels.top[2] < 80);
    assert.ok(pixels.bottom[0] < 80 && pixels.bottom[1] < 80 && pixels.bottom[2] > 180);
    assert.ok(pixels.center.slice(0, 3).every(channel => channel > 180));
  };
  assertStretch(report.stretchedPixels);
  report.localDecodedPixels = await publisher.cdp.evaluate('nativeAppSmoke.pixels()');
  assertStretch(report.localDecodedPixels);
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
    const retained = (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines[0];
    assert.equal(retained.pipelineId, pipeline.pipelineId);
    assert.equal(retained.endpoint.capturePid, pipeline.endpoint.capturePid, 'An incompatible viewer restarted the shared capture.');
    assert.equal(after.watchStates[0].state, 'playing');
    const fps = (after.video.frames - before.video.frames) * 1000 / (after.video.at - before.video.at);
    assert.ok(fps >= 100, `A rejected viewer interrupted compatible playback (${fps.toFixed(2)} FPS).`);
    assert.deepEqual((await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).errors, [], 'A viewer-only rejection was reported as a source failure.');
    report.incompatibleViewerIsolation = { fps, pipelinePreserved: true, capturePreserved: true };
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
      state: video.srcObject?.getVideoTracks()[0]?.readyState, paused: video.paused
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
  if (browserReceiver) {
    report.browserReduced = await viewer.cdp.evaluate('nativeAppSmoke.browserStats()');
    report.reducedPublisher = await publisher.cdp.evaluate('nativeAppSmoke.stats()');
    assert.equal(report.reducedPublisher.publishers[0].pipelines[0].endpoint.profile.fps, 30);
  } else assert.equal(report.reduced.subscriptions[0].endpoint.profile.fps, 30);
  const reducedBefore = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  await delay(2500);
  const reducedAfter = await viewer.cdp.evaluate('nativeAppSmoke.snapshot()');
  report.reducedFps = (reducedAfter.video.frames - reducedBefore.video.frames) * 1000 / (reducedAfter.video.at - reducedBefore.video.at);
  assert.ok(report.reducedFps >= 25 && report.reducedFps <= 35, 'Quality did not change actual presentation cadence.');
  assert.equal(reducedAfter.fullscreen, true, 'A quality change destroyed the fullscreen card.');
  report.reducedSenderTelemetry = await observedTelemetry(publisher, 852, 480);
  report.reducedReceiverTelemetry = await observedTelemetry(viewer, 852, 480);
  report.reducedSenderDiagnostics = await publisher.cdp.evaluate('nativeAppSmoke.diagnostics()');
  report.reducedStretchedPixels = await viewer.cdp.evaluate('nativeAppSmoke.pixels()');
  assertStretch(report.reducedStretchedPixels);
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
  await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.stats()')).publishers[0].pipelines.length === 0,
    'The normal Stop control retained a capture/encoder.');
  assert.equal((await viewer.cdp.evaluate('nativeAppSmoke.stats()')).subscriptions.length, 0);
  assert.equal((await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).browserWatches, 0);
  await until(async () => (await publisher.cdp.evaluate('nativeAppSmoke.snapshot()')).previewState === 'waiting',
    'The local preview did not return to demand-zero standby.');
  report.stoppedPreviewPixels = await previewPixels(publisher, 'waiting', 'preview-stopped');
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
  phase('rewatching');
  await viewer.cdp.evaluate('nativeAppSmoke.watch()');
  await until(async () => (await viewer.cdp.evaluate('nativeAppSmoke.snapshot()')).video?.frames >= 15,
    'A second normal Watch did not resume playback.');
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
        if (file.endsWith('.jsonl')) await fs.copyFile(path.join(logs, file), path.join(artifacts, `${client.label}-${file}`));
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
  if (source) {
    sourceStopping = true;
    if (source.connected) source.disconnect();
    try { assert.equal(await within(sourceExited, 10000, 'Owned source did not terminate.'), 0); }
    catch (error) { failures.push(error); source.kill('SIGKILL'); }
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
