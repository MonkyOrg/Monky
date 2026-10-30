const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

// Every modal goes through one shell (#490): one keyboard owner on top, Tab kept inside,
// the dialog role and name, focus back where it was, no fixed z-index and no loose error text.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('modals share one shell: keyboard, focus, stacking, dismissal and feedback', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `modal-shell-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_MODAL_SHELL_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_MODAL_SHELL_PROFILE);
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
        name: 'modal-shell-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__modal_shell__') return next();
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
    const origin = `http://127.0.0.1:${address.port}`;
    browser = new BrowserWindow({
      show: false, width: 1100, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    timeout = setTimeout(() => { console.error('Modal shell DOM regression timed out'); void finish(1); }, 100000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`${origin}/__modal_shell__`);
      await browser.webContents.executeJavaScript('localStorage.clear(); sessionStorage.clear();', true);
      const checks = await browser.webContents.executeJavaScript(`(${runRegression.toString()})(${JSON.stringify(language)})`, true);
      if (browser.isVisible()) throw new Error('The modal shell regression must remain offscreen');
      console.log(`Modal shell (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const { openModal } = await import('/utils/modalShell.ts');
  const { ownSurface } = await import('/utils/surfaceMotion.ts');
  const { appEvents } = await import('/core/EventBus.ts');
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const until = (predicate, message) => new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const value = predicate();
      if (value) resolve(value);
      else if (performance.now() - started > 5000) reject(new Error(message));
      else requestAnimationFrame(poll);
    };
    poll();
  });
  const key = (name, init = {}) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  };
  const open = () => [...document.querySelectorAll('.modal-backdrop:not([data-ui-closing])')];
  const settled = () => until(() => !document.querySelector('.modal-backdrop[data-ui-closing]'), 'A modal exit did not finish');
  const toast = () => document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
  const trigger = document.createElement('button');
  trigger.textContent = 'Trigger';
  document.body.append(trigger);

  // 1. The shell's own contract.
  trigger.focus();
  const reasons = [];
  let allowClose = true;
  const card = `<div class="modal-card">
    <div class="modal-header"><div class="modal-title"><span class="material-symbols-outlined">info</span><span>Shell title</span></div>
      <button type="button" data-modal-close id="shell-x">×</button></div>
    <input id="shell-search" data-clear-on-escape>
    <button type="button" id="shell-middle">Middle</button>
    <button type="button" id="shell-last">Last</button>
    <button type="button" id="shell-disabled" disabled>Disabled</button>
    <button type="button" id="shell-close" data-modal-close>Close</button>
  </div>`;
  let shell = openModal({ card, canClose: () => allowClose, onClose: reason => reasons.push(reason) });
  const dialog = shell.card;
  check(dialog.getAttribute('role') === 'dialog' && dialog.getAttribute('aria-modal') === 'true', 'The card is a modal dialog');
  const spoken = (element) => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
    return copy.textContent.trim();
  };
  check(spoken(document.getElementById(dialog.getAttribute('aria-labelledby'))) === 'Shell title',
    'The dialog is named by its title, without the icon ligature');
  check(dialog.querySelector('.modal-title .material-symbols-outlined').getAttribute('aria-hidden') === 'true', 'Title icons are decoration');
  check(document.activeElement === dialog.querySelector('#shell-search'), 'Focus starts on the first control below the header');
  check(!shell.element.style.zIndex, 'The shell never fixes a z-index: the stack follows the DOM order');
  check(!key('Tab').defaultPrevented, 'Tab between controls inside the dialog is left to the browser');
  dialog.querySelector('#shell-close').focus();
  check(key('Tab').defaultPrevented && document.activeElement === dialog.querySelector('#shell-x'), 'Tab from the last control wraps to the first');
  check(key('Tab', { shiftKey: true }).defaultPrevented && document.activeElement === dialog.querySelector('#shell-close'),
    'Shift+Tab from the first control wraps to the last, skipping disabled ones');
  trigger.blur();
  check(key('Tab').defaultPrevented && dialog.contains(document.activeElement), 'Tab from outside comes back into the dialog');
  const search = dialog.querySelector('#shell-search');
  search.focus();
  search.value = 'typed';
  let cleared = false;
  search.addEventListener('input', () => { cleared = search.value === ''; }, { once: true });
  key('Escape');
  check(cleared && !shell.closed, 'Escape clears a search being typed before it closes anything');
  allowClose = false;
  key('Escape');
  check(!shell.closed && reasons.length === 0, 'A busy dialog keeps Escape from closing it');
  shell.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  check(!shell.closed, 'A busy dialog also ignores the backdrop');
  allowClose = true;
  dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  check(!shell.closed, 'A press inside the card does not close it');
  dialog.querySelector('#shell-disabled').setAttribute('data-modal-close', '');
  dialog.querySelector('#shell-disabled').click();
  check(!shell.closed, 'A disabled close button does nothing');
  key('Escape');
  check(shell.closed && reasons.join() === 'escape' && shell.signal.aborted, 'Escape closes once and ends the dialog lifetime');
  check(document.activeElement === trigger, 'Focus goes back to whoever opened the dialog');
  await settled();

  shell = openModal({ card, onClose: reason => reasons.push(reason) });
  shell.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  check(shell.closed && reasons.at(-1) === 'backdrop', 'A press that starts on the backdrop closes');
  await settled();
  shell = openModal({ card, onClose: reason => reasons.push(reason) });
  shell.card.querySelector('#shell-close').click();
  check(shell.closed && reasons.at(-1) === 'button', 'data-modal-close buttons close');
  await settled();

  // 2. Nested dialogs: only the top one owns the keyboard; the owner's end closes its children at once.
  const parent = openModal({ card: '<div class="modal-card"><h2>Parent</h2><button type="button" id="parent-action">Act</button></div>' });
  parent.card.querySelector('#parent-action').focus();
  const child = openModal({ card: '<div class="modal-card"><h2>Child</h2><button type="button" id="child-action">Act</button></div>' });
  check(parent.element.inert, 'The parent waits behind its child');
  await until(() => parent.card.hidden, 'The parent card did not give way to the child');
  check(open().length === 2 && open().at(-1) === child.element, 'The child is the top modal');
  key('Escape');
  check(child.closed && !parent.closed, 'Escape closes only the top modal');
  await until(() => !parent.card.hidden && !parent.element.inert, 'The parent did not come back');
  check(document.activeElement === parent.card.querySelector('#parent-action'), 'Focus returns inside the parent');
  const owned = openModal({ card: '<div class="modal-card"><h2>Owned</h2><button type="button">Act</button></div>', signal: parent.signal });
  parent.close();
  check(owned.closed && !owned.element.isConnected, 'A child bound to its owner leaves with it, at once');
  await settled();

  // 3. A popup owned by the dialog keeps Escape for itself.
  const withPopup = openModal({ card: '<div class="modal-card"><h2>Popup owner</h2><button type="button" id="anchor">Anchor</button></div>' });
  const popup = document.createElement('div');
  popup.tabIndex = -1;
  document.body.append(popup);
  const release = ownSurface(popup, withPopup.card.querySelector('#anchor'));
  popup.focus();
  key('Escape');
  check(!withPopup.closed, 'Escape inside an owned popup does not close the dialog');
  release();
  popup.remove();
  withPopup.close();
  await settled();

  // 4. A dialog bound to the session closes at once when the visible server changes, taking its popups along:
  //    the previous server's content must not linger over the new one during an exit animation.
  for (const [event, payload] of [['session.changed', { key: null }], ['network.disconnected', undefined]]) {
    const bound = openModal({ card: '<div class="modal-card"><h2>Session</h2><button type="button" id="bound-anchor">Act</button></div>', closeWithSession: true,
      onClose: reason => reasons.push(reason) });
    const boundPopup = document.createElement('div');
    document.body.append(boundPopup);
    ownSurface(boundPopup, bound.card.querySelector('#bound-anchor'));
    appEvents.emit(event, payload);
    check(bound.closed && reasons.at(-1) === 'session', `${event} closes a dialog bound to the visible server`);
    check(!bound.element.isConnected && !boundPopup.isConnected,
      `${event} removes the dialog and its popups in the same tick, without an exit animation`);
  }
  await settled();

  // 5. The app's dialogs use the same shell.
  const { showAlert, showConfirm, showConfirmWithText } = await import('/views/Dialog.ts');
  const contract = async (name, opener, focusInside = true) => {
    trigger.focus();
    const pending = opener();
    const element = await until(() => open().at(-1), `${name} did not open`);
    const dialogCard = element.querySelector(':scope > .modal-card');
    const labelled = dialogCard.getAttribute('aria-labelledby');
    const nameText = dialogCard.getAttribute('aria-label') || labelled?.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    check(dialogCard.getAttribute('role') === 'dialog' && dialogCard.getAttribute('aria-modal') === 'true' && nameText?.trim(),
      `${name} is a named modal dialog`);
    check(!element.style.zIndex, `${name} has no fixed z-index`);
    if (focusInside) check(dialogCard.contains(document.activeElement), `${name} takes the focus`);
    check(!dialogCard.querySelector('.error-banner, [data-community-error], .dialog-input-error'), `${name} has no loose error area`);
    key('Escape');
    await until(() => !element.isConnected || element.hasAttribute('data-ui-closing'), `${name} did not close on Escape`);
    check(document.activeElement === trigger, `${name} gives the focus back`);
    await settled();
    return pending;
  };
  await contract('Alert', () => showAlert({ message: 'Notice' }));
  check(await contract('Confirmation', () => showConfirm({ message: 'Sure?' })) === false, 'Escape cancels a confirmation');

  // Typing only marks a refused value; the reason goes to the shared alert toast.
  const naming = showConfirmWithText({ message: 'Name it', textInput: { label: 'Name', value: 'ok', validate: value => value.includes('/') ? 'No slashes' : undefined } });
  let namingDone = false;
  void naming.then(() => { namingDone = true; });
  const nameField = await until(() => document.querySelector('.modal-backdrop:not([data-ui-closing]) [data-dialog-input]'), 'The text dialog did not open');
  const confirmButton = nameField.closest('.modal-card').querySelector('[data-action="confirm"]');
  nameField.value = 'a/b';
  nameField.dispatchEvent(new Event('input', { bubbles: true }));
  check(nameField.getAttribute('aria-invalid') === 'true' && confirmButton.disabled, 'An invalid value is marked and holds confirmation');
  check((await until(toast, 'No toast explains the invalid value')).textContent.includes('No slashes'), 'The toast explains the refusal');
  toast().querySelector('.chat-copy-toast-close').click();
  await until(() => !toast(), 'The toast did not close');
  key('Enter');
  check(!namingDone && toast()?.getAttribute('role') === 'alert' && document.activeElement === nameField,
    'Trying to confirm explains again, as an alert, and goes back to the field');
  nameField.value = 'fine';
  nameField.dispatchEvent(new Event('input', { bubbles: true }));
  check(nameField.getAttribute('aria-invalid') === 'false' && !confirmButton.disabled, 'Fixing the value releases confirmation');
  confirmButton.click();
  const named = await naming;
  check(named.confirmed && named.value === 'fine', 'The corrected value is confirmed');
  toast()?.querySelector('.chat-copy-toast-close')?.click();
  await settled();

  window.api = {
    getReleaseNotes: async () => ({ ok: true, body: '' }),
    getReleaseHistory: async () => ({ ok: true, releases: [] }),
    openExternal: async () => ({ success: false }),
    exportIdentity: async () => 'MONKY-ID:fixture',
  };
  const { showBackupExportDialog } = await import('/views/BackupDialogs.ts');
  await contract('Backup', () => showBackupExportDialog());
  const { showIdentityExportDialog, showIdentityImportDialog } = await import('/views/IdentityDialogs.ts');
  await contract('Identity export', () => showIdentityExportDialog('fixture-client'));
  check(await contract('Identity import', () => showIdentityImportDialog()) === null, 'Escape cancels the import');
  const { showLogoutDialog } = await import('/views/LogoutDialog.ts');
  await contract('Logout', () => showLogoutDialog());
  const { showUpdateCompatibility } = await import('/views/UpdateCompatibilityDialog.ts');
  check(await contract('Update compatibility', () => showUpdateCompatibility([{ serverName: 'Server', bots: [{ name: 'Bot', status: 'unknown' }] }])) === 'cancel',
    'Escape postpones the update');
  const { openShortcutCaptureDialog } = await import('/views/ShortcutCaptureDialog.ts');
  const { html } = await import('/utils/html.ts');
  await contract('Shortcut capture', () => openShortcutCaptureDialog({ idPrefix: 'shell-capture', title: 'Record', prompt: html`Press`, owner: document.body, onCaptured: () => {} }));
  const { changelogModal } = await import('/views/ChangelogModal.ts');
  await contract('Changelog', () => changelogModal.open());
  check(!changelogModal.isOpen(), 'Closing the changelog with Escape clears its state');

  // An external link that cannot open is explained in the toast, never in the layout.
  void changelogModal.open();
  const github = await until(() => document.querySelector('.modal-backdrop:not([data-ui-closing]) #changelog-github'), 'The changelog did not reopen');
  github.click();
  check((await until(toast, 'No toast for a link that did not open')).textContent.includes(t('changelog.openFailed')),
    'A link that did not open is reported in the toast');
  changelogModal.close();
  await settled();

  // Importing an identity from Settings: the notice is read above them, and only then do they reopen (#490).
  const { SettingsModal } = await import('/views/SettingsModal.ts');
  const { topModal } = await import('/utils/surfaceMotion.ts');
  const settings = new SettingsModal();
  for (const [name, view] of Object.entries(settings)) {
    if (name === 'accountTab' || !view || typeof view.renderHtml !== 'function') continue;
    if (name !== 'voiceVideoTab') view.renderHtml = () => '<p>Unrelated settings fixture</p>';
    view.attachEvents = () => {};
    view.cleanup = () => {};
  }
  settings.voiceVideoTab.refreshDevices = async () => {};
  settings.voiceVideoTab.startVadMeter = () => {};
  settings.voiceVideoTab.deactivate = () => {};
  settings.voiceVideoTab.activateCameraPreview = () => {};
  settings.aboutTab.loadAppVersion = async () => {};
  window.api.importIdentity = async () => ({ status: 'imported', publicKey: 'imported-key', clientId: 'imported-client' });
  await settings.open();
  const before = document.querySelector('.modal-backdrop--settings');
  before.querySelector('#btn-import-identity-settings').click();
  (await until(() => document.querySelector('.modal-backdrop:not([data-ui-closing]) #btn-import-identity-run'),
    'The identity import did not open from Settings')).click();
  const notice = await until(() => [...document.querySelectorAll('.modal-backdrop:not([data-ui-closing]) .dialog-card')]
    .find(dialogCard => dialogCard.textContent.includes(t('identity.importSuccess'))), 'The import notice did not appear');
  await settled();
  check(topModal() === notice.closest('.modal-backdrop') && !notice.hidden && !notice.closest('[inert]')
    && before.isConnected && document.querySelectorAll('.modal-backdrop--settings').length === 1,
  'The import notice is read above the settings, which wait for it before reopening');
  notice.querySelector('[data-action="confirm"]').click();
  const reopened = await until(() => {
    const current = document.querySelector('.modal-backdrop--settings:not([data-ui-closing])');
    return current !== before && current;
  }, 'The settings did not reopen after the notice');
  await settled();
  check(topModal() === reopened && !before.isConnected, 'The settings reopen once the notice is read');
  settings.close();
  await settled();

  // The first-run profile step explains a refused nickname in the app's language,
  // never in the browser's balloon, which follows the system's (#490).
  const { showIdentityProfileStep } = await import('/views/IdentityProfileStep.ts');
  const profile = document.createElement('div');
  document.body.append(profile);
  void showIdentityProfileStep(profile);
  const profileForm = profile.querySelector('#identity-profile-form');
  const nickname = profile.querySelector('#identity-profile-nickname');
  document.querySelectorAll('.chat-copy-toast').forEach(item => item.remove());
  nickname.value = '';
  profileForm.requestSubmit();
  const emptyNickname = await until(toast, 'An empty nickname was not explained');
  check(profileForm.noValidate && emptyNickname.textContent.includes(t('validation.required', { field: t('connection.nicknameLabel').trim() }))
    && nickname.getAttribute('aria-invalid') === 'true' && document.activeElement === nickname,
  'An empty nickname is explained in the app language, on the marked field');
  nickname.value = 'Ad\u200Bmin';
  nickname.dispatchEvent(new Event('input', { bubbles: true }));
  profileForm.requestSubmit();
  check(toast()?.textContent.includes(t('identity.nicknameInvalidCharacters')) && nickname.getAttribute('aria-invalid') === 'true'
    && !document.querySelector('.modal-backdrop:not([data-ui-closing])'),
  'A nickname the app refuses is explained in the toast, not in a dialog');
  profile.remove();
  document.querySelectorAll('.chat-copy-toast').forEach(item => item.remove());

  // A chat media output that cannot be used: mounting players stays quiet, and only a play the
  // person pressed is explained, once, in the alert toast instead of on every player (#490).
  const { settingsStore } = await import('/stores/settingsStore.ts');
  const { initializeCustomMediaPlayers } = await import('/utils/videoPlayer.ts');
  const setSinkId = HTMLMediaElement.prototype.setSinkId;
  const previousSpeaker = settingsStore.selectedSpeakerId;
  HTMLMediaElement.prototype.setSinkId = async function(id) {
    if (id === 'broken-media') throw new DOMException('Speaker unavailable', 'NotFoundError');
  };
  settingsStore.selectedSpeakerId = 'broken-media';
  document.querySelectorAll('.chat-copy-toast').forEach(item => item.remove());
  const players = document.createElement('div');
  players.innerHTML = '<div class="chat-video-player"><video></video></div>'.repeat(3);
  document.body.append(players);
  try {
    initializeCustomMediaPlayers(players);
    await new Promise(resolve => setTimeout(resolve, 50));
    check(!players.querySelector('[role="alert"]') && !toast(), 'Players routed on mount report nothing on themselves or in a toast');
    players.querySelector('.chat-video-big-play').click();
    const mediaFailure = await until(toast, 'A play on an unusable media output was not explained');
    check(mediaFailure.textContent.includes(t('audioOutputs.mediaUnavailable'))
      && document.querySelectorAll('.chat-copy-toast--danger:not([data-ui-closing])').length === 1
      && !players.querySelector('[role="alert"]') && players.querySelector('video').paused,
    'A play that cannot use the media output is explained once, in the alert toast');
  } finally {
    HTMLMediaElement.prototype.setSinkId = setSinkId;
    settingsStore.selectedSpeakerId = previousSpeaker;
    players.remove();
    document.querySelectorAll('.chat-copy-toast').forEach(item => item.remove());
  }
  return checks;
}
