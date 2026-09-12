const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const assert = require('node:assert/strict');
  const { test } = require('node:test');
  test('owned-server browsing preserves voice; Home and soundboard favorites remain independent', { timeout: 150_000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `navigation-favorites-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_NAVIGATION_FAVORITES_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => resolve(code));
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_NAVIGATION_FAVORITES_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, window, timer;
  let phase = 'startup';
  const finish = async code => {
    clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    await vite?.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timer = setTimeout(() => {
      console.error(`Navigation/favorites smoke timed out during ${phase}`);
      void finish(1);
    }, 120_000);
    const { createServer } = await import('vite');
    const mainPath = path.join(clientRoot, 'src', 'renderer', 'main.ts');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'navigation-favorites-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/navigation-favorites-shared.js') return '\0navigation-favorites-shared';
        },
        load(id) {
          if (id === '\0navigation-favorites-shared') return "export { MessageType } from '@monky/shared';";
        },
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) {
            // Exercise the real global session/voice handlers without running
            // identity loading, updates, native capture or the app bootstrap.
            return { code: `${code}\nexport { App as NavigationTestApp };`, map: null };
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__navigation_favorites__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
    window = new BrowserWindow({
      show: false, width: 1050, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) console.error(`[renderer:${phase}] ${message}`);
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/__navigation_favorites__`);
    phase = 'motion preference';
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const motionPreference = value => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }],
    });
    await motionPreference('no-preference');
    phase = 'fixture';
    await window.webContents.executeJavaScript(`(${setupNavigationFavoritesSmoke.toString()})()`, true);
    phase = 'favorite keyboard controls';
    for (const mode of ['grid', 'list', 'settings', 'home']) {
      await window.webContents.executeJavaScript(`window.navigationFavoritesSmoke.focusFavorite(${JSON.stringify(mode)})`, true);
      for (const [keyCode, pressed] of [['Return', true], ['Space', false]]) {
        window.focus();
        window.webContents.focus();
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await window.webContents.executeJavaScript(`window.navigationFavoritesSmoke.checkFavoriteKeyboard(${pressed})`, true);
      }
    }
    phase = 'favorite filters and lifecycle';
    await window.webContents.executeJavaScript('window.navigationFavoritesSmoke.favorites()', true);
    phase = 'favorite-first alphabetical ordering';
    await window.webContents.executeJavaScript('window.navigationFavoritesSmoke.favoritesOrdering()', true);
    for (const mode of ['grid', 'list', 'settings', 'home']) {
      phase = `${mode} favorite motion`;
      await motionPreference('no-preference');
      await window.webContents.executeJavaScript(`window.navigationFavoritesSmoke.favoriteMotion(${JSON.stringify(mode)})`, true);
      phase = `${mode} reduced motion`;
      await motionPreference('reduce');
      await window.webContents.executeJavaScript('window.navigationFavoritesSmoke.favoriteMotionReduced()', true);
    }
    await motionPreference('no-preference');
    phase = 'voice-preserving navigation';
    await window.webContents.executeJavaScript('window.navigationFavoritesSmoke.navigation()', true);
    phase = 'noise quick toggle';
    await window.webContents.executeJavaScript('window.navigationFavoritesSmoke.noiseToggle()', true);
    phase = 'cleanup';
    const checks = await window.webContents.executeJavaScript('window.navigationFavoritesSmoke.cleanup()', true);
    console.log(`Navigation/favorites smoke: ${checks} checks passed (P2P/SFU, local/remote, failures, races, keyboard, persistence, filters, motion, cleanup, noise toggle)`);
    await finish(0);
  }).catch(async error => {
    console.error(`Navigation/favorites smoke failed during ${phase}`, error);
    await finish(1);
  });
}

async function setupNavigationFavoritesSmoke() {
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      await tick();
    }
    throw new Error(message);
  };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const identity = { clientId: 'fixture-client', publicKey: 'fixture-public-key' };
  let hosted = { isRunning: false, port: null, serverId: null };
  let startFailure = false;
  let startGate = null;
  let nextFolder = null;
  let shortcutCallback = () => {};
  let registerShortcuts = 0;
  const hostStarts = [];
  const hostStops = [];
  const hostListeners = new Set();
  const plays = [];
  const mediaCalls = [];
  const connects = [];
  const sends = [];
  const disconnects = [];
  const connectGates = new Map();
  const sound = (folder, name) => ({
    name, fileName: `${name}.mp3`, filePath: `${folder}\\${name}.mp3`, ext: '.mp3', sizeBytes: 1024,
  });
  const firstFolder = 'C:\\Sounds\\One';
  const secondFolder = 'C:\\Sounds\\Two';
  const folderSounds = new Map([
    [firstFolder, [sound(firstFolder, 'Bell'), sound(firstFolder, 'Béll Two'), sound(firstFolder, 'Zap')]],
    [secondFolder, [sound(secondFolder, 'Bell')]],
  ]);
  window.api = {
    getIdentity: async () => identity,
    hostServerStatus: async () => ({ ...hosted }),
    hostServerStart: async options => {
      hostStarts.push(options);
      if (startGate) await startGate.promise;
      if (startFailure) return { success: false, error: 'Fixture port unavailable' };
      hosted = { isRunning: true, port: options.port, serverId: options.serverId };
      for (const listener of hostListeners) listener({ ...hosted });
      return { success: true };
    },
    hostServerStop: async () => { hostStops.push(hosted); return { success: true }; },
    onHostServerStatusChanged: listener => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
    hostServerStats: async () => ({ onlineUsers: 2 }),
    selectSoundboardFolder: async () => nextFolder,
    listSoundboardSounds: async folder => folderSounds.get(folder) ?? [],
    registerSoundboardShortcuts: async () => { registerShortcuts++; return true; },
    onSoundboardShortcutTriggered: callback => { shortcutCallback = callback; return () => {}; },
    setShortcutCapture: async () => true,
    onAppBeforeQuit: () => () => {},
    writeClientLog: async () => {},
    maximize: async () => {},
    stopLanDiscovery: async () => {},
    setWindowInServer: async () => {},
    fitHomeWindowToContent: async () => {},
    setLanguage: async () => {},
  };
  const originalFetch = window.fetch;
  const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices;
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
  window.fetch = async () => new Response('{}', { status: 503 });
  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => {
    throw new Error('Navigation/favorites smoke must not capture real user media');
  };
  const [{ NavigationTestApp }, { SoundboardModal }, { soundboardService: soundboard }, favoriteModule,
    { connectionStore: connection }, { settingsStore: settings }, { voiceStore: voice },
    { audioProcessor: audio }, { webRtcManager: rtc }, { videoService: video },
    { screenAudioService: screenAudio }, { sessionManager: sessions, sessionKeyFor },
    navigation, hosting, { serverRailView: rail }, { NetworkClient },
    { appEvents: bus }, { t, setLanguage }, shared] = await Promise.all([
    import('/main.ts'), import('/views/SoundboardModal.ts'), import('/core/SoundboardService.ts'),
    import('/stores/favoritesStore.ts'), import('/stores/connectionStore.ts'), import('/stores/settingsStore.ts'),
    import('/stores/voiceStore.ts'), import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    import('/core/VideoService.ts'), import('/core/ScreenAudioService.ts'), import('/core/SessionManager.ts'),
    import('/core/serverConnection.ts'), import('/core/hostedServerStart.ts'), import('/views/ServerRailView.ts'),
    import('/core/NetworkClient.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
    import('/navigation-favorites-shared.js'),
  ]);
  const { MessageType } = shared;
  const { SoundboardTab } = await import('/views/settings/tabs/SoundboardTab.ts');
  const { noiseSuppressionToggleTitle } = await import('/views/settings/NoiseSuppressionControl.ts');
  const { favoritesStore: favorites, FavoritesStore, soundFavoriteKey, savedServerFavoriteKey } = favoriteModule;
  settings.onboardingCompleted = true;
  settings.soundboardFolderPath = firstFolder;
  settings.soundboardShortcuts = { Bell: { accelerator: 'Q', display: 'Q' } };
  connection.savedNickname = 'Fixture';
  connection.setIdentity(identity);
  NavigationTestApp.prototype.init = async () => {};
  const app = new NavigationTestApp();
  const home = app.connectionView;
  const root = document.getElementById('app');
  const renderMain = app.mainView.render;
  app.mainView.render = () => {
    renderMain.call(app.mainView);
    root.dataset.server = sessions.getActiveKey() ?? '';
  };
  app.mainView.rejoinVoiceChannel = async () => { mediaCalls.push('view.rejoinVoiceChannel'); };
  app.setupGlobalEventListeners();
  const restores = [];
  const replace = (target, method, implementation) => {
    const original = target[method];
    restores.push(() => { target[method] = original; });
    target[method] = implementation;
  };
  for (const [target, prefix, methods] of [
    [audio, 'audio', ['stopMicrophone', 'setMuted', 'setDeafened']],
    [rtc, 'rtc', ['closeAllPeers', 'setCurrentSessionId', 'setIceServers', 'setDeafened',
      'suspendForVoiceReconnect', 'resumeAfterVoiceReconnect', 'clearLocalScreenTracks']],
    [video, 'video', ['stopCamera', 'stopScreenShare']],
  ]) {
    for (const method of methods) replace(target, method, () => { mediaCalls.push(`${prefix}.${method}`); });
  }
  replace(screenAudio, 'stop', async () => { mediaCalls.push('screenAudio.stop'); });
  replace(audio, 'startMicrophone', async () => {
    mediaCalls.push('audio.startMicrophone');
    const track = { id: 'fixture-mic', kind: 'audio', readyState: 'live', stop() {} };
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  });
  replace(rtc, 'setLocalAudioTrack', async () => { mediaCalls.push('rtc.setLocalAudioTrack'); });
  replace(rtc, 'initSfuForCurrentChannel', async () => { mediaCalls.push('rtc.initSfuForCurrentChannel'); });
  let voiceMode = 'p2p';
  replace(rtc, 'isSfuMode', () => voiceMode === 'sfu');
  replace(soundboard, 'playSound', async filePath => { plays.push(filePath); return true; });
  const userFor = port => ({
    id: `user-${port}`, sessionId: `session-${port}`, clientId: identity.clientId,
    nickname: 'Fixture', status: 'ONLINE', joinedAt: 1,
  });
  const payloadFor = (port, name = 'Fixture server') => {
    const currentUser = userFor(port);
    return {
      currentUser, voiceRestrictions: { serverMuted: false, serverDeafened: false },
      server: {
        id: `server-${port}`, name, createdAt: 1, maxUsers: 0, voiceMode,
        channels: [{ id: 'voice-room', name: 'Voice', type: 'VOICE', position: 0 }],
        members: [currentUser], knownMembers: [currentUser], voiceStates: {},
        roles: [], userRoles: [], ownerId: currentUser.id, myPermissions: 2147483647,
      },
    };
  };
  replace(NetworkClient.prototype, 'connect', async function (host, port) {
    connects.push(this.sessionKey);
    this.status = 'CONNECTING';
    const gate = connectGates.get(this.sessionKey);
    try {
      if (gate) await gate.promise;
      const payload = payloadFor(port);
      this.status = 'CONNECTED';
      this.emitScoped('network.connected', payload);
      return payload;
    } catch (error) {
      this.status = 'DISCONNECTED';
      throw error;
    }
  });
  const originalDisconnect = NetworkClient.prototype.disconnect;
  replace(NetworkClient.prototype, 'disconnect', function () {
    disconnects.push(this.sessionKey);
    originalDisconnect.call(this);
  });
  replace(NetworkClient.prototype, 'send', function (type, payload) {
    sends.push({ key: this.sessionKey, type, payload });
  });
  replace(NetworkClient.prototype, 'sendRequest', async function (type, payload) {
    sends.push({ key: this.sessionKey, type, payload });
    if (type === MessageType.VOICE_JOIN) {
      const user = sessions.get(this.sessionKey).serverStore.currentUser;
      return {
        userId: user.id, sessionId: user.sessionId, channelId: payload.channelId,
        voiceState: {
          userId: user.id, sessionId: user.sessionId, channelId: payload.channelId,
          isMuted: payload.isMuted, isDeafened: payload.isDeafened, serverMuted: false, serverDeafened: false,
          isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
        },
        participants: [],
      };
    }
    return {};
  });
  const seed = (host, port) => {
    const session = sessions.create(host, port, 'Fixture');
    const payload = payloadFor(port);
    session.client.status = 'CONNECTED';
    session.serverStore.setServerDetails(payload.server, payload.currentUser);
    return session;
  };
  const owned = {
    id: 'owned-fixture', name: 'Owned server', port: 4200, voiceChannel: 'Voice', textChannel: 'text',
    createdAt: 1, lastStarted: 1, voiceMode: 'sfu',
  };
  const target = { host: '127.0.0.1', port: owned.port, name: owned.name, lastConnected: 1 };
  const savedOne = { host: 'first.test', port: 3000, name: 'First', lastConnected: 20 };
  const savedTwo = { host: 'second.test', port: 3000, name: 'Second', lastConnected: 10 };
  const resetSaved = () => {
    connection.savedServers = [];
    connection.createdServers = [owned];
    connection.addSavedServer(savedOne);
    connection.addSavedServer(savedTwo);
  };
  const modal = new SoundboardModal();
  const settingsTab = new SoundboardTab();
  let settingsRoot = null;
  const renderSettings = () => {
    settingsRoot?.remove();
    settingsRoot = document.createElement('div');
    settingsRoot.id = 'sb-settings-fixture';
    settingsRoot.innerHTML = settingsTab.renderHtml();
    document.body.appendChild(settingsRoot);
    settingsTab.attachEvents(settingsRoot);
  };
  let keyboardMode = 'grid';
  let keyboardFavoriteKey = '';
  let keyboardOriginalIndex = -1;
  let motionCase = null;
  const keyboardStars = () => [...document.querySelectorAll(keyboardMode === 'home'
    ? '#home-saved-servers .favorite-toggle'
    : keyboardMode === 'settings' ? '#sb-settings-fixture .favorite-toggle' : '#sb-sounds-container .favorite-toggle')];
  const getStar = () => keyboardStars().find(button => button.dataset.favoriteKey === keyboardFavoriteKey);
  const soundNames = () => [...document.querySelectorAll('#sb-sounds-container .sb-sound-btn')]
    .map(button => button.dataset.soundname);
  const click = selector => {
    const element = document.querySelector(selector);
    check(!!element, `Missing ${selector}`);
    element.click();
  };
  const clearMetrics = () => {
    plays.length = mediaCalls.length = connects.length = sends.length = disconnects.length = 0;
    hostStarts.length = hostStops.length = 0;
  };
  const snapshotVoice = () => JSON.stringify(voice);
  const preserveVoice = (before, call, message) => {
    equal(snapshotVoice(), before, `${message}: voice store`);
    equal(mediaCalls, [], `${message}: physical media`);
    check(!disconnects.includes(call.key), `${message}: voice socket stays connected`);
    check(!sends.some(item => item.key === call.key && String(item.type).startsWith('VOICE_')),
      `${message}: no voice messages on the old call`);
    equal(hostStops, [], `${message}: no hosted shutdown`);
    check(navigation.callClient() === call.client, `${message}: callClient still owns the old call`);
  };
  const prepareCall = (host = 'remote.test', mode = 'p2p') => {
    voice.voiceSessionKey = null;
    voice.currentVoiceChannelId = null;
    for (const session of sessions.getAll()) session.client.status = 'DISCONNECTED';
    sessions.removeAll();
    hosted = { isRunning: false, port: null, serverId: null };
    startFailure = false;
    startGate = null;
    connectGates.clear();
    voiceMode = mode;
    const call = seed(host, 4100);
    const visible = seed('browsed.test', 4101);
    sessions.activate(visible.key);
    voice.voiceSessionKey = call.key;
    voice.currentVoiceChannelId = 'voice-room';
    voice.isMuted = true;
    voice.isDeafened = false;
    voice.serverMuted = true;
    voice.serverDeafened = false;
    voice.isCameraOn = true;
    voice.isScreenSharing = true;
    connection.createdServers = [owned];
    connection.addSavedServer(target);
    app.mainView.render();
    clearMetrics();
    return { call, visible, before: snapshotVoice() };
  };
  const settleDialog = async (confirm = true) => {
    await until(() => document.querySelector('.dialog-card'), 'Expected a navigation dialog');
    click(`.dialog-card [data-action="${confirm ? 'confirm' : 'cancel'}"]`);
  };

  window.navigationFavoritesSmoke = {
    async focusFavorite(mode) {
      modal.close();
      settingsRoot?.remove();
      keyboardMode = mode;
      if (mode === 'home') {
        resetSaved();
        for (const server of [savedOne, savedTwo]) {
          if (favorites.isServerFavorite(server)) favorites.toggleServer(server);
        }
        keyboardFavoriteKey = savedServerFavoriteKey(savedTwo);
        home.render();
      } else {
        settings.soundboardViewMode = mode === 'settings' ? 'list' : mode;
        settings.soundboardFolderPath = firstFolder;
        for (const sound of folderSounds.get(firstFolder)) {
          if (favorites.isSoundFavorite(sound.filePath)) favorites.toggleSound(sound.filePath);
        }
        keyboardFavoriteKey = soundFavoriteKey(sound(firstFolder, 'Zap').filePath);
        if (mode === 'settings') {
          await soundboard.loadSounds();
          renderSettings();
        } else {
          await modal.open();
        }
      }
      clearMetrics();
      keyboardOriginalIndex = keyboardStars().indexOf(getStar());
      getStar().focus();
    },
    async checkFavoriteKeyboard(pressed) {
      await tick();
      const button = getStar();
      equal(button.getAttribute('aria-pressed'), String(pressed), `${keyboardMode}: native Enter/Space toggles star`);
      check(!!button.getAttribute('aria-label') && button.title === button.getAttribute('aria-label'),
        `${keyboardMode}: accessible title and name`);
      equal(plays, [], `${keyboardMode}: keyboard favorite does not play sound`);
      equal(connects, [], `${keyboardMode}: keyboard favorite does not connect`);
      if (keyboardMode === 'home') equal(home.selectedSavedHost, null, 'Home star does not select a saved server');
      check(document.activeElement === button, `${keyboardMode}: focus survives toggle`);
      equal(keyboardStars().indexOf(button), pressed ? 0 : keyboardOriginalIndex,
        `${keyboardMode}: native keyboard favoriting moves the item immediately and unfavoriting restores alphabetical position`);
    },
    async favorites() {
      modal.close();
      settings.soundboardViewMode = 'grid';
      settings.soundboardFolderPath = firstFolder;
      const originalShortcuts = JSON.stringify(settings.soundboardShortcuts);
      const subscribers = favorites.listeners.size;
      await modal.open();
      const registered = registerShortcuts;
      equal(soundNames(), ['Bell', 'Béll Two', 'Zap'], 'All alphabetizes the nonfavorite group');
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'monky_favorites') throw new DOMException('Fixture storage full', 'QuotaExceededError');
        return write.call(this, key, value);
      };
      try {
        click('#sb-sounds-container .favorite-toggle');
        await until(() => document.querySelector('.dialog-card'), 'Favorite persistence error');
        equal(document.querySelector('#sb-sounds-container .favorite-toggle').getAttribute('aria-pressed'), 'false',
          'A failed favorite write does not falsely display a saved star');
        equal(document.querySelector('.dialog-message').textContent, t('favorites.saveFailed'),
          'Storage errors show localized, actionable guidance');
        await settleDialog();
      } finally {
        Storage.prototype.setItem = write;
      }
      click('#sb-sounds-container .favorite-toggle');
      click('#sb-filter-favorites');
      equal(soundNames(), ['Bell'], 'Favorites filters the sound grid');
      const input = document.getElementById('sb-search-input');
      input.value = 'béll';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      equal(soundNames(), ['Bell'], 'Search and favorites combine with accent-insensitive matching');
      input.value = 'missing';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      equal(soundNames(), [], 'Favorite search supports zero results');
      click('#sb-btn-clear-search');
      equal(soundNames(), ['Bell'], 'Clearing search retains the favorites filter');
      click('#sb-btn-view-list');
      equal(soundNames(), ['Bell'], 'View changes preserve favorites');
      equal(document.getElementById('sb-btn-view-list').getAttribute('aria-pressed'), 'true', 'List mode is announced');
      const favorite = document.querySelector('#sb-sounds-container .favorite-toggle');
      favorite.focus();
      favorite.click();
      check(!!document.getElementById('sb-show-all'), 'Removing the last favorite shows a useful empty state');
      check(document.activeElement.id === 'sb-filter-favorites', 'Removing the last favorite keeps keyboard focus');
      click('#sb-show-all');
      equal(soundNames(), ['Bell', 'Béll Two', 'Zap'], 'All restores alphabetical order after empty favorites');
      equal(JSON.stringify(settings.soundboardShortcuts), originalShortcuts, 'Favorite actions preserve shortcut bindings');
      equal(registerShortcuts, registered, 'Favorite actions do not re-register shortcuts');
      equal(plays, [], 'Filters, view changes and stars never play a sound');
      click('#sb-sounds-container .favorite-toggle');
      click('#sb-filter-favorites');
      shortcutCallback('Zap');
      equal(plays.at(-1), sound(firstFolder, 'Zap').filePath, 'Filtered-out sounds still work through their global shortcut');
      const persistedFolder = localStorage.getItem('monky_settings');
      const loadedSounds = JSON.stringify(soundboard.getSounds());
      const folderWrite = Storage.prototype.setItem;
      nextFolder = secondFolder;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'monky_settings') throw new DOMException('Fixture folder storage full', 'QuotaExceededError');
        return folderWrite.call(this, key, value);
      };
      try {
        click('#sb-btn-change-folder');
        await until(() => document.querySelector('.dialog-message'), 'Folder persistence error');
        equal(document.querySelector('.dialog-message').textContent, t('soundboard.chooseFolderFailed'),
          'Folder persistence failures show the localized folder error');
        equal(settings.soundboardFolderPath, firstFolder, 'Failed persistence restores the previously configured download folder');
        equal(JSON.stringify(soundboard.getSounds()), loadedSounds, 'Failed folder selection preserves the loaded sound library');
        equal(localStorage.getItem('monky_settings'), persistedFolder, 'Failed folder selection preserves the saved configuration');
        await settleDialog();
        await until(() => !document.getElementById('sb-btn-change-folder').disabled, 'Folder picker recovers after persistence failure');
      } finally {
        Storage.prototype.setItem = folderWrite;
      }
      nextFolder = secondFolder;
      click('#sb-btn-change-folder');
      await until(() => document.getElementById('sb-folder-path-label')?.textContent === secondFolder, 'Folder switch');
      equal(soundNames(), [], 'The same filename in another folder is not automatically a favorite');
      check(!!document.getElementById('sb-show-all'), 'A different folder gets an empty favorites state');
      nextFolder = firstFolder;
      click('#sb-btn-change-folder');
      await until(() => soundNames().length === 1, 'Restore original folder');
      equal(soundNames(), ['Bell'], 'Returning to the original folder restores its favorite');
      equal(document.getElementById('sb-sound-count').textContent, '1 / 3', 'Counts honor the active filter after folder changes');
      check(new FavoritesStore().isSoundFavorite(sound(firstFolder, 'Bell').filePath), 'Sound star persists across store restarts');
      for (const language of ['en', 'pt-BR']) {
        setLanguage(language);
        modal.close();
        await modal.open();
        equal(document.getElementById('sb-filter-all').textContent, t('favorites.all'), 'Filter uses the active locale');
        equal(document.querySelector('#sb-sounds-container .favorite-toggle').title,
          t('favorites.remove', { name: 'Bell' }), 'Star title uses the active locale');
      }
      modal.close();
      equal(favorites.listeners.size, subscribers, 'Closing removes the favorite subscription');
      const load = deferred();
      const originalLoad = soundboard.loadSounds;
      soundboard.loadSounds = () => load.promise;
      const opening = modal.open();
      modal.close();
      load.resolve([]);
      await opening;
      soundboard.loadSounds = originalLoad;
      check(!document.getElementById('sb-search-input'), 'A late load cannot reopen a closed modal');

      const originalSounds = folderSounds.get(firstFolder);
      folderSounds.set(firstFolder, [...originalSounds, sound(firstFolder, 'Drum')]);
      settings.soundboardFolderPath = firstFolder;
      await soundboard.loadSounds();
      renderSettings();
      const settingsNames = () => [...settingsRoot.querySelectorAll('.sb-shortcut-row')].map(row => row.dataset.soundname);
      equal(settingsNames(), ['Bell', 'Béll Two', 'Drum', 'Zap'], 'The settings sound list alphabetizes each group');
      click('#sb-settings-filter-favorites');
      equal(settingsNames(), ['Bell'], 'The settings list shares modal favorites');
      let settingsSearch = document.getElementById('sb-shortcuts-search-input');
      settingsSearch.value = 'zap';
      settingsSearch.dispatchEvent(new Event('input', { bubbles: true }));
      equal(settingsNames(), [], 'Settings search combines with the favorite filter');
      settingsSearch = document.getElementById('sb-shortcuts-search-input');
      settingsSearch.value = '';
      settingsSearch.dispatchEvent(new Event('input', { bubbles: true }));
      equal(settingsNames(), ['Bell'], 'Clearing settings search keeps the favorites filter');
      const settingsStar = settingsRoot.querySelector('.favorite-toggle');
      settingsStar.focus();
      settingsStar.click();
      check(!!document.getElementById('sb-settings-show-all'), 'The settings list has an actionable empty-favorites state');
      equal(document.activeElement.id, 'sb-settings-filter-favorites', 'Settings favorite removal retains keyboard focus');
      click('#sb-settings-show-all');
      equal(settingsNames(), ['Bell', 'Béll Two', 'Drum', 'Zap'], 'Settings All restores alphabetical order');
      click('#sb-settings-fixture .favorite-toggle');
      equal(JSON.stringify(settings.soundboardShortcuts), originalShortcuts, 'Settings favorites preserve shortcut configuration');
      check(new FavoritesStore().isSoundFavorite(sound(firstFolder, 'Bell').filePath), 'Settings stars share persistent sound identities');
      click('#sb-settings-filter-favorites');
      nextFolder = secondFolder;
      click('#btn-select-soundboard-folder');
      await until(() => document.getElementById('input-soundboard-path')?.value === secondFolder, 'Settings folder change');
      equal(settingsNames(), [], 'Settings folder changes do not favorite same-name files');
      settingsRoot.remove();
      folderSounds.set(firstFolder, originalSounds);
      settings.soundboardFolderPath = firstFolder;
      await soundboard.loadSounds();

      resetSaved();
      home.render();
      const hostInput = document.getElementById('join-host');
      hostInput.value = 'typed-but-not-selected.test';
      click('#home-saved-servers .favorite-toggle');
      equal(hostInput.value, 'typed-but-not-selected.test', 'Home star preserves unsubmitted form fields');
      equal(home.selectedSavedHost, null, 'Home star does not select or navigate');
      click('#home-saved-filter-favorites');
      const visibleRows = () => [...document.querySelectorAll('#home-saved-servers .saved-server-item')]
        .filter(row => row.style.display !== 'none').map(row => row.dataset.host);
      equal(visibleRows(), ['first.test'], 'Home filters only saved servers');
      check(!document.querySelector('[data-created-server-id] .favorite-toggle'), 'Created-server controls do not get stars');
      click('#home-saved-servers .btn-edit-saved-srv');
      document.getElementById('edit-srv-host').value = 'edited.test';
      document.getElementById('edit-srv-port').value = '4000';
      click('.modal-backdrop [data-action="save"]');
      check(favorites.isServerFavorite({ host: 'edited.test', port: 4000 }), 'Home edits transfer the favorite to the new address');
      equal(visibleRows(), ['edited.test'], 'An edited favorite remains visible');
      click('#home-saved-servers .btn-delete-saved-srv');
      check(!favorites.isServerFavorite({ host: 'edited.test', port: 4000 }), 'Deleting a server removes its favorite');
      check(document.getElementById('home-favorites-empty').style.display !== 'none', 'Home has an empty favorites state');
      click('#home-favorites-show-all');
      equal(visibleRows(), ['second.test'], 'All restores the remaining saved list');
      root.innerHTML = '<div id="server-rail"></div>';
      rail.render();
      check(!document.querySelector('#server-rail .favorite-toggle, #server-rail [data-favorites-filter]'),
        'The server rail has neither stars nor a favorites filter');
    },
    async favoritesOrdering() {
      const orderingFolder = 'C:\\Sounds\\Ordering';
      const alpha = sound(orderingFolder, 'Tone Alpha');
      const beta = sound(orderingFolder, 'Beta');
      const echoA = sound(`${orderingFolder}\\A`, 'Tone Echo');
      const echoB = sound(`${orderingFolder}\\B`, 'Tone Echo');
      const zulu = sound(orderingFolder, 'Tone Zulu');
      const sounds = [zulu, echoB, beta, alpha, echoA];
      const originalFolder = settings.soundboardFolderPath;
      const originalViewMode = settings.soundboardViewMode;
      const originalShortcuts = settings.soundboardShortcuts;
      settings.soundboardFolderPath = orderingFolder;
      settings.soundboardShortcuts = { ...originalShortcuts, 'Tone Echo': { accelerator: 'E', display: 'E' } };
      const expectedShortcuts = JSON.stringify(settings.soundboardShortcuts);
      const soundKeys = entries => entries.map(entry => soundFavoriteKey(entry.filePath));
      const checkVisibleFocus = (scroller, message) => {
        const focused = document.activeElement;
        check(focused instanceof HTMLElement && scroller.contains(focused), `${message}: focus stays inside the list`);
        const bounds = focused.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        check(bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1,
          `${message}: the moved star remains visible inside a scrolling list`);
      };
      try {
        for (const mode of ['grid', 'list', 'settings']) {
          modal.close();
          settingsRoot?.remove();
          for (const entry of sounds) {
            if (favorites.isSoundFavorite(entry.filePath)) favorites.toggleSound(entry.filePath);
          }
          folderSounds.set(orderingFolder, sounds);
          settings.soundboardViewMode = mode === 'settings' ? 'list' : mode;
          if (mode === 'settings') {
            settingsTab.favoritesOnly = false;
            settingsTab.searchQuery = '';
            await soundboard.loadSounds();
            renderSettings();
          } else {
            modal.favoritesOnly = false;
            await modal.open();
          }
          clearMetrics();
          const registered = registerShortcuts;
          const content = () => mode === 'settings' ? settingsRoot : modal.modalEl;
          const scroller = content().querySelector(mode === 'settings'
            ? '#soundboard-shortcuts-table-container' : '#sb-sounds-container');
          scroller.style.maxHeight = '110px';
          scroller.style.overflowY = 'auto';
          const currentKeys = () => [...content().querySelectorAll('.favorite-toggle')].map(button => button.dataset.favoriteKey);
          const expectOrder = (entries, reason) => equal(currentKeys(), soundKeys(entries), `${mode}: ${reason}`);
          const setSearch = value => {
            const input = content().querySelector(mode === 'settings' ? '#sb-shortcuts-search-input' : '#sb-search-input');
            input.focus();
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const setFilter = favoriteOnly => {
            const prefix = mode === 'settings' ? 'sb-settings-filter' : 'sb-filter';
            const button = content().querySelector(`#${prefix}-${favoriteOnly ? 'favorites' : 'all'}`);
            button.focus();
            button.click();
          };
          const toggle = (entry, expected, keepsFocus = true) => {
            const key = soundFavoriteKey(entry.filePath);
            const button = [...content().querySelectorAll('.favorite-toggle')].find(item => item.dataset.favoriteKey === key);
            check(!!button, `${mode}: target sound is present by its full path`);
            button.focus();
            button.click();
            expectOrder(expected, `immediate ordering after toggling ${entry.filePath}`);
            if (keepsFocus) {
              equal(document.activeElement?.dataset.favoriteKey, key, `${mode}: a moved star keeps focus on the same file`);
              checkVisibleFocus(scroller, mode);
            } else {
              check(document.activeElement?.isConnected && document.activeElement !== document.body,
                `${mode}: filtering out the focused sound retains usable keyboard focus`);
            }
            equal(plays, [], `${mode}: reordering never plays a sound`);
            equal(connects, [], `${mode}: reordering never navigates`);
          };

          expectOrder([beta, alpha, echoA, echoB, zulu], 'initial nonfavorites are alphabetical with stable path ties');
          toggle(zulu, [zulu, beta, alpha, echoA, echoB]);
          toggle(echoB, [echoB, zulu, beta, alpha, echoA]);
          check(!favorites.isSoundFavorite(echoA.filePath), `${mode}: identical basenames in different folders remain distinct`);
          toggle(alpha, [alpha, echoB, zulu, beta, echoA]);
          toggle(echoB, [alpha, zulu, beta, echoA, echoB]);
          setSearch('tone');
          expectOrder([alpha, zulu, echoA, echoB], 'search retains alphabetical favorite and nonfavorite groups');
          toggle(echoB, [alpha, echoB, zulu, echoA]);
          setFilter(true);
          expectOrder([alpha, echoB, zulu], 'Favorites plus search is alphabetical');
          toggle(echoB, [alpha, zulu], false);
          setFilter(false);
          setSearch('');
          expectOrder([alpha, zulu, beta, echoA, echoB], 'All restores both ordered groups');
          equal(soundboard.getSounds().map(entry => entry.filePath), sounds.map(entry => entry.filePath),
            `${mode}: display sorting never mutates the service source order`);
          equal(JSON.stringify(settings.soundboardShortcuts), expectedShortcuts, `${mode}: shortcut identities remain unchanged`);
          equal(registerShortcuts, registered, `${mode}: sorting does not re-register shortcuts`);
          shortcutCallback('Tone Echo');
          equal(plays.at(-1), echoB.filePath, `${mode}: name-based shortcuts still resolve the original source entry`);

          folderSounds.set(orderingFolder, [...sounds].reverse());
          await soundboard.loadSounds();
          if (mode === 'settings') settingsTab.refreshTable(settingsRoot);
          expectOrder([alpha, zulu, beta, echoA, echoB], 'equal-name path order is stable after source re-enumeration');
          if (mode === 'settings') {
            renderSettings();
          } else {
            await modal.open();
          }
          expectOrder([alpha, zulu, beta, echoA, echoB], 'reopening keeps favorites first and stable ties');
        }
      } finally {
        modal.close();
        settingsRoot?.remove();
        for (const entry of sounds) {
          if (favorites.isSoundFavorite(entry.filePath)) favorites.toggleSound(entry.filePath);
        }
        settings.soundboardFolderPath = originalFolder;
        settings.soundboardViewMode = originalViewMode;
        settings.soundboardShortcuts = originalShortcuts;
        folderSounds.delete(orderingFolder);
        await soundboard.loadSounds();
      }

      const laterPort = { host: 'same.test', port: 4901, name: 'Echo', lastConnected: 50 };
      const serverZulu = { host: 'zulu.test', port: 4900, name: 'Zulu', lastConnected: 40 };
      const serverAlpha = { host: 'alpha.test', port: 4900, name: 'Alpha', lastConnected: 30 };
      const earlierPort = { host: 'same.test', port: 4900, name: 'Echo', lastConnected: 20 };
      const serverBeta = { host: 'beta.test', port: 4900, name: 'Beta', lastConnected: 10 };
      const servers = [laterPort, serverZulu, serverAlpha, earlierPort, serverBeta];
      const originalCreated = connection.createdServers;
      const originalDiscovered = [...home.discoveredServers];
      connection.savedServers = [];
      for (const server of servers) connection.addSavedServer(server);
      connection.createdServers = [
        { ...owned, id: 'created-z', name: 'Zulu Created', port: 4910, lastStarted: 20 },
        { ...owned, id: 'created-a', name: 'Alpha Created', port: 4911, lastStarted: 10 },
      ];
      home.discoveredServers.set('lan-z:4920', { host: 'lan-z', port: 4920, serverName: 'Zulu LAN', version: 'fixture' });
      home.discoveredServers.set('lan-a:4920', { host: 'lan-a', port: 4920, serverName: 'Alpha LAN', version: 'fixture' });
      home.savedFavoritesOnly = false;
      home.render();
      clearMetrics();
      const list = document.querySelector('#home-saved-servers .saved-servers-list');
      list.style.maxHeight = '110px';
      list.style.overflowY = 'auto';
      const homeKeys = () => [...list.querySelectorAll('.saved-server-item')].filter(row => row.style.display !== 'none')
        .map(row => savedServerFavoriteKey({ host: row.dataset.host, port: Number(row.dataset.port) }));
      const expectHome = (entries, reason) => equal(homeKeys(), entries.map(savedServerFavoriteKey), reason);
      const rawSaved = JSON.stringify(connection.savedServers);
      const rawRail = JSON.stringify(connection.railLayout);
      const createdIds = () => [...document.querySelectorAll('.saved-server-item[data-created-server-id]')]
        .map(row => row.dataset.createdServerId);
      const createdBefore = createdIds();
      const discoveredBefore = document.getElementById('lan-discovery-section').innerHTML;
      const hostInput = document.getElementById('join-host');
      hostInput.value = 'unsubmitted-ordering.test';
      const toggleHome = (server, expected, keepsFocus = true) => {
        const key = savedServerFavoriteKey(server);
        const button = [...list.querySelectorAll('.favorite-toggle')].find(item => item.dataset.favoriteKey === key);
        const row = button.closest('.saved-server-item');
        const preview = row.querySelector('.saved-server-preview');
        button.focus();
        button.click();
        expectHome(expected, `Home immediately sorts after toggling ${server.host}:${server.port}`);
        if (keepsFocus) {
          check(document.activeElement === button, 'Home retains the same focused button while moving its row');
          checkVisibleFocus(list, 'Home');
        } else {
          check(document.activeElement?.isConnected && document.activeElement !== document.body, 'Home keeps focus after filtering out a row');
        }
        check(row.isConnected && row.querySelector('.saved-server-preview') === preview, 'Home moves existing rows without discarding previews/listeners');
        equal(hostInput.value, 'unsubmitted-ordering.test', 'Home sorting preserves unsubmitted form fields');
        equal(home.selectedSavedHost, null, 'Home sorting does not select a server');
        equal(plays, [], 'Home sorting does not play sounds');
        equal(connects, [], 'Home sorting does not connect or navigate');
      };
      expectHome([serverAlpha, serverBeta, earlierPort, laterPort, serverZulu], 'Home initial order is alphabetical with address ties');
      toggleHome(serverZulu, [serverZulu, serverAlpha, serverBeta, earlierPort, laterPort]);
      toggleHome(laterPort, [laterPort, serverZulu, serverAlpha, serverBeta, earlierPort]);
      check(!favorites.isServerFavorite(earlierPort), 'Same-host saved servers keep independent port identities');
      toggleHome(serverAlpha, [serverAlpha, laterPort, serverZulu, serverBeta, earlierPort]);
      click('#home-saved-filter-favorites');
      expectHome([serverAlpha, laterPort, serverZulu], 'Home Favorites is alphabetical');
      toggleHome(laterPort, [serverAlpha, serverZulu], false);
      click('#home-saved-filter-all');
      expectHome([serverAlpha, serverZulu, serverBeta, earlierPort, laterPort], 'Home All preserves both alphabetical groups');
      equal(JSON.stringify(connection.savedServers), rawSaved, 'Home never rewrites saved-store recency order');
      equal(JSON.stringify(connection.railLayout), rawRail, 'Home never rewrites sidebar order');
      equal(createdIds(), createdBefore, 'Favorite ordering leaves hosted/created groups unchanged');
      equal(document.getElementById('lan-discovery-section').innerHTML, discoveredBefore, 'Favorite ordering leaves LAN discovery unchanged');
      check(!document.querySelector('[data-created-server-id] .favorite-toggle, #lan-discovery-section .favorite-toggle'),
        'Ordering does not add stars to unrelated Home groups');
      connection.savedServers = [...connection.savedServers].reverse();
      home.render();
      equal([...document.querySelectorAll('#home-saved-servers .favorite-toggle')].map(button => button.dataset.favoriteKey),
        [serverAlpha, serverZulu, serverBeta, earlierPort, laterPort].map(savedServerFavoriteKey),
        'Home reopening is stable even if the source list order changes');
      for (const server of servers) {
        if (favorites.isServerFavorite(server)) favorites.toggleServer(server);
      }
      connection.createdServers = originalCreated;
      home.discoveredServers.clear();
      for (const [key, value] of originalDiscovered) home.discoveredServers.set(key, value);
      resetSaved();
    },
    async favoriteMotion(mode) {
      const folder = 'C:\\Sounds\\Motion';
      const soundItems = [
        sound(folder, 'Zulu'), sound(`${folder}\\B`, 'Echo'), sound(folder, 'Beta'),
        sound(folder, 'Alpha'), sound(`${folder}\\A`, 'Echo'),
      ];
      const servers = [
        { host: 'motion-z.test', port: 4800, name: 'Zulu', lastConnected: 50 },
        { host: 'motion-echo.test', port: 4801, name: 'Echo', lastConnected: 40 },
        { host: 'motion-b.test', port: 4800, name: 'Beta', lastConnected: 30 },
        { host: 'motion-a.test', port: 4800, name: 'Alpha', lastConnected: 20 },
        { host: 'motion-echo.test', port: 4800, name: 'Echo', lastConnected: 10 },
      ];
      const entries = mode === 'home' ? servers : soundItems;
      const [zulu, echoB, beta, alpha, echoA] = entries;
      const key = entry => mode === 'home' ? savedServerFavoriteKey(entry) : soundFavoriteKey(entry.filePath);
      const all = [alpha, beta, echoA, echoB, zulu];
      const previous = {
        folder: settings.soundboardFolderPath, view: settings.soundboardViewMode,
        shortcuts: settings.soundboardShortcuts,
      };
      const controller = mode === 'home' ? home.savedFavoriteMotion : mode === 'settings'
        ? settingsTab.favoriteMotion : modal.favoriteMotion;
      const surface = () => mode === 'home' ? document.getElementById('home-saved-servers')
        : mode === 'settings' ? settingsRoot : modal.modalEl;
      const scrollArea = () => surface().querySelector(mode === 'home' ? '.saved-servers-list'
        : mode === 'settings' ? '#soundboard-shortcuts-table-container' : '#sb-sounds-container');
      const stars = () => [...surface().querySelectorAll('.favorite-toggle')]
        .filter(button => button.checkVisibility({ checkVisibilityCSS: true }));
      const star = entry => stars().find(button => button.dataset.favoriteKey === key(entry));
      const row = entry => star(entry)?.closest('.sb-sound-card, .sb-sound-row, .sb-shortcut-row, .saved-server-item');
      const expectOrder = (expected, message) => equal(stars().map(button => button.dataset.favoriteKey), expected.map(key), `${mode}: ${message}`);
      const toggle = entry => {
        const button = star(entry);
        check(!!button, `${mode}: stable identity finds the star`);
        button.focus();
        button.click();
      };
      const filter = only => {
        const prefix = mode === 'home' ? 'home-saved-filter' : mode === 'settings' ? 'sb-settings-filter' : 'sb-filter';
        const button = surface().querySelector(`#${prefix}-${only ? 'favorites' : 'all'}`);
        button.focus();
        button.click();
      };
      const search = query => {
        const input = surface().querySelector(mode === 'settings' ? '#sb-shortcuts-search-input' : '#sb-search-input');
        input.focus();
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const animations = () => [...controller.animations];
      const clean = () => {
        equal(controller.animations.size, 0, `${mode}: no retained animations`);
        check(!controller.layer && !controller.root && !controller.unwatch && !controller.ghosts.length,
          `${mode}: temporary layers, observers and listeners are released`);
        check(!document.querySelector('[data-favorite-motion-layer]'), `${mode}: no orphaned visual copies`);
      };
      const finish = async () => {
        for (const animation of animations()) animation.finish();
        await until(() => controller.animations.size === 0, `${mode}: animations should finish`);
        clean();
      };
      const focused = entry => {
        equal(document.activeElement?.dataset.favoriteKey, key(entry), `${mode}: focus stays on the same identity`);
        const bounds = document.activeElement.getBoundingClientRect();
        const clip = scrollArea().getBoundingClientRect();
        check(bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1, `${mode}: focused control remains visible`);
      };
      const mount = async () => {
        modal.close();
        settingsRoot?.remove();
        controller.cancel();
        for (const entry of entries) {
          if (mode === 'home' ? favorites.isServerFavorite(entry) : favorites.isSoundFavorite(entry.filePath)) {
            if (mode === 'home') favorites.toggleServer(entry);
            else favorites.toggleSound(entry.filePath);
          }
        }
        if (mode === 'home') {
          connection.savedServers = [];
          for (const server of servers) connection.addSavedServer(server);
          home.savedFavoritesOnly = false;
          home.render();
          surface().scrollIntoView({ block: 'center', behavior: 'instant' });
        } else {
          folderSounds.set(folder, soundItems);
          settings.soundboardFolderPath = folder;
          settings.soundboardShortcuts = { ...previous.shortcuts, Echo: { accelerator: 'E', display: 'E' } };
          settings.soundboardViewMode = mode === 'settings' ? 'list' : mode;
          if (mode === 'settings') {
            settingsTab.searchQuery = '';
            settingsTab.favoritesOnly = false;
            await soundboard.loadSounds();
            renderSettings();
            Object.assign(settingsRoot.style, { position: 'fixed', inset: '20px', overflow: 'auto', background: 'var(--bg-primary)' });
          } else {
            modal.favoritesOnly = false;
            await modal.open();
          }
        }
        const scroller = scrollArea();
        scroller.style.maxHeight = '350px';
        scroller.style.minHeight = '0';
        scroller.style.overflowY = 'auto';
        await document.fonts.ready;
        await new Promise(resolve => setTimeout(resolve, 280));
        clearMetrics();
      };
      const unmount = () => {
        if (mode === 'home') root.innerHTML = '';
        else if (mode === 'settings') settingsRoot.remove();
        else modal.close();
      };
      const restore = async () => {
        unmount();
        await until(() => controller.animations.size === 0, `${mode}: unmount releases motion`);
        clean();
        for (const entry of entries) {
          if (mode === 'home' ? favorites.isServerFavorite(entry) : favorites.isSoundFavorite(entry.filePath)) {
            if (mode === 'home') favorites.toggleServer(entry);
            else favorites.toggleSound(entry.filePath);
          }
        }
        settings.soundboardFolderPath = previous.folder;
        settings.soundboardViewMode = previous.view;
        settings.soundboardShortcuts = previous.shortcuts;
        folderSounds.delete(folder);
        await soundboard.loadSounds();
        if (mode === 'home') resetSaved();
      };
      motionCase = { mode, zulu, all, toggle, filter, focused, expectOrder, animations, clean, restore };
      await mount();
      expectOrder(all, 'initial alphabetical order');
      const sourceBefore = JSON.stringify(mode === 'home' ? connection.savedServers : soundboard.getSounds());
      const railBefore = JSON.stringify(connection.railLayout);
      const shortcutsBefore = JSON.stringify(settings.soundboardShortcuts);
      const unrelatedBefore = mode === 'home' ? [
        document.getElementById('lan-discovery-section').innerHTML,
        [...document.querySelectorAll('.saved-server-item[data-created-server-id]')].map(element => element.outerHTML),
      ] : null;

      toggle(zulu);
      expectOrder([zulu, alpha, beta, echoA, echoB], 'logical order changes immediately');
      const item = row(zulu);
      const moving = animations().find(animation => animation.effect.target === item);
      check(!!moving, `${mode}: the actual item, not just its star, is animated`);
      await moving.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      check(moving.playState === 'running' && moving.currentTime > 0 && moving.currentTime < 240,
        `${mode}: motion advances on the real timeline: ${JSON.stringify({
          state: moving.playState, currentTime: moving.currentTime, pending: moving.pending,
          timeline: document.timeline.currentTime, visibility: document.visibilityState,
        })}`);
      const middle = item.getBoundingClientRect();
      moving.pause();
      moving.currentTime = 0;
      const start = item.getBoundingClientRect();
      moving.currentTime = 240;
      const end = item.getBoundingClientRect();
      const distance = (a, b) => Math.hypot(a.left - b.left, a.top - b.top);
      check(distance(start, end) > 2 && distance(middle, start) > 0.5 && distance(middle, end) > 0.5,
        `${mode}: rendered midpoint differs from both start and final positions`);
      await finish();
      focused(zulu);
      expectOrder([zulu, alpha, beta, echoA, echoB], 'animation ends in alphabetical favorite groups');

      const originalObserver = window.MutationObserver;
      let staleLayoutCallback;
      window.MutationObserver = class extends originalObserver {
        constructor(callback) { super(callback); staleLayoutCallback = callback; }
      };
      try {
        toggle(zulu);
      } finally {
        window.MutationObserver = originalObserver;
      }
      const interrupted = animations();
      for (const animation of interrupted) { animation.pause(); animation.currentTime = 65; }
      const current = row(zulu).getBoundingClientRect();
      toggle(zulu);
      check(interrupted.every(animation => animation.playState === 'idle'), `${mode}: rapid toggle cancels all superseded effects`);
      check(distance(current, row(zulu).getBoundingClientRect()) < 2, `${mode}: rapid toggle starts from the current visual position`);
      check(animations().length > 0, `${mode}: the interrupted movement continues toward its new destination`);
      check(typeof staleLayoutCallback === 'function', `${mode}: the previous layout observer was captured`);
      const resumed = animations().length;
      staleLayoutCallback();
      equal(animations().length, resumed, `${mode}: a stale layout callback cannot cancel the replacement transition`);
      await until(() => controller.animations.size === 0, `${mode}: motion naturally reaches its final frame`);
      clean();
      focused(zulu);

      toggle(alpha);
      await finish();
      filter(true);
      expectOrder([alpha, zulu], 'Favorites filter immediately excludes nonfavorites');
      check(animations().length > 0, `${mode}: filtering animates the remaining items`);
      for (const layer of document.querySelectorAll('[data-favorite-motion-layer]')) {
        check(layer.inert && layer.getAttribute('aria-hidden') === 'true', `${mode}: exiting visual copies cannot receive focus or clicks`);
        check(!layer.querySelector('[id]'), `${mode}: exiting copies do not duplicate control IDs`);
      }
      const filteredEffects = animations();
      for (const animation of filteredEffects) { animation.pause(); animation.currentTime = 65; }
      filter(false);
      check(filteredEffects.every(animation => animation.playState === 'idle'), `${mode}: rapid filter reversal cancels old effects`);
      expectOrder([alpha, zulu, beta, echoA, echoB], 'All restores ordered groups during the transition');
      check(animations().some(animation => animation.id === 'favorite-list-enter' || animation.id === 'favorite-list-move'),
        `${mode}: restored rows transition back into view`);
      await finish();
      toggle(alpha);
      await finish();
      toggle(zulu);
      await finish();
      filter(true);
      expectOrder([], 'empty Favorites has no stale interactive rows');
      check(animations().some(animation => animation.id === 'favorite-list-enter'), `${mode}: the empty state fades into view`);
      if (mode === 'home') home.render();
      else search('no-such-motion-sound');
      clean();
      if (mode !== 'home') search('');
      filter(false);
      await finish();
      expectOrder(all, 'recovering from an empty filter preserves the normal order');

      toggle(zulu);
      check(animations().length > 0, `${mode}: resize scenario starts with active motion`);
      const scroller = scrollArea();
      const width = scroller.style.width;
      scroller.style.width = `${scroller.getBoundingClientRect().width - 24}px`;
      await until(() => controller.animations.size === 0, `${mode}: resize cancels obsolete geometry`);
      clean();
      scroller.style.width = width;
      await tick();
      toggle(zulu);
      check(animations().length > 0, `${mode}: hiding a mounted panel interrupts active motion`);
      surface().style.visibility = 'hidden';
      await until(() => controller.animations.size === 0, `${mode}: hidden panels release their motion`);
      clean();
      surface().style.visibility = '';
      await tick();
      toggle(zulu);
      await finish();
      scroller.style.maxHeight = '80px';
      await tick();
      toggle(zulu);
      check(animations().length > 0, `${mode}: scroll scenario starts with active motion`);
      check(scroller.scrollTop > 0, `${mode}: focused last item is scrolled into view`);
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
      clean();
      await new Promise(resolve => setTimeout(resolve, 280));
      equal(scroller.scrollTop, 0, `${mode}: no late completion steals user-controlled scrolling`);
      scroller.style.maxHeight = '350px';
      await tick();
      equal(JSON.stringify(mode === 'home' ? connection.savedServers : soundboard.getSounds()), sourceBefore,
        `${mode}: animation never mutates the service/store source`);
      equal(JSON.stringify(connection.railLayout), railBefore, `${mode}: animation leaves sidebar ordering alone`);
      equal(JSON.stringify(settings.soundboardShortcuts), shortcutsBefore, `${mode}: animation preserves shortcut identities`);
      if (unrelatedBefore) equal([
        document.getElementById('lan-discovery-section').innerHTML,
        [...document.querySelectorAll('.saved-server-item[data-created-server-id]')].map(element => element.outerHTML),
      ], unrelatedBefore, 'Home animation leaves hosted and LAN groups untouched');
      equal(plays, [], `${mode}: stars and filters never play a sound`);
      equal(connects, [], `${mode}: stars and filters never navigate`);
      if (mode !== 'home') {
        shortcutCallback('Echo');
        equal(plays.at(-1), echoB.filePath, `${mode}: duplicate-name shortcuts retain their original full-path target`);
      }
      toggle(zulu);
      const closing = animations();
      check(closing.length > 0, `${mode}: close scenario starts with active motion`);
      unmount();
      await until(() => controller.animations.size === 0, `${mode}: closing cancels motion`);
      check(closing.every(animation => animation.playState === 'idle'), `${mode}: closing cancels native animation objects`);
      clean();

      await mount();
      toggle(zulu);
      check(animations().length > 0, `${mode}: reduced-motion preference changes interrupt an active transition`);
    },
    async favoriteMotionReduced() {
      const scene = motionCase;
      check(window.matchMedia('(prefers-reduced-motion: reduce)').matches, `${scene.mode}: browser preference is really emulated`);
      await until(() => scene.animations().length === 0, `${scene.mode}: reduced motion cancels in-flight effects`);
      scene.clean();
      scene.focused(scene.zulu);
      scene.toggle(scene.zulu);
      scene.expectOrder(scene.all, 'reduced motion preserves immediate alphabetical order');
      scene.focused(scene.zulu);
      scene.clean();
      scene.filter(true);
      scene.expectOrder([], 'reduced-motion empty Favorites applies immediately');
      scene.clean();
      scene.filter(false);
      scene.expectOrder(scene.all, 'reduced-motion All restores items without effects');
      scene.clean();
      equal(plays, [], `${scene.mode}: reduced-motion interactions never play audio`);
      equal(connects, [], `${scene.mode}: reduced-motion interactions never navigate`);
      await scene.restore();
      motionCase = null;
    },
    async navigation() {
      for (const host of ['remote.test', '127.0.0.1']) {
        for (const mode of ['p2p', 'sfu']) {
          const { call, before } = prepareCall(host, mode);
          const opening = rail.connectToSavedServer(target);
          await until(() => document.querySelector('.dialog-card'), 'Owned-server start confirmation');
          equal(document.querySelector('.dialog-card [data-action="confirm"]').textContent,
            t('main.serverOfflineStartConfirm'), 'Confirmation uses the start-only translation');
          await settleDialog();
          await opening;
          equal(hostStarts.length, 1, `${host}/${mode}: starts the requested hosted server once`);
          equal(hostStarts[0].voiceMode, owned.voiceMode, 'Start preserves the chosen server voice mode');
          equal(sessions.getActiveKey(), sessionKeyFor(target.host, target.port), `${host}/${mode}: views the started server`);
          preserveVoice(before, call, `${host}/${mode} rail browse`);
          const connections = connects.length;
          await rail.connectToSavedServer(target);
          await navigation.openServerSession(target.host, target.port, identity, 'Fixture');
          equal(connects.length, connections, 'Repeated browsing reuses a live socket, never authenticates again');
          preserveVoice(before, call, `${host}/${mode} live browse`);
          await navigation.openServerSession(call.host, call.port, identity, 'Fixture');
          equal(connects.length, connections, 'Browsing the current call server reuses its socket too');
          preserveVoice(before, call, `${host}/${mode} return to call server`);
        }
      }
      for (const [host, spelling] of [['remote.test', ' WSS://REMOTE.TEST '], ['[::1]', '::1']]) {
        const { call, before } = prepareCall(host);
        await navigation.openServerSession(spelling, call.port, identity, 'Fixture');
        equal(connects.length, 0, 'Equivalent address spelling does not create a duplicate voice socket');
        equal(sessions.getActiveKey(), call.key, 'Equivalent address spelling shows the existing session');
        preserveVoice(before, call, 'Equivalent server address');
      }
      {
        const { call, visible, before } = prepareCall();
        const opening = rail.connectToSavedServer(target);
        await settleDialog(false);
        await opening;
        equal(hostStarts.length, 0, 'Cancelling does not start a hosted server');
        equal(sessions.getActiveKey(), visible.key, 'Cancelling preserves the visible server');
        preserveVoice(before, call, 'Cancelled start');
      }
      for (const failure of ['start', 'different-hosted-server', 'same-port-different-id', 'unknown-hosted-id']) {
        const { call, visible, before } = prepareCall('127.0.0.1', 'sfu');
        startFailure = failure === 'start';
        if (failure === 'different-hosted-server') hosted = { isRunning: true, port: 4100, serverId: 'call-host' };
        if (failure === 'same-port-different-id') hosted = { isRunning: true, port: 4200, serverId: 'different-data' };
        if (failure === 'unknown-hosted-id') hosted = { isRunning: true, port: 4200, serverId: null };
        const opening = rail.connectToSavedServer(target);
        await settleDialog();
        await settleDialog();
        await opening;
        equal(sessions.getActiveKey(), visible.key, `${failure}: preserves the current view`);
        equal(connects, [], `${failure}: never connects on failed startup`);
        if (failure !== 'start') equal(hostStarts.length, 0, `${failure}: never replaces an existing host`);
        preserveVoice(before, call, failure);
      }
      {
        const { call, visible, before } = prepareCall();
        const failure = deferred();
        connectGates.set(sessionKeyFor(target.host, target.port), failure);
        const opening = navigation.openServerSession(target.host, target.port, identity, 'Fixture');
        failure.reject(new Error('Fixture authentication failure'));
        await opening.then(() => check(false, 'Connection must fail'), () => {});
        equal(sessions.getActiveKey(), visible.key, 'Failed authentication restores the previous view');
        preserveVoice(before, call, 'Failed authentication');
      }
      {
        const { call, before } = prepareCall();
        const failure = deferred();
        connectGates.set(sessionKeyFor(target.host, target.port), failure);
        const opening = navigation.openServerSession(target.host, target.port, identity, 'Fixture');
        const later = seed('later.test', 4300);
        navigation.showServerSession(later.key);
        failure.reject(new Error('Late authentication failure'));
        await opening.then(() => check(false, 'Connection must fail'), () => {});
        equal(sessions.getActiveKey(), later.key, 'A late failure never rolls back newer navigation');
        preserveVoice(before, call, 'Late connection failure');
      }
      {
        const { call, visible, before } = prepareCall();
        const firstFailure = deferred();
        const secondFailure = deferred();
        connectGates.set(sessionKeyFor(target.host, target.port), firstFailure);
        connectGates.set(sessionKeyFor('next.test', 4400), secondFailure);
        const first = navigation.openServerSession(target.host, target.port, identity, 'Fixture');
        const second = navigation.openServerSession('next.test', 4400, identity, 'Fixture');
        firstFailure.reject(new Error('First attempt failed'));
        await first.then(() => check(false, 'First connection must fail'), () => {});
        secondFailure.reject(new Error('Second attempt failed'));
        await second.then(() => check(false, 'Second connection must fail'), () => {});
        equal(sessions.getActiveKey(), visible.key, 'Overlapping failures restore the last real view, not a failed pending session');
        preserveVoice(before, call, 'Overlapping connection failures');
      }
      {
        const { call, visible, before } = prepareCall();
        const failure = deferred();
        connectGates.set(sessionKeyFor(target.host, target.port), failure);
        const opening = navigation.openServerSession(target.host, target.port, identity, 'Fixture');
        const incomplete = sessions.create('incomplete.test', 4500, 'Fixture');
        incomplete.client.status = 'CONNECTED';
        await navigation.openServerSession(incomplete.host, incomplete.port, identity, 'Fixture')
          .then(() => check(false, 'An incomplete session must not be shown'), () => {});
        failure.reject(new Error('Failed after an invalid navigation'));
        await opening.then(() => check(false, 'Connection must fail'), () => {});
        equal(sessions.getActiveKey(), visible.key, 'Refused navigation does not cancel the pending attempt rollback');
        preserveVoice(before, call, 'Refused navigation during connection');
      }
      {
        const { call, before } = prepareCall();
        startGate = deferred();
        const opening = rail.connectToSavedServer(target);
        await settleDialog();
        await until(() => hostStarts.length === 1, 'Hosted start should be pending');
        const later = seed('later.test', 4300);
        navigation.showServerSession(later.key);
        startGate.resolve();
        await opening;
        equal(sessions.getActiveKey(), later.key, 'Finishing a background start cannot steal newer navigation');
        equal(connects.length, 0, 'A superseded start does not open another socket');
        preserveVoice(before, call, 'Superseded hosted start');
      }
      {
        const { call, before } = prepareCall();
        const gate = deferred();
        connectGates.set(sessionKeyFor(target.host, target.port), gate);
        const first = navigation.openServerSession(target.host, target.port, identity, 'Fixture');
        const second = navigation.openServerSession(target.host, target.port, identity, 'Fixture');
        equal(connects.length, 1, 'Concurrent browsing shares one authentication');
        gate.resolve();
        await Promise.all([first, second]);
        preserveVoice(before, call, 'Concurrent browsing');
        const starts = hostStarts.length;
        hosted = { isRunning: true, port: owned.port, serverId: owned.id };
        startGate = deferred();
        let ready = false;
        const readiness = hosting.ensureHostedServerStarted(owned).then(() => { ready = true; });
        await until(() => hostStarts.length === starts + 1, 'Matching hosts still require the native idempotency/readiness operation');
        check(!ready, 'An earlier running status cannot bypass pending native start/stop work');
        startGate.resolve();
        await readiness;
        check(ready, 'A matching host is ready only after native confirmation');
        preserveVoice(before, call, 'Native idempotent hosted start');
      }
      {
        const { call, before } = prepareCall();
        hosted = { isRunning: true, port: owned.port, serverId: owned.id };
        startFailure = true;
        await hosting.ensureHostedServerStarted(owned)
          .then(() => check(false, 'An unhealthy matching host cannot claim successful startup'), () => {});
        equal(hostStarts.length, 1, 'A failed native readiness check is not bypassed by a matching status');
        preserveVoice(before, call, 'Failed native readiness');
      }
      {
        const { call, before } = prepareCall();
        startGate = deferred();
        const first = hosting.ensureHostedServerStarted(owned);
        const second = hosting.ensureHostedServerStarted(owned);
        await tick();
        equal(hostStarts.length, 1, 'Concurrent same-server starts share one IPC operation');
        await hosting.ensureHostedServerStarted({ ...owned, id: 'other', port: 4201 })
          .then(() => check(false, 'Another start must be refused while busy'), () => {});
        startGate.resolve();
        await Promise.all([first, second]);
        preserveVoice(before, call, 'Concurrent hosted starts');
      }
      {
        const { call, visible, before } = prepareCall();
        call.client.status = 'RECONNECTING';
        await navigation.openServerSession(call.host, call.port, identity, 'Fixture')
          .then(() => check(false, 'Browsing may not replace a recovering voice socket'), () => {});
        equal(connects.length, 0, 'A recovering call owns its own reconnection');
        equal(sessions.getActiveKey(), visible.key, 'Refused recovery navigation preserves the view');
        preserveVoice(before, call, 'Recovering call');
      }
      {
        const { call, before } = prepareCall('remote.test', 'sfu');
        home.render();
        document.getElementById('join-host').value = target.host;
        document.getElementById('join-port').value = String(target.port);
        const opening = home.submitJoinForm();
        await settleDialog();
        await opening;
        equal(sessions.getActiveKey(), sessionKeyFor(target.host, target.port), 'Home opens an owned server without a voice join');
        preserveVoice(before, call, 'Home browse');
      }
      {
        const { call, before } = prepareCall();
        await home.startHostedServer(owned, 'Fixture');
        equal(sessions.getActiveKey(), sessionKeyFor(target.host, target.port), 'Home start-and-view opens the target');
        preserveVoice(before, call, 'Home start button');
      }
      {
        const { call } = prepareCall();
        const destination = seed(target.host, target.port);
        await navigation.joinCallOnSession(destination.key, 'voice-room');
        equal(voice.voiceSessionKey, destination.key, 'An explicit voice join still moves to the requested session');
        check(sends.some(item => item.key === call.key && item.type === MessageType.VOICE_LEAVE),
          'Explicit voice join still leaves the previous call');
        check(sends.some(item => item.key === destination.key && item.type === MessageType.VOICE_JOIN),
          'Explicit voice join still requests admission');
        check(mediaCalls.includes('audio.startMicrophone'), 'Explicit voice join still acquires microphone media');
      }
    },
    async noiseToggle() {
      const { call } = prepareCall();
      sessions.activate(call.key);
      let gate = null;
      const requests = [];
      replace(audio, 'setNoiseSuppression', async mode => {
        requests.push(mode);
        if (gate) await gate.promise;
      });
      for (const mode of ['rnnoise', 'speex', 'gtcrn', 'browser']) {
        settings.noiseSuppressionMode = mode;
        settings.lastNoiseSuppressionMode = mode;
        settings.save();
        app.mainView.render();
        const button = document.getElementById('sidebar-btn-rnnoise');
        check(button.classList.contains('rnnoise-active'), `${mode}: initial quick toggle is active`);
        equal(button.title, noiseSuppressionToggleTitle(mode), `${mode}: initial tooltip names the selected engine`);
        equal(button.getAttribute('aria-pressed'), 'true', `${mode}: initial pressed state`);
        const savedBefore = localStorage.getItem('monky_settings');
        gate = deferred();
        button.click();
        check(button.disabled, `${mode}: disable the quick toggle while applying`);
        equal(settings.noiseSuppressionMode, mode, `${mode}: do not publish settings before audio accepts the change`);
        equal(localStorage.getItem('monky_settings'), savedBefore, `${mode}: do not save settings before awaiting`);
        equal(requests.at(-1), 'off', `${mode}: disabling requests the explicit off mode`);
        const requestCount = requests.length;
        button.click();
        equal(requests.length, requestCount, `${mode}: repeated clicks cannot queue another toggle`);
        gate.resolve();
        await until(() => !button.disabled, `${mode}: quick toggle completes`);
        equal(settings.noiseSuppressionMode, 'off', `${mode}: disabling commits off`);
        equal(settings.lastNoiseSuppressionMode, mode, `${mode}: preserve the last selected engine`);
        check(!button.classList.contains('rnnoise-active'), `${mode}: settings.updated removes the active state`);
        equal(button.title, noiseSuppressionToggleTitle('off'), `${mode}: settings.updated refreshes the off tooltip`);
        equal(button.getAttribute('aria-pressed'), 'false', `${mode}: settings.updated refreshes pressed state`);
        gate = null;
        button.click();
        await until(() => !button.disabled, `${mode}: restoring the last engine completes`);
        equal(requests.at(-1), mode, `${mode}: re-enabling restores this engine, not RNNoise`);
        equal(settings.noiseSuppressionMode, mode, `${mode}: restored selection is committed`);
        equal(button.title, noiseSuppressionToggleTitle(mode), `${mode}: restored tooltip names the engine`);
        equal(button.getAttribute('aria-label'), button.title, `${mode}: accessible label matches the tooltip`);
      }
      for (const [mode, last] of [['speex', 'speex'], ['off', 'gtcrn']]) {
        settings.noiseSuppressionMode = mode;
        settings.lastNoiseSuppressionMode = last;
        settings.save();
        const button = document.getElementById('sidebar-btn-rnnoise');
        const savedBefore = localStorage.getItem('monky_settings');
        gate = deferred();
        button.click();
        gate.reject(new Error('Fixture noise engine rejected'));
        await until(() => document.querySelector('.dialog-card'), 'Noise selection failure alert');
        equal(document.querySelector('.dialog-message').textContent, t('audioNoise.selectionFailed'),
          `${mode}: noise selection failures are actionable and localized`);
        equal(settings.noiseSuppressionMode, mode, `${mode}: failed selection restores the previous mode`);
        equal(settings.lastNoiseSuppressionMode, last, `${mode}: failed selection preserves the remembered engine`);
        equal(localStorage.getItem('monky_settings'), savedBefore, `${mode}: failed selection does not overwrite saved settings`);
        await settleDialog();
        await until(() => !button.disabled, 'Re-enable the quick toggle after an error');
        equal(button.title, noiseSuppressionToggleTitle(mode), `${mode}: failed selection preserves its tooltip`);
        equal(button.getAttribute('aria-pressed'), String(mode !== 'off'), `${mode}: failed selection preserves its pressed state`);
      }
      gate = null;
    },
    cleanup() {
      modal.close();
      settingsRoot?.remove();
      app.mainView.destroy();
      home.contentResizeObserver?.disconnect();
      for (const off of home.unbindLanListeners) off();
      if (rail.probeDebounceTimer) clearTimeout(rail.probeDebounceTimer);
      voice.voiceSessionKey = null;
      voice.currentVoiceChannelId = null;
      for (const session of sessions.getAll()) session.client.status = 'DISCONNECTED';
      sessions.removeAll();
      for (const restore of restores.reverse()) restore();
      window.fetch = originalFetch;
      navigator.mediaDevices.enumerateDevices = originalEnumerateDevices;
      navigator.mediaDevices.getUserMedia = originalGetUserMedia;
      bus.clear();
      return checks;
    },
  };
}
