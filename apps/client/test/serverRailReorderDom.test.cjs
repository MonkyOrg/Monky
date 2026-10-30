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
      // Set explicitly: CI runners may report reduced motion on their own,
      // which would skip the folder animations checked below.
      browser.webContents.debugger.attach('1.3');
      const motion = (value) => browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value }],
      });
      await motion('no-preference');
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
        // The rail, not the item, keeps the pointer: a repaint replaces every item (R-SHELL-12).
        const repaint = await evaluate(`(() => {
          const rail = document.querySelector('#server-rail');
          const before = rail.querySelector('.server-rail-item[data-port="5101"]');
          const held = rail.hasPointerCapture(1);
          window.repaintRail('#36c');
          const replaced = rail.querySelector('.server-rail-item[data-port="5101"]') !== before;
          return { held, replaced, stillHeld: rail.hasPointerCapture(1) };
        })()`);
        await check(repaint.held && repaint.replaced && repaint.stillHeld, `the rail keeps the pointer through a repaint ${JSON.stringify(repaint)}`);
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

      // Escape cancels a drag, and releasing afterwards over the server it started on
      // neither moves nor opens it: that click belongs to the drag (R-SHELL-12).
      const held = await center('.server-rail-item[data-port="5102"] .server-rail-avatar');
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...held });
      await new Promise(resolve => setTimeout(resolve, 20));
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...held });
      browser.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: held.x, y: held.y + 40 });
      await check(await waitFor(`!!document.querySelector('.server-rail--dragging')`), 'the held server is dragged');
      await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
      await check(await evaluate(`!document.querySelector('.server-rail--dragging, .dragging, .server-rail-drop-zone.active, .combine-target, .drag-over')
        && !document.querySelector('#server-rail').hasPointerCapture(1)`), 'Escape cancels the drag and lets the pointer go');
      browser.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], ...held });
      await frames();
      await check(await evaluate(`!document.querySelector('.server-rail--dragging')`), 'a cancelled press does not drag again');
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...held });
      await frames();
      await new Promise(resolve => setTimeout(resolve, 30));
      await check(await evaluate('window.connectCalls === 1'), 'releasing a cancelled drag over its server does not open it');
      await check(JSON.stringify(await order()) === '[5103,5102,5101]', 'a cancelled drag moves nothing');

      // Touch scrolls the rail, as it always has: a finger never starts a reorder.
      await check(await evaluate(`(() => {
        const item = document.querySelector('.server-rail-item[data-port="5102"]');
        const box = item.getBoundingClientRect();
        const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
        const touch = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true };
        item.dispatchEvent(new PointerEvent('pointerdown', { ...touch, button: 0, buttons: 1, ...at }));
        window.dispatchEvent(new PointerEvent('pointermove', { ...touch, buttons: 1, clientX: at.clientX, clientY: at.clientY + 30 }));
        const dragged = !!document.querySelector('.server-rail--dragging');
        window.dispatchEvent(new PointerEvent('pointercancel', { ...touch, clientX: at.clientX, clientY: at.clientY + 30 }));
        return !dragged;
      })()`), 'a touch on the rail does not start a reorder');

      // Like Discord: holding a server over the middle of another previews a
      // folder and dropping it there groups both, in place of the target.
      const connectedAgain = await center('.server-rail-item[data-port="5101"]');
      const groupTarget = await center('.server-rail-item[data-port="5102"]');
      await drag(connectedAgain, groupTarget, null, async () => {
        await check(await waitFor(`!!document.querySelector('.server-rail-item.combine-target[data-port="5102"]')`),
          'the target previews the folder while hovered');
        // A probe answer that changes a status while the server is held paints the dot in
        // place: rebuilding the rail would drop the folder preview the person is aiming at.
        await evaluate(`window.probeOnline('c.test')`);
        await check(await evaluate(`document.querySelector('.server-rail-item[data-port="5103"] .server-rail-status-dot')?.dataset.status === 'online'`),
          'a probe answer during a drag shows the new status');
        await check(await evaluate(`!!document.querySelector('.server-rail-item.combine-target[data-port="5102"]')`),
          'a probe answer during a drag keeps the folder preview');
      });
      await check(JSON.stringify(await order()) === '[5103,"folder:5102","folder:5101"]', 'dropping on a server creates a folder with both');
      const animated = await evaluate('window.animatedFolders');
      await check(animated > 0, `the new folder opens with the slide animation, not abruptly (${animated} animations)`);
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
      await check(await evaluate(`(() => { const minis = [...document.querySelectorAll('.server-rail-folder-mini')]; const style = mini => getComputedStyle(mini); return minis.every(mini => mini.getBoundingClientRect().width === 19) && style(minis[0]).borderTopLeftRadius === '14px' && style(minis[0]).borderBottomRightRadius === '4px' && style(minis[1]).borderTopRightRadius === '14px' && style(minis[2]).borderBottomLeftRadius === '14px' && style(minis[2]).borderTopRightRadius === '4px'; })()`),
        'miniatures follow the tile corner outside and are squarer inside, like Discord');
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

      // With reduced motion the folder opens and closes at once, without sliding.
      await motion('reduce');
      await clickAt(await center('.server-rail-folder-header'));
      await check(await evaluate(children + `.hidden && ` + children + `.getAnimations().length === 0 && !document.querySelector('.server-rail-folder--closing')`),
        'with reduced motion the folder closes at once');
      await clickAt(await center('.server-rail-folder-header'));
      await check(await evaluate(`!`+children+`.hidden && `+children+`.getAnimations().length === 0`),
        'with reduced motion the folder opens at once');
      await motion('no-preference');

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
      // A mouse button held for push-to-talk turns the left press and release into moves (R-SHELL-12).
      const chord = await evaluate(`(() => {
        const SIDE = 8;
        const mouse = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        const center = port => {
          const box = document.querySelector('.server-rail-item[data-port="' + port + '"]').getBoundingClientRect();
          return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
        };
        const start = center(5102);
        const head = center(5101);
        const target = { clientX: head.clientX, clientY: head.clientY - 22 };
        document.querySelector('.server-rail-item[data-port="5102"]')
          .dispatchEvent(new PointerEvent('pointermove', { ...mouse, button: 0, buttons: 1 | SIDE, ...start }));
        window.dispatchEvent(new PointerEvent('pointermove', { ...mouse, button: -1, buttons: 1 | SIDE, clientX: start.clientX, clientY: start.clientY - 10 }));
        const dragged = !!document.querySelector('.server-rail--dragging .server-rail-item.dragging[data-port="5102"]');
        window.dispatchEvent(new PointerEvent('pointermove', { ...mouse, button: -1, buttons: 1 | SIDE, ...target }));
        window.dispatchEvent(new PointerEvent('pointermove', { ...mouse, button: 0, buttons: SIDE, ...target }));
        const droppedAtOnce = !document.querySelector('.server-rail--dragging');
        window.dispatchEvent(new PointerEvent('pointerup', { ...mouse, button: 3, buttons: 0, ...target }));
        return { dragged, droppedAtOnce, order: window.railOrder() };
      })()`);
      await check(chord.dragged && chord.droppedAtOnce && JSON.stringify(chord.order) === '[5102,5101,5103]',
        `with another button held, the left press drags and its release drops at once ${JSON.stringify(chord)}`);
      // The live icon is a file the server stores or nothing: the rail never points at a local file (R-COMMUNITY-11).
      await evaluate(`window.setLiveIcon('file:///C:/Windows/win.ini')`);
      await check(await evaluate(`!document.querySelector('#server-rail img[src^="file:"]')
        && !!document.querySelector('.server-rail-item[data-port="5101"] .server-rail-avatar')`), 'a live icon in no server format is not drawn');
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
  // Servers answer the status probe only once a step makes them reachable.
  const reachable = new Set();
  window.fetch = async (url) => {
    if (!reachable.has(new URL(String(url)).hostname)) throw new Error('offline fixture');
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const [{ connectionStore }, { sessionManager }, { serverRailView }] = await Promise.all([
    import('/stores/connectionStore.ts'), import('/core/SessionManager.ts'), import('/views/ServerRailView.ts'),
  ]);
  connectionStore.loadSavedServers();
  connectionStore.loadRailLayout();
  const session = sessionManager.create('a.test', 5101, 'Fixture');
  const icon = color => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="${color}"/></svg>`)}`;
  session.serverStore.serverDetails = {
    id: 'server-a', name: 'A', iconUrl: icon('#e44'),
    channels: [], categories: [], members: [], knownMembers: [], voiceStates: {}, roles: [], userRoles: [],
  };
  // A background event that changes what the rail shows, so it is drawn again.
  window.repaintRail = (color) => window.setLiveIcon(icon(color));
  window.setLiveIcon = (iconUrl) => {
    session.serverStore.serverDetails = { ...session.serverStore.serverDetails, iconUrl };
    serverRailView.render();
  };
  sessionManager.activate(session.key);
  window.connectCalls = 0;
  // Counts slide animations on folder contents, to tell a smooth opening from a jump.
  const animate = Element.prototype.animate;
  window.animatedFolders = 0;
  Element.prototype.animate = function (...args) {
    if (this.classList?.contains('server-rail-folder-children')) window.animatedFolders++;
    return animate.apply(this, args);
  };
  serverRailView.connectToSavedServer = async () => { window.connectCalls++; };
  window.probeOnline = async (host) => {
    reachable.add(host);
    await serverRailView.refreshServerRailStatuses();
  };
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
