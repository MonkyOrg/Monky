const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// On a phone the app's controls reply to the touch: Android vibrates, Safari on
// the iPhone plays the tick of a hidden switch. Real clicks only; the tick must
// never look like a click to the page, and a computer never replies.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('controls reply to the touch on phones, and only there', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `haptics-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_HAPTICS_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_HAPTICS_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Haptics DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'haptics-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__haptics__') return next();
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
    browser = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, false);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    let checks = 0;
    const check = async (expression, message) => {
      if (!await evaluate(expression)) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.qaState()'))}`);
      checks++;
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      })()`);
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await frames();
    };
    const replies = () => evaluate('JSON.stringify(window.qa.replies)');
    const expectReplies = async (expected, message) => {
      const actual = await replies();
      if (actual !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${actual}`);
      await evaluate('window.qa.replies.length = 0');
      checks++;
    };
    try {
      browser.webContents.focus();
      await browser.loadURL(`${origin}/__haptics__`);
      await evaluate(`(${setup.toString()})()`);

      // A computer (fine pointer) never replies, even with a vibrate API, and offers no setting for it.
      await check('!window.qa.supported() && !window.qa.settingsMarkup().includes("checkbox-haptics")',
        'A computer has no touch reply and no setting');
      await click('#call');
      await expectReplies([], 'A computer does not vibrate');

      // Android: the browser vibrates.
      await evaluate('window.qa.coarse = true');
      await check('window.qa.supported() && window.qa.settingsMarkup().includes("checkbox-haptics")',
        'A phone offers the setting');
      await click('#call');
      await click('#leave');
      await click('#app-switch + .toggle-slider');
      await click('[data-qa-card="b"]');
      await click('#plain');
      await expectReplies([14, 28, 8, 8], 'Call controls, leaving, switches and choice cards reply; a plain button does not');
      await check('document.querySelector("#app-switch").checked', 'The switch still toggles');
      await click('#locked');
      await expectReplies([], 'A locked desktop-only control does not reply');
      await evaluate('window.qa.showError()');
      await expectReplies([[28, 60, 28]], 'An error toast replies with the error pattern');

      // The person turns it off.
      await evaluate('window.qa.settings.hapticsEnabled = false');
      await click('#call');
      await evaluate('window.qa.showError()');
      await expectReplies([], 'Turned off, nothing replies');
      await evaluate('window.qa.settings.hapticsEnabled = true');

      // iPhone: no vibrate; the hidden switch's tick plays instead, and its click never reaches the page.
      await evaluate(`Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true });
        window.qa.documentClicks = 0`);
      await check('window.qa.supported()', 'Safari on the iPhone is supported through the switch');
      await click('#call');
      await check('window.qa.ticks === 1 && window.qa.documentClicks === 1',
        'One tick, and the page saw only the real click');
      await check('document.head.querySelector("[data-haptic-tick] input[switch]")?.checked === true',
        'The hidden switch really toggled: the tick is its own');
      await check('!document.body.querySelector("[data-haptic-tick]") && getComputedStyle(document.head.querySelector("[data-haptic-tick]")).display === "none"',
        'The hidden switch is never on the page');
      await check('document.activeElement?.id === "call"', 'The tick does not take the focus');
      await evaluate('window.qa.ticks = 0; window.qa.showError()');
      await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
      await check('window.qa.ticks === 2', 'An error plays two ticks');

      console.log(`Haptics DOM checks passed: ${checks}`);
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setup() {
  const { setLanguage } = await import('/i18n/index.ts');
  setLanguage('pt-BR');
  const { settingsStore } = await import('/stores/settingsStore.ts');
  const desktopOnly = await import('/utils/desktopOnly.ts');
  const haptics = await import('/utils/haptics.ts');
  const { renderSwitch, renderChoiceCards } = await import('/utils/formControls.ts');
  const { showErrorToast } = await import('/views/CopyToast.ts');
  const { NotificationsTab } = await import('/views/settings/tabs/NotificationsTab.ts');
  const qa = { replies: [], coarse: false, ticks: 0, documentClicks: 0, settings: settingsStore };
  window.qa = qa;
  const realMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => query === '(pointer: coarse)'
    ? { matches: qa.coarse, media: query, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia(query);
  Object.defineProperty(navigator, 'vibrate', { value: (pattern) => { qa.replies.push(pattern); return true; }, configurable: true });
  // Chromium has no `switch` attribute; WebKit reflects it on the prototype.
  Object.defineProperty(HTMLInputElement.prototype, 'switch', {
    configurable: true, get() { return this.hasAttribute('switch'); },
  });
  const click = HTMLLabelElement.prototype.click;
  HTMLLabelElement.prototype.click = function () {
    if (this.hasAttribute('data-haptic-tick')) qa.ticks++;
    return click.call(this);
  };
  window.api = { capabilities: {
    windowControls: false, screenPictureInPicture: true, documentPictureInPicture: true, automaticPictureInPicture: false,
    hostServer: false, lanDiscovery: false, overlay: false, globalShortcuts: false, tray: false, autoStart: false,
    autoUpdate: false, gamePresence: false, nativeScreenAudio: false, screenShare: true, browserScreenPicker: true,
    screenEncoderChoice: false, localExecution: false, botScreens: true, directMessages: true, mediaFolders: true,
    mediaFolderPicker: false, botSoundDownloads: false, folderDownloads: false, durableIdentity: false, plainRemoteServers: false,
  } };
  document.querySelector('#app').innerHTML = `
    <button type="button" id="call" data-haptic="impact">Mic</button>
    <button type="button" id="leave" data-haptic="heavy">Leave</button>
    <button type="button" id="plain">Plain</button>
    <div>${renderSwitch({ id: 'app-switch', label: 'Switch', checked: false })}</div>
    ${renderChoiceCards({ id: 'cards', label: 'Cards', attribute: 'data-qa-card', selected: 'a',
    choices: [{ value: 'a', title: 'A' }, { value: 'b', title: 'B' }] })}
    <button type="button" id="locked" data-haptic="impact"${desktopOnly.lockedAttributes('overlay', 'overlay')}>Overlay</button>`;
  desktopOnly.installDesktopOnlyGate();
  haptics.installHaptics();
  document.addEventListener('click', () => { qa.documentClicks++; }, true);
  qa.supported = () => haptics.hapticsSupported();
  qa.settingsMarkup = () => new NotificationsTab().renderHtml();
  qa.showError = () => { showErrorToast('Falhou'); };
  window.qaState = () => ({ replies: qa.replies, ticks: qa.ticks, documentClicks: qa.documentClicks, coarse: qa.coarse });
}
