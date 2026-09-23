const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('remote and local monitor dialogs retain source binding, read-only controls and complete cleanup', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `server-monitor-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_MONITOR_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_MONITOR_PROFILE);
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
        name: 'server-monitor-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__server_monitor__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><button id="opener">Monitor</button></body></html>');
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
    timeout = setTimeout(() => { console.error('Server monitor DOM regression timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${address.port}/__server_monitor__`);
      const checks = await browser.webContents.executeJavaScript(
        `(${runRegression.toString()})(${JSON.stringify({
          language, view: Permission.VIEW_SERVER_MONITOR, manage: Permission.MANAGE_SERVER,
          requestType: MessageType.SERVER_MONITOR_GET,
        })})`, true);
      console.log(`Server monitor DOM (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(config) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(config.language);
  const [{ ServerMonitorModal }, { sessionManager }, { appEvents }, { RequestTimeoutError }, { ServerRolesTab }] = await Promise.all([
    import('/views/ServerMonitorModal.ts'), import('/core/SessionManager.ts'),
    import('/core/EventBus.ts'), import('/core/NetworkClient.ts'),
    import('/views/serverSettings/tabs/ServerRolesTab.ts'),
  ]);
  sessionManager.install();
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  const listenerCount = () => [...appEvents.listeners.values()].reduce((total, entries) => total + entries.size, 0);
  const initialListeners = listenerCount();
  const requests = [];
  const cancelled = [];
  const logListeners = new Set();
  const statusListeners = new Set();
  let localReads = 0;
  let localClears = 0;
  let copied = '';
  let refuseCopy = false;
  let localStatsRead;
  const baseStats = {
    serverName: 'Server', port: 3000, startedAt: 1000, uptimeMs: 30000, onlineUsers: 2,
    members: 3, channels: 2, messages: 4, maxUsers: 10,
  };
  const log = { timestamp: '2026-09-14T13:00:00.000Z', level: 'INFO', category: 'NETWORK', message: 'New client connection.' };
  const result = (serverId, sequence = 1) => ({
    serverId, stats: { ...baseStats, serverName: serverId },
    entries: [{ ...log, sequence }], cursor: sequence, dropped: 0,
  });
  localStatsRead = async () => ({ ...baseStats, dataDir: 'local-host' });
  window.api = {
    hostServerStatus: async () => ({ isRunning: true, port: 3000, serverId: 'local-host' }),
    hostServerStats: async () => { localReads++; return localStatsRead(); },
    hostServerLogs: async () => [log],
    hostServerClearLogs: async () => { localClears++; },
    onHostServerLog: (listener) => { logListeners.add(listener); return () => logListeners.delete(listener); },
    onHostServerStatusChanged: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (value) => { if (refuseCopy) throw new Error('Clipboard denied'); copied = value; },
  } });
  const scheduled = new Map();
  let timerId = 1000000;
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    if (delay !== 3000) return originalSetTimeout(callback, delay, ...args);
    const id = ++timerId;
    scheduled.set(id, () => callback(...args));
    return id;
  };
  window.clearTimeout = (id) => {
    if (scheduled.delete(id)) return;
    originalClearTimeout(id);
  };
  const poll = () => {
    check(scheduled.size === 1, 'expected exactly one non-overlapping monitor timer');
    const [id, callback] = scheduled.entries().next().value;
    scheduled.delete(id);
    callback();
  };
  const session = (id, port) => {
    const value = sessionManager.create(id, port, 'Viewer');
    value.client.getStatus = () => 'CONNECTED';
    value.client.getConnectionId = () => `socket-${id}`;
    value.client.sendRequest = (type, payload, requestId) => new Promise((resolve, reject) => {
      requests.push({ server: id, type, payload, requestId, resolve, reject });
    });
    value.client.cancelRequest = (requestId) => { cancelled.push(requestId); return true; };
    value.serverStore.setServerDetails({
      id, name: id, createdAt: 1, maxUsers: 10, hasPassword: false, voiceMode: 'p2p',
      channels: [], members: [], voiceStates: {},
      roles: [{ id: 'viewers', name: 'Viewers', color: '#5865f2', position: 1, permissions: config.view, isDefault: false }],
      userRoles: [{ userId: 'viewer', roleIds: ['viewers'] }], myPermissions: config.view,
    }, { id: 'viewer', clientId: 'viewer-key', sessionId: `viewer:${id}`, nickname: 'Viewer', status: 'ONLINE', joinedAt: 1 });
    return value;
  };
  const first = session('server-a', 3000);
  const second = session('server-b', 3001);
  sessionManager.activate(first.key);
  const roleHtml = document.createElement('div');
  roleHtml.innerHTML = new ServerRolesTab().renderHtml();
  const permissionSwitch = roleHtml.querySelector(`[data-permission="${config.view}"]`);
  check(!!permissionSwitch, 'monitor viewing is editable on the actual roles tab');
  check(permissionSwitch.closest('label')?.classList.contains('permission-switch'), 'permission uses the existing switch component');
  check(roleHtml.textContent.includes(t('permissions.viewServerMonitor')), 'permission label is localized');
  const modal = new ServerMonitorModal();
  const opener = document.querySelector('#opener');
  opener.focus();
  const oldOpening = modal.openRemote(first);
  check(requests[0].type === config.requestType && requests[0].payload.serverId === 'server-a', 'first request captures server A');
  modal.close();
  check(cancelled.includes(requests[0].requestId), 'closing cancels the original request');
  sessionManager.activate(second.key);
  const newOpening = modal.openRemote(second);
  check(requests[1].payload.serverId === 'server-b', 'reopening captures server B');
  requests[0].resolve(result('server-a', 99));
  await oldOpening;
  check(document.querySelector('#stat-online .skeleton') &&
    document.querySelector('#monitor-stats').getAttribute('aria-busy') === 'true', 'late A response cannot replace B loading metrics');
  requests[1].resolve(result('server-b'));
  await newOpening;
  check(document.querySelector('#stat-online').textContent === '2', 'current remote metrics render');
  check(document.querySelector('#stat-members').textContent === '3/10', 'online and registered members stay distinct');
  check(document.querySelector('#monitor-source').textContent.includes('server-b'), 'remote source is explicitly identified');
  check(localReads === 0 && logListeners.size === 0, 'remote monitoring never opens local IPC stats or logs');
  check(document.querySelector('[role="dialog"]').getAttribute('aria-modal') === 'true', 'monitor is an accessible modal dialog');
  const closeButton = document.querySelector('#modal-close');
  const clearButton = document.querySelector('#btn-clear-logs');
  closeButton.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  check(document.activeElement === clearButton, 'Shift+Tab wraps to the final control');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check(document.activeElement === closeButton, 'Tab wraps back to the close control');
  document.querySelector('#btn-copy-logs').click();
  await flush();
  check(copied.includes(log.message), 'copy exports the visible logs');
  check(document.querySelector('#monitor-action-status').textContent === t('serverMonitor.copied'), 'copy feedback is localized');
  refuseCopy = true;
  document.querySelector('#btn-copy-logs').click();
  await flush();
  check(document.querySelector('#monitor-action-status').textContent === t('serverMonitor.copyFailed'), 'clipboard failures are visible and localized');
  clearButton.click();
  check(!document.querySelector('#monitor-logs').textContent.includes(log.message), 'clear affects the displayed entries');
  check(localClears === 0 && requests.length === 2, 'clear never mutates local or remote history');
  poll();
  check(requests[2].payload.cursor === 1, 'polling continues from the prior cursor');
  second.serverStore.myPermissions = 0;
  appEvents.emit('server.roles_updated');
  check(cancelled.includes(requests[2].requestId), 'revocation cancels the pending request');
  check(scheduled.size === 0, 'revocation removes polling');
  check(document.querySelector('#monitor-error').textContent === t('serverMonitor.permissionDenied'), 'permission revocation is localized');
  check(second.client.getStatus() === 'CONNECTED' && sessionManager.get(second.key) === second, 'revocation does not disconnect the user');
  requests[2].resolve(result('server-b', 2));
  await flush();
  check(document.querySelector('#stat-online').textContent === '\u2014', 'revoked late data cannot reappear');
  modal.close();
  check(listenerCount() === initialListeners, 'remote close removes all monitor bus listeners');
  second.serverStore.myPermissions = config.manage;
  await modal.openRemote(second);
  check(requests.length === 3 && localReads === 0, 'manage-server is not a viewing grant or local fallback');
  check(document.querySelector('#monitor-error').textContent === t('serverMonitor.permissionDenied'), 'initial denial is explicit');
  second.serverStore.myPermissions = config.view;
  const timeoutOpening = modal.openRemote(second);
  requests[3].reject(new RequestTimeoutError(config.requestType));
  await timeoutOpening;
  check(document.querySelector('#monitor-error').textContent === t('serverMonitor.timeout'), 'timeouts are localized');
  check(localReads === 0 && scheduled.size === 0, 'timeout has no local fallback or retries');
  const switchOpening = modal.openRemote(second);
  sessionManager.activate(first.key);
  check(!document.querySelector('[role="dialog"]'), 'switching servers closes the remote monitor immediately');
  requests[4].resolve(result('server-b', 3));
  await switchOpening;
  sessionManager.removeAll();
  let resolveLocal;
  localStatsRead = () => new Promise((resolve) => { resolveLocal = resolve; });
  const localOpening = modal.openLocal();
  await flush();
  check(logListeners.size === 1 && statusListeners.size === 1, 'local source subscribes once before loading');
  modal.close();
  check(logListeners.size === 0 && statusListeners.size === 0, 'local close removes IPC listeners even during loading');
  resolveLocal({ ...baseStats, dataDir: 'local-host' });
  await localOpening;
  check(!document.querySelector('[role="dialog"]') && scheduled.size === 0, 'late local response cannot reopen or retain a timer');
  localStatsRead = async () => ({ ...baseStats, dataDir: 'local-host' });
  opener.focus();
  await modal.openLocal();
  check(document.querySelector('#monitor-source').textContent.trim() === t('serverMonitor.localSource'), 'local monitoring works without a connected session');
  document.querySelector('#btn-clear-logs').click();
  check(localClears === 0, 'local clear is also display-only');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(!document.querySelector('[role="dialog"]'), 'Escape closes the monitor');
  check(document.activeElement === opener, 'closing restores keyboard focus');
  check(logListeners.size === 0 && statusListeners.size === 0 && scheduled.size === 0, 'all local subscriptions and timers are released');
  check(listenerCount() === initialListeners, 'all monitor event subscriptions are released');
  return checks;
}
