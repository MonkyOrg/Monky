const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

// Custom status (custom-status): the real member list, status menu, editor modal and footer card.
if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `custom-status-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_CUSTOM_STATUS_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_CUSTOM_STATUS_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, window, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    await vite?.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Custom status smoke timed out'); void finish(1); }, 60_000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{ name: 'custom-status-fixture', configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__custom_status__') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head>
            <link rel="stylesheet" href="/styles/fonts.css">
            <link rel="stylesheet" href="/styles/theme.css">
            </head><body><div id="app"></div></body></html>`);
        });
      } }],
    });
    const httpServer = vite.httpServer;
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
    });
    window = new BrowserWindow({
      show: false, width: 1280, height: 800, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(`[renderer] ${message}`); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // A fresh page per language: CI runs in English, a developer machine may default to Portuguese.
    for (const language of ['pt-BR', 'en']) {
      await window.loadURL(`http://127.0.0.1:${httpServer.address().port}/__custom_status__`);
      const checks = await window.webContents.executeJavaScript(
        `(${runCustomStatusSmoke.toString()})(${JSON.stringify(language)}).catch((error) => { throw new Error(error.stack); })`, true);
      console.log(`Custom status DOM smoke (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error('Custom status DOM smoke failed', error); await finish(1); });
}

async function runCustomStatusSmoke(language) {
  const [{ MainView }, { settingsStore: settings }, { serverStore: server }, { sessionManager }, { soundEffects },
    { appEvents }, { t, setLanguage }] = await Promise.all([
    import('/views/MainView.ts'), import('/stores/settingsStore.ts'), import('/stores/serverStore.ts'),
    import('/core/SessionManager.ts'), import('/core/SoundEffects.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
  ]);
  setLanguage(language);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const settle = async () => {
    await frame();
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
    await frame();
  };
  soundEffects.play = () => {};
  sessionManager.install();
  const session = sessionManager.create('status.test', 7891, 'Self');
  sessionManager.activate(session.key);
  const sent = [];
  session.client.getStatus = () => 'CONNECTED';
  session.client.send = (type, payload) => { sent.push({ type, payload }); };
  Object.assign(settings, { appearOffline: false, brb: false, customStatus: null, customStatusActive: false });

  const self = { id: 'self', sessionId: 'self-s', clientId: 'self-c', nickname: 'Self', status: 'ONLINE', joinedAt: 1 };
  const lunch = { id: 'ana', sessionId: 'ana-s', clientId: 'ana-c', nickname: 'Ana', status: 'ONLINE', joinedAt: 1,
    customStatus: { text: 'Almoçando <img src=x onerror="window.pwned=1">', emoji: '🍔', tag: 'ALMOÇO', color: '#22aa66', showEmoji: true, showTag: false } };
  const plain = { id: 'bia', sessionId: 'bia-s', clientId: 'bia-c', nickname: 'Bia', status: 'ONLINE', joinedAt: 1,
    customStatus: { tag: 'FOCO', color: '#cc3344', showEmoji: false, showTag: false } };
  const away = { id: 'caio', sessionId: 'caio-s', clientId: 'caio-c', nickname: 'Caio', status: 'ONLINE', joinedAt: 1, brb: true };
  server.setServerDetails({
    id: 'status-server', name: 'Status fixture', createdAt: 1, maxUsers: 10, voiceStates: {}, channels: [],
    members: [self, lunch, plain, away], knownMembers: [self, lunch, plain, away], roles: [], userRoles: [],
    myPermissions: 2147483647, ownerId: self.id,
    protocol: { version: 40, minimumVersion: 35, features: ['user-brb', 'custom-status'] },
  }, self);
  const root = document.getElementById('app');
  const view = new MainView(root);
  view.render();
  await settle();

  const row = (id) => root.querySelector(`.member-item[data-user-id="${id}"]`);
  const ana = row('ana');
  check(ana.querySelector('.presence-custom-emoji')?.textContent === '🍔', 'the chosen emoji shows next to the name');
  check(!ana.querySelector('.presence-custom-tag'), 'a hidden tag stays hidden');
  check(ana.querySelector('.presence-custom').dataset.tooltip === lunch.customStatus.text, 'the status text is the tooltip of the emoji');
  const anaDot = ana.querySelector('.status-indicator');
  check(anaDot.classList.contains('custom') && getComputedStyle(anaDot).backgroundColor === 'rgb(34, 170, 102)',
    'the dot takes the custom colour');
  check(ana.querySelector('.member-subtext').textContent === lunch.customStatus.text, 'the text replaces "Online" under the name');
  check(!root.querySelector('.members-list img[src="x"]') && !window.pwned, 'status text is escaped, never markup');
  const bia = row('bia');
  check(!bia.querySelector('.presence-custom'), 'with emoji and tag both hidden nothing sits beside the name');
  check(bia.querySelector('.status-indicator.custom') && bia.querySelector('.member-subtext').textContent === t('main.statusOnline'),
    'without text the coloured dot remains and the subtitle stays Online');
  check(row('caio').querySelector('.presence-brb-tag') && !row('caio').querySelector('.presence-custom'), '"Volto já" keeps its BRB tag');

  const dot = () => root.querySelector('#main-user-status-dot');
  const menuItems = () => [...document.querySelectorAll('.floating-context-menu [role^="menuitem"]')];
  dot().click();
  await settle();
  check(menuItems().map((item) => item.textContent.trim()).join('|').includes(t('customStatus.set')),
    'the status menu offers to set a custom status');
  check(menuItems().length === 4, 'without a saved status there is no custom choice yet');
  menuItems().at(-1).click();
  await settle();
  const modal = () => document.querySelector('.custom-status-modal');
  check(modal() && document.activeElement?.id === 'custom-status-text', 'the editor opens focused on the text');
  const saveButton = () => modal().querySelector('[data-custom-status-save]');
  check(saveButton().disabled, 'an empty status cannot be saved');
  const type = (id, value) => {
    const input = modal().querySelector(`#${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  type('custom-status-text', 'Em reunião');
  type('custom-status-tag', 'OCUPADO');
  check(!saveButton().disabled, 'some text enables Save');
  const preview = () => modal().querySelector('[data-custom-status-preview]');
  check(preview().querySelector('.presence-custom-tag')?.textContent === 'OCUPADO'
    && preview().textContent.includes('Em reunião'), 'the preview shows the tag and the text');
  modal().querySelector('[data-custom-status-emoji]').click();
  await settle();
  const emojiCell = document.querySelector('.emoji-picker [data-emoji]');
  check(emojiCell, 'the emoji button opens the picker');
  const chosen = emojiCell.dataset.emoji;
  emojiCell.click();
  await settle();
  check(preview().querySelector('.presence-custom-emoji')?.textContent === chosen
    && modal().querySelector('.custom-status-emoji-glyph')?.textContent === chosen, 'the picked emoji appears in the button and preview');
  const showTag = modal().querySelector('#custom-status-show-tag');
  check(showTag.getAttribute('role') === 'switch' && showTag.closest('.toggle-switch'), 'show/hide choices are switches');
  showTag.click();
  check(!preview().querySelector('.presence-custom-tag'), 'hiding the tag removes it from the preview');
  showTag.click();
  modal().querySelector('[data-custom-status-clear-emoji]').click();
  check(!preview().querySelector('.presence-custom-emoji'), 'the emoji can be removed again');
  modal().querySelector('[data-custom-status-emoji]').click();
  await settle();
  document.querySelector('.emoji-picker [data-emoji]').click();
  await settle();
  saveButton().click();
  await settle();
  check(!modal(), 'saving closes the editor');
  check(settings.customStatusActive && settings.customStatus?.text === 'Em reunião' && settings.customStatus.tag === 'OCUPADO'
    && settings.customStatus.emoji === chosen, 'the status is saved and chosen');
  check(sent.at(-1)?.type === 'USER_UPDATE_CUSTOM_STATUS' && sent.at(-1).payload.customStatus.text === 'Em reunião',
    'it is published to the server');
  check(dot().classList.contains('custom') && dot().style.getPropertyValue('--status-color'),
    'the footer dot takes the custom colour');
  check(root.querySelector('#main-user-status-text').textContent === `${chosen} Em reunião`, 'the footer shows the emoji and text');

  dot().click();
  await settle();
  const labels = menuItems().map((item) => item.textContent.trim());
  const customItem = menuItems().find((item) => item.textContent.includes('Em reunião'));
  check(customItem?.getAttribute('aria-checked') === 'true' && customItem.querySelector('.material-symbols-outlined').style.color,
    'the saved status is a checked choice painted in its colour');
  check(labels.at(-1).includes(t('customStatus.edit')), 'the last item edits the saved status');
  menuItems().find((item) => item.textContent.includes(t('main.statusOnline'))).click();
  await settle();
  check(!settings.customStatusActive && settings.customStatus, 'choosing Online keeps the saved status for later');
  check(sent.at(-1)?.payload.customStatus === null, 'and clears it on the server');
  check(!dot().classList.contains('custom') && !dot().getAttribute('style'), 'the footer dot is plain online again');

  dot().click();
  await settle();
  menuItems().at(-1).click();
  await settle();
  check(modal().querySelector('#custom-status-text').value === 'Em reunião', 'the editor reopens with the saved values');
  modal().querySelector('#custom-status-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle();
  check(!modal(), 'Escape closes the editor without saving');
  dot().click();
  await settle();
  menuItems().at(-1).click();
  await settle();
  modal().querySelector('[data-custom-status-remove]').click();
  await settle();
  check(!modal() && settings.customStatus === null && !settings.customStatusActive, 'Remove deletes the saved status');

  // In Settings the editor opens inline, under the cards: a second modal would
  // replace the Settings card with a smaller one, which looked like a blink.
  const { settingsModal } = await import('/views/SettingsModal.ts');
  await settingsModal.open();
  await settle();
  const settingsCard = () => document.querySelector('.settings-modal-card');
  const openModals = () => document.querySelectorAll('.modal-backdrop:not([data-ui-closing])').length;
  const pencil = () => document.querySelector('[data-presence-custom-edit]');
  const customCard = document.querySelector('[data-presence-custom]');
  const brbCard = document.querySelector('[data-presence="brb"]');
  check(customCard.getBoundingClientRect().height === brbCard.getBoundingClientRect().height,
    'the custom card is the same size as the card beside it');
  const pencilBox = pencil().getBoundingClientRect();
  const cardBox = customCard.getBoundingClientRect();
  check(pencilBox.top >= cardBox.top && pencilBox.bottom <= cardBox.bottom && pencilBox.right <= cardBox.right,
    'the edit action sits inside the card');
  check(pencil().getAttribute('aria-label') === t('customStatus.set'), 'without a status the icon offers to set one');
  const host = () => document.querySelector('[data-presence-custom-editor]');
  check(host().hidden, 'the inline editor starts closed');
  pencil().click();
  check(!host().hidden && pencil().getAttribute('aria-expanded') === 'true', 'the pencil opens the editor');
  check(host().getAnimations().length > 0, 'the editor slides open instead of appearing at once');
  await settle();
  check(openModals() === 1 && !document.querySelector('.custom-status-modal') && settingsCard() && !settingsCard().hidden,
    'no second modal opens and the Settings card stays');
  check(document.activeElement?.id === 'settings-custom-status-text', 'the inline editor is focused on the text');
  const inline = (id, value) => {
    const input = host().querySelector(`#${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  inline('settings-custom-status-text', 'Estudando');
  host().querySelector('[data-custom-status-save]').click();
  check(host().getAnimations().length > 0, 'saving slides the editor closed');
  await settle();
  check(host().hidden && !host().innerHTML && settings.customStatus?.text === 'Estudando' && settings.customStatusActive,
    'saving inline stores the status and closes the editor');
  check(document.querySelector('[data-presence-custom-description]').textContent.includes('Estudando'),
    'the card shows the saved text');
  check(pencil().getAttribute('aria-label') === t('customStatus.edit') && document.activeElement === pencil(),
    'focus returns to the pencil, which now edits');
  pencil().click();
  await settle();
  check(host().querySelector('#settings-custom-status-text').value === 'Estudando', 'reopening loads the saved values');
  host().querySelector('[data-custom-status-cancel]').click();
  await settle();
  check(host().hidden && settings.customStatus?.text === 'Estudando', 'Cancel closes without changes');
  check(openModals() === 1, 'still a single modal');
  settingsModal.close();
  await settle();
  sessionManager.saveCustomStatus(null);

  appEvents.emit('settings.updated');
  view.destroy?.();
  return checks;
}
