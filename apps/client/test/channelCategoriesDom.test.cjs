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
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
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
    const dragChannelToSelector = async (from, selector, yRatio = 0.5) => {
      const targetBefore = await browser.webContents.executeJavaScript(`(() => {
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: Math.round(box.left + Math.min(80, box.width / 2)), y: Math.round(box.top + box.height * ${yRatio}), top: box.top };
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
      await new Promise(resolve => setTimeout(resolve, 30));
      const targetAfter = await browser.webContents.executeJavaScript(`(() => {
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: Math.round(box.left + Math.min(80, box.width / 2)), y: Math.round(box.top + box.height * ${yRatio}), top: box.top };
      })()`);
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
      await browser.webContents.executeJavaScript(`(${regression.toString()})(${JSON.stringify(locale)})`, true);
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
      if (channelDragGeometry.targetAfter.top <= channelDragGeometry.targetBefore.top) {
        throw new Error('The Uncategorized target did not push existing categories down during channel drag');
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
      console.log(`Category DOM ${locale}: forms, mixed groups, keyboard, menus, scoped persistence passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function regression(locale) {
  localStorage.clear();
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
  const user = { id: 'user', clientId: 'key', nickname: 'User', status: 'ONLINE' };
  store.setServerDetails(details, user);
  stores.setActiveServerStore(store);
  const client = new network.NetworkClient();
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
  checkInlineSwitch('#input-channel-inherit');
  check(collapsed('#channel-permission-overrides'), 'edit reflects inheritance');
  change('#input-channel-category', '');
  check(collapsed('#channel-inherit-group') && !collapsed('#channel-permission-overrides'), 'uncategorizing exposes preserved effective ACL');
  field('#form-edit-channel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.at(-1).payload.categoryId === null && requests.at(-1).payload.isPrivate, 'detach preserves private access');
  const categoryModal = new CategoryModal();
  categoryModal.open(category);
  check(field('#input-category-name').value === '<Team>', 'category names are escaped');
  change('#input-category-name', 'Renamed');
  field('.modal-backdrop form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  check(requests.at(-1).type === 'CATEGORY_UPDATE' && requests.at(-1).payload.name === 'Renamed', 'category editing submits');
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
