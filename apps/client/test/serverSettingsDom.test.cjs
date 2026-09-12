const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('server settings apply immediately and guard every dismissal across tabs and sessions', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `server-settings-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SERVER_SETTINGS_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_SERVER_SETTINGS_PROFILE);
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
        name: 'server-settings-regression-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__server_settings_regression__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
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
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Server settings DOM regression timed out'); void finish(1); }, 90000);
    await browser.loadURL(`http://127.0.0.1:${address.port}/__server_settings_regression__`);
    const checks = await browser.webContents.executeJavaScript(`(${runRegression.toString()})()`, true);
    console.log(`Server settings DOM: ${checks} checks passed`);
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression() {
  const [{ ServerSettingsModal }, stores, network, { appEvents }] = await Promise.all([
    import('/views/ServerSettingsModal.ts'), import('/stores/serverStore.ts'),
    import('/core/NetworkClient.ts'), import('/core/EventBus.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const listenerCount = () => [...appEvents.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  const initialListeners = listenerCount();
  const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  const member = (id) => ({ id, clientId: `${id}-key`, sessionId: `${id}-session`, nickname: id, status: 'ONLINE', joinedAt: 1 });
  const store = new stores.ServerStore();
  const role = { id: 'editors', serverId: 'server-a', name: 'Editors', color: '#5865f2', position: 1, permissions: 16, isDefault: false, createdAt: 1 };
  store.setServerDetails({
    id: 'server-a', name: 'Server A', createdAt: 1, maxUsers: 0, hasPassword: false,
    iconUrl: 'data:image/png;base64,AA==', voiceMode: 'p2p', turnEnabled: false,
    turnAvailability: { supported: false, reason: 'not-installed', autoInstallable: true },
    allowSoundboard: true, allowEveryoneMention: true, allowMessageEdit: true, showRoleBadgesToEveryone: true,
    channels: [], members: [member('admin'), member('bob')], knownMembers: [member('admin'), member('bob')],
    voiceStates: {}, roles: [role], userRoles: [], ownerId: 'admin', myPermissions: 0xFFFFFFFF,
    attachmentStorage: { usedBytes: 0, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 },
  }, member('admin'));
  const client = new network.NetworkClient();
  client.sessionKey = 'server-a';
  client.getStatus = () => 'CONNECTED';
  const requests = [];
  let bots = [{ id: 'bot-a', name: 'Helper', createdAt: 1, avatarUrl: null, online: false, bound: true }];
  client.sendRequest = (type, payload) => {
    if (type === 'BOT_LIST') return Promise.resolve({ bots: structuredClone(bots) });
    return new Promise((resolve, reject) => { requests.push({ type, payload: structuredClone(payload), resolve, reject, done: false }); });
  };
  const pendingRequest = (type) => {
    const request = requests.find((entry) => !entry.done && entry.type === type);
    if (!request) throw new Error(`No pending ${type}: ${JSON.stringify(requests.map((entry) => [entry.type, entry.done]))}`);
    return request;
  };
  const acknowledge = (type) => {
    const request = pendingRequest(type);
    request.done = true;
    const payload = request.payload;
    let result = {};
    if (type === 'SERVER_UPDATE_SETTINGS') {
      const s = store.serverDetails;
      for (const key of ['name', 'maxUsers', 'allowSoundboard', 'allowEveryoneMention', 'allowMessageEdit', 'showRoleBadgesToEveryone', 'turnEnabled', 'voiceMode']) {
        if (payload[key] !== undefined) s[key] = payload[key];
      }
      if (payload.voiceMode === 'sfu') s.turnEnabled = false;
      if (payload.turnEnabled) s.turnAvailability = { supported: true };
      if ('password' in payload) s.hasPassword = Boolean(payload.password);
      if ('iconBase64' in payload) s.iconUrl = payload.iconBase64;
      if (payload.maxAttachmentFileBytes !== undefined) s.attachmentStorage.maxFileBytes = payload.maxAttachmentFileBytes;
      if (payload.maxAttachmentStorageBytes !== undefined) s.attachmentStorage.maxTotalBytes = payload.maxAttachmentStorageBytes;
      result = { ...s };
      appEvents.emit('server.updated');
    } else if (type === 'ROLE_UPDATE') {
      const { roleId, ...patch } = payload;
      store.updateRoles(store.roles.map((entry) => entry.id === roleId ? { ...entry, ...patch } : entry), store.userRoles);
    } else if (type === 'ROLE_ASSIGN' || type === 'ROLE_UNASSIGN') {
      const roleIds = store.getUserRoleIds(payload.userId).filter((id) => id !== payload.roleId);
      if (type === 'ROLE_ASSIGN') roleIds.push(payload.roleId);
      const next = [...store.userRoles.filter((entry) => entry.userId !== payload.userId), { userId: payload.userId, roleIds }];
      store.updateRoles(store.roles, next);
    } else if (type === 'ROLE_CREATE') {
      store.updateRoles([...store.roles, { ...role, ...payload, id: 'created-role' }], store.userRoles);
    } else if (type === 'ROLE_DELETE') {
      store.updateRoles(store.roles.filter((entry) => entry.id !== payload.roleId), store.userRoles);
    } else if (type === 'BOT_UPDATE_PROFILE') {
      bots = bots.map((entry) => entry.id === payload.botId ? {
        ...entry, ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.avatarBase64 === undefined ? {} : { avatarUrl: payload.avatarBase64 }),
      } : entry);
      result = { bot: bots.find((entry) => entry.id === payload.botId) };
    } else if (type === 'BOT_REVOKE') bots = bots.filter((entry) => entry.id !== payload.botId);
    else if (type === 'BOT_CREATE') {
      const bot = { id: 'created-bot', name: payload.name, createdAt: 1, avatarUrl: null, online: false, bound: false };
      bots.push(bot);
      result = { bot, token: 'non-secret-test-token' };
    }
    request.resolve(result);
    return payload;
  };
  const reject = (type, message) => {
    const request = pendingRequest(type);
    request.done = true;
    request.reject(new Error(message));
  };
  stores.setActiveServerStore(store);
  network.setActiveNetworkClient(client);
  const modal = new ServerSettingsModal();
  const field = (id) => document.querySelector(id);
  const change = (id, value) => {
    const input = field(id);
    if (!input) throw new Error(`Missing ${id}`);
    if (typeof value === 'boolean') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const tab = (name) => field(`[data-tab="${name}"]`).click();
  const locked = () => field('#btn-done')?.disabled === true;
  const mainBackdrop = () => document.querySelector('.server-settings-modal-card')?.closest('.modal-backdrop');
  modal.open();
  await flush();
  check(!field('#btn-save') && field('#btn-done'), 'Save is replaced with one Done button');
  check(field('[data-settings-section="server-profile"]').contains(field('#input-server-name')) &&
    field('#server-voice-mode-cards').children.length === 2, 'Profile and selectable-card markup retain their expected layout boundaries');
  const original = mainBackdrop();
  field('#input-server-name').focus();
  field('#input-server-name').value = 'First rename';
  field('#input-server-name').dispatchEvent(new Event('input', { bubbles: true }));
  check(requests.length === 0, 'Typing does not persist until editing finishes');
  check(modal.close() === false && locked(), 'Public close commits the focused edit before checking the lock');
  await flush();
  check(Object.keys(pendingRequest('SERVER_UPDATE_SETTINGS').payload).join() === 'name', 'Rename sends only its own field');
  for (const dismiss of [
    () => field('#btn-done').click(),
    () => field('#modal-close').click(),
    () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    () => original.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    () => modal.close(),
    () => modal.open('storage'),
  ]) {
    dismiss();
    check(mainBackdrop() === original && locked(), 'Every dismissal and reopen path respects the same pending guard');
  }
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(!locked() && mainBackdrop() === original, 'Acknowledgement unlocks without dismissing the modal');
  change('#input-server-name', 'Rapid one');
  change('#input-server-name', 'Rapid two');
  tab('voice_video');
  change('#checkbox-allow-soundboard', false);
  await flush();
  check(pendingRequest('SERVER_UPDATE_SETTINGS').payload.name === 'Rapid one', 'First rapid edit is not replaced by a later DOM value');
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(locked() && field('#input-server-name').value === 'Rapid two', 'Earlier acknowledgement never overwrites a newer edit');
  check(pendingRequest('SERVER_UPDATE_SETTINGS').payload.name === 'Rapid two', 'Second rapid edit is serialized');
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(pendingRequest('SERVER_UPDATE_SETTINGS').payload.allowSoundboard === false, 'Changing tabs preserves queued settings');
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(!locked() && store.serverDetails.allowSoundboard === false, 'All queued changes finish before dismissal unlocks');
  change('#checkbox-turn-enabled', true);
  await flush();
  appEvents.emit('message.TURN_INSTALL_PROGRESS', { stage: 'configuring', percent: 100 });
  check(locked() && !field('#turn-install-progress').hidden, '100% install progress is not the TURN activation acknowledgement');
  reject('SERVER_UPDATE_SETTINGS', 'TURN failed to bind');
  await flush();
  check(!locked() && !field('#checkbox-turn-enabled').checked, 'Rejected TURN activation restores persisted false and releases the guard');
  check(field('#server-settings-banner').textContent.includes('TURN failed'), 'The actual activation error remains explicit');
  change('#checkbox-turn-enabled', true);
  await flush();
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(field('#checkbox-turn-enabled').checked && !locked(), 'TURN can be retried after failure');
  tab('storage');
  const beforeInvalid = requests.length;
  change('#input-attach-file-mb', '200');
  await flush();
  check(requests.length === beforeInvalid && field('#input-attach-file-mb').value === '25', 'Invalid storage changes never send and restore the persisted quota');
  change('#input-attach-file-mb', '20');
  await flush();
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(!field('#server-settings-banner').classList.contains('show'), 'Correcting a rejected field clears its error');
  tab('general');
  change('#checkbox-limit-members', true);
  await flush();
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  change('#input-max-users', '1');
  await flush();
  check(Number(field('#input-max-users').value) === store.serverDetails.maxUsers && !locked(), 'A member cap below registered membership is rejected without trapping');
  change('#input-max-users', '2');
  await flush();
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  change('#checkbox-limit-members', false);
  await flush();
  check(pendingRequest('SERVER_UPDATE_SETTINGS').payload.maxUsers === 0, 'Disabling the cap explicitly persists unlimited');
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  tab('security');
  change('#input-server-pass', 'New access secret');
  await flush();
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(store.serverDetails.hasPassword && !field('#btn-remove-pass').hidden && field('#input-server-pass').value === '', 'Password blur applies and clears secret text after acknowledgement');
  field('#btn-remove-pass').click();
  await flush();
  check(pendingRequest('SERVER_UPDATE_SETTINGS').payload.password === null && locked(), 'Password removal is immediate and acknowledged');
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  tab('general');
  field('#server-icon-wrapper').click();
  await flush();
  document.querySelector('.dialog-card [data-action="remove"]').click();
  await flush();
  check(pendingRequest('SERVER_UPDATE_SETTINGS').payload.iconBase64 === null && locked(), 'Server icon removal is immediately persisted');
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  field('[data-mode="sfu"]').click();
  await flush();
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(field('[data-mode="sfu"]').getAttribute('aria-pressed') === 'true' && field('#checkbox-turn-enabled').disabled, 'SFU cards retain persisted selection and disable incompatible TURN');
  field('[data-mode="p2p"]').click();
  await flush();
  check(locked() && document.querySelector('.dialog-card'), 'SFU departure confirmation is part of the pending operation');
  document.querySelector('.dialog-card [data-action="cancel"]').click();
  await flush();
  check(!locked() && field('[data-mode="sfu"]').getAttribute('aria-pressed') === 'true', 'Declining a prerequisite never changes persisted mode');
  tab('roles');
  field('[data-role-open="editors"]').click();
  change('#role-editor-name', 'New role name');
  await flush();
  check(locked() && pendingRequest('ROLE_UPDATE').payload.name === 'New role name', 'Existing role names apply without a role Save button');
  acknowledge('ROLE_UPDATE');
  await flush();
  check(store.getRole('editors').name === 'New role name' && field('#btn-role-save').hidden, 'Role editor remains open at the acknowledged state');
  field('[data-role-editor-tab="members"]').click();
  change('.role-editor-member-switch[data-user-id="bob"]', true);
  await flush();
  reject('ROLE_ASSIGN', 'Assignment denied');
  await flush();
  check(!field('.role-editor-member-switch[data-user-id="bob"]').checked && !locked(), 'Role assignment failure is reconciled and does not trap the operator');
  check(field('#server-settings-banner').textContent.includes('Assignment denied'), 'Role assignment failures are not swallowed');
  change('.role-editor-member-switch[data-user-id="bob"]', true);
  await flush();
  acknowledge('ROLE_ASSIGN');
  await flush();
  check(field('.role-editor-member-switch[data-user-id="bob"]').checked, 'Role assignment retries preserve the editor');
  field('[data-role-editor-tab="permissions"]').click();
  change('.role-permission-switch[data-permission="32"]', true);
  await flush();
  check(pendingRequest('ROLE_UPDATE').payload.permissions === 48, 'Permission switches apply only the requested bit against current permissions');
  acknowledge('ROLE_UPDATE');
  await flush();
  field('[data-role-editor-tab="display"]').click();
  field('#role-editor-color').click();
  field('[data-color-preset="#57f287"]').click();
  field('#role-editor-name').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
  await flush();
  check(Object.keys(pendingRequest('ROLE_UPDATE').payload).sort().join() === 'color,roleId', 'Color changes do not submit stale role fields');
  check(pendingRequest('ROLE_UPDATE').payload.color === '#57f287' && !document.querySelector('.color-picker-popover'),
    'The shared role picker preserves its immutable selected color when dismissed outside');
  acknowledge('ROLE_UPDATE');
  await flush();
  field('#role-editor-color').click();
  const roleColorInput = field('[data-color-hex]');
  roleColorInput.value = '#3158AF';
  roleColorInput.dispatchEvent(new Event('input', { bubbles: true }));
  field('#role-editor-name').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
  await flush();
  check(pendingRequest('ROLE_UPDATE').payload.color === '#3158af',
    'Role colors accept arbitrary normalized HEX, not only the former preset palette');
  acknowledge('ROLE_UPDATE');
  await flush();
  field('#role-editor-color').click();
  const colorOwner = field('#role-editor-color').closest('.modal-backdrop');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check(colorOwner.isConnected && !document.querySelector('.color-picker-popover'),
    'Escape closes the role color picker before the server settings capture-phase handler');
  field('#role-editor-color').click();
  field('[data-color-preset="#ed4245"]').click();
  field('#role-editor-name').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
  await flush();
  reject('ROLE_UPDATE', 'Color update denied');
  await flush();
  check(field('#role-editor-color').value === '#3158af' && store.getRole('editors').color === '#3158af'
    && field('#server-settings-banner').textContent.includes('Color update denied') && !locked(),
    'A rejected color change restores the acknowledged role color and reports the failure');
  change('#role-editor-is-default', true);
  await flush();
  acknowledge('ROLE_UPDATE');
  await flush();
  check(store.getRole('editors').isDefault, 'Role auto-assignment is immediately persisted');
  field('[data-role-editor-tab="members"]').click();
  change('.role-editor-member-switch[data-user-id="bob"]', false);
  await flush();
  acknowledge('ROLE_UNASSIGN');
  await flush();
  field('[data-bulk-assign="true"]').click();
  await flush();
  document.querySelector('.dialog-card [data-action="confirm"]').click();
  await flush();
  reject('ROLE_ASSIGN', 'Owner cannot be assigned');
  await flush();
  check(locked(), 'A partially rejected batch keeps the guard while remaining members are applying');
  acknowledge('ROLE_ASSIGN');
  await flush();
  check(!field('.role-editor-member-switch[data-user-id="admin"]').checked &&
    field('.role-editor-member-switch[data-user-id="bob"]').checked, 'Bulk failures preserve each member’s actual acknowledged state');
  check(field('#server-settings-banner').classList.contains('show') && !locked(), 'Partial failures remain explicit and release the guard');
  field('#btn-role-create-new').click();
  change('#role-editor-name', 'Created role');
  field('#btn-role-save').click();
  await flush();
  check(locked(), 'Explicit role creation remains tracked');
  acknowledge('ROLE_CREATE');
  await flush();
  check(store.getRole('created-role') && field('[data-role-open="created-role"]'), 'Role creation refreshes the list without reopening the modal');
  const dragged = field('.role-table-row[data-role-id="created-role"]');
  const destination = field('.role-table-row[data-role-id="editors"]');
  dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
  destination.dispatchEvent(new DragEvent('dragover', { bubbles: true, clientY: destination.getBoundingClientRect().top + 1 }));
  dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  await flush();
  check(locked() && pendingRequest('ROLE_UPDATE').payload.roleId === 'created-role', 'Role reordering applies the current dragged order');
  acknowledge('ROLE_UPDATE');
  await flush();
  check(locked(), 'Role reordering waits for every role position acknowledgement');
  acknowledge('ROLE_UPDATE');
  await flush();
  check(!locked() && field('.role-table-row').dataset.roleId === 'created-role', 'Acknowledged role ordering is preserved');
  field('[data-role-open="created-role"]').click();
  field('#btn-role-delete').click();
  await flush();
  acknowledge('ROLE_DELETE');
  await flush();
  check(!store.getRole('created-role') && mainBackdrop() === original, 'Role deletion does not reopen or dismiss settings');
  tab('bots');
  await flush();
  field('[data-bot-edit="bot-a"]').click();
  change('#bot-profile-name', 'Renamed helper');
  await flush();
  check(locked() && pendingRequest('BOT_UPDATE_PROFILE').payload.name === 'Renamed helper', 'Bot profile names apply on change and own the modal guard');
  const editingName = field('#bot-profile-name');
  field('[data-bot-edit="bot-a"]').click();
  check(field('#bot-profile-name') === editingName && editingName.value === 'Renamed helper',
    'Reopening a pending bot profile keeps the edited input instead of restoring an obsolete name');
  acknowledge('BOT_UPDATE_PROFILE');
  await flush();
  check(field('#bot-profile-name').value === 'Renamed helper' && !field('#btn-save-bot-profile'), 'Bot profile has no staged Save workflow');
  const profileRequests = requests.filter((request) => request.type === 'BOT_UPDATE_PROFILE').length;
  field('#btn-done-bot-profile').click();
  await flush();
  check(field('#bot-profile-editor').hidden && requests.filter((request) => request.type === 'BOT_UPDATE_PROFILE').length === profileRequests,
    'Done after reopening and acknowledgement never submits the old bot name');
  field('[data-bot-edit="bot-a"]').click();
  check(field('#bot-profile-name').value === 'Renamed helper', 'The reopened editor reflects the acknowledged bot name');
  field('[data-photo-remove="profile"]').click();
  await flush();
  check(pendingRequest('BOT_UPDATE_PROFILE').payload.avatarBase64 === null && locked(), 'Bot photo removal is immediate, not a draft');
  acknowledge('BOT_UPDATE_PROFILE');
  await flush();
  change('#bot-name-input', 'Created bot');
  field('#btn-create-bot').click();
  await flush();
  check(locked() && field('#bot-name-input').disabled, 'Explicit bot creation retains its pending protection');
  acknowledge('BOT_CREATE');
  await flush();
  check(field('#bot-token-value').textContent === 'non-secret-test-token' && field('[data-bot-edit="created-bot"]'), 'Bot creation preserves one-time token reveal and the created bot');
  field('[data-bot-revoke="created-bot"]').click();
  await flush();
  check(locked(), 'Bot revocation confirmation is tracked');
  document.querySelector('.dialog-card [data-action="confirm"]').click();
  await flush();
  acknowledge('BOT_REVOKE');
  await flush();
  check(!field('[data-bot-edit="created-bot"]') && !locked(), 'Acknowledged revocation updates the list');
  change('#bot-manifest-url', 'https://example.invalid/bot.json');
  field('#btn-install-bot').click();
  await flush();
  check(locked() && pendingRequest('BOT_INSTALL').payload.manifestUrl.endsWith('bot.json'), 'Manifest installation waits for its final request response');
  acknowledge('BOT_INSTALL');
  await flush();
  check(!locked() && field('#bot-manifest-url').value === '', 'Successful installation releases the guard after acknowledgement');
  tab('notifications');
  const { settingsStore } = await import('/stores/settingsStore.ts');
  const originalSetter = settingsStore.setServerChatSoundOverride;
  const localWrites = [];
  settingsStore.setServerChatSoundOverride = (id, mode) => new Promise((resolve, reject) => {
    localWrites.push({
      resolve: () => Promise.resolve(originalSetter.call(settingsStore, id, mode)).then(resolve, reject), reject,
    });
  });
  change('#select-server-chat-sound', 'mentions');
  await flush();
  check(locked() && localWrites.length === 1, 'Local preferences also wait for their persistence promise');
  localWrites.shift().reject(new Error('Storage unavailable'));
  await flush();
  check(!locked() && field('#select-server-chat-sound').value === 'inherit', 'Failed local persistence reflects the last stored choice and unlocks');
  change('#select-server-chat-sound', 'mentions');
  await flush();
  await localWrites.shift().resolve();
  await flush();
  check(field('#select-server-chat-sound').value === 'mentions' && !locked(), 'Local preferences can be corrected after a rejected write');
  settingsStore.setServerChatSoundOverride = originalSetter;
  await originalSetter.call(settingsStore, 'server-a', 'all');
  check(field('#select-server-chat-sound').value === 'all', 'The existing settings.updated persistence event refreshes the choice without an extra synthetic event');
  const previousSettings = localStorage.getItem('monky_settings');
  const previousOverrides = settingsStore.chatSoundServerOverrides;
  const storageWrite = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === 'monky_settings') throw new DOMException('Synthetic quota exceeded', 'QuotaExceededError');
    return storageWrite.call(this, key, value);
  };
  try {
    change('#select-server-chat-sound', 'none');
    check(locked(), 'A real store write is guarded from enqueue through its rejection');
    await flush();
    check(!locked() && field('#select-server-chat-sound').value === 'all', 'An actual quota failure unlocks the modal and restores the persisted control');
    check(settingsStore.chatSoundServerOverrides === previousOverrides &&
      localStorage.getItem('monky_settings') === previousSettings, 'Failed actual persistence leaves the previous map and stored bytes intact');
    check(document.querySelector('.server-settings-modal-card').textContent.includes('Synthetic quota exceeded'), 'An actual quota failure is explicit rather than reported as saved');
    check(modal.close() === true, 'A rejected preference write cannot permanently trap dismissal');
  } finally {
    Storage.prototype.setItem = storageWrite;
  }
  modal.open('notifications');
  change('#select-server-chat-sound', 'none');
  await flush();
  check(!locked() && settingsStore.getServerChatSoundOverride('server-a') === 'none' &&
    field('#select-server-chat-sound').value === 'none', 'A real persistence retry succeeds after storage becomes writable');
  check(!document.querySelector('.server-settings-modal-card').textContent.includes('Synthetic quota exceeded'), 'A successful retry clears the rejected operation error');
  const peer = document.createElement('iframe');
  peer.src = 'about:blank';
  document.body.appendChild(peer);
  const peerWindow = peer.contentWindow;
  check(peerWindow !== null, 'A separate same-origin window is available for storage-event regression');
  let refreshes = 0;
  const offSettings = appEvents.on('settings.updated', () => { refreshes++; });
  const waitForStorage = async (mutate) => {
    let handle;
    let listener;
    const received = new Promise((resolve, reject) => {
      listener = () => resolve();
      window.addEventListener('storage', listener, { once: true });
      handle = setTimeout(() => reject(new Error('Missing cross-window storage event')), 3000);
    });
    try {
      mutate();
      await received;
      await flush();
    } finally {
      clearTimeout(handle);
      window.removeEventListener('storage', listener);
    }
  };
  try {
    const external = JSON.parse(localStorage.getItem('monky_settings'));
    external.chatSoundServerOverrides['server-a'] = 'mentions';
    await waitForStorage(() => peerWindow.localStorage.setItem('monky_settings', JSON.stringify(external)));
    check(refreshes === 1 && field('#select-server-chat-sound').value === 'mentions' &&
      settingsStore.getServerChatSoundOverride('server-a') === 'mentions', 'An actual external-window localStorage update rehydrates and refreshes the open modal');
    await waitForStorage(() => peerWindow.localStorage.setItem('unrelated-test-setting', 'ignored'));
    check(refreshes === 1, 'Unrelated storage keys do not reload settings');
    await waitForStorage(() => peerWindow.sessionStorage.setItem('monky_settings', '{}'));
    check(refreshes === 1 && settingsStore.getServerChatSoundOverride('server-a') === 'mentions', 'Session storage cannot overwrite the local preference');
    await waitForStorage(() => peerWindow.localStorage.removeItem('monky_settings'));
    check(refreshes === 2 && field('#select-server-chat-sound').value === 'inherit', 'Removing the settings in another window restores inherited server sound');
    await waitForStorage(() => peerWindow.localStorage.setItem('monky_settings', JSON.stringify(external)));
    await waitForStorage(() => peerWindow.localStorage.clear());
    check(refreshes === 4 && field('#select-server-chat-sound').value === 'inherit' && !locked(), 'A real external clear also refreshes without a feedback loop or pending lock');
  } finally {
    offSettings();
    peer.remove();
  }
  tab('general');
  store.ownerId = 'other';
  store.myPermissions = 2;
  appEvents.emit('server.updated');
  check(!field('[data-tab="roles"]').hidden && !field('#checkbox-show-role-badges').matches(':disabled') &&
    field('#btn-role-create-new').matches(':disabled'), 'Server managers can change server-wide badges without being granted role management');
  store.myPermissions = 4;
  appEvents.emit('server.updated');
  check(field('#checkbox-show-role-badges').matches(':disabled') && !field('#btn-role-create-new').matches(':disabled'),
    'Role management does not grant server-wide settings permission');
  store.myPermissions = 0;
  appEvents.emit('server.updated');
  check(field('#input-server-name').matches(':disabled') && field('[data-tab="bots"]').hidden, 'Permission changes immediately disable management controls');
  store.ownerId = 'admin';
  store.myPermissions = 0xFFFFFFFF;
  appEvents.emit('server.updated');
  check(!field('#input-server-name').matches(':disabled'), 'Restored permission enables corrections without reopening');
  change('#input-server-name', 'Old session update');
  change('#input-attach-file-mb', '15');
  await flush();
  const otherStore = new stores.ServerStore();
  otherStore.setServerDetails({ ...store.serverDetails, id: 'server-b', name: 'Server B' }, member('admin'));
  const otherClient = new network.NetworkClient();
  otherClient.getStatus = () => 'CONNECTED';
  let wrongRequests = 0;
  otherClient.sendRequest = () => { wrongRequests++; return Promise.resolve({}); };
  stores.setActiveServerStore(otherStore);
  network.setActiveNetworkClient(otherClient);
  appEvents.emit('session.changed', { key: 'server-b' });
  check(locked() && modal.close() === false, 'Session switching cannot dismiss an operation still awaiting its original server');
  acknowledge('SERVER_UPDATE_SETTINGS');
  await flush();
  check(!locked() && wrongRequests === 0 && otherStore.serverDetails.name === 'Server B', 'Queued edits never leak into another session');
  check(!requests.some((entry) => !entry.done), 'All submitted operations were explicitly settled');
  check(modal.close() === true && !mainBackdrop(), 'The modal can close after stale operations settle');
  stores.setActiveServerStore(store);
  network.setActiveNetworkClient(client);
  modal.open();
  change('#input-server-name', 'Interrupted edit');
  await flush();
  client.getStatus = () => 'RECONNECTING';
  appEvents.emit('network.status', 'RECONNECTING');
  reject('SERVER_UPDATE_SETTINGS', 'Connection closed');
  await flush();
  check(!locked() && field('#input-server-name').matches(':disabled'), 'Disconnect rejection releases pending work without enabling stale edits');
  client.getStatus = () => 'CONNECTED';
  appEvents.emit('network.connected');
  check(field('#input-server-name').matches(':disabled'), 'A reconnect does not revive the old editing session');
  modal.open();
  check(!field('#input-server-name').matches(':disabled') && field('#input-server-name').value === store.serverDetails.name, 'Reopening after reconnect uses newly persisted truth');
  modal.close();
  check(listenerCount() === initialListeners, 'Closing removes every modal-owned EventBus subscription after retries and reconnects');
  client.dispose();
  otherClient.dispose();
  return checks;
}
