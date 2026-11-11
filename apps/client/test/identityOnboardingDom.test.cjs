const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('an unreadable identity offers recovery, and creating or importing another identity always asks first', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `identity-onboarding-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_IDENTITY_ONBOARDING_PROFILE: profile };
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
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.MONKY_IDENTITY_ONBOARDING_PROFILE);
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
        name: 'identity-onboarding-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__identity_onboarding__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"></head><body><div id="app"></div></body></html>');
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
    timeout = setTimeout(() => { console.error('Identity onboarding DOM regression timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`${origin}/__identity_onboarding__`);
      const checks = await browser.webContents.executeJavaScript(`(${runRegression.toString()})(${JSON.stringify(language)})`, true);
      if (browser.isVisible()) throw new Error('The identity onboarding regression must remain offscreen');
      console.log(`Identity onboarding (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const { showIdentityOnboarding } = await import('/views/IdentityOnboarding.ts');
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const waitFor = (predicate, describeFailure) => new Promise((resolve, reject) => {
    let frame;
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error(describeFailure()));
    }, 5000);
    const poll = () => {
      const value = predicate();
      if (value) {
        clearTimeout(timer);
        resolve(value);
      } else {
        frame = requestAnimationFrame(poll);
      }
    };
    poll();
  });
  const container = document.getElementById('app');
  const dialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing])');
  const toast = () => document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
  const dismissToast = async () => {
    toast()?.querySelector('.chat-copy-toast-close')?.click();
    await waitFor(() => !toast(), () => 'The error toast did not close');
  };
  const button = (id) => container.querySelector(`#${id}`);
  const fixture = { publicKey: 'fixture-public-key', clientId: 'fixture-client' };
  const calls = { status: 0, create: 0, get: 0 };
  let nextStatus = { state: 'unreadable', reason: 'locked' };
  window.api = {
    getIdentityStatus: async () => { calls.status++; return nextStatus; },
    createIdentity: async () => { calls.create++; return fixture; },
    getIdentity: async () => { calls.get++; return fixture; },
  };

  // Unreadable: the reason, a promise that nothing was deleted, and "try again" ready for Enter.
  let painted = 0;
  let settled = null;
  void showIdentityOnboarding(container, { state: 'unreadable', reason: 'locked' }, () => { painted++; })
    .then((identity) => { settled = identity; });
  check(painted === 1, 'The first paint is reported once');
  check(container.querySelector('h1')?.textContent === t('identity.unreadableTitle'), 'The screen says the identity could not be opened');
  check(container.querySelector('#identity-unreadable-reason')?.textContent === t('identity.unreadableLocked'), 'The reason is explained');
  check(container.textContent.includes(t('identity.unreadableKept')), 'The user learns that nothing was deleted');
  check(document.activeElement === button('btn-onboard-retry'), 'Try again has the focus');
  check(button('btn-onboard-import') && button('btn-onboard-create'), 'Import and create stay available');

  // Trying again while it is still locked keeps the screen and explains it in an alert toast.
  button('btn-onboard-retry').click();
  const still = await waitFor(toast, () => 'No toast after a failed retry');
  check(still.getAttribute('role') === 'alert' && still.textContent.includes(t('identity.unreadableStill')), 'The failed retry is announced');
  check(settled === null && calls.create === 0, 'A failed retry never creates an identity');
  await dismissToast();

  // A different reason updates the explanation.
  nextStatus = { state: 'unreadable', reason: 'io' };
  button('btn-onboard-retry').click();
  await waitFor(() => container.querySelector('#identity-unreadable-reason')?.textContent === t('identity.unreadableIo'),
    () => 'The new reason was not shown');
  await waitFor(toast, () => 'No toast after the second failed retry');
  await dismissToast();

  // Creating another identity asks first, and cancelling keeps everything as it is.
  button('btn-onboard-create').click();
  const confirm = await waitFor(dialog, () => 'Creating did not ask for confirmation');
  check(confirm.textContent.includes(t('identity.replaceMessage')), 'The confirmation explains what is lost');
  check(confirm.querySelector('[data-action="confirm"]')?.classList.contains('btn-danger'), 'Confirming is marked as dangerous');
  check(document.activeElement === confirm.querySelector('[data-action="cancel"]'), 'Cancel has the focus');
  confirm.querySelector('[data-action="cancel"]').click();
  await waitFor(() => !dialog(), () => 'The confirmation did not close');
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(calls.create === 0 && settled === null, 'Cancelling creates nothing');

  button('btn-onboard-create').click();
  (await waitFor(dialog, () => 'The confirmation did not open again')).querySelector('[data-action="confirm"]').click();
  await waitFor(() => settled, () => 'Confirming did not finish the onboarding');
  check(calls.create === 1 && settled.publicKey === fixture.publicKey, 'The explicit choice creates the identity once');

  // Trying again once the keychain opens hands over the stored identity.
  settled = null;
  nextStatus = { state: 'ready' };
  void showIdentityOnboarding(container, { state: 'unreadable', reason: 'locked' }, () => {}).then((identity) => { settled = identity; });
  button('btn-onboard-retry').click();
  await waitFor(() => settled, () => 'A successful retry did not finish the onboarding');
  check(calls.get === 1 && calls.create === 1, 'A successful retry reads the identity and creates nothing');

  // No identity yet: creating needs no confirmation.
  settled = null;
  void showIdentityOnboarding(container, { state: 'missing' }, () => {}).then((identity) => { settled = identity; });
  check(!button('btn-onboard-retry'), 'Without an identity there is nothing to try again');
  button('btn-onboard-create').click();
  await waitFor(() => settled, () => 'Creating the first identity did not finish the onboarding');
  check(!dialog() && calls.create === 2, 'The first identity is created without a warning');

  // Importing a code of another identity (Settings) asks first; nothing is replaced until the user confirms.
  const { showIdentityImportDialog } = await import('/views/IdentityDialogs.ts');
  const other = { publicKey: 'other-public-key', clientId: 'other-client' };
  const imports = [];
  window.api.importIdentity = async (code, password, replace) => {
    imports.push({ code, password, replace });
    return replace === other.publicKey ? { status: 'imported', ...other } : { status: 'confirm-replace', ...other };
  };
  const backdrops = () => [...document.querySelectorAll('.modal-backdrop:not([data-ui-closing])')];
  const replaceConfirm = () => backdrops().find((backdrop) => backdrop.querySelector('.dialog-message'));
  let imported;
  void showIdentityImportDialog().then((identity) => { imported = identity; });
  const code = await waitFor(() => document.querySelector('#identity-import-code'), () => 'The import dialog did not open');
  code.value = 'MONKY-ID2:fixture';
  document.querySelector('#identity-import-password').value = 'correct horse battery';
  const importButton = document.querySelector('#btn-import-identity-run');
  importButton.click();
  const asked = await waitFor(replaceConfirm, () => 'Importing another identity did not ask first');
  check(asked.querySelector('.dialog-message')?.textContent === t('identity.importReplaceMessage'), 'The confirmation explains what is lost');
  check(asked.querySelector('[data-action="confirm"]')?.classList.contains('btn-danger'), 'Switching is marked as dangerous');
  check(document.activeElement === asked.querySelector('[data-action="cancel"]'), 'Cancel has the focus');
  check(imports.length === 1 && imports[0].replace === undefined, 'The first try only asks');
  asked.querySelector('[data-action="cancel"]').click();
  await waitFor(() => !replaceConfirm() && !importButton.disabled, () => 'Cancelling did not return to the import dialog');
  check(imported === undefined && document.querySelector('#identity-import-code') === code, 'Cancelling keeps the dialog and imports nothing');
  check(importButton.textContent === t('identity.importAction'), 'The import button is ready again');

  importButton.click();
  (await waitFor(replaceConfirm, () => 'The confirmation did not open again')).querySelector('[data-action="confirm"]').click();
  await waitFor(() => imported, () => 'Confirming did not import the identity');
  check(imports.length === 3 && imports[2].replace === other.publicKey, 'The confirmed import names the key it replaces with');
  check(imports[2].code === 'MONKY-ID2:fixture' && imports[2].password === 'correct horse battery', 'The same code is imported');
  check(imported.publicKey === other.publicKey && imported.clientId === other.clientId, 'The dialog hands over the new identity');
  await waitFor(() => backdrops().length === 0, () => 'The dialogs did not close');
  const guests = [];
  window.api.createGuestIdentity = async nickname => {
    guests.push(nickname);
    return { ...fixture, guest: true, nickname };
  };
  settled = null;
  void showIdentityOnboarding(container, { state: 'missing' }, () => {}).then(identity => { settled = identity; });
  check(button('btn-onboard-guest')?.textContent.includes(t('identity.guestAction')), 'Guest entry is localized');
  button('btn-onboard-guest').click();
  let guestDialog = await waitFor(dialog, () => 'Guest name dialog did not open');
  const name = guestDialog.querySelector('input[type="text"]');
  check(guestDialog.textContent.includes(t('identity.guestHint')), 'Guest lifetime and permanent hosting restriction are explained');
  check(name && guestDialog.querySelectorAll('input:not([type="hidden"])').length === 1, 'Guest entry asks only for a name');
  name.value = '   ';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  check(guestDialog.querySelector('[data-action="confirm"]').disabled, 'An empty guest name cannot be submitted');
  check(guests.length === 0, 'Invalid name never generates a key');
  name.value = 'Temporary Guest';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  guestDialog.querySelector('[data-action="confirm"]').click();
  await waitFor(() => settled, () => 'Guest entry did not finish onboarding');
  check(settled.guest === true && settled.nickname === 'Temporary Guest', 'The temporary identity is handed to desktop/web startup');
  check(guests.length === 1 && calls.create === 2, 'Guest entry never invokes permanent identity creation');
  await waitFor(() => !dialog(), () => 'Guest dialog remained mounted');

  // The browser uses the same proof, but neither the guest key nor its encrypted DM store reaches IndexedDB.
  const web = await import('/platform/web/webIdentity.ts');
  const storage = await import('/platform/web/webStorage.ts');
  const webDm = await import('/platform/web/webDirectMessages.ts');
  const { createWebPlatformApi } = await import('/platform/web/webPlatform.ts');
  await storage.writeRecord('identity', { damaged: true });
  check((await webDm.webDirectMessages.snapshot()).ok === false, 'Missing identity cannot open DMs before guest entry');
  const webGuest = await createWebPlatformApi().createGuestIdentity('Browser Guest');
  check(webGuest.guest === true && webGuest.nickname === 'Browser Guest', 'Web guest entry is name-only');
  const nonce = 'ab'.repeat(32);
  const proof = await web.signWebChallenge(nonce);
  const bytes = value => new Uint8Array(value.match(/../g).map(piece => parseInt(piece, 16)));
  const publicKey = await crypto.subtle.importKey('spki', bytes(webGuest.publicKey), 'Ed25519', false, ['verify']);
  check(await crypto.subtle.verify('Ed25519', publicKey, bytes(proof.signature), bytes(nonce)), 'Web guest key proves the authentication challenge');
  check((await storage.readRecord('identity')).damaged === true, 'Web guest creation leaves the unreadable identity untouched');
  check((await webDm.webDirectMessages.snapshot()).ok === true, 'Guests can use normal encrypted DMs');
  await webDm.webDirectMessages.setSelfNickname('Browser Guest');
  await webDm.resetWebDirectMessages();
  check(!(await storage.listRecordKeys()).some(key => key.startsWith('dm/')), 'Guest DMs never persist in IndexedDB');
  let exportRefused = false;
  try { await web.exportWebIdentity('correct horse battery'); } catch { exportRefused = true; }
  check(exportRefused, 'A guest cannot export its temporary identity');
  await web.deleteWebIdentity();
  check((await storage.readRecord('identity')).damaged === true, 'Guest logout preserves the previous permanent record');
  await storage.deleteRecord('identity');
  const permanent = await web.createWebIdentity();
  const permanentCode = await web.exportWebIdentity('correct horse battery');
  await web.deleteWebIdentity();
  await storage.writeRecord('identity', { damaged: true });
  const toReplace = await web.createWebGuestIdentity('New Guest');
  const askedWeb = await web.importWebIdentity(permanentCode, 'correct horse battery');
  check(askedWeb.outcome.status === 'confirm-replace', 'Leaving guest mode to import a permanent identity asks first');
  const importedWeb = await web.importWebIdentity(permanentCode, 'correct horse battery', permanent.publicKey);
  check(importedWeb.outcome.status === 'imported' && !(await web.getWebIdentity()).guest, 'A confirmed import leaves guest mode');
  for (const key of await storage.listRecordKeys()) {
    const value = await storage.readRecord(key);
    check(value?.publicKey !== toReplace.publicKey, 'The guest key is never backed up when importing');
  }
  await web.deleteWebIdentity();

  const { MessageType, Permission } = await import('/@id/@monky/shared');
  const { sessionManager } = await import('/core/SessionManager.ts');
  const { connectionStore } = await import('/stores/connectionStore.ts');
  const { openIdentityBanDialog, openIdentityBansDialog } = await import('/views/IdentityBanDialog.ts');
  const { mountOwnIdentitySessions } = await import('/views/OwnIdentitySessions.ts');
  const { AccountTab } = await import('/views/settings/tabs/AccountTab.ts');
  const { SettingsSectionNavigation } = await import('/views/settings/SettingsSectionNavigation.ts');
  const { canBanIdentity } = await import('/utils/identityBan.ts');
  sessionManager.install();
  connectionStore.setIdentity({ publicKey: 'self-key', clientId: 'self-client' });
  const self = { id: 'self', publicKey: 'self-key', clientId: 'self-client', sessionId: 'self:here',
    nickname: 'Self', status: 'ONLINE', joinedAt: 1 };
  const target = { id: 'target', publicKey: 'target-key', clientId: 'target-client',
    nickname: 'Target <img src=x>', status: 'ONLINE', joinedAt: 1 };
  const requests = [];
  let bans = [{ publicKey: target.publicKey, nickname: target.nickname, reason: 'Admin-only reason',
    showReason: false, createdAt: 1, expiresAt: null }];
  const banHistory = [{ ...bans[0], id: 1000, createdBy: { id: self.id, nickname: 'Moderator <img src=x>' },
    endedAt: null, endedBy: null, status: 'active' },
    ...Array.from({ length: 60 }, (_, index) => ({
      id: 999 - index, publicKey: `expired-${index}`, nickname: `Expired ${index}`,
      reason: `Historical reason ${index}`, showReason: false, createdAt: 1, expiresAt: 2,
      createdBy: null, endedAt: null, endedBy: null, status: 'expired',
    }))];
  let remoteConnected = true;
  let delayedDevices = false;
  const finishDevices = [];
  let delayedBans = false;
  let invalidHistory = false;
  let finishBans;
  const makeSession = (host, id) => {
    const session = sessionManager.create(host, 3000, 'Self');
    session.client.getStatus = () => 'CONNECTED';
    session.client.getConnectionId = () => id;
    session.client.sendRequest = async (type, payload, requestId) => {
      requests.push({ type, payload, requestId, id });
      if ((type === MessageType.IDENTITY_BANS_GET || type === MessageType.IDENTITY_BAN_HISTORY_GET) && delayedBans)
        return new Promise(resolve => { finishBans = resolve; });
      if (type === MessageType.IDENTITY_UNBAN) {
        bans = [];
        const entry = banHistory.find(entry => entry.publicKey === payload.publicKey && entry.status === 'active');
        if (entry) { entry.status = 'revoked'; entry.endedAt = 3; entry.endedBy = { id: self.id, nickname: self.nickname }; }
      }
      if (type === MessageType.IDENTITY_BAN_HISTORY_GET) {
        if (invalidHistory) return { entries: [{ ...banHistory[0], status: 'unknown' }], nextCursor: null };
        const entries = banHistory.filter(entry => (payload.scope === 'all' || entry.status === 'active')
          && (!payload.beforeId || entry.id < payload.beforeId)).sort((a, b) => b.id - a.id);
        return { entries: entries.slice(0, 50), nextCursor: entries.length > 50 ? entries[49].id : null };
      }
      if (type === MessageType.IDENTITY_SESSION_DISCONNECT) remoteConnected = false;
      if (type === MessageType.IDENTITY_SESSIONS_GET && delayedDevices)
        return new Promise(resolve => { finishDevices.push(resolve); });
      if (type === MessageType.IDENTITY_SESSIONS_GET) return { sessions: [
        { sessionId: 'self:here', deviceId: 'here', connectedAt: 1000, current: true },
        ...(remoteConnected ? [{ sessionId: 'self:remote', deviceId: 'remote', connectedAt: 2000, current: false }] : []),
      ] };
      return { bans };
    };
    session.serverStore.setServerDetails({ id, name: host, createdAt: 1, maxUsers: 10, hasPassword: false,
      channels: [], members: [self, target], voiceStates: {}, ownerId: self.id, myPermissions: Permission.MANAGE_SERVER,
      protocol: { version: 41, minimumVersion: 35, features: ['identity-bans', 'identity-sessions'] } }, self);
    return session;
  };
  const firstSession = makeSession('Server <A>', 'a');
  makeSession('Server B', 'b');
  sessionManager.activate(firstSession.key);
  check(canBanIdentity(firstSession.serverStore, target.id)
    && !canBanIdentity(firstSession.serverStore, self.id)
    && !canBanIdentity(firstSession.serverStore, 'missing'),
    'MANAGE_SERVER alone allows banning another member, never self or an unknown target');
  firstSession.serverStore.ownerId = target.id;
  check(!canBanIdentity(firstSession.serverStore, target.id), 'The shared moderation rule protects the owner');
  firstSession.serverStore.ownerId = self.id;
  target.isBot = true;
  check(!canBanIdentity(firstSession.serverStore, target.id), 'The shared moderation rule excludes bot identities');
  target.isBot = false;
  firstSession.serverStore.serverDetails.protocol.features = ['identity-sessions'];
  check(!canBanIdentity(firstSession.serverStore, target.id), 'A legacy server never exposes unsupported identity bans');
  firstSession.serverStore.serverDetails.protocol.features.push('identity-bans');
  openIdentityBanDialog(target.id);
  const banDialog = await waitFor(dialog, () => 'Ban dialog did not open');
  check(banDialog.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true'
    || banDialog.querySelector('.modal-card')?.getAttribute('aria-modal') === 'true', 'The ban form is an accessible modal');
  check(!banDialog.querySelector('img'), 'External nicknames never become HTML');
  check(banDialog.querySelectorAll('input[type="radio"]').length === 0, 'Duration choices use cards rather than native radios');
  const durationCards = banDialog.querySelector('#identity-ban-duration');
  const reasonGroup = banDialog.querySelector('#identity-ban-reason').closest('.form-group');
  const visibilityLabel = banDialog.querySelector('#identity-ban-show-label');
  const visibilitySwitch = banDialog.querySelector('#identity-ban-show').closest('.toggle-switch');
  const centerY = element => { const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2; };
  check(reasonGroup.getBoundingClientRect().top - durationCards.getBoundingClientRect().bottom >= 16,
    'Ban duration choices and the reason field have at least 16px of separation');
  check(Math.abs(centerY(visibilityLabel) - centerY(visibilitySwitch)) <= 1,
    'The reason visibility label and switch share a horizontal row with centered alignment');
  for (const [value, descriptionKey] of [
    ['permanent', 'identity.banPermanentDescription'],
    ['temporary', 'identity.banTemporaryDescription'],
  ]) {
    const card = durationCards.querySelector('[data-ban-duration="' + value + '"]');
    const title = card.querySelector('.input-mode-card-title');
    const description = card.querySelector('.input-mode-card-description');
    check(description?.textContent === t(descriptionKey) && description.getBoundingClientRect().height > 0,
      'Each duration card shows its localized description using the shared card component');
    check(description.getBoundingClientRect().top - title.getBoundingClientRect().bottom >= 5
      && parseFloat(getComputedStyle(description).fontSize) < parseFloat(getComputedStyle(title).fontSize),
      'Card descriptions sit below their titles with the standard spacing and smaller typography');
  }
  const titles = [...durationCards.querySelectorAll('.input-mode-card-title')];
  check(Math.abs(titles[0].getBoundingClientRect().top - titles[1].getBoundingClientRect().top) <= 1,
    'Duration card titles follow the same horizontal alignment');
  check(Math.abs(durationCards.getBoundingClientRect().left - reasonGroup.getBoundingClientRect().left) <= 1
    && Math.abs(durationCards.getBoundingClientRect().right - reasonGroup.getBoundingClientRect().right) <= 1,
    'Duration choices and form fields follow the same left and right edges');
  banDialog.querySelector('[data-ban-duration="temporary"]').click();
  banDialog.querySelector('#identity-ban-duration-value').value = '0';
  banDialog.querySelector('[data-ban-duration="permanent"]').click();
  check(banDialog.querySelector('#identity-ban-duration-value').disabled && banDialog.querySelector('[data-ban-unit]').disabled,
    'An irrelevant temporary duration or unit cannot invalidate a permanent ban');
  const reason = banDialog.querySelector('#identity-ban-reason');
  reason.value = '   ';
  banDialog.querySelector('[data-ban-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(toast, () => 'Missing ban reason was not announced');
  check(!requests.some(r => r.type === MessageType.IDENTITY_BAN), 'An empty reason never reaches the server');
  await dismissToast();
  banDialog.querySelector('[data-ban-duration="temporary"]').click();
  check(banDialog.querySelector('[data-ban-duration="temporary"]').getAttribute('aria-pressed') === 'true', 'The duration card exposes selected state');
  const timeGroup = banDialog.querySelector('[data-ban-time]');
  await waitFor(() => timeGroup.getBoundingClientRect().height >=
    timeGroup.querySelector('label').getBoundingClientRect().height +
    timeGroup.querySelector('input').getBoundingClientRect().height + 5,
    () => 'The temporary duration field did not finish expanding');
  check(timeGroup.getBoundingClientRect().top - durationCards.getBoundingClientRect().bottom >= 16
    && reasonGroup.getBoundingClientRect().top - timeGroup.getBoundingClientRect().bottom >= 16,
    'The expanded temporary duration preserves spacing above and below it');
  const durationValue = banDialog.querySelector('#identity-ban-duration-value');
  const durationUnit = banDialog.querySelector('[data-ban-unit]');
  check(durationValue.type === 'number' && durationValue.min === '1' && durationValue.step === '1'
    && durationUnit.value === 'minutes'
    && [...durationUnit.options].map(option => option.value).join(',') === 'minutes,hours,days',
    'Temporary bans use a whole-number field and the three supported duration units');
  check(Math.abs(centerY(durationValue) - centerY(durationUnit)) <= 1
    && durationValue.getBoundingClientRect().right + 10 <= durationUnit.getBoundingClientRect().left,
    'The numeric duration and themed unit selector share a row without crowding');
  const banCard = banDialog.querySelector('.modal-card');
  const previousWidth = banCard.style.width;
  banCard.style.width = '360px';
  check(Math.abs(centerY(visibilityLabel) - centerY(visibilitySwitch)) <= 1
    && visibilityLabel.getBoundingClientRect().right + 10 <= visibilitySwitch.getBoundingClientRect().left,
    'Wrapped visibility text stays aligned with its switch without crowding it');
  banCard.style.width = previousWidth;
  durationValue.value = '2';
  reason.value = 'Visible moderation reason';
  const visible = banDialog.querySelector('#identity-ban-show');
  check(visible.getAttribute('role') === 'switch' && visible.closest('.toggle-switch'), 'Reason visibility uses the shared accessible switch');
  visible.click();
  banDialog.querySelector('[data-ban-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => requests.some(r => r.type === MessageType.IDENTITY_BAN), () => 'Valid ban was not sent');
  const banRequest = requests.find(r => r.type === MessageType.IDENTITY_BAN);
  check(banRequest.payload.durationSeconds === 120 && banRequest.payload.showReason === true && banRequest.payload.reason === reason.value,
    'Custom duration, required reason and visibility are sent together');
  await waitFor(() => !dialog(), () => 'The ban form did not close after server acknowledgement');
  const { SelectEnhancer } = await import('/core/SelectEnhancer.ts');
  const selectEnhancer = new SelectEnhancer();
  selectEnhancer.init();
  for (const [unitValue, seconds, maximum] of [['hours', 7200, 87600], ['days', 172800, 3650]]) {
    openIdentityBanDialog(target.id);
    const timedBan = await waitFor(dialog, () => 'Another timed ban did not open');
    timedBan.querySelector('[data-ban-duration="temporary"]').click();
    const value = timedBan.querySelector('#identity-ban-duration-value');
    const unit = timedBan.querySelector('[data-ban-unit]');
    await waitFor(() => unit.checkVisibility({ checkVisibilityCSS: true }), () => 'The unit selector is not visible');
    value.value = '2';
    unit.click();
    const option = await waitFor(() => [...(document.getElementById(unit.getAttribute('aria-controls'))?.querySelectorAll('[role="option"]') ?? [])]
      .find(element => element.textContent === t('poll.' + unitValue)), () => 'The themed unit popup did not open');
    option.click();
    check(unit.value === unitValue && value.value === '2' && Number(value.max) === maximum,
      'Changing units preserves the entered quantity and updates the maximum from the server limit');
    timedBan.querySelector('#identity-ban-reason').value = 'Timed moderation reason';
    const previousRequests = requests.filter(request => request.type === MessageType.IDENTITY_BAN).length;
    for (const invalidValue of ['', '0', '1.5', String(maximum + 1)]) {
      value.value = invalidValue;
      timedBan.querySelector('[data-ban-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(toast, () => 'An invalid duration was not announced');
      check(requests.filter(request => request.type === MessageType.IDENTITY_BAN).length === previousRequests,
        'Empty, zero, fractional and over-limit durations never reach the server');
      await dismissToast();
    }
    value.value = String(maximum);
    check(value.checkValidity(), 'The exact maximum remains valid for each duration unit');
    value.value = '2';
    timedBan.querySelector('[data-ban-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => requests.filter(request => request.type === MessageType.IDENTITY_BAN).length > previousRequests,
      () => 'A valid duration in the chosen unit was not sent');
    check(requests.filter(request => request.type === MessageType.IDENTITY_BAN).at(-1).payload.durationSeconds === seconds,
      'Hours and days are converted to the exact relative seconds accepted by the server');
    await waitFor(() => !dialog(), () => 'The timed ban did not close after acknowledgement');
    check(!document.querySelector('.select-popup:not([data-ui-closing])'), 'The unit popup does not survive its modal');
  }
  selectEnhancer.dispose();
  firstSession.serverStore.serverDetails.protocol.features.push('identity-ban-history');
  openIdentityBansDialog();
  const management = await waitFor(dialog, () => 'Ban management did not open');
  const unban = await waitFor(() => management.querySelector('[data-unban]'), () => 'Persisted ban list did not render');
  check(management.textContent.includes('Admin-only reason') && !management.querySelector('img'), 'Administrators can inspect reasons safely');
  check(management.textContent.includes('Moderator <img src=x>') && !management.querySelector('img'),
    'Responsible moderators are preserved snapshots and never become raw HTML');
  const managementCard = management.querySelector('.identity-bans-card');
  const details = [...management.querySelector('.identity-ban-details').children].map(element => element.getBoundingClientRect());
  check(managementCard.scrollWidth <= managementCard.clientWidth + 1
    && Math.abs(details[0].top - details[1].top) <= 1 && details[0].right < details[1].left,
    'History metadata stays horizontally aligned with real fonts and without overflowing its modal');
  const unbansBefore = requests.filter(request => request.type === MessageType.IDENTITY_UNBAN).length;
  unban.click();
  let unbanConfirmation = await waitFor(() => backdrops().find(b => b.querySelector('[data-action="confirm"]')), () => 'Unban did not ask for confirmation');
  check(document.activeElement === unbanConfirmation.querySelector('[data-action="cancel"]')
    && unbanConfirmation.textContent.includes(target.nickname), 'Desbanimento names its target and focuses Cancel');
  unbanConfirmation.querySelector('[data-action="cancel"]').click();
  await waitFor(() => !backdrops().some(b => b.querySelector('[data-action="confirm"]')), () => 'Unban cancellation did not close');
  check(requests.filter(request => request.type === MessageType.IDENTITY_UNBAN).length === unbansBefore,
    'Cancelling desbanimento preserves the ban and sends no mutation');
  unban.click();
  unbanConfirmation = await waitFor(() => backdrops().find(b => b.querySelector('[data-action="confirm"]')), () => 'Unban did not ask for confirmation');
  unbanConfirmation.querySelector('[data-action="confirm"]').click();
  await waitFor(() => management.textContent.includes(t('identity.noBans')), () => 'Unban did not refresh the list');
  check(requests.filter(request => request.type === MessageType.IDENTITY_UNBAN).at(-1).payload.banId === 1000,
    'Desbanimento is bound to the exact historical ban, not just its identity');
  management.querySelector('[data-bans-scope="all"]').click();
  await waitFor(() => management.querySelectorAll('[data-ban-key]').length === 50, () => 'The first bounded history page did not render');
  const revokedRecord = management.querySelector('[data-ban-key="1000"]');
  check(revokedRecord.textContent.includes('Admin-only reason')
    && revokedRecord.textContent.includes(t('identity.banStatus.revoked'))
    && revokedRecord.textContent.includes(self.nickname) && !revokedRecord.querySelector('[data-unban]'),
    'Desbanimento retains reason, moderator, dates and resolution without offering another revert');
  management.querySelector('[data-load-more]').click();
  await waitFor(() => management.querySelectorAll('[data-ban-key]').length === 61, () => 'The remaining history did not append');
  check(new Set([...management.querySelectorAll('[data-ban-key]')].map(element => element.dataset.banKey)).size === 61
    && management.querySelector('[data-load-more]').hidden,
    'Complete history loads in stable pages without duplicates and stops at its real end');
  check(management.querySelector('[data-ban-key="999"]').textContent.includes(t('identity.banStatus.expired'))
    && management.querySelector('[data-ban-key="999"]').textContent.includes(t('identity.banUnknownModerator'))
    && !management.querySelector('[data-ban-key="999"] [data-unban]'), 'Expired legacy records retain history without inventing moderators or reversal actions');
  management.querySelector('[data-bans-scope="active"]').click();
  await waitFor(() => management.textContent.includes(t('identity.noBans')), () => 'Returning to active bans did not clear history');
  invalidHistory = true;
  management.querySelector('[data-bans-scope="all"]').click();
  await waitFor(toast, () => 'Malformed history did not produce accessible feedback');
  check(!management.querySelector('[data-ban-key]') && !management.textContent.includes(t('identity.noBans')),
    'A failed scope change never presents stale records or a success-shaped empty history');
  invalidHistory = false;
  await dismissToast();
  management.querySelector('[data-refresh]').click();
  await waitFor(() => management.querySelectorAll('[data-ban-key]').length === 50, () => 'History did not recover after malformed data');
  management.querySelector('[data-modal-close]').click();
  await waitFor(() => !dialog(), () => 'Ban list did not close');
  delayedBans = true;
  openIdentityBansDialog();
  await waitFor(() => finishBans, () => 'Ban refresh was not pending');
  firstSession.serverStore.myPermissions = 0;
  firstSession.serverStore.bus.emit('server.roles_updated');
  check(!dialog(), 'Revoked moderation access removes the dialog immediately, even while a request is pending');
  finishBans({ entries: [{ ...banHistory[0], reason: 'Late private reason' }], nextCursor: null });
  await Promise.resolve();
  await Promise.resolve();
  check(!document.body.textContent.includes('Late private reason'), 'Late private ban data cannot reappear after revocation');
  firstSession.serverStore.myPermissions = Permission.MANAGE_SERVER;
  delayedBans = false;
  firstSession.serverStore.serverDetails.protocol.features = ['identity-bans', 'identity-sessions'];
  bans = [{ publicKey: target.publicKey, nickname: target.nickname, reason: 'Legacy active ban',
    showReason: false, createdAt: 1, expiresAt: null }];
  const historyRequestsBefore = requests.filter(request => request.type === MessageType.IDENTITY_BAN_HISTORY_GET).length;
  openIdentityBansDialog();
  const legacyBans = await waitFor(dialog, () => 'The legacy active-ban view did not open');
  await waitFor(() => legacyBans.querySelector('[data-unban]'), () => 'Legacy active bans were not preserved');
  legacyBans.querySelector('[data-bans-scope="all"]').click();
  await waitFor(toast, () => 'Unsupported history was not explained');
  check(legacyBans.querySelector('[data-bans-scope="all"]').getAttribute('aria-disabled') === 'true'
    && requests.filter(request => request.type === MessageType.IDENTITY_BAN_HISTORY_GET).length === historyRequestsBefore,
    'Older servers keep active bans and desbanimento without receiving an unsupported history request');
  await dismissToast();
  legacyBans.querySelector('[data-modal-close]').click();
  await waitFor(() => !dialog(), () => 'The legacy active-ban view did not close');
  const account = new AccountTab();
  const settings = document.createElement('div');
  settings.className = 'settings-modal-card';
  settings.innerHTML = '<div class="settings-sidebar"><button class="settings-tab-btn" data-tab="account">Account</button></div>'
    + '<div class="settings-main-container"><div class="settings-content-body"><div id="tab-panel-account">'
    + account.renderHtml() + '</div></div></div>';
  container.append(settings);
  const navigation = new SettingsSectionNavigation(settings);
  navigation.setTab('account');
  const devicesDialog = settings.querySelector('[data-settings-section="identity-sessions"]');
  check(devicesDialog && !settings.querySelector('#btn-identity-sessions'),
    'Connected devices has its own profile subsection, not a button hidden in identity');
  check(!dialog(), 'The device list stays inside settings rather than opening another modal');
  const subsectionLink = await waitFor(() => [...settings.querySelectorAll('.settings-section-list button')]
    .find(button => button.textContent === t('identity.sessionsTitle')), () => 'Connected devices is missing from profile navigation');
  subsectionLink.click();
  const stopDevices = mountOwnIdentitySessions(settings);
  await waitFor(() => devicesDialog.querySelectorAll('[data-device]').length === 2, () => 'Devices were not aggregated across servers');
  check(devicesDialog.textContent.includes(t('identity.sessionsScope')), 'The device list states its actual server scope');
  check(devicesDialog.querySelector('[data-device="here"]').textContent.includes(t('identity.thisDevice')), 'The current installation is identified');
  const card = devicesDialog.querySelector('[data-device="remote"]');
  check(!card.hasAttribute('style') && getComputedStyle(card).backgroundColor === getComputedStyle(settings.querySelector('[data-settings-section="identity"] > div')).backgroundColor,
    'Device cards use the app card surface without inline layout overrides');
  check(!devicesDialog.querySelector('img') && devicesDialog.textContent.includes('Server <A>'),
    'Server names remain escaped text inside the inline device list');
  devicesDialog.querySelector('[data-refresh]').click();
  await waitFor(() => devicesDialog.querySelector('[data-identity-sessions]').getAttribute('aria-busy') === 'false',
    () => 'Refreshing connected devices did not settle');
  check(devicesDialog.querySelector('[data-device="remote"]') === card, 'An unchanged refresh preserves existing device controls');
  devicesDialog.querySelector('[data-disconnect-device="remote"]').focus();
  devicesDialog.querySelector('[data-disconnect-device="remote"]').click();
  const cancelDisconnect = await waitFor(() => card.querySelector('[data-device-confirmation]:not([hidden])'),
    () => 'Disconnect did not ask for confirmation');
  check(!dialog() && settings.isConnected && !settings.hidden && !settings.inert,
    'Inline disconnect confirmation never stacks a modal or hides settings');
  check(document.activeElement === cancelDisconnect.querySelector('[data-cancel-disconnect]'),
    'The safe cancel action receives keyboard focus');
  check(card.querySelector('[data-disconnect-device]').classList.contains('btn-danger')
    && cancelDisconnect.querySelector('[data-confirm-disconnect]').classList.contains('btn-danger'),
    'Both destructive device actions use the app danger color');
  check(requests.filter(r => r.type === MessageType.IDENTITY_SESSION_DISCONNECT).length === 0,
    'Opening inline confirmation does not disconnect anything');
  cancelDisconnect.querySelector('[data-cancel-disconnect]').click();
  await waitFor(() => !dialog() && !devicesDialog.querySelector('[data-refresh]').disabled, () => 'Cancelled disconnect did not restore controls');
  check(requests.filter(r => r.type === MessageType.IDENTITY_SESSION_DISCONNECT).length === 0, 'Cancelling keeps every remote session connected');
  check(document.activeElement === devicesDialog.querySelector('[data-disconnect-device="remote"]'),
    'Cancelling returns keyboard focus to the same device action');
  devicesDialog.querySelector('[data-disconnect-device="remote"]').click();
  const disconnectConfirmation = await waitFor(() => card.querySelector('[data-device-confirmation]:not([hidden])'), () => 'Disconnect did not ask for confirmation');
  disconnectConfirmation.querySelector('[data-confirm-disconnect]').click();
  check(disconnectConfirmation.querySelector('[data-confirm-disconnect]').disabled
    && disconnectConfirmation.querySelector('[data-cancel-disconnect]').disabled,
    'Pending disconnect disables repeated confirmation and cancellation');
  disconnectConfirmation.querySelector('[data-confirm-disconnect]').click();
  await waitFor(() => requests.filter(r => r.type === MessageType.IDENTITY_SESSION_DISCONNECT).length === 2, () => 'Shared-server sessions were not all disconnected');
  await waitFor(() => !devicesDialog.querySelector('[data-device="remote"]'), () => 'Offline devices remained in the current list');
  await waitFor(() => !dialog(), () => 'Disconnect confirmation did not close');
  delayedDevices = true;
  devicesDialog.querySelector('[data-refresh]').click();
  await waitFor(() => finishDevices.length === 2, () => 'The device refresh was not pending');
  devicesDialog.querySelector('[data-disconnect-device="here"]').click();
  check(!!devicesDialog.querySelector('[data-device="here"] [data-device-confirmation]:not([hidden])') && !dialog(),
    'A refresh cannot force an inline confirmation into a second modal');
  stopDevices();
  stopDevices();
  navigation.destroy();
  settings.remove();
  finishDevices.splice(0).forEach(resolve => resolve({ sessions: [{ sessionId: 'late', deviceId: 'late-private-device', connectedAt: 1000, current: false }] }));
  await Promise.resolve();
  await Promise.resolve();
  check(!devicesDialog.querySelector('[data-device-confirmation], [data-device]') && !document.body.textContent.includes('late-private-device'),
    'Settings teardown cancels inline confirmation and rejects late device responses');
  delayedDevices = false;
  connectionStore.setIdentity({ publicKey: 'guest-key', clientId: 'guest-client', guest: true, nickname: 'Guest' });
  check(!new AccountTab().renderHtml().includes('data-settings-section="identity-sessions"'),
    'Guests do not get the connected-device subsection');
  connectionStore.setIdentity(null);
  check(!new AccountTab().renderHtml().includes('data-settings-section="identity-sessions"'),
    'Signed-out profiles do not get the connected-device subsection');
  connectionStore.setIdentity({ publicKey: 'self-key', clientId: 'self-client' });
  firstSession.chatStore.messages.set('private-chat', [{ content: 'Previously delivered private content' }]);
  firstSession.botScreenStore.screens.set('private-miniapp', {});
  await sessionManager.removeAll();
  check(firstSession.serverStore.serverDetails === null && firstSession.serverStore.knownMembers.size === 0
    && firstSession.chatStore.messages.size === 0 && firstSession.botScreenStore.screens.size === 0,
    'Revoked/removed sessions discard server, chat, membership and miniapp content');
  const { logOut, showLogoutDialog } = await import('/views/LogoutDialog.ts');
  const { webRtcManager } = await import('/core/WebRtcManager.ts');
  webRtcManager.prepareForQuit = async () => {};
  window.api.logOut = async () => ({ success: true });
  connectionStore.setIdentity({ publicKey: 'guest-key', clientId: 'guest-client', guest: true, nickname: 'Guest' });
  localStorage.setItem('monky_nickname', 'Previous permanent profile');
  void showLogoutDialog();
  const guestLogout = await waitFor(dialog, () => 'Guest logout confirmation did not open');
  check(!guestLogout.querySelector('#logout-dialog-export') && guestLogout.textContent.includes(t('identity.guestLogout')),
    'Guest logout explains the temporary lifecycle and does not offer permanent-key export');
  guestLogout.querySelector('#logout-dialog-cancel').focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitFor(() => !dialog(), () => 'Escape did not cancel guest logout');
  await logOut();
  check(localStorage.getItem('monky_nickname') === 'Previous permanent profile', 'Leaving a guest preserves the previous persistent account profile');
  return checks;
}
