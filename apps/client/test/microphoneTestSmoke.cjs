const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

module.exports = { runMicrophoneTestSmoke };

if (require.main === module || process.argv[1] === __filename) {
  const clientRoot = path.resolve(__dirname, '..');
  if (!process.versions.electron) {
    const profile = path.join(clientRoot, 'dist-test', `microphone-test-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_MICROPHONE_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: clientRoot, env, stdio: 'inherit' });
    const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
    child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
  } else {
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', process.env.MONKY_MICROPHONE_TEST_PROFILE);
    app.on('window-all-closed', () => {});
    let vite;
    let window;
    let timeout;
    const finish = async (code) => {
      clearTimeout(timeout);
      if (window && !window.isDestroyed()) window.destroy();
      if (vite) await vite.close();
      app.exit(code);
    };
    app.whenReady().then(async () => {
      const { createServer } = await import('vite');
      vite = await createServer({
        configFile: path.join(clientRoot, 'vite.config.ts'),
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
        plugins: [{
          name: 'microphone-test-fixture',
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              if (request.url !== '/__microphone_test__') return next();
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"></head><body></body></html>');
            });
          },
        }],
      });
      const httpServer = vite.httpServer;
      if (!httpServer) throw new Error('Missing Vite HTTP server');
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
      window = new BrowserWindow({
        show: false, width: 1000, height: 900,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      timeout = setTimeout(() => { console.error('Microphone test smoke timed out'); void finish(1); }, 45_000);
      await window.loadURL(`http://127.0.0.1:${address.port}/__microphone_test__`);
      const checks = await window.webContents.executeJavaScript(`(${runMicrophoneTestSmoke.toString()})()`, true);
      console.log(`Microphone test smoke: ${checks} checks passed`);
      if (process.argv.includes('--screenshots')) {
        await window.webContents.executeJavaScript(`document.body.innerHTML = '<div style="width:700px;padding:24px;">' + window.microphoneTestPreviewMarkup + '</div>'; document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
        fs.writeFileSync(path.join(clientRoot, 'dist-test', 'microphone-test-preview.png'),
          (await window.webContents.capturePage({ x: 0, y: 0, width: 760, height: 850 })).toPNG());
      }
      await finish(0);
    }).catch(async (error) => { console.error(error); await finish(1); });
  }
}

async function runMicrophoneTestSmoke() {
  const [{ VoiceVideoTab }, { settingsStore: settings }, { voiceStore: voice }, { audioProcessor: audio }, { appEvents }, { t }] =
    await Promise.all([
      import('/views/settings/tabs/VoiceVideoTab.ts'), import('/stores/settingsStore.ts'),
      import('/stores/voiceStore.ts'), import('/core/AudioProcessor.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
    ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 65));
  const original = {
    gum: navigator.mediaDevices.getUserMedia, enumerate: navigator.mediaDevices.enumerateDevices,
    AudioContext: window.AudioContext, raw: audio.getRawMicrophoneStream,
    play: HTMLMediaElement.prototype.play, pause: HTMLMediaElement.prototype.pause, sink: HTMLMediaElement.prototype.setSinkId,
    raf: window.requestAnimationFrame, cancelRaf: window.cancelAnimationFrame,
    mic: settings.selectedMicrophoneId, speaker: settings.selectedSpeakerId, mode: settings.inputMode,
    channel: voice.currentVoiceChannelId, muted: voice.isMuted, deafened: voice.isDeafened,
    serverMuted: voice.serverMuted, serverDeafened: voice.serverDeafened,
    ptt: voice.pttPressed, microphoneOpen: voice.microphoneOpen,
    api: window.api, pttKey: settings.pttKey, storage: localStorage.getItem('monky_settings'),
  };
  const initialListenerCount = Array.from(appEvents.listeners.values()).reduce((count, listeners) => count + listeners.size, 0);
  let speakingEvents = 0;
  const offSpeaking = appEvents.on('local.speaking', (speaking) => { if (speaking) speakingEvents++; });
  const sourceContext = new original.AudioContext();
  const source = sourceContext.createMediaStreamDestination();
  const captures = [];
  const contexts = [];
  const plays = [];
  const sinks = [];
  const frames = new Set();
  let raw = null;
  let captureMode = 'normal';
  let sinkMode = 'normal';
  let playMode = 'normal';
  let pendingCapture = null;
  let pendingSink = null;
  let pendingPlay = null;
  let pttTab = null;
  let pttContainer = null;
  const capture = () => {
    const stream = source.stream.clone();
    captures.push(stream);
    return stream;
  };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (captureMode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
    if (captureMode === 'pending') return new Promise((resolve) => { pendingCapture = { resolve, constraints }; });
    const stream = capture();
    stream.requestedConstraints = constraints;
    return stream;
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'mic-test', label: 'Microphone' },
    { kind: 'audiooutput', deviceId: 'speaker-test', label: 'Headphones' },
  ];
  class PreviewAudioContext extends original.AudioContext {
    constructor(...args) { super(...args); contexts.push(this); }
    createMediaStreamSource(stream) {
      this.previewStream = stream;
      return super.createMediaStreamSource(stream);
    }
    createAnalyser() {
      const analyser = super.createAnalyser();
      // Real streams/graphs with deterministic samples; CI needs no audio device.
      analyser.getByteFrequencyData = (buffer) => {
        buffer.fill(this.previewStream?.getAudioTracks().some((track) => track.enabled && track.readyState === 'live') ? 100 : 0);
      };
      return analyser;
    }
  }
  window.AudioContext = PreviewAudioContext;
  // Hidden Electron windows may not receive compositor animation frames.
  window.requestAnimationFrame = (callback) => {
    const id = window.setTimeout(() => { frames.delete(id); callback(performance.now()); }, 16);
    frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => { window.clearTimeout(id); frames.delete(id); };
  HTMLMediaElement.prototype.setSinkId = async function (id) {
    sinks.push({ audio: this, id });
    if (sinkMode === 'fail') throw new DOMException('Output disconnected', 'NotFoundError');
    if (sinkMode === 'pending') await new Promise((resolve) => { pendingSink = { resolve, audio: this }; });
  };
  HTMLMediaElement.prototype.play = async function () {
    plays.push(this);
    if (playMode === 'fail') throw new Error('Playback unavailable');
    if (playMode === 'pending') await new Promise((resolve) => { pendingPlay = { resolve, audio: this }; });
    // Deliberately no real playback: the regression cannot feed speakers.
  };
  HTMLMediaElement.prototype.pause = function () { original.pause.call(this); };
  audio.getRawMicrophoneStream = () => raw;
  settings.selectedMicrophoneId = 'mic-test';
  settings.selectedSpeakerId = 'speaker-test';
  settings.inputMode = 'voice_activity';
  voice.currentVoiceChannelId = null;
  const container = document.createElement('div');
  container.id = 'tab-panel-voice_video';
  document.body.append(container);
  const tab = new VoiceVideoTab();
  container.innerHTML = tab.renderHtml();
  tab.attachEvents(container);
  await tab.refreshDevices(container);
  const button = container.querySelector('#btn-microphone-test');
  const meter = container.querySelector('#microphone-test-meter');
  const status = container.querySelector('#microphone-test-status');
  const stopped = (message) => {
    check(button.getAttribute('aria-pressed') === 'false' && meter.getAttribute('aria-valuenow') === '0'
      && meter.querySelector('.vad-meter-fill').style.width === '0%', message);
  };
  try {
    check(button.textContent.trim() === t('settings.microphoneTestStart') && button.type === 'button', 'localized opt-in test button');
    check(button.getAttribute('aria-pressed') === 'false' && meter.getAttribute('aria-valuenow') === '0', 'test initially stopped');
    check(container.querySelector('#microphone-test-hint').textContent === t('settings.microphoneTestHint'), 'visible localized headphones/feedback warning');
    await wait();
    check(captures.length === 0 && plays.length === 0, 'render and event binding never capture or play');
    tab.startVadMeter(container);
    await wait();
    check(captures.length === 1 && plays.length === 0, 'passive VAD meter never plays audio');
    check(!voice.isSpeaking && speakingEvents === 0 && Number(container.querySelector('#vad-meter').getAttribute('aria-valuenow')) > 0,
      'Voice settings keep their local level preview without announcing speech outside a call');
    check(captures[0].requestedConstraints.audio.deviceId.exact === 'mic-test', 'preview captures the selected input');
    button.click();
    await wait();
    check(captures.length === 1 && contexts.length === 1, 'microphone test shares the passive meter capture/graph');
    check(plays.length === 1 && plays[0].srcObject === captures[0], 'explicit click starts local playback only');
    check(sinks[0].id === 'speaker-test' && sinks[0].audio === plays[0], 'selected output routed before playback');
    check(plays[0].volume === 0.25 && !plays[0].autoplay, 'test has reduced volume and no autoplay');
    check(button.getAttribute('aria-pressed') === 'true' && status.textContent === t('settings.microphoneTestPlaying'), 'playing state is visible');
    check(Number(meter.getAttribute('aria-valuenow')) > 0, 'test level bar updates while running');
    const preview = container.cloneNode(true);
    for (const select of container.querySelectorAll('select')) {
      for (const option of preview.querySelector(`#${select.id}`).options) {
        option.toggleAttribute('selected', option.value === select.value);
      }
    }
    window.microphoneTestPreviewMarkup = preview.outerHTML;
    button.click();
    await wait();
    stopped('stop resets test button and level bar');
    check(plays[0].srcObject === null, 'stop detaches playback stream');
    check(captures[0].getAudioTracks()[0].readyState === 'live', 'stopping test does not stop passive VAD capture');
    check(Number(container.querySelector('#vad-meter').getAttribute('aria-valuenow')) > 0, 'passive VAD still works after stopping test');
    button.click();
    await wait();
    tab.deactivate();
    await wait();
    stopped('deactivate stops test before switching settings tabs');
    check(frames.size === 0 && plays.at(-1).srcObject === null, 'deactivate releases all active previews');
    tab.startVadMeter(container);
    button.click();
    await wait();
    check(button.getAttribute('aria-pressed') === 'true' && plays.at(-1).srcObject, 'returning to voice tab keeps explicit test button usable');
    tab.cleanup();
    await wait();
    check(captures[0].getAudioTracks()[0].readyState === 'ended' && contexts[0].state === 'closed', 'tab cleanup releases shared preview');
    check(frames.size === 0, 'tab cleanup cancels shared animation loop');

    tab.attachEvents(container);
    button.click();
    await wait();
    const beforeOutputChange = plays.length;
    settings.selectedSpeakerId = 'changed-output';
    appEvents.emit('settings.updated');
    await wait();
    stopped('changing selected output stops test');
    check(status.textContent === t('settings.microphoneTestDeviceChanged') && plays.length === beforeOutputChange, 'device change explains stop without automatic restart');
    settings.selectedSpeakerId = '';
    button.click();
    await wait();
    check(sinks.at(-1).id === '', 'explicit restart routes system-default output');
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await wait();
    stopped('hotplug stops test');
    button.click();
    await wait();
    settings.selectedMicrophoneId = 'changed-input';
    appEvents.emit('settings.updated');
    await wait();
    stopped('changing selected input stops test');
    check(status.textContent === t('settings.microphoneTestDeviceChanged'), 'selected input change is explained');
    settings.selectedMicrophoneId = 'mic-test';
    button.click();
    await wait();
    appEvents.emit('network.disconnected');
    await wait();
    stopped('the actual network-disconnect event stops playback outside a call');
    check(status.textContent === t('settings.microphoneTestDisconnected'), 'network disconnect explains why the local test stopped');

    sinkMode = 'fail';
    const playsBeforeSinkFailure = plays.length;
    button.click();
    await wait();
    stopped('sink failure resets test state');
    check(plays.length === playsBeforeSinkFailure && Boolean(status.textContent), 'sink failure never plays and displays error');
    check(captures.at(-1).getAudioTracks()[0].readyState === 'ended' && contexts.at(-1).state === 'closed', 'sink failure releases owned capture/graph');
    sinkMode = 'normal';
    playMode = 'fail';
    button.click();
    await wait();
    stopped('playback failure resets test state');
    check(status.textContent === t('settings.microphoneTestFailed') && plays.at(-1).srcObject === null, 'playback error explained and stream detached');
    playMode = 'normal';
    window.AudioContext = class extends PreviewAudioContext {
      resume() { return Promise.reject(new Error('Audio context unavailable')); }
    };
    button.click();
    await wait();
    stopped('audio context resume failure resets test');
    check(captures.at(-1).getAudioTracks()[0].readyState === 'ended' && contexts.at(-1).state === 'closed', 'audio context failure releases graph and tracks');
    window.AudioContext = PreviewAudioContext;
    const supportedSink = HTMLMediaElement.prototype.setSinkId;
    HTMLMediaElement.prototype.setSinkId = undefined;
    button.click();
    await wait();
    stopped('unsupported output routing resets test');
    check(status.textContent === t('settings.microphoneTestFailed'), 'unsupported routing is explained instead of playing on the wrong speaker');
    HTMLMediaElement.prototype.setSinkId = supportedSink;

    captureMode = 'pending';
    const playsBeforePermission = plays.length;
    button.click();
    await wait();
    check(button.getAttribute('aria-pressed') === 'true' && pendingCapture, 'pending permission remains cancellable');
    button.click();
    const late = capture();
    pendingCapture.resolve(late);
    captureMode = 'normal';
    await wait();
    stopped('stop during permission keeps test stopped');
    check(late.getAudioTracks()[0].readyState === 'ended' && plays.length === playsBeforePermission, 'late permission is released without playback');

    sinkMode = 'pending';
    button.click();
    await wait();
    check(pendingSink && pendingSink.audio.srcObject, 'sink selection can be pending');
    const beforeSinkResume = plays.length;
    button.click();
    pendingSink.resolve();
    sinkMode = 'normal';
    await wait();
    check(plays.length === beforeSinkResume && pendingSink.audio.srcObject === null, 'late sink selection cannot start playback after stop');
    stopped('late sink selection keeps bar zero');

    playMode = 'pending';
    button.click();
    await wait();
    check(pendingPlay && pendingPlay.audio.srcObject, 'play promise can be pending');
    button.click();
    pendingPlay.resolve();
    playMode = 'normal';
    await wait();
    stopped('late play completion cannot reactivate test');
    check(pendingPlay.audio.srcObject === null, 'late play completion has no attached media');

    captureMode = 'denied';
    tab.startVadMeter(container);
    await wait();
    button.click();
    await wait();
    stopped('test reports permission denial even after passive preview failed');
    check(Boolean(status.textContent), 'permission failure is visible');
    captureMode = 'normal';
    button.click();
    await wait();
    check(button.getAttribute('aria-pressed') === 'true' && plays.at(-1).srcObject, 'explicit retry recovers a failed shared preview');
    button.click();
    tab.stopVadMeter();
    await wait();

    settings.inputMode = 'push_to_talk';
    voice.currentVoiceChannelId = 'voice-test';
    voice.isMuted = true;
    voice.isDeafened = true;
    voice.serverMuted = true;
    voice.serverDeafened = true;
    voice.pttPressed = false;
    raw = source.stream.clone();
    raw.getAudioTracks()[0].enabled = false;
    button.click();
    await wait();
    check(plays.at(-1).srcObject !== raw && plays.at(-1).srcObject?.getAudioTracks()[0].enabled, 'muted call uses independent local test capture');
    check(!raw.getAudioTracks()[0].enabled && voice.isMuted && voice.isDeafened && voice.serverMuted && voice.serverDeafened
      && !voice.pttPressed && settings.inputMode === 'push_to_talk', 'test preserves personal/admin/deafen/PTT state');
    button.click();
    check(raw.getAudioTracks()[0].readyState === 'live' && !raw.getAudioTracks()[0].enabled, 'stopping independent test preserves muted call track');
    const capturesBeforeBorrow = captures.length;
    raw.getAudioTracks()[0].enabled = true;
    button.click();
    await wait();
    check(captures.length === capturesBeforeBorrow && plays.at(-1).srcObject === raw, 'enabled call microphone is borrowed without capture duplication');
    const oldPlayback = plays.at(-1);
    raw.getAudioTracks()[0].enabled = false;
    appEvents.emit('voice.microphone_updated');
    await wait();
    check(oldPlayback.srcObject === null && plays.at(-1).srcObject !== raw, 'muting active raw track safely retargets an already-requested test');
    check(!raw.getAudioTracks()[0].enabled && voice.serverMuted, 'retarget never unmutes call');
    appEvents.emit('voice.channel_changed', null);
    await wait();
    stopped('call connection change stops local test');
    check(status.textContent === t('settings.microphoneTestDisconnected'), 'connection stop is explained');
    raw.getTracks().forEach((track) => track.stop());
    raw = null;
    voice.currentVoiceChannelId = null;

    button.click();
    await wait();
    const audioError = plays.at(-1);
    audioError.dispatchEvent(new Event('error'));
    await wait();
    stopped('media element runtime error stops test');
    check(audioError.srcObject === null && Boolean(status.textContent), 'runtime audio error releases playback and reports failure');
    button.click();
    await wait();
    captures.at(-1).getAudioTracks()[0].dispatchEvent(new Event('ended'));
    await wait();
    stopped('microphone ending stops test');
    check(Boolean(status.textContent), 'ended microphone reports error');

    button.click();
    await wait();
    container.style.display = 'none';
    await wait();
    stopped('hiding the settings tab stops playback');
    container.style.display = '';
    await wait();
    const beforeVisible = plays.length;
    await wait();
    check(plays.length === beforeVisible, 'showing tab again does not autoplay');
    button.click();
    await wait();
    container.remove();
    await wait();
    stopped('removing settings DOM stops playback');
    tab.cleanup();
    let captureStarts = 0;
    let captureStops = 0;
    const nativeCallbacks = new Set();
    const pendingStarts = [];
    window.api = {
      ...original.api,
      startPttCapture: () => {
        captureStarts++;
        return new Promise((resolve) => pendingStarts.push(resolve));
      },
      stopPttCapture: async () => { captureStops++; },
      onPttCaptured: (callback) => {
        nativeCallbacks.add(callback);
        return () => nativeCallbacks.delete(callback);
      },
    };
    pttContainer = document.createElement('div');
    document.body.append(pttContainer);
    pttTab = new VoiceVideoTab();
    pttContainer.innerHTML = pttTab.renderHtml();
    pttTab.attachEvents(pttContainer);
    captureMode = 'pending';
    pttContainer.querySelector('#btn-toggle-cam-preview').click();
    await wait();
    check(Boolean(pendingCapture?.constraints.video), 'camera permission can remain pending during tab change');
    pttTab.deactivate();
    const lateCamera = capture();
    pendingCapture.resolve(lateCamera);
    captureMode = 'normal';
    await wait();
    check(lateCamera.getTracks().every((track) => track.readyState === 'ended')
      && pttContainer.querySelector('#settings-cam-preview').srcObject === null, 'deactivation cancels late camera preview without leaking tracks');
    const record = pttContainer.querySelector('#btn-record-ptt-key');
    record.click();
    const captured = [...nativeCallbacks][0];
    const blockedKey = new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true, cancelable: true });
    pttContainer.dispatchEvent(blockedKey);
    check(captureStarts === 1 && nativeCallbacks.size === 1 && blockedKey.defaultPrevented, 'PTT recording installs its temporary native/keyboard capture');
    pttTab.deactivate();
    const normalKey = new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true, cancelable: true });
    pttContainer.dispatchEvent(normalKey);
    check(captureStops === 1 && nativeCallbacks.size === 0 && !normalKey.defaultPrevented, 'deactivate stops PTT recording and removes keyboard interception');
    check(record.textContent === t('settings.pttRecordShortcut') && !record.classList.contains('btn-primary'), 'deactivate resets PTT recording controls');
    captured({ keyType: 'keyboard', code: 'Y', keyCode: 21, display: 'Y' });
    pendingStarts.shift()(true);
    await wait();
    check(settings.pttKey === original.pttKey && nativeCallbacks.size === 0, 'late native PTT capture cannot change settings after deactivation');
    pttContainer.querySelector('#mode-card-vad').click();
    check(settings.inputMode === 'voice_activity', 'normal input-mode binding survives deactivation');
    pttContainer.querySelector('#mode-card-ptt').click();
    check(settings.inputMode === 'push_to_talk', 'input-mode binding still toggles after returning to voice settings');
    record.click();
    check(captureStarts === 2 && nativeCallbacks.size === 1, 'PTT record button remains bound without reattaching events');
    pttTab.cleanup();
    pendingStarts.shift()(true);
    await wait();
    check(captureStops === 2 && nativeCallbacks.size === 0, 'real cleanup deactivates and removes temporary PTT capture');
    pttContainer.remove();
    check(captures.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')), 'all owned capture tracks ended');
    check(contexts.every((context) => context.state === 'closed'), 'all preview contexts closed');
    check(plays.every((element) => element.srcObject === null), 'all playback elements detached');
    check(frames.size === 0, 'all test preview frame callbacks cancelled');
    offSpeaking();
    const finalListenerCount = Array.from(appEvents.listeners.values()).reduce((count, listeners) => count + listeners.size, 0);
    check(finalListenerCount === initialListenerCount, 'test and tab leave no EventBus listeners');
  } finally {
    offSpeaking();
    tab.cleanup();
    pttTab?.cleanup();
    pttContainer?.remove();
    container.remove();
    captures.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    raw?.getTracks().forEach((track) => track.stop());
    contexts.forEach((context) => { if (context.state !== 'closed') void context.close(); });
    plays.forEach((element) => { element.srcObject = null; original.pause.call(element); });
    frames.forEach((id) => window.clearTimeout(id));
    source.stream.getTracks().forEach((track) => track.stop());
    await sourceContext.close();
    window.AudioContext = original.AudioContext;
    window.requestAnimationFrame = original.raf;
    window.cancelAnimationFrame = original.cancelRaf;
    navigator.mediaDevices.getUserMedia = original.gum;
    navigator.mediaDevices.enumerateDevices = original.enumerate;
    HTMLMediaElement.prototype.play = original.play;
    HTMLMediaElement.prototype.pause = original.pause;
    HTMLMediaElement.prototype.setSinkId = original.sink;
    audio.getRawMicrophoneStream = original.raw;
    settings.selectedMicrophoneId = original.mic;
    settings.selectedSpeakerId = original.speaker;
    settings.inputMode = original.mode;
    voice.currentVoiceChannelId = original.channel;
    voice.isMuted = original.muted;
    voice.isDeafened = original.deafened;
    voice.serverMuted = original.serverMuted;
    voice.serverDeafened = original.serverDeafened;
    voice.pttPressed = original.ptt;
    voice.microphoneOpen = original.microphoneOpen;
    if (original.api === undefined) delete window.api;
    else window.api = original.api;
    settings.pttKey = original.pttKey;
    if (original.storage === null) localStorage.removeItem('monky_settings');
    else localStorage.setItem('monky_settings', original.storage);
  }
  return checks;
}
