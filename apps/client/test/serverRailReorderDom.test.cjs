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
    // Chromium delivers mouse moves aligned to animation frames, so on a slow
    // runner they can still be queued when the next script runs: wait for the
    // effect instead of assuming it after a fixed delay.
    const waitFor = async (expression, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await frames();
      }
      return false;
    };
    const center = (selector) => evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), bottom: Math.round(box.bottom) };
    })()`);
    // Real Chromium input: the same path a user's mouse takes, not synthetic DOM events.
    const drag = async (from, to, midway, beforeRelease) => {
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
      if (beforeRelease) {
        await frames();
        await beforeRelease();
      }
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...to });
      await waitFor(`!document.querySelector('.server-rail--dragging')`);
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
        await check(await waitFor(`!!document.querySelector('.server-rail--dragging')`), 'the drag starts before the repaint');
        await evaluate(`import('/core/EventBus.ts').then(({ appEvents }) => appEvents.emit('community.updated'))`);
        await frames();
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

      // Like Discord: holding a server over the middle of another previews a
      // folder and dropping it there groups both, in place of the target.
      const connectedAgain = await center('.server-rail-item[data-port="5101"]');
      const groupTarget = await center('.server-rail-item[data-port="5102"]');
      await drag(connectedAgain, groupTarget, null, async () => {
        await check(await waitFor(`!!document.querySelector('.server-rail-item.combine-target[data-port="5102"]')`),
          'the target previews the folder while hovered');
      });
      await check(JSON.stringify(await order()) === '[5103,"folder:5102","folder:5101"]', 'dropping on a server creates a folder with both');
      await check(await evaluate(`document.querySelector('.server-rail-folder:not(.collapsed) .server-rail-folder-header')?.getAttribute('aria-label') === 'b.test, a.test'`),
        'an unnamed folder is labelled after its servers');

      // Near an edge the line shows instead and nothing is grouped.
      const loose = await center('.server-rail-item[data-port="5103"]');
      const folderTile = await evaluate(`(() => {
        const box = document.querySelector('.server-rail-folder-header').getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), bottom: Math.round(box.bottom) };
      })()`);
      await drag(loose, folderTile, null, async () => {
        await check(await waitFor(`!!document.querySelector('.server-rail-folder-header.drag-over')`), 'the folder highlights while a server is held over it');
      });
      await check(JSON.stringify(await order()) === '["folder:5102","folder:5101","folder:5103"]', 'dropping on a folder adds the server to it');

      // Settings: name and colour.
      await evaluate(`window.openFolderSettings()`);
      await check(await waitFor(`!!document.querySelector('.folder-settings-modal')`), 'folder settings open');
      await evaluate(`(() => {
        const input = document.querySelector('#folder-settings-name');
        input.value = 'Amigos';
        document.querySelector('[data-folder-color="#e91e63"]').click();
      })()`);
      await check(await evaluate(`document.querySelector('[data-folder-color="#e91e63"]').getAttribute('aria-checked') === 'true'`), 'the chosen colour is selected');
      const done = await center('[data-folder-settings-done]');
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...done });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...done });
      await check(await waitFor(`window.folderState()?.name === 'Amigos' && window.folderState()?.color === '#e91e63'`), 'Done saves the name and colour');
      await check(await evaluate(`document.querySelector('.server-rail-folder').style.getPropertyValue('--folder-color') === '#e91e63'`), 'the rail paints the folder colour');

      // Collapsed, the folder becomes a tile with its servers in miniature.
      await evaluate(`window.collapseAll()`);
      await check(await waitFor(`document.querySelectorAll('.server-rail-folder.collapsed .server-rail-folder-mini').length === 3`), 'a collapsed folder shows its servers in miniature');
      // Opening and closing slide the servers in and out instead of snapping.
      const clickAt = async (point) => {
        browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
        await frames();
      };
      const children = `document.querySelector('.server-rail-folder-children')`;
      await clickAt(await center('.server-rail-folder-header'));
      await check(await waitFor(`!`+children+`.hidden && `+children+`.getAnimations().length > 0`), 'opening a folder animates its servers in');
      await check(await waitFor(`!`+children+`.hidden && `+children+`.getAnimations().length === 0 && `+children+`.getBoundingClientRect().height > 80`),
        'the opened folder settles at full height');
      await clickAt(await center('.server-rail-folder-header'));
      await check(await evaluate(`!`+children+`.hidden && document.querySelector('.server-rail-folder--closing') && `+children+`.getAnimations().length > 0`),
        'closing keeps the servers and tint visible while they slide out');
      await check(await waitFor(``+children+`.hidden && !document.querySelector('.server-rail-folder--closing')`), 'the closed folder hides its servers when done');
      await clickAt(await center('.server-rail-folder-header'));
      await check(await waitFor(`!`+children+`.hidden && `+children+`.getAnimations().length === 0`), 'the folder opens again');

      // Icons morph from a circle into a rounded square, and the picture follows the shape.
      await check(await evaluate(`[...document.querySelectorAll('.server-rail-avatar > img')].every(img => getComputedStyle(img).clipPath === 'none')`),
        'server pictures are not clipped to a fixed circle');
      const hoverTarget = await center('.server-rail-item[data-port="5102"] .server-rail-avatar');
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...hoverTarget });
      await check(await waitFor(`getComputedStyle(document.querySelector('.server-rail-item[data-port="5102"] .server-rail-avatar')).borderRadius === '16px'`),
        'hovering a server rounds it into a square');
      browser.webContents.sendInputEvent({ type: 'mouseMove', x: 300, y: 300 });
      await check(await waitFor(`getComputedStyle(document.querySelector('.server-rail-item[data-port="5102"] .server-rail-avatar')).borderRadius === '50%'`),
        'leaving it turns it back into a circle');

      // Dragging servers out until one is left dissolves the folder.
      const leaving = await center('.server-rail-item[data-port="5103"]');
      const top = await center('.server-rail-folder-header');
      await drag(leaving, { x: top.x, y: top.y - 26 });
      await check(JSON.stringify(await order()) === '[5103,"folder:5102","folder:5101"]', 'a server can leave the folder');
      const leavingToo = await center('.server-rail-item[data-port="5101"]');
      const head = await center('.server-rail-item[data-port="5103"]');
      await drag(leavingToo, { x: head.x, y: head.y - 22 });
      await check(JSON.stringify(await order()) === '[5101,5103,5102]', 'a folder left with one server gives way to it');
      await check(await evaluate(`!document.querySelector('.server-rail-folder')`), 'no empty or single-server folder remains');
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
  window.railState = () => {
    const rail = document.querySelector('#server-rail');
    return {
      order: window.railOrder(),
      dragging: rail.classList.contains('server-rail--dragging'),
      marked: [...rail.querySelectorAll('.dragging')].map(node => node.dataset.port ?? node.dataset.folderId),
      html: rail.innerHTML.slice(0, 600),
    };
  };
  const { folderSettingsModal } = await import('/views/FolderSettingsModal.ts');
  const folder = () => connectionStore.railLayout.find(node => node.type === 'folder');
  window.folderState = () => folder() && { name: folder().name, color: folder().color };
  window.openFolderSettings = () => folderSettingsModal.open(folder().id);
  window.collapseAll = () => connectionStore.collapseAllFolders();
  const { appEvents } = await import('/core/EventBus.ts');
  appEvents.on('connection.saved_servers_changed', () => serverRailView.render());
  serverRailView.render();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (!document.querySelector('.server-rail-item.active[data-port="5101"] img')) throw new Error('The connected server did not render with its icon');
}
