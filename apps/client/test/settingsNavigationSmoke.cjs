const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const clientRoot = path.resolve(__dirname, '..');
const releaseNotesOnly = process.argv.includes('--release-notes');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `settings-navigation-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_SETTINGS_NAV_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...(releaseNotesOnly ? ['--release-notes'] : [])], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_SETTINGS_NAV_PROFILE);
  // Hosted Windows sessions can disable Chromium's scroll animator independently of matchMedia.
  app.commandLine.appendSwitch('enable-smooth-scrolling');
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
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
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
      show: false, width: 1100, height: 850, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Settings navigation smoke timed out'); void finish(1); }, 90_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__settings_navigation__`);
    window.focus();
    window.webContents.focus();
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    if (releaseNotesOnly) {
      const repository = path.resolve(clientRoot, '..', '..');
      const { buildReleaseNotes } = await import(pathToFileURL(path.join(repository, 'scripts', 'generate-changelog.js')).href);
      const fragments = ['616-friendly-notes.json', '617-copy-version.json']
        .map(file => JSON.parse(fs.readFileSync(path.join(repository, 'release-notes', file), 'utf8')));
      const body = buildReleaseNotes(['feat: client notes (#616)\n\n#616: parse bilingual JSON in renderer'], {
        fragments, repo: 'MonkyOrg/Monky', prevTag: 'v8.3.6-beta', version: '8.3.7-beta',
      });
      const checks = await evaluate(`(${runReleaseNotesSmoke.toString()})(${JSON.stringify(body)}, ${JSON.stringify(fragments)})`);
      await runVersionCopyKeyboardSmoke(window);
      for (const language of ['pt-BR', 'en']) {
        await evaluate(`window.releaseNotesFixture.preview(${JSON.stringify(language)})`);
        fs.writeFileSync(path.join(clientRoot, 'dist-test', `release-notes-${language}.png`),
          (await window.webContents.capturePage()).toPNG());
      }
      await evaluate('window.releaseNotesFixture.cleanup()');
      console.log(`Release notes and version copy: ${checks} DOM checks plus native Enter/Space, hover and reduced-motion checks passed`);
      await finish(0);
      return;
    }
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

async function runVersionCopyKeyboardSmoke(window) {
  window.focus();
  window.webContents.focus();
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const surface of ['about', 'changelog']) {
    const { selector } = await evaluate(`window.releaseNotesFixture.activate(${JSON.stringify(surface)})`);
    for (const keyCode of ['Return', 'Space']) {
      const before = await evaluate('window.releaseNotesFixture.copies().length');
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await wait(60);
      const copied = await evaluate('window.releaseNotesFixture.copies()');
      if (copied.length !== before + 1 || copied.at(-1) !== 'v8.3.7-beta') {
        const focus = await evaluate(`({
          focused: document.activeElement?.outerHTML,
          documentFocused: document.hasFocus(),
          versionDisabled: document.querySelector(${JSON.stringify(selector)})?.disabled
        })`);
        throw new Error(`${surface}/${keyCode}: native keyboard activation must copy exactly the displayed version once: ${JSON.stringify({ before, copied, focus })}`);
      }
      if (!await evaluate(`document.querySelector('.chat-copy-toast-label')?.textContent === 'Versão copiada!'`)) {
        throw new Error(`${surface}/${keyCode}: keyboard copy must use the shared toast`);
      }
    }
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).blur()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 3, y: 3 });
    await wait(170);
    const initial = await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`);
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await wait(180);
    const hovered = await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`);
    if (hovered === initial) throw new Error(`${surface}: version text must have a subtle hover affordance`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    // A non-activating key changes input modality without racing Tab's focus move.
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    let focused;
    for (let attempt = 0; attempt < 40; attempt++) {
      focused = await evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        return { active: document.activeElement === button, visible: button.matches(':focus-visible'),
          outline: getComputedStyle(button).outlineWidth, documentFocused: document.hasFocus() };
      })()`);
      if (focused.active && focused.visible && focused.outline === '2px') break;
      await wait(50);
    }
    if (!focused.active || !focused.visible || focused.outline !== '2px') {
      throw new Error(`${surface}: version copy needs a visible keyboard focus indicator: ${JSON.stringify(focused)}`);
    }
  }
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    if (!await evaluate(`getComputedStyle(document.querySelector('#changelog-version')).transitionDuration === '0s'`)) {
      throw new Error('Version hover must respect reduced motion');
    }
  } finally {
    window.webContents.debugger.detach();
  }
}

async function runReleaseNotesSmoke(generatedBody, fragments) {
  const [{ AboutTab }, { ChangelogModal, changelogModal }, { updateService }, { appEvents }, language] = await Promise.all([
    import('/views/settings/tabs/AboutTab.ts'), import('/views/ChangelogModal.ts'),
    import('/core/UpdateService.ts'), import('/core/EventBus.ts'), import('/i18n/index.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const originalApi = window.api;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalLanguage = language.getLanguage();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  const copies = [];
  const requests = [];
  const opened = [];
  const version = '8.3.7-beta';
  const friendlyResult = { ok: true, version, body: generatedBody, url: 'https://example.com/not-the-release' };
  let clipboardWork = async () => {};
  let notesWork = async () => friendlyResult;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async text => { copies.push(text); await clipboardWork(); } },
  });
  window.api = {
    getAppVersion: async () => version,
    getReleaseNotes: async tag => { requests.push(tag); return notesWork(); },
    openExternal: async url => { opened.push(url); return { success: true }; },
  };
  language.setLanguage('pt-BR');
  const about = new AboutTab();
  const modal = new ChangelogModal();
  const baselineListeners = appEvents.listeners.get('i18n.language_changed')?.size ?? 0;
  let root;
  const mountAbout = () => {
    about.cleanup();
    root?.remove();
    root = document.createElement('main');
    root.style.cssText = 'padding:24px;max-height:100vh;overflow:auto;width:680px;';
    root.innerHTML = about.renderHtml();
    document.body.append(root);
    about.attachEvents(root);
    return root.querySelector('#settings-app-version');
  };
  const cleanup = () => {
    modal.close();
    changelogModal.close();
    updateService.dismiss();
    about.cleanup();
    root?.remove();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete navigator.clipboard;
    window.api = originalApi;
    language.setLanguage(originalLanguage);
    console.warn = originalWarn;
    delete window.releaseNotesFixture;
  };
  try {
    let button = mountAbout();
    check(button.tagName === 'BUTTON' && button.type === 'button' && button.disabled && button.textContent === '…',
      'About/Updates version is a non-submitting button, disabled until loaded');
    const versionPending = deferred();
    window.api.getAppVersion = () => versionPending.promise;
    const loadingVersion = about.loadAppVersion(root);
    button.click();
    check(!copies.length, 'Loading placeholder cannot be copied');
    versionPending.resolve(version);
    await loadingVersion;
    check(button.textContent === `v${version}` && !button.disabled &&
      button.getAttribute('aria-label') === language.t('versionCopy.copy', { version: `v${version}` }),
    'Version display is preserved and has an accessible copy label');

    const pendingCopy = deferred();
    clipboardWork = () => pendingCopy.promise;
    button.click();
    await wait();
    check(copies.at(-1) === `v${version}` && !document.querySelector('.chat-copy-toast'),
      'Clipboard gets the displayed text, without a premature success toast');
    pendingCopy.resolve();
    await wait();
    check(document.querySelector('.chat-copy-toast')?.getAttribute('role') === 'status' &&
      document.querySelector('.chat-copy-toast-label')?.textContent === language.t('versionCopy.copied') &&
      document.querySelector('.chat-copy-toast .material-symbols-outlined')?.textContent === 'check_circle',
    'Version copy reuses the exact message copy toast and live-region semantics');
    clipboardWork = async () => {};
    about.attachEvents(root);
    about.attachEvents(root);
    const beforeRebindCopy = copies.length;
    button.click();
    await wait();
    check(copies.length === beforeRebindCopy + 1 && document.querySelectorAll('.chat-copy-toast').length === 1,
      'Rebinding does not duplicate clipboard calls or stack toasts');
    await wait(1650);
    check(!document.querySelector('.chat-copy-toast'), 'Shared copy toast expires after 1600ms');

    const superseded = deferred();
    clipboardWork = () => superseded.promise;
    button.click();
    clipboardWork = async () => { throw new Error('Clipboard denied'); };
    button.click();
    await wait();
    check(!document.querySelector('.chat-copy-toast') &&
      document.querySelector('.dialog-message')?.textContent === language.t('versionCopy.failed'),
    'Clipboard rejection reports a localized error, never success');
    superseded.resolve();
    await wait();
    check(!document.querySelector('.chat-copy-toast'), 'An older clipboard completion cannot replace a newer failure with success');
    document.querySelector('.dialog-card [data-action="confirm"]').click();

    const closingCopy = deferred();
    clipboardWork = () => closingCopy.promise;
    button.click();
    about.cleanup();
    root.remove();
    closingCopy.resolve();
    await wait();
    check(!document.querySelector('.chat-copy-toast'), 'Closing settings discards late clipboard confirmation');
    clipboardWork = async () => {};
    button = mountAbout();
    window.api.getAppVersion = async () => { throw new Error('No version bridge'); };
    await about.loadAppVersion(root);
    check(button.disabled && button.textContent === language.t('versionCopy.unavailable'), 'Version loading errors are visible and not copyable');
    const closingVersion = deferred();
    window.api.getAppVersion = () => closingVersion.promise;
    const staleVersion = about.loadAppVersion(root);
    about.cleanup();
    root.remove();
    closingVersion.resolve('99.9.9');
    await staleVersion;
    check(button.disabled, 'Late version loads cannot reactivate closed controls');

    window.api.getAppVersion = async () => version;
    button = mountAbout();
    await about.loadAppVersion(root);
    const openButton = root.querySelector('#btn-view-changelog');
    openButton.focus();
    openButton.click();
    await wait();
    check(changelogModal.isOpen() && requests.at(-1) === undefined, 'Settings manually reopens the installed-version notes through existing IPC');
    check(document.querySelector('#changelog-title').textContent === language.t('changelog.titleVersion', { version: `v${version}` }),
      'Release title retains the displayed version');
    const text = () => document.querySelector('.changelog-body').textContent;
    check(fragments.every(fragment => text().includes(fragment['pt-BR'])) && !/#\d+|renderer|JSON|Comparação completa/.test(text()),
      'Generated PT-BR prose is shown without technical body or issue references');
    check(document.querySelectorAll('.changelog-group').length === new Set(fragments.map(fragment => fragment.group)).size,
      'Only nonempty curated groups appear');
    const requestsBeforeLanguage = requests.length;
    language.setLanguage('en');
    check(fragments.every(fragment => text().includes(fragment.en) && !text().includes(fragment['pt-BR'])) &&
      document.querySelector('.changelog-group-title').textContent.includes("What's new") &&
      requests.length === requestsBeforeLanguage,
    'Changing app language updates both prose and headings without refetching or wrong-language fallback');
    const releaseVersion = document.querySelector('#changelog-version');
    releaseVersion.click();
    await wait();
    check(copies.at(-1) === `v${version}` && document.querySelector('.chat-copy-toast-label').textContent === 'Version copied!',
      'Release-notes version copies with the same localized toast');
    document.querySelector('#changelog-github').click();
    await wait();
    check(opened.at(-1) === `https://github.com/MonkyOrg/Monky/releases/tag/v${version}`,
      'Technical details open the installed release, never a remote-supplied URL');
    changelogModal.close();
    check(document.activeElement === openButton, 'Closing release notes restores settings keyboard focus');

    const legacy = [
      '### Downloads', '- setup.exe', '### Changelog', '#### ✨ Novidades', '- #547: add IPC renderer parser',
      '#### 🐛 Correções', '- #1: mutate SDP', '- #2: fix ICE',
      '#### 🔧 Outros', '- refactor: internal service', '### More details', '- unrelated item',
    ].join('\n');
    notesWork = async () => ({ ok: true, version, body: legacy });
    await modal.open();
    check(text().includes(language.t('changelog.legacyIntro')) &&
      text().includes(language.tCount('changelog.legacy.correcoes', 2)) &&
      document.querySelectorAll('.changelog-group').length === 3 &&
      !/#547|SDP|ICE|refactor|setup.exe/.test(text()),
    'Legacy releases show honest localized group counts without pretending to translate technical prose');
    modal.close();

    for (const body of ['', '<!-- monky-client-notes:v1\n{broken}\n-->\n' + legacy]) {
      notesWork = async () => ({ ok: true, version, body });
      check(!await modal.open({ requireContent: true, celebrate: true }) && !modal.isOpen(),
        'Automatic update presentation falls back rather than opening empty or invalid notes');
      await modal.open();
      check(!/#547|SDP/.test(text()) && text().includes(language.t(body ? 'changelog.invalid' : 'changelog.noHighlights')),
        'Manual reopening explains missing or malformed friendly notes without a technical fallback dump');
      modal.close();
    }
    notesWork = async () => { throw new Error('offline'); };
    await modal.open({ tag: `v${version}` });
    check(text().includes(language.t('changelog.loadFailed')) && !document.querySelector('#changelog-retry').hidden,
      'Network errors are surfaced with a retry action');
    notesWork = async () => friendlyResult;
    document.querySelector('#changelog-retry').click();
    await wait();
    check(text().includes(fragments[0].en) && requests.at(-1) === `v${version}` && document.querySelector('#changelog-retry').hidden,
      'Retry fetches the same version and replaces the error with real notes');
    window.api.openExternal = async () => ({ success: false });
    document.querySelector('#changelog-github').click();
    await wait();
    check(!document.querySelector('[data-el="link-error"]').hidden &&
      document.querySelector('[data-el="link-error"]').textContent === language.t('changelog.openFailed'),
    'Opening GitHub failures are visible, not silently retried in another browser path');
    window.api.openExternal = async url => { opened.push(url); return { success: true }; };
    document.querySelector('#changelog-github').click();
    await wait();
    check(document.querySelector('[data-el="link-error"]').hidden, 'Successful GitHub retry clears the stale error');
    modal.close();

    const getNotes = window.api.getReleaseNotes;
    delete window.api.getReleaseNotes;
    await modal.open();
    check(text().includes(language.t('changelog.loadFailed')), 'A missing release-note bridge is surfaced on manual reopening');
    modal.close();
    window.api.getReleaseNotes = getNotes;

    const delayed = deferred();
    notesWork = () => delayed.promise;
    const stale = modal.open();
    check(document.querySelector('.changelog-body').getAttribute('aria-busy') === 'true', 'Manual loading state is announced');
    modal.close();
    notesWork = async () => friendlyResult;
    await modal.open();
    delayed.resolve({ ok: true, version: '99.9.9', body: legacy });
    check(await stale === false && document.querySelector('#changelog-version').textContent === `v${version}`,
      'Closed/reopened modals ignore late responses from the previous request');
    modal.close();
    const automatic = deferred();
    notesWork = () => automatic.promise;
    const beforeAutomatic = requests.length;
    const first = modal.open({ requireContent: true, celebrate: true });
    const second = modal.open({ requireContent: true, celebrate: true });
    check(requests.length === beforeAutomatic + 1 && !modal.isOpen(), 'Concurrent automatic opens share one fetch');
    modal.close();
    automatic.resolve(friendlyResult);
    check((await Promise.all([first, second])).every(shown => !shown) && !modal.isOpen(),
      'Closing during an automatic fetch never resurrects the modal');
    notesWork = async () => friendlyResult;

    const outcomes = [{ status: 'success', version, fromVersion: '8.3.6-beta' }, null];
    window.api.getUpdateOutcome = async () => outcomes.shift() ?? null;
    await updateService.reportLastInstall();
    check(changelogModal.isOpen() && document.querySelector('#changelog-title').textContent ===
      language.t('changelog.updatedTo', { version: `v${version}` }) && !document.querySelector('.update-banner'),
    'Successful updates keep the once-after-install celebratory presentation without a leftover banner');
    changelogModal.close();
    await updateService.reportLastInstall();
    check(!changelogModal.isOpen(), 'Consumed update outcomes do not present the notes again');
    check((appEvents.listeners.get('i18n.language_changed')?.size ?? 0) === baselineListeners,
      'Every modal close unsubscribes the language listener');
    check(warnings.length >= 4, 'Expected errors are logged for diagnostics');

    language.setLanguage('pt-BR');
    button = mountAbout();
    await about.loadAppVersion(root);
    window.releaseNotesFixture = {
      copies: () => copies.slice(),
      activate: async surface => {
        modal.close();
        if (surface === 'changelog') await modal.open();
        const selector = surface === 'about' ? '#settings-app-version' : '#changelog-version';
        document.querySelector(selector).focus();
        return { selector };
      },
      preview: async locale => {
        language.setLanguage(locale);
        await modal.open();
        document.activeElement?.blur();
        await document.fonts.ready;
        await wait(100);
      },
      cleanup,
    };
    return checks;
  } catch (error) {
    cleanup();
    throw error;
  }
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
    throw new Error('Settings navigation did not settle before the timeout');
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
    const firstMenu = root.querySelector('[data-tab="first"]').nextElementSibling;
    const secondMenu = root.querySelector('[data-tab="second"]').nextElementSibling;
    const entrance = firstMenu.getAnimations()[0];
    check(entrance?.playState === 'running', 'Opening a submenu starts its animation automatically');
    entrance.pause();
    entrance.currentTime = 80;
    await new Promise(resolve => requestAnimationFrame(resolve));
    check(root.querySelectorAll('.settings-section-nav:not([hidden])').length === 1
      && root.querySelectorAll('.settings-section-link').length === 3, 'Only active tab expands its sections');
    check(firstMenu.getBoundingClientRect().height > 0
      && firstMenu.getBoundingClientRect().height < firstMenu.firstElementChild.getBoundingClientRect().height,
    'Opening a submenu shows intermediate expansion frames instead of jumping');
    entrance.play();
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
    closingAnimation.pause();
    closingAnimation.currentTime = 80;
    await new Promise(resolve => requestAnimationFrame(resolve));
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
    await settled(() => current() === 'two');
    check(current() === 'two', 'Manual content scrolling updates the selected subsection');
    setReduced(true);
    root.querySelector('[data-section-target="one"]').click();
    check(scrollCalls.at(-1).behavior === 'instant' && Math.abs(body.scrollTop - scrollCalls.at(-1).top) < 1, 'Reduced motion skips scroll animation');
    const retained = root.querySelector('[data-section-target="two"]');
    retained.focus();
    check(document.activeElement === retained, 'The subsection is focused before its label changes');
    middle.dataset.settingsLabel = 'Updated section';
    await settled(() => root.querySelector('[data-section-target="two"]').textContent === 'Updated section');
    check(root.querySelector('[data-section-target="two"]').textContent === 'Updated section'
      && document.activeElement.dataset.sectionTarget === 'two', 'Dynamic labels update without dropping sidebar keyboard focus');
    middle.parentElement.hidden = true;
    await settled(() => !root.querySelector('[data-section-target="two"]'));
    check(!root.querySelector('[data-section-target="two"]'), 'Hidden conditional sections disappear from navigation');
    middle.parentElement.hidden = false;
    await settled(() => !!root.querySelector('[data-section-target="two"]'));
    check(!!root.querySelector('[data-section-target="two"]'), 'Revealing a section restores its navigation link');
    const oldHeading = root.querySelector('[data-settings-section="one"]');
    const replacement = oldHeading.cloneNode(true);
    replacement.removeAttribute('id');
    oldHeading.replaceWith(replacement);
    await settled(() => document.getElementById(root.querySelector('[data-section-target="one"]').getAttribute('aria-controls')) === replacement);
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
  for (const section of ['camera', 'noise-suppression']) {
    await appModal.open('voice_video', section);
    const modalRoot = document.querySelector('.modal-backdrop--settings');
    check(modalRoot.querySelector('.settings-tab-btn.active')?.dataset.tab === 'voice_video'
      && modalRoot.querySelector(`.settings-section-link[data-section-target="${section}"]`)?.getAttribute('aria-current') === 'location',
    `Quick ${section} navigation opens and selects its requested voice/video subsection`);
    await settled(() => modalRoot.querySelector('.settings-content-body').scrollTop > 100);
    check(modalRoot.querySelector('.settings-content-body').scrollTop > 100,
      `Quick ${section} navigation scrolls the settings body instead of opening its unrelated default section`);
    appModal.close();
  }

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
  check(!document.querySelector('[data-tab="roles"]:not([hidden]), [data-tab="members"]:not([hidden]), [data-tab="bots"]:not([hidden])'),
    'Subsection navigation never exposes tabs unavailable to the current permissions');
  serverModal.close();
  check(!document.querySelector('.settings-section-nav'), 'Closing server settings cleans up its section navigation');
  window.matchMedia = originalMatchMedia;
  return checks;
}
