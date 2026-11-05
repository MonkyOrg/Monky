const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// The web version looks like the desktop (#858): a desktop-only control stays
// in place, locked. Real clicks and keys must offer the app and never reach the
// control; Tab still moves through; the download opens the page of the language.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('desktop-only controls stay visible, locked, and offer the desktop app', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `desktop-only-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_DESKTOP_ONLY_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_DESKTOP_ONLY_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Desktop-only DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'desktop-only-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__desktop_only__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head>'
              + '<body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, false);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const waitFor = async (expression, message, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await frames();
      }
      throw new Error(`${message}: ${JSON.stringify(await evaluate('window.qaState()'))}`);
    };
    let checks = 0;
    const check = async (expression, message) => {
      if (!await evaluate(expression)) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.qaState()'))}`);
      checks++;
    };
    const key = async (keyCode) => {
      browser.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode.length === 1) browser.webContents.sendInputEvent({ type: 'char', keyCode });
      browser.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await frames();
    };
    const pointAt = async (selector) => evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`);
    const click = async (selector) => {
      const point = await pointAt(selector);
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await frames();
    };
    const dialogs = 'document.querySelectorAll(".modal-backdrop:not([data-ui-closing]) .desktop-only-dialog").length';
    const closeOffer = async () => {
      await key('Escape');
      await waitFor(`${dialogs} === 0`, 'The offer did not close');
    };
    try {
      browser.webContents.focus();
      for (const language of ['pt-BR', 'en']) {
        checks = 0;
        await browser.loadURL(`${origin}/__desktop_only__`);
        await evaluate(`(${setup.toString()})(${JSON.stringify(language)})`);
        await check('window.qa.desktopUnchanged', 'Where the platform has the feature, the helpers return the markup untouched');
        await check('window.qa.button.getAttribute("aria-disabled") === "true" && !window.qa.button.disabled',
          'A locked control is aria-disabled, never disabled');
        await check('window.qa.button.querySelector(".desktop-only-badge")?.textContent === window.qa.t("desktopOnly.badge")',
          'A locked control carries the Desktop badge');

        // Hover explains it.
        const point = await pointAt('#locked');
        browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        await waitFor('document.querySelector(".monky-tooltip:not([hidden])")?.textContent === window.qa.t("desktopOnly.tooltip")',
          'Hovering a locked control shows its tooltip');
        checks++;

        // A real click opens one offer naming the feature; the control's own handler never runs.
        await click('#locked');
        await waitFor(`${dialogs} === 1`, 'A click on a locked control opens the offer');
        await check(`document.querySelector(".modal-backdrop:not([data-ui-closing]) .desktop-only-dialog").textContent.includes(window.qa.t("desktopOnly.feature.overlay"))
          && !!document.querySelector(".modal-backdrop:not([data-ui-closing]) .desktop-only-dialog [data-action=download]")`, 'The offer names the feature and offers the download');
        await check(`(() => {
          const card = document.querySelector(".modal-backdrop:not([data-ui-closing]) .desktop-only-dialog");
          const actions = card.querySelectorAll(".desktop-only-dialog__actions button");
          return actions.length === 1 && actions[0].dataset.action === "download"
            && card.querySelectorAll("[data-modal-close]").length === 1 && !!card.querySelector(".modal-header [data-modal-close]");
        })()`, 'The offer has only the download in its footer; the header X is its only close button');
        await check('window.qa.ownRuns === 0', 'The locked control did not run');
        await evaluate('window.qa.button.click()');
        await frames();
        await check(`${dialogs} === 1`, 'A second activation does not stack another offer');

        // Download opens the page of the language, then the offer closes and focus returns.
        await evaluate('document.querySelector(".modal-backdrop:not([data-ui-closing]) .desktop-only-dialog [data-action=download]").click()');
        await waitFor(`${dialogs} === 0`, 'The offer closes after opening the page');
        await check(`JSON.stringify(window.qa.opened) === JSON.stringify([${JSON.stringify(language === 'en'
          ? 'https://monkyorg.github.io/Monky/en/download.html' : 'https://monkyorg.github.io/Monky/download.html')}])`,
        'The download opens the official page of the language');
        await waitFor('document.activeElement === window.qa.button', 'Closing returns focus to the control');
        checks++;

        // A switch inside a locked block does not toggle.
        await click('#locked-switch');
        await waitFor(`${dialogs} === 1`, 'A click inside a locked block opens the offer');
        await check('document.querySelector("#locked-switch").checked === false && window.qa.changes === 0', 'The locked switch did not toggle');
        await check('document.querySelector(".modal-backdrop:not([data-ui-closing]) .desktop-only-dialog").textContent.includes(window.qa.t("desktopOnly.feature.gamePresence"))',
          'The block names its own feature');
        await closeOffer();

        // Keyboard: Enter and Space offer the app; Tab moves past.
        await evaluate('document.querySelector("#before").focus()');
        await key('Tab');
        await check('document.activeElement === window.qa.button', 'Tab reaches the locked control in order');
        await waitFor('document.querySelector(".monky-tooltip:not([hidden])")?.textContent === window.qa.t("desktopOnly.tooltip")',
          'Focusing a locked control shows its tooltip');
        for (const pressed of ['Enter', 'Space']) {
          await key(pressed);
          await waitFor(`${dialogs} === 1`, `${pressed} on a locked control opens the offer`);
          await check('window.qa.ownRuns === 0', `${pressed} did not run the control`);
          await closeOffer();
          await waitFor('document.activeElement === window.qa.button', 'Focus returns to the control');
        }
        await key('Tab');
        await check('document.activeElement?.id === "locked-switch"', 'Tab moves on to the next control');
        await key('Tab');
        await check('document.activeElement?.classList.contains("desktop-only-notice__download")', 'The panel notice offers the download');

        // Under its notice, a locked panel is quiet: no second dialog, no action, no change; the tooltip still explains.
        await key('Tab');
        await check('document.activeElement?.id === "panel-button"', 'Tab reaches a button of the locked panel');
        await waitFor('document.querySelector(".monky-tooltip:not([hidden])")?.textContent === window.qa.t("desktopOnly.tooltip")',
          'Focusing a control of the locked panel shows the tooltip');
        for (const pressed of ['Enter', 'Space']) {
          await key(pressed);
          await frames();
          await check(`${dialogs} === 0 && window.qa.panelRuns === 0`, `${pressed} inside the locked panel does nothing`);
        }
        await click('#panel-button');
        await frames();
        await check(`${dialogs} === 0 && window.qa.panelRuns === 0`, 'A click inside the locked panel does nothing');
        await click('label.toggle-switch:has(#panel-switch)');
        await frames();
        await check(`${dialogs} === 0 && window.qa.panelRuns === 0 && !document.querySelector("#panel-switch").checked`,
          'A switch inside the locked panel neither toggles nor opens the offer');
        await evaluate('document.querySelector("#panel-button").focus()');
        await key('Tab');
        await check('document.activeElement?.id === "panel-switch"', 'Tab moves through the locked panel');
        await key('Space');
        await frames();
        await check(`${dialogs} === 0 && !document.querySelector("#panel-switch").checked`, 'Space on a switch of the locked panel does nothing');
        await key('Tab');
        await check('document.activeElement?.id === "locked-field"', 'Tab reaches the field of a locked panel');

        // Typing into a locked panel changes nothing.
        await key('x');
        await check('document.querySelector("#locked-field").value === "abc"', 'Typing into a locked panel changes nothing');
        await check(`${dialogs} === 0`, 'Typing does not open the offer');
        await key('Tab');
        await check('document.activeElement?.id === "locked-icon"', 'Tab leaves the locked panel');
        // Outside the panel, a locked control still offers the app.
        await key('Enter');
        await waitFor(`${dialogs} === 1`, 'A locked control outside the panel still opens the offer');
        await closeOffer();
        await key('Tab');
        await check('document.activeElement?.id === "after"', 'Tab moves past the locked icon');

        // Locked buttons do not react to the pointer: the look under it and while pressed is the resting one.
        for (const selector of ['#locked', '#locked-icon']) {
          browser.webContents.sendInputEvent({ type: 'mouseMove', x: 990, y: 790 });
          await frames();
          const resting = await evaluate(`window.qa.look(${JSON.stringify(selector)})`);
          const point = await pointAt(selector);
          browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          await frames();
          const hovered = await evaluate(`window.qa.look(${JSON.stringify(selector)})`);
          browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          await frames();
          const pressed = await evaluate(`window.qa.look(${JSON.stringify(selector)})`);
          browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await waitFor(`${dialogs} === 1`, `Releasing on ${selector} opens the offer`);
          await closeOffer();
          if (hovered !== resting || pressed !== resting) {
            throw new Error(`${selector} reacts to the pointer: ${JSON.stringify({ resting, hovered, pressed })}`);
          }
          checks++;
        }
        await check('window.qa.button.querySelector(".desktop-only-badge") !== null && !document.querySelector("#locked-icon .desktop-only-badge")',
          'Only the control with text carries the badge');
        await check(`window.qa.footerIcons.every((icon) => icon.locked && !icon.badge && !icon.pulse)`,
          'The icon-only buttons of the call footer are locked without a badge or a live state');

        // Inside a dialog, locked options never stack the offer: a partly locked settings tab explains them with a short notice.
        const summary = (scope) => `document.querySelector(${JSON.stringify(`${scope} .desktop-only-notice[data-desktop-only-summary]`)})`;
        await evaluate('import("/views/SettingsModal.ts").then(({ settingsModal }) => { window.qa.settings = settingsModal; void settingsModal.open("voice_video"); })');
        await waitFor(`${summary('#tab-panel-voice_video')}?.textContent.includes(window.qa.t("desktopOnly.someOptions"))`,
          'The partly locked Voice tab shows the short notice');
        await check(`!!${summary('#tab-panel-voice_video')}.querySelector("[data-desktop-download]")
          && ${summary('#tab-panel-voice_video')} === document.querySelector("#tab-panel-voice_video").firstElementChild`,
        'The short notice sits at the top of the tab with the download');
        await check(`!${summary('#tab-panel-keybinds')} && !!document.querySelector("#tab-panel-keybinds .desktop-only-notice")
          && !${summary('#tab-panel-notifications')}`, 'A fully locked tab keeps its own notice; a tab with nothing locked gets none');
        await click('#mode-card-ptt');
        await frames();
        await check(`${dialogs} === 0 && document.querySelector("#mode-card-ptt").getAttribute("aria-pressed") === "false"`,
          'A click on push-to-talk inside Settings does nothing');
        await evaluate('document.querySelector("#mode-card-vad").focus()');
        await key('Tab');
        await check('document.activeElement?.id === "mode-card-ptt"', 'Tab reaches the locked push-to-talk card');
        await waitFor('document.querySelector(".monky-tooltip:not([hidden])")?.textContent === window.qa.t("desktopOnly.tooltip")',
          'Focusing push-to-talk shows the tooltip');
        for (const pressed of ['Enter', 'Space']) {
          await key(pressed);
          await frames();
          await check(`${dialogs} === 0 && document.querySelector("#mode-card-ptt").getAttribute("aria-pressed") === "false"`,
            `${pressed} on push-to-talk inside Settings does nothing`);
        }
        await evaluate('window.qa.settings.close()');
        await waitFor('!document.querySelector(".settings-modal-card")', 'Settings closed');

        // Add Server: the dialog explains its locked options once, at the top; they stay quiet.
        await evaluate('import("/views/addServer/AddServerModal.ts").then(({ addServerModal }) => { window.qa.addServer = addServerModal; addServerModal.open(); })');
        await waitFor(`${summary('#add-server-modal')}?.textContent.includes(window.qa.t("desktopOnly.someOptionsDialog"))`,
          'Add Server shows the short notice');
        await click('#add-server-option-create');
        await frames();
        await check(`${dialogs} === 0 && !!document.querySelector("#add-server-option-create")`, 'Creating a server inside Add Server does nothing');
        await click('#add-server-option-join');
        await waitFor('document.querySelector("#add-server-scan-lan") && !document.querySelector("#add-server-modal [data-ui-closing]")',
          'The join step opens');
        await waitFor(`!!${summary('#add-server-modal')}`, 'The join step keeps the short notice');
        await click('#add-server-scan-lan');
        await frames();
        await check(`${dialogs} === 0`, 'Scanning the local network inside Add Server does nothing');
        await evaluate('document.querySelector("#add-server-scan-lan").focus()');
        await key('Enter');
        await frames();
        await check(`${dialogs} === 0`, 'Enter on the local network scan inside Add Server does nothing');
        await evaluate('window.qa.addServer.close(true)');
        await waitFor('!document.querySelector("#add-server-modal")', 'Add Server closed');

        // Outside any dialog, the same kind of control offers the app.
        await click('#locked-icon');
        await waitFor(`${dialogs} === 1`, 'A locked control outside any dialog opens the offer');
        await closeOffer();
        console.log(`Desktop-only controls (${language}): ${checks} checks passed`);
      }
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function setup(language) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const desktopOnly = await import('/utils/desktopOnly.ts');
  const { initTooltips } = await import('/core/TooltipService.ts');
  const { renderSwitch } = await import('/utils/formControls.ts');
  const markup = () => `
    <button type="button" id="before">before</button>
    <button type="button" id="locked"${desktopOnly.lockedAttributes('overlay', 'overlay')}>Overlay${desktopOnly.lockedBadge('overlay')}</button>
    ${desktopOnly.lockedBlock('gamePresence', 'gamePresence', `<div>${renderSwitch({ id: 'locked-switch', label: 'Game', checked: false })}</div>`)}
    ${desktopOnly.lockedPanel('globalShortcuts', 'globalShortcuts', `<button type="button" id="panel-button" class="btn btn-secondary">Record</button>
      <div>${renderSwitch({ id: 'panel-switch', label: 'Sound', checked: false })}</div><input id="locked-field" value="abc">`)}
    <button type="button" id="locked-icon" class="btn btn-icon"${desktopOnly.lockedAttributes('overlay', 'overlay')}><span class="material-symbols-outlined">picture_in_picture_alt</span></button>
    <button type="button" id="after">after</button>`;
  // The desktop: the bridge has every capability, so nothing is touched.
  window.api = { capabilities: undefined };
  const desktop = markup();
  const desktopUnchanged = !desktop.includes('data-desktop-only') && !desktop.includes('desktop-only-')
    && desktopOnly.lockedBlock('overlay', 'overlay', '<p>x</p>') === '<p>x</p>' && desktopOnly.lockedPanel('overlay', 'overlay', '<p>x</p>') === '<p>x</p>';
  const opened = [];
  // The web: what a browser tab declares.
  window.api = {
    capabilities: {
      windowControls: false, screenPictureInPicture: true, documentPictureInPicture: true, automaticPictureInPicture: false,
      hostServer: false, lanDiscovery: false, overlay: false, globalShortcuts: false, tray: false, autoStart: false,
      autoUpdate: false, gamePresence: false, nativeScreenAudio: false, screenShare: true, browserScreenPicker: true,
      screenEncoderChoice: false, localExecution: false, botScreens: true, directMessages: true, mediaFolders: true,
      mediaFolderPicker: false, botSoundDownloads: false, folderDownloads: false, durableIdentity: false, plainRemoteServers: false,
    },
    openExternal: async (url) => { opened.push(url); return { success: true }; },
  };
  document.querySelector('#app').innerHTML = markup();
  initTooltips();
  desktopOnly.installDesktopOnlyGate();
  const qa = { t, opened, desktopUnchanged, ownRuns: 0, changes: 0, panelRuns: 0, button: document.querySelector('#locked') };
  qa.button.addEventListener('click', () => { qa.ownRuns++; });
  qa.button.addEventListener('keydown', () => { qa.ownRuns++; });
  document.querySelector('#locked-switch').addEventListener('change', () => { qa.changes++; });
  document.querySelector('#panel-button').addEventListener('click', () => { qa.panelRuns++; });
  document.querySelector('#panel-switch').addEventListener('change', () => { qa.panelRuns++; });
  // The resting look of a control, to compare with its look under the pointer.
  qa.look = (selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    return JSON.stringify([style.backgroundColor, style.color, style.borderColor, style.transform, style.boxShadow, style.opacity]);
  };
  // The real footer of a call, where screen sharing and the soundboard are icon-only buttons.
  window.api = { ...window.api, capabilities: { ...window.api.capabilities, screenShare: false, mediaFolders: false } };
  const { UserControlBar } = await import('/views/main/UserControlBar.ts');
  const footer = document.createElement('div');
  footer.id = 'qa-footer';
  footer.innerHTML = new UserControlBar({ root: footer, toggleCamera: async () => {} })
    .markup({ nickname: 'QA', avatarUrl: null }).toString();
  qa.footerIcons = ['#media-btn-screen', '#media-btn-soundboard'].map((selector) => {
    const button = footer.querySelector(selector);
    return { locked: button?.getAttribute('data-desktop-only') ?? null, badge: !!button?.querySelector('.desktop-only-badge'),
      pulse: !!button?.classList.contains('broadcasting-pulse') || !!button?.classList.contains('active') };
  });
  window.api = { ...window.api, capabilities: { ...window.api.capabilities, screenShare: true, mediaFolders: true } };
  // Whatever else the views ask of the platform answers the neutral value, as the web bridge does.
  const bridge = window.api;
  window.api = new Proxy(bridge, {
    get(target, key) {
      if (Reflect.has(target, key) || typeof key !== 'string' || key === 'then') return Reflect.get(target, key);
      return key.startsWith('on') ? () => () => {} : async () => undefined;
    },
  });
  window.qa = qa;
  window.qaState = () => ({
    active: document.activeElement?.id || document.activeElement?.className, ownRuns: qa.ownRuns, changes: qa.changes,
    opened: qa.opened, dialogs: document.querySelectorAll('.desktop-only-dialog').length,
    tooltip: document.querySelector('.monky-tooltip:not([hidden])')?.textContent ?? null, panelRuns: qa.panelRuns,
    footerIcons: qa.footerIcons,
  });
}
