const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `settings-navigation-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_SETTINGS_NAV_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_SETTINGS_NAV_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'settings-navigation-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__settings_navigation__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"></head><body></body></html>');
          });
        },
      }],
    });
    const httpServer = vite.httpServer;
    if (!httpServer) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
    window = new BrowserWindow({
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Settings navigation smoke timed out'); void finish(1); }, 90_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__settings_navigation__`);
    window.focus();
    window.webContents.focus();
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    const checks = await evaluate(`(${runSettingsNavigationSmoke.toString()})()`);
    console.log(`Settings navigation and emoji scrolling: ${checks} checks passed`);
    for (const kind of ['app', 'server']) {
      await evaluate(`(() => {
        const preview = window.settingsPreviews.${kind};
        document.body.innerHTML = preview.markup;
        document.querySelector('.settings-content-body').scrollTop = preview.contentScroll;
        document.querySelector('.settings-sidebar').scrollTop = preview.sidebarScroll;
        return document.fonts.ready.then(() => new Promise(resolve => setTimeout(resolve, 200)));
      })()`);
      fs.writeFileSync(path.join(clientRoot, 'dist-test', `settings-sections-${kind}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate(`document.body.replaceChildren(); import('/views/CodeBlockModal.ts').then(({codeBlockModal}) => {
      window.codeFixture = codeBlockModal;
      codeBlockModal.open({onSubmit: (language, code) => { window.codeSubmitted = {language, code}; }});
      document.querySelector('#code-body').value = 'const answer = 42;';
      document.querySelector('#code-body').dispatchEvent(new Event('input', {bubbles:true}));
    })`);
    const rect = () => evaluate(`(() => {
      const r = document.querySelector('.code-modal-card').getBoundingClientRect();
      const editor = document.querySelector('#code-body').getBoundingClientRect();
      return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height,
        editorWidth:editor.width, editorHeight:editor.height};
    })()`);
    const before = await rect();
    const point = { x: Math.floor(before.right - 3), y: Math.floor(before.bottom - 3) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 90, y: point.y + 55, modifiers: ['leftButtonDown'] });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 90, y: point.y + 55 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const after = await rect();
    if (!(after.width > before.width && after.height > before.height
      && after.editorWidth > before.editorWidth && after.editorHeight > before.editorHeight)) {
      throw new Error(`Native resize must enlarge the dialog and editor on both axes: ${JSON.stringify({before, after})}`);
    }
    await evaluate(`document.querySelector('.code-modal-card').style.cssText = 'width:4000px;height:4000px'`);
    for (const [width, height] of [[1100, 850], [560, 440]]) {
      window.setContentSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 100));
      const bounds = await rect();
      if (bounds.left < 23 || bounds.top < 23 || bounds.right > width - 23 || bounds.bottom > height - 23) {
        throw new Error(`Resized code dialog must retain a 24px viewport margin: ${JSON.stringify({width, height, bounds})}`);
      }
      if (!await evaluate(`document.querySelector('#code-body').value === 'const answer = 42;'`)) throw new Error('Resizing must preserve code');
    }
    fs.writeFileSync(path.join(clientRoot, 'dist-test', 'code-modal-resized.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('#form-code-block').requestSubmit()`);
    if (!await evaluate(`!document.querySelector('.code-modal-card') && window.codeSubmitted.code === 'const answer = 42;'`)) {
      throw new Error('Resizing must preserve form submission');
    }
    console.log('Code modal: native two-axis resize, viewport bounds and submission passed');
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runSettingsNavigationSmoke() {
  const [{ SettingsSectionNavigation }, { SettingsModal }, { ServerSettingsModal }, { EmojiPicker },
    { serverStore }, language] = await Promise.all([
    import('/views/settings/SettingsSectionNavigation.ts'), import('/views/SettingsModal.ts'),
    import('/views/ServerSettingsModal.ts'), import('/views/EmojiPicker.ts'),
    import('/stores/serverStore.ts'),
    import('/i18n/index.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
  const settled = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await wait(20);
    }
    throw new Error('Scroll did not reach its destination');
  };
  const originalMatchMedia = window.matchMedia;
  let reduced = false;
  const motionQueries = [];
  const setReduced = value => {
    reduced = value;
    motionQueries.forEach(query => query.dispatchEvent(new Event('change')));
  };
  window.matchMedia = query => {
    const result = originalMatchMedia.call(window, query);
    if (query === '(prefers-reduced-motion: reduce)') {
      Object.defineProperty(result, 'matches', { get: () => reduced });
      motionQueries.push(result);
    }
    return result;
  };
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  const section = id => `<section style="min-height:360px"><h3 data-settings-section="${id}" data-settings-label="Section ${id}">${id}</h3><input aria-label="${id}" value="preserved"></section>`;
  root.innerHTML = `<div class="modal-card settings-modal-card">
    <div class="settings-sidebar"><button class="settings-tab-btn active" data-tab="first">First</button><button class="settings-tab-btn" data-tab="second">Second</button></div>
    <div class="settings-main-container"><div class="settings-content-body" style="height:320px;flex:none;">
    <div class="settings-tab-panel" id="tab-panel-first">${section('one')}${section('two')}${section('three')}</div>
    <div class="settings-tab-panel" id="tab-panel-second" hidden>${section('other')}</div></div></div></div>`;
  document.body.append(root);
  const navigation = new SettingsSectionNavigation(root);
  const body = root.querySelector('.settings-content-body');
  const current = () => root.querySelector('.settings-section-nav[aria-hidden="false"] [aria-current="location"]')?.dataset.sectionTarget;
  const switchTab = tab => {
    root.querySelector('#tab-panel-first').hidden = tab !== 'first';
    root.querySelector('#tab-panel-second').hidden = tab !== 'second';
    navigation.setTab(tab);
  };
  let interruptedAnimations = [];
  const scrollCalls = [];
  const scrollTo = body.scrollTo;
  body.scrollTo = function (options) { scrollCalls.push(options); return scrollTo.call(this, options); };
  try {
    navigation.setTab('first');
    await wait();
    check(root.querySelectorAll('.settings-section-nav:not([hidden])').length === 1
      && root.querySelectorAll('.settings-section-link').length === 3, 'Only active tab expands its sections');
    const firstMenu = root.querySelector('[data-tab="first"]').nextElementSibling;
    const secondMenu = root.querySelector('[data-tab="second"]').nextElementSibling;
    check(firstMenu.getBoundingClientRect().height > 0
      && firstMenu.getBoundingClientRect().height < firstMenu.firstElementChild.getBoundingClientRect().height,
    'Opening a submenu shows intermediate expansion frames instead of jumping');
    await settled(() => firstMenu.getAnimations().length === 0);
    const expandedHeight = firstMenu.getBoundingClientRect().height;
    firstMenu.querySelector('button').focus();
    switchTab('second');
    const closingAnimation = firstMenu.getAnimations()[0];
    check(!firstMenu.hidden && firstMenu.inert && firstMenu.getAttribute('aria-hidden') === 'true'
      && root.querySelector('[data-tab="first"]').getAttribute('aria-expanded') === 'false'
      && document.activeElement === root.querySelector('[data-tab="second"]'),
    'Closing remains rendered for motion but immediately releases focus and hides its controls from accessibility');
    firstMenu.querySelector('button').focus();
    check(document.activeElement === root.querySelector('[data-tab="second"]'), 'Closing submenu links cannot receive keyboard focus');
    await wait(40);
    const closingHeight = firstMenu.getBoundingClientRect().height;
    check(closingHeight > 0 && closingHeight < expandedHeight, 'Closing a submenu progressively collapses its height');
    switchTab('first');
    check(closingAnimation.playState === 'idle'
      && Math.abs(firstMenu.getBoundingClientRect().height - closingHeight) < 1,
    'Rapid tab reversal resumes from the current height and cancels the obsolete collapse');
    await settled(() => firstMenu.getAnimations().length === 0 && secondMenu.getAnimations().length === 0);
    check(!firstMenu.hidden && !firstMenu.inert && secondMenu.hidden, 'A stale closing callback cannot hide a reopened submenu');
    navigation.setTab('first');
    check(!firstMenu.getAnimations().length, 'Selecting the already open tab does not replay its entrance');
    switchTab('second');
    await wait(40);
    setReduced(true);
    check(firstMenu.hidden && !secondMenu.hidden
      && !firstMenu.getAnimations().length && !secondMenu.getAnimations().length,
    'Enabling reduced motion immediately settles both expansion and collapse');
    switchTab('first');
    check(!firstMenu.hidden && secondMenu.hidden && !firstMenu.getAnimations().length
      && firstMenu.getBoundingClientRect().height === expandedHeight, 'Reduced motion changes tabs without animating their submenus');
    setReduced(false);
    check(current() === 'one', 'The initial visible section is selected');
    const outerScroll = document.scrollingElement.scrollTop;
    root.querySelector('[data-section-target="three"]').click();
    check(current() === 'three' && scrollCalls.at(-1).behavior === 'smooth', 'Section click selects destination and requests smooth scrolling');
    const destination = scrollCalls.at(-1).top;
    await settled(() => body.scrollTop > 0);
    check(body.scrollTop < destination, `Section navigation moves through intermediate scroll positions (${body.scrollTop}/${destination})`);
    await settled(() => Math.abs(body.scrollTop - destination) < 2);
    check(document.scrollingElement.scrollTop === outerScroll, 'Section navigation never moves the surrounding page');
    body.dispatchEvent(new WheelEvent('wheel'));
    const middle = root.querySelector('[data-settings-section="two"]');
    body.scrollTop += middle.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientTop - 16;
    await wait();
    check(current() === 'two', 'Manual content scrolling updates the selected subsection');
    setReduced(true);
    root.querySelector('[data-section-target="one"]').click();
    check(scrollCalls.at(-1).behavior === 'instant' && Math.abs(body.scrollTop - scrollCalls.at(-1).top) < 1, 'Reduced motion skips scroll animation');
    const retained = root.querySelector('[data-section-target="two"]');
    retained.focus();
    middle.dataset.settingsLabel = 'Updated section';
    await wait();
    check(root.querySelector('[data-section-target="two"]').textContent === 'Updated section'
      && document.activeElement.dataset.sectionTarget === 'two', 'Dynamic labels update without dropping sidebar keyboard focus');
    middle.parentElement.hidden = true;
    await wait();
    check(!root.querySelector('[data-section-target="two"]'), 'Hidden conditional sections disappear from navigation');
    middle.parentElement.hidden = false;
    await wait();
    check(!!root.querySelector('[data-section-target="two"]'), 'Revealing a section restores its navigation link');
    const oldHeading = root.querySelector('[data-settings-section="one"]');
    const replacement = oldHeading.cloneNode(true);
    replacement.removeAttribute('id');
    oldHeading.replaceWith(replacement);
    await wait();
    check(document.getElementById(root.querySelector('[data-section-target="one"]').getAttribute('aria-controls')) === replacement,
      'Replacing tab content retargets links to the new DOM');
    switchTab('second');
    check(current() === 'other' && body.scrollTop === 0
      && root.querySelector('[data-tab="first"]').getAttribute('aria-expanded') === 'false', 'Switching tabs collapses the old submenu and resets content scroll');
    check(root.querySelector('#tab-panel-first input').value === 'preserved', 'Navigation never recreates or discards form controls');
    setReduced(false);
    switchTab('first');
    interruptedAnimations = [firstMenu, secondMenu].flatMap(menu => menu.getAnimations());
    check(interruptedAnimations.length === 2, 'Destroy is exercised while both submenu transitions are running');
  } finally {
    navigation.destroy();
  }
  root.querySelector('[data-settings-section="other"]').dataset.settingsLabel = 'After cleanup';
  await wait();
  check(!root.querySelector('.settings-section-nav')
    && !root.querySelector('[data-tab="first"]').hasAttribute('aria-expanded'), 'Destroy removes menus, observers and generated accessibility state');
  check(interruptedAnimations.every(animation => animation.playState === 'idle'), 'Destroy cancels submenu animations and their completion callbacks');
  root.remove();

  const anchor = document.createElement('button');
  document.body.append(anchor);
  const picker = new EmojiPicker({ container: document.body, anchor, emojiOnly: true, floating: true, onSelectEmoji: () => {} });
  try {
    setReduced(false);
    await picker.open();
    const pickerBody = document.querySelector('.emoji-picker-body');
    const originalScroll = pickerBody.scrollTo;
    const calls = [];
    pickerBody.scrollTo = function (options) { calls.push(options); return originalScroll.call(this, options); };
    document.querySelector('[data-goto-group="flags"]').click();
    check(calls.at(-1).behavior === 'smooth', 'Emoji categories use smooth scrolling inside the picker');
    await settled(() => pickerBody.scrollTop > 0);
    check(pickerBody.scrollTop > 0 && pickerBody.scrollTop < pickerBody.scrollHeight - pickerBody.clientHeight, 'Emoji category navigation animates instead of jumping');
    await settled(() => pickerBody.scrollTop >= calls[0].top - 2);
    setReduced(true);
    document.querySelector('[data-goto-group="smileys"]').click();
    check(calls.at(-1).behavior === 'instant', 'Emoji categories honor reduced motion');
  } finally {
    picker.destroy();
    anchor.remove();
  }

  language.setLanguage('pt-BR');
  const appModal = new SettingsModal();
  for (const tab of Object.values(appModal)) {
    if (tab && typeof tab === 'object' && typeof tab.renderHtml === 'function') tab.attachEvents = () => {};
  }
  appModal.voiceVideoTab.refreshDevices = async () => {};
  appModal.voiceVideoTab.startVadMeter = () => {};
  appModal.aboutTab.loadAppVersion = async () => {};
  window.settingsPreviews = {};
  const verifyTabs = async (modalRoot, kind) => {
    for (const trigger of modalRoot.querySelectorAll('.settings-tab-btn[data-tab]')) {
      trigger.click();
      await wait();
      const panel = modalRoot.querySelector(`#tab-panel-${trigger.dataset.tab}`);
      const targets = Array.from(panel.querySelectorAll('[data-settings-section]')).filter(target => target.checkVisibility());
      const links = Array.from(modalRoot.querySelectorAll('.settings-section-nav[aria-hidden="false"] .settings-section-link'));
      check(targets.length > 0 && links.length === targets.length, `${kind}/${trigger.dataset.tab} exposes its actual visible sections`);
      check(new Set(targets.map(target => target.dataset.settingsSection)).size === targets.length
        && links.every((link, index) => link.textContent === targets[index].dataset.settingsLabel && link.type === 'button'),
      `${kind}/${trigger.dataset.tab} uses unique translated sections and non-submitting buttons`);
      links.at(-1).click();
      check(links.at(-1).getAttribute('aria-current') === 'location', `${kind}/${trigger.dataset.tab} selects the requested section`);
      if (trigger.dataset.tab === (kind === 'app' ? 'account' : 'general')) {
        window.settingsPreviews[kind] = {
          markup: modalRoot.outerHTML,
          contentScroll: modalRoot.querySelector('.settings-content-body').scrollTop,
          sidebarScroll: modalRoot.querySelector('.settings-sidebar').scrollTop,
        };
      }
    }
  };
  await appModal.open();
  await verifyTabs(document.querySelector('.modal-backdrop--settings'), 'app');
  appModal.close();
  check(!document.querySelector('.settings-section-nav'), 'Closing app settings cleans up its section navigation');

  serverStore.setServerDetails({
    id: 'settings-server', name: 'Settings server', createdAt: 1, maxUsers: 10, voiceStates: {},
    channels: [], members: [], knownMembers: [], roles: [], userRoles: [],
    myPermissions: 2147483647,
  }, { id: 'settings-user', sessionId: 'settings-session', nickname: 'Settings user', status: 'ONLINE', joinedAt: 1 });
  const serverModal = new ServerSettingsModal();
  serverModal.generalTab.attach = () => () => {};
  serverModal.rolesTab.attachEvents = () => {};
  serverModal.botsTab.attachEvents = () => {};
  serverModal.open();
  await verifyTabs(document.querySelector('.modal-backdrop'), 'server');
  serverModal.close();
  serverStore.myPermissions = 0;
  serverModal.open('general');
  check(!document.querySelector('[data-tab="roles"], [data-tab="members"], [data-tab="bots"]'),
    'Subsection navigation never exposes tabs unavailable to the current permissions');
  serverModal.close();
  check(!document.querySelector('.settings-section-nav'), 'Closing server settings cleans up its section navigation');
  window.matchMedia = originalMatchMedia;
  return checks;
}
