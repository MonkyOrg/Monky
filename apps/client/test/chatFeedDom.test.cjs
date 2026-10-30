const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// The channel feed mirrors the store: it holds the same newest messages the
// store keeps (R-CHAT-6), and marks as "mentions me" exactly what the sound and
// the @ badge treat as a mention (R-SHELL-6).
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('the chat feed follows the store window and the shared mention rule', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `chat-feed-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_CHAT_FEED_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_CHAT_FEED_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Chat feed DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'chat-feed-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__chat_feed__') return next();
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
    const check = async (condition, message) => {
      if (!condition) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.fixture.state()'))}`);
    };
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__chat_feed__`);
      // Instant scrolling keeps the reading-position check free of animations in flight.
      browser.webContents.debugger.attach('1.3');
      await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // 240 messages of history, then 60 live ones: the store keeps the newest 250.
      await evaluate('window.fixture.open(240)');
      await check((await evaluate('window.fixture.state()')).rows === 240, 'the history is drawn');
      await evaluate('window.fixture.live(240, 60)');
      let state = await evaluate('window.fixture.state()');
      await check(state.rows === 250 && state.stored === 250 && state.first === 'busy-50' && state.orphans === 0
        && state.dividers === 1 && state.unknown === 0,
      'the feed drops the rows the store let go of, with the divider of a day left empty');
      await check(await evaluate('window.fixture.firstRowMenu()') >= 2, 'the oldest row left keeps its message actions');

      // Someone reading further up keeps the same messages in view while rows above leave.
      const before = await evaluate('window.fixture.readMiddle()');
      await evaluate('window.fixture.live(300, 1)');
      const after = await evaluate(`window.fixture.rowTop(${JSON.stringify(before.id)})`);
      state = await evaluate('window.fixture.state()');
      await check(state.rows === 250 && state.first === 'busy-51' && Math.abs(after - before.top) <= 1,
        `the reading position stays put (${before.top} → ${after})`);

      // The row highlight follows the rule of the sound and the @ badge.
      await evaluate(`window.fixture.say([
        ['prefix', 'oi @Lucas, tudo bem?'], ['bold', '**@lu** vem ver'], ['everyone', 'bom dia @todos'],
        ['code', 'use \`@Lu\` no código'], ['mail', 'escreva para lu@exemplo.com'],
      ])`);
      const marked = () => evaluate('window.fixture.mentioned()');
      const expected = JSON.stringify({ prefix: false, bold: true, everyone: true, code: false, mail: false });
      await check(JSON.stringify(await marked()) === expected, 'only whole mentions of the reader highlight live rows');
      await evaluate('window.fixture.redraw()');
      await check(JSON.stringify(await marked()) === expected, 'a full redraw highlights the same rows');
      console.log('Chat feed DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupFixture() {
  localStorage.clear();
  const [{ ChatView }, { sessionManager }, language, { contextMenu }] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/i18n/index.ts'), import('/views/ContextMenu.ts'),
  ]);
  language.setLanguage('en');
  const root = document.getElementById('app');
  const me = { id: 'feed-me', clientId: 'feed-device', nickname: 'Lu', status: 'ONLINE', joinedAt: 1 };
  const lucas = { id: 'feed-lucas', clientId: 'feed-lucas-device', nickname: 'Lucas', status: 'ONLINE', joinedAt: 1 };
  sessionManager.install();
  const session = sessionManager.create('chat-feed.local', 49312, me.nickname);
  session.serverStore.setServerDetails({
    id: 'feed-server', name: 'Feed', createdAt: 1, maxUsers: 10, voiceStates: {}, allowEveryoneMention: true,
    channels: [{ id: 'busy', name: 'busy', serverId: 'feed-server', type: 'TEXT', position: 0, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true }],
    members: [me, lucas], knownMembers: [me, lucas], roles: [], userRoles: [],
    myPermissions: 2147483647 & ~(1 << 11), ownerId: 'someone-else',
  }, me);
  session.client.getStatus = () => 'CONNECTED';
  session.client.getCurrentServerUrl = () => session.key;
  session.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  session.client.send = () => {};
  session.client.sendRequest = () => Promise.resolve({ selectors: [] });
  sessionManager.activate(session.key);
  // The ten oldest messages belong to an earlier day than the rest.
  const message = (index, content = `Message ${index}`) => ({
    id: `busy-${index}`, channelId: 'busy', userId: lucas.id, userNickname: lucas.nickname, isSystem: false, content,
    createdAt: index < 10 ? Date.UTC(2026, 9, 14, 12) + index * 60_000 : Date.UTC(2026, 9, 16, 8) + index * 60_000,
  });
  const chatRoot = document.createElement('div');
  chatRoot.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';
  root.appendChild(chatRoot);
  const chat = new ChatView(chatRoot);
  const feed = () => document.getElementById('chat-messages-feed');
  const rows = () => [...feed().querySelectorAll(':scope > .chat-message-row')];
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  let spoken = 0;
  const said = new Map();

  window.fixture = {
    open: (count) => {
      chat.setChannel('busy');
      session.chatStore.setHistory('busy', Array.from({ length: count }, (_, index) => message(index)));
    },
    live: (from, count) => {
      for (let index = from; index < from + count; index++) session.chatStore.addMessage(message(index));
    },
    state: () => {
      const stored = new Set(session.chatStore.getMessages('busy').map(entry => entry.id));
      const children = [...feed().children];
      return {
        rows: rows().length,
        stored: stored.size,
        first: rows()[0]?.dataset.messageId,
        unknown: rows().filter(row => !stored.has(row.dataset.messageId)).length,
        dividers: children.filter(child => child.classList.contains('chat-date-divider')).length,
        orphans: children.filter((child, index) => child.classList.contains('chat-date-divider')
          && (!children[index + 1] || children[index + 1].classList.contains('chat-date-divider'))).length,
      };
    },
    firstRowMenu: async () => {
      const more = rows()[0].querySelector('[data-message-action="more"]');
      more.click();
      await frames();
      const items = document.querySelectorAll('.floating-context-menu [role^="menuitem"]').length;
      contextMenu.close();
      return items;
    },
    readMiddle: async () => {
      await frames();
      const target = rows()[120];
      feed().scrollTop += target.getBoundingClientRect().top - feed().getBoundingClientRect().top - 200;
      await frames();
      return { id: target.dataset.messageId, top: target.getBoundingClientRect().top };
    },
    rowTop: async (id) => {
      await frames();
      return feed().querySelector(`.chat-message-row[data-message-id="${id}"]`).getBoundingClientRect().top;
    },
    say: (entries) => {
      for (const [key, content] of entries) {
        const entry = message(1000 + spoken++, content);
        said.set(key, entry.id);
        session.chatStore.addMessage(entry);
      }
    },
    mentioned: () => Object.fromEntries([...said].map(([key, id]) => [key,
      !!feed().querySelector(`.chat-message-row.chat-message-mentioned[data-message-id="${id}"]`)])),
    redraw: () => chat.render(),
  };
}
