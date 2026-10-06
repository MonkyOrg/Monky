const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('the server rail reorders every server with a real pointer drag, including the connected one', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `rail-reorder-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_RAIL_REORDER_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_RAIL_REORDER_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Rail reorder DOM timeout'); void finish(1); }, 90000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'rail-reorder-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__rail__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head>' +
              '<body><div class="server-rail" id="server-rail" style="height: 560px"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 400, height: 600, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, true);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const center = (selector) => evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), bottom: Math.round(box.bottom) };
    })()`);
    // Real Chromium input: the same path a user's mouse takes, not synthetic DOM events.
    const drag = async (from, to, midway) => {
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...from });
      await new Promise(resolve => setTimeout(resolve, 20));
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...from });
      for (let step = 1; step <= 10; step++) {
        browser.webContents.sendInputEvent({
          type: 'mouseMove', modifiers: ['leftButtonDown'],
          x: Math.round(from.x + (to.x - from.x) * step / 10), y: Math.round(from.y + (to.y - from.y) * step / 10),
        });
        await new Promise(resolve => setTimeout(resolve, 15));
        if (step === 5 && midway) await midway();
      }
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...to });
      await new Promise(resolve => setTimeout(resolve, 60));
      await frames();
    };
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__rail__`);
      const setup = await evaluate(`(${setupRail.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);
      const order = () => evaluate('window.railOrder()');
      const check = async (condition, message) => {
        if (!condition) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.railState()'))}`);
      };

      await check(JSON.stringify(await order()) === '[5101,5102,5103]', 'fixture starts in saved order');
      await check(await evaluate(`(() => {
        const icon = document.querySelector('.server-rail-item.active[data-port="5101"] img');
        return !!icon && icon.getAttribute('draggable') === 'false' && getComputedStyle(icon).webkitUserDrag === 'none';
      })()`), 'the connected server shows its icon, which is never dragged as an image');

      // The connected server, dragged by its icon to the end, while background
      // activity repaints the rail mid-drag.
      const connected = await center('.server-rail-item.active[data-port="5101"] img');
      const last = await center('.server-rail-item[data-port="5103"]');
      await drag(connected, { x: last.x, y: last.bottom - 4 }, async () => {
        await evaluate(`import('/core/EventBus.ts').then(({ appEvents }) => appEvents.emit('community.updated'))`);
        await check(await evaluate(`!!document.querySelector('.server-rail--dragging .server-rail-item.dragging[data-port="5101"]')`),
          'a repaint during the drag keeps the dragged server marked');
      });
      await check(JSON.stringify(await order()) === '[5102,5103,5101]', 'the connected server moves to the end');
      await check(await evaluate('window.connectCalls === 0'), 'releasing a drag never opens the dragged server');
      await check(await evaluate(`!document.querySelector('.server-rail--dragging, .dragging, .server-rail-drop-zone.active')`),
        'drag styling is cleared after the drop');

      // An offline server without an icon goes to the top.
      const offline = await center('.server-rail-item[data-port="5103"]');
      const first = await center('.server-rail-item[data-port="5102"]');
      await drag(offline, { x: first.x, y: first.y - 12 });
      await check(JSON.stringify(await order()) === '[5103,5102,5101]', 'any server can be moved above the others');

      // A short press is still a click, not a drag.
      const click = await center('.server-rail-item[data-port="5102"] .server-rail-avatar');
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...click });
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...click });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...click });
      await frames();
      await new Promise(resolve => setTimeout(resolve, 30));
      await check(await evaluate('window.connectCalls === 1'), 'a plain click still opens the server');
      await check(JSON.stringify(await order()) === '[5103,5102,5101]', 'a plain click does not reorder');

      // Servers enter and leave folders by dropping on the folder header.
      await evaluate(`window.createFolder()`);
      const folderHeader = await center('.server-rail-folder-header');
      const connectedAgain = await center('.server-rail-item[data-port="5101"]');
      await drag(connectedAgain, folderHeader);
      await check(JSON.stringify(await order()) === '[5103,5102,"folder:5101"]', 'a server moves into a folder');
      console.log('Server rail reorder DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupRail() {
  localStorage.clear();
  const saved = (host, port, lastConnected) => ({ host, port, name: host, lastConnected });
  localStorage.setItem('monky_saved_servers', JSON.stringify([
    saved('a.test', 5101, 3), saved('b.test', 5102, 2), saved('c.test', 5103, 1),
  ]));
  window.fetch = async () => { throw new Error('offline fixture'); };
  const [{ connectionStore }, { sessionManager }, { serverRailView }] = await Promise.all([
    import('/stores/connectionStore.ts'), import('/core/SessionManager.ts'), import('/views/ServerRailView.ts'),
  ]);
  connectionStore.loadSavedServers();
  connectionStore.loadRailLayout();
  const session = sessionManager.create('a.test', 5101, 'Fixture');
  session.serverStore.serverDetails = {
    id: 'server-a', name: 'A', iconUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2244%22 height=%2244%22%3E%3Crect width=%2244%22 height=%2244%22 fill=%22%23e44%22/%3E%3C/svg%3E',
    channels: [], categories: [], members: [], knownMembers: [], voiceStates: {}, roles: [], userRoles: [],
  };
  sessionManager.activate(session.key);
  window.connectCalls = 0;
  serverRailView.connectToSavedServer = async () => { window.connectCalls++; };
  window.railOrder = () => connectionStore.railLayout.flatMap(node => node.type === 'server'
    ? [node.port] : node.children.map(child => `folder:${child.port}`));
  window.railState = () => ({ order: window.railOrder(), html: document.querySelector('#server-rail').innerHTML.slice(0, 600) });
  window.createFolder = () => connectionStore.createFolder('Group');
  const { appEvents } = await import('/core/EventBus.ts');
  appEvents.on('connection.saved_servers_changed', () => serverRailView.render());
  serverRailView.render();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (!document.querySelector('.server-rail-item.active[data-port="5101"] img')) throw new Error('The connected server did not render with its icon');
}
