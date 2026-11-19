const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('send logs modal picks server and channel in searchable selects', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `send-logs-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SEND_LOGS_PROFILE: profile };
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
  const { Permission } = require('@monky/shared');
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.MONKY_SEND_LOGS_PROFILE);
  let vite;
  let browser;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'send-logs-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__send_logs__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"></head><body></body></html>');
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
    if (!address || typeof address === 'string') throw new Error('Missing Vite address');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = new BrowserWindow({
      show: false, width: 1000, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    timeout = setTimeout(() => { console.error('Send logs modal DOM regression timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`${origin}/__send_logs__`);
      const checks = await browser.webContents.executeJavaScript(
        `(${runRegression.toString()})(${JSON.stringify(language)}, ${Permission.READ_MESSAGES})`, true);
      console.log(`Send logs modal (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language, readPermission) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const [{ selectEnhancer }, { sessionManager }, { appEvents }, { openSendLogsModal }] = await Promise.all([
    import('/core/SelectEnhancer.ts'), import('/core/SessionManager.ts'), import('/core/EventBus.ts'),
    import('/views/settings/SendLogsModal.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const waitFor = (predicate, describeFailure) => new Promise((resolve, reject) => {
    let frame;
    const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error(describeFailure())); }, 5000);
    const poll = () => {
      const value = predicate();
      if (value) { clearTimeout(timer); resolve(value); } else frame = requestAnimationFrame(poll);
    };
    poll();
  });
  const popup = () => document.querySelector('.monky-select-popup:not([data-ui-closing])');
  // Rows with an icon keep the bare option label in aria-label; textContent also holds the icon name.
  const rows = () => Array.from(document.querySelectorAll('.monky-select-popup:not([data-ui-closing]) .monky-select-option'))
    .map(row => row.getAttribute('aria-label') ?? row.textContent);
  const key = (target, name) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  const search = (select, term) => {
    select.focus();
    key(select, 'Enter');
    const input = popup()?.querySelector('.monky-select-search');
    check(!!input && document.activeElement === input, `${select.id} opens a searchable popup`);
    input.value = term;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input;
  };

  const channel = (id, name, type = 'TEXT') => ({ id, name, type });
  const session = (key, name, channels, blocked = []) => ({
    key, host: `${key}.example`, port: 7300,
    client: { getStatus: () => 'CONNECTED' },
    serverStore: {
      serverDetails: { name, channels },
      hasPermission: (permission, channelId) => permission === readPermission || !blocked.includes(channelId),
    },
  });
  const filler = Array.from({ length: 60 }, (_, index) => channel(`a-${index}`, `canal-${String(index).padStart(2, '0')}`));
  const alpha = session('alpha', 'Alpha', [
    channel('a-general', 'general'), channel('a-support', 'support'), channel('a-locked', 'locked'),
    channel('a-voice', 'support-voice', 'VOICE'), ...filler,
  ], ['a-locked']);
  const beta = session('beta', 'Beta', [channel('b-news', 'news'), channel('b-offtopic', 'offtopic')]);
  let sessions = [alpha, beta];
  const originals = { getAll: sessionManager.getAll, getActive: sessionManager.getActive };
  sessionManager.getAll = () => sessions;
  sessionManager.getActive = () => alpha;
  selectEnhancer.init();
  const owner = new AbortController();
  try {
    openSendLogsModal(owner.signal);
    const modal = await waitFor(() => document.querySelector('.send-logs-modal'), () => 'The modal did not open');
    const servers = modal.querySelector('#send-logs-server');
    const channels = modal.querySelector('#send-logs-channel');
    const confirm = modal.querySelector('[data-send-logs-confirm]');
    check(servers instanceof HTMLSelectElement && channels instanceof HTMLSelectElement, 'Server and channel are selects');
    check(!modal.querySelector('.forward-destination'), 'No destination cards are rendered');
    check(servers.value === 'alpha' && servers.options.length === 2, 'Every connected server is an option and the active one is chosen');
    const locked = [...channels.options].find(item => item.value === 'a-locked');
    check(locked?.disabled && locked.label.includes(t('chat.forwardNoPermission')), 'A blocked channel is disabled and says why');
    check(![...channels.options].some(item => item.value === 'a-voice'), 'Only text channels are offered');
    check(channels.value === '' && confirm.disabled, 'No channel is chosen up front');

    const channelSearch = search(channels, 'supp');
    check(rows().length === 1 && rows()[0] === 'support', `Typing filters the channels (${rows()})`);
    channelSearch.value = 'zzz';
    channelSearch.dispatchEvent(new Event('input', { bubbles: true }));
    check(popup().querySelector('.monky-select-empty')?.textContent === t('settings.logsSendChannelNoResults'), 'No match shows the empty label');
    channelSearch.value = 'supp';
    channelSearch.dispatchEvent(new Event('input', { bubbles: true }));
    key(channelSearch, 'Enter');
    check(channels.value === 'a-support' && !confirm.disabled, 'Enter on the search picks the filtered channel');

    appEvents.emit('session.connections_changed');
    check(modal.querySelector('#send-logs-channel') === channels && channels.value === 'a-support' && servers.value === 'alpha',
      'A connection update refreshes the options in place and keeps the choice');

    const serverSearch = search(servers, 'bet');
    check(rows().length === 1 && rows()[0] === 'Beta', 'Typing filters the servers');
    key(serverSearch, 'Enter');
    check(servers.value === 'beta', 'The other server is chosen');
    check(channels.value === '' && confirm.disabled, 'Changing the server clears the chosen channel');
    check([...channels.options].filter(item => !item.hidden).map(item => item.value).join() === 'b-news,b-offtopic', 'The channels follow the chosen server');

    sessions = [alpha];
    appEvents.emit('session.connections_changed');
    check(servers.value === 'alpha' && servers.options.length === 1, 'A server that disconnects falls back to one still connected');

    owner.abort();
    await waitFor(() => !document.querySelector('.send-logs-modal'), () => 'The modal did not close with its owner');
    check(!popup(), 'No popup is left behind');
  } finally {
    owner.abort();
    selectEnhancer.dispose();
    sessionManager.getAll = originals.getAll;
    sessionManager.getActive = originals.getActive;
  }
  return checks;
}
