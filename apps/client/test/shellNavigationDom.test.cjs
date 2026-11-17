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
  test('shell navigation keeps the chat, menus and DM drafts across call and background changes', { timeout: 330_000 }, async () => {
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
    }, 300_000);
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
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/footerControls.css"></head><body><div id="app"></div></body></html>');
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
    await window.webContents.executeJavaScript(`import('/stores/settingsStore.ts').then(({settingsStore}) => {
      settingsStore.setSidebarHidden('navigation', true); settingsStore.setSidebarHidden('members', true);
    })`, true);
    window.webContents.debugger.attach('1.3');
    const { emulateViewport } = require('./mobileViewport.cjs');
    for (const [width, height, mobile = width <= 960] of [
      [320, 568], [390, 844], [600, 500], [768, 1024], [844, 390], [874, 300], [390, 340],
      [960, 700], [961, 700], [1280, 900], [1032, 1376, true], [1376, 1032, true],
      [1024, 768, true], [1440, 900, true], [1441, 900, true],
    ]) {
      await emulateViewport(window.webContents, width, height, { mobile });
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: width === 768 ? 'reduce' : 'no-preference' }],
      });
      const responsive = await window.webContents.executeJavaScript(`(${responsiveShellSmoke.toString()})(${width}, ${height}, ${mobile})`, true);
      console.log(`Responsive shell ${width}x${height}: ${responsive} checks passed`);
      if (process.env.MONKY_RESPONSIVE_SCREENSHOTS && width === 390 && height === 844) {
        const directory = process.env.MONKY_RESPONSIVE_SCREENSHOTS;
        fs.mkdirSync(directory, { recursive: true });
        for (const screen of ['dm', 'navigation', 'settings']) {
          await window.webContents.executeJavaScript(`(async () => {
            ${screen === 'dm' ? `const input = document.querySelector('#chat-message-input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));` : ''}
            ${screen === 'navigation' ? `document.querySelector('[data-compact-back]').click();` : ''}
            ${screen === 'settings' ? `await (await import('/views/SettingsModal.ts')).settingsModal.open();` : ''}
            await document.fonts.ready;
            await Promise.allSettled(document.getAnimations().filter(animation =>
              animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
          })()`, true);
          fs.writeFileSync(path.join(directory, `responsive-${screen}.png`), (await window.webContents.capturePage()).toPNG());
        }
        await window.webContents.executeJavaScript(`import('/views/SettingsModal.ts').then(({settingsModal}) => settingsModal.close())`, true);
        await window.webContents.executeJavaScript(`Promise.allSettled(document.getAnimations().filter(animation =>
          animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))`, true);
        await window.webContents.executeJavaScript(`document.querySelector('[data-dm-open]').click()`, true);
        await window.webContents.executeJavaScript(`const input = document.querySelector('#chat-message-input');
          input.value = 'draft across viewport changes'; input.dispatchEvent(new Event('input', {bubbles:true}));`, true);
      }
    }
    // Turning the phone with settings open keeps the chosen category in both layouts.
    const settingsState = () => window.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const card = document.querySelector('.settings-modal-card');
      const shown = element => !!element && element.checkVisibility() && element.getClientRects().length > 0;
      return { tab: card.querySelector('.settings-tab-btn[aria-current="page"]')?.dataset.tab,
        sidebar: shown(card.querySelector('.settings-sidebar')), main: shown(card.querySelector('.settings-main-container')),
        inert: card.querySelector('.settings-main-container').inert, back: shown(card.querySelector('.compact-settings-back')) };
    })()`, true);
    const turn = async (width, height) => {
      await emulateViewport(window.webContents, width, height, { mobile: true });
      return settingsState();
    };
    const sameState = (actual, expected, message) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
      }
    };
    await emulateViewport(window.webContents, 844, 390, { mobile: true });
    const chosen = await window.webContents.executeJavaScript(`(async () => {
      await (await import('/views/SettingsModal.ts')).settingsModal.open();
      const tab = document.querySelectorAll('.settings-modal-card .settings-tab-btn')[1];
      tab.click();
      return tab.dataset.tab;
    })()`, true);
    sameState(await turn(390, 844), { tab: chosen, sidebar: false, main: true, inert: false, back: true },
      'a category chosen on its side opens as its own page upright');
    await window.webContents.executeJavaScript(`document.querySelector('.compact-settings-back').click()`, true);
    await window.webContents.executeJavaScript(`(async () => {
      while (document.documentElement.hasAttribute('data-compact-transition')
        || !document.querySelector('.settings-modal-card .settings-main-container').inert) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    })()`, true);
    const index = await settingsState();
    if (!index.sidebar || !index.inert) throw new Error(`Back did not restore the upright settings index: ${JSON.stringify(index)}`);
    sameState(await turn(844, 390), { ...index, main: true, inert: false, back: false },
      'the upright index turns into categories beside their content');
    await window.webContents.executeJavaScript(`document.querySelectorAll('.settings-modal-card .settings-tab-btn')[1].click()`, true);
    await turn(390, 844);
    sameState(await turn(844, 390), { tab: chosen, sidebar: true, main: true, inert: false, back: false },
      'an upright page turns back into the same category beside the index');
    await window.webContents.executeJavaScript(`import('/views/SettingsModal.ts').then(({settingsModal}) => settingsModal.close())`, true);
    console.log('Settings rotation: 4 checks passed');
    if (process.env.MONKY_RESPONSIVE_SCREENSHOTS) {
      await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
      });
      for (const screen of ['server-navigation', 'channel', 'call', 'call-options', 'settings-detail']) {
        await window.webContents.executeJavaScript(`(async () => {
          const {sessionManager} = await import('/core/SessionManager.ts');
          const {voiceStore} = await import('/stores/voiceStore.ts');
          const {appEvents} = await import('/core/EventBus.ts');
          const session = sessionManager.getAll().find(entry => entry.port === 5401);
          ${screen === 'server-navigation' ? `sessionManager.activate(session.key); document.querySelector('[data-compact-back]').click();` : ''}
          ${screen === 'channel' ? `document.querySelector('.channel-item[data-channel-type="TEXT"]').click();` : ''}
          ${screen === 'call' ? `voiceStore.setChannel('voice-5401', session.key);
            appEvents.emit('screen_pip.return_to_call', {sessionKey:session.key,channelId:'voice-5401'});` : ''}
          ${screen === 'call-options' ? `document.querySelector('[data-compact-call-options]').click();` : ''}
          ${screen === 'settings-detail' ? `document.querySelector('.compact-call-sheet [data-modal-close]').click();
            await (await import('/views/SettingsModal.ts')).settingsModal.open('voice_video');` : ''}
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.allSettled(document.getAnimations().filter(animation =>
            animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
        })()`, true);
        fs.writeFileSync(path.join(process.env.MONKY_RESPONSIVE_SCREENSHOTS, `responsive-${screen}.png`),
          (await window.webContents.capturePage()).toPNG());
      }
      await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    }
    // iOS keeps :hover on the tile last touched; a hover that grows the tile pushed its border out of the clipped strip.
    await emulateViewport(window.webContents, 390, 844, { mobile: true });
    await window.webContents.executeJavaScript(`(async () => {
      const {sessionManager} = await import('/core/SessionManager.ts');
      const {voiceStore} = await import('/stores/voiceStore.ts');
      const {appEvents} = await import('/core/EventBus.ts');
      const session = sessionManager.getAll().find(entry => entry.port === 5401);
      sessionManager.activate(session.key);
      voiceStore.setChannel('voice-5401', session.key);
      appEvents.emit('screen_pip.return_to_call', {sessionKey:session.key,channelId:'voice-5401'});
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (let tries = 0; !document.querySelector('.stage-focused-strip > .stage-mini-card'); tries++) {
        if (tries > 300) throw new Error('No participant was left in the strip beside the focused one');
        document.querySelector('.stage-grid > .stage-card')?.click();
        await frame();
      }
    })()`, true);
    const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await window.webContents.debugger.sendCommand('DOM.querySelectorAll', {
      nodeId: root.nodeId, selector: '.stage-focused-strip > .stage-mini-card',
    });
    await window.webContents.debugger.sendCommand('CSS.enable');
    for (const nodeId of nodeIds) {
      await window.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    }
    const hovered = await window.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.allSettled(document.getAnimations().filter(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
      const strip = document.querySelector('.stage-focused-strip').getBoundingClientRect();
      return [...document.querySelectorAll('.stage-focused-strip > .stage-mini-card')].map(card => {
        const box = card.getBoundingClientRect();
        return { hover: card.matches(':hover'), inside: box.left >= strip.left - 0.5 && box.right <= strip.right + 0.5,
          box: [box.left, box.right], strip: [strip.left, strip.right] };
      });
    })()`, true);
    if (!hovered.length || hovered.some(card => !card.hover || !card.inside)) {
      throw new Error(`A touched participant tile overflows the clipped strip of a portrait call: ${JSON.stringify(hovered)}`);
    }
    await window.webContents.debugger.sendCommand('CSS.disable');
    console.log(`Touched stage tiles: ${hovered.length} checks passed`);
    window.webContents.debugger.detach();
    await window.loadURL(`http://127.0.0.1:${address.port}/__shell_navigation__`);
    const automatic = await window.webContents.executeJavaScript(`(${automaticConnectionSmoke.toString()})()`, true);
    console.log(`Automatic connection smoke: ${automatic} checks passed`);
    await finish(0);
  }).catch(async error => {
    if (process.env.MONKY_RESPONSIVE_SCREENSHOTS && window && !window.isDestroyed()) {
      fs.writeFileSync(path.join(process.env.MONKY_RESPONSIVE_SCREENSHOTS, 'responsive-failure.png'),
        (await window.webContents.capturePage()).toPNG());
    }
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
    signChallenge: async nonce => ({ signature: `fixture-signature:${nonce}` }),
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
    { connectionStore }, { settingsStore }, shared] = await Promise.all([
    import('/main.ts'), import('/core/SessionManager.ts'), import('/core/serverConnection.ts'),
    import('/stores/voiceStore.ts'), import('/core/EventBus.ts'), import('/views/ServerRailView.ts'),
    import('/stores/connectionStore.ts'), import('/stores/settingsStore.ts'), import('/shell-navigation-shared.js'),
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
          { id: `forum-${port}`, name: 'Discussions', type: 'FORUM', position: 2, createdAt: 3 },
          { id: `post-${port}`, name: 'A discussion with a long title', type: 'TEXT', forumId: `forum-${port}`, position: 3, createdAt: 4 },
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
        this.reply(MessageType.AUTH_CHALLENGE, message.requestId, { nonce: String(this.port).padStart(64, '0') });
      } else if (message.type === MessageType.AUTH_CHALLENGE_RESPONSE) {
        this.reply(MessageType.AUTH_SUCCESS, message.requestId, payloadFor(this.port));
      } else if (message.type === MessageType.PING) {
        this.reply(MessageType.PONG, message.requestId, {});
      } else if (message.type === MessageType.CHAT_LOAD_HISTORY) {
        this.reply(MessageType.CHAT_HISTORY, undefined, { channelId: message.payload.channelId, messages: [
          { id: 'mobile-welcome', channelId: message.payload.channelId, userId: identity.clientId,
            userNickname: 'Fixture', content: 'Olá! Este é um servidor de demonstração.', createdAt: Date.now() - 60000 },
          { id: 'mobile-message', channelId: message.payload.channelId, userId: 'demo-peer',
            userNickname: 'Pessoa de exemplo', content: 'Podemos continuar a conversa por aqui e depois entrar na chamada.',
            createdAt: Date.now() - 30000 },
        ] });
      } else if (message.type === MessageType.COMMUNITY_GET) {
        this.reply(MessageType.COMMUNITY_SNAPSHOT, message.requestId, {
          settings: { eventsEnabled: true, bannerUrl: null }, events: [],
          liveActions: [1, 2].map(index => ({
            id: `mobile-action-${index}`, channelId: `text-${this.port}`,
            botId: 'fixture-bot', creatorUserId: identity.clientId,
            title: `A responsive live action with a long title that must not cover its close button ${index}`,
            description: '', imageUrls: [],
            expiresAt: Date.now() + 600000, createdAt: Date.now(), revision: 0,
            content: { kind: 'form', form: { title: 'A response', fields: [
              { type: 'text', name: 'answer', label: 'Answer' },
            ] } },
          })),
        });
      } else if (message.type === MessageType.FORUM_LIST) {
        this.reply(MessageType.FORUM_LIST_RESULT, message.requestId, {
          channelId: message.payload.channelId, posts: [{
            channelId: `post-${this.port}`, forumId: `forum-${this.port}`, title: 'A discussion with a long title',
            authorId: identity.clientId, preview: 'A responsive forum discussion',
            createdAt: Date.now(), updatedAt: Date.now(), pinned: false, locked: false, closed: false,
          }], hasMore: false, nextOffset: 1,
        });
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
  await until(() => document.querySelectorAll('#chat-attachment-tray [data-tray-remove]').length === 1, 'the attachment was not staged');
  const dmIntact = () => document.querySelector('#dm-conversation-root') === conversation
    && document.querySelector('#chat-message-input') === input && input.value === draft
    && document.querySelectorAll('#chat-attachment-tray [data-tray-remove]').length === 1;

  await openServerSession('c.test', 5403, identity, 'Fixture', undefined, { background: true });
  await until(() => document.querySelector('.server-rail-avatar[data-port="5403"] .server-rail-status-dot')?.dataset.status === 'online',
    'the rail did not show the background connection');
  check(connectionStore.findSavedServer({ host: 'c.test', port: 5403 })?.name === 'Server 5403',
    'a sign-in gives the saved entry the name the server has now, in the background too (#85)');
  check(sessionManager.isHome(), 'a background connection keeps Home on screen');
  check(dmIntact(), 'a background connection keeps the DM, its text and its attachment');
  sessionManager.remove(sessionOn(5403).key);
  await settle();
  check(document.querySelector('.server-rail-avatar[data-port="5403"] .server-rail-status-dot')?.dataset.status !== 'online',
    'the rail shows the server is gone');
  check(dmIntact(), 'a background server going away keeps the DM, its text and its attachment');

  phase = 'another server at a saved address';
  // Its sign-in does not rewrite the entry the person saved: automatic entry
  // refuses that server, and entering by hand saves it again.
  connectionStore.addSavedServer({ host: 'e.test', port: 5405, name: 'Servidor que eu salvei', serverId: 'server-replaced', lastConnected: 1 });
  await openServerSession('e.test', 5405, identity, 'Fixture', undefined, { background: true });
  check(connectionStore.findSavedServer({ host: 'e.test', port: 5405 })?.name === 'Servidor que eu salvei',
    'a different server at a saved address leaves the saved name as it was');
  sessionManager.remove(sessionOn(5405).key);
  connectionStore.removeSavedServer('e.test', 5405);
  await settle();

  phase = 'R-SHELL-3: background servers and menus';
  await openServerSession('a.test', 5401, identity, 'Fixture');
  await until(() => !!document.querySelector('#chat-messages-feed') && !!document.querySelector('#main-user-status-dot'),
    'the server chat did not open');
  await openServerSession('b.test', 5402, identity, 'Fixture', undefined, { background: true });
  await until(() => document.querySelector('.server-rail-avatar[data-port="5402"] .server-rail-status-dot')?.dataset.status === 'online',
    'the rail did not show the second server');
  check(document.querySelector('#btn-server-settings')?.hidden === false,
    'a server connecting in the background leaves the menu of the server on screen as it was');
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
  const footerEdges = () => {
    const { left, right, bottom } = document.querySelector('.user-control-bar').getBoundingClientRect();
    return JSON.stringify([left, right, bottom]);
  };
  const serverFooter = footerEdges();
  document.querySelector('#server-rail-home').click();
  await until(() => !!document.querySelector('#home-view'), 'Home did not come back');
  check(footerEdges() === serverFooter,
    `the Home user card crosses the rail exactly like in a server (${serverFooter} → ${footerEdges()})`);
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

  phase = 'owned server click: readiness comes from hosting, not HTTP';
  settingsStore.autoConnectServers = false;
  settingsStore.save();
  const { t } = await import('/i18n/index.ts');
  const oldHostingApi = { hostServerStatus: window.api.hostServerStatus, hostServerStart: window.api.hostServerStart };
  const oldFetch = window.fetch;
  let localStatus = { servers: [] };
  let startFailure = true;
  let starts = 0;
  window.api.hostServerStatus = async () => localStatus;
  window.api.hostServerStart = async options => {
    starts++;
    if (startFailure) return { success: false, error: 'Startup fixture failed' };
    localStatus = { servers: [{ port: options.port, serverId: options.serverId }] };
    return { success: true };
  };
  // Another process can answer /preview on the same port while our server is stopped.
  window.fetch = async url => new URL(String(url)).port === '5600'
    ? new Response(JSON.stringify({ name: 'Unrelated online preview' }), { status: 200 })
    : oldFetch(url);
  connectionStore.saveCreatedServer({
    id: 'owned-start-fixture', name: 'Owned startup', port: 5600,
    voiceChannel: 'Geral', textChannel: 'geral', createdAt: 1, lastStarted: 1,
  });
  const dialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing]) .dialog-card');
  const clickOwned = () => document.querySelector('.server-rail-avatar[data-port="5600"]').click();
  const confirmStart = async () => {
    clickOwned();
    await until(() => !!dialog() || attemptsOn(5600) > 0, 'the owned server click did not react');
    check(dialog()?.textContent.includes(t('main.serverOfflineStartTitle')),
      'an online HTTP preview does not skip the owned server start confirmation');
    check(attemptsOn(5600) === 0, 'the click does not open a login socket before starting');
  };
  await confirmStart();
  dialog().querySelector('[data-action="cancel"]').click();
  await until(() => !document.querySelector('.server-rail-avatar[data-port="5600"][aria-busy="true"]'),
    'cancelled start did not release the busy state');
  check(starts === 0 && attemptsOn(5600) === 0 && sessionManager.isHome(),
    'cancelling starts neither a server nor a login and keeps Home visible');

  await confirmStart();
  dialog().querySelector('[data-action="confirm"]').click();
  await until(() => dialog()?.textContent.includes('Startup fixture failed'), 'the actual startup failure was not shown');
  check(dialog().textContent.includes(t('main.serverStartFailedTitle')),
    'a failed startup is reported as startup, not offline or changed identity');
  check(starts === 1 && attemptsOn(5600) === 0 && !!sessionOn(5401) && sessionManager.isHome(),
    'failed startup opens no socket and preserves the existing session and visible Home');
  dialog().querySelector('[data-action="confirm"]').click();
  await until(() => !document.querySelector('.server-rail-avatar[data-port="5600"][aria-busy="true"]'),
    'failed start did not release the busy state');

  // A matching status can have a stop queued: the start still needs acknowledgement.
  localStatus = { servers: [{ port: 5600, serverId: 'owned-start-fixture' }] };
  clickOwned();
  await until(() => dialog()?.textContent.includes('Startup fixture failed'), 'matching status bypassed startup acknowledgement');
  check(starts === 2 && attemptsOn(5600) === 0, 'matching status alone cannot open the login socket');
  dialog().querySelector('[data-action="confirm"]').click();
  await until(() => !document.querySelector('.server-rail-avatar[data-port="5600"][aria-busy="true"]'),
    'acknowledgement failure did not release the busy state');

  localStatus = { servers: [] };
  startFailure = false;
  await confirmStart();
  dialog().querySelector('[data-action="confirm"]').click();
  await until(() => sessionOn(5600)?.client.getStatus() === 'CONNECTED', 'acknowledged startup did not connect');
  check(starts === 3 && attemptsOn(5600) === 1, 'only acknowledged startup proceeds to login');
  document.querySelector('#server-rail-home').click();
  await until(() => sessionManager.isHome(), 'Home did not return after testing owned startup');
  sessionOn(5600).client.disconnect();
  await until(() => !sessionOn(5600), 'owned startup fixture did not disconnect');
  connectionStore.removeCreatedServer('owned-start-fixture');
  connectionStore.removeSavedServer('127.0.0.1', 5600);
  Object.assign(window.api, oldHostingApi);
  window.fetch = oldFetch;
  return checks;
}

async function responsiveShellSmoke(width, height, mobile) {
  let checks = 0;
  const check = (condition, message) => {
    if (!condition) throw new Error(`[responsive ${width}x${height}] ${message}`);
    checks++;
  };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const settleMotion = async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  };
  const until = async (condition, message) => {
    const started = performance.now();
    while (!condition()) {
      if (performance.now() - started > 5000) throw new Error(message);
      await frame();
    }
  };
  const visible = element => !!element?.checkVisibility({ checkVisibilityCSS: true });
  // A drawn button may be smaller than its touch area, which its ::after extends.
  const touchSize = selector => {
    const element = document.querySelector(selector);
    const after = getComputedStyle(element, '::after');
    const outset = after.content === 'none' || after.position !== 'absolute' ? 0 : -parseFloat(after.left);
    return Math.min(element.offsetWidth, element.offsetHeight) + 2 * Math.max(0, outset);
  };
  const withinViewport = (element, message) => {
    check(visible(element), `${message}: visible`);
    const box = element.getBoundingClientRect();
    check(box.left >= -1 && box.right <= width + 1 && box.top >= -1 && box.bottom <= height + 1,
      `${message}: contained (${JSON.stringify(box)})`);
  };
  const [{ sessionManager }, { settingsStore }, { appEvents }, { settingsModal }, { serverSettingsModal }, { t }, { voiceStore }] = await Promise.all([
    import('/core/SessionManager.ts'), import('/stores/settingsStore.ts'), import('/core/EventBus.ts'),
    import('/views/SettingsModal.ts'), import('/views/ServerSettingsModal.ts'), import('/i18n/index.ts'),
    import('/stores/voiceStore.ts'),
  ]);
  await frame();
  const compact = width <= 960 || mobile && width <= 1440;
  // A phone on its side shows navigation beside the content instead of one page at a time.
  const split = compact && height <= 540 && width / height >= 1.5;
  if (compact) {
    check(/Android.*Mobile/.test(navigator.userAgent) && navigator.userAgentData.mobile
      && navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches && devicePixelRatio === 3,
      'the renderer uses mobile device emulation, touch, Android identification and 3x pixel density');
  }
  const checkComposer = async (label) => {
    const composer = document.querySelector('.chat-input-wrapper');
    const input = composer.querySelector('#chat-message-input');
    check(getComputedStyle(input).webkitTapHighlightColor === 'rgba(0, 0, 0, 0)',
      `${label}: Chromium touch feedback cannot leave a blue rectangle over the custom composer`);
    const [attach, emoji, send] = ['#btn-attach', '#btn-emoji', '#btn-send-message']
      .map(selector => composer.querySelector(selector).getBoundingClientRect());
    const format = composer.querySelector('#btn-format');
    // Channels move formatting into the "+" menu; direct messages keep the button in the row.
    check(visible(format) === !composer.querySelector('#chat-create-menu'),
      `${label}: formatting is reached from "+" when it exists, never offered twice`);
    const controls = [attach, emoji, send, ...visible(format) ? [format.getBoundingClientRect()] : []];
    const field = input.getBoundingClientRect();
    // A wrapped draft grows the field upwards; the actions stay on its last line.
    check(controls.every(box => box.width >= 44 && box.height >= 44 && Math.abs(box.bottom - field.bottom) < 1),
      `${label}: the actions share the message row as 44px touch targets`);
    check(field.left >= attach.right - 1 && field.right <= Math.min(emoji.left, send.left) + 1 && field.width >= 96,
      `${label}: "+" | message | emoji | send fit one row around the text`);
    const counter = composer.querySelector('#chat-char-counter');
    check(!visible(counter), `${label}: a short message shows no character count`);
    const draft = input.value;
    input.value = 'x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const limit = Number(/\/(\d+)$/.exec(counter.textContent)?.[1]);
    if (limit) {
      input.value = 'x'.repeat(Math.ceil(limit * 0.9));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await frame();
      const count = counter.getBoundingClientRect();
      const box = composer.getBoundingClientRect();
      check(visible(counter) && count.left >= box.left && count.right <= box.right
        && count.bottom <= input.getBoundingClientRect().top + 1,
        `${label}: near the limit the count appears above the row, inside the composer`);
    }
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    const placeholder = input.querySelector('.cm-placeholder');
    check(placeholder?.textContent === t('chat.compactInputPlaceholder'),
      `${label}: the mobile placeholder has no desktop keyboard shortcut`);
    check(placeholder.getBoundingClientRect().left >= input.getBoundingClientRect().left
      && placeholder.getBoundingClientRect().right <= input.getBoundingClientRect().right,
      `${label}: the entire placeholder fits without ellipsis or clipping`);
    input.value = draft;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (compact) {
      // iOS opens the keyboard over a page it already scrolled to the field: the visible viewport starts lower.
      const root = document.documentElement;
      const top = Math.round(height * 0.25);
      const visibleHeight = Math.round(height * 0.6);
      const previous = ['--viewport-top', '--viewport-height'].map(name => root.style.getPropertyValue(name));
      const keyboardWasOpen = root.hasAttribute('data-keyboard-open');
      root.style.setProperty('--viewport-top', `${top}px`);
      root.style.setProperty('--viewport-height', `${visibleHeight}px`);
      root.setAttribute('data-keyboard-open', '');
      await frame();
      const app = document.querySelector('#app').getBoundingClientRect();
      ['--viewport-top', '--viewport-height'].forEach((name, index) => root.style.setProperty(name, previous[index]));
      root.toggleAttribute('data-keyboard-open', keyboardWasOpen);
      await frame();
      check(Math.abs(app.top - top) < 1 && Math.abs(app.bottom - (top + visibleHeight)) < 1,
        `${label}: with the keyboard open the app fills the visible viewport, with no raised composer over an empty gap (${JSON.stringify(app)})`);
    }
  };
  const layout = () => document.querySelector('.main-layout');
  const toggle = async panel => {
    const previous = layout().dataset.compactPanel;
    if (panel === 'navigation' && previous === 'navigation') return;
    const expected = panel === 'members' ? previous === 'members' ? 'content' : 'members'
      : previous === 'members' ? 'content' : 'navigation';
    if (panel === 'members') document.querySelector('[data-compact-toggle="members"]').click();
    else if (panel === 'navigation' && layout().dataset.compactPanel !== 'navigation' || panel === 'content') {
      document.querySelector('[data-compact-back]').click();
    }
    await until(() => layout().dataset.compactPanel === expected, 'The mobile navigation did not commit');
  };
  const closeModals = async () => {
    settingsModal.close();
    serverSettingsModal.close();
    await until(() => !document.querySelector('.modal-backdrop'), 'Settings did not close');
  };
  if (window.responsiveDraft) {
    check(document.querySelector('#chat-message-input') === window.responsiveDraft.input
      && window.responsiveDraft.input.value === 'draft across viewport changes', 'resizing retains the live DM composer and draft');
    check(document.querySelector('.user-control-bar') === window.responsiveDraft.footer,
      'resizing moves the existing voice controls rather than recreating them');
    check(!!window.responsiveDraft.footer.closest('.compact-footer') === compact,
      'the footer returns to its desktop owner when leaving compact mode');
  }
  const preferences = [settingsStore.navigationSidebarHidden, settingsStore.membersSidebarHidden];
  check(layout().hasAttribute('data-compact-split') === split, 'only a phone on its side splits the screen');
  if (compact) {
    await toggle('navigation');
    check(layout().dataset.compactPanel === 'navigation' && !document.querySelector('.home-sidebar-shell').inert,
      'Home navigation opens without changing or remounting its content');
    withinViewport(document.querySelector('.home-sidebar-shell'), 'Home sidebar');
    withinViewport(document.querySelector('.server-rail'), 'server rail');
    withinViewport(document.querySelector('.compact-footer'), 'root profile card');
    await until(() => !document.documentElement.hasAttribute('data-compact-transition'), 'The profile navigation did not finish');
    const dot = document.querySelector('.compact-footer .status-indicator-button');
    const hitbox = getComputedStyle(dot, '::before');
    check(parseFloat(hitbox.width) >= 44 && parseFloat(hitbox.height) >= 44,
      'the small visual status dot has a 44px touch area');
    const dotBox = dot.getBoundingClientRect();
    const hitCenter = {
      x: dotBox.right - parseFloat(hitbox.right) - parseFloat(hitbox.width) / 2,
      y: dotBox.bottom - parseFloat(hitbox.bottom) - parseFloat(hitbox.height) / 2,
    };
    const statusHits = [[0, -16], [0, 16], [-16, 0], [16, 0]].map(([x, y]) =>
      document.elementFromPoint(hitCenter.x + x, hitCenter.y + y));
    check(statusHits.every(hit => dot.contains(hit)),
      'the status touch area really receives input around the avatar, not just at the 14px dot: '
      + JSON.stringify({ box: dotBox.toJSON(), hits: statusHits.map(hit => hit?.className) }));
    if (split) {
      const sidebar = document.querySelector('.home-sidebar-shell').getBoundingClientRect();
      const center = document.querySelector('.main-center-column');
      check(!center.inert && center.getBoundingClientRect().left >= sidebar.right - 1
        && document.querySelector('.compact-navigation').getBoundingClientRect().left >= sidebar.right - 1,
        'on its side the content and its toolbar stay reachable beside the navigation');
      check(!visible(document.querySelector('[data-compact-back]')), 'navigation already on screen offers no way back to it');
    } else {
      check(!visible(document.querySelector('.compact-navigation')), 'the navigation index has no generic Monky toolbar');
      check(document.querySelector('.main-center-column').inert, 'covered content cannot receive keyboard focus');
    }
    check(!visible(document.querySelector('.user-media-bar')), 'the root profile does not expose a desktop media toolbar');
    document.querySelector('#home-nav-friends').click();
    await until(() => layout().dataset.compactPanel === 'content', 'Friends did not become visible');
    check(layout().dataset.compactPanel === 'content', 'selecting Friends returns to content, including an already-selected row');
    if (split) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await frame();
      check(layout().dataset.compactPanel === 'content' && !document.querySelector('.home-sidebar-shell').inert,
        'side by side, Escape has no other page to return to');
    } else {
      const backBox = document.querySelector('[data-compact-back]').getBoundingClientRect();
      const headingIcon = document.querySelector('.friends-home-heading').firstElementChild.getBoundingClientRect();
      check(headingIcon.left >= backBox.right + 4 && Math.abs(headingIcon.top + headingIcon.height / 2
        - backBox.top - backBox.height / 2) < 1, 'Friends heading leaves aligned space for the mobile back button');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => layout().dataset.compactPanel === 'navigation', 'Escape did not return to navigation');
      check(layout().dataset.compactPanel === 'navigation', 'Escape returns from content to the navigation index');
    }
  }
  appEvents.emit('dm.open', 'a'.repeat(64));
  await until(() => !!document.querySelector('#chat-message-input'), 'DM did not open');
  const input = document.querySelector('#chat-message-input');
  input.value = 'draft across viewport changes';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (compact) {
    await toggle('navigation');
    document.querySelector('[data-dm-open]').click();
    await until(() => layout().dataset.compactPanel === 'content', 'The DM did not become visible');
    check(layout().dataset.compactPanel === 'content' && document.querySelector('#chat-message-input') === input
      && input.value === 'draft across viewport changes', 'reopening the current DM closes navigation without losing its draft');
    withinViewport(document.querySelector('.chat-input-container'), 'DM composer');
    withinViewport(document.querySelector('.compact-navigation'), 'contextual conversation controls');
    if (split) withinViewport(document.querySelector('.compact-footer'), 'user footer under the navigation beside a conversation');
    else check(!visible(document.querySelector('.compact-footer')), 'a conversation has no persistent desktop user footer');
    await checkComposer('DM composer');
  }
  const session = sessionManager.getAll().find(entry => entry.port === 5401);
  sessionManager.activate(session.key);
  await until(() => !!document.querySelector('.channels-sidebar'), 'Server shell did not render');
  if (compact) {
    await toggle('navigation');
    withinViewport(document.querySelector('.channels-sidebar'), 'channel list');
    await until(() => !!document.querySelector('.community-banner-body [data-community="open"]'),
      'The live-action banner did not load');
    const bannerBody = document.querySelector('.community-banner-body');
    const openAction = bannerBody.querySelector('[data-community="open"]');
    const openBox = openAction.getBoundingClientRect();
    const bodyBox = bannerBody.getBoundingClientRect();
    const bodyStyle = getComputedStyle(bannerBody);
    const title = document.createRange();
    title.selectNodeContents(bannerBody.querySelector('h3'));
    const dismissBox = document.querySelector('.community-dismiss').getBoundingClientRect();
    check([...title.getClientRects()].every(box => box.top >= dismissBox.bottom
      || box.right <= dismissBox.left - 4),
      'the live-action title wraps without running under the close button');
    check(Math.abs(openBox.left - bodyBox.left - parseFloat(bodyStyle.paddingLeft)) < 1
      && Math.abs(bodyBox.right - openBox.right - parseFloat(bodyStyle.paddingRight)) < 1,
      'the live-action button fills the card content instead of floating in the corner');
    check(openBox.height >= 44 && parseFloat(getComputedStyle(openAction).fontSize) >= 14,
      'the live-action button has a readable label and a 44px touch target');
    const previousBox = document.querySelector('[data-community="previous"]').getBoundingClientRect();
    const nextBox = document.querySelector('[data-community="next"]').getBoundingClientRect();
    const positionBox = document.querySelector('.community-navigation > span').getBoundingClientRect();
    check(Math.abs((previousBox.left + nextBox.right) / 2 - (bodyBox.left + bodyBox.right) / 2) < 1
      && Math.abs(positionBox.left - previousBox.right - 16) < 1
      && Math.abs(nextBox.left - positionBox.right - 16) < 1
      && previousBox.top >= openBox.bottom && nextBox.top >= openBox.bottom,
      'the carousel controls are centered below the full-width action');
    document.querySelector('.channel-item[data-channel-type="TEXT"]').click();
    await until(() => layout().dataset.compactPanel === 'content', 'The text channel did not become visible');
    check(layout().dataset.compactPanel === 'content', 'choosing a text channel reveals its conversation');
    withinViewport(document.querySelector('.chat-input-container'), 'channel composer');
    withinViewport(document.querySelector('#btn-send-message'), 'send message button');
    await checkComposer('channel composer');
    document.querySelector('#btn-emoji').click();
    await until(() => visible(document.querySelector('.emoji-picker')), 'The mobile emoji sheet did not open');
    const picker = document.querySelector('.emoji-picker');
    await settleMotion(picker);
    withinViewport(picker, 'mobile emoji sheet');
    check(picker.parentElement === document.body && picker.getBoundingClientRect().width === width,
      'the shared emoji picker is a full-width sheet rather than a desktop composer popover');
    check(!document.activeElement?.matches('.emoji-picker-search-input'),
      'opening emojis on touch does not automatically request the virtual keyboard');
    const feedUnderSheet = document.querySelector('.chat-messages-feed');
    feedUnderSheet.scrollTop = Math.max(0, feedUnderSheet.scrollTop - 40);
    feedUnderSheet.dispatchEvent(new Event('scroll'));
    await frame();
    check(picker.isConnected && !picker.hasAttribute('data-ui-closing'),
      'the chat scrolling under the emoji sheet, as a new message does, keeps the sheet open');
    picker.querySelector('[data-picker-close]').click();
    await until(() => !document.querySelector('.emoji-picker'), 'The emoji sheet did not close');
    check(!visible(document.querySelector('.server-tools')), 'desktop search is not an extra permanent header');
    document.querySelector('[data-compact-search]').click();
    withinViewport(document.querySelector('.server-tools'), 'contextual message search');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(!layout().hasAttribute('data-compact-search-open')
      && document.querySelector('[data-compact-search]').getAttribute('aria-expanded') === 'false'
      && document.activeElement === document.querySelector('[data-compact-search]'),
      'Escape closes search and restores its accessible state and trigger focus without leaving the conversation');
    check(document.querySelector('.chat-container .content-header').getBoundingClientRect().width <= width,
      'the channel header shares no horizontal space with desktop sidebars');
    check(parseFloat(getComputedStyle(document.querySelector('.chat-container .content-header')).paddingRight) <= 100,
      'the channel title does not reserve the desktop search field width');
    await toggle('members');
    if (split) {
      const drawer = document.querySelector('.members-sidebar');
      await until(() => getComputedStyle(drawer).transform === 'none', 'The members drawer did not slide in');
      check(layout().dataset.compactPanel === 'members' && !drawer.inert && !document.querySelector('.channels-sidebar').inert
        && drawer.getBoundingClientRect().left >= document.querySelector('.channels-sidebar').getBoundingClientRect().right,
        'on its side members open as a drawer over the conversation, leaving the channels in place');
      withinViewport(drawer, 'members drawer');
      document.querySelector('.chat-messages-feed').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await until(() => layout().dataset.compactPanel === 'content', 'Touching the conversation did not put the drawer away');
      check(drawer.inert, 'the closed drawer leaves keyboard navigation');
    } else {
      check(layout().dataset.compactPanel === 'members' && document.querySelector('.channels-sidebar').inert,
        'members replace content without exposing the channels to keyboard navigation');
      withinViewport(document.querySelector('.members-sidebar'), 'members panel');
      await toggle('content');
    }
    await toggle('navigation');
    document.querySelector('[data-voice-chat-channel]').click();
    await until(() => visible(document.querySelector('.voice-channel-chat-panel')), 'Voice chat did not open');
    if (split) {
      const chat = document.querySelector('.voice-channel-chat-panel').getBoundingClientRect();
      const stageBox = document.querySelector('.main-center-column').getBoundingClientRect();
      check(layout().dataset.compactPanel === 'content' && !document.querySelector('.main-center-column').inert
        && stageBox.right <= chat.left + 1 && stageBox.width >= chat.width,
        'on its side the voice chat opens beside the stage, which keeps most of the screen');
    } else {
      const chat = document.querySelector('.voice-channel-chat-panel').getBoundingClientRect();
      const stageBox = document.querySelector('.voice-stage-container').getBoundingClientRect();
      check(layout().dataset.compactPanel === 'content' && layout().hasAttribute('data-compact-chat-below')
        && !document.querySelector('.main-center-column').inert && stageBox.height > 0 && stageBox.bottom <= chat.top + 1,
        'upright the voice chat opens below the stage, which stays on screen');
    }
    withinViewport(document.querySelector('.voice-channel-chat-panel'), 'voice channel chat');
    await settleMotion(document.querySelector('.voice-channel-chat-panel'));
    const voiceHeader = document.querySelector('.voice-chat-content .channel-title-container').getBoundingClientRect();
    const headerControls = ['[data-compact-search]', '[data-compact-toggle="members"]', '.voice-chat-close']
      .map(selector => document.querySelector(selector).getBoundingClientRect());
    // On its side the 40px header draws smaller icons, each with a 44px touch area; the stage toolbar sits left of the chat.
    check(['[data-compact-search]', '[data-compact-toggle="members"]'].every(selector => touchSize(selector) >= 44),
      'voice-chat header icons keep a 44px touch area');
    check(headerControls.every(box => box.width >= (split ? 36 : 44)
      && (box.left >= voiceHeader.right - 1 || split && box.right <= voiceHeader.left + 1)),
      'voice-chat search, members and close controls have separate touch targets outside the title');
    check(!visible(document.querySelector('.voice-chat-search')), 'voice-chat search starts collapsed, not overlaid on its title');
    if (!split) {
      const [searchBox, membersBox] = ['[data-compact-search]', '[data-compact-toggle="members"]']
        .map(selector => document.querySelector(selector).getBoundingClientRect());
      check(searchBox.right <= membersBox.left + 1 && membersBox.left - searchBox.right <= 8,
        `the bar packs search beside members at its end instead of over the stage title (${searchBox.right} ${membersBox.left})`);
    }
    document.querySelector('[data-compact-search]').click();
    withinViewport(document.querySelector('.voice-chat-search'), 'voice-chat contextual search');
    check(document.activeElement === document.querySelector('.voice-chat-search .message-search-launch'),
      'the voice-chat search button focuses its own search field, not the hidden stage');
    check(document.querySelector('.voice-chat-search').getBoundingClientRect().bottom
      <= document.querySelector('.voice-chat-content .chat-messages-feed').getBoundingClientRect().top + 1,
      'expanded voice-chat search does not cover the conversation');
    document.querySelector('[data-compact-search]').click();
    document.querySelector('.voice-chat-close').click();
    await until(() => document.querySelector('.voice-channel-chat-panel').hidden, 'Voice chat did not close');
    withinViewport(document.querySelector('.voice-stage-container'), 'voice stage preview');
    withinViewport(document.querySelector('#stage-btn-join'), 'join call control');
    voiceStore.setChannel('voice-5401', session.key);
    document.querySelector('.voice-conn-info').click();
    await until(() => !!document.querySelector('#stage-btn-leave'), 'Joined call controls did not appear');
    const users = [session.participants.getAll()[0].user,
      { id: 'mobile-demo', clientId: 'demo-key', sessionId: 'demo-device', nickname: 'Pessoa de exemplo', status: 'ONLINE', joinedAt: 1 }];
    session.participants.reconcileVoiceChannel('voice-5401', users.map(user => ({ user, voiceState: {
      sessionId: user.sessionId, userId: user.id, channelId: 'voice-5401', isMuted: false, isDeafened: false,
      isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false, serverMuted: false, serverDeafened: false,
    } })));
    await frame();
    for (let cycle = 0; cycle < 2; cycle++) {
      document.querySelector('#stage-btn-chat').click();
      await until(() => visible(document.querySelector('.voice-channel-chat-panel')), 'The call chat did not open');
      if (cycle === 0 && !split) {
        const root = document.documentElement;
        const panel = document.querySelector('.voice-channel-chat-panel');
        await settleMotion(panel);
        const { reducedMotion } = await import('/utils/surfaceMotion.ts');
        const band = () => document.querySelector('.voice-stage-container').getBoundingClientRect().height;
        const settleBand = () => Promise.allSettled(layout().getAnimations({ subtree: true }).map(animation => animation.finished));
        // Typing starts from the focused composer; the app re-reads the viewport on that focus.
        panel.querySelector('.chat-input-container [contenteditable]').focus();
        await frame();
        await frame();
        const bandBefore = band();
        const visibleHeight = Math.round(innerHeight * 0.6);
        const fullViewport = root.style.getPropertyValue('--viewport-height');
        // The keyboard shrinks the visual viewport; the app keeps re-reading it while the keyboard moves.
        const keyboardViewport = height => {
          if (height === null) delete visualViewport.height;
          else Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => height });
          visualViewport.dispatchEvent(new Event('resize'));
        };
        keyboardViewport(visibleHeight);
        check(root.hasAttribute('data-keyboard-open'), 'a viewport shrunk under the focused composer counts as the keyboard');
        const bandAtKeyboard = band();
        const chat = panel.querySelector('.chat-container');
        const typing = panel.querySelector('.chat-input-container');
        const overflows = [];
        const sample = () => {
          if (chat.scrollHeight > chat.clientHeight + 1 || typing.getBoundingClientRect().bottom > visibleHeight + 0.5) {
            overflows.push({ band: band(), detail: `${Math.round(band())}px: ${chat.scrollHeight}/${chat.clientHeight}, ${typing.getBoundingClientRect().bottom}` });
          }
        };
        sample();
        while (layout().getAnimations({ subtree: true }).some(animation => animation.playState === 'running')) {
          await frame();
          sample();
        }
        await settleBand();
        const bandWithKeyboard = band();
        check(reducedMotion() || bandAtKeyboard >= bandWithKeyboard - 0.5 && bandWithKeyboard < bandBefore - 20
          && (innerHeight < 780 || bandAtKeyboard > bandWithKeyboard + 20),
          `the stage band shrinks with the keyboard as far as the call chat allows, instead of jumping to its final place first (${bandBefore} → ${bandAtKeyboard} → ${bandWithKeyboard})`);
        const squeezedByBand = overflows.filter(overflow => overflow.band > bandWithKeyboard + 0.5);
        check(squeezedByBand.length === 0,
          `the shrinking stage band never squeezes the call chat until Safari scrolls the page after the composer (${squeezedByBand.map(overflow => overflow.detail).join('; ')})`);
        // Measured at the full height, where the composer is not cut by the keyboard itself.
        root.style.setProperty('--viewport-height', fullViewport);
        await frame();
        const container = panel.querySelector('.chat-container').getBoundingClientRect();
        const composer = panel.querySelector('.chat-input-container').getBoundingClientRect();
        const feed = panel.querySelector('.chat-messages-feed');
        const feedStyle = getComputedStyle(feed);
        const squeezed = feed.getBoundingClientRect().height
          <= parseFloat(feedStyle.paddingTop) + parseFloat(feedStyle.paddingBottom) + 0.5;
        keyboardViewport(null);
        check(!root.hasAttribute('data-keyboard-open'), 'the viewport growing back closes the keyboard layout');
        await settleBand();
        check(Math.abs(band() - bandBefore) < 1, 'the stage band grows back when the keyboard closes');
        const gap = container.bottom - composer.bottom;
        const footerGap = parseFloat(getComputedStyle(document.querySelector('.compact-footer > .user-control-bar')).marginBottom);
        check(footerGap > 0 && gap >= -0.5 && (squeezed || Math.abs(gap - footerGap) < 0.5),
          `typing in the call chat leaves the footer card's dark gap (${footerGap}px) between the composer and Safari's address bar, as a channel chat does, and gives it up before cutting the composer (${gap}px)`);
      }
      await toggle('navigation');
      if (cycle === 0) {
        await frame();
        const footerBox = document.querySelector('.compact-footer').getBoundingClientRect();
        check(!layout().hasAttribute('data-compact-chat-below') && footerBox.bottom >= innerHeight - 1,
          `leaving the stage with its chat open gives the channels the whole screen, not the video band (${JSON.stringify(footerBox)})`);
        const strip = getComputedStyle(document.querySelector('.compact-footer .voice-conn-info')).backgroundColor;
        const flat = (element, background) => {
          const style = getComputedStyle(element);
          return style.backgroundColor === background && style.boxShadow === 'none'
            && ['Top', 'Right', 'Bottom', 'Left'].every(side => style[`border${side}Width`] === '0px'
              || style[`border${side}Color`] === 'rgba(0, 0, 0, 0)' || side === 'Bottom' && element.classList.contains('camera-control-group'));
        };
        check(flat(document.querySelector('.compact-footer .camera-control-group'), strip)
          && flat(document.querySelector('.compact-footer .voice-conn-leave'), 'rgba(0, 0, 0, 0)'),
        `the call strip draws camera and leave as icons on one continuous strip, without the desktop card, outline or a hole (${strip})`);
        const voiceItem = document.querySelector('.channel-item[data-channel-type="VOICE"]');
        const lastAction = [...voiceItem.querySelectorAll('button')].filter(visible).at(-1);
        check(lastAction.getBoundingClientRect().right >= voiceItem.getBoundingClientRect().right - 1,
          'the voice channel actions reach the end of the row instead of floating away from the edge');
      }
      document.querySelector('.channel-item[data-channel-type="VOICE"]').click();
      await until(() => layout().dataset.compactPanel === 'content', 'The joined voice stage did not become visible');
      await frame();
      check(document.querySelector('.voice-channel-chat-panel').hidden,
        'clicking the joined voice channel dismisses its covering chat and returns to the stage every time');
      withinViewport(document.querySelector('.stage-call-controls'), 'call dock after returning through the voice channel');
      document.querySelector('#stage-btn-chat').click();
      await until(() => visible(document.querySelector('.voice-channel-chat-panel')), 'The call chat did not reopen');
      // On its side the chat sits beside the stage, where the footer banner is not shown.
      document.querySelector(split ? '.voice-chat-close' : '.voice-conn-info').click();
      await frame();
      if (split) await until(() => document.querySelector('.voice-channel-chat-panel').hidden, 'The call chat did not close');
      check(document.querySelector('.voice-channel-chat-panel').hidden,
        'the connected-call banner returns from voice chat to the stage instead of leaving it covered');
      check(voiceStore.currentVoiceChannelId === 'voice-5401' && voiceStore.voiceSessionKey === session.key,
        'returning from chat preserves the admitted call');
    }
    document.querySelector('#stage-btn-chat').click();
    await until(() => visible(document.querySelector('.voice-channel-chat-panel')), 'The searchable call chat did not open');
    document.querySelector('[data-compact-search]').click();
    document.querySelector(split ? '.voice-chat-close' : '.voice-conn-info').click();
    await frame();
    if (split) await until(() => document.querySelector('.voice-channel-chat-panel').hidden, 'The searched call chat did not close');
    check(!layout().hasAttribute('data-compact-search-open'),
      'returning to the stage clears contextual chat search instead of leaving a gap over the call');
    withinViewport(document.querySelector('.stage-call-controls'), 'compact floating call dock');
    withinViewport(document.querySelector('#stage-btn-leave'), 'hang up action');
    if (!split) {
      const chatToggle = document.querySelector('#stage-btn-chat');
      // Closing the chat fades the button's active background out.
      await settleMotion(chatToggle);
      const gap = document.querySelector('[data-compact-toggle="members"]').getBoundingClientRect().left
        - chatToggle.getBoundingClientRect().right;
      check(gap >= 0 && gap <= 12 && getComputedStyle(chatToggle).backgroundColor === 'rgba(0, 0, 0, 0)',
        `the stage chat button sits flat beside members, without the room of the hidden search (gap ${gap})`);
    }
    const cards = [...document.querySelectorAll('.stage-grid > .stage-card')];
    check(cards.length === 2, 'the compact call contains both participants');
    // A phone on its side has width to spare, not height: the dock becomes a rail beside the tiles.
    const sideDock = compact && height <= 540 && width / height >= 1.5;
    const dock = () => document.querySelector('.stage-call-controls').getBoundingClientRect();
    const stageArea = () => document.querySelector('#stage-content-area').getBoundingClientRect();
    check(sideDock ? dock().height > dock().width && dock().left >= stageArea().right
      : dock().width > dock().height && dock().top >= stageArea().bottom - 1,
    `the call dock is a ${sideDock ? 'rail beside' : 'bar below'} the participants (${JSON.stringify(dock())})`);
    for (const card of cards) {
      withinViewport(card, 'call participant tile');
      const box = card.getBoundingClientRect();
      check(sideDock ? box.right <= dock().left : box.bottom <= dock().top,
        'both participants fit beside or above the call dock, including short and landscape viewports');
    }
    if (sideDock) {
      check(stageArea().height >= (height - 64) * 0.75, 'on its side the stage keeps the height below its header');
      const stageHeader = document.querySelector('.voice-stage-container > .content-header').getBoundingClientRect();
      const chatButton = document.querySelector('#stage-btn-chat').getBoundingClientRect();
      check(chatButton.top >= stageHeader.top - 1 && chatButton.bottom <= stageHeader.bottom + 1 && touchSize('#stage-btn-chat') >= 44,
        `on its side the call chat button fits its header and keeps a 44px touch area (${JSON.stringify(chatButton)} ${JSON.stringify(stageHeader)})`);
      cards[1].click();
      await until(() => !!document.querySelector('.stage-focused-main'), 'Tapping a participant did not focus it');
      await settleMotion(document.querySelector('.voice-stage-container'));
      const main = document.querySelector('.stage-focused-main').getBoundingClientRect();
      const strip = document.querySelector('.stage-focused-strip').getBoundingClientRect();
      check(main.height >= stageArea().height * 0.9 && main.width >= width * 0.6,
        `a focused tile (a shared screen) takes the stage's whole height instead of a strip of it (${JSON.stringify(main)})`);
      check(strip.left >= main.right && strip.height > strip.width && strip.bottom <= dock().top
        && strip.left >= dock().left - 1 && strip.right <= dock().right + 1,
      'the other participants line up in the call rail, above its controls');
      withinViewport(document.querySelector('.stage-focused-strip > .stage-mini-card'), 'unfocused participant beside the focus');
      // On its side a focused video goes immersive: a tap hides the chrome, the next one brings it back.
      document.querySelector('.stage-focused-main').click();
      await until(() => layout().hasAttribute('data-stage-chrome-hidden'), 'Tapping the focused video did not hide the chrome');
      check(!!document.querySelector('.stage-focused-main'), 'hiding the chrome keeps the participant in focus');
      document.querySelector('.stage-focused-main').click();
      check(!layout().hasAttribute('data-stage-chrome-hidden') && !!document.querySelector('.stage-focused-main'),
        'the next tap only brings the chrome back');
      document.querySelector('#stage-btn-grid').click();
      await until(() => !document.querySelector('.stage-focused-main'), 'Back to the grid did not release the focus');
    }
    check(!visible(document.querySelector('.compact-footer')), 'the stage never duplicates its call dock with a desktop footer');
    voiceStore.setScreenSharing(true);
    const stopShare = document.querySelector('#stage-btn-stop-share');
    await until(() => !stopShare.hidden && !!document.querySelector('#stage-broadcast-banner-wrapper'),
      'Sharing did not offer a way to stop');
    await settleMotion(document.querySelector('.voice-stage-container'));
    // The banner above the stage pushed a focused video down and repeated what the call dock already shows.
    check(!visible(document.querySelector('#stage-broadcast-banner-wrapper')),
      'a phone shows no live banner above the stage while sharing');
    withinViewport(stopShare, 'stop sharing action in the call dock');
    const stopBox = stopShare.getBoundingClientRect();
    check(Math.abs(stopBox.width - stopBox.height) < 1 && stopBox.width >= 40 && visible(stopShare.querySelector('.material-symbols-outlined')),
      `stopping a share is a round icon button like the rest of the dock (${JSON.stringify(stopBox)})`);
    withinViewport(document.querySelector('#stage-btn-leave'), 'hang up action while sharing');
    if (sideDock) {
      cards[1].click();
      await until(() => !!document.querySelector('.stage-focused-main'), 'Tapping a participant while sharing did not focus it');
      await settleMotion(document.querySelector('.voice-stage-container'));
      const thumbnail = document.querySelector('.stage-focused-strip > .stage-mini-card');
      withinViewport(thumbnail, 'unfocused participant beside the focus while sharing');
      check(thumbnail.getBoundingClientRect().bottom <= dock().top + 1,
        `while sharing, the larger call rail leaves the other participants uncovered (${JSON.stringify(thumbnail.getBoundingClientRect())} ${JSON.stringify(dock())})`);
      withinViewport(document.querySelector('#stage-btn-leave'), 'hang up action in focus while sharing');
      withinViewport(stopShare, 'stop sharing action in focus');
      // The rail drops its box in focus, but its rounded corners once still clipped the corner buttons.
      const rail = document.querySelector('.stage-call-controls');
      const railBox = rail.getBoundingClientRect();
      const corner = parseFloat(getComputedStyle(rail).borderTopLeftRadius) || 0;
      const clipped = getComputedStyle(rail).overflow === 'visible' ? [] : [...rail.querySelectorAll('button')].filter(visible).filter(button => {
        const box = button.getBoundingClientRect();
        const radius = Math.min(box.width, box.height) / 2;
        const x = (box.left + box.right) / 2;
        const y = (box.top + box.bottom) / 2;
        const arcX = x < railBox.left + corner ? railBox.left + corner : x > railBox.right - corner ? railBox.right - corner : null;
        const arcY = y < railBox.top + corner ? railBox.top + corner : y > railBox.bottom - corner ? railBox.bottom - corner : null;
        return arcX !== null && arcY !== null && Math.hypot(x - arcX, y - arcY) + radius > corner + 0.5;
      });
      check(clipped.length === 0, `the focused call rail clips none of its buttons (${clipped.map(button => button.id).join(', ')})`);
      document.querySelector('#stage-btn-grid').click();
      await until(() => !document.querySelector('.stage-focused-main'), 'Back to the grid did not release the focus while sharing');
    }
    voiceStore.setScreenSharing(false);
    await until(() => stopShare.hidden, 'Stopping the share did not withdraw its control');
    // A phone flips its camera on the camera's own tile, beside fullscreen, not two taps away in the call options.
    const { videoService } = await import('/core/VideoService.ts');
    const realCameraState = videoService.getCameraState;
    const realSwitchFacing = videoService.switchCameraFacing;
    let flips = 0;
    videoService.getCameraState = () => ({ status: 'ready', stream: null, publishing: true, error: null, canSwitchFacing: true });
    videoService.switchCameraFacing = async () => { flips++; };
    // The server's echo of the camera state is what redraws the stage's tiles.
    voiceStore.setCameraOn(true);
    appEvents.emit('participants.updated');
    const ownCameraTile = () => document.querySelector(`[data-tile-key="${session.participants.getAll()[0].user.sessionId}:camera"]`);
    await until(() => visible(ownCameraTile()?.querySelector('[data-camera-flip]')), 'The camera tile did not offer to flip the camera');
    const flip = ownCameraTile().querySelector('[data-camera-flip]');
    withinViewport(flip, 'camera flip on its tile');
    check(flip.parentElement === ownCameraTile().querySelector('.stage-fullscreen-btn')?.parentElement,
      'the camera flip sits beside the tile\'s fullscreen button');
    flip.click();
    await frame();
    check(flips === 1 && !document.querySelector('.stage-focused-main'), 'tapping the flip swaps the camera without focusing the tile');
    document.querySelector('[data-compact-call-options]').click();
    await until(() => !!document.querySelector('.compact-call-sheet'), 'Call options did not open');
    check(![...document.querySelectorAll('.compact-call-sheet .material-symbols-outlined')].some(icon => icon.textContent === 'flip_camera_ios'),
      'the call options no longer repeat the camera flip');
    document.querySelector('.compact-call-sheet [data-modal-close]').click();
    await until(() => !document.querySelector('.compact-call-sheet'), 'Call options did not close');
    voiceStore.setCameraOn(false);
    appEvents.emit('participants.updated');
    videoService.getCameraState = realCameraState;
    videoService.switchCameraFacing = realSwitchFacing;
    await until(() => !ownCameraTile(), 'Turning the camera off did not remove its tile');
    // A phone browser without screen capture shows no tooltip on touch: the sheet itself says why sharing is locked.
    const { setDesktopOnly } = await import('/utils/desktopOnly.ts');
    const screenButton = document.querySelector('#stage-btn-screen');
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true });
    setDesktopOnly(screenButton, 'screenShare');
    document.querySelector('[data-compact-call-options]').click();
    await until(() => !!document.querySelector('.compact-call-sheet'), 'Call options did not open');
    const callSheet = document.querySelector('.compact-call-sheet .modal-card');
    await settleMotion(callSheet);
    withinViewport(callSheet, 'additional call controls bottom sheet');
    check(Math.abs(callSheet.getBoundingClientRect().bottom - height) < 2, 'call options are attached to the bottom edge');
    const lockedShare = callSheet.querySelector('.compact-call-action[data-desktop-only="screenShare"]');
    const shareReason = lockedShare && document.getElementById(lockedShare.getAttribute('aria-describedby'));
    check(visible(shareReason) && lockedShare.contains(shareReason)
      && shareReason.textContent === t('desktopOnly.reason.screenShareDevice')
      && getComputedStyle(lockedShare).opacity === '1',
    'a locked call action shows, undimmed and tied to it, why this device cannot share its screen');
    document.querySelector('.compact-call-sheet [data-modal-close]').click();
    await until(() => !document.querySelector('.compact-call-sheet'), 'Call options did not close');
    setDesktopOnly(screenButton, null);
    delete navigator.mediaDevices.getDisplayMedia;
    await toggle('navigation');
    document.querySelector('.channel-item[data-channel-type="TEXT"]').click();
    await until(() => layout().dataset.compactPanel === 'content', 'The background call chat did not become visible');
    // The voice row dissolves into the footer card, so its visible parts are checked, not the row itself.
    withinViewport(document.querySelector('#voice-connection-row .voice-conn-info'), 'background call banner');
    withinViewport(document.querySelector('#voice-connection-row .voice-conn-leave'), 'background call leave button');
    // A screen watched from the conversation floats as a thumbnail instead of taking a notice row from the chat.
    const shareState = sharing => session.participants.reconcileVoiceChannel('voice-5401', users.map(user => ({ user, voiceState: {
      sessionId: user.sessionId, userId: user.id, channelId: 'voice-5401', isMuted: false, isDeafened: false,
      isSpeaking: false, isCameraOn: false, isScreenSharing: sharing && user.id === 'mobile-demo',
      screenShareIds: sharing && user.id === 'mobile-demo' ? ['demo-share'] : [],
      isSharingScreenAudio: false, serverMuted: false, serverDeafened: false,
    } })));
    shareState(true);
    const shareCanvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
    shareCanvas.getContext('2d').fillRect(0, 0, 320, 180);
    const shared = shareCanvas.captureStream();
    session.participants.setRemoteScreenStream('demo-device', 'demo-share', shared);
    voiceStore.setScreenWatching('demo-device', 'demo-share', true);
    await until(() => visible(document.querySelector('.watched-screen-mini')), 'The watched screen did not float over the conversation');
    const mini = document.querySelector('.watched-screen-mini');
    await settleMotion(mini);
    const composerTop = () => document.querySelector('#compact-content-panel .chat-input-container').getBoundingClientRect().top;
    const headerBottom = document.querySelector('#compact-content-panel .content-header').getBoundingClientRect().bottom;
    check(mini.querySelector('video').srcObject === shared && !document.querySelector('#screenshare-viewer-stage-btn'),
      'the watched screen plays in the thumbnail instead of a "you are watching" row');
    check(mini.getBoundingClientRect().top >= headerBottom && mini.getBoundingClientRect().bottom <= composerTop(),
      'the thumbnail floats between the header and the composer');
    const pointer = (type, x, y, target = window) => target.dispatchEvent(new PointerEvent(type, { pointerId: 31, clientX: x, clientY: y, bubbles: true }));
    const miniStart = mini.getBoundingClientRect();
    const openStage = mini.querySelector('.watched-screen-mini-open');
    // A flick moves and lifts in the same frame: the corner is where the finger let go.
    const liftAt = composerTop() - 10;
    pointer('pointerdown', miniStart.left + 20, miniStart.top + 20, openStage);
    pointer('pointermove', miniStart.left + 10, miniStart.top + 200);
    pointer('pointermove', 30, liftAt);
    pointer('pointerup', 30, liftAt);
    openStage.click();
    await until(() => mini.dataset.corner === 'bottom-left'
      && Math.abs(mini.getBoundingClientRect().bottom - composerTop() + 8) < 1, 'The dragged thumbnail did not settle above the composer');
    check(mini.isConnected && !document.querySelector('.stage-call-controls'), 'lifting the finger after a drag does not count as a tap');
    openStage.click();
    await until(() => !!document.querySelector('.stage-call-controls') && !document.querySelector('.watched-screen-mini'),
      'Tapping the thumbnail did not return to the stage');
    const sharedVideo = () => [...document.querySelectorAll('#stage-content-area video')].find(video => video.srcObject?.id === shared.id);
    await until(() => !!sharedVideo(), 'The watched screen is not on the stage');
    if (!sharedVideo().closest('.stage-focused-main')) sharedVideo().closest('.stage-card, .stage-mini-card').click();
    const focusedAspect = () => Number(sharedVideo()?.closest('.stage-focused-main')?.style.getPropertyValue('--stage-video-aspect'));
    const paint = () => shareCanvas.getContext('2d').fillRect(0, 0, shareCanvas.width, shareCanvas.height);
    await until(() => { paint(); return Math.abs(focusedAspect() - 16 / 9) < 0.01; }, 'The focused screen did not take its video\'s shape');
    // On its side the frame keeps the whole stage; the name and fullscreen button stay on the picture, not on its black bars.
    const overlaysOnPicture = shape => {
      if (!layout().hasAttribute('data-compact-immersive')) return;
      const video = sharedVideo();
      const frame = video.getBoundingClientRect();
      const scale = Math.min(frame.width / video.videoWidth, frame.height / video.videoHeight);
      const left = frame.left + (frame.width - video.videoWidth * scale) / 2;
      const top = frame.top + (frame.height - video.videoHeight * scale) / 2;
      const right = left + video.videoWidth * scale;
      const bottom = top + video.videoHeight * scale;
      for (const selector of ['.stage-badges-overlay', '.stage-card-controls']) {
        const box = video.closest('.stage-focused-main').querySelector(selector).getBoundingClientRect();
        check(box.left >= left - 0.5 && box.right <= right + 0.5 && box.top >= top - 0.5 && box.bottom <= bottom + 0.5,
          `on its side, ${selector} sits on the ${shape} picture, not across its black bars (${JSON.stringify(box)} ${JSON.stringify({ left, top, right, bottom })})`);
      }
      const name = video.closest('.stage-focused-main').querySelector('.stage-badges-overlay').getBoundingClientRect();
      const buttons = video.closest('.stage-focused-main').querySelector('.stage-card-controls').getBoundingClientRect();
      check(name.right <= buttons.left || name.bottom <= buttons.top,
        `on the ${shape} picture the name and the tile's buttons do not cover each other (${JSON.stringify(name)} ${JSON.stringify(buttons)})`);
    };
    overlaysOnPicture('wide');
    // The sharer turns the phone upright: the frame follows the stream instead of cropping it.
    Object.assign(shareCanvas, { width: 180, height: 320 });
    await until(() => { paint(); return Math.abs(focusedAspect() - 9 / 16) < 0.01; }, 'The focused screen did not follow the turned stream');
    overlaysOnPicture('upright');
    check(true, 'a focused share follows the sharer turning the phone');
    document.querySelector('#stage-btn-grid').click();
    await until(() => !document.querySelector('.stage-focused-main'), 'Back to the grid did not release the watched screen');
    await toggle('navigation');
    document.querySelector('.channel-item[data-channel-type="TEXT"]').click();
    await until(() => visible(document.querySelector('.watched-screen-mini')), 'The thumbnail did not come back with the conversation');
    check(document.querySelector('.watched-screen-mini').dataset.corner === 'bottom-left', 'the thumbnail returns to the corner it was left in');
    document.querySelector('.watched-screen-mini-close').click();
    await until(() => !document.querySelector('.watched-screen-mini'), 'Stopping from the thumbnail did not remove it');
    check(!voiceStore.isWatchingScreen('demo-device', 'demo-share'), 'the thumbnail\'s close button stops watching the screen');
    session.participants.removeRemoteScreenStream('demo-device', 'demo-share');
    shared.getTracks().forEach(track => track.stop());
    shareState(false);
    // A dialog would be a sheet over the call: on a phone a media failure is an alert in the corner that offers the fix.
    appEvents.emit('voice.microphone_failed', { error: 'NotReadableError' });
    await until(() => !!document.querySelector('.chat-copy-toast--notice[role="alert"]'), 'The microphone failure was not announced');
    const failure = document.querySelector('.chat-copy-toast--notice[role="alert"]');
    check(!document.querySelector('.dialog-card') && failure.querySelector('.chat-copy-toast-action')?.textContent === t('voiceJoin.microphoneRetry'),
      'a phone announces a microphone failure in an alert toast with a retry, not a modal over the call');
    withinViewport(failure, 'media failure notice');
    failure.querySelector('.chat-copy-toast-close').click();
    document.querySelector('.voice-conn-info').click();
    await until(() => !!document.querySelector('.stage-call-controls'), 'The call banner did not reopen its stage');
    document.querySelector('[data-compact-call-options]').click();
    voiceStore.setChannel(null);
    await until(() => !document.querySelector('.compact-call-sheet'), 'Ending the call did not revoke its open controls');
    await toggle('navigation');
    document.querySelector('.channel-item[data-channel-type="TEXT"]').click();
    await until(() => layout().dataset.compactPanel === 'content', 'The chat did not become visible after hanging up');
    await toggle('navigation');
    document.querySelector('.channel-item[data-channel-type="FORUM"]').click();
    await until(() => !!document.querySelector('[data-forum-open]'), 'Forum list did not load');
    withinViewport(document.querySelector('.forum-list-pane'), 'forum list');
    document.querySelector('[data-forum-open]').click();
    await until(() => visible(document.querySelector('.forum-discussion-pane')), 'Forum discussion did not open');
    await settleMotion(document.querySelector('.forum-discussion-pane'));
    withinViewport(document.querySelector('.forum-discussion-pane'), 'full-width forum discussion');
    withinViewport(document.querySelector('#chat-forum-back'), 'forum return button');
    check(!visible(document.querySelector('.forum-list-pane')), 'the covered forum list cannot receive focus');
    document.querySelector('#chat-forum-back').click();
    await until(() => document.querySelector('.forum-discussion-pane').hidden, 'Forum discussion did not close');
    withinViewport(document.querySelector('.forum-list-pane'), 'forum list after returning');
  } else {
    voiceStore.setChannel('voice-5401', session.key);
    document.querySelector('.channel-item[data-channel-type="VOICE"]').click();
    await until(() => !!document.querySelector('#stage-btn-chat'), 'The desktop call stage did not open');
    document.querySelector('#stage-btn-chat').click();
    await until(() => !document.querySelector('.voice-channel-chat-panel').hidden, 'The desktop voice chat did not open');
    document.querySelector('.channel-item[data-channel-type="VOICE"]').click();
    await frame();
    check(!document.querySelector('.voice-channel-chat-panel').hidden,
      'desktop stage navigation preserves its accompanying voice chat');
    document.querySelector('.voice-chat-close').click();
    await until(() => document.querySelector('.voice-channel-chat-panel').hidden, 'The desktop voice chat did not close');
    voiceStore.setChannel(null);
  }
  if (compact) {
    await settingsModal.open();
    const card = document.querySelector('.settings-modal-card');
    await settleMotion(card);
    withinViewport(card, 'app settings');
    if (split) {
      const sidebar = card.querySelector('.settings-sidebar');
      const main = card.querySelector('.settings-main-container');
      check(visible(sidebar) && visible(main) && !main.inert
        && main.getBoundingClientRect().left >= sidebar.getBoundingClientRect().right - 1
        && Math.abs(sidebar.getBoundingClientRect().width - 220) < 2,
        'on its side settings show the categories beside the selected category');
      check(card.querySelector('.compact-settings-back').hidden && !visible(card.querySelector('.compact-settings-index-header')),
        'side by side, settings offer no page navigation');
      for (const tab of card.querySelectorAll('.settings-tab-btn')) {
        tab.click();
        await frame();
        check(tab.getAttribute('aria-current') === 'page' && visible(sidebar) && !main.inert
          && !document.documentElement.hasAttribute('data-compact-transition')
          && !document.getAnimations().some(animation => animation.effect?.pseudoElement?.includes('compact-page')),
          `settings ${tab.dataset.tab} opens in place without a page slide`);
        check(tab.getBoundingClientRect().height >= 43.99 && tab.scrollWidth <= tab.clientWidth + 1,
          `settings ${tab.dataset.tab} category is a full touch row that wraps its label`);
        await settleMotion(card);
        const body = card.querySelector('.settings-content-body');
        check(body.scrollWidth <= body.clientWidth + 1,
          `settings ${tab.dataset.tab} reflows without horizontal overflow (${body.scrollWidth}/${body.clientWidth})`);
        withinViewport(card.querySelector('.settings-content-header'), `settings ${tab.dataset.tab} close header`);
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => !card.isConnected, 'Escape did not close side-by-side settings');
      check(!card.isConnected, 'side by side, Escape closes settings directly');
    } else {
      check(visible(card.querySelector('.settings-sidebar')) && card.querySelector('.settings-main-container').inert,
        'settings start at a full-screen category index');
      const categories = [...card.querySelectorAll('.settings-tab-btn')];
      const lastCategory = categories.at(-1);
      categories[0].focus({ preventScroll: true });
      categories[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      await until(() => lastCategory.getBoundingClientRect().bottom
        <= card.querySelector('.settings-sidebar').getBoundingClientRect().bottom + 1,
        'Keyboard navigation did not reveal the last settings category');
      check(document.activeElement === lastCategory, 'End focuses the last settings category');
      withinViewport(lastCategory, 'keyboard-selected settings category');
      const checkPageSlide = async direction => {
        const slides = () => document.getAnimations().filter(animation => animation.effect?.pseudoElement?.includes('compact-page'));
        await until(() => slides().length === 2, 'The real settings screen did not start its lateral slide');
        const active = slides();
        active.forEach(animation => {
          animation.pause();
          animation.currentTime = animation.effect.getComputedTiming().duration / 4;
        });
        await frame();
        const before = active.map(animation => animation.effect.getComputedTiming().progress);
        active.forEach(animation => { animation.currentTime = animation.effect.getComputedTiming().duration * 3 / 4; });
        await frame();
        check(slides().length === 2 && active.every((animation, index) =>
          before[index] > 0 && animation.effect.getComputedTiming().progress > before[index]
          && animation.effect.getComputedTiming().progress < 1), 'Real settings snapshots remain visible and advance after repaint');
        check(slides().some(animation => animation.effect.getKeyframes()[0].transform === `translateX(${direction * 100}%)`),
          `Settings ${direction === 1 ? 'entry' : 'back'} slides from the correct side`);
        active.forEach(animation => animation.play());
      };
      let verifySlide = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      for (const tab of card.querySelectorAll('.settings-tab-btn')) {
        if (verifySlide) document.documentElement.style.setProperty('--motion-step-duration', '1000ms');
        tab.click();
        await until(() => visible(card.querySelector('.settings-main-container')), 'The settings category did not become visible');
        if (verifySlide) await checkPageSlide(1);
        await frame();
        await settleMotion(card);
        const body = card.querySelector('.settings-content-body');
        check(body.scrollWidth <= body.clientWidth + 1,
          `settings ${tab.dataset.tab} reflows without horizontal overflow (${body.scrollWidth}/${body.clientWidth})`);
        withinViewport(card.querySelector('.settings-content-header'), `settings ${tab.dataset.tab} close header`);
        check(!visible(card.querySelector('.settings-sidebar')), 'a settings category replaces, rather than squeezes beside, the index');
        card.querySelector('.compact-settings-back').click();
        await until(() => visible(card.querySelector('.settings-sidebar')), 'The settings index did not return');
        if (verifySlide) {
          await checkPageSlide(-1);
          await until(() => !document.documentElement.hasAttribute('data-compact-transition'), 'Settings back animation did not finish');
          document.documentElement.style.removeProperty('--motion-step-duration');
          verifySlide = false;
        }
        check(visible(card.querySelector('.settings-sidebar')) && card.querySelector('.settings-main-container').inert,
          'back restores the settings category index and hides its detail from the keyboard');
      }
      card.querySelector('.settings-tab-btn').click();
      await until(() => visible(card.querySelector('.settings-main-container')), 'The settings detail did not open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => visible(card.querySelector('.settings-sidebar')), 'Escape did not return to settings categories');
      check(visible(card.querySelector('.settings-sidebar')) && card.isConnected,
        'Escape goes back to the settings index before dismissing the modal');
    }
    await closeModals();
    const serverFeatures = session.serverStore.serverDetails.protocol.features;
    session.serverStore.serverDetails.protocol.features = [
      ...serverFeatures, 'recent-sounds', 'dm-relay', 'afk-channel',
    ];
    serverSettingsModal.open();
    const serverCard = document.querySelector('.server-settings-modal-card');
    await settleMotion(serverCard);
    withinViewport(serverCard, 'server settings');
    for (const tab of serverCard.querySelectorAll('.settings-tab-btn')) {
      tab.click();
      await until(() => visible(serverCard.querySelector('.settings-main-container')), 'The server settings category did not become visible');
      await frame();
      const body = serverCard.querySelector('.settings-content-body');
      check(body.scrollWidth <= body.clientWidth + 1,
        `server settings ${tab.dataset.tab} reflows without horizontal overflow (${body.scrollWidth}/${body.clientWidth})`);
      const panel = serverCard.querySelector(`#tab-panel-${tab.dataset.tab}`);
      const rows = [...panel.querySelectorAll('.settings-switch-row')].filter(visible);
      if (tab.dataset.tab === 'voice_video') {
        check(rows.length === 5, 'all voice/video switch cards participate in the compact layout');
      }
      for (const row of rows) {
        const control = row.querySelector(':scope > .toggle-switch');
        const controlBox = control.getBoundingClientRect();
        const copy = row.firstElementChild;
        const title = copy.tagName === 'DIV' ? copy.firstElementChild : copy;
        const titleBox = title.getBoundingClientRect();
        check(controlBox.width >= 43.99 && controlBox.height >= 43.99
          && titleBox.right <= controlBox.left - 8
          && Math.abs(titleBox.top + titleBox.height / 2 - controlBox.top - controlBox.height / 2) < 1,
          `server settings ${tab.dataset.tab}: switches have their own 44px slot aligned with the title: ${
            JSON.stringify({ id: control.querySelector('input').id, control: controlBox.toJSON(), title: titleBox.toJSON() })}`);
        const track = control.querySelector('.toggle-slider').getBoundingClientRect();
        check(Math.abs(track.width - 36) < 0.01 && Math.abs(track.height - 20) < 0.01,
          'the larger switch touch target preserves the standard visual track size');
        const descriptions = copy.tagName === 'DIV' ? [...copy.children].slice(1).filter(visible) : [];
        for (const description of descriptions) {
          const box = description.getBoundingClientRect();
          check(box.top >= Math.max(titleBox.bottom, controlBox.bottom) - 1
            && box.right >= controlBox.right - 1 && box.left <= titleBox.left + 1
            && parseFloat(getComputedStyle(description).fontSize) >= 13,
            `server settings ${tab.dataset.tab}: descriptions use a readable full-width row below the switch`);
        }
      }
      const footer = serverCard.querySelector('#form-server-settings > .modal-footer');
      const done = footer.querySelector('#btn-done').getBoundingClientRect();
      const hint = footer.querySelector('#server-settings-status').getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      check(Math.abs(done.left - footerBox.left - 12) < 1
        && Math.abs(footerBox.right - done.right - 12) < 1 && done.height >= 44 && hint.bottom <= done.top,
        'the server settings footer stacks its status above a full-width Done action');
      if (!split) {
        serverCard.querySelector('.compact-settings-back').click();
        await until(() => visible(serverCard.querySelector('.settings-sidebar')), 'The server settings index did not return');
      }
    }
    await closeModals();
    session.serverStore.serverDetails.protocol.features = serverFeatures;

    const { contextMenu } = await import('/views/ContextMenu.ts');
    const anchor = document.querySelector('#bar-btn-settings');
    contextMenu.open(width - 1, height - 1, Array.from({ length: 20 }, (_, index) => ({
      label: `${t('common.moreOptions')} ${index}`, onClick: () => {},
    })), anchor);
    await frame();
    withinViewport(document.querySelector('.floating-context-menu'), 'long context menu');
    contextMenu.close();
    await until(() => !document.querySelector('.floating-context-menu'), 'Context menu did not close');

    const { EmojiPicker } = await import('/views/EmojiPicker.ts');
    const picker = new EmojiPicker({
      container: document.body, anchor, floating: true, emojiOnly: true, onSelectEmoji() {},
    });
    picker.open();
    await settleMotion(document.querySelector('.emoji-picker'));
    withinViewport(document.querySelector('.emoji-picker'), 'floating emoji picker');
    picker.destroy();
    await until(() => !document.querySelector('.emoji-picker'), 'Emoji picker did not close');

    const audio = document.querySelector('[data-audio-device="input"]');
    audio.click();
    await until(() => !!document.querySelector('.audio-device-popover'), 'Audio device popover did not open');
    await settleMotion(document.querySelector('.audio-device-popover'));
    withinViewport(document.querySelector('.audio-device-popover'), 'audio device picker');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => !document.querySelector('.audio-device-popover'), 'Audio device picker did not close');
  }
  check(settingsStore.navigationSidebarHidden === preferences[0] && settingsStore.membersSidebarHidden === preferences[1],
    'compact navigation never rewrites desktop sidebar preferences');
  check(document.documentElement.scrollWidth <= width, 'the page has no horizontal scrolling');
  document.querySelector('#server-rail-home').click();
  await until(() => !!document.querySelector('.home-sidebar-shell'), 'Home did not return');
  appEvents.emit('dm.open', 'a'.repeat(64));
  await until(() => !!document.querySelector('#chat-message-input'), 'DM did not return');
  const nextInput = document.querySelector('#chat-message-input');
  nextInput.value = 'draft across viewport changes';
  nextInput.dispatchEvent(new Event('input', { bubbles: true }));
  window.responsiveDraft = { input: nextInput, footer: document.querySelector('.user-control-bar') };
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
    signChallenge: async nonce => ({ signature: `fixture-signature:${nonce}` }),
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
        const challenge = () => this.reply(MessageType.AUTH_CHALLENGE, message.requestId, { nonce: String(this.port).padStart(64, '0') });
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
