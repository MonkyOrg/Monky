const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const assert = require('node:assert/strict');
  const { test } = require('node:test');
  test('Discord-style Home, add-server rail modal and background auto-connect', { timeout: 150_000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `home-discord-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_HOME_AUTO_ENTRY_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_HOME_AUTO_ENTRY_PROFILE);
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
      console.error(`Home Discord smoke timed out during ${phase}`);
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
        name: 'home-discord-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/home-discord-shared.js') return '\0home-discord-shared';
        },
        load(id) {
          if (id === '\0home-discord-shared') return "export { MessageType, Permission, PROTOCOL_VERSION } from '@monky/shared';";
        },
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) {
            return { code: `${code}\nexport { App as HomeTestApp };`, map: null };
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__home_discord__') return next();
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
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) console.error(`[renderer:${phase}] ${message}`);
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/__home_discord__`);
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    phase = 'renderer smoke';
    const checks = await evaluate(`(${setupHomeDiscordSmoke.toString()})()`);
    console.log(`Home Discord smoke: ${checks} checks passed`);
    phase = 'first launch guide';
    await window.loadURL(`http://127.0.0.1:${address.port}/__home_discord__`);
    const guideChecks = await evaluate(`(${setupFirstLaunchGuideSmoke.toString()})()`);
    console.log(`First launch guide smoke: ${guideChecks} checks passed`);
    await finish(0);
  }).catch(async error => {
    console.error(`Home Discord smoke failed during ${phase}`, error);
    await finish(1);
  });
}

async function setupHomeDiscordSmoke() {
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  const tick = () => new Promise(resolve => setTimeout(resolve, 25));
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await tick();
    }
    throw new Error(message);
  };

  const identity = { clientId: 'fixture-client', publicKey: 'fixture-public-key' };
  const signatures = [];
  const sockets = [];
  const sent = [];
  const lanFoundListeners = new Set();
  const lanLostListeners = new Set();
  const hostStatusListeners = new Set();
  const startedHosts = [];
  const saved = (host, port, lastConnected = 1) => ({
    host, port, name: `${host} ${port}`, serverId: `server-${port}`, lastConnected, password: `fixture-password-${port}`,
  });
  const first = saved('first.test', 5101, 2);
  const second = saved('second.test', 5102, 1);

  window.api = {
    hasIdentity: async () => true,
    getIdentity: async () => identity,
    signChallenge: async nonce => { signatures.push(nonce); return `fixture-signature:${nonce}`; },
    getClientLogConfig: async () => ({ enabled: false }),
    writeClientLog: async () => {},
    onAppBeforeQuit: () => () => {},
    onTrayToggleMute: () => () => {},
    onTrayToggleDeafen: () => () => {},
    updateTrayVoiceStatus: async () => {},
    setWindowInServer: async () => {},
    stopLanDiscovery: async () => {},
    startLanDiscovery: async () => {},
    onLanDiscoveryFound: listener => { lanFoundListeners.add(listener); return () => lanFoundListeners.delete(listener); },
    onLanDiscoveryLost: listener => { lanLostListeners.add(listener); return () => lanLostListeners.delete(listener); },
    hostServerStatus: async () => ({ isRunning: false, port: null, serverId: null }),
    hostServerStart: async options => { startedHosts.push(options); return { success: true }; },
    hostServerStop: async () => ({ success: true }),
    hostServerDeleteData: async () => ({ success: true }),
    onHostServerStatusChanged: listener => { hostStatusListeners.add(listener); return () => hostStatusListeners.delete(listener); },
    setLanguage: async () => {},
    setMinimizeToTray: async () => {},
    signalRendererReady: () => {},
    maximize: async () => {},
    getAppVersion: async () => '0.0.0-fixture',
    openExternal: async () => {},
  };

  localStorage.setItem('monky_saved_servers', JSON.stringify([first, second]));
  localStorage.setItem('monky_nickname', 'Fixture');
  localStorage.setItem('monky_avatar', 'data:image/png;base64,fixture');
  localStorage.setItem('monky_settings', JSON.stringify({
    onboardingCompleted: true,
    autoConnectServers: false,
    autoEntryServerKeys: [],
  }));
  window.fetch = async url => {
    const text = String(url);
    if (text.includes('offline.test')) throw new Error('offline');
    return new Response(JSON.stringify({ name: 'Preview', userCount: 1, voiceUserCount: 0, users: [], voiceUsers: [] }), { status: 200 });
  };
  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('Home smoke must not capture media'); };

  const [{ HomeTestApp }, { sessionManager: sessions, sessionKeyFor }, { settingsStore: settings },
    { connectionStore: connection }, { serverRailView }, shared] = await Promise.all([
    import('/main.ts'), import('/core/SessionManager.ts'), import('/stores/settingsStore.ts'),
    import('/stores/connectionStore.ts'), import('/views/ServerRailView.ts'), import('/home-discord-shared.js'),
  ]);
  const { MessageType, PROTOCOL_VERSION } = shared;
  const payloadFor = port => {
    const user = {
      id: identity.clientId, sessionId: `${identity.clientId}:fixture-device-${port}`, clientId: identity.clientId,
      nickname: 'Fixture', status: 'ONLINE', joinedAt: 1,
    };
    return {
      currentUser: user,
      voiceRestrictions: { serverMuted: false, serverDeafened: false },
      server: {
        id: `server-${port}`, name: `Server ${port}`, createdAt: 1, maxUsers: 0, voiceMode: 'p2p',
        channels: [
          { id: `text-${port}`, name: 'general', type: 'TEXT', position: 0, createdAt: 1 },
          { id: `voice-${port}`, name: 'Voice', type: 'VOICE', position: 1, createdAt: 2 },
        ],
        members: [user], knownMembers: [user], voiceStates: {}, roles: [], userRoles: [],
        ownerId: user.id, myPermissions: 2147483647, protocol: { version: PROTOCOL_VERSION, features: [] },
      },
    };
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
    constructor(url) {
      this.url = url;
      this.port = Number(new URL(url).port);
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = FixtureSocket.OPEN;
        this.onopen?.({});
      });
    }
    reply(type, requestId, payload) {
      queueMicrotask(() => {
        if (this.readyState === FixtureSocket.OPEN) this.onmessage?.({ data: JSON.stringify({ type, requestId, payload }) });
      });
    }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push({ ...message, port: this.port });
      if (message.type === MessageType.AUTH_CONNECT) {
        this.reply(MessageType.AUTH_CHALLENGE, message.requestId, { nonce: `nonce-${this.port}` });
      } else if (message.type === MessageType.AUTH_CHALLENGE_RESPONSE) {
        this.reply(MessageType.AUTH_SUCCESS, message.requestId, payloadFor(this.port));
      } else if (message.type === MessageType.USER_UPDATE_AVATAR || message.type === MessageType.PING) {
        this.reply(message.type === MessageType.PING ? MessageType.PONG : message.type, message.requestId, {});
      }
    }
    close() {
      if (this.readyState === FixtureSocket.CLOSED) return;
      this.readyState = FixtureSocket.CLOSED;
      queueMicrotask(() => this.onclose?.({}));
    }
  }
  window.WebSocket = FixtureSocket;

  new HomeTestApp();
  await until(() => !!document.querySelector('#home-view'), 'Home shell did not render');
  check(document.querySelector('#server-rail-home')?.getAttribute('aria-current') === 'page', 'Home rail button is selected');
  check(!!document.querySelector('#home-dm-list .home-dm-empty'), 'DM list renders its empty state');
  check([...document.querySelectorAll('.friends-tab')].map(node => node.textContent).join(' ').includes('Disponível')
    || [...document.querySelectorAll('.friends-tab')].map(node => node.textContent).join(' ').includes('Available'), 'Friends tabs render');
  check(!document.querySelector('.members-sidebar'), 'Home does not render the members sidebar');
  check(!!document.querySelector('#server-rail-add.server-rail-add'), 'Rail plus button is rendered at the end of the list');
  await new Promise(resolve => setTimeout(resolve, 150));
  equal(sockets.length, 0, 'autoConnectServers=false prevents background startup connections');

  settings.autoConnectServers = true;
  settings.save();
  await until(() => sockets.length === 2, 'background auto-connect did not open every saved server');
  equal(sockets.map(socket => socket.port).sort(), [5101, 5102], 'background auto-connect opens all rail servers');
  check(sessions.isHome(), 'background auto-connect keeps Home focused');
  check(signatures.length === 2, 'background connections authenticate with the saved identity');

  document.querySelector('#server-rail-add').click();
  await until(() => !!document.querySelector('#add-server-modal'), 'plus modal did not open');
  check(!!document.querySelector('#add-server-option-create'), 'plus modal offers server creation');
  check(!!document.querySelector('#add-server-option-join'), 'plus modal offers joining a server');
  document.querySelector('#add-server-option-create').click();
  await until(() => !!document.querySelector('#add-server-create-form'), 'create form did not render');
  check(!!document.querySelector('#add-server-open-tutorials'), 'create flow exposes hosting tutorials');
  check(!!document.querySelector('#add-server-name') && !!document.querySelector('#add-server-local-port'), 'create form has server name and port');
  document.querySelector('#add-server-create-back').click();
  await until(() => !!document.querySelector('#add-server-option-join'), 'choice screen did not return');
  document.querySelector('#add-server-option-join').click();
  await until(() => !!document.querySelector('#add-server-join-form'), 'join form did not render');
  check(!!document.querySelector('#add-server-invite') && !!document.querySelector('#add-server-lan-section'), 'join flow has invite paste and LAN discovery');
  for (const listener of lanFoundListeners) listener({ host: '192.168.0.25', port: 3210, serverName: 'LAN Fixture', version: 'test' });
  await until(() => document.querySelector('#add-server-lan-section')?.textContent.includes('LAN Fixture'), 'LAN result did not render');
  document.querySelector('#add-server-close').click();

  connection.saveCreatedServer({
    id: 'owned-fixture', name: 'Owned Fixture', port: 5200, password: 'pw',
    textChannel: 'geral', voiceChannel: 'Geral', createdAt: Date.now(), lastStarted: Date.now(), voiceMode: 'p2p',
  });
  serverRailView.render();
  const ownedButton = document.querySelector('.server-rail-avatar[data-port="5200"]');
  check(!!ownedButton, 'created local server appears in the rail');
  ownedButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
  await until(() => !!document.querySelector('.floating-context-menu'), 'owned server context menu did not open');
  const menuText = document.querySelector('.floating-context-menu').textContent;
  for (const label of ['Iniciar', 'Parar', 'Excluir'].some(label => menuText.includes(label))
    ? ['Iniciar', 'Parar', 'Monitor', 'Excluir']
    : ['Start', 'Stop', 'Monitor', 'Delete']) {
    check(menuText.includes(label), `owned server context menu includes ${label}`);
  }

  equal(startedHosts.length, 0, 'background auto-connect did not start stopped hosted servers');
  await until(() => sent.some(message => message.type === MessageType.USER_UPDATE_AVATAR), 'background sessions did not receive the global avatar');
  check(true, 'background sessions receive the global avatar');

  // Logout: red button at the bottom of Settings, confirmation with export, and a full account wipe.
  const logoutCalls = [];
  let logoutResult = { success: false, error: 'disk busy' };
  window.api.logOut = async () => { logoutCalls.push(sessions.getAll().length); return logoutResult; };
  window.api.exportIdentity = async () => ({ success: true, code: 'fixture-code' });
  localStorage.setItem('monky_language', 'pt-BR');
  localStorage.setItem('monky.categories.collapsed.server-5101', '["c1"]');
  settings.selectedMicrophoneId = 'fixture-mic';
  settings.autoEntryServerKeys = ['first.test:5101'];
  settings.save();
  let stableKeys = '';
  for (let stableTicks = 0; stableTicks < 8;) {
    await tick();
    const keys = sessions.getAll().map(session => session.key).join(',');
    stableTicks = keys === stableKeys ? stableTicks + 1 : 0;
    stableKeys = keys;
  }
  const sessionsBeforeLogout = sessions.getAll().length;
  const sessionKeysBeforeLogout = sessions.getAll().map(session => session.key ?? session.id);
  check(sessionsBeforeLogout >= 2, 'logout scenario starts connected to the saved servers');
  const { settingsModal } = await import('/views/SettingsModal.ts');
  await settingsModal.open();
  const sidebar = document.querySelector('.settings-sidebar');
  const logoutButton = document.querySelector('#settings-logout-btn');
  check(!!logoutButton && sidebar.lastElementChild === logoutButton, 'logout is the last item of the settings sidebar');
  check(!logoutButton.classList.contains('settings-tab-btn') && !logoutButton.dataset.tab, 'logout button is not a settings tab');
  check(getComputedStyle(logoutButton).color === getComputedStyle(document.documentElement).getPropertyValue('--danger').trim()
    || getComputedStyle(logoutButton).color.startsWith('rgb(2'), `logout button is red (${getComputedStyle(logoutButton).color})`);
  const sidebarRect = sidebar.getBoundingClientRect();
  check(sidebarRect.bottom - logoutButton.getBoundingClientRect().bottom < 40, 'logout button is pinned to the bottom of the sidebar');

  logoutButton.click();
  await until(() => !!document.querySelector('.logout-dialog'), 'logout confirmation did not open');
  check(!!document.querySelector('#logout-dialog-export') && !!document.querySelector('#logout-dialog-cancel')
    && document.querySelector('#logout-dialog-confirm')?.classList.contains('btn-danger'), 'logout dialog offers export, cancel and a red confirm');
  document.querySelector('#logout-dialog-export').click();
  await until(() => !!document.querySelector('#identity-export-password'), 'export-first did not open the identity export dialog');
  const exportBackdrop = document.querySelector('#identity-export-password').closest('.modal-backdrop');
  check(Number(exportBackdrop.style.zIndex) > Number(document.querySelector('.logout-dialog').closest('.modal-backdrop').style.zIndex),
    'identity export opens above the logout confirmation');
  exportBackdrop.querySelector('[data-action="cancel"]').click();
  await until(() => !document.querySelector('#identity-export-password'), 'identity export dialog did not close');
  document.querySelector('#logout-dialog-cancel').click();
  await until(() => !document.querySelector('.logout-dialog'), 'cancel did not close the logout dialog');
  equal(logoutCalls.length, 0, 'cancel never logs out');
  equal(sessions.getAll().map(session => session.key ?? session.id), sessionKeysBeforeLogout, 'cancel keeps the server sessions');

  logoutButton.click();
  await until(() => !!document.querySelector('.logout-dialog'), 'logout confirmation did not reopen');
  document.querySelector('#logout-dialog-confirm').click();
  await until(() => document.querySelector('#logout-dialog-error')?.classList.contains('show'), 'logout failure was not shown');
  check(document.querySelector('#logout-dialog-error').textContent.includes('disk busy')
    && !document.querySelector('#logout-dialog-confirm').disabled, 'a failed logout shows the error and allows retrying');
  logoutResult = { success: true };
  document.querySelector('#logout-dialog-confirm').click();
  await until(() => logoutCalls.length === 2, 'retrying logout did not call the main process');
  equal(logoutCalls, [0, 0], 'every server session is closed before the main process deletes the identity');
  check(document.querySelector('#logout-dialog-confirm').disabled, 'the dialog stays locked while Monky relaunches');
  for (const key of ['monky_saved_servers', 'monky_created_servers', 'monky_nickname', 'monky_avatar', 'monky_rail_layout',
    'monky.categories.collapsed.server-5101']) {
    check(localStorage.getItem(key) === null, `logout removes ${key}`);
  }
  equal(connection.savedServers.length, 0, 'logout forgets the saved servers and their passwords');
  equal(connection.createdServers.length, 0, 'logout forgets the created servers list');
  const storedSettings = JSON.parse(localStorage.getItem('monky_settings'));
  check(storedSettings.onboardingCompleted === false && storedSettings.autoEntryServerKeys.length === 0,
    'logout resets the guide and per-server auto-entry');
  check(storedSettings.selectedMicrophoneId === 'fixture-mic' && localStorage.getItem('monky_language') === 'pt-BR',
    'logout keeps device preferences such as audio and language');
  document.querySelector('.logout-dialog').closest('.modal-backdrop').remove();
  settingsModal.close();
  return checks;
}

/** A brand-new profile lands on Home with the guide open; startup connections wait for it. */
async function setupFirstLaunchGuideSmoke() {
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const tick = () => new Promise(resolve => setTimeout(resolve, 25));
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await tick();
    }
    throw new Error(message);
  };
  const sockets = [];
  const unsubscribe = () => () => {};
  window.api = {
    hasIdentity: async () => true,
    getIdentity: async () => ({ clientId: 'fixture-client', publicKey: 'fixture-public-key' }),
    signChallenge: async nonce => `fixture-signature:${nonce}`,
    getClientLogConfig: async () => ({ enabled: false }),
    writeClientLog: async () => {},
    onAppBeforeQuit: unsubscribe,
    onTrayToggleMute: unsubscribe,
    onTrayToggleDeafen: unsubscribe,
    updateTrayVoiceStatus: async () => {},
    setWindowInServer: async () => {},
    stopLanDiscovery: async () => {},
    startLanDiscovery: async () => {},
    onLanDiscoveryFound: unsubscribe,
    onLanDiscoveryLost: unsubscribe,
    hostServerStatus: async () => ({ isRunning: false, port: null, serverId: null }),
    hostServerStart: async () => ({ success: true }),
    hostServerStop: async () => ({ success: true }),
    hostServerDeleteData: async () => ({ success: true }),
    onHostServerStatusChanged: unsubscribe,
    setLanguage: async () => {},
    setMinimizeToTray: async () => {},
    signalRendererReady: () => {},
    maximize: async () => {},
    getAppVersion: async () => '0.0.0-fixture',
    openExternal: async () => {},
  };
  localStorage.clear();
  localStorage.setItem('monky_saved_servers', JSON.stringify([{
    host: 'first.test', port: 5101, name: 'First', serverId: 'server-5101', lastConnected: 1, password: '',
  }]));
  localStorage.setItem('monky_nickname', 'Fixture');
  localStorage.setItem('monky_settings', JSON.stringify({ autoConnectServers: true, autoEntryServerKeys: [] }));
  window.fetch = async () => new Response(JSON.stringify({ name: 'Preview', userCount: 1, voiceUserCount: 0, users: [], voiceUsers: [] }), { status: 200 });
  window.WebSocket = class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    constructor(url) { if (new URL(url).hostname === 'first.test') sockets.push(url); }
    send() {}
    close() { this.readyState = 3; }
  };
  navigator.mediaDevices.enumerateDevices = async () => [];

  const [{ HomeTestApp }, { settingsStore: settings }] = await Promise.all([
    import('/main.ts'), import('/stores/settingsStore.ts'),
  ]);
  new HomeTestApp();
  await until(() => !!document.querySelector('#home-view'), 'Home shell did not render');
  await until(() => !!document.querySelector('#add-server-modal .onboarding-card #onboarding-next'), 'guide did not open for a new profile');
  const guideModal = document.querySelector('#add-server-modal');
  const guideCard = guideModal.querySelector('.modal-card');
  check(settings.onboardingCompleted !== true, 'the guide is still pending while it is open');
  await new Promise(resolve => setTimeout(resolve, 150));
  check(sockets.length === 0, 'startup connections wait until the guide closes');

  document.querySelector('#onboarding-next').click();
  await until(() => !!document.querySelector('#onboarding-join'), 'guide did not advance to the join/create choice');
  document.querySelector('#onboarding-join').click();
  await until(() => !!document.querySelector('#add-server-join-form'), 'choosing join in the guide did not open the join form');
  check(document.querySelector('#add-server-modal') === guideModal && guideModal.querySelector('.modal-card') === guideCard
    && !guideModal.hasAttribute('data-ui-closing'), 'the join form continues in the guide modal instead of opening another');
  check(settings.onboardingCompleted === true, 'finishing the guide marks it as completed');
  await until(() => sockets.length === 1, 'startup connections did not resume after the guide');
  check(true, 'startup connections resume after the guide');

  document.querySelector('#add-server-join-back').click();
  await until(() => !!document.querySelector('#add-server-option-create'), 'join form did not return to the choice screen');
  document.querySelector('#add-server-option-create').click();
  await until(() => !!document.querySelector('#add-server-open-tutorials'), 'create form did not render');
  const card = document.querySelector('#add-server-modal .add-server-card');
  const name = document.querySelector('#add-server-name');
  name.value = 'Servidor digitado';
  document.querySelector('#add-server-open-tutorials').click();
  await until(() => !!document.querySelector('#onboarding-back') && !card.querySelector('[data-ui-closing]'), 'hosting tutorials did not open');
  check(document.querySelector('#add-server-modal .modal-card') === card && document.querySelectorAll('.modal-backdrop').length === 1,
    'hosting tutorials open inside the add-server card');
  check(!document.querySelector('#onboarding-welcome-title, #onboarding-next'), 'hosting tutorials skip the guide welcome');
  document.querySelector('#onboarding-back').click();
  await until(() => !document.querySelector('#onboarding-back') && !card.querySelector('[data-ui-closing]'), 'Back did not close the hosting tutorials');
  check(!!document.querySelector('#add-server-create-form') && card.classList.contains('add-server-card')
    && !document.querySelector('#add-server-modal').inert, 'Back from hosting tutorials returns to the create-server form');
  check(document.querySelector('#add-server-name') === name && name.value === 'Servidor digitado',
    'the create form keeps what was typed while the tutorials were open');
  return checks;
}
