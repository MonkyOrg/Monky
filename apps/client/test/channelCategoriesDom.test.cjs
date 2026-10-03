const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('category controls, inheritance and persistence work with pointer and keyboard in both locales', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `category-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_CATEGORY_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_CATEGORY_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    const fonts = ['material-symbols/outlined.css', '@fontsource/inter/400.css', '@fontsource/inter/600.css']
      .map(id => `<link rel="stylesheet" href="/@fs/${require.resolve(id).replaceAll('\\', '/')}">`).join('');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'category-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__categories__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(`<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css">${fonts}</head><body></body></html>`);
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    browser.webContents.debugger.attach('1.3');
    const selectAllModifier = process.platform === 'darwin' ? 'meta' : 'control';
    const drag = async (from, to) => {
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...from });
      await new Promise(resolve => setTimeout(resolve, 20));
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...from });
      for (let step = 1; step <= 8; step++) {
        browser.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(from.x + (to.x - from.x) * step / 8),
          y: Math.round(from.y + (to.y - from.y) * step / 8),
          modifiers: ['leftButtonDown'],
        });
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...to });
      await new Promise(resolve => setTimeout(resolve, 80));
    };
    const key = async (keyCode, modifiers = [], deliveryDelay = 0) => {
      const inputKeyCode = { ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right' }[keyCode] ?? keyCode;
      await browser.webContents.executeJavaScript(`window.categoryKeyDelivery = new Promise((resolve, reject) => {
        const events = [];
        const received = event => {
          events.push({ key: event.key, code: event.code, trusted: event.isTrusted });
          if (!event.isTrusted || event.key.toLowerCase() !== ${JSON.stringify(keyCode.toLowerCase())}) return;
          clearTimeout(timer);
          window.removeEventListener('keyup', received, true);
          resolve();
        };
        const timer = setTimeout(() => {
          window.removeEventListener('keyup', received, true);
          reject(new Error('Native key was not delivered: ' + ${JSON.stringify(keyCode)} + '; ' + JSON.stringify({
            events, active: document.activeElement?.outerHTML, query: document.querySelector('[data-audience-search]')?.value,
          })));
        }, 5000);
        window.addEventListener('keyup', received, true);
      }); void 0`);
      const send = () => {
        browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: inputKeyCode, modifiers });
        if (keyCode === 'Enter') browser.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
        browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: inputKeyCode, modifiers });
      };
      if (deliveryDelay) setTimeout(send, deliveryDelay);
      else send();
      await browser.webContents.executeJavaScript('window.categoryKeyDelivery');
      await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    const resize = async (width) => {
      await browser.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height: 850, deviceScaleFactor: 1, mobile: false,
      });
      await browser.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        let frames = 0;
        const ready = () => {
          if (innerWidth === ${width}) requestAnimationFrame(() => requestAnimationFrame(resolve));
          else if (++frames > 120) reject(new Error('Viewport resize timed out'));
          else requestAnimationFrame(ready);
        };
        ready();
      })`);
    };
    const click = async (selector) => {
      const point = await browser.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return { failure: 'Missing pointer target: ' + ${JSON.stringify(selector)} };
        element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        const box = element.getBoundingClientRect();
        const point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
        const hit = document.elementFromPoint(point.x, point.y);
        if (!box.width || !box.height || hit !== element && !element.contains(hit)) {
          return { failure: 'Pointer target is covered: ' + ${JSON.stringify(selector)} + ' by ' + hit?.outerHTML.slice(0, 200) };
        }
        return point;
      })()`);
      if (point.failure) throw new Error(point.failure);
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    const dragChannelToSelector = async (from, selector, yRatio = 0.5) => {
      const targetBefore = await browser.webContents.executeJavaScript(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        const box = target.getBoundingClientRect();
        return { x: Math.round(box.left + Math.min(80, box.width / 2)), y: Math.round(box.top + box.height * ${yRatio}),
          top: box.top, layoutTop: box.top - target.closest('#channel-categories-list').getBoundingClientRect().top,
          scroll: target.closest('.channels-list-container').scrollTop };
      })()`);
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...from });
      await new Promise(resolve => setTimeout(resolve, 20));
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...from });
      browser.webContents.sendInputEvent({
        type: 'mouseMove',
        x: from.x + 7,
        y: from.y + 7,
        modifiers: ['leftButtonDown'],
      });
      // Native input is delivered asynchronously; measure only after the renderer starts the drag.
      const targetAfter = await browser.webContents.executeJavaScript(`new Promise(resolve => {
        const started = performance.now();
        const measure = () => {
          if (!document.querySelector('.channel-reorder-active .channel-dragging')) {
            if (performance.now() - started > 3000) resolve({ failure: 'The channel pointer drag did not start' });
            else requestAnimationFrame(measure);
            return;
          }
          const target = document.querySelector(${JSON.stringify(selector)});
          const box = target.getBoundingClientRect();
          resolve({ x: Math.round(box.left + Math.min(80, box.width / 2)), y: Math.round(box.top + box.height * ${yRatio}),
            top: box.top, layoutTop: box.top - target.closest('#channel-categories-list').getBoundingClientRect().top,
            scroll: target.closest('.channels-list-container').scrollTop });
        };
        measure();
      })`);
      if (targetAfter.failure) throw new Error(targetAfter.failure);
      for (let step = 1; step <= 8; step++) {
        browser.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round((from.x + 7) + (targetAfter.x - (from.x + 7)) * step / 8),
          y: Math.round((from.y + 7) + (targetAfter.y - (from.y + 7)) * step / 8),
          modifiers: ['leftButtonDown'],
        });
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: targetAfter.x, y: targetAfter.y });
      await new Promise(resolve => setTimeout(resolve, 80));
      return { targetBefore, targetAfter };
    };
    timeout = setTimeout(() => { console.error('Category DOM timeout'); void finish(1); }, 90000);
    for (const locale of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__categories__`);
      await resize(1100);
      await browser.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: locale === 'pt-BR' ? 'reduce' : 'no-preference' }],
      });
      const initial = await browser.webContents.executeJavaScript(`(${regression.toString()})(${JSON.stringify(locale)})
        .then(() => null).catch(error => ({ failure: error.stack || String(error) }))`, true);
      if (initial?.failure) throw new Error(initial.failure);
      await browser.webContents.executeJavaScript(
        'Promise.allSettled(document.getAnimations({ subtree: true }).map(animation => animation.finished))'
      );
      await browser.webContents.executeJavaScript(
        'document.querySelectorAll(".modal-backdrop").forEach(element => element.remove())'
      );
      browser.focus();
      browser.webContents.focus();
      browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'SPACE' });
      browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'SPACE' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const expanded = await browser.webContents.executeJavaScript(`document.querySelector('[data-collapse-category="category"]').getAttribute('aria-expanded')`);
      if (expanded !== 'true') throw new Error('Space did not expand the focused category button');
      const points = await browser.webContents.executeJavaScript(`(() => {
        const point = (selector, yRatio = 0.5) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return { x: Math.round(box.left + Math.min(80, box.width / 2)), y: Math.round(box.top + box.height * yRatio) };
        };
        return {
          channel: point('.channel-item[data-channel-id="voice"]'),
          category: point('[data-category-id="category"] > .category-title'),
          destination: point('[data-category-id="destination"] > .category-title', 0.75),
        };
      })()`);
      const channelDragGeometry = await dragChannelToSelector(
        points.channel,
        '[data-category-id="destination"] > .category-title',
        0.75,
      );
      console.log('Channel drag geometry', channelDragGeometry);
      if (channelDragGeometry.targetAfter.top <= channelDragGeometry.targetBefore.top) {
        throw new Error('The Uncategorized target did not push existing categories down during channel drag: ' +
          JSON.stringify(channelDragGeometry));
      }
      const channelMoved = await browser.webContents.executeJavaScript(`window.categoryTestRequests.some(({ type, payload }) =>
        type === 'CHANNEL_UPDATE' && payload.channelId === 'voice' && payload.categoryId === 'destination')`);
      if (!channelMoved) {
        const diagnostic = await browser.webContents.executeJavaScript(`({
          points: ${JSON.stringify(points)},
          events: window.categoryTestMouseEvents,
          requests: window.categoryTestRequests,
          channelAtStart: document.elementFromPoint(${points.channel.x}, ${points.channel.y})?.outerHTML.slice(0, 160),
          destinationAtEnd: document.elementFromPoint(${points.destination.x}, ${points.destination.y})?.outerHTML.slice(0, 160),
        })`);
        throw new Error(`A real Chromium pointer drag did not move the channel between categories: ${JSON.stringify(diagnostic)}`);
      }
      await browser.webContents.executeJavaScript('window.categoryTestRequests.length = 0');
      await drag(points.category, points.destination);
      const categoryMoved = await browser.webContents.executeJavaScript(`window.categoryTestRequests.some(({ type, payload }) =>
        type === 'CATEGORY_REORDER' && payload.orderedIds.join(',') === 'destination,category')`);
      if (!categoryMoved) throw new Error('A real Chromium pointer drag did not reorder categories');
      await browser.webContents.executeJavaScript('window.openChannelSettingsProbe(); document.fonts.ready');
      await browser.webContents.executeJavaScript('Promise.allSettled(document.getAnimations({ subtree: true }).map(animation => animation.finished))');
      await click('[data-channel-tab="permissions"]');
      if (!await browser.webContents.executeJavaScript(`!document.querySelector('[data-customize]') && !document.querySelector('.channel-permission-controls').disabled && document.querySelector('[data-sync-category]').hidden`)) {
        throw new Error('Synchronized permissions must be directly editable without a Customize button');
      }
      await click('[data-permission-bit="256"][data-permission-state="deny"]');
      await key('End');
      if (!await browser.webContents.executeJavaScript(`document.querySelector('[data-permission-bit="256"][data-permission-state="allow"]').getAttribute('aria-checked') === 'true'`)) {
        throw new Error('Real keyboard navigation did not select Allow after a pointer selection');
      }
      await click('[data-audience-toggle]');
      if (!await browser.webContents.executeJavaScript(`!!document.querySelector('[data-audience-popup]:popover-open') && document.activeElement.matches('[data-audience-search]')`)) {
        throw new Error('The shared audience dropdown did not open and focus its search in channel settings');
      }
      await key('Escape');
      if (!await browser.webContents.executeJavaScript(`!!document.querySelector('.channel-settings-card:not([hidden])') && !document.querySelector('[data-audience-popup]:popover-open')`)) {
        throw new Error('Escape must close the role dropdown without closing channel settings');
      }
      await click('[data-audience-toggle]');
      await browser.webContents.insertText('Additional');
      await key('ArrowDown');
      if (!await browser.webContents.executeJavaScript(`document.activeElement?.matches('[data-audience-kind="role"][data-audience-id="additional"]')`)) {
        throw new Error('Native ArrowDown did not focus the filtered role');
      }
      await key('Enter');
      if (!await browser.webContents.executeJavaScript(`!!document.querySelector('[data-permission-target="role:additional"].active')`)) {
        throw new Error('Keyboard selection did not add the extra role override');
      }
      await key('Escape');
      await click('[data-audience-toggle]');
      // Delivery can lag behind two animation frames; text insertion must await the native key.
      await key('A', [selectAllModifier], 120);
      await browser.webContents.insertText('ana');
      await key('ArrowDown');
      if (!await browser.webContents.executeJavaScript(`document.querySelector('[data-audience-search]')?.value === 'ana' && document.activeElement?.matches('[data-audience-kind="user"][data-audience-id="member"]')`)) {
        throw new Error('Native select-all and ArrowDown did not focus the filtered member');
      }
      await key('Enter');
      if (!await browser.webContents.executeJavaScript(`!!document.querySelector('[data-permission-target="user:member"].active') && !document.querySelector('[data-audience-id="bot"]')`)) {
        const state = await browser.webContents.executeJavaScript(`({
          active: document.activeElement?.outerHTML, query: document.querySelector('[data-audience-search]')?.value,
          popup: !!document.querySelector('[data-audience-popup]:popover-open'),
          targets: [...document.querySelectorAll('[data-permission-target]')].map(element => element.dataset.permissionTarget),
          options: [...document.querySelectorAll('[data-audience-id]:not([hidden])')].map(element => element.dataset.audienceId),
        })`);
        throw new Error('Searching and selecting a person did not add a member rule or exposed bots: ' + JSON.stringify(state));
      }
      await key('Escape');
      await browser.webContents.executeJavaScript('Promise.allSettled(document.getAnimations({ subtree: true }).map(animation => animation.finished))');
      for (const width of [1100, 320]) {
        await resize(width);
        await browser.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
        const bounds = await browser.webContents.executeJavaScript(`(() => {
          const card = document.querySelector('.channel-settings-card');
          const body = card.querySelector('.settings-content-body');
          const footer = card.querySelector('.modal-footer').getBoundingClientRect();
          const sync = card.querySelector('[data-sync-category]');
          const syncStyle = getComputedStyle(sync);
          return { viewport: innerWidth, card: card.scrollWidth - card.clientWidth,
            body: body.scrollWidth - body.clientWidth, right: card.getBoundingClientRect().right,
            sync: sync.querySelector('[aria-hidden="true"]')?.textContent === 'sync' &&
              syncStyle.fontFamily === getComputedStyle(body).fontFamily &&
              syncStyle.fontSize === '11px' && syncStyle.cursor === 'pointer' &&
              sync.getBoundingClientRect().height >= 32 && sync.getBoundingClientRect().height <= 48 &&
              sync.getBoundingClientRect().right <= card.querySelector('.channel-sync-status').getBoundingClientRect().right,
            footer: footer.bottom <= innerHeight, icons: document.fonts.check('18px "Material Symbols Outlined"'),
            overflow: [...body.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > body.getBoundingClientRect().right)
              .slice(0, 8).map(element => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width })) };
        })()`);
        if (process.env.MONKY_COMMUNITY_SCREENSHOTS) {
          fs.writeFileSync(path.join(process.env.MONKY_COMMUNITY_SCREENSHOTS, `channel-settings-${locale}-${width}.png`),
            (await browser.webContents.capturePage()).toPNG());
        }
        if (bounds.card > 1 || bounds.body > 1 || bounds.right > bounds.viewport || !bounds.footer || !bounds.icons || !bounds.sync) {
          throw new Error(`Settings overflow or unloaded icons at ${width}px: ${JSON.stringify(bounds)}`);
        }
        await click('[data-audience-toggle]');
        await key('A', [selectAllModifier]);
        await key('Backspace');
        const popup = await browser.webContents.executeJavaScript(`(() => {
          const popup = document.querySelector('[data-audience-popup]');
          const box = popup.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            roles: !!popup.querySelector('[data-audience-kind="role"]:not([hidden])'),
            members: !!popup.querySelector('[data-audience-kind="user"]:not([hidden])') };
        })()`);
        if (popup.left < 0 || popup.right > width || popup.top < 0 || popup.bottom > 850 || !popup.roles || !popup.members) {
          throw new Error(`Role/member picker escaped the viewport or lost its groups: ${JSON.stringify(popup)}`);
        }
        if (process.env.MONKY_COMMUNITY_SCREENSHOTS) {
          fs.writeFileSync(path.join(process.env.MONKY_COMMUNITY_SCREENSHOTS, `channel-settings-picker-${locale}-${width}.png`),
            (await browser.webContents.capturePage()).toPNG());
        }
        await key('Escape');
      }
      await resize(1100);
      await click('[data-sync-category]');
      await browser.webContents.executeJavaScript('Promise.allSettled(document.getAnimations({ subtree: true }).map(animation => animation.finished))');
      await click('[data-action="cancel"]');
      if (!await browser.webContents.executeJavaScript(`!document.querySelector('[data-sync-category]').hidden && !!document.querySelector('[data-permission-target="role:additional"]') && !!document.querySelector('[data-permission-target="user:member"]')`)) {
        throw new Error('Cancelling synchronization lost the local draft');
      }
      await click('[data-sync-category]');
      await browser.webContents.executeJavaScript('Promise.allSettled(document.getAnimations({ subtree: true }).map(animation => animation.finished))');
      await click('[data-action="confirm"]');
      if (!await browser.webContents.executeJavaScript(`!document.querySelector('.channel-permission-controls').disabled && document.querySelector('[data-sync-category]').hidden && !document.querySelector('[data-permission-target="role:additional"]') && !document.querySelector('[data-permission-target="user:member"]')`)) {
        throw new Error('Confirmed synchronization did not replace local overrides');
      }
      await click('#btn-save');
      if (!await browser.webContents.executeJavaScript(`window.categoryTestRequests.at(-1).payload.inheritCategoryPermissions === true && !('permissionOverwrites' in window.categoryTestRequests.at(-1).payload)`)) {
        throw new Error('Saving synchronization did not preserve live category inheritance');
      }
      console.log(`Category DOM ${locale}: forms, mixed groups, keyboard, menus, scoped persistence passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function regression(locale) {
  localStorage.clear();
  const { selectEnhancer } = await import('/core/SelectEnhancer.ts');
  selectEnhancer.init();
  const [{ setLanguage, t }, stores, network, { CategoryModal }, { CreateChannelModal }, { EditChannelModal }, { appEvents }] = await Promise.all([
    import('/i18n/index.ts'), import('/stores/serverStore.ts'), import('/core/NetworkClient.ts'),
    import('/views/CategoryModal.ts'),
    import('/views/CreateChannelModal.ts'), import('/views/EditChannelModal.ts'), import('/core/EventBus.ts'),
  ]);
  setLanguage(locale);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const store = new stores.ServerStore();
  const category = { id: 'category', serverId: 'server', name: '<Team>', position: 0, createdAt: 1, isPrivate: true, allowedRoleIds: ['role'] };
  const destination = { ...category, id: 'destination', name: 'Destination', position: 1 };
  const channel = (id, type, categoryId) => ({
    id, serverId: 'server', name: id, type, categoryId, inheritCategoryPermissions: true, position: id === 'voice' ? 0 : 1,
    isPrivate: true, allowedRoleIds: ['role'], botCommandsEnabled: true, createdAt: 1,
  });
  const forumThreads = Array.from({ length: 201 }, (_, index) => ({
    ...channel(`thread-${index}`, 'TEXT', category.id),
    forumId: 'forum',
  }));
  const details = {
    id: 'server', name: 'Server', createdAt: 1, maxUsers: 10, hasPassword: false, allowSoundboard: true,
    channels: [channel('voice', 'VOICE', category.id), channel('text', 'TEXT', category.id), channel('loose', 'TEXT', null), ...forumThreads],
    categories: [category, destination], members: [], roles: [{ id: 'role', name: 'Team', color: null, position: 2, permissions: 0, isDefault: false, createdAt: 1 }],
    userRoles: [], myPermissions: 0xFFFFFFFF,
  };
  details.roles.push({ ...details.roles[0], id: 'additional', name: 'Additional role' });
  const user = { id: 'user', clientId: 'key', nickname: 'User', status: 'ONLINE' };
  store.setServerDetails(details, user);
  store.knownMembers.set('member', { ...user, id: 'member', nickname: 'Ána Offline', status: 'DISCONNECTED' });
  store.knownMembers.set('bot', { ...user, id: 'bot', nickname: 'Bot', isBot: true });
  details.knownMembers = [...store.knownMembers.values()];
  store.myPermissions = 546576;
  store.setCategories([{ ...category, isPrivate: false, permissionOverwrites: [{ roleId: null, allow: 0, deny: 512 }] }, destination]);
  check(!store.hasPermission(512, 'text') && store.hasPermission(524288, 'text'),
    'A category-only update revokes inherited reading immediately without hiding the channel');
  store.setCategories([{ ...category, permissionOverwrites: [
    { roleId: null, allow: 0, deny: 524288 },
    { userId: user.id, allow: 524288, deny: 512 },
  ] }, destination]);
  check(store.hasPermission(524288, 'text') && !store.hasPermission(512, 'text') &&
    (store.getUserChannelPermissions('member', 'text') & 524288) === 0,
  'Client inheritance resolves individual visibility and reading only for the matching member');
  store.setCategories(details.categories);
  store.myPermissions = details.myPermissions;
  stores.setActiveServerStore(store);
  const client = new network.NetworkClient();
  client.getStatus = () => 'CONNECTED';
  const requests = [];
  client.sendRequest = async (type, payload) => { requests.push({ type, payload }); return {}; };
  network.setActiveNetworkClient(client);
  const field = (selector) => [...document.querySelectorAll(selector)].find(element =>
    !element.closest('.modal-backdrop[data-ui-closing], .floating-context-menu[data-ui-closing]'));
  const collapsed = selector => field(selector).hidden || field(selector).hasAttribute('data-ui-closing');
  const checkInlineSwitch = (selector) => {
    const toggle = field(selector).closest('.toggle-switch');
    const row = toggle.closest('.channel-privacy-row');
    const info = row.querySelector('.channel-privacy-info').getBoundingClientRect();
    const control = toggle.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    check(info.width > 0 && control.width > 0, `${selector} text and switch are visible`);
    check(control.left >= info.right && Math.abs((control.top + control.bottom) / 2 - (info.top + info.bottom) / 2) < 2,
      `${selector} is alongside the description, not below it`);
    check(Math.abs(control.right - (box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth))) < 2,
      `${selector} is aligned to the right edge of the row`);
  };
  const change = (selector, value) => {
    const input = field(selector);
    if (typeof value === 'boolean') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const create = new CreateChannelModal();
  create.open('TEXT', category.id);
  checkInlineSwitch('#input-channel-inherit');
  const createCard = field('.create-channel-modal');
  createCard.style.width = '320px';
  checkInlineSwitch('#input-channel-inherit');
  createCard.style.removeProperty('width');
  check(field('#input-channel-category').value === category.id, 'plus selects the category');
  check(collapsed('#channel-permission-overrides'), 'new channels inherit by default');
  check(field('input[name="channel-type"][value="VOICE"]'), 'voice is available within text-seeded category');
  check(!field('input[type="checkbox"]:not(.toggle-switch input)'), 'checkboxes only inside switches');
  change('#input-channel-inherit', false);
  check(!collapsed('#channel-permission-overrides'), 'override switch reveals existing role controls');
  checkInlineSwitch('#input-channel-private');
  change('#input-channel-name', 'Created');
  change('#input-channel-private', true);
  change('.channel-role-checkbox', true);
  field('#form-create-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.at(-1).payload.categoryId === category.id && requests.at(-1).payload.inheritCategoryPermissions === false, 'create submits category override');
  check(requests.at(-1).payload.allowedRoleIds[0] === 'role', 'create submits allowed roles');
  const sendRequest = client.sendRequest;
  let finishCreate;
  client.sendRequest = () => new Promise(resolve => { finishCreate = resolve; });
  create.open();
  change('#input-channel-name', 'Pending');
  field('#form-create-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  create.close();
  create.open();
  const reopenedCreate = field('.create-channel-modal');
  finishCreate({});
  await flush();
  check(field('.create-channel-modal') === reopenedCreate, 'late channel creation never closes a reopened form');
  create.close();
  client.sendRequest = sendRequest;
  const edit = new EditChannelModal();
  edit.open('text');
  check(!field('#input-channel-inherit'), 'Editing uses synchronization status instead of another inheritance switch');
  check(field('[data-channel-tab="general"]') && field('[data-channel-tab="permissions"]'), 'channel settings have a sidebar');
  field('[data-channel-tab="permissions"]').click();
  check(!collapsed('.channel-sync-status') && !field('.channel-permission-controls').disabled &&
    field('[data-sync-category]').hidden && !field('[data-customize]'), 'synchronized permissions are informational and directly editable');
  field('[data-permission-bit="256"][data-permission-state="deny"]').click();
  check(!field('[data-sync-category]').hidden && field('[data-sync-status]').textContent === t('channelPermissions.unsynced'),
    'Changing a permission immediately reveals synchronization without a Customize step');
  field('[data-permission-bit="256"][data-permission-state="inherit"]').click();
  check(field('[data-sync-category]').hidden && field('[data-sync-status]').textContent === t('channelPermissions.synced'),
    'Restoring the category rules removes the synchronization action without a false difference');
  field('[data-audience-toggle]').click();
  field('[data-audience-kind="role"][data-audience-id="additional"]').click();
  field('[data-audience-search]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(field('[data-sync-category]').hidden, 'An all-inherited empty target is not a permission difference');
  field('[data-permission-bit="256"][data-permission-state="deny"]').click();
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.at(-1).payload.inheritCategoryPermissions === false &&
    requests.at(-1).payload.permissionOverwrites.some(rule => rule.roleId === 'additional' && (rule.deny & 256) !== 0),
  'Saving a direct permission edit automatically persists independent rules');
  edit.open('text');
  field('[data-channel-tab="general"]').click();
  change('#input-channel-category', '');
  check(collapsed('.channel-sync-status'), 'uncategorizing removes irrelevant synchronization controls');
  field('[data-channel-tab="permissions"]').click();
  check(!field('.channel-permission-controls').disabled && field('#input-channel-private').checked, 'uncategorizing preserves effective private ACL');
  field('[data-permission-bit="256"][data-permission-state="deny"]').click();
  check(field('[data-permission-bit="256"][data-permission-state="deny"]').getAttribute('aria-checked') === 'true', 'Everyone can deny sending without hiding the channel');
  field('[data-permission-target="role:role"]').click();
  field('[data-permission-bit="256"][data-permission-state="allow"]').click();
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  const rules = requests.at(-1).payload.permissionOverwrites;
  check(requests.at(-1).payload.categoryId === null && rules.some(rule => rule.roleId === null && (rule.deny & 256) !== 0), 'local Everyone denial is saved');
  check(rules.some(rule => rule.roleId === 'role' && (rule.allow & 256) !== 0), 'role grant and existing private visibility are preserved');
  const categoryModal = new CategoryModal();
  categoryModal.open(category);
  check(field('#input-channel-name').value === '<Team>', 'category names are escaped in the shared settings editor');
  check(field('label[for="input-channel-name"]').textContent === t('categories.name'), 'Category editing labels the field as category name');
  field('[data-channel-tab="permissions"]').click();
  field('[data-audience-toggle]').click();
  check(field('[data-audience-id="user"][data-audience-kind="user"]') &&
    !field('[data-audience-id="bot"]'), 'Individual rules allow self and offline humans but not bots');
  field('[data-audience-id="member"][data-audience-kind="user"]').click();
  field('[data-audience-search]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(field('.channel-settings-card'), 'Escape closes only the shared target picker');
  field('[data-permission-bit="256"][data-permission-state="deny"]').click();
  field('[data-channel-tab="general"]').click();
  change('#input-channel-name', 'Renamed');
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.at(-1).type === 'CATEGORY_UPDATE' && requests.at(-1).payload.name === 'Renamed', 'category editing submits');
  check(requests.at(-1).payload.permissionOverwrites.some(rule =>
    rule.userId === 'member' && rule.roleId === undefined && (rule.deny & 256) !== 0),
  'Category editing submits an individual denial without treating it as Everyone');
  edit.open('text');
  client.sendRequest = async () => { throw new Error('Controlled save failure'); };
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(field('#btn-save') && !field('#btn-save').disabled &&
    document.querySelector('.chat-copy-toast-label')?.textContent === 'Controlled save failure',
  'A failed settings save shows an error toast and restores controls for retry');
  client.sendRequest = sendRequest;
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(!field('.channel-settings-card'), 'Retrying a settings save closes the editor after acknowledgement');
  edit.open('text');
  const beforeConflict = requests.length;
  store.setCategories([{ ...category, name: 'Concurrent category change' }, destination]);
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.length === beforeConflict && document.querySelector('.chat-copy-toast-label')?.textContent === t('channelPermissions.changed'),
    'A changed inherited category rejects a stale draft before sending');
  edit.close();
  store.setCategories(details.categories);
  const initialCategories = [category, destination];
  const updatedCategory = { ...category, permissionOverwrites: [
    { roleId: null, allow: 0, deny: 524288 | 512 },
    { roleId: 'role', allow: 524288, deny: 0 },
  ] };
  store.setCategories([updatedCategory, destination]);
  edit.open('text');
  check(field('[data-sync-category]').hidden &&
    field('[data-permission-bit="512"][data-permission-state="deny"]').getAttribute('aria-checked') === 'true',
  'Opening an inherited channel uses the latest category rules instead of stale channel data');
  edit.close();
  store.setCategories([category, { ...updatedCategory, id: destination.id }]);
  edit.open('text');
  change('#input-channel-category', destination.id);
  check(field('[data-sync-category]').hidden &&
    field('[data-permission-bit="512"][data-permission-state="deny"]').getAttribute('aria-checked') === 'true',
  'Moving a synchronized channel adopts the destination rules immediately');
  const beforeDestinationConflict = requests.length;
  store.setCategories([category, { ...updatedCategory, id: destination.id, name: 'Concurrent destination change' }]);
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.length === beforeDestinationConflict &&
    document.querySelector('.chat-copy-toast-label')?.textContent === t('channelPermissions.changed'),
  'A concurrent change in the selected destination blocks a stale save');
  edit.close();
  store.setCategories(initialCategories);
  const textChannel = store.getChannel('text');
  const originalTextChannel = { ...textChannel };
  Object.assign(textChannel, { inheritCategoryPermissions: false, permissionOverwrites: [
    { roleId: 'role', allow: 524288, deny: 0 },
    { roleId: null, allow: 0, deny: 524288 },
    { userId: 'member', allow: 0, deny: 0 },
  ] });
  edit.open('text');
  check(field('[data-sync-category]').hidden, 'Rule order and empty targets do not create false differences');
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.at(-1).payload.inheritCategoryPermissions === true &&
    !('permissionOverwrites' in requests.at(-1).payload),
  'Matching independent rules save as category inheritance without redundant overrides');
  const legacyRules = [{ roleId: null, allow: 524288, deny: 0 }];
  Object.assign(textChannel, { isPrivate: true, allowedRoleIds: [], permissionOverwrites: legacyRules });
  store.setCategories([{ ...category, isPrivate: false, allowedRoleIds: [], permissionOverwrites: legacyRules }, destination]);
  edit.open('text');
  check(!field('[data-sync-category]').hidden && field('#input-channel-private').checked,
    'Matching bits do not discard a legacy private flag that still excludes bots');
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.at(-1).payload.inheritCategoryPermissions === false,
    'Saving different legacy privacy keeps the channel independent');
  Object.assign(textChannel, { permissionOverwrites: undefined }, originalTextChannel);
  store.setCategories(initialCategories);
  edit.open('text');
  let finishSettings;
  client.sendRequest = () => new Promise(resolve => { finishSettings = resolve; });
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const previousPermissions = store.myPermissions;
  store.myPermissions = 0;
  store.bus.emit('server.updated');
  check(!field('.channel-settings-card'), 'Losing management immediately closes even a pending editor');
  finishSettings({});
  await flush();
  store.myPermissions = previousPermissions;
  client.sendRequest = sendRequest;
  categoryModal.open();
  field('#input-category-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(!field('.modal-backdrop'), 'escape closes category modal');
  categoryModal.open();
  appEvents.emit('session.changed', { key: 'different' });
  check(!field('.modal-backdrop'), 'session changes close category modal');

  console.log(`Category forms ${locale} passed`);
  const { MainView } = await import('/views/MainView.ts');
  const root = document.createElement('div');
  root.innerHTML = '<div class="channels-list-container" tabindex="0"><div id="server-community"></div><div id="channel-categories-list"></div></div>';
  document.body.appendChild(root);
  const view = new MainView(root);
  view.attachChannelListMenu();
  view.renderChannels();
  const cssRules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  const categoryHoverRule = cssRules.find(rule => rule.selectorText === '.category-title:hover');
  const channelHoverRule = cssRules.find(rule => rule.selectorText === '.channel-item:hover');
  check(categoryHoverRule && channelHoverRule, 'category and channel hover rules are present');
  check(categoryHoverRule.style.backgroundColor === channelHoverRule.style.backgroundColor &&
    categoryHoverRule.style.color === channelHoverRule.style.color,
  'category hover uses the same background and text colors as channels');
  const list = root.querySelector('.channels-list-container');
  const rightClick = target => target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 20, clientY: 20,
  }));
  const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].filter(element => !element.closest('[data-ui-closing]'));
  const menuLabel = item => item.querySelector('span:last-child').textContent;
  rightClick(list);
  check(JSON.stringify(menuItems().map(menuLabel)) === JSON.stringify([
    t('channelModal.title'), t('categories.create'),
  ]), 'empty sidebar offers only channel and category creation in order');
  list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  check(menuItems().length === 0, 'Left-clicking the sidebar outside its menu dismisses it');
  rightClick(list);
  menuItems()[0].click();
  check(field('#form-create-channel') && field('#input-channel-category').value === '', 'sidebar creates a channel without a category');
  field('#input-channel-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  rightClick(list);
  menuItems()[1].click();
  check(field('#input-category-name'), 'sidebar menu opens category creation');
  field('#input-category-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const permissions = store.myPermissions;
  store.myPermissions = 0;
  rightClick(list);
  check(menuItems().length === 0, 'members without management permission have no sidebar creation menu');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  store.myPermissions = permissions;
  rightClick(root.querySelector('#server-community'));
  check(!field('[role="menu"]'), 'community controls do not open the sidebar creation menu');
  for (const unbind of view.unbindEvents) unbind();
  view.unbindEvents = [];
  rightClick(list);
  check(!field('[role="menu"]'), 'sidebar creation listener is removed during view cleanup');
  view.attachChannelListMenu();
  const grouped = root.querySelector('[data-category-channels="category"]');
  check(grouped.querySelectorAll('.channel-item').length === 2, 'text and voice render in the same category');
  check(grouped.firstElementChild.dataset.channelId === 'voice', 'mixed order is retained');
  check(root.querySelector('[data-category-channels=""]').querySelector('.channel-item').dataset.channelId === 'loose', 'uncategorized channels render');
  const categoryTitle = root.querySelector('[data-category-id="category"] > .category-title');
  rightClick(categoryTitle);
  check(document.querySelectorAll('[role="menuitem"]').length >= 5, 'category contextual menu has management controls');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  rightClick(categoryTitle);
  check(menuItems().some(item => menuLabel(item) === t('categories.edit')), 'right-clicking a category preserves its own menu');
  check(!menuItems().some(item => menuLabel(item) === t('categories.create')), 'category menu is not replaced by the background menu');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  rightClick(root.querySelector('.channel-item[data-channel-id="voice"]'));
  check(menuItems().some(item => menuLabel(item) === t('main.editChannel')), 'right-clicking a channel preserves its own menu');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  view.openChannelMenu('voice', 10, 10);
  check(document.querySelector('[aria-haspopup="menu"]'), 'channel movement is offered through contextual submenu');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  const moveToCategory = new DataTransfer();
  const looseChannel = root.querySelector('[data-channel-id="loose"]');
  const destinationTitle = root.querySelector('[data-category-id="destination"] > .category-title');
  looseChannel.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: moveToCategory }));
  check(root.querySelector('#channel-categories-list').classList.contains('channel-reorder-active'),
    'channel dragging reveals category drop surfaces');
  destinationTitle.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: moveToCategory }));
  check(destinationTitle.classList.contains('channel-category-drop-target'),
    'destination category uses the highlighted move target');
  check(!destinationTitle.nextElementSibling.classList.contains('channel-category-drop-target'),
    'highlighting a category title does not outline its channel list');
  destinationTitle.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: moveToCategory }));
  await flush();
  check(requests.some(({ type, payload }) =>
    type === 'CHANNEL_UPDATE' && payload.channelId === 'loose' && payload.categoryId === destination.id),
  'a channel can move into another category');
  const destinationOrder = requests.findLast(({ type }) => type === 'CHANNEL_REORDER')?.payload.orderedIds ?? [];
  check(destinationOrder.length === 1 && destinationOrder[0] === 'loose',
    'reordering the sidebar excludes forum threads from the payload');
  looseChannel.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: moveToCategory }));

  store.setServerDetails({ ...details, channels: details.channels.filter(item => item.id !== 'loose') }, user);
  view.renderChannels();
  const uncategorizedList = root.querySelector('[data-category-channels=""]');
  const uncategorizedDropzone = root.querySelector('[data-category-dropzone=""]');
  check(uncategorizedList && !uncategorizedList.querySelector('.channel-item'),
    'the uncategorized destination remains mounted when empty');
  check(getComputedStyle(uncategorizedDropzone).display === 'none',
    'the empty uncategorized destination stays out of the normal layout');
  const moveOutside = new DataTransfer();
  const groupedChannel = root.querySelector('.channel-item[data-channel-id="voice"]');
  check(store.myPermissions === permissions, 'management permission survives the empty destination fixture');
  check(groupedChannel.classList.contains('channel-reorder-handle'),
    'channels retain their pointer reorder handle after the sidebar rerenders');
  groupedChannel.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: moveOutside }));
  check(root.querySelector('#channel-categories-list').classList.contains('channel-reorder-active'),
    'dragging from a category activates move-outside surfaces');
  check(getComputedStyle(uncategorizedDropzone).display === 'flex',
    'dragging makes the move-outside destination visible');
  const firstCategoryTop = root.querySelector('[data-category-id="category"]').getBoundingClientRect().top;
  check(firstCategoryTop >= uncategorizedDropzone.getBoundingClientRect().bottom,
    'the move-outside destination occupies layout space above existing categories');
  const siblingChannel = root.querySelector('.channel-item[data-channel-id="text"]');
  siblingChannel.dispatchEvent(new DragEvent('dragover', {
    bubbles: true, cancelable: true, clientY: siblingChannel.getBoundingClientRect().top, dataTransfer: moveOutside,
  }));
  check(siblingChannel.classList.contains('channel-drop-before') &&
    !siblingChannel.closest('[data-category-channels]').classList.contains('channel-category-drop-target'),
  'hovering a channel shows only the insertion line, without outlining the category body');
  uncategorizedDropzone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: moveOutside }));
  check(uncategorizedDropzone.classList.contains('channel-category-drop-target'),
    'move-outside destination uses the highlighted move target');
  uncategorizedDropzone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: moveOutside }));
  await flush();
  check(requests.some(({ type, payload }) =>
    type === 'CHANNEL_UPDATE' && payload.channelId === 'voice' && payload.categoryId === null),
  'a channel can move outside every category');
  groupedChannel.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: moveOutside }));
  check(getComputedStyle(uncategorizedDropzone).display === 'none',
    'move-outside destination hides again after dragging');

  const off = appEvents.on('server.updated', () => view.renderChannels());
  root.querySelector('[data-collapse-category="category"]').click();
  check(store.isCategoryCollapsed('category'), 'pointer collapses and persists');
  const another = new stores.ServerStore();
  another.setServerDetails(details, { ...user, id: 'another' });
  check(!another.isCategoryCollapsed('category'), 'collapse is scoped to identity');
  another.setServerDetails({ ...details, id: 'another-server' }, user);
  check(!another.isCategoryCollapsed('category'), 'collapse is scoped to server');
  another.setServerDetails(details, user);
  check(another.isCategoryCollapsed('category'), 'collapse survives store recreation');
  create.close();
  edit.close();
  categoryModal.close();
  requests.length = 0;
  window.categoryTestRequests = requests;
  window.openChannelSettingsProbe = () => {
    document.querySelectorAll('.chat-copy-toast').forEach(toast => toast.remove());
    edit.open('text');
  };
  window.categoryTestMouseEvents = [];
  for (const type of ['mousedown', 'mousemove', 'mouseup']) {
    document.addEventListener(type, event => {
      window.categoryTestMouseEvents.push({
        type,
        x: event.clientX,
        y: event.clientY,
        target: event.target?.className ?? event.target?.tagName,
        closing: event.target?.getAttribute?.('data-ui-closing'),
        html: event.target?.outerHTML?.slice(0, 200),
      });
    }, true);
  }
  root.querySelector('[data-collapse-category="category"]').focus();
  // Kept for the real key event dispatched from Electron after returning.
  window.categoryTestCleanup = () => { off(); view.destroy(); };
}
