'use strict';
// E-MAIN-1 and E-MAIN-3 in a real Electron: the navigation and window policy every
// WebContents receives, the sandboxed preloads (#826), the overlay's minimal preload and own page (R-MEDIA-3), the
// main-frame IPC guard, the preload's one-time folder report (D4) and the renderer
// Content-Security-Policy, both in the built bundle (file://) and through the Vite dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const client = path.resolve(__dirname, '..');
const built = name => path.join(client, 'dist-electron', ...name.split('/'));

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-electron-security-'));
  const env = { ...process.env, MONKY_SECURITY_SMOKE_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: client, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 150_000);
  child.once('error', error => { clearTimeout(timer); console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { clearTimeout(timer); cleanup(); process.exitCode = code ?? 1; });
} else {
  void run().catch(error => {
    console.error(error);
    require('electron').app.exit(1);
  });
}

async function run() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const profile = process.env.MONKY_SECURITY_SMOKE_PROFILE;
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  require(built('main/botScreenDocuments.js')).registerBotScreenScheme();
  const { installWebContentsPolicy } = require(built('main/webContentsPolicy.js'));
  let disposePolicy = installWebContentsPolicy(app);
  const { MEDIA_FOLDERS_IPC, SHORTCUT_IPC, DEVELOPMENT_QA_IPC } = require('@monky/shared');
  const { IpcRegistry, windowContents } = require(built('main/ipc/registry.js'));
  // The packaged native helper is not built in DOM lanes; the overlay only needs its window to resize.
  require('@monky/screen-audio').setWindowResizeAspect = () => {};
  const { OverlayManager } = require(built('main/overlayManager.js'));
  const { isolatedWebPreferences } = require(built('main/windowPreferences.js'));
  await app.whenReady();
  // Miniapp documents answer 404 here; the frame only needs a real handler for its scheme.
  require(built('main/botScreenDocuments.js')).installBotScreenDocuments(require('electron').session.defaultSession);

  let checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks++; };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (probe, label, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await probe();
      if (last) return last;
      await delay(50);
    }
    throw new Error(`Timed out: ${label} (${JSON.stringify(last)})`);
  };
  const windows = [];
  const track = window => { windows.push(window); return window; };
  const violations = new Map();
  const observe = (label, contents) => {
    const seen = [];
    violations.set(label, seen);
    contents.on('console-message', event => {
      if (/Content Security Policy/i.test(event.message)) seen.push(event.message);
    });
    return seen;
  };

  const { server, hits, origin } = await fixtureServer();
  let vite;
  let overlay;
  try {
    // --- Policy: navigation, popups and webviews are refused by default. ---
    const control = track(new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, webviewTag: true } }));
    disposePolicy();
    const unguarded = track(new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, webviewTag: true } }));
    disposePolicy = installWebContentsPolicy(app);
    await unguarded.loadURL(`${origin}/plain`);
    await unguarded.webContents.executeJavaScript(`location.href = '${origin}/control-navigation'`);
    await until(() => hits.get('/control-navigation'), 'an unguarded window navigates (control)');
    await control.loadURL(`${origin}/plain`);
    await control.webContents.executeJavaScript(`location.href = '${origin}/guarded-navigation'`);
    const popup = await control.webContents.executeJavaScript(`String(window.open('${origin}/guarded-popup'))`);
    await control.loadURL(`${origin}/webview-host`);
    await delay(1500);
    check(!hits.get('/guarded-navigation') && control.webContents.getURL() === `${origin}/webview-host`,
      'A guarded window never leaves its document.');
    check(popup === 'null' && !hits.get('/guarded-popup'), 'window.open is refused by default.');
    check(!hits.get('/webview-guest'), 'A <webview> is never attached.');
    check(BrowserWindow.getAllWindows().length === windows.length, 'No window was created behind the guard.');
    unguarded.destroy();
    control.destroy();

    // --- Main-frame IPC guard with real senders: a frame of the owner and another window. ---
    const probePreload = path.join(profile, 'probePreload.cjs');
    fs.writeFileSync(probePreload, "const { contextBridge, ipcRenderer } = require('electron');\n"
      + "contextBridge.exposeInMainWorld('probe', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });\n");
    const probeOptions = { show: false, webPreferences: {
      preload: probePreload, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, sandbox: false,
    } };
    const owner = track(new BrowserWindow(probeOptions));
    const intruder = track(new BrowserWindow(probeOptions));
    const registry = new IpcRegistry(ipcMain, { main: () => windowContents(owner), overlay: () => null });
    registry.handle('security:probe', 'main', (_event, value) => `ok:${value}`);
    await owner.loadURL(`${origin}/host`);
    await intruder.loadURL(`${origin}/child`);
    const attempt = 'window.probe.invoke("security:probe", "x").then(value => value, error => String(error.message))';
    check(await owner.webContents.executeJavaScript(attempt) === 'ok:x', 'The main window top frame is answered.');
    const frame = await until(() => owner.webContents.mainFrame.frames[0], 'embedded frame');
    check(/only answers the main window/.test(await frame.executeJavaScript(attempt)), 'An embedded frame is refused.');
    check(/only answers the main window/.test(await intruder.webContents.executeJavaScript(attempt)), 'Another window is refused.');
    registry.dispose();

    // --- The main preload reports the saved folders once per document; nothing else does. ---
    const reports = [];
    ipcMain.handle(MEDIA_FOLDERS_IPC.adopt, (event, folders) => {
      reports.push({ sender: event.sender.id, top: event.senderFrame === event.sender.mainFrame, folders });
    });
    const appWindow = track(new BrowserWindow({ show: false, webPreferences: isolatedWebPreferences('preload') }));
    check(appWindow.webContents.getLastWebPreferences().sandbox === true, 'The main window runs sandboxed (#826).');
    await appWindow.loadURL(`${origin}/settings`);
    await until(() => reports.length === 1, 'first folder report');
    check(reports[0].top && reports[0].sender === appWindow.webContents.id && !reports[0].folders.soundboard
      && !reports[0].folders.stickers, 'A profile without folders still reports, closing the adoption.');
    await appWindow.webContents.executeJavaScript(`localStorage.setItem('monky_settings', JSON.stringify({
      soundboardFolderPath: 'C:\\\\Sons', stickersFolderPath: '/home/qa/Figurinhas', soundboardVolume: 70 }))`);
    appWindow.webContents.reload();
    await until(() => reports.length === 2, 'second folder report');
    check(reports[1].folders.soundboard === 'C:\\Sons' && reports[1].folders.stickers === '/home/qa/Figurinhas',
      'The preload reports exactly the saved sound and sticker folders.');

    // --- Only a direct user action may let Main confirm an unconfirmed folder natively (D4). ---
    const listings = [];
    const listingChannels = ['soundboard:list-sounds', 'stickers:list'];
    for (const channel of listingChannels) {
      ipcMain.handle(channel, (_event, folder, userAction) => { listings.push({ channel, folder, userAction }); return []; });
    }
    const listBoth = 'window.api.listSoundboardSounds("/qa/Sons").then(() => window.api.listStickers("/qa/Figurinhas"))';
    await appWindow.webContents.executeJavaScript(listBoth);
    check(listings.length === 2 && listings.every(entry => entry.userAction === false),
      `Loading in the background never asks to confirm a folder: ${JSON.stringify(listings)}`);
    await appWindow.webContents.executeJavaScript(listBoth, true);
    check(listings.length === 4 && listings.slice(2).every(entry => entry.userAction === true)
      && listings.map(entry => entry.channel).join() === [...listingChannels, ...listingChannels].join(),
    `A user action lets Main confirm the folder: ${JSON.stringify(listings)}`);
    for (const channel of listingChannels) ipcMain.removeHandler(channel);
    const opaque = track(new BrowserWindow({ show: false, webPreferences: isolatedWebPreferences('preload') }));
    await opaque.loadURL('data:text/html,<title>opaque</title>');
    check(await opaque.webContents.executeJavaScript('typeof window.api.getAppVersion') === 'function',
      'Documents without storage still get the API.');

    // --- The sandboxed preload has only `electron`: Node globals stay out of the page, the prepared QA
    // flag still arrives through argv, and native screen audio plays its embedded worklet (#826). ---
    check(await appWindow.webContents.executeJavaScript('typeof process + typeof require') === 'undefinedundefined',
      'The page sees neither process nor require.');
    const qaMarker = { runId: 'sandbox-fixture' };
    ipcMain.handle(DEVELOPMENT_QA_IPC.config, () => qaMarker);
    const prepared = track(new BrowserWindow({ show: false,
      webPreferences: isolatedWebPreferences('preload', { additionalArguments: ['--monky-prepared-qa'] }) }));
    await prepared.loadURL(`${origin}/plain`);
    check(JSON.stringify(await prepared.webContents.executeJavaScript('window.api.getDevelopmentQaConfig()')) === JSON.stringify(qaMarker),
      'The sandboxed preload reads its prepared QA flag from argv.');
    check(JSON.stringify(await appWindow.webContents.executeJavaScript('window.api.getDevelopmentQaConfig()')) === 'null',
      'A window without the flag never asks for the QA configuration.');
    ipcMain.removeHandler(DEVELOPMENT_QA_IPC.config);
    prepared.destroy();
    check(await nativeAudioPlays(appWindow), 'The sandboxed preload starts native screen audio from its embedded worklet.');

    // --- Built bundle (file://): the real renderer and the browser features it relies on. ---
    const assets = fs.readdirSync(path.join(client, 'dist', 'assets'));
    const asset = (pattern, contains) => {
      const name = assets.find(file => pattern.test(file)
        && (!contains || fs.readFileSync(path.join(client, 'dist', 'assets', file), 'utf8').includes(contains)));
      assert.ok(name, `Missing built asset ${pattern}`);
      return name;
    };
    const assetNames = {
      cameraWorker: asset(/^cameraEffects\.worker-.*\.js$/, 'new Worker('),
      rnnoise: asset(/^rnnoise-.*\.wasm$/),
      noiseWorklet: asset(/^workletProcessor-.*\.js$/),
    };
    const page = track(new BrowserWindow({ show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } }));
    const builtViolations = observe('built bundle', page.webContents);
    await page.loadFile(path.join(client, 'dist', 'index.html'));
    await until(() => page.webContents.executeJavaScript('document.getElementById("app").childElementCount > 0'), 'renderer UI');
    const features = await page.webContents.executeJavaScript(`(${exerciseFeatures.toString()})(${JSON.stringify({ origin, ...assetNames })})`);
    for (const [feature, result] of Object.entries(features)) check(result === true, `${feature}: ${result}`);
    check(builtViolations.length === 0, `The built renderer loads without CSP violations: ${builtViolations.join('\n')}`);
    const blocked = await page.webContents.executeJavaScript(`(${exerciseInjections.toString()})(${JSON.stringify({ origin })})`);
    for (const [injection, result] of Object.entries(blocked)) check(result === true, `${injection} must be blocked: ${result}`);
    check(!hits.get('/blocked-frame') && !hits.get('/blocked-object'), 'Blocked embeds never reach the network.');

    // --- Overlay: real OverlayManager, real bundle, minimal preload. ---
    const overlayOwner = track(new BrowserWindow({ show: false }));
    const manager = new OverlayManager(overlayOwner);
    ipcMain.handle('overlay:layout-cards', (event, layout) => manager.layoutCards(event.sender.id, layout));
    ipcMain.handle('overlay:close', () => ({ success: manager.close() }));
    ipcMain.handle('overlay:send-signal', () => undefined);
    // Opening the overlay starts none of the app's services: no sound library, cues or global input (R-MEDIA-3).
    const appServiceCalls = [];
    for (const channel of ['soundboard:list-sounds', 'soundboard:default-folder', ...Object.values(SHORTCUT_IPC)]) {
      ipcMain.handle(channel, event => { appServiceCalls.push({ channel, sender: event.sender.id }); return null; });
    }
    const overlayRequests = [];
    const overlayErrors = [];
    const created = new Promise(resolve => app.once('browser-window-created', (_event, window) => {
      // Attached before the page loads, to see every file it asks for.
      window.webContents.debugger.attach('1.3');
      window.webContents.debugger.on('message', (_message, method, params) => {
        if (method === 'Network.requestWillBeSent') overlayRequests.push(params.request.url);
      });
      void window.webContents.debugger.sendCommand('Network.enable');
      resolve(window);
    }));
    manager.open({ mode: 'cameras-only', layout: 'horizontal', position: 'bottom-right', cardOpacity: 0.85,
      focusActiveSpeaker: false, preserveAspectRatio: true });
    overlay = await created;
    check(overlay.webContents.getLastWebPreferences().sandbox === true, 'The overlay runs sandboxed (#826).');
    const overlayViolations = observe('overlay', overlay.webContents);
    overlay.webContents.on('console-message', event => {
      if (event.level === 'error') overlayErrors.push(event.message);
    });
    await until(() => !overlay.isDestroyed() && !overlay.webContents.isLoading(), 'overlay load');
    manager.sendSyncState({ config: manager.getConfig(), channelName: 'Security fixture', participants: [] });
    await until(() => overlay.webContents.executeJavaScript('!!document.querySelector(".overlay-stage-root")'), 'overlay UI');
    await delay(500);
    overlay.webContents.debugger.detach();
    const appEntry = /<script type="module"[^>]* src="\.\/assets\/([^"]+\.js)"/.exec(fs.readFileSync(path.join(client, 'dist', 'index.html'), 'utf8'))?.[1];
    const files = overlayRequests.filter(url => url.startsWith('file:')).map(url => decodeURIComponent(new URL(url).pathname).split('/').pop());
    check(new URL(overlay.webContents.getURL()).pathname.endsWith('/dist/overlay.html'), 'The overlay loads its own page.');
    check(appEntry && files.length > 1 && !files.includes(appEntry) && !files.some(name => /\.(wav|mp3)$/i.test(name)),
      `The overlay loads neither the app bundle (${appEntry}) nor its sounds: ${files.join(', ')}`);
    check(appServiceCalls.length === 0, `The overlay starts no app service: ${JSON.stringify(appServiceCalls)}`);
    const overlayApi = await overlay.webContents.executeJavaScript('Object.keys(window.api).sort().join(",")');
    check(overlayApi === ['closeOverlay', 'layoutOverlayCards', 'onOverlayConfigUpdated', 'onOverlayHoverChanged',
      'onOverlayResizeStateChanged', 'onOverlaySignalReceived', 'onOverlaySyncStateReceived', 'sendOverlaySignal'].join(','),
    `The overlay only gets what OverlayStageView uses: ${overlayApi}`);
    check(await overlay.webContents.executeJavaScript('typeof window.api.signChallenge') === 'undefined',
      'The overlay cannot sign login challenges.');
    check(!reports.some(report => report.sender === overlay.webContents.id), 'The overlay never reports folders.');
    const overlayUrl = overlay.webContents.getURL();
    await overlay.webContents.executeJavaScript(`location.href = '${origin}/overlay-navigation'`);
    const overlayPopup = await overlay.webContents.executeJavaScript(`String(window.open('${origin}/overlay-popup'))`);
    const dropped = await dropLink(overlay, `${origin}/overlay-drop`);
    await delay(1500);
    check(overlay.webContents.getURL() === overlayUrl && !hits.get('/overlay-navigation'), 'The overlay never navigates away.');
    check(overlayPopup === 'null' && !hits.get('/overlay-popup'), 'The overlay cannot open windows.');
    check(!hits.get('/overlay-drop'), `A link dropped on the overlay is not opened (${dropped}).`);
    check(overlayViolations.length === 0, `The overlay loads without CSP violations: ${overlayViolations.join('\n')}`);
    check(overlayErrors.length === 0, `The overlay renders without errors: ${overlayErrors.join('\n')}`);
    const overlayBlocked = await overlay.webContents.executeJavaScript(`(${exerciseInjections.toString()})(${JSON.stringify({ origin })})`);
    for (const [injection, result] of Object.entries(overlayBlocked)) check(result === true, `overlay: ${injection} must be blocked: ${result}`);
    manager.close();

    // --- Vite dev server (npm run dev): the same policy must not break HMR or the app. ---
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(client, 'vite.config.ts'), logLevel: 'error', cacheDir: path.join(profile, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, watch: null },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    const dev = track(new BrowserWindow({ show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } }));
    const devViolations = observe('vite', dev.webContents);
    let hmrConnected = false;
    dev.webContents.on('console-message', event => {
      if (/\[vite\] connected/.test(event.message)) hmrConnected = true;
    });
    await dev.loadURL(`http://127.0.0.1:${address.port}/`);
    await until(() => dev.webContents.executeJavaScript('document.getElementById("app").childElementCount > 0'), 'dev renderer UI', 60_000);
    await until(() => hmrConnected, 'Vite HMR connection');
    check(devViolations.length === 0, `The dev server renderer loads without CSP violations: ${devViolations.join('\n')}`);
    // npm run dev opens the overlay from the dev server too: its page must run and reload there.
    const devOverlay = track(new BrowserWindow({ show: false, width: 400, height: 240,
      webPreferences: isolatedWebPreferences('overlayPreload', { backgroundThrottling: false }) }));
    const devOverlayViolations = observe('vite overlay', devOverlay.webContents);
    let overlayHmr = false;
    devOverlay.webContents.on('console-message', event => {
      if (/\[vite\] connected/.test(event.message)) overlayHmr = true;
    });
    await devOverlay.loadURL(`http://127.0.0.1:${address.port}/overlay.html`);
    await until(() => devOverlay.webContents.executeJavaScript('!!document.querySelector(".overlay-stage-root")'), 'dev overlay UI', 60_000);
    await until(() => overlayHmr, 'Vite HMR connection in the overlay');
    check(devOverlayViolations.length === 0, `The dev server overlay loads without CSP violations: ${devOverlayViolations.join('\n')}`);
    console.log(`Electron security: ${checks} checks passed (policy, sandboxed preloads with QA flag and native audio, overlay preload, IPC guard, folder report and confirmation, CSP built and dev; ${dropped}).`);
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }

  async function finish(code) {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    await vite?.close().catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
    app.exit(code);
  }
}

/**
 * Runs one native screen audio output into the window's real preload, the way
 * Main does, with the native engine answered in place. Readiness proves the
 * AudioWorklet embedded in the preload bundle started; credits, that it plays.
 */
async function nativeAudioPlays(window) {
  const { ipcMain, MessageChannelMain } = require('electron');
  const protocol = require('@monky/shared');
  const { NativeAudioPortMain } = require(path.join(client, 'native', 'screen-share', 'runtime', 'nativeAudioPortMain.cjs'));
  const { within } = require(path.join(client, 'native', 'screen-share', 'runtime', 'asyncTools.cjs'));
  ipcMain.handle(protocol.NATIVE_SCREEN_IPC.invoke, () => null);
  const credits = Promise.withResolvers();
  const output = new NativeAudioPortMain({
    webContents: window.webContents, frame: window.webContents.mainFrame, expectedUrl: window.webContents.getURL(),
    sessionId: 'sandbox-fixture', protocol, createMessageChannel: () => new MessageChannelMain(),
    controls: {
      configureOutput: async value => ({ epoch: value.epoch, sampleRate: 48000, channels: 2 }),
      probe: value => ({ ...value, rtcBeforeUs: 1000000, rtcAfterUs: 1000001 }),
      calibrate: value => ({ epoch: value.epoch, calibrationId: value.probeId, offsetUs: 900000, uncertaintyUs: 1 }),
      grantCredits: value => credits.resolve(value),
      feedback() {},
    },
    onError: error => credits.reject(error),
  });
  try {
    // Watching a native screen is what registers the preload's audio receiver.
    await window.webContents.executeJavaScript("window.api.nativeScreenCommand({ action: 'watch' })");
    await within(output.start({ epoch: 1, sinkId: '', sampleRate: 48000, channels: 2 }), 15_000, 'Native audio never became ready.');
    const granted = await within(credits.promise, 15_000, 'The native audio worklet never asked for PCM.');
    await within(output.stop(1), 15_000, 'Native audio did not retire.');
    return granted.epoch === 1 && granted.frames > 0;
  } finally {
    ipcMain.removeHandler(protocol.NATIVE_SCREEN_IPC.invoke);
  }
}

async function dropLink(window, url) {
  const debug = window.webContents.debugger;
  try {
    debug.attach('1.3');
    const data = { items: [{ mimeType: 'text/uri-list', data: url }, { mimeType: 'text/plain', data: url }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await debug.sendCommand('Input.dispatchDragEvent', { type, x: 40, y: 40, data });
    }
    return 'dropped';
  } catch (error) {
    return `drop not simulated: ${error.message}`;
  } finally {
    if (debug.isAttached()) debug.detach();
  }
}

function fixtureServer() {
  const http = require('node:http');
  const { WebSocketServer } = require('ws');
  const hits = new Map();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pages = {
    '/plain': '<!doctype html><title>plain</title>',
    '/settings': '<!doctype html><title>settings</title>',
    '/host': '<!doctype html><title>host</title><iframe src="/child"></iframe>',
    '/child': '<!doctype html><title>child</title>',
    '/webview-host': '<!doctype html><title>webview</title><webview src="/webview-guest"></webview>',
  };
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://fixture').pathname;
    hits.set(route, (hits.get(route) ?? 0) + 1);
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (pages[route]) {
      response.setHeader('Content-Type', 'text/html');
      response.end(pages[route]);
    } else if (route === '/pixel.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(png);
    } else if (route === '/tone.wav') {
      response.setHeader('Content-Type', 'audio/wav');
      response.end(wav());
    } else if (route === '/data') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  new WebSocketServer({ server }).on('connection', socket => socket.send('hello'));
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, hits, origin: `http://127.0.0.1:${server.address().port}` })));
}

function wav() {
  const samples = 800;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

// Runs inside the built renderer: each feature the app uses must keep working under its CSP.
async function exerciseFeatures({ origin, cameraWorker, rnnoise, noiseWorklet }) {
  const settle = (promise, ms = 10_000) => Promise.race([
    promise.then(() => true, error => `${error?.name ?? 'Error'}: ${error?.message ?? error}`),
    new Promise(resolve => setTimeout(() => resolve('timed out'), ms)),
  ]);
  const loaded = (element, event) => new Promise((resolve, reject) => {
    element.addEventListener(event, resolve, { once: true });
    element.addEventListener('error', () => reject(new Error(`${element.tagName} failed: ${element.src}`)), { once: true });
  });
  const image = src => { const img = new Image(); const done = loaded(img, 'load'); img.src = src; return done; };
  const media = src => { const audio = new Audio(); const done = loaded(audio, 'loadedmetadata'); audio.src = src; return done; };
  const pixel = await (await fetch(`${origin}/pixel.png`)).blob();
  const tone = await (await fetch(`${origin}/tone.wav`)).arrayBuffer();
  const wavDataUrl = `data:audio/wav;base64,${btoa(String.fromCharCode(...new Uint8Array(tone)))}`;
  const pngDataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(pixel); });
  const context = new AudioContext();
  const wasm = await (await fetch(`./assets/${rnnoise}`)).arrayBuffer();
  const results = {
    'server image (http)': await settle(image(`${origin}/pixel.png`)),
    'inline image (data:)': await settle(image(pngDataUrl)),
    'local image (blob:)': await settle(image(URL.createObjectURL(pixel))),
    'server audio (http)': await settle(media(`${origin}/tone.wav`)),
    'inline audio (data:)': await settle(media(wavDataUrl)),
    'local audio (blob:)': await settle(media(URL.createObjectURL(new Blob([tone], { type: 'audio/wav' })))),
    'server fetch (http)': await settle(fetch(`${origin}/data`).then(response => { if (!response.ok) throw new Error(String(response.status)); })),
    'server socket (ws)': await settle(new Promise((resolve, reject) => {
      const socket = new WebSocket(origin.replace('http', 'ws'));
      socket.onmessage = () => { socket.close(); resolve(); };
      socket.onerror = () => reject(new Error('WebSocket failed'));
    })),
    'noise suppression WebAssembly': await settle(WebAssembly.compile(wasm)),
    'bundled AudioWorklet': await settle(context.audioWorklet.addModule(`./assets/${noiseWorklet}`)),
    'runtime AudioWorklet (blob:) compiling WebAssembly': await settle((async () => {
      const code = `registerProcessor('csp-probe', class extends AudioWorkletProcessor {
        constructor(options) { super(); WebAssembly.compile(options.processorOptions.wasm)
          .then(() => this.port.postMessage('compiled'), error => this.port.postMessage('refused: ' + error.message)); }
        process() { return false; } });`;
      await context.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
      const node = new AudioWorkletNode(context, 'csp-probe', { processorOptions: { wasm } });
      const reply = await new Promise(resolve => { node.port.onmessage = event => resolve(event.data); });
      if (reply !== 'compiled') throw new Error(reply);
    })()),
    'camera effects module worker': await settle((async () => {
      const { default: createWorker } = await import(new URL(`./assets/${cameraWorker}`, location.href).href);
      const worker = createWorker({ name: 'csp-probe' });
      const reply = await new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data?.type);
        worker.onerror = event => reject(new Error(event.message || 'Worker failed'));
        worker.postMessage({ type: 'dispose' });
      });
      if (reply !== 'disposed') throw new Error(`Unexpected reply ${reply}`);
    })()),
    'miniapp frame (monky-miniapp:)': await settle(new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.onload = resolve;
      frame.src = 'monky-miniapp://csp-probe/index.html';
      document.body.append(frame);
      setTimeout(resolve, 1000);
    })),
  };
  await context.close();
  return results;
}

// Runs inside the built renderer: what an escaping mistake could inject must stay inert.
async function exerciseInjections({ origin }) {
  const reports = [];
  document.addEventListener('securitypolicyviolation', event => reports.push(event.effectiveDirective));
  const reported = async directive => {
    for (let i = 0; i < 40 && !reports.includes(directive); i++) await new Promise(resolve => setTimeout(resolve, 50));
    return reports.includes(directive);
  };
  document.body.insertAdjacentHTML('beforeend', '<img src="data:," onerror="window.__cspInline = true">');
  const script = document.createElement('script');
  script.textContent = 'window.__cspScript = true';
  document.body.append(script);
  let evaluated = false;
  try { evaluated = eval('true'); } catch { /* refused */ }
  document.body.insertAdjacentHTML('beforeend', `<iframe src="${origin}/blocked-frame"></iframe><object data="${origin}/blocked-object"></object>`);
  const link = document.createElement('a');
  link.href = 'javascript:window.__cspUrl = true';
  document.body.append(link);
  link.click();
  return {
    'inline event handler': window.__cspInline === undefined && await reported('script-src-attr') || `ran or unreported: ${reports}`,
    'injected inline script': window.__cspScript === undefined && await reported('script-src-elem') || `ran or unreported: ${reports}`,
    'eval': evaluated === false || 'eval ran',
    'javascript: URL': window.__cspUrl === undefined || 'javascript: URL ran',
    'third-party frame': await reported('frame-src') || `unreported: ${reports}`,
    'plugin object': await reported('object-src') || `unreported: ${reports}`,
  };
}
