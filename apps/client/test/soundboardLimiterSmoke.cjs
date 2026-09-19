const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runCustomSoundsSmoke } = require('./fixtures/customSounds.cjs');

const clientRoot = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `soundboard-limiter-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_SOUNDBOARD_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_SOUNDBOARD_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  let vite;
  let window;
  let timeout;
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { SoundboardDownloads } = require(path.join(clientRoot, 'dist-electron', 'main', 'soundboardDownload.js'));
    const downloads = new SoundboardDownloads(path.join(app.getPath('userData'), 'soundboard-folder.json'));
    const folder = await downloads.getDefaultFolder();
    if (!folder) throw new Error('The new profile did not receive its default soundboard folder');
    const bytes = wav();
    fs.writeFileSync(path.join(folder, 'authored.wav'), bytes);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'soundboard-limiter-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__soundboard_limiter__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"></head><body><main id="fixture"></main></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing soundboard fixture server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing soundboard fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    window = new BrowserWindow({
      show: false, width: 1000, height: 850, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: url.origin !== origin && !['data:', 'blob:'].includes(url.protocol) });
    });
    timeout = setTimeout(() => { console.error('Soundboard limiter smoke timed out'); void finish(1); }, 90_000);
    await window.loadURL(`${origin}/__soundboard_limiter__`);
    await window.webContents.executeJavaScript('document.fonts.ready', true);
    const checks = await window.webContents.executeJavaScript(`(${runSmoke.toString()})(${JSON.stringify({
      folder, base64: bytes.toString('base64'), shortBase64: wav(0.02).toString('base64'), size: bytes.length,
    })})`, true);
    console.log(`Soundboard limiter smoke: ${checks} checks passed (real AudioWorklet, mixed PCM, local UI and resource teardown; physical audio muted)`);
    await window.webContents.executeJavaScript(`(${setupModalSmoke.toString()})()`, true);
    window.focus();
    window.webContents.focus();
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const key = async keyCode => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await new Promise(resolve => setTimeout(resolve, 20));
    };
    const pointerTarget = value => window.webContents.executeJavaScript(`window.limiterModalSmoke.pointerTarget(${value})`, true);
    const mouse = (type, point) => window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: type === 'mouseDown' ? 'mousePressed' : type === 'mouseUp' ? 'mouseReleased' : 'mouseMoved',
      ...point, button: 'left', buttons: type === 'mouseUp' ? 0 : 1, clickCount: type === 'mouseMove' ? 0 : 1,
    });
    for (const locale of ['pt-BR', 'en']) {
      await window.webContents.executeJavaScript(`window.limiterModalSmoke.open(${JSON.stringify(locale)})`, true);
      const start = await pointerTarget(3);
      await mouse('mouseDown', start);
      await mouse('mouseUp', start);
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(3, false)', true);
      await mouse('mouseDown', start);
      await mouse('mouseMove', await pointerTarget(8));
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(8, false)', true);
      const end = await pointerTarget(4);
      await mouse('mouseMove', end);
      await mouse('mouseUp', end);
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(4, false)', true);
      await window.webContents.executeJavaScript('window.limiterModalSmoke.focusToggle()', true);
      await key('Space');
      await window.webContents.executeJavaScript('window.limiterModalSmoke.enabled()', true);
      await key('Tab');
      await window.webContents.executeJavaScript('window.limiterModalSmoke.sliderFocused()', true);
      await key('Left');
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(5)', true);
      await key('Home');
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(1)', true);
      await key('End');
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(10)', true);
      await window.webContents.executeJavaScript('window.limiterModalSmoke.liveMeter()', true);
      await mouse('mouseDown', await pointerTarget(6));
      await mouse('mouseMove', await pointerTarget(4));
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(4, false)', true);
      const liveEnd = await pointerTarget(6);
      await mouse('mouseMove', liveEnd);
      await mouse('mouseUp', liveEnd);
      await window.webContents.executeJavaScript('window.limiterModalSmoke.value(6, false)', true);
      window.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 });
      window.setContentSize(640, 620);
      await window.webContents.executeJavaScript('window.limiterModalSmoke.visible()', true);
      fs.writeFileSync(path.join(clientRoot, 'dist-test', `soundboard-limiter-${locale}.png`), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(1000, 850);
      await window.webContents.executeJavaScript('window.limiterModalSmoke.failuresAndCleanup()', true);
    }
    const modalChecks = await window.webContents.executeJavaScript('window.limiterModalSmoke.finish()', true);
    console.log(`Soundboard modal limiter: ${modalChecks} checks passed (native keyboard, PT/EN, shared preferences, failures, resize and cleanup)`);
    const customChecks = await window.webContents.executeJavaScript(`(${runCustomSoundsSmoke.toString()})(${JSON.stringify(bytes.toString('base64'))})`, true);
    console.log(`Custom sound effects smoke: ${customChecks} checks passed (all catalogue entries, real media, overrides, defaults, locales and cleanup)`);
    await finish(0);
  }).catch(async error => {
    console.error(error);
    if (window && !window.isDestroyed()) {
      fs.writeFileSync(path.join(clientRoot, 'dist-test', 'soundboard-limiter-failure.png'), (await window.webContents.capturePage()).toPNG());
    }
    await finish(1);
  });
}

function wav(seconds = 1) {
  const rate = 48000;
  const frames = Math.round(rate * seconds);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * frame / rate) * 30000), 44 + frame * 2);
  return bytes;
}

async function runSmoke(fixture) {
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const until = async (probe, message) => {
    const deadline = Date.now() + 5000;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const originalContext = window.AudioContext;
  const contexts = [];
  window.AudioContext = class extends originalContext {
    constructor(...args) { super(...args); contexts.push(this); }
  };
  let folderRequests = 0;
  const sound = { fileName: 'authored.wav', soundName: 'Authored tone', mimeType: 'audio/wav',
    base64: fixture.base64, dataUrl: `data:audio/wav;base64,${fixture.base64}`, sizeBytes: fixture.size };
  window.api = {
    getDefaultSoundboardFolder: async () => { folderRequests++; return fixture.folder; },
    listSoundboardSounds: async folder => {
      if (folder !== fixture.folder) throw new Error('Unexpected fixture folder');
      return [{ name: sound.soundName, fileName: sound.fileName, filePath: `${folder}/authored.wav`, sizeBytes: fixture.size, ext: '.wav' }];
    },
    soundDownloadAvailability: async folder => folder === fixture.folder ? 'ready' : 'no_folder',
    readSoundboardSound: async () => sound,
  };
  const [{ settingsStore }, { soundboardService }, { SoundboardTab }, { appEvents }, language] = await Promise.all([
    import('/stores/settingsStore.ts'), import('/core/SoundboardService.ts'), import('/views/settings/tabs/SoundboardTab.ts'),
    import('/core/EventBus.ts'), import('/i18n/index.ts'),
  ]);
  const workletUrl = new URL('/audio/soundboardLimiter.worklet.js', window.location.href).href;
  const tab = new SoundboardTab();
  const root = document.getElementById('fixture');
  try {
    await until(() => soundboardService.getLoadStatus() === 'ready', 'Default folder did not finish loading');
    check(folderRequests === 1 && settingsStore.soundboardFolderPath === fixture.folder && soundboardService.getSounds().length === 1,
      'The renderer selects and loads the native default folder without a picker');
    check(!settingsStore.soundboardLimiterEnabled, 'The limiter starts disabled on a new profile');
    const renderMixed = async (enabled, limitLevel) => {
      const context = new OfflineAudioContext(2, 48000, 48000);
      await context.audioWorklet.addModule(workletUrl);
      const mixer = context.createGain();
      mixer.gain.value = 0.8;
      const limiter = new AudioWorkletNode(context, 'monky-soundboard-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        parameterData: { enabled: enabled ? 1 : 0, limitLevel },
      });
      mixer.connect(limiter);
      limiter.connect(context.destination);
      const sources = [];
      for (let index = 0; index < 2; index++) {
        const source = context.createOscillator();
        const gain = context.createGain();
        source.frequency.value = 1000;
        gain.gain.value = 0.75;
        source.connect(gain).connect(mixer);
        source.start();
        sources.push(source, gain);
      }
      const rendered = await context.startRendering();
      let peak = 0;
      for (const sample of rendered.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
      limiter.disconnect();
      limiter.port.close();
      mixer.disconnect();
      for (const source of sources) source.disconnect();
      let power = 0;
      for (let frame = 14400; frame < 38400; frame++) power += rendered.getChannelData(0)[frame] ** 2;
      return { peak, sineLevel: 20 * Math.log10(Math.SQRT2 * Math.sqrt(power / 24000)) };
    };
    check(Math.abs((await renderMixed(false, 1)).peak - 1.2) < 1e-6, 'Disabled limiting preserves the real mixed PCM and selected volume');
    for (const limitLevel of [1, 6, 10]) {
      const { peak, sineLevel } = await renderMixed(true, limitLevel);
      check(peak <= 10 ** (-1 / 20) + 1e-7 && Math.abs(sineLevel - (-36 + 3 * limitLevel)) < 0.15,
        `The real AudioWorklet limits mixed loudness at level ${limitLevel}: ${sineLevel}`);
    }
    for (const locale of ['en', 'pt-BR']) {
      tab.cleanup();
      language.setLanguage(locale);
      root.innerHTML = tab.renderHtml();
      tab.attachEvents(root);
      const toggle = root.querySelector('#checkbox-soundboard-limiter');
      const slider = root.querySelector('#slider-soundboard-ceiling');
      check(!!toggle.closest('.toggle-switch'), 'Limiter activation uses the accessible switch component');
      if (!settingsStore.soundboardLimiterEnabled) {
        check(!slider.disabled, 'The ceiling can be configured before opting in');
        toggle.click();
        await until(() => !toggle.disabled, 'Limiter readiness check did not finish');
      }
      check(settingsStore.soundboardLimiterEnabled && !slider.disabled, 'Activation checks the real audio graph before persisting');
      slider.value = '5';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      check(settingsStore.soundboardLoudnessLimit === 5 && slider.getAttribute('aria-valuetext') === language.t('settings.soundboardLimitLevel', { level: 5 }),
        'The ceiling slider updates persistent settings and accessible output');
      check(root.textContent.includes(locale === 'en' ? 'Loudness ceiling' : 'Teto de intensidade'), 'Limiter UI follows the chosen language');
    }

    settingsStore.soundboardVolume = 100;
    settingsStore.soundboardMuted = false;
    settingsStore.save();
    const payload = { userId: 'remote-one', userName: 'Remote fixture', channelId: 'voice',
      soundName: sound.soundName, mimeType: sound.mimeType, audioBase64: fixture.base64 };
    const originalPayload = JSON.stringify(payload);
    await Promise.all([
      soundboardService.handleIncomingSound(payload),
      soundboardService.handleIncomingSound({ ...payload, userId: 'remote-two' }),
    ]);
    await until(() => soundboardService.getActivePlaybacks().length === 2, 'Concurrent soundboard playback did not start');
    const graph = soundboardService.audioOutput.graph;
    check(graph.context instanceof originalContext && graph.limiter instanceof AudioWorkletNode,
      'Incoming sounds use a real native audio context and limiter');
    check(soundboardService.audioOutput.sources.size === 2, 'Concurrent listeners share one final limiting graph');
    check(graph.limiter.parameters.get('enabled').value === 1 && graph.limiter.parameters.get('limitLevel').value === 5,
      'The live graph uses the listener preferences');
    check(JSON.stringify(payload) === originalPayload, 'Local limiting does not rewrite the received or forwarded audio');
    settingsStore.soundboardVolume = 25;
    settingsStore.save();
    check(graph.mixer.gain.value === 0.25, 'The existing volume control stays before the limiter');
    appEvents.emit('local.deafened', true);
    check(graph.gate.gain.value === 0, 'Deafen also silences already buffered limiter output');
    check(soundboardService.getIntensity() === 0, 'Deafen clears audible intensity without waiting for buffered reports');
    appEvents.emit('local.deafened', false);
    check(graph.gate.gain.value === 1, 'Undeafen restores the selected local volume');
    soundboardService.stopSound();
    await until(() => contexts.every(context => context.state === 'closed'), 'Stopped soundboards left a live audio context');
    check(soundboardService.audioOutput.sources.size === 0, 'Stopping removes media sources and their cancellation listeners');
    check(soundboardService.getIntensity() === null, 'Stopping clears the cached meter instead of retaining its last reading');
    check(await soundboardService.playSound('authored.wav'), 'Local library preview starts outside a voice call');
    await until(() => soundboardService.getActivePlaybacks().length === 1, 'Local preview did not become active');
    check(soundboardService.audioOutput.graph.limiter.parameters.get('enabled').value === 1,
      'Library previews use the same limiter as received clips');
    soundboardService.stopSound();
    await until(() => contexts.every(context => context.state === 'closed'), 'Preview cleanup left a live audio context');
    check(contexts.length >= 3, 'Readiness, received clips and preview lifecycles were exercised separately');
    await soundboardService.handleIncomingSound({ ...payload, userId: 'short-tail', audioBase64: fixture.shortBase64 });
    const shortGraph = soundboardService.audioOutput.graph;
    const shortAudio = soundboardService.activePlaybacks.get('short-tail')?.audio;
    check(!!shortAudio && !!shortGraph, 'A clip shorter than the look-ahead starts normally');
    let endedAt = null;
    shortAudio.addEventListener('ended', () => { endedAt = performance.now(); }, { once: true });
    await until(() => endedAt !== null, 'The short clip did not finish naturally');
    check(shortGraph.context.state === 'running', 'Natural end preserves the buffered audio graph');
    await until(() => shortGraph.context.state === 'closed', 'Natural end did not release the audio graph');
    check(performance.now() - endedAt >= 100, 'The full loudness look-ahead drains before closing the output');
    check(soundboardService.audioOutput.sources.size === 0, 'Natural completion removes the short media source');
    check(soundboardService.getIntensity() === null, 'Natural completion also clears the meter');
  } finally {
    tab.cleanup();
    soundboardService.stopSound();
    root.replaceChildren();
    window.AudioContext = originalContext;
  }
  return checks;
}

async function setupModalSmoke() {
  const [{ settingsStore }, { soundboardService }, { SoundboardModal }, { SoundboardTab }, { appEvents }, language] = await Promise.all([
    import('/stores/settingsStore.ts'), import('/core/SoundboardService.ts'), import('/views/SoundboardModal.ts'),
    import('/views/settings/tabs/SoundboardTab.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
  ]);
  const modal = new SoundboardModal();
  const tab = new SoundboardTab();
  const root = document.getElementById('fixture');
  const subscriptions = () => (appEvents.listeners.get('settings.updated')?.size ?? 0)
    + (appEvents.listeners.get('soundboard.intensity')?.size ?? 0);
  const baseline = subscriptions();
  const prepare = soundboardService.prepareLimiter;
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const until = async (probe, message) => {
    const end = Date.now() + 5000;
    while (!probe()) {
      if (Date.now() >= end) throw new Error(typeof message === 'function' ? message() : message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const toggle = () => document.getElementById('checkbox-soundboard-modal-limiter');
  const slider = () => document.getElementById('slider-soundboard-modal-ceiling');
  const dismiss = async key => {
    await until(() => document.querySelector('.dialog-card'), 'Expected limiter error dialog');
    check(document.querySelector('.dialog-message').textContent === language.t(key), 'Failures use the selected language');
    document.querySelector('.dialog-card [data-action="confirm"]').click();
    await until(() => !toggle().disabled, 'Limiter remained busy after acknowledging the error');
  };
  window.limiterModalSmoke = {
    async open(locale) {
      modal.close();
      tab.cleanup();
      language.setLanguage(locale);
      settingsStore.soundboardLimiterEnabled = false;
      settingsStore.soundboardLoudnessLimit = 6;
      settingsStore.save();
      root.innerHTML = tab.renderHtml();
      tab.attachEvents(root);
      await modal.open();
      check(toggle().closest('.sb-limiter-toolbar') !== null, 'The limiter is directly visible below the modal volume toolbar');
      check(toggle().getAttribute('role') === 'switch' && toggle().closest('.toggle-switch'), 'Uses the accessible switch, not an isolated checkbox');
      check(toggle().labels[0].textContent === language.t('settings.soundboardLimiter'), 'Switch has a localized accessible name');
      check(slider().labels[0].textContent === language.t('settings.soundboardCeiling'), 'Slider has a localized accessible name');
      check(!slider().disabled && !toggle().checked, 'Limiting starts off but choosing its ceiling is allowed');
      check(document.querySelector('[data-limiter-meter]').hidden, 'No fabricated level is shown while idle');
    },
    pointerTarget(value) {
      const rect = slider().getBoundingClientRect();
      return { x: Math.round(rect.left + 7 + (rect.width - 14) * (value - 1) / 9), y: Math.round(rect.top + rect.height / 2) };
    },
    focusToggle() {
      check(!settingsStore.soundboardLimiterEnabled, 'Editing a ceiling does not silently activate limiting');
      settingsStore.soundboardLoudnessLimit = 6;
      settingsStore.save();
      toggle().focus();
    },
    async enabled() {
      await until(() => settingsStore.soundboardLimiterEnabled && !toggle().disabled, 'Native Space did not enable the limiter');
      check(root.querySelector('#checkbox-soundboard-limiter').checked, 'Modal activation synchronizes the settings view');
      check(document.activeElement === toggle(), 'Keyboard focus survives asynchronous preparation');
      check(getComputedStyle(toggle().closest('.toggle-switch')).outlineStyle === 'solid',
        `Switch focus is visible (document=${document.hasFocus()}, focus-visible=${toggle().matches(':focus-visible')})`);
    },
    sliderFocused() {
      check(document.activeElement === slider(), 'Native Tab reaches the ceiling control');
    },
    async value(expected, keyboard = true) {
      await until(() => settingsStore.soundboardLoudnessLimit === expected,
        () => `Native input did not reach ceiling ${expected}; current value is ${settingsStore.soundboardLoudnessLimit}`);
      check(settingsStore.soundboardLoudnessLimit === expected,
        `Native pointer or keyboard input changes the ceiling: expected ${expected}, got ${settingsStore.soundboardLoudnessLimit}`);
      check(slider().getAttribute('aria-valuetext') === language.t('settings.soundboardLimitLevel', { level: expected }), 'Screen readers receive the level');
      check(root.querySelector('#slider-soundboard-ceiling').value === String(expected), 'Modal changes synchronize the settings slider');
      check(JSON.parse(localStorage.getItem('monky_settings')).soundboardLoudnessLimit === expected, 'The shared preference is persisted');
      if (keyboard) check(getComputedStyle(slider()).outlineStyle === 'solid', 'Slider focus is visible');
    },
    async liveMeter() {
      settingsStore.soundboardLoudnessLimit = 6;
      settingsStore.soundboardVolume = 100;
      settingsStore.save();
      check(await soundboardService.playSound('authored.wav'), 'Real audio drives the modal meter');
      const playback = soundboardService.activePlaybacks.get('local');
      check(!!playback, 'The meter has an actual preview source');
      playback.audio.loop = true;
      const controls = toggle().closest('.sb-limiter-controls');
      const meter = controls.querySelector('[data-limiter-meter]');
      const track = controls.querySelector('[data-limiter-track]');
      const current = controls.querySelector('[data-limiter-current]');
      const formatter = new Intl.NumberFormat(language.getLanguage(), { maximumFractionDigits: 1, minimumFractionDigits: 1 });
      await until(() => soundboardService.getIntensity() > 10, 'Live input level did not reach the UI');
      check(!meter.hidden && meter.getAttribute('aria-valuenow') === '10', 'The visual meter bounds are accessible');
      const value = soundboardService.getIntensity();
      check(current.textContent === language.t('soundboard.intensityCurrent', { value: formatter.format(value) }),
        'Actual over-range input is shown, not replaced by the selected ceiling');
      check(controls.dataset.intensityState === 'above', 'Excessive input is marked above the ceiling');
      check(root.querySelector('[data-limiter-current]').textContent === current.textContent,
        'Settings and modal receive the same real audio measurement');
      const markerAtMaximum = meter.getBoundingClientRect();
      check(Math.abs(markerAtMaximum.x + markerAtMaximum.width / 2 - (track.getBoundingClientRect().right - 7)) < 1,
        'The over-range marker is positioned at the end of the real track');
      settingsStore.soundboardVolume = 8;
      settingsStore.save();
      await until(() => controls.dataset.intensityState === 'below' && soundboardService.getIntensity() > 0,
        'Quieter audio did not enter the green band');
      check(controls.querySelector('[data-limiter-status]').textContent === language.t('soundboard.intensityBelow'),
        'Green has a textual meaning, not color alone');
      settingsStore.soundboardVolume = 13;
      settingsStore.save();
      await until(() => controls.dataset.intensityState === 'near', 'Audio near the ceiling did not enter the yellow band');
      check(controls.querySelector('[data-limiter-status]').textContent === language.t('soundboard.intensityNear'),
        'Yellow has a textual meaning');
      settingsStore.soundboardVolume = 25;
      settingsStore.save();
      await until(() => controls.dataset.intensityState === 'above' && soundboardService.getIntensity() < 9,
        'Louder audio did not return to the red band');
      const expected = (soundboardService.getIntensity() - 1) / 9;
      const marker = meter.getBoundingClientRect();
      const bounds = track.getBoundingClientRect();
      check(Math.abs(marker.x + marker.width / 2 - (bounds.x + 7 + (bounds.width - 14) * expected)) < 1,
        'The marker moves to the measured position rather than a CSS default');
      check(getComputedStyle(controls.querySelector('.sb-limiter-bands')).backgroundImage.includes('linear-gradient'),
        'Color bands are actually painted on the slider track');
      const before = soundboardService.getIntensity();
      settingsStore.soundboardLoudnessLimit = 9;
      settingsStore.save();
      check(controls.dataset.intensityState === 'below', 'Moving the ceiling reclassifies the same signal immediately');
      check(soundboardService.getIntensity() === before, 'Moving the ceiling does not fabricate a different source level');
      check(track.style.getPropertyValue('--limit-position').startsWith('88.88'), 'Color boundaries follow the selected ceiling');
      let bypassReports = 0;
      const unbindReports = appEvents.on('soundboard.intensity', () => { bypassReports++; });
      try {
        settingsStore.soundboardLimiterEnabled = false;
        settingsStore.save();
        await until(() => bypassReports >= 3 && soundboardService.getIntensity() > 7 && soundboardService.getIntensity() < 8,
          'Fresh meter reports must continue when limiting is bypassed');
      } finally { unbindReports(); }
      check(!meter.hidden && !slider().disabled && controls.querySelector('[data-limiter-status]').textContent === language.t('soundboard.limiterInactive'),
        'Measurement and ceiling adjustment remain usable while the limiter is off');
      settingsStore.soundboardLimiterEnabled = true;
      settingsStore.soundboardLoudnessLimit = 6;
      settingsStore.save();
    },
    async visible() {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const card = document.querySelector('.soundboard-modal-card').getBoundingClientRect();
      for (const element of [toggle().closest('.toggle-switch'), slider(), document.getElementById('sb-btn-close')]) {
        const box = element.getBoundingClientRect();
        check(box.width > 0 && box.height > 0 && box.top >= card.top && box.bottom <= card.bottom + 1 &&
          box.left >= card.left && box.right <= card.right + 1,
          `Limiter and close button remain visible at 640x620: ${JSON.stringify({ id: element.id, box: box.toJSON(), card: card.toJSON() })}`);
      }
      const box = slider().getBoundingClientRect();
      check(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === slider(), 'The ceiling is not covered by another modal surface');
    },
    async failuresAndCleanup() {
      soundboardService.stopSound();
      check(toggle().closest('.sb-limiter-controls').querySelector('[data-limiter-meter]').hidden,
        'Stopping immediately hides the live marker');
      const settingsSlider = root.querySelector('#slider-soundboard-ceiling');
      settingsSlider.value = '4';
      settingsSlider.dispatchEvent(new Event('input', { bubbles: true }));
      check(slider().value === '4', 'Synchronization also works from settings back to the modal');
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'monky_settings') throw new DOMException('Synthetic storage failure', 'QuotaExceededError');
        return Reflect.apply(setItem, this, [key, value]);
      };
      try {
        slider().value = '7';
        slider().dispatchEvent(new Event('input', { bubbles: true }));
      } finally { Storage.prototype.setItem = setItem; }
      await dismiss('soundboard.limiterSaveFailed');
      check(settingsStore.soundboardLoudnessLimit === 4 && slider().value === '4',
        'A failed save rolls back the ceiling and the visible value');
      Storage.prototype.setItem = function(key, value) {
        if (key === 'monky_settings') throw new DOMException('Synthetic storage failure', 'QuotaExceededError');
        return Reflect.apply(setItem, this, [key, value]);
      };
      try {
        toggle().focus();
        toggle().click();
        await dismiss('soundboard.limiterSaveFailed');
        check(settingsStore.soundboardLimiterEnabled && toggle().checked,
          'A failed switch save restores the previous state');
        check(document.activeElement === toggle(), 'Acknowledging an error restores focus in the still-open soundboard');
      } finally { Storage.prototype.setItem = setItem; }
      settingsStore.soundboardLimiterEnabled = false;
      settingsStore.save();
      soundboardService.prepareLimiter = async () => { throw new Error('Synthetic unavailable limiter'); };
      try {
        toggle().click();
        await dismiss('soundboard.limiterUnavailable');
        check(!settingsStore.soundboardLimiterEnabled && !toggle().checked && !slider().disabled,
          'An unavailable graph cannot be enabled from the modal');
      } finally { soundboardService.prepareLimiter = prepare; }
      let resolve;
      soundboardService.prepareLimiter = () => new Promise(done => { resolve = done; });
      try {
        toggle().click();
        check(toggle().disabled, 'Preparation blocks duplicate requests');
        modal.close();
        resolve();
        await new Promise(done => setTimeout(done, 20));
        check(!settingsStore.soundboardLimiterEnabled, 'Closing during preparation cannot enable a stale control');
      } finally { soundboardService.prepareLimiter = prepare; }
      const settingsOnly = subscriptions();
      for (let count = 0; count < 5; count++) {
        await modal.open();
        const detached = slider();
        modal.close();
        detached.value = '8';
        detached.dispatchEvent(new Event('input', { bubbles: true }));
        check(settingsStore.soundboardLoudnessLimit === 4, 'Closed controls cannot mutate settings');
        check(subscriptions() === settingsOnly, 'Repeated openings do not retain settings listeners');
      }
      await modal.open();
      check(slider().value === '4' && !toggle().checked, 'Reopening restores the shared preference');
    },
    finish() {
      soundboardService.stopSound();
      modal.close();
      tab.cleanup();
      root.replaceChildren();
      check(subscriptions() === baseline, 'Both surfaces release their subscriptions');
      return checks;
    },
  };
}
