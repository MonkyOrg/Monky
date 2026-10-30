const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

// Shell navigation in real Chromium, driven through the whole app: hanging up
// from the sidebar row or the tray never paints the stage over the chat (or
// revives a destroyed stage at Home), background servers neither close menus
// nor redraw the rail for nothing, a connection coming or going in the
// background keeps the DM being written on Home, and the rail keeps probing
// saved servers. A second page then lets the rail's own timer drive automatic
// connections that fail: a refusal is not repeated until the saved password
// changes, other failures (a server with no room among them) wait longer each
// time, and none of them touches what is on screen or the automatic entry
// still under way.
if (!process.versions.electron) {
  const assert = require('node:assert/strict');
  const { test } = require('node:test');
  test('shell navigation keeps the chat, menus and DM drafts across call and background changes', { timeout: 150_000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `shell-navigation-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SHELL_NAVIGATION_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_SHELL_NAVIGATION_PROFILE);
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
      console.error('Shell navigation smoke timed out');
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
        name: 'shell-navigation-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/shell-navigation-shared.js') return '\0shell-navigation-shared';
        },
        load(id) {
          if (id === '\0shell-navigation-shared') return "export { MessageType, PROTOCOL_VERSION } from '@monky/shared';";
        },
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) {
            return { code: `${code}\nexport { App as ShellTestApp };`, map: null };
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__shell_navigation__') return next();
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
    await window.loadURL(`http://127.0.0.1:${address.port}/__shell_navigation__`);
    const checks = await window.webContents.executeJavaScript(`(${shellNavigationSmoke.toString()})()`, true);
    console.log(`Shell navigation smoke: ${checks} checks passed`);
    await window.loadURL(`http://127.0.0.1:${address.port}/__shell_navigation__`);
    const automatic = await window.webContents.executeJavaScript(`(${automaticConnectionSmoke.toString()})()`, true);
    console.log(`Automatic connection smoke: ${automatic} checks passed`);
    await finish(0);
  }).catch(async error => {
    console.error('Shell navigation smoke failed', error);
    await finish(1);
  });
}

async function shellNavigationSmoke() {
  let checks = 0;
  let phase = 'startup';
  const check = (condition, message) => {
    if (!condition) throw new Error(`[${phase}] ${message}`);
    checks++;
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (condition()) return;
      await tick();
    }
    throw new Error(`[${phase}] ${message}`);
  };
  const settle = async () => {
    for (let attempt = 0; attempt < 5; attempt++) await tick();
  };

  const identity = { clientId: 'fixture-client', publicKey: 'fixture-public-key' };
  const sockets = [];
  const sent = [];
  let trayLeave = null;
  const unsubscribe = () => () => {};

  // One friend with a short conversation, enough to write a DM on Home.
  const me = 'f'.repeat(64);
  const peer = 'a'.repeat(64);
  const now = Date.now();
  const ok = value => Promise.resolve({ ok: true, value });
  const dmHandlers = {
    snapshot: () => ok({
      me: { publicKey: me },
      peers: [{ publicKey: peer, nickname: 'Amigo', avatar: null, relation: 'friend', blocked: false, friendSince: 1,
        requestedAt: null, maxFileBytes: 50 * 1024 * 1024 }],
      conversations: [{ peer, lastMessageAt: now, lastMessagePreview: 'oi', lastMessageAuthor: peer, unread: 0, hidden: false, readOnly: false }],
      settings: { maxFileBytes: 50 * 1024 * 1024 },
    }),
    conversation: () => ok({ peer, hasMore: false, peerReadAt: 0, messages: [{
      id: 'hello', peer, author: peer, content: 'oi', createdAt: now - 60_000, editedAt: null, deleted: false,
      replyTo: null, reactions: [], attachments: [], delivery: null,
    }] }),
    pendingPeers: () => ok([]),
    onEvent: () => () => {},
  };
  window.api = {
    getIdentityStatus: async () => ({ state: 'ready' }),
    getIdentity: async () => identity,
    signChallenge: async nonce => `fixture-signature:${nonce}`,
    getClientLogConfig: async () => ({ enabled: false }),
    writeClientLog: async () => {},
    onAppBeforeQuit: unsubscribe,
    onTrayToggleMute: unsubscribe,
    onTrayToggleDeafen: unsubscribe,
    onTrayLeaveCall: listener => { trayLeave = listener; return () => { trayLeave = null; }; },
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
    dm: new Proxy({}, { get: (_target, name) => dmHandlers[name] ?? (() => ok({})) }),
  };

  const saved = (host, port) => ({ host, port, name: host, lastConnected: port, password: '' });
  localStorage.clear();
  localStorage.setItem('monky_saved_servers', JSON.stringify([
    saved('a.test', 5401), saved('b.test', 5402), saved('c.test', 5403), saved('d.test', 5404),
  ]));
  localStorage.setItem('monky_nickname', 'Fixture');
  localStorage.setItem('monky_avatar', 'data:image/png;base64,fixture');
  localStorage.setItem('monky_settings', JSON.stringify({
    onboardingCompleted: true, autoConnectServers: true, autoEntryServerKeys: [],
    chatMessageSoundEnabled: true, chatMessageSoundMentionsOnly: false,
  }));
  // Servers answer the HTTP probe only while listed here, so automatic
  // connections stay off until a phase asks for one.
  const reachable = new Set();
  window.fetch = async url => {
    const { hostname } = new URL(String(url));
    if (!reachable.has(hostname)) throw new Error('offline fixture');
    return new Response(JSON.stringify({ name: hostname }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  // A server that is up but turns every connection away.
  const refusedPorts = new Set([5404]);
  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('The shell smoke never captures media'); };

  const [{ ShellTestApp }, { sessionManager }, { openServerSession }, { voiceStore }, { appEvents }, { serverRailView },
    { connectionStore }, shared] = await Promise.all([
    import('/main.ts'), import('/core/SessionManager.ts'), import('/core/serverConnection.ts'),
    import('/stores/voiceStore.ts'), import('/core/EventBus.ts'), import('/views/ServerRailView.ts'),
    import('/stores/connectionStore.ts'), import('/shell-navigation-shared.js'),
  ]);
  const { MessageType, PROTOCOL_VERSION } = shared;
  const payloadFor = port => {
    const user = {
      id: identity.clientId, sessionId: `${identity.clientId}:device-${port}`, clientId: identity.clientId,
      nickname: 'Fixture', status: 'ONLINE', joinedAt: 1,
    };
    return {
      currentUser: user,
      voiceRestrictions: { serverMuted: false, serverDeafened: false },
      server: {
        id: `server-${port}`, name: `Server ${port}`, createdAt: 1, maxUsers: 0, voiceMode: 'p2p',
        channels: [
          { id: `text-${port}`, name: 'general', type: 'TEXT', position: 0, createdAt: 1 },
          { id: `voice-${port}`, name: `Voice ${port}`, type: 'VOICE', position: 1, createdAt: 2 },
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
    push(type, payload, requestId) {
      if (this.readyState === FixtureSocket.OPEN) this.onmessage?.({ data: JSON.stringify({ type, requestId, payload }) });
    }
    reply(type, requestId, payload) {
      queueMicrotask(() => this.push(type, payload, requestId));
    }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push({ ...message, port: this.port });
      if (message.type === MessageType.AUTH_CONNECT) {
        if (refusedPorts.has(this.port)) {
          this.close();
          return;
        }
        this.reply(MessageType.AUTH_CHALLENGE, message.requestId, { nonce: `nonce-${this.port}` });
      } else if (message.type === MessageType.AUTH_CHALLENGE_RESPONSE) {
        this.reply(MessageType.AUTH_SUCCESS, message.requestId, payloadFor(this.port));
      } else if (message.type === MessageType.PING) {
        this.reply(MessageType.PONG, message.requestId, {});
      } else if (message.type === MessageType.CHAT_LOAD_HISTORY) {
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
  const socketOf = port => sockets.filter(socket => socket.port === port).at(-1);
  const sessionOn = port => sessionManager.getAll().find(session => session.port === port);
  const openMenu = () => document.querySelector('.floating-context-menu:not([data-ui-closing])');
  const closeMenu = async () => {
    (await import('/views/ContextMenu.ts')).contextMenu.close();
  };
  let messageNumber = 0;
  const chatFrom = (port, content = 'mensagem de fundo') => socketOf(port).push(MessageType.CHAT_MESSAGE, {
    id: `background-${++messageNumber}`, channelId: `text-${port}`, userId: 'someone-else', userNickname: 'Outra pessoa',
    content, createdAt: Date.now(),
  });
  const leaves = port => sent.filter(message => message.type === MessageType.VOICE_LEAVE && message.port === port);

  new ShellTestApp();
  await until(() => !!document.querySelector('#home-view'), 'Home did not render');

  phase = 'R-SHELL-4: DM on Home';
  appEvents.emit('dm.open', peer);
  await until(() => !!document.querySelector('#dm-conversation-root #chat-message-input'), 'the DM conversation did not open');
  const conversation = document.querySelector('#dm-conversation-root');
  const input = document.querySelector('#chat-message-input');
  const draft = 'texto que não pode sumir';
  input.focus();
  input.value = draft;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const files = new DataTransfer();
  files.items.add(new File(['anexo'], 'anexo.txt', { type: 'text/plain' }));
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: files, bubbles: true, cancelable: true }));
  await until(() => document.querySelectorAll('#chat-attachment-tray [data-dm-unstage]').length === 1, 'the attachment was not staged');
  const dmIntact = () => document.querySelector('#dm-conversation-root') === conversation
    && document.querySelector('#chat-message-input') === input && input.value === draft
    && document.querySelectorAll('#chat-attachment-tray [data-dm-unstage]').length === 1;

  await openServerSession('c.test', 5403, identity, 'Fixture', undefined, { background: true });
  await until(() => document.querySelector('.server-rail-avatar[data-port="5403"] .server-rail-status-dot')?.dataset.status === 'online',
    'the rail did not show the background connection');
  check(sessionManager.isHome(), 'a background connection keeps Home on screen');
  check(dmIntact(), 'a background connection keeps the DM, its text and its attachment');
  sessionManager.remove(sessionOn(5403).key);
  await settle();
  check(document.querySelector('.server-rail-avatar[data-port="5403"] .server-rail-status-dot')?.dataset.status !== 'online',
    'the rail shows the server is gone');
  check(dmIntact(), 'a background server going away keeps the DM, its text and its attachment');

  phase = 'R-SHELL-3: background servers and menus';
  await openServerSession('a.test', 5401, identity, 'Fixture');
  await until(() => !!document.querySelector('#chat-messages-feed') && !!document.querySelector('#main-user-status-dot'),
    'the server chat did not open');
  await openServerSession('b.test', 5402, identity, 'Fixture', undefined, { background: true });
  await until(() => document.querySelector('.server-rail-avatar[data-port="5402"] .server-rail-status-dot')?.dataset.status === 'online',
    'the rail did not show the second server');
  // Settle what the periodic probe shows, so a round during the count changes nothing.
  await serverRailView.refreshServerRailStatuses();
  await settle();
  const rail = document.querySelector('#server-rail');
  let railRebuilds = 0;
  new MutationObserver(records => { railRebuilds += records.length; }).observe(rail, { childList: true });
  let backgroundActivity = 0;
  appEvents.on('session.background_activity', () => { backgroundActivity++; });

  document.querySelector('#main-user-status-dot').click();
  await until(() => !!openMenu(), 'the status menu did not open');
  const statusMenu = openMenu();
  chatFrom(5402);
  await settle();
  check(document.querySelector('[data-port="5402"] .server-rail-badge')?.dataset.kind === 'unread', 'the background message shows its badge');
  check(backgroundActivity === 1 && railRebuilds > 0, 'the new badge redraws the rail once');
  check(openMenu() === statusMenu, 'a background message does not close a menu opened outside the rail');
  railRebuilds = 0;
  for (let index = 0; index < 10; index++) chatFrom(5402);
  await settle();
  check(backgroundActivity === 1 && railRebuilds === 0, `messages that change no badge do not redraw the rail (${backgroundActivity}, ${railRebuilds})`);
  check(openMenu() === statusMenu, 'the menu outside the rail stays open through ten background messages');
  await closeMenu();

  const avatar = document.querySelector('.server-rail-avatar[data-port="5402"]');
  avatar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 36, clientY: 200 }));
  await until(() => !!openMenu(), 'the rail menu did not open');
  chatFrom(5402, '@Fixture olha isso');
  await settle();
  check(document.querySelector('[data-port="5402"] .server-rail-badge')?.dataset.kind === 'mention', 'a mention turns the badge red');
  check(!openMenu(), 'a menu opened from the rail closes when the rail is rebuilt under it');

  phase = 'R-SHELL-1: hanging up from outside the stage';
  const chatShown = () => !!document.querySelector('#main-center-stage #chat-messages-feed')
    && !document.querySelector('.voice-stage-container');
  const session = sessionOn(5401);
  const background = sessionOn(5402);
  check(chatShown(), 'the chat is on screen before the call');

  voiceStore.setChannel('voice-5401', session.key);
  await until(() => !!document.querySelector('#sidebar-btn-leave-voice'), 'the call row did not appear');
  document.querySelector('#sidebar-btn-leave-voice').click();
  await settle();
  check(voiceStore.currentVoiceChannelId === null && leaves(5401).length === 1, 'the sidebar row ends the call on its server');
  check(chatShown(), 'hanging up from the sidebar keeps the chat instead of painting the stage over it');

  voiceStore.setChannel('voice-5401', session.key);
  await until(() => !!document.querySelector('#sidebar-btn-leave-voice'), 'the call row did not come back');
  check(typeof trayLeave === 'function', 'the tray action is wired');
  trayLeave();
  await settle();
  check(voiceStore.currentVoiceChannelId === null && leaves(5401).length === 2, 'the tray ends the call');
  check(chatShown(), 'hanging up from the tray keeps the chat');

  voiceStore.setChannel('voice-5402', background.key);
  await until(() => !!document.querySelector('#sidebar-btn-leave-voice'), 'the call row of the other server did not appear');
  trayLeave();
  await settle();
  check(voiceStore.currentVoiceChannelId === null && leaves(5402).length === 1, 'leaving a call on another server talks to that server');
  check(chatShown(), 'no stage of another server\'s room is painted over this chat');

  voiceStore.setChannel('voice-5401', session.key);
  appEvents.emit('screen_pip.return_to_call', { sessionKey: session.key, channelId: 'voice-5401' });
  await until(() => !!document.querySelector('.voice-stage-container #stage-btn-leave'), 'the stage of the call did not open');
  document.querySelector('#sidebar-btn-leave-voice').click();
  await until(() => !!document.querySelector('.voice-stage-container #stage-btn-join'), 'the stage on screen did not drop its call controls');
  check(!document.querySelector('#stage-btn-leave') && voiceStore.currentVoiceChannelId === null,
    'the stage on screen shows the room without the call');

  phase = 'R-SHELL-3: a background server dropping';
  document.querySelector(`.channel-item[data-channel-id="text-5401"]`)?.click();
  await until(chatShown, 'the chat did not come back');
  document.querySelector('#main-user-status-dot').click();
  await until(() => !!openMenu(), 'the status menu did not reopen');
  const menuBeforeDrop = openMenu();
  background.client.disconnect();
  await settle();
  check(!sessionOn(5402), 'the dropped background server is gone');
  check(openMenu() === menuBeforeDrop, 'a background server dropping does not close the menu on screen');
  await closeMenu();

  phase = 'R-SHELL-1: hanging up at Home';
  document.querySelector('#server-rail-home').click();
  await until(() => !!document.querySelector('#home-view'), 'Home did not come back');
  voiceStore.setChannel('voice-5401', session.key);
  await settle();
  // The stage listens to participants while it is mounted; at Home there is none.
  const stageListeners = () => appEvents.listeners.get('participants.updated')?.size ?? 0;
  const before = stageListeners();
  trayLeave();
  await settle();
  check(voiceStore.currentVoiceChannelId === null && leaves(5401).length === 4, 'the tray ends the call from Home');
  check(stageListeners() === before, `hanging up at Home revives no destroyed stage (${before} → ${stageListeners()})`);
  check(!!document.querySelector('#home-view') && !document.querySelector('.voice-stage-container'), 'Home stays on screen');

  phase = 'review: the rail keeps probing saved servers';
  const statusOf = port => document.querySelector(`.server-rail-avatar[data-port="${port}"] .server-rail-status-dot`)?.dataset.status;
  const attemptsOn = port => sockets.filter(socket => socket.port === port).length;
  reachable.add('d.test');
  await serverRailView.refreshServerRailStatuses();
  check(statusOf(5404) === 'online', 'a saved server that answers the probe shows online');
  await until(() => attemptsOn(5404) >= 1 && !sessionOn(5404), 'the probe did not start the automatic connection, or it did not fail');
  await settle();
  check(statusOf(5404) === 'online', 'the failed connection leaves the server shown as it was probed');
  await serverRailView.refreshServerRailStatuses();
  await settle();
  check(attemptsOn(5404) === 1, 'a failed automatic connection waits before the next attempt instead of taking every round');
  reachable.delete('d.test');
  const probedAvatar = document.querySelector('.server-rail-avatar[data-port="5404"]');
  probedAvatar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 36, clientY: 260 }));
  await until(() => !!openMenu(), 'the rail menu of the probed server did not open');
  const probedMenu = openMenu();
  await serverRailView.refreshServerRailStatuses();
  check(statusOf(5404) === 'offline', 'a server that goes down after an online probe shows offline');
  check(openMenu() === probedMenu && probedAvatar.isConnected,
    'a probe answer paints the status in place, keeping the rail and the menu opened from it');
  await closeMenu();
  const probedServer = connectionStore.findSavedServer({ host: 'd.test', port: 5404 });
  connectionStore.removeSavedServer('d.test', 5404);
  connectionStore.addSavedServer(probedServer);
  check(statusOf(5404) === 'checking', 'a server removed and saved again starts over from checking, not from its last probe');
  return checks;
}

async function automaticConnectionSmoke() {
  let checks = 0;
  let phase = 'startup';
  const check = (condition, message) => {
    if (!condition) throw new Error(`[${phase}] ${message}`);
    checks++;
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));
  const until = async (condition, message, timeoutMs = 5000) => {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
      if (condition()) return;
      await tick();
    }
    throw new Error(`[${phase}] ${message}`);
  };
  const settle = async () => {
    for (let attempt = 0; attempt < 5; attempt++) await tick();
  };

  const identity = { clientId: 'fixture-client', publicKey: 'fixture-public-key' };
  const unsubscribe = () => () => {};
  const ok = value => Promise.resolve({ ok: true, value });
  const dmHandlers = {
    snapshot: () => ok({ me: { publicKey: 'f'.repeat(64) }, peers: [], conversations: [], settings: { maxFileBytes: 50 * 1024 * 1024 } }),
    pendingPeers: () => ok([]),
    onEvent: () => () => {},
  };
  window.api = {
    getIdentityStatus: async () => ({ state: 'ready' }),
    getIdentity: async () => identity,
    signChallenge: async nonce => `fixture-signature:${nonce}`,
    getClientLogConfig: async () => ({ enabled: false }),
    writeClientLog: async () => {},
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
    dm: new Proxy({}, { get: (_target, name) => dmHandlers[name] ?? (() => ok({})) }),
  };

  // s.test enters on its own at startup and waits there until released; p.test
  // turns down the saved password; t.test drops every sign-in, as a server
  // still starting up would; f.test has no room, and answers the signed
  // challenge as full until a step makes room, as a server does at its member
  // limit or at the identity's device limit.
  const saved = (host, port, extra) => ({ host, port, name: host, lastConnected: port, password: '', ...extra });
  localStorage.clear();
  localStorage.setItem('monky_saved_servers', JSON.stringify([
    saved('s.test', 5501, { serverId: 'server-5501' }), saved('p.test', 5502, { password: 'senha antiga' }), saved('t.test', 5503),
    saved('f.test', 5504),
  ]));
  localStorage.setItem('monky_nickname', 'Fixture');
  localStorage.setItem('monky_avatar', 'data:image/png;base64,fixture');
  localStorage.setItem('monky_settings', JSON.stringify({
    onboardingCompleted: true, autoConnectServers: true, autoEntryServerKeys: [JSON.stringify(['s.test', 5501])],
  }));
  const reachable = new Set();
  const probes = [];
  window.fetch = async url => {
    const { hostname } = new URL(String(url));
    probes.push(hostname);
    if (!reachable.has(hostname)) throw new Error('offline fixture');
    return new Response(JSON.stringify({ name: hostname }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('The automatic connection smoke never captures media'); };

  const [{ ShellTestApp }, { sessionManager }, { openServerSession }, { AutoEntryService }, { serverRailView },
    { categoryModal }, { appEvents }, { connectionStore }, shared] = await Promise.all([
    import('/main.ts'), import('/core/SessionManager.ts'), import('/core/serverConnection.ts'),
    import('/core/AutoEntryService.ts'), import('/views/ServerRailView.ts'), import('/views/CategoryModal.ts'),
    import('/core/EventBus.ts'), import('/stores/connectionStore.ts'), import('/shell-navigation-shared.js'),
  ]);
  const { MessageType, PROTOCOL_VERSION } = shared;
  // The waits are shortened, not faked: rounds still come from the rail's own
  // timer (at most one a second) and attempts from the service's own schedule.
  serverRailView.constructor.PROBE_INTERVAL_MS = 100;
  AutoEntryService.RETRY_DELAYS_MS = [1000, 3000];

  const payloadFor = port => {
    const user = {
      id: identity.clientId, sessionId: `${identity.clientId}:device-${port}`, clientId: identity.clientId,
      nickname: 'Fixture', status: 'ONLINE', joinedAt: 1,
    };
    return {
      currentUser: user,
      voiceRestrictions: { serverMuted: false, serverDeafened: false },
      server: {
        id: `server-${port}`, name: `Server ${port}`, createdAt: 1, maxUsers: 0, voiceMode: 'p2p',
        channels: [{ id: `text-${port}`, name: 'general', type: 'TEXT', position: 0, createdAt: 1 }],
        members: [user], knownMembers: [user], voiceStates: {}, roles: [], userRoles: [],
        ownerId: user.id, myPermissions: 2147483647, protocol: { version: PROTOCOL_VERSION, features: [] },
      },
    };
  };
  const sockets = [];
  const droppingPorts = new Set([5503]);
  const fullPorts = new Set([5504]);
  let releaseStartup = null;
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
      this.port = Number(new URL(url).port);
      this.openedAt = Date.now();
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
      if (message.type === MessageType.AUTH_CONNECT) {
        const challenge = () => this.reply(MessageType.AUTH_CHALLENGE, message.requestId, { nonce: `nonce-${this.port}` });
        if (this.port === 5501 && !releaseStartup) releaseStartup = challenge;
        else if (this.port === 5502 && message.payload.password !== 'senha nova') {
          this.reply(MessageType.SERVER_ERROR, message.requestId, { code: 'AUTH_INVALID_PASSWORD', message: 'Senha do servidor incorreta.' });
        } else if (droppingPorts.has(this.port)) this.close();
        else challenge();
      } else if (message.type === MessageType.AUTH_CHALLENGE_RESPONSE) {
        if (fullPorts.has(this.port)) {
          this.reply(MessageType.SERVER_ERROR, message.requestId, {
            code: 'SERVER_FULL', message: 'Você já está conectado em 3 dispositivos. Desconecte um deles para entrar deste.',
          });
        } else this.reply(MessageType.AUTH_SUCCESS, message.requestId, payloadFor(this.port));
      } else if (message.type === MessageType.PING) {
        this.reply(MessageType.PONG, message.requestId, {});
      } else if (message.type === MessageType.CHAT_LOAD_HISTORY) {
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
  const attemptsOn = port => sockets.filter(socket => socket.port === port);
  const sessionOn = port => sessionManager.getAll().find(session => session.port === port);
  const openMenu = () => document.querySelector('.floating-context-menu:not([data-ui-closing])');

  const app = new ShellTestApp();
  const autoEntry = app.autoEntryService;

  phase = 'a refusal in the background while the automatic entry waits';
  await until(() => !!releaseStartup, 'the automatic entry did not start');
  reachable.add('p.test');
  await until(() => attemptsOn(5502).length === 1 && !sessionOn(5502), 'the probe did not try the refusing server, or it was not refused');
  await settle();
  check(!autoEntry.cancelled && autoEntry.listenersInstalled,
    'a refusal elsewhere neither cancels the automatic entry nor drops its background listeners');
  check(sessionOn(5501)?.client.getStatus() === 'CONNECTING', 'the automatic entry is still waiting for its server');
  releaseStartup();
  await until(() => sessionOn(5501)?.client.getStatus() === 'CONNECTED' && !sessionManager.isHome()
    && !!document.querySelector('#chat-messages-feed'), 'the automatic entry did not finish');
  check(sessionManager.getActiveKey() === sessionOn(5501).key, 'the automatic entry puts its server on screen');

  phase = 'failures in the background with a dialog open';
  categoryModal.open();
  const name = document.querySelector('#input-category-name');
  const dialog = document.querySelector('.category-modal');
  check(!!name && !!dialog, 'the category dialog opened');
  name.value = 'Categoria em edição';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  reachable.add('t.test');
  reachable.add('f.test');
  await until(() => attemptsOn(5503).length === 1 && !sessionOn(5503) && attemptsOn(5504).length === 1 && !sessionOn(5504),
    'the probe did not try the failing servers, or they did not fail');
  await settle();
  check(dialog.isConnected && !dialog.closest('[data-ui-closing]') && name.value === 'Categoria em edição',
    'failed attempts in the background keep the dialog open with what was typed');
  categoryModal.close();

  phase = 'a failure in the background at Home with nothing connected';
  const startup = sessionOn(5501);
  appEvents.emit('connection.manual_disconnect', { key: startup.key });
  startup.client.disconnect();
  await until(() => sessionManager.isHome() && !!document.querySelector('#home-view')
    && !sessionManager.getAll().some(session => session.client.getStatus() === 'CONNECTED'), 'leaving the only server did not return Home');
  const avatar = document.querySelector('.server-rail-avatar[data-port="5502"]');
  avatar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 36, clientY: 200 }));
  await until(() => !!openMenu(), 'the rail menu did not open');
  const menu = openMenu();
  const before = attemptsOn(5503).length;
  await until(() => attemptsOn(5503).length > before && !sessionOn(5503), 'the failing server was not tried again', 8000);
  await settle();
  check(openMenu() === menu && avatar.isConnected, 'a failed attempt with nothing connected keeps the menu open');
  (await import('/views/ContextMenu.ts')).contextMenu.close();

  phase = 'failures that may pass wait longer each time';
  await until(() => attemptsOn(5503).length >= 3 && attemptsOn(5504).length >= 3, 'the failing servers were not tried a third time', 8000);
  for (const [port, failure] of [[5503, 'a dropped sign-in'], [5504, 'a server with no room']]) {
    const [first, second, third] = attemptsOn(port).map(socket => socket.openedAt);
    check(second - first >= 1000 && third - second >= 3000,
      `${failure} is tried again, each wait following the schedule and growing (${second - first} ms, then ${third - second} ms)`);
  }

  phase = 'a server with no room is entered once it has room';
  const fullAttempts = attemptsOn(5504).length;
  fullPorts.delete(5504);
  await until(() => sessionOn(5504)?.client.getStatus() === 'CONNECTED', 'the server was not entered once it had room', 8000);
  check(attemptsOn(5504).length === fullAttempts + 1, 'the next scheduled attempt signs in, with nothing changed in the app');
  check(!autoEntry.failedAttempts.has(sessionOn(5504).key), 'signing in forgets the failures');

  phase = 'a refusal waits for another password';
  check(probes.filter(host => host === 'p.test').length >= 5, 'the rail kept probing on its own timer');
  check(attemptsOn(5502).length === 1, 'the refused server was not tried again on any of those rounds');
  connectionStore.updateSavedServer('p.test', 5502, { ...connectionStore.findSavedServer({ host: 'p.test', port: 5502 }), password: 'senha nova' });
  await until(() => sessionOn(5502)?.client.getStatus() === 'CONNECTED', 'a new password did not bring the refused server back', 4000);
  check(attemptsOn(5502).length === 2, 'the new password is tried once, and signs in');

  phase = 'a sign-in that works clears the failures';
  droppingPorts.delete(5503);
  // An automatic attempt the server already turned away must end before entering by hand.
  await until(() => sessionOn(5503)?.client.getStatus() !== 'CONNECTING', 'an attempt on the failing server did not end');
  await openServerSession('t.test', 5503, identity, 'Fixture');
  check(!autoEntry.failedAttempts.has(sessionOn(5503).key), 'entering by hand forgets what the failed attempts concluded');
  return checks;
}
