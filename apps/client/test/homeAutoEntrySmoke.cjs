const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const assert = require('node:assert/strict');
  const { test } = require('node:test');
  test('Home auto-entry, settings synchronization and voice-only previews', { timeout: 150_000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `home-auto-entry-profile-${process.pid}`);
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
      console.error(`Home auto-entry smoke timed out during ${phase}`);
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
        name: 'home-auto-entry-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/home-auto-entry-shared.js') return '\0home-auto-entry-shared';
        },
        load(id) {
          if (id === '\0home-auto-entry-shared') return "export { MessageType, PROTOCOL_VERSION } from '@monky/shared';";
        },
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) {
            return { code: `${code}\nexport { App as HomeTestApp };`, map: null };
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__home_auto_entry__') return next();
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
      show: false, width: 1150, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) console.error(`[renderer:${phase}] ${message}`);
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/__home_auto_entry__`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    phase = 'real startup and authentication';
    await evaluate(`(${setupHomeAutoEntrySmoke.toString()})()`);
    for (const name of ['connections', 'cancellation', 'preferences', 'previews']) {
      phase = name;
      await evaluate(`window.homeAutoEntrySmoke.${name}()`);
    }
    phase = 'native switch keyboard';
    for (const surface of ['home', 'settings']) {
      for (let press = 0; press < 2; press++) {
        await evaluate(`window.homeAutoEntrySmoke.focusSwitch(${JSON.stringify(surface)})`);
        window.focus();
        window.webContents.focus();
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await evaluate('window.homeAutoEntrySmoke.checkKeyboard()');
      }
    }
    phase = 'cleanup';
    const checks = await evaluate('window.homeAutoEntrySmoke.cleanup()');
    console.log(`Home auto-entry smoke: ${checks} checks passed (startup/auth, background routing, cancellation, persistence, settings, voice previews, keyboard, cleanup)`);
    await finish(0);
  }).catch(async error => {
    console.error(`Home auto-entry smoke failed during ${phase}`, error);
    await finish(1);
  });
}

async function setupHomeAutoEntrySmoke() {
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (condition()) return;
      await tick();
    }
    throw new Error(message);
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
  };
  const identity = { clientId: 'fixture-client', publicKey: 'fixture-public-key' };
  const identityGate = deferred();
  let identityCalls = 0;
  const signatures = [];
  const hostsStarted = [];
  const hostListeners = new Set();
  window.api = {
    hasIdentity: async () => identityGate.promise,
    getIdentity: async () => { identityCalls++; return identity; },
    signChallenge: async nonce => { signatures.push(nonce); return `fixture-signature:${nonce}`; },
    getClientLogConfig: async () => ({ enabled: false }),
    hostServerStatus: async () => ({ isRunning: false, port: null, serverId: null }),
    hostServerStart: async options => { hostsStarted.push(options); throw new Error('No real server may be started'); },
    onHostServerStatusChanged: listener => { hostListeners.add(listener); return () => hostListeners.delete(listener); },
    onAppBeforeQuit: () => () => {},
    onTrayToggleMute: () => () => {},
    onTrayToggleDeafen: () => () => {},
    updateTrayVoiceStatus: async () => {},
    setWindowInServer: async () => {},
    stopLanDiscovery: async () => {},
    fitHomeWindowToContent: async () => {},
    setLanguage: async () => {},
    setMinimizeToTray: async () => {},
    signalRendererReady: () => {},
    probeServer: async () => ({ reachable: false, reason: 'refused' }),
    getAppVersion: async () => '0.0.0-fixture',
    writeClientLog: async () => {},
  };
  const saved = (host, port, lastConnected = 1) => ({
    host, port, name: `${host} ${port}`, serverId: `server-${port}`, lastConnected, password: `fixture-password-${port}`,
  });
  const first = saved('first.test', 5101, 2);
  const second = saved('second.test', 5102);
  localStorage.setItem('monky_saved_servers', JSON.stringify([first, second]));
  localStorage.setItem('monky_nickname', 'Fixture');
  localStorage.setItem('monky_avatar', 'data:image/png;base64,fixture');
  localStorage.setItem('monky_settings', JSON.stringify({
    onboardingCompleted: true, autoEntryServerKeys: [JSON.stringify([first.host, first.port]), JSON.stringify([second.host, second.port])],
  }));
  const originalFetch = window.fetch;
  const originalWebSocket = window.WebSocket;
  const originalMedia = navigator.mediaDevices.getUserMedia;
  const originalDevices = navigator.mediaDevices.enumerateDevices;
  window.fetch = async () => new Response(JSON.stringify({ userCount: 9, users: [{ nickname: 'Not in voice' }], voiceUserCount: 0, voiceUsers: [] }));
  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('Auto-entry must never capture media'); };
  const [{ HomeTestApp }, { AutoEntryService }, { sessionManager: sessions, sessionKeyFor }, navigation,
    { connectionStore: connection }, { settingsStore: settings }, { favoritesStore: favorites },
    { serverStore }, { voiceStore: voice }, { audioProcessor: audio }, { webRtcManager: rtc },
    { videoService: video }, { settingsModal }, { appEvents: bus }, { t, setLanguage }, shared] = await Promise.all([
    import('/main.ts'), import('/core/AutoEntryService.ts'), import('/core/SessionManager.ts'),
    import('/core/serverConnection.ts'), import('/stores/connectionStore.ts'), import('/stores/settingsStore.ts'),
    import('/stores/favoritesStore.ts'), import('/stores/serverStore.ts'), import('/stores/voiceStore.ts'),
    import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'), import('/core/VideoService.ts'),
    import('/views/SettingsModal.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
    import('/home-auto-entry-shared.js'),
  ]);
  const { MessageType, PROTOCOL_VERSION } = shared;
  const sockets = [];
  const sent = [];
  const behaviors = new Map();
  const gates = new Map();
  const logicalServerIds = new Map();
  let replaceDuplicateConnections = false;
  const mediaCalls = [];
  const restores = [];
  const replace = (target, name, implementation) => {
    const original = target[name];
    restores.push(() => { target[name] = original; });
    target[name] = implementation;
  };
  for (const [target, prefix, methods] of [
    [audio, 'audio', ['startMicrophone', 'stopMicrophone', 'setMuted', 'setDeafened']],
    [rtc, 'rtc', ['closeAllPeers', 'setCurrentSessionId', 'setIceServers', 'setDeafened', 'setQualityPreset', 'clearLocalScreenTracks']],
    [video, 'video', ['stopCamera', 'stopScreenShare']],
  ]) {
    for (const method of methods) replace(target, method, () => { mediaCalls.push(`${prefix}.${method}`); });
  }
  const payloadFor = port => {
    const user = {
      id: identity.clientId, sessionId: `${identity.clientId}:fixture-device-${port}`, clientId: identity.clientId,
      nickname: 'Fixture', status: 'ONLINE', joinedAt: 1,
    };
    return {
      currentUser: user, voiceRestrictions: { serverMuted: false, serverDeafened: false },
      server: {
        id: logicalServerIds.get(port) ?? `server-${port}`, name: `Server ${port}`, createdAt: 1, maxUsers: 0, voiceMode: 'p2p',
        channels: [{ id: `voice-${port}`, name: 'Voice', type: 'VOICE', position: 0 }],
        members: [user], knownMembers: [user], voiceStates: {},
        roles: [], userRoles: [], ownerId: user.id, myPermissions: 2147483647,
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
        if (this.readyState !== 0) return;
        if (behaviors.get(this.port) === 'unavailable') { this.close(); return; }
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
        if (behaviors.get(this.port) === 'hang') return;
        if (behaviors.get(this.port) === 'password') {
          this.reply(MessageType.AUTH_FAILED, message.requestId, { message: 'Fixture: password rejected' });
          return;
        }
        if (behaviors.get(this.port) === 'protocol') {
          this.reply(MessageType.SERVER_ERROR, message.requestId, {
            code: 'PROTOCOL_VERSION_MISMATCH', message: 'Fixture: incompatible protocol', serverProtocolVersion: PROTOCOL_VERSION + 1,
          });
          return;
        }
        this.reply(MessageType.AUTH_CHALLENGE, message.requestId, { nonce: `nonce-${this.port}` });
      } else if (message.type === MessageType.AUTH_CHALLENGE_RESPONSE) {
        check(message.payload.signature === `fixture-signature:nonce-${this.port}`, 'normal challenge signing is preserved');
        const respond = () => {
          if (this.readyState !== FixtureSocket.OPEN) return;
          const payload = payloadFor(this.port);
          if (replaceDuplicateConnections) {
            for (const socket of sockets) {
              if (socket !== this && socket.readyState === FixtureSocket.OPEN
                && socket.authenticatedServerId === payload.server.id) socket.close();
            }
          }
          this.authenticatedServerId = payload.server.id;
          this.reply(MessageType.AUTH_SUCCESS, message.requestId, payload);
        };
        const gate = gates.get(this.port);
        if (gate) void gate.promise.then(respond);
        else respond();
      } else if (message.type === MessageType.USER_UPDATE_AVATAR) {
        this.reply(MessageType.USER_UPDATE_AVATAR, message.requestId, {});
      } else if (message.type === MessageType.PING) {
        this.reply(MessageType.PONG, message.requestId, {});
      }
    }
    close() {
      if (this.readyState === FixtureSocket.CLOSED) return;
      this.readyState = FixtureSocket.CLOSED;
      queueMicrotask(() => this.onclose?.({}));
    }
  }
  window.WebSocket = FixtureSocket;
  const app = new HomeTestApp();
  const root = document.getElementById('app');
  const rendered = [];
  app.mainView.render = () => {
    const active = sessions.getActive();
    rendered.push(active?.key ?? null);
    root.innerHTML = `<main id="main-center-stage" data-fixture-server="${active?.serverStore.serverDetails?.id ?? ''}"></main>`;
  };
  app.mainView.destroy = () => {};
  app.mainView.rejoinVoiceChannel = async () => { mediaCalls.push('voice.rejoin'); };
  equal(sockets.length, 0, 'startup waits for the saved identity before connecting');
  identityGate.resolve(true);
  await until(() => app.autoEntryService.running !== null, 'renderer did not start automatic entry after prerequisites');
  await app.autoEntryService.start();
  equal(sockets.map(socket => socket.port), [5101, 5102], 'real renderer startup connects each opted-in server once');
  equal(sessions.getActiveKey(), sessionKeyFor(first.host, first.port), 'first startup server remains foreground');
  equal(serverStore.serverDetails?.id, 'server-5101', 'background auth restores the foreground proxy');
  equal(sessions.getAll().map(session => session.serverStore.serverDetails?.id), ['server-5101', 'server-5102'], 'auth payloads stay in their own store');
  equal(rendered, [sessionKeyFor(first.host, first.port)], 'background auth does not redraw Home or steal navigation');
  equal(identityCalls, 1, 'startup reuses the already-loaded identity rather than generating another');
  equal(signatures.length, 2, 'every server uses the existing challenge-response authentication');
  for (const message of sent.filter(message => message.type === MessageType.AUTH_CONNECT)) {
    equal(message.payload.password, `fixture-password-${message.port}`, 'saved server password reaches only its own handshake');
    equal(message.payload.publicKey, identity.publicKey, 'saved identity is preserved');
    equal(message.payload.protocolVersion, PROTOCOL_VERSION, 'normal protocol admission is preserved');
  }
  equal(sent.filter(message => message.type === MessageType.USER_UPDATE_AVATAR).map(message => message.port), [5101, 5102], 'avatars update captured sessions');
  check(!mediaCalls.some(call => call === 'audio.startMicrophone' || call === 'voice.rejoin'), 'startup never starts microphone or rejoins voice');
  check(!sent.some(message => [MessageType.VOICE_JOIN, MessageType.VOICE_RECONNECT].includes(message.type)), 'startup never sends voice admission');
  equal(hostsStarted.length, 0, 'startup never starts a server process');
  const initialSockets = sockets.length;
  sessions.removeAll();
  app.connectionView.render();
  await app.autoEntryService.start();
  equal(sockets.length, initialSockets, 'logout, Home and repeated start do not reconnect');

  const services = [];
  const notices = [];
  const service = timeout => {
    const instance = new AutoEntryService(message => notices.push(message), timeout);
    services.push(instance);
    return instance;
  };
  const reset = (servers, enabled = true) => {
    for (const instance of services) instance.dispose();
    settingsModal.close();
    voice.voiceSessionKey = null;
    voice.currentVoiceChannelId = null;
    sessions.removeAll();
    connection.savedServers = servers;
    connection.createdServers = [];
    connection.savedNickname = 'Fixture';
    connection.setIdentity(identity);
    connection.savedAvatarBase64 = '';
    settings.onboardingCompleted = true;
    settings.autoEntryServerKeys = [];
    if (enabled) for (const server of servers) settings.setServerAutoEntry(server, true);
    settings.save();
    notices.length = 0;
    behaviors.clear();
    gates.clear();
    logicalServerIds.clear();
    replaceDuplicateConnections = false;
    mediaCalls.length = 0;
    localStorage.setItem('monky_saved_servers', JSON.stringify(servers));
  };
  const home = app.connectionView;
  let keyboardInput = null;
  let keyboardPrevious = false;
  window.homeAutoEntrySmoke = {
    async connections() {
      const a = saved('a.test', 5201);
      const b = saved('b.test', 5202);
      reset([a, b], false);
      const baseline = sockets.length;
      await service().start();
      equal(sockets.length, baseline, 'migration/default-off opens no sockets');
      for (const prerequisite of ['identity', 'nickname', 'onboarding']) {
        reset([a]);
        if (prerequisite === 'identity') connection.setIdentity(null);
        if (prerequisite === 'nickname') connection.savedNickname = 'x';
        if (prerequisite === 'onboarding') settings.onboardingCompleted = false;
        await service().start();
        equal(sockets.length, baseline, `missing ${prerequisite} prevents automatic entry`);
        equal(notices.length, 1, 'missing prerequisites leave a Home notice');
      }
      reset([{ ...a, serverId: undefined }]);
      await service().start();
      equal(sockets.length, baseline, 'legacy servers need an authenticated logical identity before automatic entry');
      equal(notices.length, 1, 'legacy identity verification has a manual-entry hint');
      reset([a, b, { ...a, host: 'A.TEST' }]);
      gates.set(b.port, deferred());
      const multi = service();
      const connecting = multi.start();
      await until(() => sockets.some(socket => socket.port === b.port && socket.readyState === FixtureSocket.OPEN), 'second handshake did not start');
      voice.voiceSessionKey = sessions.getActiveKey();
      voice.currentVoiceChannelId = 'voice-5201';
      mediaCalls.length = 0;
      gates.get(b.port).resolve();
      await connecting;
      equal(sockets.slice(baseline).map(socket => socket.port), [a.port, b.port], 'canonical duplicates never create duplicate sessions');
      equal(sessions.getActive()?.port, a.port, 'multiple opted-in servers retain the first foreground server');
      equal(mediaCalls, [], 'background entry never tears down an existing call');
      equal(voice.currentVoiceChannelId, 'voice-5201', 'voice stays on the existing server');
      equal(serverStore.serverDetails?.id, 'server-5201', 'background protocol events do not change active stores');

      reset([a, { ...saved('alias.test', 5203), serverId: a.serverId }]);
      const aliasesStart = sockets.length;
      await service().start();
      equal(sockets.slice(aliasesStart).map(socket => socket.port), [a.port], 'different saved aliases for one authenticated server never create rival sessions');

      reset([{ ...a, serverId: 'previous-server-identity' }, b]);
      await service().start();
      equal(sessions.getAll().map(session => session.port), [b.port], 'unexpected server identity is disconnected before proceeding');
      check(!settings.isServerAutoEntryEnabled(a), 'changed server identity disables the preference');
      equal(connection.savedServers.find(server => server.port === a.port)?.serverId, undefined, 'changed server identity requires fresh manual confirmation');
      equal(notices.length, 1, 'server identity changes are reported');

      for (const failure of ['unavailable', 'password', 'protocol', 'hang']) {
        reset([a, b]);
        connection.createdServers = [{ id: 'owned-fixture', name: 'Owned', port: a.port, createdAt: 1, lastStarted: 0, voiceChannel: 'Voice', textChannel: 'text' }];
        connection.savedServers[0] = { ...a, host: '127.0.0.1' };
        settings.setServerAutoEntry(connection.savedServers[0], true);
        behaviors.set(a.port, failure);
        const before = sockets.length;
        await service(70).start();
        equal(sockets.slice(before).map(socket => socket.port), [a.port, b.port], `${failure}: each endpoint gets one bounded attempt`);
        equal(sessions.getAll().map(session => session.port), [b.port], `${failure}: failed session is removed, next server can enter`);
        equal(sessions.getActive()?.port, b.port, `${failure}: first successful server becomes foreground`);
        equal(notices.length, 1, `${failure}: failure is reported without a retry prompt`);
        window.dispatchEvent(new Event('online'));
        await tick();
        equal(sockets.length - before, 2, `${failure}: no automatic failure/retry storm`);
        equal(hostsStarted.length, 0, `${failure}: owned stopped servers are never started silently`);
      }
      reset([a, b]);
      const existing = sessions.create(a.host, a.port, 'Fixture');
      existing.client.status = 'RECONNECTING';
      sessions.activate(existing.key);
      const before = sockets.length;
      await service().start();
      equal(sockets.slice(before).map(socket => socket.port), [b.port], 'existing reconnect owner is not replaced');
      equal(existing.client.getStatus(), 'RECONNECTING', 'background entry preserves a recovering session');

      reset([a, { ...b, serverId: a.serverId }]);
      const pendingExisting = sessions.create(a.host, a.port, 'Fixture');
      pendingExisting.client.status = 'CONNECTING';
      sessions.activate(pendingExisting.key);
      const aliasesPending = sockets.length;
      await service().start();
      equal(sockets.length, aliasesPending, 'aliases of an existing pending handshake are also skipped');
    },
    async cancellation() {
      const a = saved('cancel-a.test', 5301);
      const b = saved('cancel-b.test', 5302);
      const c = saved('cancel-c.test', 5303);
      reset([a, b, c]);
      gates.set(b.port, deferred());
      const before = sockets.length;
      const queue = service();
      const running = queue.start();
      await until(() => sockets.slice(before).some(socket => socket.port === b.port), 'background cancellation fixture did not connect');
      sessions.removeAll();
      await running;
      gates.get(b.port).resolve();
      await tick();
      equal(sessions.getAll().length, 0, 'logout closes a pending background handshake and all completed sessions');
      equal(sockets.slice(before).map(socket => socket.port), [a.port, b.port], 'logout cancels the remaining startup queue');
      await queue.start();
      home.render();
      equal(sockets.length - before, 2, 'Home does not restart a cancelled queue');

      reset([a, b]);
      gates.set(a.port, deferred());
      const initialCount = sockets.length;
      const initialPending = service().start();
      await until(() => sockets.length > initialCount, 'first pending cancellation fixture did not connect');
      sessions.removeAll();
      await initialPending;
      gates.get(a.port).resolve();
      await tick();
      equal(sockets.length - initialCount, 1, 'logout during the first handshake does not connect later opted-in servers');
      equal(sessions.getAll().length, 0, 'first pending handshake does not leave a ghost session');

      for (const action of ['disable', 'remove']) {
        reset([a, b]);
        gates.set(a.port, deferred());
        const start = sockets.length;
        const pending = service().start();
        await until(() => sockets.length > start, 'pending entry was not created');
        if (action === 'disable') settings.setServerAutoEntry(a, false);
        else connection.removeSavedServer(a.host, a.port);
        await pending;
        gates.get(a.port).resolve();
        await tick();
        equal(sessions.getAll().map(session => session.port), [b.port], `${action}: only the cancelled target is removed`);
        equal(settings.isServerAutoEntryEnabled(a), false, `${action}: preference remains disabled`);
      }

      reset([a, b]);
      gates.set(a.port, deferred());
      const start = sockets.length;
      const automatic = service().start();
      await until(() => sockets.length > start, 'manual takeover fixture did not connect');
      const manual = navigation.openServerSession(a.host, a.port, identity, 'Fixture', a.password);
      gates.get(a.port).resolve();
      await Promise.all([automatic, manual]);
      equal(sockets.slice(start).filter(socket => socket.port === a.port).length, 1, 'manual entry reuses an in-flight automatic handshake');

      for (const firstAuth of ['manual', 'automatic']) {
        reset([a, { ...b, serverId: a.serverId }], false);
        settings.setServerAutoEntry(a, true);
        logicalServerIds.set(b.port, a.serverId);
        replaceDuplicateConnections = true;
        gates.set(a.port, deferred());
        gates.set(b.port, deferred());
        const automatic = service().start();
        await until(() => navigation.getServerSessionForAddress(a.host, a.port)?.client.getStatus() === 'CONNECTING',
          'automatic alias fixture did not start');
        const automaticSession = navigation.getServerSessionForAddress(a.host, a.port);
        const manual = navigation.openServerSession(b.host, b.port, identity, 'Fixture', b.password);
        if (firstAuth === 'manual') {
          gates.get(b.port).resolve();
          await manual;
        }
        gates.get(a.port).resolve();
        await automatic;
        equal(sessions.getAll().map(session => session.port), [b.port],
          `${firstAuth} authenticates first: discard the rival automatic alias`);
        equal(automaticSession.client.getStatus(), 'DISCONNECTED', 'superseded automatic socket is disposed');
        gates.get(b.port).resolve();
        await manual;
        await until(() => navigation.getServerSessionForAddress(b.host, b.port)?.client.getStatus() === 'CONNECTED',
          'manually selected alias did not recover from same-device replacement');
        equal(sessions.getActive()?.port, b.port, 'manual alias remains foreground');
        const settledSocketCount = sockets.length;
        window.dispatchEvent(new Event('online'));
        await tick();
        equal(sockets.length, settledSocketCount, 'disposed automatic alias cannot start another reconnect contest');
        equal(notices.length, 0, 'manual takeover is not an automatic-entry failure');
      }

      reset([a, b]);
      gates.set(a.port, deferred());
      const late = service().start();
      await until(() => navigation.getServerSessionForAddress(a.host, a.port)?.client.getStatus() === 'CONNECTING', 'late navigation fixture not pending');
      await navigation.openServerSession(c.host, c.port, identity, 'Fixture', c.password);
      gates.get(a.port).resolve();
      await late;
      equal(sessions.getActive()?.port, c.port, 'late automatic successes never steal a manual navigation');
      equal(serverStore.serverDetails?.id, `server-${c.port}`, 'manual foreground store survives all background replies');
    },
    async preferences() {
      const a = saved('settings.test', 5401);
      a.name = 'Server " <fixture>';
      const b = saved('other-settings.test', 5402);
      reset([a, b], false);
      home.render();
      const homeInput = () => root.querySelector('[data-server-auto-entry]');
      const inputFor = (container, server) => [...container.querySelectorAll('[data-server-auto-entry]')]
        .find(input => input.dataset.serverAutoEntry === JSON.stringify([server.host, server.port]));
      check(!homeInput().checked, 'Home switch defaults off');
      check(homeInput().closest('.toggle-switch'), 'Home uses an accessible toggle-switch, not a standalone checkbox');
      delete b.serverId;
      home.render();
      check(inputFor(root, b).disabled, 'legacy favorites cannot opt in until a manual connection verifies their identity');
      connection.rememberSavedServerIdentity(b.host, b.port, 'server-5402');
      check(!inputFor(root, b).disabled, 'authenticated server identity unlocks automatic entry without changing other preferences');
      const target = inputFor(root, a);
      target.click();
      equal(home.selectedSavedHost, null, 'using an auto-entry switch never selects/connects its card');
      check(settings.isServerAutoEntryEnabled(a), 'Home toggle persists opt-in');
      const current = localStorage.getItem('monky_settings');
      check(current.includes(JSON.stringify([a.host, a.port]).replaceAll('"', '\\"')), 'stored settings include the canonical server identity');
      await settingsModal.open();
      const modal = document.querySelector('.modal-backdrop--settings');
      check(inputFor(modal, a).checked, 'settings reads the same preference as Home');
      check(modal.querySelectorAll('[data-settings-section="automatic-entry"]').length === 1, 'auto-entry section has a unique navigation id');
      const labels = [...modal.querySelectorAll('[data-settings-section]')].map(section => section.dataset.settingsSection);
      equal(new Set(labels).size, labels.length, 'settings section identifiers remain unique');
      inputFor(modal, a).click();
      check(!target.checked && !settings.isServerAutoEntryEnabled(a), 'settings toggle synchronizes Home immediately');
      target.click();
      check(inputFor(modal, a).checked, 'Home toggle synchronizes an already-open settings panel');
      check(!favorites.isServerFavorite(a), 'automatic entry never changes the independent favorite star');

      const storageSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'monky_settings') throw new Error('Fixture full storage');
        return storageSet.call(this, key, value);
      };
      try {
        inputFor(modal, a).click();
        check(inputFor(modal, a).checked && target.checked, 'failed writes roll both visible switches back');
        check(modal.querySelector('#settings-error-banner').textContent.length > 0, 'failed writes are visible in settings');
      } finally { Storage.prototype.setItem = storageSet; }
      settingsModal.close();
      settings.load();
      home.render();
      check(inputFor(root, a).checked, 'opt-in survives settings rehydration and Home rerender');
      for (const language of ['pt-BR', 'en']) {
        setLanguage(language);
        await settingsModal.open();
        const panel = document.querySelector('.modal-backdrop--settings');
        const section = panel.querySelector('[data-settings-section="automatic-entry"]');
        equal(section.dataset.settingsLabel, t('autoEntry.section'), 'section navigation uses the translated label');
        check(!section.dataset.settingsLabel.startsWith('autoEntry.'), 'automatic-entry catalog keys must be integrated');
        equal(inputFor(panel, a).getAttribute('aria-label'), t('autoEntry.serverLabel', { name: a.name }), 'translated server labels are escaped without losing content');
        check(!section.querySelector('fixture'), 'saved server names cannot inject HTML into settings');
        settingsModal.close();
      }
      home.render();
      const beforeSettings = bus.listeners.get('settings.updated')?.size ?? 0;
      const beforeServers = bus.listeners.get('connection.saved_servers_changed')?.size ?? 0;
      for (let index = 0; index < 3; index++) { await settingsModal.open(); settingsModal.close(); }
      equal(bus.listeners.get('settings.updated')?.size ?? 0, beforeSettings, 'closing settings releases auto-entry settings listeners');
      equal(bus.listeners.get('connection.saved_servers_changed')?.size ?? 0, beforeServers, 'closing settings releases saved-server listeners');
      await settingsModal.open();
      connection.removeSavedServer(b.host, b.port);
      equal(document.querySelectorAll('.modal-backdrop--settings [data-server-auto-entry]').length, 1, 'settings list refreshes when a favorite is deleted elsewhere');
      settingsModal.close();
    },
    async previews() {
      const node = document.createElement('div');
      root.append(node);
      home.renderServerPreview(node, 'preview.test', '5501', {
        userCount: 9, users: [{ nickname: 'Only online' }],
        voiceUserCount: 2, voiceUsers: [{ nickname: 'Voice A' }, { nickname: 'Voice B' }],
        memberCount: 9, maxUsers: 20,
      });
      check(node.textContent.includes(t('connection.voiceUsersCount', { count: 2 })), 'Home count is voice-only');
      equal([...node.querySelectorAll('img')].map(image => image.title), ['Voice A', 'Voice B'], 'only actual voice occupants get avatars');
      check(!node.textContent.includes('Only online'), 'online-only names never leak into voice previews');
      home.renderServerPreview(node, 'preview.test', '5501', {
        voiceUserCount: 0, voiceUsers: [],
        botCompatibility: { protocolVersion: PROTOCOL_VERSION, incompatibleBots: 2, uncheckedBots: 1 },
      });
      const advisory = node.querySelector('.bot-compatibility-warning');
      check(advisory?.getAttribute('role') === 'note', 'bot compatibility is a persistent, non-interactive card advisory');
      check(advisory.textContent.includes(t('connection.botCompatibilityMismatch', { count: 2, protocol: PROTOCOL_VERSION })), 'mismatch advisory names the actual server protocol');
      check(advisory.textContent.includes(t('connection.botCompatibilityUnchecked', { count: 1, protocol: PROTOCOL_VERSION })), 'unverified bots remain distinct from incompatible bots');
      check(node.textContent.includes(t('connection.voiceUsersCount', { count: 0 })), 'bot advisory never changes voice occupancy');
      for (const botCompatibility of [undefined, null, {}, { protocolVersion: PROTOCOL_VERSION, incompatibleBots: -1, uncheckedBots: 2 },
        { protocolVersion: PROTOCOL_VERSION, incompatibleBots: 0, uncheckedBots: 0 }]) {
        home.renderServerPreview(node, 'preview.test', '5501', { voiceUserCount: 0, voiceUsers: [], botCompatibility });
        check(!node.querySelector('.bot-compatibility-warning'), 'absent, malformed or cleared summaries do not leave a stale warning');
      }
      home.renderServerPreview(node, 'preview.test', '5501', { userCount: 9, users: [{ nickname: 'Only online' }] });
      check(node.textContent.includes(t('connection.voicePreviewUnavailable')), 'older endpoints show unknown voice occupancy rather than online users');
      equal(node.querySelectorAll('img').length, 0, 'older endpoints never show online avatars as voice occupants');
      home.renderServerPreview(node, 'preview.test', '5501', { voiceUserCount: 0, voiceUsers: [{ nickname: 'Stale' }] });
      equal(node.querySelectorAll('img').length, 0, 'zero occupancy discards stale preview avatars');
      home.renderServerPreview(node, 'preview.test', '5501', {
        voiceUserCount: 1, voiceUsers: [{ nickname: '"><fixture>', avatarUrl: 'data:image/png;base64,broken" onerror="window.fixtureInjected=1' }],
      });
      check(!node.querySelector('fixture') && !node.querySelector('img').hasAttribute('onerror'), 'preview data cannot inject attributes or markup');
      node.remove();
      let aborted = 0;
      window.fetch = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { aborted++; reject(new DOMException('Fixture abort', 'AbortError')); }, { once: true });
      });
      home.render();
      home.render();
      home.suspend();
      await tick();
      check(aborted >= 2, 'rerender and leaving Home abort stale preview requests');
      equal(home.previewControllers.size, 0, 'preview requests are released after leaving Home');
      window.fetch = async () => new Response('{}', { status: 503 });
      home.render();
    },
    async focusSwitch(surface) {
      if (surface === 'settings' && !document.querySelector('.modal-backdrop--settings')) await settingsModal.open();
      if (surface === 'home') settingsModal.close();
      const container = surface === 'home' ? root : document.querySelector('.modal-backdrop--settings');
      keyboardInput = container.querySelector('[data-server-auto-entry]');
      keyboardPrevious = keyboardInput.checked;
      keyboardInput.scrollIntoView({ block: 'center', behavior: 'instant' });
      keyboardInput.focus();
      check(document.activeElement === keyboardInput, `${surface}: switch is keyboard focusable`);
    },
    async checkKeyboard() {
      await tick();
      equal(keyboardInput.checked, !keyboardPrevious, 'native Space toggles the focused switch');
      const address = JSON.parse(keyboardInput.dataset.serverAutoEntry);
      equal(settings.isServerAutoEntryEnabled({ host: address[0], port: address[1] }), !keyboardPrevious, 'keyboard change persists');
      equal(home.selectedSavedHost, null, 'keyboard toggles do not navigate the Home card');
    },
    cleanup() {
      for (const instance of services) instance.dispose();
      settingsModal.close();
      sessions.removeAll();
      home.dispose();
      equal(hostListeners.size, 0, 'disposing Home removes the hosted-server status listener');
      equal(home.previewControllers.size, 0, 'disposing Home clears outstanding previews');
      equal(hostsStarted.length, 0, 'no test or automatic entry started a real server');
      check(!sent.some(message => [MessageType.VOICE_JOIN, MessageType.VOICE_RECONNECT].includes(message.type)), 'no automatic path ever joined voice');
      for (const restore of restores.reverse()) restore();
      window.WebSocket = originalWebSocket;
      window.fetch = originalFetch;
      navigator.mediaDevices.getUserMedia = originalMedia;
      navigator.mediaDevices.enumerateDevices = originalDevices;
      bus.clear();
      return checks;
    },
  };
}
