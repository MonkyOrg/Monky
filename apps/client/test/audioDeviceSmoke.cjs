const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

module.exports = { runAudioDeviceSmoke };

if (require.main === module || process.argv[1] === __filename) {
  const clientRoot = path.resolve(__dirname, '..');
  if (!process.versions.electron) {
    const profile = path.join(clientRoot, 'dist-test', `audio-device-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_AUDIO_DEVICE_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: clientRoot, env, stdio: 'inherit' });
    const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
    child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
  } else {
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', process.env.MONKY_AUDIO_DEVICE_TEST_PROFILE);
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
          name: 'audio-device-fixture',
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              if (request.url !== '/__audio_devices__') return next();
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
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
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      timeout = setTimeout(() => { console.error('Audio device smoke timed out'); void finish(1); }, 45_000);
      await window.loadURL(`http://127.0.0.1:${address.port}/__audio_devices__`);
      const checks = await window.webContents.executeJavaScript(`(${runAudioDeviceSmoke.toString()})()`, true);
      console.log(`Audio device smoke: ${checks} checks passed`);
      if (process.argv.includes('--screenshots')) {
        window.setContentSize(760, 360);
        window.showInactive();
        await window.webContents.executeJavaScript(`(${renderAudioDevicePreview.toString()})()`, true);
        for (const kind of ['input', 'output']) {
          await window.webContents.executeJavaScript(`document.querySelector('[data-audio-device="${kind}"]').click()`, true);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const image = await window.webContents.capturePage();
          const filename = path.join(clientRoot, 'dist-test', `audio-device-${kind}.png`);
          fs.writeFileSync(filename, image.toPNG());
          console.log(`Screenshot: ${filename}`);
          if (kind === 'input') {
            await window.webContents.executeJavaScript(`document.querySelector('.audio-device-current').dispatchEvent(new MouseEvent('mouseenter')); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
            await window.webContents.executeJavaScript(`if (document.querySelector('.audio-device-options').getBoundingClientRect().left < document.querySelector('.audio-device-current').getBoundingClientRect().right) throw new Error('Device submenu must open beside the selected-device row when space is available')`);
            fs.writeFileSync(path.join(clientRoot, 'dist-test', 'audio-device-input-options.png'), (await window.webContents.capturePage()).toPNG());
          }
        }
        await window.webContents.executeJavaScript('window.cleanupAudioDevicePreview()', true);
      }
      await finish(0);
    }).catch(async (error) => { console.error(error); await finish(1); });
  }
}

async function renderAudioDevicePreview() {
  const [{ bindAudioDevicePopovers }] = await Promise.all([
    import('/views/AudioDevicePopover.ts'), import('/styles/fonts.css'),
  ]);
  const original = { gum: navigator.mediaDevices.getUserMedia, enumerate: navigator.mediaDevices.enumerateDevices };
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => destination.stream.clone();
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'usb-microphone', label: 'Microfone USB' },
    { kind: 'audiooutput', deviceId: 'default', label: 'Default' },
    { kind: 'audiooutput', deviceId: 'headphones', label: 'Fones de ouvido USB' },
  ];
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:12px;bottom:12px;padding:12px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:var(--radius-md)';
  root.innerHTML = `<div class="user-quick-actions">
    <div class="audio-control-group">
      <button class="btn-icon" aria-label="Microfone"><span class="material-symbols-outlined md-20">mic</span></button>
      <button class="audio-device-trigger" data-audio-device="input"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>
    </div>
    <div class="audio-control-group">
      <button class="btn-icon" aria-label="Fones"><span class="material-symbols-outlined md-20">headphones</span></button>
      <button class="audio-device-trigger" data-audio-device="output"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>
    </div>
    <button class="btn-icon" aria-label="Configurações"><span class="material-symbols-outlined md-20">settings</span></button>
  </div>`;
  document.body.append(root);
  const off = bindAudioDevicePopovers(root);
  window.cleanupAudioDevicePreview = async () => {
    off();
    root.remove();
    destination.stream.getTracks().forEach((track) => track.stop());
    await context.close();
    navigator.mediaDevices.getUserMedia = original.gum;
    navigator.mediaDevices.enumerateDevices = original.enumerate;
    delete window.cleanupAudioDevicePreview;
  };
  await document.fonts.ready;
}

async function runAudioDeviceSmoke() {
  const [{ bindAudioDevicePopovers }, { bindMicrophoneLevelMeter }, devices, { settingsStore: settings },
    { voiceStore: voice }, { audioProcessor: audio }, { appEvents }, { settingsModal }] = await Promise.all([
    import('/views/AudioDevicePopover.ts'), import('/core/MicrophoneLevelMeter.ts'),
    import('/core/AudioDeviceService.ts'), import('/stores/settingsStore.ts'),
    import('/stores/voiceStore.ts'),     import('/core/AudioProcessor.ts'), import('/core/EventBus.ts'), import('/views/SettingsModal.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 80));
  const original = {
    gum: navigator.mediaDevices.getUserMedia, enumerate: navigator.mediaDevices.enumerateDevices,
    AudioContext: window.AudioContext, raw: audio.getRawMicrophoneStream,
    sink: HTMLMediaElement.prototype.setSinkId, mic: settings.selectedMicrophoneId,
    speaker: settings.selectedSpeakerId, channel: voice.currentVoiceChannelId,
    muted: voice.isMuted, serverMuted: voice.serverMuted,
    raf: window.requestAnimationFrame, cancelRaf: window.cancelAnimationFrame,
    storage: localStorage.getItem('monky_settings'),
  };
  const input = new original.AudioContext();
  const destination = input.createMediaStreamDestination();
  const oscillator = input.createOscillator();
  oscillator.frequency.value = 900;
  oscillator.connect(destination);
  oscillator.start();
  await input.resume();
  const captures = [];
  const contexts = [];
  const sinks = [];
  const frames = new Set();
  // Hidden Electron windows do not consistently receive compositor frames.
  window.requestAnimationFrame = (callback) => {
    const id = window.setTimeout(() => { frames.delete(id); callback(performance.now()); }, 16);
    frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => { window.clearTimeout(id); frames.delete(id); };
  let captureError = null;
  let pending = null;
  let callStream = null;
  let list = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'mic-1', label: '<b>Microphone</b>' },
    { kind: 'audioinput', deviceId: 'mic-2', label: 'Microphone 2' },
    { kind: 'audiooutput', deviceId: 'speaker-1', label: 'Speaker' },
  ];
  navigator.mediaDevices.enumerateDevices = async () => list;
  navigator.mediaDevices.getUserMedia = async () => {
    if (captureError) throw captureError;
    if (pending) return await new Promise((resolve) => { pending.resolve = resolve; });
    const stream = destination.stream.clone();
    captures.push(stream);
    return stream;
  };
  class PreviewAudioContext extends original.AudioContext {
    constructor(...args) { super(...args); contexts.push(this); }
    createMediaStreamSource(stream) {
      this.previewStream = stream;
      return super.createMediaStreamSource(stream);
    }
    createAnalyser() {
      const analyser = super.createAnalyser();
      // Deterministic sample data, while retaining real streams/nodes/contexts:
      // CI may have no functioning audio output clock for the synthetic source.
      analyser.getByteFrequencyData = (buffer) => {
        const audible = this.previewStream?.getAudioTracks().some((track) => track.readyState === 'live' && track.enabled);
        buffer.fill(audible ? 96 : 0);
      };
      return analyser;
    }
  }
  window.AudioContext = PreviewAudioContext;
  HTMLMediaElement.prototype.setSinkId = async function (id) {
    if (id === 'broken') throw new DOMException('Gone', 'NotFoundError');
    sinks.push(id);
  };
  audio.getRawMicrophoneStream = () => callStream;
  settings.selectedMicrophoneId = '';
  settings.selectedSpeakerId = '';
  voice.currentVoiceChannelId = null;
  voice.isMuted = false;
  voice.serverMuted = false;
  const root = document.createElement('div');
  root.className = 'user-quick-actions';
  root.style.cssText = 'position:fixed;left:12px;bottom:12px';
  root.innerHTML = '<button class="btn-icon" data-audio-device="input">up</button><button class="btn-icon" data-audio-device="output">up</button><button id="outside-audio">outside</button>';
  document.body.append(root);
  const inputTrigger = root.querySelector('[data-audio-device="input"]');
  const outputTrigger = root.querySelector('[data-audio-device="output"]');
  const off = bindAudioDevicePopovers(root);
  const panel = () => document.querySelector('.audio-device-popover');
  let offExtra = () => {};
  let offApply = devices.registerAudioDeviceApplier(async () => {});
  try {
    inputTrigger.click();
    await wait();
    check(inputTrigger.getAttribute('aria-expanded') === 'true', 'input trigger expanded');
    check(getComputedStyle(inputTrigger).width === '18px', 'footer specificity preserves compact independent arrow');
    check(panel()?.querySelector('select')?.hidden && panel().querySelectorAll('.vad-meter').length === 1,
      'input panel replaces the native picker with a device row and shared meter');
    check(panel().querySelectorAll('button').length === 2 && !panel().querySelector('input'),
      'panel contains only device navigation and settings access, without adding volume/profile controls');
    check(panel().querySelector('option[value="mic-1"]').textContent === '<b>Microphone</b>' && !panel().querySelector('b'),
      'device labels are escaped by DOM options');
    check(panel().getBoundingClientRect().bottom <= inputTrigger.getBoundingClientRect().top, 'panel opens above anchor');
    const row = panel().querySelector('.audio-device-current');
    check(document.activeElement === row, 'focus moves into current device row');
    check(getComputedStyle(panel().querySelector('.vad-meter-fill')).maskImage.includes('data:image/svg+xml'),
      'input level uses the segmented meter design');
    row.dispatchEvent(new MouseEvent('mouseenter'));
    const submenu = document.querySelector('.audio-device-options');
    check(!submenu.hidden && row.getAttribute('aria-expanded') === 'true', 'hovering device row opens its submenu');
    check(submenu.querySelector('[data-device-id="mic-1"]').textContent.includes('<b>Microphone</b>') && !submenu.querySelector('b'),
      'submenu renders device names as text rather than HTML');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    check(submenu.contains(document.activeElement), 'ArrowRight moves focus into device choices');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    check(document.activeElement.dataset.deviceId === 'mic-2', 'End selects the last available device for keyboard navigation');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(submenu.hidden && !!panel() && document.activeElement === row, 'First Escape closes only the submenu and restores row focus');
    const extra = document.createElement('div');
    extra.className = 'vad-meter';
    extra.innerHTML = '<div class="vad-meter-fill"></div>';
    root.append(extra);
    offExtra = bindMicrophoneLevelMeter(extra);
    await wait();
    check(captures.length === 1 && contexts.length === 1, 'settings and popover reuse one local preview graph');
    check(Number(extra.getAttribute('aria-valuenow')) > 0, 'Shared meter exposes the measured input level accessibly');
    offExtra();
    check(extra.getAttribute('aria-valuenow') === '0', 'Stopping a meter clears its accessible level as well as its bar');
    extra.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait();
    check(!panel() && inputTrigger.getAttribute('aria-expanded') === 'false', 'Escape closes panel');
    check(document.activeElement === inputTrigger, 'Escape restores trigger focus');
    check(captures.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')), 'preview tracks stopped');
    check(contexts.every((context) => context.state === 'closed'), 'preview contexts closed');

    const captureCount = captures.length;
    outputTrigger.click();
    await wait();
    check(!panel().querySelector('.vad-meter') && captures.length === captureCount, 'output selector never captures microphone');
    const output = panel().querySelector('select');
    panel().querySelector('.audio-device-current').click();
    document.querySelector('.audio-device-options [data-device-id="speaker-1"]').click();
    await wait();
    check(settings.selectedSpeakerId === 'speaker-1' && sinks.includes('speaker-1'), 'output persisted and validated');
    check(panel().querySelector('.audio-device-current-value').textContent === 'Speaker', 'current row shows the applied device');
    output.value = '';
    output.dispatchEvent(new Event('change'));
    await wait();
    check(settings.selectedSpeakerId === '' && sinks.includes(''), 'system default output can be restored');
    output.add(new Option('Broken output', 'broken'));
    output.value = 'broken';
    output.dispatchEvent(new Event('change'));
    await wait();
    check(settings.selectedSpeakerId === '' && output.value === '', 'failed output selection preserves system default');
    root.querySelector('#outside-audio').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check(!panel(), 'outside pointer closes');
    const openSettings = settingsModal.open;
    let settingsTab = null;
    settingsModal.open = async tab => { settingsTab = tab; };
    try {
      outputTrigger.click();
      await wait();
      panel().querySelector('.audio-device-settings').click();
      check(settingsTab === 'voice_video' && !panel() && !document.querySelector('.audio-device-options'),
        'settings shortcut opens the voice tab after disposing both popup layers');
    } finally {
      settingsModal.open = openSettings;
    }

    pending = {};
    inputTrigger.click();
    await wait();
    check(typeof pending.resolve === 'function', 'permission capture is pending');
    inputTrigger.click();
    const late = destination.stream.clone();
    pending.resolve(late);
    pending = null;
    await wait();
    check(late.getTracks().every((track) => track.readyState === 'ended') && !panel(), 'late permission after close cannot leak capture');

    inputTrigger.click();
    await wait();
    const initialPreview = captures.at(-1);
    const outsideMic = panel().querySelector('select');
    outsideMic.value = 'mic-1';
    outsideMic.dispatchEvent(new Event('change'));
    await wait();
    check(settings.selectedMicrophoneId === 'mic-1' && JSON.parse(localStorage.getItem('monky_settings')).selectedMicrophoneId === 'mic-1',
      'outside-call input selection persists');
    check(initialPreview.getTracks().every((track) => track.readyState === 'ended'), 'device change releases previous preview');
    pending = {};
    outsideMic.value = 'mic-2';
    outsideMic.dispatchEvent(new Event('change'));
    await wait();
    inputTrigger.click();
    const cancelledProbe = destination.stream.clone();
    pending.resolve(cancelledProbe);
    pending = null;
    await wait();
    check(settings.selectedMicrophoneId === 'mic-1' && cancelledProbe.getTracks().every((track) => track.readyState === 'ended'),
      'closing during device permission cancels persistence and releases probe');

    window.AudioContext = class { constructor() { throw new Error('Audio graph failure'); } };
    inputTrigger.click();
    await wait();
    check(captures.at(-1).getTracks().every((track) => track.readyState === 'ended'), 'audio graph failure releases acquired tracks');
    check(Boolean(panel().querySelector('[role="status"]').textContent), 'audio graph failure shown');
    inputTrigger.click();
    window.AudioContext = PreviewAudioContext;
    inputTrigger.click();
    await wait();
    const endedPreview = captures.at(-1);
    endedPreview.getAudioTracks()[0].dispatchEvent(new Event('ended'));
    await wait();
    check(endedPreview.getTracks().every((track) => track.readyState === 'ended')
      && Boolean(panel().querySelector('[role="status"]').textContent), 'device-ended stops preview and reports unavailability');
    inputTrigger.click();

    captureError = new DOMException('Denied', 'NotAllowedError');
    inputTrigger.click();
    await wait();
    check(Boolean(panel().querySelector('[role="status"]').textContent), 'permission denial is visible');
    inputTrigger.click();
    captureError = null;
    callStream = destination.stream.clone();
    voice.currentVoiceChannelId = 'call';
    const beforeCall = captures.length;
    inputTrigger.click();
    await wait();
    check(captures.length === beforeCall, 'in-call preview reuses raw stream without capture');
    for (const mute of ['isMuted', 'serverMuted']) {
      voice[mute] = true;
      callStream.getAudioTracks().forEach((track) => { track.enabled = false; });
      appEvents.emit('voice.microphone_updated');
      await wait();
      check(callStream.getAudioTracks().every((track) => !track.enabled) && voice[mute],
        `${mute}: preview never unmutes live raw tracks or mute state`);
      const isolated = captures.at(-1);
      check(isolated !== callStream && isolated.getAudioTracks().every((track) => track.enabled && track.readyState === 'live'),
        `${mute}: independent local capture supplies preview`);
      check(parseFloat(panel().querySelector('.vad-meter-fill').style.width) > 0,
        `${mute}: muted call still has a useful local input level (width=${panel().querySelector('.vad-meter-fill').style.width}, source=${input.state}, meter=${contexts.at(-1).state})`);
      voice[mute] = false;
      callStream.getAudioTracks().forEach((track) => { track.enabled = true; });
      appEvents.emit('voice.microphone_updated');
      await wait();
      check(isolated.getAudioTracks().every((track) => track.readyState === 'ended'),
        `${mute}: unmuting releases isolated preview and returns to raw stream`);
    }
    const applyCalls = [];
    let pendingSwitch = null;
    offApply();
    offApply = devices.registerAudioDeviceApplier(async (kind, id, signal) => {
      applyCalls.push([kind, id]);
      if (pendingSwitch) {
        pendingSwitch.signal = signal;
        await new Promise((resolve) => { pendingSwitch.resolve = resolve; });
        return;
      }
      if (id === 'mic-2') throw new Error('Replacement failed');
    });
    let mic = panel().querySelector('select');
    mic.value = 'mic-1';
    mic.dispatchEvent(new Event('change'));
    await wait();
    check(settings.selectedMicrophoneId === 'mic-1' && applyCalls[0]?.join(':') === 'input:mic-1', 'selection awaits existing live switch then persists');
    mic.value = 'mic-2';
    mic.dispatchEvent(new Event('change'));
    await wait();
    check(settings.selectedMicrophoneId === 'mic-1' && mic.value === 'mic-1', 'failed replacement retains previous selection');
    check(Boolean(panel().querySelector('[role="status"]').textContent), 'failed switch shown');
    pendingSwitch = {};
    mic.value = 'mic-2';
    mic.dispatchEvent(new Event('change'));
    await wait();
    inputTrigger.click();
    check(pendingSwitch.signal?.aborted, 'closing forwards cancellation to the in-call switch adapter');
    pendingSwitch.resolve();
    pendingSwitch = null;
    await wait();
    check(settings.selectedMicrophoneId === 'mic-1', 'aborted in-call switch never persists late success');
    inputTrigger.click();
    await wait();
    mic = panel().querySelector('select');
    const previousCall = callStream;
    const beforeReplacement = captures.length;
    callStream = destination.stream.clone();
    appEvents.emit('voice.microphone_updated');
    await wait();
    check(captures.length === beforeReplacement && contexts.at(-1).state === 'running', 'live stream replacement retargets meter without new capture');
    previousCall.getTracks().forEach((track) => track.stop());
    list = [];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await wait();
    check(mic.querySelector('option[value="mic-1"]')?.disabled && mic.value === 'mic-1', 'hotplug preserves missing device explicitly');
    inputTrigger.click();
    check(callStream.getAudioTracks().every((track) => track.readyState === 'live' && track.enabled),
      'closing borrowed preview leaves call tracks alive and unchanged');
    voice.serverMuted = true;
    callStream.getAudioTracks().forEach((track) => { track.enabled = false; });
    inputTrigger.click();
    await wait();
    const mutedPreview = captures.at(-1);
    inputTrigger.click();
    check(mutedPreview.getAudioTracks().every((track) => track.readyState === 'ended'),
      'closing a muted-call panel stops its isolated preview');
    check(voice.serverMuted && callStream.getAudioTracks().every((track) => track.readyState === 'live' && !track.enabled),
      'closing isolated preview preserves admin mute and call tracks');
    voice.serverMuted = false;
    callStream.getTracks().forEach((track) => track.stop());
    callStream = null;
    voice.currentVoiceChannelId = null;
    inputTrigger.click();
    await wait();
    appEvents.emit('network.disconnected');
    await wait();
    check(!panel(), 'disconnect closes panel and capture');
    inputTrigger.click();
    await wait();
    root.remove();
    await wait();
    check(!panel(), 'detached anchor removes panel');
    check(captures.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')), 'all owned capture tracks cleaned up');
    check(contexts.every((context) => context.state === 'closed'), 'all preview contexts cleaned up');
    check(frames.size === 0, 'all preview animation callbacks cancelled');
  } finally {
    off();
    offExtra();
    offApply();
    root.remove();
    captures.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    callStream?.getTracks().forEach((track) => track.stop());
    contexts.forEach((context) => { if (context.state !== 'closed') void context.close(); });
    frames.forEach((id) => window.clearTimeout(id));
    window.requestAnimationFrame = original.raf;
    window.cancelAnimationFrame = original.cancelRaf;
    oscillator.stop();
    oscillator.disconnect();
    destination.stream.getTracks().forEach((track) => track.stop());
    await input.close();
    window.AudioContext = original.AudioContext;
    navigator.mediaDevices.getUserMedia = original.gum;
    navigator.mediaDevices.enumerateDevices = original.enumerate;
    HTMLMediaElement.prototype.setSinkId = original.sink;
    audio.getRawMicrophoneStream = original.raw;
    settings.selectedMicrophoneId = original.mic;
    settings.selectedSpeakerId = original.speaker;
    voice.currentVoiceChannelId = original.channel;
    voice.isMuted = original.muted;
    voice.serverMuted = original.serverMuted;
    if (original.storage === null) localStorage.removeItem('monky_settings');
    else localStorage.setItem('monky_settings', original.storage);
  }
  return checks;
}
