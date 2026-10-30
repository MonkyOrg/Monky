const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

// The whole app in real Chromium, with a saved server that is stopped: moving a
// volume slider, muting or saving any setting other than automatic connection
// never probes saved servers nor calls the push-to-talk hook, and the volume is
// saved once, where the slider stops (R-SHELL-2, R-VOICEUI-8). The sidebar
// rebuilds only the rows a voice or presence event changed, so keyboard focus
// stays put, and folding a category neither redraws the server nor asks it for
// anything (R-SHELL-11).
if (!process.versions.electron) {
  const assert = require('node:assert/strict');
  const { test } = require('node:test');
  test('settings changes stay scoped and the sidebar keeps untouched rows', { timeout: 150_000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `settings-sidebar-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SETTINGS_SIDEBAR_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_SETTINGS_SIDEBAR_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, window, timer;
  const finish = async code => {
    clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    await vite?.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timer = setTimeout(() => {
      console.error('Settings and sidebar smoke timed out');
      void finish(1);
    }, 120_000);
    const { createServer } = await import('vite');
    const mainPath = path.join(clientRoot, 'src', 'renderer', 'main.ts');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'settings-sidebar-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/settings-sidebar-shared.js') return '\0settings-sidebar-shared';
        },
        load(id) {
          if (id === '\0settings-sidebar-shared') return "export { MessageType, PROTOCOL_VERSION } from '@monky/shared';";
        },
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) {
            return { code: `${code}\nexport { App as SettingsSidebarTestApp };`, map: null };
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__settings_sidebar__') return next();
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
      show: false, width: 1280, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.on('console-message', event => {
      if (event.level === 'error') console.error(`[renderer] ${event.message}`);
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/__settings_sidebar__`);
    const checks = await window.webContents.executeJavaScript(`(${settingsSidebarSmoke.toString()})()`, true);
    console.log(`Settings and sidebar smoke: ${checks} checks passed`);
    await finish(0);
  }).catch(async error => {
    console.error('Settings and sidebar smoke failed', error);
    await finish(1);
  });
}

async function settingsSidebarSmoke() {
  let checks = 0;
  let phase = 'startup';
  const check = (condition, message) => {
    if (!condition) throw new Error(`[${phase}] ${message}`);
    checks++;
  };
  const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (condition()) return;
      await tick();
    }
    throw new Error(`[${phase}] ${message}`);
  };

  const identity = { clientId: 'fixture-client', publicKey: 'fixture-public-key' };
  const unsubscribe = () => () => {};
  const ok = value => Promise.resolve({ ok: true, value });
  const ptt = [];
  window.api = {
    getIdentityStatus: async () => ({ state: 'ready' }),
    getIdentity: async () => identity,
    signChallenge: async nonce => `fixture-signature:${nonce}`,
    getClientLogConfig: async () => ({ enabled: false }),
    writeClientLog: async () => {},
    setPttConfig: async config => { ptt.push(config); return true; },
    onPttStateChanged: unsubscribe,
    onAppBeforeQuit: unsubscribe,
    onTrayToggleMute: unsubscribe,
    onTrayToggleDeafen: unsubscribe,
    onTrayLeaveCall: unsubscribe,
    updateTrayVoiceStatus: async () => {},
    setWindowInServer: async () => {},
    stopLanDiscovery: async () => {},
    startLanDiscovery: async () => {},
    onLanDiscoveryFound: unsubscribe,
    onLanDiscoveryLost: unsubscribe,
    hostServerStatus: async () => ({ servers: [] }),
    hostServerStart: async () => ({ success: true }),
    hostServerStop: async () => ({ success: true }),
    hostServerDeleteData: async () => ({ success: true }),
    onHostServerStatusChanged: unsubscribe,
    setLanguage: async () => {},
    setMinimizeToTray: async () => {},
    signalRendererReady: () => {},
    maximize: async () => {},
    getAppVersion: async () => '0.0.0-fixture',
    openExternal: async () => ({ success: true }),
    dm: new Proxy({}, { get: (_target, name) => name === 'snapshot'
      ? () => ok({ me: { publicKey: 'f'.repeat(64) }, peers: [], conversations: [], settings: { maxFileBytes: 1 } })
      : name === 'onEvent' ? () => () => {} : name === 'pendingPeers' ? () => ok([]) : () => ok({}) }),
  };

  // a.test is on screen; the saved server on this machine is stopped.
  localStorage.clear();
  localStorage.setItem('monky_saved_servers', JSON.stringify([
    { host: 'a.test', port: 5601, name: 'a.test', lastConnected: 2, password: '' },
    { host: '127.0.0.1', port: 5699, name: 'Meu servidor', lastConnected: 1, password: '' },
  ]));
  localStorage.setItem('monky_nickname', 'Fixture');
  localStorage.setItem('monky_settings', JSON.stringify({ onboardingCompleted: true, autoConnectServers: true, autoEntryServerKeys: [] }));
  const probes = [];
  window.fetch = async url => {
    const { hostname } = new URL(String(url));
    probes.push(hostname);
    throw new TypeError('Failed to fetch');
  };
  const stoppedProbes = () => probes.filter(host => host === '127.0.0.1').length;
  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('The settings and sidebar smoke never captures media'); };

  const [{ SettingsSidebarTestApp }, { openServerSession }, { appEvents }, { settingsStore }, { participantManager },
    { serverStore }, { toggleMicrophoneMute }, { serverRailView }, shared] = await Promise.all([
    import('/main.ts'), import('/core/serverConnection.ts'), import('/core/EventBus.ts'), import('/stores/settingsStore.ts'),
    import('/core/ParticipantManager.ts'), import('/stores/serverStore.ts'), import('/core/voiceControls.ts'),
    import('/views/ServerRailView.ts'), import('/settings-sidebar-shared.js'),
  ]);
  // The rail probes once, a second after it is drawn; its later rounds stay out of the counts below.
  serverRailView.constructor.PROBE_INTERVAL_MS = 10 * 60_000;
  const { MessageType, PROTOCOL_VERSION } = shared;
  const person = (id, nickname) => ({ id, sessionId: `${id}:device`, clientId: id, nickname, status: 'ONLINE', joinedAt: 2 });
  const me = { ...person(identity.clientId, 'Fixture'), joinedAt: 1 };
  const members = [me, person('ana', 'Ana'), person('bia', 'Bia'), person('caio', 'Caio'), person('duda', 'Duda')];
  const voiceState = (member, channelId, extra = {}) => ({
    sessionId: member.sessionId, userId: member.id, channelId, isMuted: false, isDeafened: false, serverMuted: false,
    serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
    connectionHealth: 'connected', ...extra,
  });
  const payload = {
    currentUser: me,
    voiceRestrictions: { serverMuted: false, serverDeafened: false },
    server: {
      id: 'server-5601', name: 'Server 5601', createdAt: 1, maxUsers: 0, voiceMode: 'p2p',
      categories: [{ id: 'rooms', name: 'Salas', position: 0, createdAt: 1 }],
      channels: [
        { id: 'text-1', name: 'geral', type: 'TEXT', position: 0, createdAt: 1 },
        { id: 'voice-1', name: 'Sala 1', type: 'VOICE', position: 1, createdAt: 2, categoryId: 'rooms' },
        { id: 'voice-2', name: 'Sala 2', type: 'VOICE', position: 2, createdAt: 3, categoryId: 'rooms' },
      ],
      members, knownMembers: members,
      voiceStates: {
        [members[1].sessionId]: voiceState(members[1], 'voice-1'),
        [members[2].sessionId]: voiceState(members[2], 'voice-1'),
        [members[3].sessionId]: voiceState(members[3], 'voice-2'),
      },
      roles: [], userRoles: [], ownerId: me.id, myPermissions: 2147483647,
      protocol: { version: PROTOCOL_VERSION, features: [] },
    },
  };
  class FixtureSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    constructor() {
      queueMicrotask(() => {
        this.readyState = FixtureSocket.OPEN;
        this.onopen?.({});
      });
    }
    reply(type, requestId, body) {
      queueMicrotask(() => {
        if (this.readyState === FixtureSocket.OPEN) this.onmessage?.({ data: JSON.stringify({ type, requestId, payload: body }) });
      });
    }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type === MessageType.AUTH_CONNECT) this.reply(MessageType.AUTH_CHALLENGE, message.requestId, { nonce: 'nonce' });
      else if (message.type === MessageType.AUTH_CHALLENGE_RESPONSE) this.reply(MessageType.AUTH_SUCCESS, message.requestId, payload);
      else if (message.type === MessageType.PING) this.reply(MessageType.PONG, message.requestId, {});
      else if (message.type === MessageType.CHAT_LOAD_HISTORY) {
        this.reply(MessageType.CHAT_HISTORY, undefined, { channelId: message.payload.channelId, messages: [] });
      }
    }
    close() {
      if (this.readyState === FixtureSocket.CLOSED) return;
      this.readyState = FixtureSocket.CLOSED;
      queueMicrotask(() => this.onclose?.({}));
    }
  }
  window.WebSocket = FixtureSocket;

  new SettingsSidebarTestApp();
  await until(() => !!document.querySelector('#home-view'), 'Home did not render');
  await openServerSession('a.test', 5601, identity, 'Fixture');
  await until(() => document.querySelectorAll('#members-list-items .member-item').length === members.length
    && document.querySelectorAll('.voice-participant-mini').length === 3, 'the server sidebar did not render');
  // The startup round of the automatic entry has probed the stopped server already.
  await tick(1200);
  const updates = [];
  appEvents.on('settings.updated', update => updates.push(update?.keys ?? null));

  phase = 'R-SHELL-2: volume slider';
  const anaRow = document.querySelector('#members-list-items .member-item[data-user-id="ana"]');
  anaRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 300 }));
  await until(() => !!document.querySelector('#ctx-volume-slider'), 'the volume slider did not open');
  const slider = document.querySelector('#ctx-volume-slider');
  probes.length = 0;
  ptt.length = 0;
  updates.length = 0;
  const heard = [];
  const offVolume = appEvents.on('user_volume.changed', ({ volume }) => heard.push(volume));
  for (let step = 0; step < 30; step++) {
    slider.value = String(60 + step);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(16);
  }
  check(heard.length === 30 && heard.at(-1) === 89, 'every step of the slider is heard at once');
  check(updates.length === 0, `nothing is announced while the slider moves: ${JSON.stringify(updates)}`);
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(500);
  offVolume();
  check(stoppedProbes() === 0, `the stopped server was probed ${stoppedProbes()} times while the volume moved`);
  check(ptt.length === 0, `the push-to-talk hook was called ${ptt.length} times while the volume moved`);
  check(JSON.stringify(updates) === JSON.stringify([['userVolumes']]), `the volume is announced once, as itself: ${JSON.stringify(updates)}`);
  check(JSON.parse(localStorage.getItem('monky_settings')).userVolumes['ana:device'] === 89, 'the volume is saved where the slider stopped');
  (await import('/views/UserContextMenu.ts')).userContextMenu.close();

  phase = 'R-SHELL-2: mute';
  updates.length = 0;
  toggleMicrophoneMute();
  toggleMicrophoneMute();
  await tick(300);
  check(stoppedProbes() === 0 && ptt.length === 0, 'muting neither probes saved servers nor calls the push-to-talk hook');
  check(updates.length === 2 && updates.every(keys => keys && !keys.includes('autoConnectServers') && !keys.includes('pttKey')),
    `a mute announces only itself: ${JSON.stringify(updates)}`);

  phase = 'R-SHELL-2: push-to-talk';
  settingsStore.setInputMode('push_to_talk');
  check(ptt.length === 1 && ptt[0].enabled === true, 'changing the input mode reaches the push-to-talk hook');
  settingsStore.pttKey = { code: 'KeyB', display: 'B', keyType: 'keyboard', keyCode: 48 };
  settingsStore.save();
  check(ptt.length === 2 && ptt[1].key.code === 'KeyB', 'changing the key reaches the push-to-talk hook');
  settingsStore.pttSoundCue = !settingsStore.pttSoundCue;
  settingsStore.save();
  settingsStore.save();
  check(ptt.length === 2, 'other settings, or saving nothing new, never reach the hook');
  settingsStore.setInputMode('voice_activity');
  check(ptt.length === 3 && ptt[2].enabled === false, 'leaving push-to-talk reaches the hook');
  await tick(300);
  check(stoppedProbes() === 0, 'push-to-talk changes never probe saved servers');

  phase = 'R-SHELL-2: automatic connection';
  settingsStore.autoConnectServers = false;
  settingsStore.save();
  await tick(300);
  check(stoppedProbes() === 0, 'turning automatic connection off probes nothing');
  settingsStore.autoConnectServers = true;
  settingsStore.save();
  await until(() => stoppedProbes() === 1, 'turning automatic connection on did not look for the saved servers');
  check(ptt.length === 3, 'automatic connection never reaches the push-to-talk hook');

  phase = 'R-SHELL-11: voice event';
  const roomTwo = document.querySelector('.channel-item[data-channel-id="voice-2"]');
  const roomTwoChat = roomTwo.querySelector('[data-voice-chat-channel="voice-2"]');
  const biaRow = document.querySelector('#members-list-items .member-item[data-user-id="bia"]');
  const biaMini = document.querySelector('.voice-participant-mini[data-session-id="bia:device"]');
  const anaMini = document.querySelector('.voice-participant-mini[data-session-id="ana:device"]');
  roomTwoChat.focus();
  check(document.activeElement === roomTwoChat, 'the room chat button takes keyboard focus');
  participantManager.updateVoiceState(voiceState(members[1], 'voice-1', { isMuted: true }));
  await frame();
  const anaMiniAfter = document.querySelector('.voice-participant-mini[data-session-id="ana:device"]');
  check(anaMiniAfter !== anaMini && !anaMini.querySelector('.audio-state-icon') && !!anaMiniAfter.querySelector('.audio-state-icon'),
    'the person who muted is redrawn, muted');
  check(document.querySelector('.channel-item[data-channel-id="voice-2"]') === roomTwo, 'another room keeps its row');
  check(document.querySelector('.voice-participant-mini[data-session-id="bia:device"]') === biaMini, 'the rest of the room keeps its rows');
  check(document.querySelector('#members-list-items .member-item[data-user-id="bia"]') === biaRow, 'untouched members keep their rows');
  check(document.activeElement === roomTwoChat, 'keyboard focus stays on the room chat button through a voice event');

  phase = 'R-SHELL-11: presence';
  const caioRow = document.querySelector('#members-list-items .member-item[data-user-id="caio"]');
  serverStore.updateMember({ ...members[4], brb: true });
  await frame();
  check(document.querySelector('#members-list-items .member-item[data-user-id="duda"]') !== null
    && document.querySelector('#members-list-items .member-item[data-user-id="caio"]') === caioRow, 'a presence change keeps the other members');
  check(document.activeElement === roomTwoChat, 'keyboard focus stays on the room chat button through a presence event');

  phase = 'R-SHELL-11: failed connection hint';
  participantManager.setPeerConnectionFailed('bia:device', true);
  await frame();
  const failedHint = document.querySelector('.voice-participant-mini[data-session-id="bia:device"] .peer-failed')?.getAttribute('title') ?? '';
  check(failedHint.includes('\n\n') && !failedHint.includes('&#10;'), `the failed connection hint keeps its two paragraphs: ${JSON.stringify(failedHint)}`);
  participantManager.setPeerConnectionFailed('bia:device', false);
  await frame();

  phase = 'R-SHELL-11: folding a category';
  let serverUpdates = 0;
  const offServer = appEvents.on('server.updated', () => { serverUpdates++; });
  const fold = document.querySelector('[data-collapse-category="rooms"]');
  fold.focus();
  fold.click();
  const rooms = document.querySelector('[data-category-channels="rooms"]');
  check(rooms.hidden && fold.getAttribute('aria-expanded') === 'false', 'the category folds');
  check(document.activeElement === fold && fold.isConnected, 'the fold button keeps focus');
  check(serverUpdates === 0, 'folding a category does not redraw the whole server');
  fold.click();
  check(!rooms.hidden && fold.getAttribute('aria-expanded') === 'true', 'the category unfolds');
  offServer();
  return checks;
}
