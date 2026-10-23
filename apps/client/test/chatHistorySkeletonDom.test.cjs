const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Opening a channel or a direct conversation shows message-shaped placeholders
// until its history arrives, never an "empty channel" message or a blank feed.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('chat and direct-message history show skeletons while loading', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `history-skeleton-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_HISTORY_SKELETON_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(result, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_HISTORY_SKELETON_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('History skeleton DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'history-skeleton-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__history_skeleton__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head>'
              + '<body><div id="app" style="height:100vh;display:flex;flex-direction:column"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, true);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const waitFor = async (expression, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await frames();
      }
      return false;
    };
    const check = async (condition, message) => {
      if (!condition) throw new Error(`${message}: ${await evaluate("document.querySelector('#app').innerHTML.slice(0, 600)")}`);
    };
    const skeleton = (feed) => `!!document.querySelector('${feed} > .loading-skeleton--messages[role="status"] .loading-skeleton-avatar')`;
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__history_skeleton__`);
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // Channel with no known messages: placeholders, not the empty-channel text.
      await evaluate('window.fixture.openChannel("busy")');
      await check(await evaluate(skeleton('#chat-messages-feed')), 'an unloaded channel shows message skeletons');
      await check(await evaluate(`!document.querySelector('#chat-empty-placeholder')`), 'the empty-channel message waits for the history');
      await check(await evaluate(`window.fixture.requests.some(item => item.channelId === 'busy')`), 'the history is requested');
      await evaluate('window.fixture.deliver("busy", 3)');
      await check(await waitFor(`document.querySelectorAll('#chat-messages-feed .chat-message-row').length === 3`), 'the history replaces the skeleton');
      await check(await evaluate(`!document.querySelector('#chat-messages-feed .loading-skeleton')`), 'no placeholder remains');

      // A genuinely empty channel ends on the empty-channel message.
      await evaluate('window.fixture.openChannel("quiet")');
      await check(await evaluate(skeleton('#chat-messages-feed')), 'the second channel starts with skeletons too');
      await evaluate('window.fixture.deliver("quiet", 0)');
      await check(await waitFor(`!!document.querySelector('#chat-empty-placeholder')`), 'an empty history shows the empty-channel message');

      // Already loaded: going back shows the messages at once, no skeleton flash.
      await evaluate('window.fixture.openChannel("busy")');
      await check(await evaluate(`!document.querySelector('#chat-messages-feed .loading-skeleton') && document.querySelectorAll('#chat-messages-feed .chat-message-row').length === 3`),
        'a channel with cached messages renders them immediately');

      // A live message that beats the history removes the placeholders.
      await evaluate('window.fixture.openChannel("live")');
      await check(await evaluate(skeleton('#chat-messages-feed')), 'the live channel starts with skeletons');
      await evaluate('window.fixture.live("live")');
      await check(await waitFor(`!document.querySelector('#chat-messages-feed .loading-skeleton') && document.querySelectorAll('#chat-messages-feed .chat-message-row').length === 1`),
        'a live message replaces the skeleton');
      await evaluate('window.fixture.closeChannel()');

      // Direct messages: skeleton until the local history answers.
      await evaluate('window.fixture.openDm()');
      await check(await waitFor(skeleton('[data-dm-feed]')), 'a direct conversation shows skeletons while loading');
      await evaluate('window.fixture.releaseDm()');
      await check(await waitFor(`document.querySelectorAll('[data-dm-feed] .chat-message-row').length === 2 && !document.querySelector('[data-dm-feed] .loading-skeleton')`),
        'the conversation replaces the skeleton');
      await evaluate('window.fixture.closeDm()');

      // A failed load does not leave placeholders behind.
      await evaluate('window.fixture.openDm(true)');
      await check(await waitFor(skeleton('[data-dm-feed]')), 'the failing conversation starts with skeletons');
      await evaluate('window.fixture.releaseDm()');
      await check(await waitFor(`!!document.querySelector('[data-dm-feed]') && !document.querySelector('[data-dm-feed] .loading-skeleton')`),
        'a failed load clears the skeleton');
      await evaluate('window.fixture.closeDm()');
      console.log('History skeleton DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupFixture() {
  localStorage.clear();
  const [{ ChatView }, { sessionManager }, language, { dmStore }, { DmConversationView }] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/i18n/index.ts'),
    import('/stores/dmStore.ts'), import('/views/home/DmConversationView.ts'),
  ]);
  language.setLanguage('en');
  const root = document.getElementById('app');
  const me = { id: 'skeleton-me', clientId: 'skeleton-device', nickname: 'Me', status: 'ONLINE', joinedAt: 1 };
  sessionManager.install();
  const session = sessionManager.create('history-skeleton.local', 49311, me.nickname);
  const channel = (id, position) => ({ id, name: id, serverId: 'skeleton-server', type: 'TEXT', position, createdAt: 1,
    isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true });
  session.serverStore.setServerDetails({
    id: 'skeleton-server', name: 'Skeleton', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: ['busy', 'quiet', 'live'].map(channel), members: [me], knownMembers: [me], roles: [], userRoles: [],
    myPermissions: 2147483647 & ~(1 << 11), ownerId: 'someone-else',
  }, me);
  const requests = [];
  session.client.getStatus = () => 'CONNECTED';
  session.client.getCurrentServerUrl = () => session.key;
  session.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  session.client.send = (type, payload) => { if (payload?.limit) requests.push({ type, channelId: payload.channelId }); };
  session.client.sendRequest = () => Promise.resolve({ selectors: [] });
  sessionManager.activate(session.key);
  const message = (channelId, index) => ({ id: `${channelId}-${index}`, channelId, userId: me.id, userNickname: me.nickname,
    createdAt: Date.UTC(2026, 9, 16, 12) + index * 60_000, isSystem: false, content: `Message ${index}` });

  const chatRoot = document.createElement('div');
  chatRoot.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
  root.appendChild(chatRoot);
  let chat = new ChatView(chatRoot);

  const peer = 'a'.repeat(64);
  const otherPeer = 'b'.repeat(64);
  const friend = (publicKey, nickname) => ({ publicKey, nickname, avatar: null, relation: 'friend',
    blocked: false, friendSince: 1, requestedAt: null, maxFileBytes: 1024 });
  const summary = (key) => ({ peer: key, lastMessageAt: 2, lastMessagePreview: '', lastMessageAuthor: key, unread: 0, hidden: false, readOnly: false });
  const ok = value => Promise.resolve({ ok: true, value });
  let gate = null;
  let failNext = false;
  const handlers = {
    snapshot: () => ok({ me: { publicKey: 'f'.repeat(64) }, peers: [friend(peer, 'Friend'), friend(otherPeer, 'Other')],
    conversations: [summary(peer), summary(otherPeer)], settings: { maxFileBytes: 1024 } }),
    conversation: async () => {
      await new Promise(resolve => { gate = resolve; });
      if (failNext) return { ok: false, error: { code: 'storage' } };
      return { ok: true, value: { peer, hasMore: false, peerReadAt: 0, messages: [1, 2].map(index => ({
        id: `dm-${index}`, peer, author: peer, content: `Hello ${index}`, createdAt: Date.now() - (3 - index) * 1000,
        editedAt: null, deleted: false, replyTo: null, reactions: [], attachments: [], delivery: null,
      })) } };
    },
    pendingPeers: () => ok([]),
    onEvent: () => () => {},
  };
  window.api = { dm: new Proxy({}, { get: (_target, name) => handlers[name] ?? (() => ok({})) }), openExternal: async () => ({ success: true }) };
  await dmStore.init();
  let dmView = null;
  const dmRoot = document.createElement('div');
  dmRoot.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';

  window.fixture = {
    requests,
    openChannel: (id) => chat.setChannel(id),
    deliver: (id, count) => session.chatStore.setHistory(id, Array.from({ length: count }, (_, index) => message(id, index))),
    live: (id) => session.chatStore.addMessage(message(id, 99)),
    closeChannel: () => { chat.destroy(); chatRoot.remove(); chat = null; root.appendChild(dmRoot); },
    openDm: (fail = false) => {
      failNext = fail;
      dmView = new DmConversationView(fail ? otherPeer : peer);
      dmView.mount(dmRoot);
    },
    releaseDm: () => gate?.(),
    closeDm: () => { dmView?.destroy(); dmRoot.innerHTML = ''; },
  };
}
