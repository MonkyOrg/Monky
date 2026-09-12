const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runBotSettingsDomSmoke } = require(path.join(__dirname, 'botSettingsDomSmoke.cjs'));

const clientRoot = path.resolve(__dirname, '..');
const output = path.join(clientRoot, 'dist-test');

if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true });
  const profile = path.join(output, `command-dom-profile-${process.pid}`);
  const env = { ...process.env, MONKY_COMMAND_DOM_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_COMMAND_DOM_PROFILE);
  let vite;
  let window;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
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
        name: 'command-dom-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__command_dom_smoke__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"><link rel="stylesheet" href="/styles/footerControls.css"></head><body><div id="app"></div></body></html>');
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
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('DOM smoke timed out'); void finish(1); }, 60_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__command_dom_smoke__`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    window.webContents.focus();
    if (process.argv.includes('--bot-settings-only')) {
      const checks = await window.webContents.executeJavaScript(`(${runBotSettingsDomSmoke.toString()})()`, true);
      await window.webContents.executeJavaScript('document.body.innerHTML = window.botSettingsPreviewMarkup', true);
      fs.writeFileSync(path.join(output, 'bot-settings.png'), (await window.webContents.capturePage()).toPNG());
      console.log(`Bot settings DOM smoke: ${checks} checks passed`);
      await finish(0);
      return;
    }
    const previewChecks = await window.webContents.executeJavaScript(`(${runAudioPreviewLifecycleSmoke.toString()})()`, true);
    console.log(`Audio preview lifecycle: ${previewChecks} checks passed`);
    if (process.argv.includes('--autocomplete-only')) {
      const checks = await window.webContents.executeJavaScript(`(${runAutocompleteDomSmoke.toString()})()`, true);
      await runLocalDownloadGestureSmoke(window);
      const preferenceChecks = await window.webContents.executeJavaScript('window.autocompletePreferencesSmoke()', true);
      await window.webContents.executeJavaScript('window.autocompleteDomCleanup()', true);
      console.log(`Autocomplete DOM smoke: ${checks} checks passed`);
      console.log(`Bot preference transport: ${preferenceChecks} checks passed`);
      await finish(0);
      return;
    }
    await window.webContents.executeJavaScript(`(${runDomSmoke.toString()})()`, true);
    fs.writeFileSync(path.join(output, 'command-dom-catalog.png'), (await window.webContents.capturePage()).toPNG());
    const result = await window.webContents.executeJavaScript('window.commandDomCaptureComposer()', true);
    fs.writeFileSync(path.join(output, 'command-dom-composer.png'), (await window.webContents.capturePage()).toPNG());
    await runMessageToolbarPointerSmoke(window);
    await window.webContents.executeJavaScript('window.commandDomCleanup()', true);
    const autocompleteChecks = await window.webContents.executeJavaScript(`(${runAutocompleteDomSmoke.toString()})()`, true);
    fs.writeFileSync(path.join(output, 'command-dom-audio-selector.png'), (await window.webContents.capturePage()).toPNG());
    await runLocalDownloadGestureSmoke(window);
    const preferenceChecks = await window.webContents.executeJavaScript('window.autocompletePreferencesSmoke()', true);
    await window.webContents.executeJavaScript('window.autocompleteDomCleanup()', true);
    const sidebarChecks = await window.webContents.executeJavaScript(`(${runSidebarPttSmoke.toString()})()`, true);
    const restrictionChecks = await window.webContents.executeJavaScript(`(${runServerRestrictionSmoke.toString()})()`, true);
    const settingsChecks = await window.webContents.executeJavaScript(`(${runSettingsNavigationSmoke.toString()})()`, true);
    const botSettingsChecks = await window.webContents.executeJavaScript(`(${runBotSettingsDomSmoke.toString()})()`, true);
    await window.webContents.executeJavaScript(`document.body.innerHTML = '<div class="user-quick-actions" style="justify-content:flex-start;padding:20px;gap:12px;">' + window.adminAudioPreviewMarkup + '</div>'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(output, 'admin-audio-icons.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 140, height: 80 })).toPNG());
    await window.webContents.executeJavaScript(`document.body.innerHTML = '<div style="width:250px;padding:12px;">' + window.adminAudioChannelPreviewMarkup + '</div>'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(output, 'admin-channel-icons.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 280, height: 70 })).toPNG());
    await window.webContents.executeJavaScript(`document.body.innerHTML = '<div id="app">' + window.mainAudioControlsPreviewMarkup + '</div>'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(output, 'main-audio-controls.png'), (await window.webContents.capturePage({ x: 0, y: 550, width: 620, height: 300 })).toPNG());
    await window.webContents.executeJavaScript(`document.body.innerHTML = '<div style="display:flex;gap:16px;padding:24px;">' + window.voiceConnectionPreviewMarkup + '</div>'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(output, 'voice-connection-states.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 1020, height: 180 })).toPNG());
    console.log(`Command DOM smoke: ${result.checks} checks passed`);
    console.log(`Autocomplete DOM smoke: ${autocompleteChecks} checks passed`);
    console.log(`Sidebar PTT smoke: ${sidebarChecks} checks passed`);
    console.log(`Server restriction smoke: ${restrictionChecks} checks passed`);
    console.log(`Settings navigation smoke: ${settingsChecks} checks passed`);
    console.log(`Bot settings DOM smoke: ${botSettingsChecks} checks passed`);
    console.log(`Bot preference transport: ${preferenceChecks} checks passed`);
    console.log('Screenshots: dist-test\\command-dom-catalog.png and dist-test\\command-dom-composer.png');
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runAudioPreviewLifecycleSmoke() {
  const [{ AudioPreviewService }, { renderSelectionChoiceList }, { settingsStore }, { appEvents }] = await Promise.all([
    import('/core/AudioPreviewService.ts'), import('/utils/selectionChoices.ts'),
    import('/stores/settingsStore.ts'), import('/core/EventBus.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
  };
  const previous = {
    api: window.api, Audio: window.Audio, speaker: settingsStore.selectedSpeakerId,
    createUrl: URL.createObjectURL, revokeUrl: URL.revokeObjectURL,
  };
  const audios = [], routes = [], loads = [], cancels = [], urls = [], revoked = [];
  let deferRoutes = false;
  let nextLoad;
  const ready = () => ({ status: 'ready', data: new Uint8Array([0]), mimeType: 'audio/wav' });
  class FixtureAudio extends EventTarget {
    constructor() {
      super(); this.paused = true; this.sinkId = ''; this.src = ''; this.plays = 0; this.error = null;
      this.currentTime = 0; this.duration = NaN; this.ended = false; this.listeners = new Map(); audios.push(this);
    }
    addEventListener(type, listener, options) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener); this.listeners.set(type, listeners);
      super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      this.listeners.get(type)?.delete(listener);
      super.removeEventListener(type, listener, options);
    }
    play() {
      if (this.ended) { this.currentTime = 0; this.ended = false; }
      this.paused = false; this.plays++; this.dispatchEvent(new Event('play')); return Promise.resolve();
    }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
    load() {}
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    setSinkId(id) {
      if (!deferRoutes) { this.sinkId = id; return Promise.resolve(); }
      const wait = deferred();
      routes.push({ audio: this, id, resolve: () => { this.sinkId = id; wait.resolve(); }, reject: wait.reject });
      return wait.promise;
    }
  }
  const root = document.createElement('div');
  document.body.append(root);
  const service = new AudioPreviewService();
  const unbind = service.bind(root);
  try {
    window.Audio = FixtureAudio;
    URL.createObjectURL = blob => { const url = previous.createUrl.call(URL, blob); urls.push(url); return url; };
    URL.revokeObjectURL = url => { revoked.push(url); previous.revokeUrl.call(URL, url); };
    settingsStore.selectedSpeakerId = '';
    window.api = {
      loadAudioPreview: async input => { loads.push(input); const pending = nextLoad; nextLoad = undefined; return pending ? pending.promise : ready(); },
      cancelAudioPreview: async input => { cancels.push(input); return true; },
    };
    root.innerHTML = ['first', 'second', 'unrelated'].map((id, index) => `<section>${renderSelectionChoiceList({
      choices: [{ label: id, value: 'same-id', audio: {
        url: `https://audio.example/${id}.wav`, fileName: `${id}.wav`, ...(index === 0 ? { durationMs: 12_000 } : {}),
      } }],
      label: id, header: id, idPrefix: id, keyPrefix: `preview-lifecycle:${id}`,
      volumeScope: index < 2 ? 'preview-lifecycle-command' : 'another-command',
      optionAttributes: () => 'data-lifecycle-select',
    })}</section>`).join('');
    const controls = index => root.querySelectorAll('[data-audio-choice-controls]')[index];
    const play = index => controls(index).querySelector('button').click();
    let submissions = 0;
    root.addEventListener('click', event => { if (event.target.closest('[data-lifecycle-select]')) submissions++; });
    play(0);
    await settle();
    check(audios[0]?.plays === 1 && audios[0].src.startsWith('blob:'), 'A preview must play only a local Blob after IPC');
    const sliders = [...root.querySelectorAll('[data-audio-preview-volume]')];
    const progress = index => controls(index).querySelector('[data-audio-preview-progress]');
    check(!controls(0).querySelector('input'), 'Individual results must not have their own volume sliders');
    check(progress(0).value === 0 && progress(0).max === 12, 'Preview metadata supplies a duration before decoding');
    audios[0].duration = 8.5;
    audios[0].dispatchEvent(new Event('loadedmetadata'));
    audios[0].currentTime = 3.25;
    audios[0].dispatchEvent(new Event('timeupdate'));
    check(progress(0).value === 3.25 && progress(0).max === 8.5 &&
      controls(0).querySelector('[data-audio-preview-time]').textContent === '00:03 / 00:08',
      'Playback progress must follow decoded duration and currentTime, not download bytes');
    play(0);
    await settle();
    check(audios[0].paused && progress(0).value === 3.25, 'Pausing retains the playback position');
    play(0);
    await settle();
    audios[0].currentTime = 8.5;
    audios[0].ended = true;
    audios[0].paused = true;
    audios[0].dispatchEvent(new Event('ended'));
    check(progress(0).value === progress(0).max, 'An ended preview reaches the end of its progress bar');
    play(0);
    await settle();
    check(progress(0).value === 0 && !audios[0].paused, 'Replay starts its progress again');
    const slider = sliders[0];
    slider.value = '27';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    check(audios[0].volume === 0.27 && sliders[1].value === '27' &&
      root.querySelector('[data-audio-preview-percentage]').textContent === '27%' &&
      slider.getAttribute('aria-valuetext') === '27%', 'Command-wide volume updates the player, percentage and matching controls');
    sliders[2].value = '81';
    sliders[2].dispatchEvent(new Event('input', { bubbles: true }));
    check(audios[0].volume === 0.27 && slider.value === '27', 'An unrelated command must not change this preview volume');
    play(1);
    await settle();
    check(loads.length === 2 && audios[1]?.plays === 1, 'Equal option IDs with different audio sources must load different previews');
    check(audios[0].paused && audios[0].src === '' && revoked.includes(urls[0]), 'Replacing a preview must release the old player and Blob');
    check(audios[1].volume === 0.27, 'Another result in the command inherits its shared volume');
    check([...audios[0].listeners.values()].every(listeners => listeners.size === 0), 'Replacement removes all media and progress listeners');
    audios[0].currentTime = 7;
    audios[0].dispatchEvent(new Event('timeupdate'));
    check(progress(0).value === 0 && progress(1).value === 0, 'Released media cannot update the old or new progress bars');
    audios[1].duration = Infinity;
    audios[1].currentTime = 3;
    audios[1].dispatchEvent(new Event('durationchange'));
    check(progress(1).value === 0 && controls(1).querySelector('[data-audio-preview-time]').textContent === '00:03 / --:--',
      'Unknown or non-finite duration must never produce an invalid progress value');
    check(submissions === 0, 'Preview and volume controls must never select or submit a choice');
    service.release(root);

    deferRoutes = true;
    settingsStore.selectedSpeakerId = 'headphones';
    play(0);
    await settle();
    const old = audios.at(-1);
    play(1);
    await settle();
    const current = audios.at(-1);
    check(routes.length === 2 && current !== old, 'Fixture must pause two distinct output-routing operations');
    routes[0].resolve();
    await settle();
    check(old.plays === 0 && current.plays === 0, 'A stale routing completion cannot start either the old or the newer pending player');
    routes[1].resolve();
    await settle();
    check(current.plays === 1 && current.sinkId === 'headphones', 'The selected player starts only after its own output is ready');
    settingsStore.selectedSpeakerId = 'output-one';
    appEvents.emit('settings.updated');
    await settle();
    settingsStore.selectedSpeakerId = 'output-two';
    appEvents.emit('settings.updated');
    await settle();
    check(routes.length === 3 && current.paused, 'Rapid output changes must serialize and pause playback');
    routes[2].resolve();
    await settle();
    check(routes.length === 4 && current.plays === 1, 'An intermediate output must never resume playback');
    routes[3].resolve();
    await settle();
    check(current.sinkId === 'output-two' && current.plays === 2, 'Only the latest selected output may resume');
    settingsStore.selectedSpeakerId = 'unavailable';
    appEvents.emit('settings.updated');
    await settle();
    routes.at(-1).reject(new Error('Fixture unavailable output'));
    await settle();
    check(current.paused && current.src === '' && current.plays === 2 &&
      controls(1).dataset.audioPreviewState === 'failed', 'Output failures must stop and show an error, never fall back to another speaker');
    const beforeLateLoad = audios.length;
    nextLoad = deferred();
    const pending = nextLoad;
    play(0);
    await settle();
    const requestId = loads.at(-1).requestId;
    service.release(root);
    pending.resolve(ready());
    await settle();
    check(cancels.some(entry => entry.requestId === requestId) && audios.length === beforeLateLoad,
      'Closing a pending preview cancels its exact IPC request and ignores late bytes');
    check(urls.every(url => revoked.includes(url)), 'Every created preview Blob must be revoked');
    const routesBeforeRelease = routes.length;
    settingsStore.selectedSpeakerId = 'after-release';
    appEvents.emit('settings.updated');
    await settle();
    check(routes.length === routesBeforeRelease, 'Released previews must remove their settings listener');
  } finally {
    unbind();
    root.remove();
    window.api = previous.api;
    window.Audio = previous.Audio;
    settingsStore.selectedSpeakerId = previous.speaker;
    URL.createObjectURL = previous.createUrl;
    URL.revokeObjectURL = previous.revokeUrl;
  }
  return checks;
}

async function runAutocompleteDomSmoke() {
  const [{ ChatView }, chats, servers, networks, { appEvents }, { bindBotChatEvents }, language, { settingsStore }, { botPreferenceScopeFor }] = await Promise.all([
    import('/views/ChatView.ts'), import('/stores/chatStore.ts'), import('/stores/serverStore.ts'),
    import('/core/NetworkClient.ts'), import('/core/EventBus.ts'), import('/core/botChatEvents.ts'),
    import('/i18n/index.ts'), import('/stores/settingsStore.ts'), import('/utils/botSettingsContext.ts'),
  ]);
  language.setLanguage('pt-BR');
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Autocomplete fixture did not settle: ' + JSON.stringify({
      queries: queries.map(entry => entry.payload.query), invoked: invoked.length,
      field: root.querySelector('[data-bot-autocomplete]')?.value,
      menu: root.querySelector('#bot-parameter-options')?.textContent?.slice(0, 200),
      notice: root.querySelector('#chat-command-notice')?.textContent,
      error: root.querySelector('.bot-error')?.textContent,
    }));
  };
  const type = (element, value) => { element.focus(); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (element, value, isComposing = false) => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: value, isComposing, bubbles: true, cancelable: true,
  }));
  const store = chats.createChatStore();
  const server = servers.createServerStore();
  const client = networks.createNetworkClient();
  client.getStatus = () => 'CONNECTED';
  client.getCurrentServerUrl = () => 'ws://local-fixture.example:46332';
  chats.setActiveChatStore(store);
  servers.setActiveServerStore(server);
  networks.setActiveNetworkClient(client);
  const caller = { id: 'caller', clientId: 'caller-client', nickname: 'Caller', status: 'ONLINE', joinedAt: 1 };
  server.setServerDetails({
    id: 'autocomplete-server', name: 'Autocomplete', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: ['one', 'two'].map((id, position) => ({
      id, serverId: 'autocomplete-server', name: id, type: 'TEXT', position, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
    })),
    members: [caller], knownMembers: [caller], roles: [], userRoles: [], myPermissions: 2147483647, ownerId: caller.id,
  }, caller);
  let command = {
    name: 'query', botId: 'audio-bot', botName: 'Audio Bot', description: 'Find audio',
    options: [{ name: 'sound', description: 'Sound', type: 'string', autocomplete: true, required: true,
      placeholder: 'Digite pelo menos 2 caracteres para pesquisar' }],
  };
  const queries = [];
  const invoked = [];
  let receivedDownload = null;
  let downloadInput = null;
  let resolveDownload = null;
  let progressListener = null;
  let availability = 'ready';
  let pickerCalls = 0;
  const previewLoads = [];
  const previewCancels = [];
  const syntheticWave = () => {
    const sampleRate = 8000;
    const samples = 800;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const write = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    write(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    write(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, samples * 2, true);
    return new Uint8Array(buffer);
  };
  const previousApi = window.api;
  const previousFolder = settingsStore.soundboardFolderPath;
  const previousExceptions = settingsStore.botDownloadConfirmationExceptions;
  const previousPreferences = settingsStore.botUserPreferences;
  const previousStoredSettings = localStorage.getItem('monky_settings');
  settingsStore.botUserPreferences = {};
  settingsStore.botDownloadConfirmationExceptions = [];
  const preferenceScope = botPreferenceScopeFor(client, server, command.botId);
  settingsStore.saveBotPreferences(preferenceScope, { language: 'pt-BR' });
  window.api = {
    ...previousApi,
    soundDownloadAvailability: async () => availability,
    selectSoundboardFolder: async () => { pickerCalls++; return 'C:\\isolated-fixture-sounds'; },
    listSoundboardSounds: async () => [],
    authorizeSoundDownload: async () => ({ status: 'authorized', token: 'fixture-local-capability' }),
    downloadSound: async input => {
      downloadInput = input;
      return new Promise(resolve => { resolveDownload = resolve; });
    },
    cancelSoundDownload: async () => true,
    onSoundDownloadProgress: callback => { progressListener = callback; return () => { progressListener = null; }; },
    loadAudioPreview: async input => {
      previewLoads.push(input);
      return { status: 'ready', data: syntheticWave(), mimeType: 'audio/wav' };
    },
    cancelAudioPreview: async input => { previewCancels.push(input); return true; },
  };
  client.send = (messageType, payload, requestId) => {
    if (messageType === 'COMMAND_AUTOCOMPLETE') queries.push({ payload, requestId, time: Date.now() });
    if (messageType === 'COMMAND_INVOKE') {
      invoked.push(payload);
      const ack = { invocationId: `invocation-${invoked.length}`, channelId: payload.channelId, botId: payload.botId, commandName: payload.commandName };
      queueMicrotask(() => client.handleIncomingMessage({ type: 'COMMAND_INVOKED', requestId, payload: ack }));
      if (payload.allowSoundDownload) setTimeout(() => {
        receivedDownload = {
          ...ack, downloadId: `download-${invoked.length}`, botName: command.botName, invokerId: caller.id,
          invokerNickname: caller.nickname, url: 'https://audio.example/authored.mp3', fileName: 'authored.mp3',
          title: 'Authored sound', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
        };
        appEvents.emit('message.COMMAND_SOUND_DOWNLOAD', receivedDownload);
      }, 0);
    }
  };
  const off = bindBotChatEvents();
  document.body.innerHTML = '<div id="app"></div>';
  const root = find('#app');
  root.style.cssText = 'height:calc(100vh - 24px);width:calc(100vw - 24px);margin:12px;display:flex;flex-direction:column;';
  const view = new ChatView(root);
  store.setCommands([command]);
  server.setSlashCommands([command]);
  view.setChannel('one');
  const input = () => find('[data-bot-autocomplete="sound"]');
  const select = () => { type(find('#chat-message-input'), '/query'); key(find('#chat-message-input'), 'Enter'); };
  const response = (request, choices) => client.handleIncomingMessage({
    type: 'COMMAND_AUTOCOMPLETE_RESULT', requestId: request.requestId, payload: { status: 'ok', choices },
  });
  const choices = Array.from({ length: 20 }, (_, index) => ({
    label: `Visible ${index}`,
    value: `opaque-${index}-${'x'.repeat(490)}`,
    ...(index === 0 ? {
      description: 'Generic audio autocomplete',
      audio: { url: 'https://audio.example.test/autocomplete.wav', fileName: 'autocomplete.wav', durationMs: 2100 },
    } : {}),
  }));
  select();
  check(store.getInvocations('one').length === 0, 'Selecting a query command must not add a chat card');
  await document.fonts.ready;
  const measure = document.createElement('canvas').getContext('2d');
  const inputStyle = getComputedStyle(input());
  measure.font = `${inputStyle.fontWeight} ${inputStyle.fontSize} ${inputStyle.fontFamily}`;
  const placeholderWidth = measure.measureText(input().placeholder).width;
  const initialWidth = input().getBoundingClientRect().width;
  check(initialWidth >= placeholderWidth + 3 && initialWidth <= placeholderWidth + 24,
    `The parameter must fit its placeholder without excessive padding (${initialWidth} vs ${placeholderWidth})`);
  type(input(), 'a');
  check(input().getBoundingClientRect().width >= initialWidth - 1, 'Typing a short query must not collapse the placeholder-sized input');
  await new Promise(resolve => setTimeout(resolve, 270));
  check(queries.length === 0, 'One character must not trigger a query');
  type(input(), 'alpha');
  key(input(), 'Enter');
  check(invoked.length === 0, 'Typed text without a selected choice must not invoke');
  await waitFor(() => queries.length === 1);
  check(JSON.stringify(queries[0].payload.userSettings) === JSON.stringify({ language: 'pt-BR' }),
    'Autocomplete carries only this bot/server/caller custom preferences');
  response(queries[0], choices);
  await waitFor(() => root.querySelectorAll('[data-parameter-option]').length === 10);
  const menuRect = find('#bot-parameter-options').getBoundingClientRect();
  const composerRect = find('.bot-compact-command-form').getBoundingClientRect();
  check(menuRect.bottom <= composerRect.top + 1 && menuRect.width >= composerRect.width * 0.95,
    'The result panel must be above the composer and use its full available width');
  const choiceList = find('#bot-parameter-options .bot-choice-list');
  check(choiceList.scrollHeight > choiceList.clientHeight && getComputedStyle(choiceList).overflowY === 'auto',
    'Long result lists must scroll inside the panel');
  const beforeAutocompletePreviewInvoke = invoked.length;
  find('[data-audio-preview-action="toggle"]').click();
  await waitFor(() => previewLoads.some(entry => entry.url === 'https://audio.example.test/autocomplete.wav'));
  check(invoked.length === beforeAutocompletePreviewInvoke && store.getCommandDraft('one').values.sound === undefined,
    'Autocomplete preview play must not select or invoke the command');
  const autocompleteSlider = find('[data-audio-preview-volume]');
  check(root.querySelectorAll('[data-audio-preview-volume]').length === 1,
    'Autocomplete must show one shared volume control, outside the results');
  check(!!root.querySelector('[data-audio-preview-progress]'), 'Audio results must expose playback progress');
  autocompleteSlider.value = '41';
  autocompleteSlider.dispatchEvent(new Event('input', { bubbles: true }));
  check(find('[data-audio-preview-percentage]').textContent === '41%', 'Autocomplete shows the current shared volume percentage');
  key(autocompleteSlider, 'ArrowRight');
  check(invoked.length === beforeAutocompletePreviewInvoke && !!root.querySelector('[data-parameter-option]'),
    'Autocomplete preview volume must keep the result list open without invoking');
  type(input(), 'beta');
  check(root.querySelectorAll('[data-parameter-option]').length === 0, 'Editing removes selectable stale results immediately');
  key(input(), 'Enter');
  check(invoked.length === 0, 'Enter while loading must not submit the query as an ID');
  await waitFor(() => queries.length === 2);
  check(queries[1].time - queries[0].time >= 495, 'Queries must be throttled independently of debounce');
  response(queries[1], choices);
  await waitFor(() => !!root.querySelector('[data-parameter-option]'));
  check(find('[data-audio-preview-volume]').value === '41', 'Replacing search results keeps the same command volume');
  key(input(), 'ArrowDown');
  key(input(), 'Enter');
  await waitFor(() => invoked.length === 1 && !store.getCommandDraft('one'));
  check(JSON.stringify(invoked[0].userSettings) === JSON.stringify({ language: 'pt-BR' }),
    'Command execution carries the same scoped custom preference payload');
  check(invoked[0].options.sound === choices[1].value, 'Enter selects and invokes exactly once with the opaque value');
  select();
  type(input(), 'mouse');
  await waitFor(() => queries.length === 3);
  response(queries[2], choices);
  await waitFor(() => !!root.querySelector('[data-parameter-option]'));
  find('[data-parameter-option="0"]').click();
  await waitFor(() => invoked.length === 2 && !store.getCommandDraft('one'));
  check(invoked[1].options.sound === choices[0].value, 'Mouse selection must also invoke without a second submit');
  const requiredOnlyOptions = command.options;
  command = { ...command, options: [...requiredOnlyOptions, { name: 'insert-first', description: 'Insert first', type: 'boolean' }] };
  store.setCommands([command]);
  server.setSlashCommands([command]);
  select();
  type(input(), 'optional');
  await waitFor(() => queries.length === 4);
  response(queries[3], choices);
  await waitFor(() => !!root.querySelector('[data-parameter-option]'));
  find('[data-parameter-option="0"]').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  check(invoked.length === 2 && store.getCommandDraft('one')?.values.sound === choices[0].value,
    'Autocomplete selection must not auto-invoke while optional parameters are still available');
  input().setSelectionRange(input().value.length, input().value.length);
  key(input(), 'ArrowRight');
  await waitFor(() => [...root.querySelectorAll('[data-parameter-option] strong')]
    .some(label => label.textContent === 'insert-first'));
  find('[data-parameter-option="0"]').click();
  await waitFor(() => !!root.querySelector('[data-field-name="insert-first"]'));
  check(document.activeElement.closest('[data-field-name]')?.dataset.fieldName === 'insert-first',
    'ArrowRight optional selection must add the chip and focus its control after autocomplete');
  store.clearCommand('one');
  await waitFor(() => !store.getCommandDraft('one'));
  command = { ...command, options: requiredOnlyOptions };
  store.setCommands([command]);
  server.setSlashCommands([command]);
  select();
  const composingInput = input();
  composingInput.focus();
  composingInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  type(composingInput, 'composição');
  key(composingInput, 'Enter', true);
  command = { ...command, botName: 'Renamed Audio Bot' };
  store.setCommands([command]);
  await new Promise(resolve => setTimeout(resolve, 550));
  check(queries.length === 4 && invoked.length === 2, 'IME composition must neither search nor execute');
  check(composingInput.isConnected && document.activeElement === composingInput, 'Registry refresh must not replace a composing input');
  composingInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  await waitFor(() => queries.length === 5);
  response(queries[4], []);
  await waitFor(() => find('#bot-parameter-options').textContent.includes('Nenhum resultado'));
  check(true, 'Empty results are localized in Portuguese');
  type(input(), 'late');
  await waitFor(() => queries.length === 6);
  key(input(), 'Escape');
  response(queries[5], choices);
  await new Promise(resolve => setTimeout(resolve, 30));
  check(find('#bot-parameter-options').hidden, 'A late response must not reopen an escaped menu');
  type(input(), 'channel');
  await waitFor(() => queries.length === 7);
  view.setChannel('two');
  response(queries[6], choices);
  await new Promise(resolve => setTimeout(resolve, 30));
  check(!root.querySelector('[data-parameter-option]'), 'A response from a destroyed channel view must be ignored');
  view.setChannel('one');
  language.setLanguage('en');
  type(input(), 'empty english');
  await waitFor(() => queries.length === 8);
  response(queries[7], []);
  await waitFor(() => find('#bot-parameter-options').textContent.includes('No results'));
  check(true, 'Empty results are localized in English');
  key(input(), 'Escape');
  key(input(), 'Escape');
  language.setLanguage('pt-BR');
  command = { ...command, downloadsSound: true };
  store.setCommands([command]);
  server.setSlashCommands([command]);
  settingsStore.soundboardFolderPath = '';
  select();
  check(!store.getCommandDraft('one') && pickerCalls === 0 &&
    find('#chat-command-notice').textContent.includes('Selecione uma pasta'),
    'Missing folders warn immediately without entering a command or opening a native picker');
  settingsStore.soundboardFolderPath = 'C:\\isolated-fixture-sounds';
  availability = 'confirmation_required';
  select();
  await waitFor(() => root.querySelector('#chat-command-notice')?.textContent?.includes('Confirme a pasta'));
  check(!store.getCommandDraft('one'), 'An unconfirmed legacy folder must block composer activation');
  check(!root.querySelector('#chat-command-notice button'), 'Folder confirmation is handled in settings, not by an inline picker');
  availability = 'ready';
  select();
  await waitFor(() => !!store.getCommandDraft('one'));
  type(input(), 'local');
  await waitFor(() => queries.length === 9);
  response(queries[8], choices);
  await waitFor(() => !!root.querySelector('[data-parameter-option]'));
  find('[data-parameter-option="0"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  check(invoked.length === 2 && !downloadInput, 'A synthetic click may select but must not authorize local I/O');
  find('[data-command-form]').requestSubmit();
  await new Promise(resolve => setTimeout(resolve, 20));
  check(invoked.length === 2, 'Programmatic requestSubmit is not an execution gesture');
  // Prepare fresh choices for a trusted native mouse click driven by the main fixture.
  type(input(), 'trusted');
  await waitFor(() => queries.length === 10);
  response(queries[9], choices);
  await waitFor(() => !!root.querySelector('[data-parameter-option]'));
  window.autocompleteNativeState = () => ({
    invokes: invoked.length, downloadInput, subscriptions: !!progressListener, pickerCalls,
    confirmation: !!document.querySelector('.dialog-card'),
    phase: receivedDownload && store.getInvocation(receivedDownload.invocationId)?.soundDownload?.phase,
    fileName: receivedDownload && store.getInvocation(receivedDownload.invocationId)?.soundDownload?.fileName,
  });
  window.autocompleteNativeFinish = async () => {
    if (!downloadInput || !resolveDownload || !receivedDownload) throw new Error('Trusted gesture did not authorize download');
    view.setChannel('two');
    progressListener?.({ ...downloadInput, receivedBytes: 417, totalBytes: 834 });
    check(!root.querySelector('.bot-sound-download'), 'Progress must not create a card in the new channel');
    appEvents.emit('message.COMMAND_FINISHED', {
      invocationId: receivedDownload.invocationId, channelId: receivedDownload.channelId, reason: 'completed',
    });
    check(store.getInvocation(receivedDownload.invocationId).soundDownload.result.status === 'cancelled',
      'A network finish alone must not claim that the local file was saved');
    resolveDownload({ status: 'downloaded' });
    await waitFor(() => store.getInvocation(receivedDownload.invocationId)?.soundDownload?.result?.status === 'downloaded');
    view.setChannel('one');
    check(find(`[data-invocation-id="${receivedDownload.invocationId}"] .bot-sound-download`).textContent.includes('Áudio salvo'),
      'The original channel retains actual download completion');
    check(!progressListener, 'Terminal download removes its progress listener');
    check(store.getInvocation(receivedDownload.invocationId).soundDownload.resultOrigin === 'main',
      'The real Main reply wins even when a network finish overtakes its IPC delivery');
    return checks;
  };
  window.autocompleteNativePrepareKeyboard = async (resetConfirmation = false) => {
    if (resetConfirmation) settingsStore.resetBotDownloadConfirmations();
    receivedDownload = null;
    downloadInput = null;
    resolveDownload = null;
    select();
    await waitFor(() => !!store.getCommandDraft('one'));
    const before = queries.length;
    type(input(), 'keyboard');
    await waitFor(() => queries.length > before);
    response(queries.at(-1), choices);
    await waitFor(() => !!root.querySelector('[data-parameter-option]'));
    input().focus();
  };
  window.autocompleteNativeAbort = () => appEvents.emit('message.COMMAND_FINISHED', {
    invocationId: receivedDownload.invocationId, channelId: receivedDownload.channelId, reason: 'cancelled',
  });
  window.autocompleteNativeCancelled = async () => {
    await waitFor(() => store.getInvocation(receivedDownload.invocationId)?.soundDownload?.result?.status === 'cancelled');
    check(!downloadInput && !document.querySelector('.dialog-card') && pickerCalls === 0,
      'Cancelling or ending a pending confirmation closes it without a transfer or folder picker');
    check(settingsStore.botDownloadConfirmationExceptions.length === 0, 'A cancelled confirmation cannot remember approval');
  };
  window.autocompleteDomCleanup = () => {
    view.destroy(); off(); client.dispose();
    settingsStore.soundboardFolderPath = previousFolder;
    settingsStore.botDownloadConfirmationExceptions = previousExceptions;
    settingsStore.botUserPreferences = previousPreferences;
    if (previousStoredSettings === null) localStorage.removeItem('monky_settings');
    else localStorage.setItem('monky_settings', previousStoredSettings);
    window.api = previousApi;
    language.setLanguage('pt-BR');
  };
  window.autocompletePreferencesSmoke = async () => {
    const beforeChecks = checks;
    select();
    await waitFor(() => !!store.getCommandDraft('one'));
    let before = queries.length;
    type(input(), 'preferences');
    await waitFor(() => queries.length > before);
    response(queries.at(-1), choices);
    await waitFor(() => !!root.querySelector('[data-parameter-option]'));
    before = queries.length;
    settingsStore.saveBotPreferences(preferenceScope, { language: 'en' });
    await waitFor(() => queries.length > before);
    check(queries.at(-1).payload.query === 'preferences' && queries.at(-1).payload.userSettings.language === 'en',
      'Changing custom preferences cancels/requeries identical autocomplete text with the new values');
    response(queries.at(-1), choices);
    await waitFor(() => !!root.querySelector('[data-parameter-option]'));
    before = queries.length;
    settingsStore.saveBotPreferences(preferenceScope, { language: 'en' }, false);
    settingsStore.saveBotPreferences(botPreferenceScopeFor(client, server, 'another-bot'), { language: 'fr' });
    await new Promise(resolve => setTimeout(resolve, 600));
    check(queries.length === before, 'Host-only consent and other-bot changes do not restart autocomplete');
    const summary = {
      botId: command.botId, name: command.botName, online: true, capabilities: { downloadsSound: true },
      schemaRevision: 1, revision: 1, hasServerSettings: true, hasUserSettings: true, canConfigure: false,
    };
    appEvents.emit('message.BOT_SETTINGS_LIST_RESPONSE', { bots: [summary] });
    await waitFor(() => queries.length > before);
    response(queries.at(-1), choices);
    await waitFor(() => !!root.querySelector('[data-parameter-option]'));
    before = queries.length;
    appEvents.emit('message.BOT_SETTINGS_LIST_RESPONSE', { bots: [{ ...summary, revision: 2 }] });
    await waitFor(() => queries.length > before);
    check(queries.at(-1).payload.query === 'preferences', 'Shared revision notifications invalidate ordinary-user autocomplete');
    check(JSON.stringify(queries.at(-1).payload.userSettings) === JSON.stringify({ language: 'en' }),
      'Host filename confirmation and local I/O choices never enter custom SDK values');
    response(queries.at(-1), choices);
    return checks - beforeChecks;
  };
  return checks;
}

async function runLocalDownloadGestureSmoke(window) {
  window.focus();
  window.webContents.focus();
  const click = async (selector) => {
    const point = await window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing native pointer target');
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`, true);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const waitFor = async (predicate) => {
    let state;
    for (let attempt = 0; attempt < 150; attempt++) {
      state = await window.webContents.executeJavaScript('window.autocompleteNativeState()', true);
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Native download state did not settle: ' + JSON.stringify(state));
  };
  const enter = () => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  };
  const confirm = async (invokes, remember, baseName = 'authored') => {
    const before = await waitFor(state => state.confirmation && state.invokes === invokes);
    if (before.downloadInput || before.phase !== 'confirming' || before.pickerCalls !== 0) {
      throw new Error('A real request must await confirmation before native transfer');
    }
    if (invokes === 3) fs.writeFileSync(path.join(output, 'command-dom-download-name.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('.dialog-card');
      if (!modal.textContent.includes('Authored sound') || !modal.textContent.includes('authored.mp3') ||
          !modal.textContent.includes('C:\\\\isolated-fixture-sounds') || !modal.textContent.includes('audio.example')) {
        throw new Error('Confirmation must show the resolved title, file, destination and source');
      }
      const input = modal.querySelector('[data-dialog-input]');
      if (input.value !== 'authored' || document.activeElement !== input || modal.querySelector('.dialog-text-suffix').textContent !== '.mp3') {
        throw new Error('Saving must offer the original basename for editing while preserving the extension');
      }
      input.value = '../escape';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!modal.querySelector('[data-action="confirm"]').disabled || modal.querySelector('[data-dialog-input-error]').hidden ||
          input.getAttribute('aria-invalid') !== 'true') throw new Error('Invalid names must show an error and block saving');
    })()`, true);
    enter();
    await new Promise(resolve => setTimeout(resolve, 20));
    const invalid = await window.webContents.executeJavaScript('window.autocompleteNativeState()', true);
    if (invalid.downloadInput || !invalid.confirmation) throw new Error('A trusted Enter cannot accept an invalid filename');
    await window.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('.dialog-card');
      const input = modal.querySelector('[data-dialog-input]');
      input.value = ${JSON.stringify(baseName)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (modal.querySelector('[data-action="confirm"]').disabled || !modal.querySelector('[data-dialog-input-error]').hidden) {
        throw new Error('Correcting the filename must clear the error and enable confirmation');
      }
      modal.querySelector('[data-action="confirm"]').click();
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`, true);
    const synthetic = await window.webContents.executeJavaScript('window.autocompleteNativeState()', true);
    if (synthetic.downloadInput || !synthetic.confirmation) throw new Error('Synthetic acceptance must not authorize a transfer');
    if (remember) await click('.dialog-card .toggle-switch');
    await click('.dialog-card [data-action="confirm"]');
    const accepted = await waitFor(state => !!state.downloadInput);
    if (accepted.invokes !== invokes || accepted.confirmation || accepted.pickerCalls !== 0) {
      throw new Error('Acceptance must start exactly the correlated native download');
    }
    if (accepted.downloadInput.fileName !== `${baseName}.mp3` || accepted.fileName !== `${baseName}.mp3`) {
      throw new Error('The chosen filename must reach the native writer and download card with its extension preserved');
    }
  };
  await click('[data-parameter-option="0"] .bot-choice-copy');
  await confirm(3, false, 'My local audio');
  await window.webContents.executeJavaScript('window.autocompleteNativeFinish()', true);
  await window.webContents.executeJavaScript('window.autocompleteNativePrepareKeyboard()', true);
  enter();
  await confirm(4, true, 'Another local name');
  await window.webContents.executeJavaScript('window.autocompleteNativeFinish()', true);
  await window.webContents.executeJavaScript('window.autocompleteNativePrepareKeyboard()', true);
  enter();
  const suppressed = await waitFor(state => !!state.downloadInput);
  if (suppressed.invokes !== 5 || suppressed.confirmation) throw new Error('Remembered approval should suppress only the next matching dialog');
  if (suppressed.downloadInput.fileName !== 'authored.mp3') throw new Error('Skipped confirmations must use the bot filename, not a previous custom name');
  const checks = await window.webContents.executeJavaScript('window.autocompleteNativeFinish()', true);
  await window.webContents.executeJavaScript('window.autocompleteNativePrepareKeyboard(true)', true);
  enter();
  await waitFor(state => state.confirmation);
  await click('.dialog-card .toggle-switch');
  await click('.dialog-card [data-action="cancel"]');
  await window.webContents.executeJavaScript('window.autocompleteNativeCancelled()', true);
  await window.webContents.executeJavaScript('window.autocompleteNativePrepareKeyboard()', true);
  enter();
  await waitFor(state => state.confirmation);
  await window.webContents.executeJavaScript('window.autocompleteNativeAbort(); window.autocompleteNativeCancelled()', true);
  console.log(`Local download: trusted consent, opt-out/reset, cancellation and original-channel lifecycle (${checks} combined checks)`);
}

async function runMessageToolbarPointerSmoke(window) {
  window.focus();
  window.webContents.focus();
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const wait = () => new Promise(resolve => setTimeout(resolve, 50));
  const row = '.chat-message-row[data-message-id="toolbar-pointer"]';
  const action = name => `${row} [data-message-action="${name}"]`;
  const check = async (expression, message) => {
    let matched = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evaluate(expression)) { matched = true; break; }
      await wait();
    }
    if (!matched) {
      const state = await evaluate(`(() => {
        const row = document.querySelector('${row}');
        const rect = row.querySelector('.chat-message-text').getBoundingClientRect();
        return { classes: row.className, hovered: row.matches(':hover'),
          hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.outerHTML,
          focused: document.activeElement.outerHTML.slice(0, 250),
          documentFocused: document.hasFocus(), focusVisible: document.activeElement.matches(':focus-visible') };
      })()`);
      throw new Error(message + ': ' + JSON.stringify(state));
    }
  };
  const move = async selector => {
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await wait();
    return point;
  };
  const click = async selector => {
    const point = await move(selector);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait();
  };
  const leave = async () => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await check(`!document.querySelector('${row}').matches(':hover')`,
      'Native pointer leave must reach the renderer before checking popup dismissal');
  };
  const visible = `getComputedStyle(document.querySelector('${row} .chat-message-toolbar')).opacity === '1'`;
  await evaluate('window.prepareToolbarPointerFixture()');
  try {
    await click(`${row} .chat-message-text`);
    await check(`getComputedStyle(document.querySelector('${row}')).outlineStyle === 'none'`,
      'Mouse-clicking a message must not draw the keyboard focus outline');
    await click(action('copy'));
    await check(`!(${visible}) && !document.querySelector('.chat-copy-toast')`,
      'Copy must immediately hide its toolbar, even while the clipboard is pending');
    await evaluate('window.finishToolbarPointerCopy()');
    await leave();
    await move(`${row} .chat-message-text`);
    await check(visible, 'Hovering the message again restores actions');
    await click(action('reply'));
    await check(`!(${visible}) && document.activeElement.id === 'chat-message-input'`,
      'Reply immediately hides actions and focuses the composer');
    await leave();
    await move(`${row} .chat-message-text`);
    await click(action('emoji'));
    await leave();
    await check(`${visible} && !!document.querySelector('.emoji-picker')
      && document.querySelector('${action('emoji')}').getAttribute('aria-expanded') === 'true'`,
      'Emoji keeps the toolbar visible while its picker is open, even after pointer leave');
    await click(action('emoji'));
    await check(`${visible} && !document.querySelector('.emoji-picker')
      && document.querySelector('${action('emoji')}').getAttribute('aria-expanded') === 'false'`,
      'Clicking the same emoji button closes only its picker');
    await leave();
    await check(`!(${visible})`, 'Closing the emoji picker releases the toolbar');
    await move(`${row} .chat-message-text`);
    await click(action('emoji'));
    await click(action('more'));
    await check(`!document.querySelector('.emoji-picker') && !!document.querySelector('.floating-context-menu')`,
      'Opening more closes the emoji picker without leaving its anchor expanded');
    await click(action('emoji'));
    await check(`!!document.querySelector('.emoji-picker') && !document.querySelector('.floating-context-menu')`,
      'Opening emoji closes more and switches the pinned toolbar anchor');
    await evaluate('window.closeToolbarPointerPicker()');
    await leave();
    await move(`${row} .chat-message-text`);
    await click(action('more'));
    await leave();
    await check(`${visible} && !!document.querySelector('.floating-context-menu')
      && document.querySelector('${action('more')}').getAttribute('aria-expanded') === 'true'`,
      'An open more-menu must keep its toolbar visible after the pointer leaves');
    await click(action('more'));
    await check(`${visible} && !document.querySelector('.floating-context-menu')
      && document.querySelector('${action('more')}').getAttribute('aria-expanded') === 'false'`,
      'Clicking the same more-button closes only its submenu, without reopening it');
    await leave();
    await check(`!(${visible})`, 'Closed more-menu must not leave mouse focus pinning the toolbar');
    await move(`${row} .chat-message-text`);
    await click(action('more'));
    await evaluate(`Array.from(document.querySelectorAll('.floating-context-menu button'))
      .find(button => button.textContent.includes('content_copy')).id = 'toolbar-menu-copy'`);
    await click('#toolbar-menu-copy');
    await check(`!(${visible}) && !document.querySelector('.floating-context-menu')`,
      'Selecting a submenu action also dismisses the toolbar');
    await evaluate('window.finishToolbarPointerCopy()');
    await leave();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await wait();
    await check(`${visible} && document.activeElement.matches('.chat-message-toolbar button:focus-visible')`,
      'Keyboard navigation restores the toolbar and preserves visible focus');
    console.log('Message toolbar: 14 trusted pointer/keyboard checks passed');
  } finally {
    await evaluate('window.cleanupToolbarPointerFixture()');
  }
}

async function runServerRestrictionSmoke() {
  const [{ MainView }, servers, { voiceStore: voice }, { settingsStore: settings },
    { appEvents, EventBus }, { soundEffects }] = await Promise.all([
    import('/views/MainView.ts'), import('/stores/serverStore.ts'), import('/stores/voiceStore.ts'),
    import('/stores/settingsStore.ts'), import('/core/EventBus.ts'), import('/core/SoundEffects.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const previousStore = servers.getActiveServerStore();
  const previousMode = settings.inputMode;
  const previousPlay = soundEffects.play;
  soundEffects.play = () => {};
  settings.inputMode = 'voice_activity';
  voice.reset();
  voice.setDeafened(false);
  voice.setMuted(false);
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app');
  const view = new MainView(root);
  const silent = new EventBus();
  const user = { id: 'restriction-user', sessionId: 'restriction-device', clientId: 'restriction-client',
    nickname: 'Restriction fixture', status: 'ONLINE', joinedAt: 1 };
  const makeServer = (id, restrictions) => {
    const store = servers.createServerStore();
    store.bus = silent;
    store.setServerDetails({
      id, name: id, createdAt: 1, maxUsers: 10, channels: [], members: [user], voiceStates: {},
      ownerId: user.id, myPermissions: 2147483647,
    }, user);
    store.updateVoiceRestrictions(user.id, restrictions);
    return store;
  };
  const a = makeServer('restricted-a', { serverMuted: true, serverDeafened: true });
  const b = makeServer('unrestricted-b', { serverMuted: false, serverDeafened: false });
  const show = (store) => {
    a.bus = b.bus = silent;
    servers.setActiveServerStore(store);
    store.bus = appEvents;
    view.render();
  };
  const mic = () => root.querySelector('#bar-btn-mic');
  const deafen = () => root.querySelector('#bar-btn-deafen');
  const blocks = () => root.querySelectorAll('.user-quick-actions [data-audio-block]:not([hidden])').length;
  let notifications = 0;
  const off = appEvents.on('server.voice_restrictions_updated', () => { notifications++; });
  try {
    show(a);
    check(!voice.currentVoiceChannelId && blocks() === 2,
      'The authenticated server policy is visible immediately, without ever joining voice');
    check(mic().querySelector('[data-audio-icon]').textContent === 'mic'
      && deafen().querySelector('[data-audio-icon]').textContent === 'headphones'
      && !mic().classList.contains('danger-active') && !deafen().classList.contains('danger-active'),
      'Pre-call administrative badges do not replace the personal icons or colors');
    mic().click();
    check(voice.isMuted && blocks() === 2 && mic().querySelector('[data-audio-icon]').textContent === 'mic_off',
      'Personal pre-mute still changes visibly beneath the persisted server restriction');
    mic().click();
    check(!voice.isMuted && blocks() === 2 && !voice.getEffectiveMuted(),
      'A server badge outside voice does not create a physical call mute or override personal intent');

    voice.setChannel('room-a', 'restricted-a');
    voice.setServerMuted(true);
    voice.setServerDeafened(true);
    voice.setChannel(null);
    check(blocks() === 2 && !voice.serverMuted && !voice.serverDeafened,
      'Leaving voice clears physical call flags but keeps the server policy visible');
    voice.reset();
    check(blocks() === 2, 'Full call teardown also preserves both administrative badges');

    show(b);
    check(blocks() === 0, 'An unrestricted server never inherits another server policy');
    const beforeBackground = notifications;
    a.updateVoiceRestrictions(user.id, { serverMuted: true, serverDeafened: false });
    check(notifications === beforeBackground && blocks() === 0,
      'A background server updates only its own silent store, without repainting the visible controls');
    show(a);
    check(blocks() === 1 && deafen().querySelector('[data-audio-block]').hidden,
      'Returning to a server displays its latest policy without a voice join');
    const beforeDuplicate = notifications;
    a.updateVoiceRestrictions(user.id, { serverMuted: true, serverDeafened: false });
    a.updateVoiceRestrictions('another-user', { serverMuted: false, serverDeafened: true });
    check(notifications === beforeDuplicate && blocks() === 1,
      'Duplicate updates and restrictions on another identity do not change the current user policy');
    a.updateVoiceRestrictions(user.id, {
      sessionId: 'another-device', serverMuted: false, serverDeafened: true,
    });
    check(blocks() === 2 && Object.keys(a.voiceRestrictions).sort().join(',') === 'serverDeafened,serverMuted',
      'An update for another device of the same identity applies outside voice without retaining transient session data');

    voice.setChannel('room-b', 'unrestricted-b');
    voice.setServerMuted(true);
    voice.setServerDeafened(true);
    a.updateVoiceRestrictions(user.id, { serverMuted: false, serverDeafened: false });
    check(blocks() === 0 && voice.getEffectiveMuted() && voice.getEffectiveDeafened(),
      'The visible server policy cannot clear the physical restrictions of a call on another server');
    a.updateVoiceRestrictions(user.id, { serverMuted: true, serverDeafened: false });
    check(blocks() === 1 && deafen().querySelector('[data-audio-block]').hidden,
      'Visible badges follow the browsed server, not the different policy of the active call');
    voice.reset();
    a.updateVoiceRestrictions(user.id, { serverMuted: false, serverDeafened: false });
    check(blocks() === 0, 'Administrative removal updates idle controls immediately without a voice event');
    a.updateVoiceRestrictions(user.id, { serverMuted: true, serverDeafened: true });
    view.render();
    check(blocks() === 2, 'Re-rendering after an authenticated snapshot preserves pre-call restrictions');
    a.clear();
    check(blocks() === 0 && !a.currentUser, 'Discarding a server session clears only its own displayed policy');
    a.updateVoiceRestrictions(undefined, { serverMuted: true, serverDeafened: true });
    check(blocks() === 0 && !a.voiceRestrictions.serverMuted && !a.voiceRestrictions.serverDeafened,
      'A late or unidentified notification cannot populate a store without an authenticated user');
    return checks;
  } finally {
    off();
    view.destroy();
    voice.reset();
    a.bus = b.bus = silent;
    servers.setActiveServerStore(previousStore);
    settings.inputMode = previousMode;
    soundEffects.play = previousPlay;
    root.remove();
  }
}

async function runSettingsNavigationSmoke() {
  const [{ SettingsModal }, { t }, { initTooltips }, { selectEnhancer }] = await Promise.all([
    import('/views/SettingsModal.ts'), import('/i18n/index.ts'), import('/core/TooltipService.ts'), import('/core/SelectEnhancer.ts'),
  ]);
  const offTooltips = initTooltips();
  selectEnhancer.init();
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  let starts = 0;
  let deactivations = 0;
  let cleanups = 0;
  let versions = 0;
  const modal = new SettingsModal();
  for (const key of ['accountTab', 'soundboardTab', 'stickersTab', 'keybindsTab', 'notificationsTab', 'qualityTab', 'logsTab']) {
    modal[key] = { renderHtml: () => '', attachEvents: () => {}, cleanup: () => {} };
  }
  modal.aboutTab = { renderHtml: () => '', attachEvents: () => {}, cleanup: () => {}, loadAppVersion: async () => { versions++; } };
  modal.voiceVideoTab = {
    renderHtml: () => '<label for="settings-select-fixture">Device</label><select id="settings-select-fixture" title="Device choice"><option value="one">One</option><option value="two">Two</option></select>',
    attachEvents: () => {}, refreshDevices: async () => {},
    startVadMeter: () => { starts++; }, deactivate: () => { deactivations++; }, cleanup: () => { cleanups++; },
  };
  try {
    await modal.open();
    check(starts === 0, 'Opening account settings must not start a hidden microphone meter');
    modal.close();
    await modal.open('voice_video');
    check(document.querySelector('#tab-panel-voice_video').style.display !== 'none'
      && document.querySelector('#settings-current-tab-title').textContent.includes(t('settings.tabVoiceVideo')),
    'Quick audio settings shortcut opens the voice tab directly');
    check(starts === 1, 'Visible voice settings starts its meter exactly once');
    const select = document.getElementById('settings-select-fixture');
    select.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    select.click();
    check(!!document.querySelector('.monky-select-popup') && select.title === 'Device choice',
      'Themed select opens inside settings while tooltip handling preserves its title API');
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(!document.querySelector('.monky-select-popup') && !!document.querySelector('.modal-backdrop--settings'),
      'Escape closes the dropdown without also closing its settings modal');
    const priorCleanup = cleanups;
    modal.switchTab('account');
    check(deactivations === 1 && cleanups === priorCleanup, 'Leaving voice stops media without removing the tab control bindings');
    modal.switchTab('voice_video');
    check(starts === 2 && cleanups === priorCleanup, 'Returning to voice resumes the meter without duplicating or dropping bindings');
    modal.close();
    check(cleanups === priorCleanup + 1, 'Closing settings performs full voice tab cleanup');
    let resolveRefresh;
    modal.voiceVideoTab.refreshDevices = () => new Promise(resolve => { resolveRefresh = resolve; });
    const priorStarts = starts;
    const priorVersions = versions;
    const opening = modal.open('voice_video');
    modal.close();
    resolveRefresh();
    await opening;
    check(starts === priorStarts && versions === priorVersions && !document.querySelector('.modal-backdrop--settings'),
      'Closing during async settings setup cannot start a late microphone preview');
    return checks;
  } finally {
    modal.close();
    selectEnhancer.dispose();
    offTooltips();
  }
}

async function runSidebarPttSmoke() {
  const [{ MainView }, { VoiceStageView }, ptt, { voiceStore: voice }, { settingsStore: settings },
    { appEvents }, { networkClient }, { soundEffects }, language, audioIcons, { OverlayStageView },
    servers, participants, routing, { userContextMenu }, { initTooltips }, { selectEnhancer }, { webRtcManager }, { sessionManager }, { updateLocalSpeaking }] = await Promise.all([
    import('/views/MainView.ts'), import('/views/VoiceStageView.ts'), import('/views/PttIndicator.ts'),
    import('/stores/voiceStore.ts'), import('/stores/settingsStore.ts'), import('/core/EventBus.ts'),
    import('/core/NetworkClient.ts'), import('/core/SoundEffects.ts'), import('/i18n/index.ts'),
    import('/views/AudioStateIcon.ts'), import('/views/OverlayStageView.ts'),
    import('/stores/serverStore.ts'), import('/core/ParticipantManager.ts'), import('/core/sessionRouting.ts'), import('/views/UserContextMenu.ts'),
    import('/core/TooltipService.ts'), import('/core/SelectEnhancer.ts'),
    import('/core/WebRtcManager.ts'),
    import('/core/SessionManager.ts'),
    import('/core/voiceControls.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  document.body.innerHTML = '<div id="app"></div><div id="ptt-stage-fixture"></div>';
  const root = document.getElementById('app');
  root.innerHTML = '<div class="user-quick-actions">' + ptt.renderMicrophoneButton()
    + '<button id="bar-btn-deafen" class="btn btn-icon">' + audioIcons.renderAudioStateIcon('headphones') + '</button></div>'
    + '<img id="main-user-avatar"><div id="voice-channels-list" style="width:250px"></div><div id="members-list-items"></div>';
  const view = new MainView(root);
  const stage = new VoiceStageView(document.getElementById('ptt-stage-fixture'));
  const send = networkClient.send;
  const play = soundEffects.play;
  const enumerateDevices = navigator.mediaDevices.enumerateDevices;
  networkClient.send = () => {};
  soundEffects.play = () => {};
  settings.inputMode = 'push_to_talk';
  voice.currentVoiceChannelId = 'ptt-sidebar-fixture';
  voice.isMuted = voice.isDeafened = voice.serverMuted = voice.serverDeafened = false;
  voice.setMicrophoneState(false, false);
  language.setLanguage('pt-BR');
  const offTooltips = initTooltips();
  selectEnhancer.init();
  const localUser = { id: 'ptt-local-user', sessionId: 'ptt-local-session', clientId: 'ptt-local-client', nickname: 'Local', status: 'ONLINE', joinedAt: 1 };
  const remoteUser = { ...localUser, id: 'ptt-remote-user', sessionId: 'ptt-remote-session', clientId: 'ptt-remote-client', nickname: 'Remote' };
  const server = servers.createServerStore();
  const manager = participants.createParticipantManager();
  servers.setActiveServerStore(server);
  participants.setActiveParticipantManager(manager);
  server.setServerDetails({
    id: 'ptt-server', name: 'PTT fixture', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: [{ id: voice.currentVoiceChannelId, serverId: 'ptt-server', name: 'Voice', type: 'VOICE', position: 0, createdAt: 1, isPrivate: false, allowedRoleIds: [] }],
    members: [localUser, remoteUser], knownMembers: [localUser, remoteUser], roles: [], userRoles: [], myPermissions: 2147483647, ownerId: localUser.id,
  }, localUser);
  manager.addUser(localUser);
  manager.updateVoiceState({
    sessionId: localUser.sessionId, userId: localUser.id, channelId: voice.currentVoiceChannelId,
    isMuted: false, isDeafened: false, serverMuted: false, serverDeafened: false,
    isSpeaking: false, isCameraOn: false, isScreenSharing: false,
  });
  manager.addUser(remoteUser);
  const remoteState = {
    ...manager.get(localUser.sessionId).voiceState, sessionId: remoteUser.sessionId, userId: remoteUser.id,
  };
  manager.updateVoiceState(remoteState);
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    view.renderChannels();
    view.renderMembers();
    view.attachEvents();
    const channelBlocks = () => root.querySelectorAll('#voice-mini-user-ptt-local-session [data-audio-block]:not([hidden])').length;
    const memberBlocks = () => root.querySelectorAll('.member-item[data-user-id="ptt-local-user"] [data-audio-block]:not([hidden])').length;
    manager.updateVoiceState({ ...remoteState, serverMuted: true, serverDeafened: true });
    await new Promise(resolve => requestAnimationFrame(resolve));
    check(root.querySelectorAll('#voice-mini-user-ptt-remote-session [data-audio-block]:not([hidden])').length === 2
      && root.querySelectorAll('.member-item[data-user-id="ptt-remote-user"] [data-audio-block]:not([hidden])').length === 2,
    'Participant updates must show remote administrative microphone and headphones in both lists');
    const adminStatusColor = getComputedStyle(root.querySelector('#voice-mini-user-ptt-remote-session [data-audio-icon]')).color;
    const colorProbe = document.createElement('span');
    colorProbe.style.color = 'var(--text-muted)';
    root.append(colorProbe);
    const personalStatusColor = getComputedStyle(colorProbe).color;
    colorProbe.remove();
    check(channelBlocks() === 0 && memberBlocks() === 0, 'Remote moderation must not change the local participant indicators');
    manager.updateVoiceState({ ...remoteState, isMuted: true });
    await new Promise(resolve => requestAnimationFrame(resolve));
    check(root.querySelectorAll('#voice-mini-user-ptt-remote-session [data-audio-block]:not([hidden])').length === 0
      && root.querySelector('#voice-mini-user-ptt-remote-session [data-audio-icon]').textContent === 'mic_off',
    'Clearing remote moderation must reveal the remaining personal mute');
    check(getComputedStyle(root.querySelector('#voice-mini-user-ptt-remote-session [data-audio-icon]')).color === personalStatusColor
      && personalStatusColor !== adminStatusColor, 'Personal mute in the channel is gray, unlike the unchanged administrative red');
    manager.updateVoiceState({ ...remoteState, isDeafened: true });
    await new Promise(resolve => requestAnimationFrame(resolve));
    check([...root.querySelectorAll('#voice-mini-user-ptt-remote-session [data-audio-icon]')]
      .every(element => getComputedStyle(element).color === personalStatusColor),
      'Personal deafen keeps both participant indicators gray');
    const button = root.querySelector('#bar-btn-mic');
    const icon = () => button.querySelector('[data-audio-icon]').textContent;
    const block = button.querySelector('[data-audio-block]');
    const deafenButton = root.querySelector('#bar-btn-deafen');
    const marker = button.querySelector('[data-ptt-mode]');
    check(!root.querySelector('[data-ptt-indicator]'), 'Sidebar must not add a separate PTT banner');
    check(button.dataset.state === 'closed' && icon() === 'keyboard_voice', 'PTT waiting must use its distinct voice-input icon');
    check(!marker.hidden && marker.textContent === 'PTT', 'PTT mode must remain identifiable on the microphone button');
    const waitingColor = getComputedStyle(button).color;
    check(button.getAttribute('aria-pressed') === 'false', 'Waiting for PTT is not manual mute');
    voice.setMicrophoneState(true, true);
    check(button.dataset.state === 'open' && icon() === 'mic' && button.dataset.pressed === 'true', 'Actual MainView binding must remain subscribed after attach cleanup');
    updateLocalSpeaking(true);
    check(root.querySelector('#main-user-avatar').classList.contains('speaking')
      && root.querySelector('#voice-mini-user-ptt-local-session').classList.contains('speaking'),
      'Live microphone activity lights both the footer avatar and its voice-channel participant');
    const openColor = getComputedStyle(button).color;
    check(openColor !== waitingColor, 'PTT open and waiting states must have different colors');
    const markerStyle = getComputedStyle(marker);
    check(markerStyle.boxShadow === 'none' && markerStyle.borderTopWidth === '0px' && markerStyle.outlineStyle === 'none', 'Pressed PTT must retain plain text without a border or outline');
    check(!voice.isMuted && button.getAttribute('aria-pressed') === 'false', 'PTT press must not toggle the manual mute preference');
    voice.setMicrophoneState(true, false);
    check(button.dataset.state === 'open' && button.dataset.pressed === 'false', 'Release delay remains visibly open without showing a held key');
    voice.setMicrophoneState(false, false);
    check(button.dataset.state === 'closed', 'Releasing the microphone returns the button to waiting');
    check(!root.querySelector('#main-user-avatar').classList.contains('speaking')
      && !root.querySelector('#voice-mini-user-ptt-local-session').classList.contains('speaking'),
      'Closing microphone transmission immediately removes both speaking borders');
    updateLocalSpeaking(false);
    view.attachEvents();
    button.click();
    check(voice.isMuted && button.dataset.state === 'muted' && icon() === 'mic_off', 'Clicking the reattached button must toggle manual mute exactly once');
    check(button.getAttribute('aria-pressed') === 'true' && button.title.includes('silenciado manualmente'), 'Manual mute must be explicit and accessible');
    const mutedColor = getComputedStyle(button).color;
    check(mutedColor !== waitingColor && mutedColor !== openColor && marker.hidden, 'Manual mute must have its own color without the PTT label');
    check(getComputedStyle(button.querySelector('[data-audio-icon]')).transform === 'none' && !button.title.includes('PTT'), 'Fully muted microphone must be centered and described independently of PTT');
    check(block.hidden, 'Personal mute must not display the administrative block symbol');
    voice.setMicrophoneState(true, true);
    check(voice.isMuted && button.dataset.state === 'muted' && marker.hidden, 'PTT state cannot visually override a manual mute or reveal its label');
    voice.setMicrophoneState(false, false);
    button.click();
    check(!voice.isMuted && button.dataset.state === 'closed' && !marker.hidden, 'Manual unmute restores the PTT label and waiting state, not an open microphone');
    voice.setDeafened(true);
    check(button.dataset.state === 'muted' && marker.hidden && button.title.includes('áudio desativado'), 'Deafen hides PTT and remains distinguishable from waiting');
    voice.setDeafened(false);
    voice.setServerMuted(true);
    server.updateVoiceRestrictions(localUser.id, voice);
    check(channelBlocks() === 1 && memberBlocks() === 1, 'Admin mute must immediately update actual channel and member lists without a participant echo');
    check(button.dataset.state === 'closed' && !marker.hidden && button.title.includes(language.t('permissions.serverMuted')),
      'Server mute adds its explanation without replacing personal PTT state');
    check(icon() === 'keyboard_voice' && !block.hidden && block.textContent === 'block'
      && getComputedStyle(button).color === waitingColor, 'Administrative blocking keeps the normal waiting icon and its color');
    check(getComputedStyle(block).color === adminStatusColor, 'The administrative badge stays red independently of the primary icon');
    voice.setMicrophoneState(true, true);
    check(button.dataset.state === 'closed' && icon() === 'keyboard_voice' && !marker.hidden,
      'A delayed microphone-open event cannot advertise PTT transmission under an administrative block');
    voice.setMicrophoneState(false, false);
    check(getComputedStyle(button.querySelector('[data-audio-icon]')).color !== getComputedStyle(button).backgroundColor,
      'Administrative microphone must remain visible against the muted button background');
    check(getComputedStyle(block).color !== getComputedStyle(block).backgroundColor,
      'Prohibition glyph must remain visible against its circular background');
    const badgeRect = block.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    check(badgeRect.width > 0 && badgeRect.top >= buttonRect.top && badgeRect.right <= buttonRect.right, 'Administrative badge must remain visible inside the button');
    button.click();
    check(voice.serverMuted && !block.hidden && marker.hidden && icon() === 'mic_off'
      && getComputedStyle(button).color === mutedColor, 'Personal mute visibly becomes red and crossed out while the administrative badge remains');
    button.click();
    check(!voice.isMuted && voice.getEffectiveMuted() && !block.hidden && icon() === 'keyboard_voice'
      && getComputedStyle(button).color === waitingColor, 'Personal unmute restores its icon without bypassing the actual server mute');
    button.click();
    voice.setServerMuted(false);
    server.updateVoiceRestrictions(localUser.id, voice);
    check(channelBlocks() === 0 && memberBlocks() === 0, 'Removing admin mute must clear both lists without a participant echo');
    check(voice.isMuted && icon() === 'mic_off' && block.hidden, 'Removing admin mute reveals an existing personal mute');
    button.click();
    settings.inputMode = 'voice_activity';
    appEvents.emit('settings.updated');
    const normalMicColor = getComputedStyle(button).color;
    const normalDeafenColor = getComputedStyle(deafenButton).color;
    voice.setServerDeafened(true);
    server.updateVoiceRestrictions(localUser.id, voice);
    check(channelBlocks() === 2 && memberBlocks() === 2, 'Admin deafen must immediately show blocked microphone and headphones in both lists');
    const channelRow = root.querySelector('#voice-mini-user-ptt-local-session');
    const memberRow = root.querySelector('.member-item[data-user-id="ptt-local-user"]');
    window.adminAudioChannelPreviewMarkup = channelRow.outerHTML;
    appEvents.emit('voice.state_updated');
    check(root.querySelector('#voice-mini-user-ptt-local-session') === channelRow
      && root.querySelector('.member-item[data-user-id="ptt-local-user"]') === memberRow,
    'Unchanged audio flags must not rebuild lists on frequent voice events');
    check(icon() === 'mic' && !block.hidden && marker.hidden && getComputedStyle(button).color === normalMicColor
      && !button.classList.contains('danger-active'), 'Admin deafen adds a red block without changing the personally open microphone');
    check(deafenButton.querySelector('[data-audio-icon]').textContent === 'headphones'
      && !deafenButton.querySelector('[data-audio-block]').hidden
      && deafenButton.title.includes(language.t('permissions.serverDeafened'))
      && deafenButton.title.includes(language.t('main.deafen'))
      && getComputedStyle(deafenButton).color === normalDeafenColor,
      'Admin deafen keeps normal headphones, its badge and the personal toggle action');
    deafenButton.click();
    check(voice.isDeafened && icon() === 'mic_off'
      && deafenButton.querySelector('[data-audio-icon]').textContent === 'headset_off'
      && !block.hidden && !deafenButton.querySelector('[data-audio-block]').hidden
      && getComputedStyle(deafenButton).color === mutedColor,
      'Personal deafen changes both icons visibly without removing administrative blocks');
    deafenButton.click();
    check(!voice.isDeafened && !voice.isMuted && voice.getEffectiveMuted() && voice.getEffectiveDeafened()
      && icon() === 'mic' && deafenButton.querySelector('[data-audio-icon]').textContent === 'headphones',
      'Personal undeafen restores normal icons while real administrative restrictions remain enforced');
    window.adminAudioPreviewMarkup = button.outerHTML + deafenButton.outerHTML;
    const originalVoiceSession = voice.voiceSessionKey;
    const moderatedSession = sessionManager.create('moderated.example', 3000, 'Local');
    moderatedSession.serverStore.setServerDetails({
      ...server.serverDetails, id: 'moderated-server', name: 'Server <A>',
      channels: server.serverDetails.channels.map(channel => ({ ...channel, name: 'Call on A' })),
    }, localUser);
    moderatedSession.participants.addUser(localUser);
    moderatedSession.participants.updateVoiceState({ ...manager.get(localUser.sessionId).voiceState, serverDeafened: true });
    moderatedSession.serverStore.updateVoiceRestrictions(localUser.id, voice);
    server.updateVoiceRestrictions(localUser.id, { serverMuted: false, serverDeafened: false });
    voice.voiceSessionKey = moderatedSession.key;
    appEvents.emit('voice.state_updated');
    view.renderChannels();
    view.renderMembers();
    check(channelBlocks() === 0 && memberBlocks() === 0,
      'A visible server must not inherit administrative badges from a call on another server');
    check(block.hidden && deafenButton.querySelector('[data-audio-block]').hidden,
      'Footer must not claim administrative restrictions belong to the server being viewed');
    check(voice.serverDeafened && voice.getEffectiveMuted() && voice.getEffectiveDeafened(),
      'Changing the visible server never unmutes the actual call');
    check(icon() === 'mic' && deafenButton.querySelector('[data-audio-icon]').textContent === 'headphones'
      && button.title === language.t('main.mute') && deafenButton.title === language.t('main.deafen')
      && getComputedStyle(button).color === normalMicColor && getComputedStyle(deafenButton).color === normalDeafenColor,
      'Another server shows only personal icons and actions, without importing the call server restriction');
    const { OverlayBridgeService } = await import('/core/OverlayBridgeService.ts');
    const bridge = new OverlayBridgeService();
    bridge.isOpen = true;
    const originalApi = window.api;
    let overlaySnapshot;
    window.api = { ...originalApi, sendOverlaySyncState: async state => { overlaySnapshot = state; } };
    try {
      bridge.syncState();
      check(overlaySnapshot?.channelName === 'Call on A' && overlaySnapshot.participants.length === 1
        && overlaySnapshot.participants[0].sessionId === localUser.sessionId && overlaySnapshot.participants[0].serverDeafened,
        'Floating overlay keeps the active call roster and restrictions while a different server is visible');
    } finally {
      window.api = originalApi;
    }
    voice.setServerDeafened(false);
    voice.setMicrophoneState(true, false);
    updateLocalSpeaking(true);
    check(voice.isSpeaking && moderatedSession.participants.get(localUser.sessionId).isSpeaking
      && !manager.get(localUser.sessionId).isSpeaking,
      'Local activity updates the call server instead of the currently visible participant store');
    check(root.querySelector('#main-user-avatar').classList.contains('speaking')
      && !root.querySelector('#voice-mini-user-ptt-local-session').classList.contains('speaking'),
      'The physical call may light the footer, but never a matching user row on another server');
    view.renderChannels();
    check(!root.querySelector('#voice-mini-user-ptt-local-session').classList.contains('speaking'),
      'Rebuilding the visible channel list does not import another server speech state');
    updateLocalSpeaking(false);
    voice.setMicrophoneState(false, false);
    voice.setServerDeafened(true);
    language.setLanguage('en');
    appEvents.emit('voice.state_updated');
    check(button.title === language.t('main.mute') && deafenButton.title === language.t('main.deafen'),
      'Personal tooltips stay localized without mentioning a hidden background-server restriction');
    language.setLanguage('pt-BR');
    voice.voiceSessionKey = originalVoiceSession;
    sessionManager.remove(moderatedSession.key);
    server.updateVoiceRestrictions(localUser.id, voice);
    appEvents.emit('voice.state_updated');
    view.renderChannels();
    view.renderMembers();
    check(channelBlocks() === 2 && memberBlocks() === 2 && !block.hidden,
      'Returning to the owning server restores its administrative indicators');
    voice.setServerDeafened(false);
    server.updateVoiceRestrictions(localUser.id, voice);
    check(channelBlocks() === 0 && memberBlocks() === 0, 'Removing admin deafen must clear both lists immediately');
    routing.setForegroundContext(false);
    voice.setServerMuted(true);
    check(channelBlocks() === 0, 'Background moderation must not redraw lists inside the session routing window');
    routing.setForegroundContext(true);
    await Promise.resolve();
    server.updateVoiceRestrictions(localUser.id, voice);
    check(channelBlocks() === 1 && memberBlocks() === 1, 'Background moderation must repaint after foreground stores are restored');
    voice.setServerMuted(false);
    server.updateVoiceRestrictions(localUser.id, voice);
    check(block.hidden && deafenButton.querySelector('[data-audio-block]').hidden, 'Removing moderation clears both prohibition badges');
    settings.inputMode = 'push_to_talk';
    appEvents.emit('settings.updated');
    voice.setMicrophoneState(true, false);
    updateLocalSpeaking(true);
    const speakingChannel = voice.currentVoiceChannelId;
    voice.setChannel(null);
    updateLocalSpeaking(true);
    view.renderChannels();
    check(!voice.isSpeaking && !manager.get(localUser.sessionId).isSpeaking
      && !root.querySelector('#main-user-avatar').classList.contains('speaking')
      && !root.querySelector('#voice-mini-user-ptt-local-session').classList.contains('speaking'),
      'Leaving the call rejects delayed speech and clears both indicators before the roster echo');
    voice.setChannel(speakingChannel);
    voice.setMicrophoneState(false, false);
    const manualMuted = voice.isMuted;
    voice.setServerMuted(true);
    voice.setServerDeafened(true);
    server.updateVoiceRestrictions(localUser.id, voice);
    voice.setChannel('ptt-sidebar-fixture', 'other-server');
    check(!voice.serverMuted && !voice.serverDeafened && voice.isMuted === manualMuted,
      'Changing call server clears only the old server restrictions, never personal mute');
    check(!block.hidden && !deafenButton.querySelector('[data-audio-block]').hidden,
      'Changing call server preserves the policy of the server still being viewed');
    server.updateVoiceRestrictions(localUser.id, { serverMuted: false, serverDeafened: false });
    voice.setChannel('ptt-sidebar-fixture');
    voice.setChannel(null);
    check(button.dataset.state === 'inactive' && !marker.hidden, 'PTT mode remains visible outside a call');
    button.click();
    check(voice.isMuted && button.dataset.state === 'muted' && marker.hidden, 'Manual pre-mute stays red without PTT even outside a call');
    language.setLanguage('en');
    check(button.title.includes('manually muted'), 'Microphone descriptions must follow the selected language');
    settings.inputMode = 'voice_activity';
    appEvents.emit('settings.updated');
    check(marker.hidden && icon() === 'mic_off', 'VAD hides the PTT label without changing manual mute');
    button.click();
    check(icon() === 'mic' && button.dataset.state === 'idle', 'Unmuted VAD keeps the normal microphone icon');
    settings.inputMode = 'push_to_talk';
    appEvents.emit('settings.updated');
    stage.setChannel('ptt-sidebar-fixture');
    check(!!document.querySelector('.stage-call-controls') && !document.querySelector('#ptt-stage-fixture [data-ptt-indicator]'), 'The actual stage must retain its controls without a separate PTT indicator');
    const pingBadge = document.getElementById('stage-ping-badge');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    pingBadge.focus();
    check(pingBadge.getAttribute('aria-describedby')?.includes('monky-tooltip')
      && !!document.querySelector('.monky-tooltip:not([hidden])')?.textContent.trim()
      && !document.querySelector('.ping-tooltip'), 'Actual stage latency details use the same immediate accessible tooltip');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    voice.setServerDeafened(true);
    server.updateVoiceRestrictions(localUser.id, voice);
    for (const id of ['stage-btn-mic', 'stage-btn-deafen']) {
      check(!document.getElementById(id).querySelector('[data-audio-block]').hidden, 'Stage controls must also distinguish admin restrictions');
    }
    voice.setServerDeafened(false);
    server.updateVoiceRestrictions(localUser.id, voice);
    const statuses = document.createElement('div');
    root.append(statuses);
    const priorInputMode = settings.inputMode;
    const priorAudioState = {
      isMuted: voice.isMuted, isDeafened: voice.isDeafened,
      serverMuted: voice.serverMuted, serverDeafened: voice.serverDeafened,
    };
    settings.inputMode = 'voice_activity';
    appEvents.emit('settings.updated');
    for (let flags = 0; flags < 16; flags++) {
      const audioState = {
        isMuted: !!(flags & 1), isDeafened: !!(flags & 2),
        serverMuted: !!(flags & 4), serverDeafened: !!(flags & 8),
      };
      statuses.innerHTML = audioIcons.renderAudioMuteIndicators(audioState);
      const expectedBlocks = Number(audioState.serverMuted || audioState.serverDeafened) + Number(audioState.serverDeafened);
      check(statuses.querySelectorAll('[data-audio-block]:not([hidden])').length === expectedBlocks, 'Participant indicators must prioritize admin restrictions without duplicate badges');
      check([...statuses.querySelectorAll('[role="img"]')].every(e => e.getAttribute('aria-label')), 'Participant audio indicators must have localized accessible names');
      check([...statuses.querySelectorAll('.audio-state-icon')].every(element =>
        getComputedStyle(element.querySelector('[data-audio-icon]')).color
          === (element.classList.contains('audio-state-icon--blocked') ? adminStatusColor : personalStatusColor)),
        'All participant mute/deafen combinations preserve gray personal and red administrative indicators');
      Object.assign(voice, audioState);
      server.updateVoiceRestrictions(localUser.id, audioState);
      appEvents.emit('voice.state_updated');
      for (const id of ['bar-btn-mic', 'stage-btn-mic']) {
        const control = document.getElementById(id);
        const personalMuted = audioState.isMuted || audioState.isDeafened;
        check(control.querySelector('[data-audio-icon]').textContent === (personalMuted ? 'mic_off' : 'mic')
          && control.classList.contains('danger-active') === personalMuted
          && control.getAttribute('aria-pressed') === String(audioState.isMuted)
          && control.querySelector('[data-audio-block]').hidden === !(audioState.serverMuted || audioState.serverDeafened),
          `${id}: primary microphone and administrative badge stay independent for every combination`);
      }
      for (const id of ['bar-btn-deafen', 'stage-btn-deafen']) {
        const control = document.getElementById(id);
        check(control.querySelector('[data-audio-icon]').textContent === (audioState.isDeafened ? 'headset_off' : 'headphones')
          && control.classList.contains('danger-active') === audioState.isDeafened
          && control.getAttribute('aria-pressed') === String(audioState.isDeafened)
          && control.querySelector('[data-audio-block]').hidden === !audioState.serverDeafened,
          `${id}: primary headphones and administrative badge stay independent for every combination`);
      }
    }
    Object.assign(voice, priorAudioState);
    server.updateVoiceRestrictions(localUser.id, priorAudioState);
    settings.inputMode = priorInputMode;
    appEvents.emit('settings.updated');
    appEvents.emit('voice.state_updated');
    const overlay = new OverlayStageView(document.createElement('div'));
    const overlayState = { isMuted: false, isDeafened: false, serverMuted: true, serverDeafened: true, screenShareIds: [], isCameraOn: false };
    statuses.innerHTML = overlay.getMiniIconsHtml(overlayState);
    check(statuses.querySelectorAll('[data-audio-block]:not([hidden])').length === 2, 'Minimal overlay must display both administrative restrictions');
    statuses.innerHTML = overlay.getBadgesHtml({ p: overlayState, kind: 'camera' });
    check(statuses.querySelectorAll('[data-audio-block]:not([hidden])').length === 2, 'Overlay video tiles must retain administrative badges');
    statuses.innerHTML = audioIcons.renderAudioMuteIndicators({ isMuted: false, isDeafened: true }, { showMicrophone: false });
    check(statuses.querySelectorAll('[data-audio-icon]').length === 1, 'Member-list masking must preserve audio status without adding a microphone outside voice');
    statuses.remove();
    stage.destroy();
    view.destroy();
    const previousState = button.dataset.state;
    voice.setMicrophoneState(true, true);
    button.click();
    check(button.dataset.state === previousState && !voice.isMuted, 'Destroy must release microphone state and click listeners');
    voice.currentVoiceChannelId = 'ptt-sidebar-fixture';
    document.getElementById('ptt-stage-fixture').style.display = 'none';
    view.render();
    language.setLanguage('pt-BR');
    const healthChanged = webRtcManager.sfuEngine.callbacks.onHealthChanged;
    const connectionRow = () => root.querySelector('#voice-connection-row');
    const connectionStatus = () => root.querySelector('.voice-conn-status');
    const connectionSignal = () => root.querySelector('.voice-conn-signal');
    const previews = [];
    const captureConnection = () => previews.push(`<div style="width:300px;">${connectionRow().outerHTML}</div>`);
    healthChanged('connecting');
    check(voice.isConnecting && !voice.isReconnecting && connectionRow().classList.contains('connecting')
      && connectionStatus().textContent === 'Conectando…', 'Actual SFU initial health renders connecting, never reconnecting');
    check(connectionSignal().textContent === 'sync'
      && getComputedStyle(connectionSignal()).animationName === 'reconnect-spin',
      'Initial connection uses the rotating sync icon');
    check(root.querySelector('.voice-conn-info').title === language.t('main.connectingTitle')
      && root.querySelector('#sidebar-voice-ping').textContent === '-- ms',
      'Connecting tooltip explains initial setup without claiming measured latency');
    const connectingColor = getComputedStyle(connectionStatus()).color;
    captureConnection();
    healthChanged('connected');
    await Promise.resolve();
    check(!voice.isConnecting && !voice.isReconnecting && connectionStatus().textContent === language.t('main.voiceConnected')
      && connectionSignal().textContent === 'rss_feed', 'Connected health restores the normal voice status and RSS icon');
    const connectedColor = getComputedStyle(connectionStatus()).color;
    captureConnection();
    healthChanged('reconnecting');
    check(connectionStatus().textContent === 'Reconectando…' && connectionSignal().textContent === 'signal_wifi_bad',
      'Real connection loss keeps its recovery text and warning icon');
    check(getComputedStyle(connectionStatus()).color !== connectingColor
      && getComputedStyle(connectionStatus()).color !== connectedColor && connectingColor !== connectedColor,
      'Connecting, connected and reconnecting have distinct status colors');
    captureConnection();
    healthChanged('connecting');
    check(voice.isReconnecting && connectionStatus().textContent === 'Reconectando…',
      'Rebuilding SFU transports during recovery must not flash initial connecting');
    healthChanged('connected');
    language.setLanguage('en');
    healthChanged('connecting');
    check(connectionStatus().textContent === 'Connecting…'
      && root.querySelector('.voice-conn-info').title === 'Establishing the voice connection',
      'Initial connection status and tooltip follow the selected language');
    healthChanged('connected');
    window.voiceConnectionPreviewMarkup = previews.join('');
    check(root.querySelectorAll('.audio-control-group').length === 2
      && root.querySelectorAll('button.audio-device-trigger').length === 2, 'Actual MainView must render independent microphone and output device arrows');
    const footerRect = root.querySelector('.user-control-bar').getBoundingClientRect();
    for (const trigger of root.querySelectorAll('button.audio-device-trigger')) {
      const rect = trigger.getBoundingClientRect();
      check(trigger.getAttribute('aria-expanded') === 'false' && rect.width > 0
        && rect.left >= footerRect.left && rect.right <= footerRect.right,
      'Device arrows must be accessible, visible and contained inside the actual footer');
    }
    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: 'default', kind: 'audiooutput', label: 'System output', groupId: 'audio' },
    ];
    const outputTrigger = root.querySelector('[data-audio-device="output"]');
    outputTrigger.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const outputPanel = document.querySelector('.audio-device-popover');
    check(!!outputPanel && outputTrigger.getAttribute('aria-expanded') === 'true', 'Actual output arrow must open its device panel without toggling mute');
    const selectRect = outputPanel.querySelector('.audio-device-current').getBoundingClientRect();
    check([selectRect.left + 8, selectRect.left + selectRect.width / 2, selectRect.right - 8].every(x =>
      outputPanel.contains(document.elementFromPoint(x, selectRect.top + selectRect.height / 2))),
      'Device selector must appear above the floating footer, not hidden behind its media buttons');
    check(outputPanel.getBoundingClientRect().bottom <= outputTrigger.getBoundingClientRect().top,
      'Actual footer device panel must open upward');
    window.mainAudioControlsPreviewMarkup = root.innerHTML + outputPanel.outerHTML;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(!document.querySelector('.audio-device-popover') && document.activeElement === outputTrigger,
      'Escape closes actual footer panel and restores arrow focus');
    for (const element of [
      root.querySelector('#user-profile-btn'),
      root.querySelector('#voice-mini-user-ptt-local-session'),
      root.querySelector('.member-item[data-user-id="ptt-local-user"]'),
    ]) {
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 100 }));
      check(!!document.querySelector('.user-context-menu [data-action="self-mute"]')
        && !document.querySelector('.user-context-menu #ctx-volume-slider'),
      'Own profile, channel row and member row must all open the same menu without self volume');
      userContextMenu.close();
    }
    const originalJoin = view.handleJoinVoiceChannel;
    const originalSetView = view.setActiveContentView;
    const originalActiveKey = sessionManager.getActiveKey;
    const priorVoiceChannel = voice.currentVoiceChannelId;
    const priorVoiceKey = voice.voiceSessionKey;
    let visibleKey = 'stage-entry-fixture';
    sessionManager.getActiveKey = () => visibleKey;
    try {
      for (const outcome of ['denied', 'denied-provisional', 'cancelled', 'different-channel', 'different-server', 'accepted']) {
        visibleKey = 'stage-entry-fixture';
        voice.setChannel(null);
        let resolveJoin;
        let called = false;
        const opened = [];
        view.handleJoinVoiceChannel = async () => {
          called = true;
          if (outcome === 'denied-provisional') voice.setChannel('ptt-sidebar-fixture', visibleKey);
          await new Promise(resolve => { resolveJoin = resolve; });
          return outcome === 'accepted' || outcome === 'different-server' || outcome === 'different-channel';
        };
        view.setActiveContentView = value => { opened.push(value); };
        root.querySelector('.channel-item[data-channel-type="VOICE"]').click();
        check(called && opened.length === 0, `${outcome}: stage remains closed while admission is pending`);
        if (outcome === 'different-channel') voice.setChannel('newer-call', visibleKey);
        else if (outcome === 'accepted' || outcome === 'different-server') {
          voice.setChannel('ptt-sidebar-fixture', visibleKey);
          if (outcome === 'different-server') visibleKey = 'newly-visible-server';
        } else if (outcome === 'cancelled') voice.reset();
        resolveJoin();
        await new Promise(resolve => setTimeout(resolve, 0));
        check(opened.filter(value => value === 'stage').length === (outcome === 'accepted' ? 1 : 0),
          `${outcome}: stage opens only for confirmed admission on the still-visible server`);
      }
      view.handleJoinVoiceChannel = originalJoin;
      const session = sessionManager.create('stage-admission-fixture', 0, 'Local');
      session.serverStore.setServerDetails({ ...server.serverDetails }, localUser);
      session.serverStore.hasPermission = () => true;
      session.client.getStatus = () => 'CONNECTED';
      session.client.send = () => {};
      const originalActive = sessionManager.getActive;
      sessionManager.getActive = () => session;
      visibleKey = session.key;
      let resolveAdmission;
      let requests = 0;
      const opened = [];
      session.client.sendRequest = () => {
        requests++;
        return new Promise(resolve => { resolveAdmission = resolve; });
      };
      view.setActiveContentView = value => { opened.push(value); };
      try {
        voice.setChannel(null);
        view.renderChannels();
        root.querySelector('.channel-item[data-channel-type="VOICE"]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        check(requests === 1 && voice.currentVoiceChannelId === 'ptt-sidebar-fixture',
          'Real admission provisions the intended channel while awaiting its response');
        root.querySelector('.channel-item[data-channel-type="VOICE"]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        check(requests === 1 && !opened.includes('stage'),
          'A second click cannot treat provisional voice membership as a completed admission');
        voice.reset();
        resolveAdmission({});
        await new Promise(resolve => setTimeout(resolve, 0));
        check(!opened.includes('stage'), 'Cancelling a double-clicked admission must not open the stage');
      } finally {
        voice.reset();
        resolveAdmission?.({});
        await new Promise(resolve => setTimeout(resolve, 0));
        sessionManager.getActive = originalActive;
        sessionManager.remove(session.key);
      }
    } finally {
      view.handleJoinVoiceChannel = originalJoin;
      view.setActiveContentView = originalSetView;
      sessionManager.getActiveKey = originalActiveKey;
      voice.setChannel(priorVoiceChannel, priorVoiceKey);
    }
    const ownProfile = root.querySelector('#user-profile-btn');
    view.destroy();
    ownProfile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    check(!document.querySelector('.user-context-menu'), 'Destroy must release the own-profile context menu listener');
    return checks;
  } finally {
    routing.setForegroundContext(true);
    selectEnhancer.dispose();
    offTooltips();
    userContextMenu.close();
    stage.destroy();
    view.destroy();
    networkClient.send = send;
    soundEffects.play = play;
    navigator.mediaDevices.enumerateDevices = enumerateDevices;
    voice.reset();
    root.remove();
    document.getElementById('ptt-stage-fixture').remove();
  }
}

async function runDomSmoke() {
  const [{ ChatView }, chats, servers, networks, events, inputs, catalog, language, proxies, botEvents] = await Promise.all([
    import('/views/ChatView.ts'), import('/stores/chatStore.ts'), import('/stores/serverStore.ts'),
    import('/core/NetworkClient.ts'), import('/core/EventBus.ts'), import('/utils/botInputs.ts'),
    import('/utils/commandCatalog.ts'), import('/i18n/index.ts'), import('/core/activeProxy.ts'), import('/core/botChatEvents.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const find = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  const type = (element, value) => { element.focus(); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (element, value) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('DOM fixture condition did not settle');
  };
  const option = (name) => {
    const row = [...document.querySelectorAll('[data-parameter-option]')].find((element) => element.querySelector('strong')?.textContent === name);
    if (!row) throw new Error(`Missing parameter choice ${name}`);
    return row;
  };
  language.setLanguage('pt-BR');
  localStorage.removeItem(catalog.COMMAND_USAGE_STORAGE_KEY);
  const caller = { id: 'alice', clientId: 'alice-client', nickname: 'Alice', status: 'ONLINE', joinedAt: 1 };
  const otherCaller = { ...caller, id: 'bob', clientId: 'bob-client', nickname: 'Bob' };
  const store = chats.createChatStore();
  const server = servers.createServerStore();
  const client = networks.createNetworkClient();
  const sent = [];
  client.getStatus = () => 'CONNECTED';
  client.getCurrentServerUrl = () => 'wss://command-fixture.example/';
  client.send = (messageType, payload) => sent.push({ type: messageType, payload });
  chats.setActiveChatStore(store);
  servers.setActiveServerStore(server);
  networks.setActiveNetworkClient(client);
  const previousPreviewApi = window.api;
  const previewLoads = [];
  const previewCancels = [];
  const syntheticWave = () => {
    const sampleRate = 8000;
    const samples = 800;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const write = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    write(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    write(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, samples * 2, true);
    return new Uint8Array(buffer);
  };
  window.api = {
    ...previousPreviewApi,
    loadAudioPreview: async input => {
      previewLoads.push(input);
      return { status: 'ready', data: syntheticWave(), mimeType: 'audio/wav' };
    },
    cancelAudioPreview: async input => { previewCancels.push(input); return true; },
  };
  const unbindBotEvents = botEvents.bindBotChatEvents();
  const refreshRegistry = (commands) => events.appEvents.emit('message.COMMANDS_LIST_RESPONSE', { commands });
  server.setServerDetails({
    id: 'command-dom-server', name: 'Command DOM', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: ['one', 'two'].map((id, position) => ({
      id, serverId: 'command-dom-server', name: id === 'one' ? 'general' : 'other', type: 'TEXT',
      position, createdAt: 1, isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
    })),
    members: [caller, otherCaller], knownMembers: [caller, otherCaller], roles: [], userRoles: [],
    myPermissions: 2147483647, ownerId: caller.id,
  }, caller);
  const command = {
    name: 'play', description: 'Choose a song with the full title', botId: 'music-one', botName: 'Monky Music',
    botAvatarUrl: '/assets/Logo.png',
    options: [
      { name: 'song', description: 'Full song title', type: 'string', required: true },
      { name: 'count', description: 'Repeat count', type: 'integer', required: true, min: 0, max: 10 },
      { name: 'private', description: 'Private playback', type: 'boolean' },
      { name: 'member', description: 'Member', type: 'user' },
      { name: 'mode', description: 'Playback mode', type: 'string', choices: [
        { label: 'Ordered', value: 'ordered', description: 'Generic audio choice',
          audio: { url: 'https://audio.example.test/ordered.wav', fileName: 'ordered.wav', durationMs: 4200 } },
        { label: 'Shuffle', value: 'shuffle' },
      ] },
    ],
  };
  const duplicate = { ...command, botId: 'music-two', botName: 'Second Music', botAvatarUrl: null };
  const ping = { ...command, name: 'ping', description: 'Check the bot', options: [] };
  refreshRegistry([command, duplicate, ping]);
  const container = find('#app');
  container.style.cssText = 'height:calc(100vh - 24px);width:calc(100vw - 24px);margin:12px auto;display:flex;flex-direction:column;flex:none;';
  const view = new ChatView(container);
  view.setChannel('one');
  await document.fonts.ready;
  await frame();
  // Chat actions and both emoji picker modes share the real renderer DOM.
  const [{ recentEmojis, RECENT_EMOJIS_KEY }, { contextMenu }, { userContextMenu }] = await Promise.all([
    import('/emoji/recentEmojis.ts'), import('/views/ContextMenu.ts'), import('/views/UserContextMenu.ts'),
  ]);
  localStorage.removeItem(RECENT_EMOJIS_KEY);
  const original = { id: 'chat-original', channelId: 'one', userId: 'bob', userNickname: 'Bob', content: 'Original <safe>', createdAt: 1 };
  store.addMessage(original);
  const row = find('[data-message-id="chat-original"].chat-message-row');
  const rightClick = element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 100 }));
  try {
    rightClick(row.querySelector('.chat-author-name'));
    check(!!document.querySelector('.user-context-menu #ctx-volume-slider'), 'Right-clicking another chat author must open their user menu');
    userContextMenu.close();
    server.currentUser = otherCaller;
    rightClick(row.querySelector('.chat-author-name'));
    check(!!document.querySelector('.user-context-menu [data-action="self-mute"]')
      && !document.querySelector('.user-context-menu #ctx-volume-slider'), 'Right-clicking own chat name opens manual controls without self volume');
    rightClick(row.querySelector('.chat-message-text'));
    check(!!document.querySelector('.floating-context-menu') && !document.querySelector('.user-context-menu'), 'Message body retains message actions rather than opening the user menu');
    rightClick(row.querySelector('.chat-author-avatar'));
    check(!!document.querySelector('.user-context-menu [data-action="self-deafen"]')
      && !document.querySelector('.floating-context-menu'), 'Own chat avatar opens the user menu and closes message actions');
  } finally {
    contextMenu.close();
    userContextMenu.close();
    server.currentUser = caller;
  }
  const beforeHeight = row.getBoundingClientRect().height;
  find('[data-message-id="chat-original"] [data-message-action="reply"]').focus();
  await frame();
  check(getComputedStyle(find('.chat-message-toolbar')).opacity === '1', 'Keyboard focus must reveal floating message actions');
  check(row.getBoundingClientRect().height === beforeHeight, 'Message toolbar must not shift chat layout');
  check(getComputedStyle(find('[data-message-action="emoji"]')).opacity === '1', 'Enabled emoji action must not look disabled');
  const messagePermissions = server.myPermissions;
  server.myPermissions = 0;
  events.appEvents.emit('server.roles_updated');
  check(find('[data-message-action="emoji"]').disabled, 'Emoji action must remain disabled without message permission');
  check(getComputedStyle(find('[data-message-action="emoji"]')).opacity === '0.4', 'Disabled emoji action must retain the toolbar disabled styling');
  server.myPermissions = messagePermissions;
  events.appEvents.emit('server.roles_updated');
  check(!find('[data-message-action="emoji"]').disabled && getComputedStyle(find('[data-message-action="emoji"]')).opacity === '1', 'Restoring permission must restore full emoji opacity');
  find('[data-message-action="more"]').click();
  check(document.querySelectorAll('.floating-context-menu [role="menuitem"]').length === 4, 'Other authors offer emoji, reply, copy and moderator delete but not edit');
  key(document.activeElement, 'ArrowDown');
  check(document.activeElement.textContent.includes('Responder'), 'Arrow keys must navigate message menu');
  key(document.activeElement, 'Escape');
  check(!document.querySelector('.floating-context-menu'), 'Escape must close message menu');
  check(document.activeElement.dataset.messageAction === 'more', 'Escape must return focus to toolbar');
  const originalWriteText = navigator.clipboard.writeText;
  let copiedMessage = '';
  let finishCopy;
  navigator.clipboard.writeText = (value) => new Promise((resolve) => { copiedMessage = value; finishCopy = resolve; });
  try {
    const copyToolbar = find('.chat-message-toolbar');
    const toolbarWidth = copyToolbar.getBoundingClientRect().width;
    const copyLabel = find('[data-message-action="copy"]').getAttribute('aria-label');
    find('[data-message-action="copy"]').click();
    check(!document.querySelector('.chat-copy-toast'), 'Copy must not report success before the clipboard write finishes');
    finishCopy();
    await Promise.resolve();
    check(copiedMessage === original.content, 'Copy message must preserve plain source text without markup');
    check(find('.chat-copy-toast-label').textContent === 'Copiado!', 'Copy success must display a localized toast');
    check(find('.chat-copy-toast').parentElement === document.body && getComputedStyle(find('.chat-copy-toast')).position === 'fixed', 'Copy toast must be outside the hover toolbar and anchored to the viewport');
    check(find('.chat-copy-toast').getAttribute('role') === 'status', 'Copy toast must expose accessible status feedback');
    check(getComputedStyle(find('.chat-copy-toast')).pointerEvents === 'none', 'Copy toast must not intercept clicks');
    check(copyToolbar.getBoundingClientRect().width === toolbarWidth && !copyToolbar.textContent.includes('Copiado!'), 'Copy feedback must not change the hover toolbar layout or content');
    check(find('[data-message-action="copy"] .material-symbols-outlined').textContent === 'content_copy', 'Copy button must retain its original icon');
    check(find('[data-message-action="copy"]').getAttribute('aria-label') === copyLabel, 'Copy button must retain its action label');
    find('#chat-message-input').focus();
    check(getComputedStyle(copyToolbar).opacity === '0' && !!document.querySelector('.chat-copy-toast'), 'Toast must remain visible without forcing the hover toolbar open');
    await new Promise((resolve) => setTimeout(resolve, 850));
    language.setLanguage('en');
    navigator.clipboard.writeText = async (value) => { copiedMessage = value; };
    find('[data-message-action="more"]').click();
    const menuCopy = [...document.querySelectorAll('.floating-context-menu [role="menuitem"]')]
      .find((button) => button.textContent.includes('Copy message'));
    check(!!menuCopy, 'Message menu must expose its localized copy action');
    menuCopy.click();
    await Promise.resolve();
    check(!document.querySelector('.floating-context-menu'), 'Copy from menu must close the menu');
    check(find('.chat-copy-toast-label').textContent === 'Copied!', 'Menu copy must show the same toast in English');
    check(document.querySelectorAll('.chat-copy-toast').length === 1, 'Repeated copies must replace the toast instead of stacking');
    await new Promise((resolve) => setTimeout(resolve, 850));
    check(!!document.querySelector('.chat-copy-toast'), 'Copying again must renew the toast duration');
    await new Promise((resolve) => setTimeout(resolve, 850));
    check(!document.querySelector('.chat-copy-toast'), 'Copy toast must disappear automatically');
    check(find('[data-message-action="copy"]').getAttribute('aria-label') === copyLabel, 'Copy action label must remain unchanged after toast dismissal');
    language.setLanguage('pt-BR');
    navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied by fixture'); };
    find('[data-message-action="copy"]').click();
    await Promise.resolve();
    check(!document.querySelector('.chat-copy-toast'), 'Clipboard failure must never show a success toast');
    check(find('.dialog-message').textContent === 'Não foi possível copiar a mensagem.', 'Clipboard failure must retain localized error feedback');
    find('.dialog-card [data-action="confirm"]').click();
    navigator.clipboard.writeText = async () => {};
    find('[data-message-action="copy"]').click();
    await Promise.resolve();
    view.setChannel('two');
    check(!document.querySelector('.chat-copy-toast'), 'Changing channels must clean up the active copy toast');
    view.setChannel('one');
    navigator.clipboard.writeText = () => new Promise((resolve) => { finishCopy = resolve; });
    find('[data-message-action="copy"]').click();
    view.destroy();
    finishCopy();
    await Promise.resolve();
    check(!document.querySelector('.chat-copy-toast'), 'Clipboard completion after view destruction must not resurrect a toast');
    view.render();
  } finally {
    navigator.clipboard.writeText = originalWriteText;
    language.setLanguage('pt-BR');
  }
  find('[data-message-action="reply"]').click();
  check(!find('#chat-reply-composer').hidden && find('#chat-reply-composer').textContent.includes('Bob'), 'Reply composer must name the original author');
  type(find('#chat-message-input'), 'Answer');
  key(find('#chat-message-input'), 'Enter');
  check(sent.at(-1).payload.replyToMessageId === original.id && sent.at(-1).payload.content === 'Answer', 'Composer must send only the selected reply ID with text');
  check(find('#chat-reply-composer').hidden, 'Sending must clear reply draft');
  store.addMessage({ ...original, id: 'chat-response', content: 'Answer', createdAt: 2, reply: store.messageReply(original) });
  check(find('[data-reply-target]').textContent.includes('Original <safe>'), 'Reply preview must escape untrusted text');
  find('[data-reply-target]').click();
  check(document.activeElement.dataset.messageId === original.id, 'Clicking reply must focus original message');
  store.updateMessage({ ...original, content: 'Edited original', editedAt: 3 });
  check(find('[data-reply-target]').textContent.includes('Edited original'), 'Editing original must update reply previews live');
  store.updateMessage({ ...original, content: '', deletedAt: 4 });
  check(find('[data-reply-target]').disabled && find('[data-reply-target]').textContent.includes('Mensagem apagada'), 'Deleted originals must lose preview and navigation');
  store.addMessage({ ...original, id: 'chat-missing-reference', createdAt: 5, reply: { ...store.messageReply(original), messageId: 'very-old' } });
  find('[data-reply-target="very-old"]').click();
  check(sent.at(-1).type === 'CHAT_LOAD_HISTORY' && sent.at(-1).payload.aroundMessageId === 'very-old', 'Uncached originals must request an exact history window');
  store.setHistory('one', [{ ...original, id: 'very-old' }], 'very-old');
  check(document.activeElement.dataset.messageId === 'very-old', 'Loaded old reference must receive navigation focus');
  check(!find('#chat-return-latest').hidden, 'History navigation must offer return to latest');
  find('#chat-return-latest').click();
  check(sent.at(-1).type === 'CHAT_LOAD_HISTORY' && !sent.at(-1).payload.aroundMessageId, 'Return to latest must request normal history');
  find('#btn-emoji').click();
  await frame();
  check(!document.querySelector('[data-picker-tab="recent"]'), 'Recent must not be a top-level picker tab');
  check(document.querySelectorAll('[data-picker-tab]').length === 2, 'Composer picker must keep only emoji and sticker tabs');
  check(find('.emoji-picker-nav').firstElementChild.dataset.gotoGroup === 'recent', 'Clock must be the first bottom category');
  check(find('[data-goto-group="recent"] .material-symbols-outlined').textContent === 'schedule', 'Recent category must use a clock icon');
  check(find('[data-goto-group="recent"]').getAttribute('aria-label') === 'Recentes', 'Recent category must have a localized accessible label');
  const checkPickerSearch = () => {
    const search = find('.emoji-picker-search-input');
    search.focus();
    const style = getComputedStyle(search);
    check(style.borderTopWidth === '0px' && style.borderLeftWidth === '0px', 'Search input must not inherit an inner border');
    check(style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.paddingLeft === '0px', 'Search input must not inherit an inner box or padding');
    check(getComputedStyle(find('.emoji-picker-search')).borderTopWidth === '1px', 'Search wrapper must retain its single outer border');
  };
  checkPickerSearch();
  find('[data-goto-group="smileys"]').click();
  await frame();
  check(find('.emoji-picker-body').scrollTop > 0, 'Existing category buttons must still navigate the catalog');
  find('[data-goto-group="recent"]').click();
  for (let attempt = 0; attempt < 60 && find('.emoji-picker-body').scrollTop > 0; attempt++) await frame();
  check(find('.emoji-picker-body').scrollTop === 0, 'Recent clock must navigate back to the first category');
  check(!!document.querySelector('[data-emoji-group="recent"] .emoji-picker-recent-empty'), 'Empty recent category must explain how it is populated');
  check(recentEmojis.get().length === 0, 'Opening recent category must not record an emoji');
  type(find('.emoji-picker-search-input'), 'coracao');
  check(!!document.querySelector('[data-emoji]'), 'Emoji search must still query the full catalog');
  type(find('.emoji-picker-search-input'), '');
  check(!!document.querySelector('[data-goto-group="recent"]'), 'Clearing search must restore recent category navigation');
  find('[data-picker-tab="stickers"]').click();
  checkPickerSearch();
  check(!document.querySelector('[data-goto-group="recent"]'), 'Sticker tab must not contain emoji categories');
  find('[data-picker-tab="emojis"]').click();
  const emojiButton = find('[data-emoji]');
  const selectedEmoji = emojiButton.dataset.emoji;
  emojiButton.click();
  check(find('[data-emoji-group="recent"] [data-emoji]').dataset.emoji === selectedEmoji, 'Selecting an emoji must refresh the recent section in place');
  key(document.activeElement, 'Escape');
  check(recentEmojis.get()[0] === selectedEmoji, 'Actual composer selection must persist recency');
  find('.chat-reaction-add').click();
  await frame();
  check(!!document.querySelector('[data-goto-group="recent"]') && !document.querySelector('.emoji-picker-tabs'), 'Reaction picker must have Recent in its category bar, without redundant tabs');
  checkPickerSearch();
  find('[data-goto-group="recent"]').click();
  check(find('[data-emoji-group="recent"] [data-emoji]').dataset.emoji === selectedEmoji, 'Reaction picker must share composer recency');
  find('[data-emoji-group="recent"] [data-emoji]').click();
  check(sent.at(-1).type === 'CHAT_REACTION_ADD', 'Reaction recent selection must send a reaction');
  check(recentEmojis.get().filter((emoji) => emoji === selectedEmoji).length === 1, 'Repeated selections must stay distinct');
  language.setLanguage('en');
  find('.chat-reaction-add').click();
  await frame();
  check(find('[data-goto-group="recent"]').getAttribute('aria-label') === 'Recent', 'Recent clock must be localized in English');
  check(find('[data-emoji-group="recent"] .emoji-picker-section-title').textContent === 'Recent', 'Recent category heading must be localized in English');
  key(document.activeElement, 'Escape');
  language.setLanguage('pt-BR');
  contextMenu.open(10, 10, [{ label: 'Test', onClick() {} }]);
  contextMenu.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check(!document.querySelector('.floating-context-menu'), 'Immediate menu teardown must stay closed');
  const [{ VoiceVideoTab }, { settingsStore: voiceSettings }, { voiceStore: voiceState }, pttIndicators] = await Promise.all([
    import('/views/settings/tabs/VoiceVideoTab.ts'), import('/stores/settingsStore.ts'),
    import('/stores/voiceStore.ts'), import('/views/PttIndicator.ts'),
  ]);
  const previousMode = voiceSettings.inputMode;
  const previousPttKey = voiceSettings.pttKey;
  const previousApi = window.api;
  const previousVoice = {
    currentVoiceChannelId: voiceState.currentVoiceChannelId,
    isMuted: voiceState.isMuted, isDeafened: voiceState.isDeafened,
    serverMuted: voiceState.serverMuted, serverDeafened: voiceState.serverDeafened,
  };
  const voicePanel = document.createElement('div');
  const voiceTab = new VoiceVideoTab();
  voiceSettings.inputMode = 'voice_activity';
  voiceState.currentVoiceChannelId = null;
  voiceState.isMuted = voiceState.isDeafened = voiceState.serverMuted = voiceState.serverDeafened = false;
  voicePanel.innerHTML = voiceTab.renderHtml();
  document.body.appendChild(voicePanel);
  voiceTab.attachEvents(voicePanel);
  const indicatorMirrors = document.createElement('div');
  indicatorMirrors.innerHTML = pttIndicators.renderPttIndicator() + pttIndicators.renderPttIndicator();
  document.body.appendChild(indicatorMirrors);
  const unbindMirrors = pttIndicators.bindPttIndicators(indicatorMirrors);
  try {
    const vadCard = voicePanel.querySelector('#mode-card-vad');
    const pttCard = voicePanel.querySelector('#mode-card-ptt');
    const indicators = [...document.querySelectorAll('[data-ptt-indicator]')];
    check(!voicePanel.querySelector('input[type="radio"]'), 'Input mode must use cards instead of native radios');
    check(vadCard.tagName === 'BUTTON' && pttCard.tagName === 'BUTTON', 'Input cards must have native keyboard activation');
    check([...voicePanel.querySelectorAll('input[type="checkbox"]')].every((input) => input.closest('.toggle-switch')), 'Boolean settings must retain styled switches, not bare checkboxes');
    check(indicators.every((indicator) => indicator.hidden), 'VAD mode must not show a PTT badge');
    pttCard.click();
    check(voiceSettings.inputMode === 'push_to_talk' && pttCard.getAttribute('aria-pressed') === 'true' && vadCard.getAttribute('aria-pressed') === 'false', 'Selecting the PTT card must persist one exclusive mode');
    check(voicePanel.querySelector('#container-vad-settings').style.display === 'none' && voicePanel.querySelector('#container-ptt-settings').style.display === 'block', 'Input cards must switch their settings panels');
    check(indicators.every((indicator) => !indicator.hidden && indicator.dataset.state === 'inactive'), 'PTT enabled outside a call must remain visible without claiming an open microphone');
    voiceState.currentVoiceChannelId = 'ptt-fixture';
    events.appEvents.emit('voice.channel_changed', 'ptt-fixture');
    voiceState.setMicrophoneState(false, false);
    check(indicators.every((indicator) => indicator.dataset.state === 'closed'), 'Idle PTT must show the microphone closed in every indicator');
    voiceState.setMicrophoneState(true, true);
    check(indicators.every((indicator) => indicator.dataset.state === 'open' && indicator.dataset.pressed === 'true'), 'Held PTT with an open microphone must update all indicators');
    check(indicators[0].querySelector('[data-ptt-label]').textContent.includes('Microfone aberto'), 'PTT state must be localized in Portuguese');
    check(indicators[0].querySelector('[data-ptt-key]').textContent === voiceSettings.pttKey.display, 'PTT indicator must show its configured shortcut');
    voiceState.setMicrophoneState(true, false);
    check(indicators.every((indicator) => indicator.dataset.state === 'open' && indicator.dataset.pressed === 'false'), 'Release delay must show the actual open microphone even after the shortcut is released');
    voiceState.setMicrophoneState(false, false);
    voiceState.serverMuted = true;
    events.appEvents.emit('voice.state_updated');
    check(indicators.every((indicator) => indicator.dataset.state === 'muted'), 'Server mute must never appear as an open PTT microphone');
    voiceState.serverMuted = false;
    language.setLanguage('en');
    events.appEvents.emit('voice.microphone_updated');
    check(indicators[0].querySelector('[data-ptt-label]').textContent.includes('Microphone closed'), 'PTT state must be localized in English');
    vadCard.click();
    check(voiceSettings.inputMode === 'voice_activity' && indicators.every((indicator) => indicator.hidden), 'Returning to VAD must hide every PTT indicator');
    let nativeCapture;
    let captureStarts = true;
    window.api = {
      ...previousApi,
      setPttConfig: async () => true,
      startPttCapture: async () => captureStarts,
      stopPttCapture: async () => true,
      onPttCaptured: (callback) => {
        nativeCapture = callback;
        return () => { nativeCapture = null; };
      },
    };
    const recordPtt = voicePanel.querySelector('#btn-record-ptt-key');
    recordPtt.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
    check(voiceSettings.pttKey === previousPttKey && nativeCapture, 'Focused DOM capture must not race ahead of the native worker and save a DOM code as a native PTT key');
    nativeCapture({ code: 'M', display: 'M', keyType: 'keyboard', keyCode: 50 });
    check(voiceSettings.pttKey.keyCode === 50 && voiceSettings.pttKey.code === 'M' && !nativeCapture, 'PTT recording must persist the native keycode and release its listener');
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyM', key: 'm', bubbles: true }));
    captureStarts = false;
    recordPtt.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    check(!nativeCapture && voicePanel.querySelector('#ptt-key-desc').textContent === language.t('keybinds.hookUnavailable'), 'Unavailable native capture must stop recording and display its failure');
    voiceTab.cleanup();
    unbindMirrors();
    pttCard.click();
    check(voiceSettings.inputMode === 'voice_activity', 'Unmounted input cards must release their listeners');
    voiceSettings.inputMode = 'push_to_talk';
    events.appEvents.emit('settings.updated');
    check(indicators.every((indicator) => indicator.hidden), 'Unmounted indicators must release global event listeners');
  } finally {
    voiceTab.cleanup();
    unbindMirrors();
    voicePanel.remove();
    indicatorMirrors.remove();
    Object.assign(voiceState, previousVoice);
    window.api = previousApi;
    voiceSettings.pttKey = previousPttKey;
    voiceSettings.inputMode = previousMode;
    voiceSettings.save();
    language.setLanguage('pt-BR');
  }
  store.setHistory('one', []);
  type(find('#chat-message-input'), '');
  sent.length = 0;
  const allowedChannel = { ...server.getChannel('one') };
  type(find('#chat-message-input'), '/');
  server.updateChannel({ ...allowedChannel, botCommandsEnabled: false });
  check(find('#command-dropup').textContent.includes('não são permitidos neste canal'), 'Channel switch must immediately replace an open slash menu with a localized notice');
  check(document.querySelectorAll('[data-cmd-index]').length === 0, 'Disabled channels must not expose selectable commands, even for admins');
  const deniedSent = sent.length;
  type(find('#chat-message-input'), '/ping');
  key(find('#chat-message-input'), 'Enter');
  check(sent.length === deniedSent && !store.getCommandDraft('one'), 'Disabled channel must prevent command execution');
  language.setLanguage('en');
  type(find('#chat-message-input'), '/');
  check(find('#command-dropup').textContent.includes('not allowed in this text channel'), 'Channel denial must be localized in English');
  server.updateChannel(allowedChannel);
  server.myPermissions = 1 << 8;
  events.appEvents.emit('server.roles_updated');
  check(find('#command-dropup').textContent.includes('do not have permission'), 'Role revocation must immediately refresh an open slash menu');
  check(!find('#chat-message-input').readOnly, 'Bot permission denial must not block ordinary chat');
  server.myPermissions = 2147483647;
  events.appEvents.emit('server.roles_updated');
  check(document.querySelectorAll('[data-cmd-index]').length > 0, 'Granting bot permission must restore commands');
  language.setLanguage('pt-BR');
  type(find('#chat-message-input'), '');
  const [{ CreateChannelModal }, { EditChannelModal }, { ServerRolesTab }] = await Promise.all([
    import('/views/CreateChannelModal.ts'), import('/views/EditChannelModal.ts'),
    import('/views/serverSettings/tabs/ServerRolesTab.ts'),
  ]);
  const createChannel = new CreateChannelModal();
  const editChannel = new EditChannelModal();
  const channelRequests = [];
  const originalSendRequest = client.sendRequest;
  client.sendRequest = async (messageType, payload) => { channelRequests.push({ type: messageType, payload }); return {}; };
  try {
    createChannel.open('TEXT');
    check(find('#input-channel-bot-commands').checked, 'New text channels must enable bots by default');
    check(!!find('#input-channel-bot-commands').closest('.toggle-switch'), 'Channel bot setting must use the established toggle switch');
    find('#input-channel-bot-commands').checked = false;
    find('input[name="channel-type"][value="VOICE"]').click();
    check(find('#channel-bot-commands-group').hidden, 'Voice channels must hide the text-only bot setting');
    find('input[name="channel-type"][value="TEXT"]').click();
    check(!find('#channel-bot-commands-group').hidden && !find('#input-channel-bot-commands').checked, 'Switching channel type must preserve the chosen bot setting');
    type(find('#input-channel-name'), 'channel-test');
    find('#form-create-channel').requestSubmit();
    await frame();
    check(channelRequests.at(-1)?.payload.botCommandsEnabled === false, 'Channel creation must send an explicit disabled switch');
    check(channelRequests.at(-1)?.payload.maxParticipants === undefined, 'Bot settings must not overwrite the channel participant default');
    server.updateChannel({ ...allowedChannel, botCommandsEnabled: false });
    editChannel.open('one');
    check(!find('#input-channel-bot-commands').checked, 'Channel edit must load the persisted bot switch');
    find('#form-edit-channel').requestSubmit();
    await frame();
    check(channelRequests.at(-1)?.type === 'CHANNEL_UPDATE' && channelRequests.at(-1)?.payload.botCommandsEnabled === false, 'Editing a disabled channel must preserve its bot setting');
    createChannel.open('VOICE');
    check(find('#channel-bot-commands-group').hidden, 'Voice creation must initially hide bot controls');
    type(find('#input-channel-name'), 'voice-test');
    find('#form-create-channel').requestSubmit();
    await frame();
    check(channelRequests.at(-1)?.payload.botCommandsEnabled === undefined, 'Voice creation must leave bot defaults untouched');
    const rolesMarkup = document.createElement('div');
    rolesMarkup.innerHTML = new ServerRolesTab().renderHtml();
    check(!!rolesMarkup.querySelector('.role-permission-switch[data-permission="8192"]'), 'Role editor must expose MANAGE_BOTS as a switch');
    check(!!rolesMarkup.querySelector('.role-permission-switch[data-permission="16384"]'), 'Role editor must expose USE_BOT_COMMANDS as a switch');
  } finally {
    createChannel.close();
    editChannel.close();
    client.sendRequest = originalSendRequest;
    server.updateChannel(allowedChannel);
  }
  const exactPing = { ...ping, botId: 'zeta', botName: 'Zeta Bot' };
  const botNameMatch = { ...ping, name: 'start', botId: 'ping-bot', botName: 'Ping Bot' };
  refreshRegistry([exactPing, botNameMatch]);
  for (const selectKey of ['Enter', 'Tab']) {
    type(find('#chat-message-input'), '/ping');
    key(find('#chat-message-input'), selectKey);
    check(store.getCommandDraft('one')?.command.botId === exactPing.botId,
      `${selectKey} must prefer a unique exact command over an unrelated bot-name match`);
    check(sent.at(-1)?.type === 'COMMAND_INVOKE' && sent.at(-1)?.payload.botId === exactPing.botId,
      `${selectKey} must immediately invoke the exact no-argument command`);
    store.setCommandPending('one', store.getCommandDraft('one'), false);
    find('[data-bot-action="cancel-command"]').click();
  }
  type(find('#chat-message-input'), '/ping');
  key(find('#chat-message-input'), 'ArrowDown');
  refreshRegistry([exactPing, botNameMatch]);
  check(find('.command-row.active strong').textContent === '/start', 'Refresh must preserve deliberate keyboard navigation');
  key(find('#chat-message-input'), 'Enter');
  check(store.getCommandDraft('one')?.command.name === 'start', 'Explicit navigation must still select another matching command');
  check(sent.at(-1)?.payload.commandName === 'start', 'Explicit selection must invoke the no-argument command');
  store.setCommandPending('one', store.getCommandDraft('one'), false);
  find('[data-bot-action="cancel-command"]').click();
  sent.length = 0;
  refreshRegistry([command, duplicate, ping]);
  type(find('#chat-message-input'), '/');
  const normalInputHeight = find('#chat-message-input').clientHeight;
  refreshRegistry([command, duplicate, ping, ...Array.from({ length: 20 }, (_, index) => ({
    ...command, name: `extra-${index}`,
  }))]);
  const catalogScroll = find('.command-picker-scroll');
  check(catalogScroll.scrollHeight > catalogScroll.clientHeight, 'Long catalogs must have an internal scroll range');
  check(catalogScroll.getBoundingClientRect().bottom <= find('.command-picker').getBoundingClientRect().bottom + 1,
    'Long command lists must remain inside their panel instead of covering the chat input');
  catalogScroll.scrollTop = catalogScroll.scrollHeight;
  await frame();
  check(catalogScroll.scrollTop > 0, 'The last commands must be reachable by scrolling');
  refreshRegistry([command, duplicate, ping]);
  check(document.querySelectorAll('[data-command-group]').length === 3, 'Expected frequent and two bot groups');
  check(find('#command-dropup').getBoundingClientRect().width > 900, 'Command dropup should span composer width');
  check(find('#command-dropup').getBoundingClientRect().top >= 0, 'Command dropup must stay inside the viewport');
  check(find('.command-empty-frequency').textContent.includes('executar'), 'Empty frequency must not fabricate usage');
  check(getComputedStyle(find('.command-row.active .command-row-arguments')).display !== 'none', 'Active row must reveal parameter chips');
  find('[data-command-section="bot:music-two"] [data-cmd-index]').click();
  check(store.getCommandDraft('one').command.botId === 'music-two', 'Duplicate command must target selected bot');
  check(sent.every((entry) => entry.type !== 'COMMAND_INVOKE'), 'Selecting must never invoke');
  check(find('#chat-command-composer').getBoundingClientRect().height < 180, 'Composer must be compact');
  check(find('#chat-command-composer').getBoundingClientRect().bottom <= innerHeight, 'Composer must remain inside the viewport');
  check(document.querySelectorAll('#chat-command-composer [data-field-name]').length === 2, 'Only required arguments start visible');
  const songInput = find('#chat-command-composer [data-field-name="song"] [data-bot-input]');
  const songField = songInput.closest('[data-field-name]');
  songInput.focus();
  check(songField.classList.contains('focused'), 'Only the actual focused parameter should have its focused state');
  const compactWidth = songInput.getBoundingClientRect().width;
  type(songInput, 'A'.repeat(200));
  check(songInput.getBoundingClientRect().width > compactWidth, 'Parameter inputs grow for longer values as well as placeholders');
  const argumentsRow = find('.bot-command-arguments');
  argumentsRow.style.maxWidth = '200px';
  await frame();
  const narrowBounds = argumentsRow.getBoundingClientRect();
  check([...argumentsRow.querySelectorAll('[data-field-name]')].every(field => field.getBoundingClientRect().right <= narrowBounds.right + 1),
    'Long parameters must wrap within a narrow composer instead of overflowing');
  argumentsRow.style.removeProperty('max-width');
  type(songInput, 'A song with spaces and, commas');
  songInput.setSelectionRange(songInput.value.length, songInput.value.length);
  key(songInput, 'ArrowRight');
  check(document.activeElement === find('#chat-command-composer [data-field-name="count"] [data-bot-input]'),
    'ArrowRight at the end of one parameter must focus the next visible parameter');
  check(find('#chat-command-composer button[type="submit"]').disabled,
    'Incomplete required parameters must keep the visual submit button disabled');
  key(document.activeElement, 'Enter');
  check(sent.every((entry) => entry.type !== 'COMMAND_INVOKE'), 'Invalid required inputs must not execute');
  const countInput = find('#chat-command-composer [data-field-name="count"] [data-bot-input]');
  const countField = countInput.closest('[data-field-name]');
  check(getComputedStyle(countInput).borderTopWidth === '0px' && getComputedStyle(countInput).paddingLeft === '2px',
    'Generic text input styles must not add a second border or oversized padding inside parameter chips');
  check(countField.classList.contains('invalid') && countInput.getAttribute('aria-invalid') === 'true',
    'Trying to execute an incomplete command must mark the invalid parameter wrapper');
  check(!find('[data-field-name="song"]').classList.contains('focused') && countField.classList.contains('focused'),
    'Moving between parameters must move the focus highlight');
  type(countInput, '11');
  check(countField.classList.contains('invalid') &&
    getComputedStyle(countField).borderTopColor === getComputedStyle(find('[data-command-form] > .bot-error')).color,
    'An out-of-range value must keep a red parameter border even while focused');
  type(countInput, '0');
  check(!countField.classList.contains('invalid') && !countInput.hasAttribute('aria-invalid'),
    'A valid zero clears the invalid border immediately');
  check(getComputedStyle(countField).borderTopColor === getComputedStyle(find('[data-bot-action="optional-parameters"]')).color,
    'A valid focused parameter has the accent border');
  check(!find('#chat-command-composer button[type="submit"]').disabled,
    'Completed required parameters must enable command execution visually');
  countInput.setSelectionRange(0, 0);
  key(countInput, 'ArrowRight');
  check(find('#bot-parameter-options').hidden, 'ArrowRight inside text must not open optional parameters early');
  countInput.setSelectionRange(countInput.value.length, countInput.value.length);
  countInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', isComposing: true, bubbles: true, cancelable: true }));
  check(find('#bot-parameter-options').hidden, 'IME ArrowRight must not open optional parameters');
  key(countInput, 'ArrowRight');
  check(!find('#bot-parameter-options').hidden, 'ArrowRight at the end of the last parameter must open optional parameters');
  key(find('[data-bot-action="optional-parameters"]'), 'Enter');
  const toggle = find('#chat-command-composer [data-field-name="private"] input');
  check(document.activeElement === toggle, 'Selecting an optional parameter must add its chip and focus its control');
  check(toggle.type === 'checkbox' && getComputedStyle(toggle).opacity === '0', 'Boolean must use hidden native control');
  check(find('#chat-command-composer .toggle-slider').getBoundingClientRect().width > 0, 'Custom switch must be visible');
  toggle.click();
  toggle.click();
  find('[data-remove-parameter="private"]').click();
  check(store.getCommandDraft('one').values.private === false, 'Removing an optional field must preserve false');
  check(!document.querySelector('#chat-command-composer [data-field-name="private"]'), 'Removed parameter must be hidden');
  find('[data-bot-action="optional-parameters"]').click();
  option('private').click();
  check(find('#chat-command-composer [data-field-name="private"] input').checked === false, 'Revealing must restore optional draft');
  find('[data-bot-action="optional-parameters"]').click();
  option('mode').click();
  check(!find('#bot-parameter-options').hidden, 'Focusing choices must open anchored list');
  const optionPanel = find('#bot-parameter-options').getBoundingClientRect();
  const commandComposer = find('#chat-command-composer').getBoundingClientRect();
  check(optionPanel.width >= commandComposer.width - 2, 'Parameter choices must span the full command composer width');
  check(optionPanel.bottom <= commandComposer.top + 1, 'Parameter choices must render above the command composer');
  const beforePreviewSent = sent.length;
  find('#bot-parameter-options [data-audio-preview-action="toggle"]').click();
  await waitFor(() => previewLoads.length >= 1);
  check(previewLoads.at(-1).url === 'https://audio.example.test/ordered.wav', 'Audio previews must load through the renderer IPC bridge');
  check(sent.length === beforePreviewSent && store.getCommandDraft('one').values.mode !== 'ordered',
    'Preview play must neither invoke a command nor select the option');
  const previewSlider = find('#bot-parameter-options [data-audio-preview-volume]');
  check(document.querySelectorAll('#bot-parameter-options [data-audio-preview-volume]').length === 1,
    'Static command choices must have one command-level volume slider');
  previewSlider.value = '33';
  previewSlider.dispatchEvent(new Event('input', { bubbles: true }));
  key(previewSlider, 'ArrowRight');
  check(sent.length === beforePreviewSent && !find('#bot-parameter-options').hidden,
    'Preview volume and slider keyboard handling must not submit or close choices');
  key(find('[data-bot-choice="mode"]'), 'ArrowDown');
  key(find('[data-bot-choice="mode"]'), 'Enter');
  check(store.getCommandDraft('one').values.mode === 'shuffle', 'Choice must keep declared value, not label');
  check(find('#bot-parameter-options').hidden, 'Choosing an option must close its list');
  const typing = find('#chat-command-composer [data-field-name="song"] [data-bot-input]');
  typing.focus();
  typing.setSelectionRange(4, 12, 'backward');
  const optionalNames = JSON.stringify(store.getCommandDraft('one').visibleOptionalNames);
  refreshRegistry([{ ...command, botName: 'Unrelated profile update' }, structuredClone(duplicate), ping]);
  check(document.activeElement === typing, 'Unrelated registry refresh must retain the focused argument control');
  check(typing.selectionStart === 4 && typing.selectionEnd === 12 && typing.selectionDirection === 'backward', 'Registry refresh must preserve caret and selection direction');
  refreshRegistry([command, { ...duplicate, botName: 'Selected profile update' }, ping]);
  const renamedInput = find('#chat-command-composer [data-field-name="song"] [data-bot-input]');
  check(document.activeElement === renamedInput && renamedInput.selectionStart === 4 && renamedInput.selectionEnd === 12 &&
    renamedInput.selectionDirection === 'backward', 'Selected bot profile refresh must restore focus and selection');
  const thirdMember = { ...otherCaller, id: 'charlie', clientId: 'charlie-client', nickname: 'Charlie' };
  server.addMember(thirdMember);
  server.addMember({ ...thirdMember, id: command.botId, clientId: 'bot-client', nickname: command.botName, isBot: true });
  const memberRefreshInput = find('#chat-command-composer [data-field-name="song"] [data-bot-input]');
  check(document.activeElement === memberRefreshInput && memberRefreshInput.selectionStart === 4 &&
    memberRefreshInput.selectionEnd === 12 && memberRefreshInput.selectionDirection === 'backward', 'Member refresh must retain active text input and caret');
  check(JSON.stringify(store.getCommandDraft('one').visibleOptionalNames) === optionalNames &&
    store.getCommandDraft('one').values.mode === 'shuffle', 'Refreshes must retain revealed optional parameters and values');
  refreshRegistry([command, duplicate, ping]);
  find('[data-bot-action="optional-parameters"]').click();
  option('member').click();
  check(!!option(caller.nickname), 'Bot member choices must include the caller');
  check(![...document.querySelectorAll('#bot-parameter-options [data-parameter-option] strong')].some((label) =>
    label.textContent === command.botName), 'Bot accounts must not be offered as user arguments');
  const browsedMember = option('Charlie');
  browsedMember.focus();
  browsedMember.dispatchEvent(new MouseEvent('mouseenter'));
  server.updateMember({ ...thirdMember, nickname: 'Aaron' });
  check(!find('#bot-parameter-options').hidden, 'Member refresh must retain an open member choice menu');
  check(document.activeElement === option('Aaron') && option('Aaron').getAttribute('aria-selected') === 'true',
    'Member choice focus must follow the stable user ID when names reorder');
  option('Bob').click();
  check(store.getCommandDraft('one').values.member === 'bob', 'Member choice must retain user ID');
  store.setCommandValues('one', { ...store.getCommandDraft('one').values, member: command.botId });
  find('#chat-command-composer button[type="submit"]').click();
  check(sent.every((entry) => entry.type !== 'COMMAND_INVOKE'), 'Bot user IDs must fail local validation even if inserted into the draft');
  find('[data-bot-choice="member"]').click();
  option(caller.nickname).click();
  find('#chat-command-composer button[type="submit"]').click();
  check(sent.some((entry) => entry.type === 'COMMAND_INVOKE' && entry.payload.options.member === caller.id), 'Self-targeting must pass command validation and send the caller ID');
  const selfDraft = store.getCommandDraft('one');
  store.setCommandPending('one', selfDraft, false);
  key(find('#chat-command-composer [data-field-name="song"] [data-bot-input]'), 'Escape');
  check(!store.getCommandDraft('one'), 'Escape must cancel selected command');
  check(getComputedStyle(find('.chat-input-wrapper')).display !== 'none', 'Normal composer must return after cancel');
  check(find('#chat-message-input').clientHeight >= normalInputHeight, 'Restored normal input must retain a usable line height');
  check(['#btn-attach', '#btn-code', '#btn-emoji'].every((selector) => !find(selector).disabled), 'Ordinary media/code controls must remain usable');
  type(find('#chat-message-input'), 'Ordinary draft stays here');
  view.setChannel('two');
  view.setChannel('one');
  check(find('#chat-message-input').value === 'Ordinary draft stays here', 'Channel switches must retain ordinary drafts');
  type(find('#chat-message-input'), '/ping');
  key(find('#chat-message-input'), 'Tab');
  check(sent.filter((entry) => entry.type === 'COMMAND_INVOKE').length === 2, 'No-argument Tab selection must execute immediately');
  find('#chat-command-composer button[type="submit"]').click();
  find('#chat-command-composer form').requestSubmit();
  check(sent.filter((entry) => entry.type === 'COMMAND_INVOKE').length === 2, 'Pending invocation must reject duplicate submit');
  const invocation = { invocationId: 'dom-invocation', channelId: 'one', botId: command.botId, commandName: 'ping' };
  store.acknowledgeCommand(invocation);
  store.clearCommand('one');
  store.receivePrompt({
    ...invocation, interactionId: 'form', botName: command.botName, botAvatarUrl: command.botAvatarUrl,
    expiresAt: Date.now() + 60_000,
    form: { title: 'Private follow-up', fields: [
      { name: 'question', label: 'Question', type: 'text', required: true },
      { name: 'options', label: 'Options', type: 'string-list', required: true, minItems: 2, maxItems: 5 },
    ] },
  });
  type(find('.bot-inline-form [data-field-name="question"] [data-bot-input]'), 'Preserve the private form');
  const list = [...document.querySelectorAll('.bot-inline-form [data-field-name="options"] [data-bot-input]')];
  type(list[0], 'First option');
  type(list[1], 'Second option');
  find('.bot-inline-form [data-field-action="add"]').click();
  type(find('.bot-inline-form [data-list-index="2"][data-bot-input]'), 'Third option');
  store.setHistory('one', []);
  view.setChannel('two');
  view.setChannel('one');
  check(find('.bot-inline-form [data-field-name="question"] [data-bot-input]').value === 'Preserve the private form', 'History/channel rebuilds must retain form answers');
  check(document.querySelectorAll('.bot-inline-form [data-field-name="options"] [data-bot-input]').length === 3, 'Dynamic rows must survive rebuilds');
  server.updateChannel({ ...allowedChannel, botCommandsEnabled: false });
  check(find('.bot-inline-form button[type="submit"]').disabled, 'Channel disable must immediately disable an existing form, even for admins');
  const beforeDeniedForm = sent.length;
  find('.bot-inline-form').requestSubmit();
  check(sent.length === beforeDeniedForm, 'A forged DOM submit must not bypass the channel switch');
  server.updateChannel(allowedChannel);
  server.myPermissions = 1 << 8;
  events.appEvents.emit('server.roles_updated');
  check(find('.bot-inline-form button[type="submit"]').disabled, 'Role revocation must disable an existing form');
  server.myPermissions = 2147483647;
  events.appEvents.emit('server.roles_updated');
  check(!find('.bot-inline-form button[type="submit"]').disabled, 'Restored access must restore form editing');
  find('.bot-inline-form button[type="submit"]').click();
  store.failFormSubmit(invocation.invocationId, 'form', 'Retry this form');
  check(find('.bot-inline-form .bot-error').textContent === 'Retry this form', 'Failed form must stay visible with its error');
  find('.bot-inline-form button[type="submit"]').click();
  store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId: 'form', values: { question: 'Preserve the private form' } });
  check(!document.querySelector('[data-interaction-id="form"]'), 'Acknowledged form must disappear');
  const selectorForm = (presentation) => ({
    title: 'Choose a next step',
    fields: [{ name: 'choice', label: 'Choose', type: 'select', required: true, presentation,
      choices: [{ label: 'First', value: 'first' }, { label: 'Second', value: 'second' }] }],
  });
  store.receivePrompt({
    ...invocation, interactionId: 'buttons', botName: command.botName, expiresAt: Date.now() + 60_000,
    form: selectorForm('buttons'),
  });
  const beforeButtons = sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length;
  find('[data-bot-select-value="second"]').click();
  check(sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length === beforeButtons + 1,
    'Choice button must submit immediately');
  check(sent.at(-1).payload.values.choice === 'second', 'Choice button must preserve its option value');
  store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId: 'buttons', values: { choice: 'second' } });
  store.receivePrompt({
    ...invocation, interactionId: 'dropdown', botName: command.botName, expiresAt: Date.now() + 60_000,
    form: selectorForm('dropdown'),
  });
  const beforeDropdown = sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length;
  type(find('[data-interaction-id="dropdown"] select'), 'first');
  check(sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length === beforeDropdown,
    'Dropdown must wait for confirmation');
  find('[data-interaction-id="dropdown"] button[type="submit"]').click();
  check(sent.filter((entry) => entry.type === 'COMMAND_SUBMIT').length === beforeDropdown + 1,
    'Dropdown confirmation must submit the selected value');
  store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId: 'dropdown', values: { choice: 'first' } });
  for (const presentation of ['buttons', 'dropdown']) {
    const interactionId = `audio-${presentation}`;
    const form = selectorForm(presentation);
    form.fields[0].choices[0].audio = { url: 'https://audio.example.test/private.wav', fileName: 'private.wav' };
    store.receivePrompt({
      ...invocation, interactionId, botName: command.botName, expiresAt: Date.now() + 60_000, form,
    });
    const card = find(`[data-interaction-id="${interactionId}"]`);
    check(card.querySelectorAll('[data-audio-preview-volume]').length === 1 && !!card.querySelector('[data-audio-preview-progress]'),
      'Private selectors reuse the shared volume and progress UI');
    const beforePreview = sent.filter(entry => entry.type === 'COMMAND_SUBMIT').length;
    card.querySelector('[data-audio-preview-action="toggle"]').click();
    await waitFor(() => previewLoads.some(entry => entry.url === 'https://audio.example.test/private.wav'));
    check(sent.filter(entry => entry.type === 'COMMAND_SUBMIT').length === beforePreview,
      'Private form previews cannot submit or select a value');
    card.querySelector('[data-bot-select-value="second"]').click();
    if (presentation === 'dropdown') {
      check(sent.filter(entry => entry.type === 'COMMAND_SUBMIT').length === beforePreview,
        'An audio dropdown must still require explicit form submission');
      card.querySelector('button[type="submit"]').click();
    }
    check(sent.filter(entry => entry.type === 'COMMAND_SUBMIT').length === beforePreview + 1 &&
      sent.at(-1).payload.values.choice === 'second', 'Private audio selectors must submit the declared opaque value once');
    store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId, values: { choice: 'second' } });
  }
  const audioField = name => ({
    name, label: name, type: 'select', required: true,
    choices: [{ label: 'Preview', value: 'preview', audio: { url: 'https://audio.example.test/private.wav' } }],
  });
  store.receivePrompt({
    ...invocation, interactionId: 'two-audio-fields', botName: command.botName, expiresAt: Date.now() + 60_000,
    form: { title: 'Multiple audio fields', fields: [audioField('first'), audioField('second')] },
  });
  const audioForm = find('[data-interaction-id="two-audio-fields"]');
  check(audioForm.querySelectorAll('[data-audio-choice-controls]').length === 2 &&
    audioForm.querySelectorAll('[data-audio-preview-volume]').length === 1, 'A multi-field form has one shared volume, not one per field');
  const formVolume = audioForm.querySelector('[data-audio-preview-volume]');
  formVolume.value = '19';
  formVolume.dispatchEvent(new Event('input', { bubbles: true }));
  audioForm.querySelector('[data-field-name="first"] [data-bot-select-value]').click();
  const updatedAudioForm = find('[data-interaction-id="two-audio-fields"]');
  check(updatedAudioForm.querySelector('[data-audio-preview-volume]').value === '19' &&
    updatedAudioForm.querySelectorAll('[data-audio-preview-volume]').length === 1,
    'Updating a private select field preserves the shared volume without duplicating its toolbar');
  updatedAudioForm.querySelector('[data-field-name="second"] [data-bot-select-value]').click();
  find('[data-interaction-id="two-audio-fields"] button[type="submit"]').click();
  check(sent.at(-1).payload.values.first === 'preview' && sent.at(-1).payload.values.second === 'preview',
    'Audio form controls leave field submission intact');
  store.acknowledgeForm({ invocationId: invocation.invocationId, interactionId: 'two-audio-fields', values: { first: 'preview', second: 'preview' } });
  check(!document.querySelector('.bot-inline-form'), 'All completed selectors must disappear');
  const background = chats.createChatStore();
  background.bus = proxies.silentBus;
  background.receivePrompt({
    ...invocation, invocationId: 'background', interactionId: 'secret', botName: 'Background bot', expiresAt: Date.now() + 60_000,
    form: { title: 'BACKGROUND ONLY', fields: [{ name: 'value', label: 'Value', type: 'text' }] },
  });
  check(!container.textContent.includes('BACKGROUND ONLY'), 'Background forms must not repaint foreground');
  store.finishInvocation({ ...invocation, reason: 'completed' });
  check([...document.querySelectorAll('.bot-inline-form [data-bot-input]')].every((input) => input.disabled), 'Finished forms must be disabled');
  store.addMessage(inputs.botCommandMessage({
    ...invocation, messageId: 'attributed', content: 'The command finished successfully.', createdAt: Date.now(),
    botName: command.botName, botAvatarUrl: command.botAvatarUrl, ephemeral: true,
    invokerId: otherCaller.id, invokerNickname: otherCaller.nickname, invokerAvatarUrl: null,
  }));
  check(find('.bot-response-context').textContent.includes('Bob usou /ping'), 'Response context must use authoritative caller');
  check(find('.bot-response-bubble .chat-author-name').textContent === command.botName, 'Bot identity must remain separate from caller');
  check(find('.bot-response-bubble .bot-private-cue').textContent.includes('você'), 'Private response must retain its badge');
  check(getComputedStyle(find('.bot-response-bubble')).borderLeftWidth === '3px', 'Bot response must have accented card');
  type(find('#chat-message-input'), '/');
  const usageBeforeOffline = JSON.stringify(store.getCommandUsage());
  refreshRegistry([duplicate]);
  check(!document.querySelector('[data-command-section="frequent"] .command-row'), 'Unavailable bot commands must be hidden from frequency');
  refreshRegistry([]);
  check(JSON.stringify(store.getCommandUsage()) === usageBeforeOffline, 'An empty registry snapshot must not erase frequency');
  refreshRegistry([command, duplicate, ping]);
  check(find('[data-command-section="frequent"] .command-row-title').textContent.includes('/ping'), 'ACKed usage must appear in frequent section');
  const persisted = localStorage.getItem(catalog.COMMAND_USAGE_STORAGE_KEY) ?? '';
  check(!persisted.includes('song with spaces') && !persisted.includes('Preserve the private form'), 'Frequency storage must never contain arguments');
  check(JSON.parse(persisted).every((entry) => entry.serverId === server.serverDetails.id && entry.callerId === caller.id), 'Frequency must use the authenticated local identity, not a response caller');
  await frame();
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(getComputedStyle(find('#command-dropup')).display !== 'none', 'Refocusing the composer must not leave a stale blur timer closing discovery');
  key(find('#chat-message-input'), 'ArrowDown');
  key(find('#chat-message-input'), 'ArrowDown');
  check(find('.command-row[aria-selected="true"] .command-row-arguments').textContent.includes('song'), 'Active command should reveal required parameter chips');
  await frame();
  window.commandDomCaptureComposer = async () => {
    key(find('#chat-message-input'), 'Escape');
    store.selectCommand('one', command, 'A song with multiple words');
    store.setCommandValues('one', { song: 'A song with multiple words', count: '0', private: false, mode: 'shuffle' });
    store.setCommandOptionVisible('one', 'private', true);
    store.setCommandOptionVisible('one', 'mode', true);
    await frame();
    check(find('.bot-response-bubble').getBoundingClientRect().bottom <= find('#chat-messages-feed').getBoundingClientRect().bottom, 'Selecting a command must keep the latest pinned reply in view');
    return { checks };
  };
  const { PublicSelectorView } = await import('/views/PublicSelectorView.ts');
  const selectorFeed = document.createElement('div');
  document.body.append(selectorFeed);
  const selectorRow = () => {
    selectorFeed.innerHTML = '<div data-message-id="public-question"><div class="chat-message-body"><div class="chat-message-text">Question</div></div></div>';
  };
  selectorRow();
  const selectorClient = networks.createNetworkClient();
  selectorClient.sessionKey = 'selector-dom';
  selectorClient.getStatus = () => 'CONNECTED';
  selectorClient.getCurrentServerUrl = () => 'wss://selector-fixture.example/';
  const { settingsStore: selectorPreferences } = await import('/stores/settingsStore.ts');
  const { botPreferenceScopeFor } = await import('/utils/botSettingsContext.ts');
  const previousSelectorPreferences = selectorPreferences.botUserPreferences;
  const previousSelectorConfirmations = selectorPreferences.botDownloadConfirmationExceptions;
  const previousSelectorStorage = localStorage.getItem('monky_settings');
  selectorPreferences.saveBotPreferences(botPreferenceScopeFor(selectorClient, server, 'music-one'), { compact: true }, false);
  let publicSnapshot = {
    id: 'public-selector', botId: 'music-one', channelId: 'one', messageId: 'public-question',
    title: 'Question <script>not HTML</script>', choices: [
      { label: 'A <img>', value: 'a' },
      { label: 'B', value: 'b', description: 'Durable audio option',
        audio: { url: 'https://audio.example.test/public.wav', fileName: 'public.wav', durationMs: 1800 } },
    ],
    presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 2,
    createdAt: 1, closedAt: null, resultMessageId: null, counts: { a: 0, b: 0 }, responseCount: 0, canRespond: true,
  };
  const publicRequests = [];
  selectorClient.sendRequest = async (messageType, payload) => {
    publicRequests.push({ type: messageType, payload });
    if (messageType === 'SELECTOR_LIST') return { selectors: [publicSnapshot] };
    publicSnapshot = { ...publicSnapshot, ownResponse: payload.value, counts: { a: payload.value === 'a' ? 1 : 0, b: payload.value === 'b' ? 1 : 0 }, responseCount: 1 };
    return publicSnapshot;
  };
  const publicView = new PublicSelectorView(selectorFeed, selectorClient, server, 'one');
  await frame();
  check(selectorFeed.querySelectorAll('[data-selector-value]').length === 2, 'Persisted public selectors must restore buttons from server list');
  check(!selectorFeed.querySelector('img,script'), 'Public selector labels and question must be text, never executable HTML');
  const beforePublicPreviewRequests = publicRequests.length;
  check(selectorFeed.querySelectorAll('[data-audio-preview-volume]').length === 1 &&
    !!selectorFeed.querySelector('[data-audio-preview-progress]'), 'Public selectors reuse a shared volume and per-preview progress');
  const publicVolume = selectorFeed.querySelector('[data-audio-preview-volume]');
  publicVolume.value = '52';
  publicVolume.dispatchEvent(new Event('input', { bubbles: true }));
  check(selectorFeed.querySelector('[data-audio-preview-percentage]').textContent === '52%' &&
    publicRequests.length === beforePublicPreviewRequests, 'Public volume updates the percentage without submitting a response');
  selectorFeed.querySelector('[data-audio-preview-action="toggle"]').click();
  await waitFor(() => previewLoads.some((entry) => entry.url === 'https://audio.example.test/public.wav'));
  check(publicRequests.length === beforePublicPreviewRequests, 'Public selector preview play must not submit a response');
  const existingPreviewControl = selectorFeed.querySelector('[data-audio-choice-controls]');
  selectorFeed.insertAdjacentHTML('beforeend', '<div data-message-id="unrelated">Another message</div>');
  await frame();
  check(existingPreviewControl.isConnected, 'Unrelated messages must not recreate or interrupt an unchanged public preview');
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', {
    ...publicSnapshot,
    choices: [{ label: 'Rejected', value: 'a', audio: { url: 'http://audio.example.test/unsafe.wav' } }],
  });
  check(existingPreviewControl.isConnected && !selectorFeed.textContent.includes('Rejected'),
    'An invalid audio snapshot must not bypass the shared contract by stripping and restoring metadata');
  selectorFeed.querySelector('[data-selector-value="b"]').click();
  await frame();
  check(publicRequests.filter((request) => request.type === 'SELECTOR_RESPOND').length === 1, 'Public option buttons must submit immediately');
  check(JSON.stringify(publicRequests.find((request) => request.type === 'SELECTOR_RESPOND').payload.userSettings) === JSON.stringify({ compact: true }),
    'Independent public selectors send only their owning bot/caller custom preferences, not host approval');
  check(sent.filter((request) => request.type === 'COMMAND_SUBMIT').every((request) => !('userSettings' in request.payload)),
    'Private continuations cannot replace the initial invocation preference snapshot');
  check(selectorFeed.querySelector('[data-selector-value="b"]').getAttribute('aria-selected') === 'true', 'Public response ACK must show the selected option');
  publicSnapshot = { ...publicSnapshot, presentation: 'dropdown' };
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', publicSnapshot);
  selectorFeed.querySelector('[data-selector-value="a"]').click();
  check(publicRequests.filter((request) => request.type === 'SELECTOR_RESPOND').length === 1, 'Public dropdown selection must wait for Confirm');
  selectorFeed.querySelector('[data-selector-confirm]').click();
  await frame();
  check(publicRequests.filter((request) => request.type === 'SELECTOR_RESPOND').length === 2, 'Confirm must submit a public dropdown once');
  selectorRow();
  await frame();
  check(!!selectorFeed.querySelector('[data-selector-value="a"]'), 'History rerenders must restore public audio selector controls');
  check(selectorFeed.querySelector('[data-audio-preview-volume]').value === '52', 'A restored persistent selector retains its own volume');
  server.updateChannel({ ...server.getChannel('one'), botCommandsEnabled: false });
  check(selectorFeed.querySelector('[data-selector-confirm]').disabled &&
    selectorFeed.querySelector('[data-selector-value="a"]').dataset.selectorDisabled === 'true',
    'Disabled channels must block public selector responses for admins too');
  server.updateChannel({ ...server.getChannel('one'), botCommandsEnabled: true });
  publicSnapshot = { ...publicSnapshot, closedAt: Date.now(), canRespond: false };
  language.setLanguage('pt-BR');
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', publicSnapshot);
  check(selectorFeed.querySelector('[data-selector-confirm]').disabled, 'Closed selectors must disable voting');
  check(selectorFeed.querySelector('.bot-status').textContent === 'Encerrado', 'Public selectors must use the Portuguese central catalog');
  language.setLanguage('en');
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', publicSnapshot);
  check(selectorFeed.querySelector('.bot-status').textContent === 'Closed', 'Public selectors must use the English central catalog');
  publicView.destroy();
  const requestsBeforeDestroy = publicRequests.length;
  events.appEvents.emit('message.SELECTOR_SNAPSHOT', { ...publicSnapshot, closedAt: null, canRespond: true });
  check(publicRequests.length === requestsBeforeDestroy, 'Destroyed public selector views must not send further requests');
  selectorClient.dispose();
  selectorFeed.remove();
  selectorPreferences.botUserPreferences = previousSelectorPreferences;
  selectorPreferences.botDownloadConfirmationExceptions = previousSelectorConfirmations;
  if (previousSelectorStorage === null) localStorage.removeItem('monky_settings');
  else localStorage.setItem('monky_settings', previousSelectorStorage);
  window.prepareToolbarPointerFixture = async () => {
    const { initTooltips } = await import('/core/TooltipService.ts');
    const offTooltips = initTooltips();
    const writeText = navigator.clipboard.writeText;
    navigator.clipboard.writeText = () => new Promise(resolve => { window.finishToolbarPointerCopy = resolve; });
    store.addMessage({ ...original, id: 'toolbar-pointer', channelId: 'two', content: 'Toolbar pointer fixture', createdAt: Date.now() });
    view.setChannel('two');
    const pointerRow = find('[data-message-id="toolbar-pointer"]');
    pointerRow.style.marginTop = '60px';
    pointerRow.scrollIntoView({ block: 'center' });
    window.closeToolbarPointerPicker = () => view.reactionPicker?.close();
    window.cleanupToolbarPointerFixture = () => {
      contextMenu.close();
      view.reactionPicker?.close();
      navigator.clipboard.writeText = writeText;
      offTooltips();
    };
    await frame();
  };
  window.commandDomCleanup = () => {
    view.destroy(); unbindBotEvents(); client.dispose();
    window.api = previousPreviewApi;
  };
  return { checks };
}
