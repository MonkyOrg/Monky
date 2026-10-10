const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('audit log dialog filters, pages, refreshes and closes on revocation without leaking listeners', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `server-audit-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_AUDIT_PROFILE: profile };
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
  const { Permission, MessageType } = require('@monky/shared');
  app.setPath('userData', process.env.MONKY_AUDIT_PROFILE);
  app.on('window-all-closed', () => {});
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
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'server-audit-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__server_audit__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><button id="opener">Audit</button></body></html>');
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
    browser = new BrowserWindow({
      show: false, width: 1100, height: 950,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Server audit DOM regression timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${address.port}/__server_audit__`);
      const checks = await browser.webContents.executeJavaScript(
        `(${runRegression.toString()})(${JSON.stringify({
          language, view: Permission.VIEW_AUDIT_LOG, requestType: MessageType.SERVER_AUDIT_GET,
        })})`, true);
      console.log(`Server audit DOM (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(config) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(config.language);
  const [{ ServerAuditModal }, { sessionManager }, { appEvents }, { RequestTimeoutError }] = await Promise.all([
    import('/views/ServerAuditModal.ts'), import('/core/SessionManager.ts'),
    import('/core/EventBus.ts'), import('/core/NetworkClient.ts'),
  ]);
  sessionManager.install();
  let checks = 0;
  let last = 'start';
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; last = message; };
  window.addEventListener('unhandledrejection', (event) => console.error('Unhandled after', last, event.reason));
  try {
    return await scenario();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} (after "${last}")`);
  }

  async function scenario() {
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  const listenerCount = () => [...appEvents.listeners.values()].reduce((total, entries) => total + entries.size, 0);
  const initialListeners = listenerCount();
  const requests = [];
  const cancelled = [];
  const scheduled = [];
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  let timerId = 2000000;
  window.setTimeout = (callback, delay, ...args) => {
    const source = String(callback);
    const kind = delay === 5000 && source.includes('poll') ? 'poll' : delay === 300 ? 'search' : null;
    if (!kind) return originalSetTimeout(callback, delay, ...args);
    const id = ++timerId;
    scheduled.push({ id, kind, run: () => callback(...args) });
    return id;
  };
  window.clearTimeout = (id) => {
    const index = scheduled.findIndex((entry) => entry.id === id);
    if (index >= 0) scheduled.splice(index, 1);
    else originalClearTimeout(id);
  };
  const fire = (kind) => {
    const pending = scheduled.filter((entry) => entry.kind === kind);
    check(pending.length === 1, `expected exactly one ${kind} timer, found ${pending.length}`);
    scheduled.splice(scheduled.indexOf(pending[0]), 1);
    pending[0].run();
  };
  const entry = (id, overrides = {}) => ({
    id, createdAt: Date.UTC(2026, 9, 9, 12, 0, 0) + id, action: 'channel.update',
    actor: { type: 'user', id: 'admin', name: 'Admin' }, target: { type: 'channel', id: `c${id}`, name: `canal-${id}` },
    related: {}, changes: [{ field: 'name', before: 'old', after: `canal-${id}` }], detail: null, ...overrides,
  });
  const page = (entries, hasMore = false) => ({ serverId: 'server-a', entries, hasMore, retentionDays: 90 });
  const dialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing]) [role="dialog"]');
  const rows = () => [...document.querySelectorAll('.modal-backdrop:not([data-ui-closing]) .server-audit-entry')];
  const toast = () => document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');

  const session = sessionManager.create('server-a', 3000, 'Auditor');
  session.client.getStatus = () => 'CONNECTED';
  session.client.getConnectionId = () => 'socket-a';
  session.client.sendRequest = (type, payload, requestId) => new Promise((resolve, reject) => {
    requests.push({ type, payload, requestId, resolve, reject });
  });
  session.client.cancelRequest = (requestId) => { cancelled.push(requestId); return true; };
  session.serverStore.setServerDetails({
    id: 'server-a', name: 'Server <A>', createdAt: 1, maxUsers: 10, hasPassword: false, voiceMode: 'p2p',
    protocol: { version: 38, minimumVersion: 35, features: ['server-audit'] },
    channels: [], members: [], voiceStates: {},
    roles: [{ id: 'auditors', name: 'Auditors', color: '#5865f2', position: 1, permissions: config.view, isDefault: false }],
    userRoles: [{ userId: 'auditor', roleIds: ['auditors'] }], myPermissions: config.view,
  }, { id: 'auditor', clientId: 'auditor-key', sessionId: 'auditor:server-a', nickname: 'Auditor', status: 'ONLINE', joinedAt: 1 });
  sessionManager.activate(session.key);

  const modal = new ServerAuditModal();
  const opener = document.querySelector('#opener');
  opener.focus();
  const opening = modal.open(session);
  await flush();
  check(dialog()?.getAttribute('aria-modal') === 'true', 'the audit log is an accessible modal dialog');
  check(document.querySelector('#audit-results').getAttribute('aria-busy') === 'true', 'the first page shows a loading state');
  check(requests[0].type === config.requestType && JSON.stringify(requests[0].payload) === '{"serverId":"server-a"}',
    'the first request asks this server for every category');
  check(document.querySelector('#audit-subtitle').textContent.includes('Server <A>'), 'the server name is shown as text');
  requests[0].resolve(page([
    entry(30, { action: 'voice.move', target: { type: 'user', id: 'm', name: '<img src=x id=injected>' },
      related: { from: { type: 'channel', id: 'l', name: 'Lobby' }, to: { type: 'channel', id: 's', name: 'Stage' } }, changes: [] }),
    entry(20), entry(10, { changes: [{ field: 'password' }] }),
  ], true));
  await opening;
  check(rows().length === 3, 'every entry of the page is listed');
  check(!document.querySelector('#injected') && rows()[0].textContent.includes('<img src=x id=injected>'), 'names are rendered as text');
  check(rows()[0].textContent.includes('Lobby') && rows()[0].textContent.includes('Stage'), 'moves name both rooms');
  check(rows()[1].querySelector('.server-audit-before').textContent === 'old' &&
    rows()[1].querySelector('.server-audit-after').textContent === 'canal-20', 'changes show the value before and after');
  check(rows()[2].textContent.includes(t('serverAudit.changed')), 'secret fields only say that they changed');
  check(document.querySelector('[data-audit-filter="all"]').getAttribute('aria-pressed') === 'true', 'all categories start selected');
  check(!document.querySelector('.server-audit-filters input'), 'filters are buttons, never native checkboxes or radios');

  const closeButton = document.querySelector('#modal-close');
  const loadMore = document.querySelector('#audit-load-more');
  check(!loadMore.hidden, 'more pages offer a load more button');
  closeButton.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  check(document.activeElement === loadMore, 'Shift+Tab wraps to the last control');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check(document.activeElement === closeButton, 'Tab wraps back to the first control');

  loadMore.click();
  await flush();
  check(requests[1].payload.before === 10 && loadMore.disabled, 'loading more asks for entries older than the last one');
  requests[1].resolve(page([entry(5)]));
  await flush();
  check(rows().length === 4 && rows()[3].dataset.auditId === '5', 'older entries are appended');
  check(loadMore.hidden && document.querySelector('#audit-status').textContent === t('serverAudit.reachedEnd'),
    'the last page says there is nothing older');

  fire('poll');
  await flush();
  check(requests[2].payload.after === 30, 'refreshing asks only for entries newer than the newest one');
  requests[2].resolve(page([entry(50), entry(40)]));
  await flush();
  check(rows()[0].dataset.auditId === '50' && rows()[1].dataset.auditId === '40', 'new entries appear on top in order');
  check(document.querySelector('#audit-status').textContent === t('serverAudit.newEntries'), 'new entries are announced');

  const voice = document.querySelector('[data-audit-filter="voice"]');
  voice.click();
  check(voice.getAttribute('aria-pressed') === 'true' &&
    document.querySelector('[data-audit-filter="all"]').getAttribute('aria-pressed') === 'false', 'one category is selected at a time');
  check(scheduled.every((timer) => timer.kind !== 'poll'), 'changing the filter stops the old refresh');
  await flush();
  check(requests[3].payload.category === 'voice', 'the filter is sent to the server');
  document.querySelector('[data-audit-filter="roles"]').click();
  await flush();
  check(requests.length === 4, 'reads never overlap');
  requests[3].resolve(page([entry(9, { action: 'voice.mute' })]));
  await flush();
  check(!rows().some((row) => row.dataset.auditId === '9'), 'a page for a previous filter is discarded');
  check(requests[4].payload.category === 'roles', 'the latest filter is read next');
  requests[4].resolve(page([]));
  await flush();
  check(document.querySelector('#audit-results').textContent.includes(t('serverAudit.noMatches')), 'empty filtered results say so');

  const search = document.querySelector('#audit-search');
  search.value = '  Ana ';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  check(requests.length === 5, 'typing waits before searching');
  fire('search');
  await flush();
  check(requests[5].payload.query === 'Ana' && requests[5].payload.category === 'roles', 'search combines with the filter');
  requests[5].reject(new RequestTimeoutError(config.requestType));
  await flush();
  check(toast()?.getAttribute('role') === 'alert' && toast().textContent.includes(t('serverAudit.timeout')),
    'failures appear in the shared error toast');
  check(dialog() && document.querySelector('#audit-retry'), 'a failed load offers to retry without closing');
  document.querySelector('#audit-retry').click();
  await flush();
  check(requests[6].payload.query === 'Ana', 'retrying repeats the same search');
  requests[6].resolve(page([entry(7, { action: 'role.assign', related: { role: { type: 'role', id: 'r', name: 'Mods' } } })]));
  await flush();
  check(rows().length === 1 && rows()[0].textContent.includes('Mods'), 'the retried page renders');

  const pendingPoll = scheduled.find((timer) => timer.kind === 'poll');
  check(pendingPoll, 'a refresh is scheduled');
  fire('poll');
  await flush();
  session.serverStore.myPermissions = 0;
  appEvents.emit('server.roles_updated');
  check(!dialog(), 'revoking the permission removes the audit log at once');
  check(cancelled.includes(requests[7].requestId), 'revocation cancels the pending refresh');
  check(toast()?.textContent.includes(t('serverAudit.permissionDenied')), 'revocation is explained in a toast');
  check(scheduled.length === 0, 'no timer survives the close');
  check(listenerCount() === initialListeners, 'closing removes every bus listener');
  requests[7].resolve(page([entry(99)]));
  await flush();
  check(!dialog() && !document.querySelector('[data-audit-id="99"]'), 'late data cannot reopen or render');

  session.serverStore.myPermissions = config.view;
  session.serverStore.serverDetails.protocol = { version: 38, minimumVersion: 35, features: [] };
  await modal.open(session);
  check(!dialog() && requests.length === 8, 'servers without the audit log are never asked');
  check(toast()?.textContent.includes(t('serverAudit.updateRequired')), 'an outdated server is explained');
  session.serverStore.serverDetails.protocol = { version: 38, minimumVersion: 35, features: ['server-audit'] };

  opener.focus();
  const reopening = modal.open(session);
  await flush();
  requests[8].resolve(page([entry(1)]));
  await reopening;
  check(rows().length === 1 && document.querySelector('[data-audit-filter="all"]').getAttribute('aria-pressed') === 'true',
    'reopening starts again from every category');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(!dialog(), 'Escape closes the audit log');
  check(document.activeElement === opener, 'closing restores focus');
  check(listenerCount() === initialListeners && scheduled.length === 0, 'all listeners and timers are released');
  await sessionManager.removeAll();
  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
  return checks;
  }
}
