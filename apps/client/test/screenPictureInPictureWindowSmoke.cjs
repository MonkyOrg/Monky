const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  require('node:test')('Monky PiP opens its own floating window on minimize without focus, keeps frames flowing and returns to Monky', { timeout: 45000 }, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-pip-window-'));
    const env = { ...process.env, MONKY_PIP_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow, ipcMain, screen } = require('electron');
  const ts = require('typescript');
  const vm = require('node:vm');
  const { ScreenPictureInPictureWindows, handleScreenPictureInPictureOpen } =
    require(path.join(root, 'dist-electron', 'main', 'screenPictureInPictureWindow.js'));
  app.setPath('userData', process.env.MONKY_PIP_TEST_PROFILE);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  let mainWindow, other, deadline;
  // The runner's real cursor is outside the test's control, so the PiP reads this one.
  let pipCursor = { x: -100000, y: -100000 };
  const finish = code => {
    clearTimeout(deadline);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    deadline = setTimeout(() => { console.error('Monky PiP window smoke timeout'); finish(1); }, 40000);
    mainWindow = new BrowserWindow({ title: 'Monky QA - PiP', show: false, width: 480, height: 320,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        preload: path.join(root, 'dist-electron', 'preload', 'preload.js') } });
    const contents = mainWindow.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // Same order as main.ts: the PiP popup first, everything else denied.
    contents.setWindowOpenHandler(details => handleScreenPictureInPictureOpen(contents, details) ?? { action: 'deny' });
    const file = fs.readFileSync(path.join(root, 'src', 'main', 'ipcHandlers.ts'), 'utf8');
    const start = file.indexOf('const isWindowAway =');
    const end = file.indexOf("ipcMain.handle('window:minimize'", start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(ts.transpileModule(file.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, { mainWindow, ipcMain, ScreenPictureInPictureWindows: class extends ScreenPictureInPictureWindows {
      constructor(owner) { super(owner, Date.now, () => pipCursor); }
    } });
    const page = path.join(process.env.MONKY_PIP_TEST_PROFILE, 'pip.html');
    fs.writeFileSync(page, '<!doctype html><body style="background:#22252d;color:white">Monky QA: PiP<canvas width="160" height="90"></canvas><video muted autoplay></video></body>');
    await mainWindow.loadFile(page);
    const evaluate = code => contents.executeJavaScript(code, false);
    const until = async (check, label) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(label);
    };
    const untilPage = (code, label) => until(() => evaluate(code), label);
    const pipWindows = () => BrowserWindow.getAllWindows().filter(window => window !== mainWindow && window !== other
      && !window.isDestroyed());
    await evaluate(`(() => {
      const canvas = document.querySelector('canvas'), context = canvas.getContext('2d');
      const video = document.querySelector('video');
      video.srcObject = canvas.captureStream(20);
      let frame = 0;
      window.fixtureTimer = setInterval(() => {
        context.fillStyle = ++frame % 2 ? 'orange' : 'blue'; context.fillRect(0, 0, 160, 90);
      }, 50);
      window.inactiveEvents = 0;
      window.activeEvents = 0;
      window.pip = null;
      // The same steps as ScreenPictureInPicture.present(), without the call UI.
      window.openPip = async (requireInactive, id = crypto.randomUUID()) => {
        const opened = await window.api.openScreenPictureInPicture(id, requireInactive, video.videoWidth / video.videoHeight);
        if (!opened) return false;
        const child = window.open('', 'monky-screen-pip-' + id, 'popup');
        if (!child) throw new Error('Main refused the authorized popup');
        const pipVideo = child.document.createElement('video');
        pipVideo.muted = true;
        pipVideo.autoplay = true;
        pipVideo.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
        pipVideo.srcObject = video.srcObject;
        child.document.body.style.margin = '0';
        child.document.body.append(pipVideo);
        child.addEventListener('pagehide', () => { window.pipHidden = (window.pipHidden ?? 0) + 1; });
        await pipVideo.play();
        window.pip = child;
        return true;
      };
      window.closePip = () => {
        window.pip?.document.querySelector('video')?.pause();
        window.pip?.close();
        window.pip = null;
      };
      window.pipFrames = () => window.pip?.document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames ?? -1;
      window.api.onWindowActive(() => {
        window.activeEvents++;
        if (!window.manualPip) window.closePip();
      });
      window.api.onWindowInactive(() => {
        window.inactiveEvents++;
        if (window.manualPip || window.pip) return;
        window.openPip(true).then(value => { window.opened = value; }).catch(error => { window.pipError = String(error); });
      });
      return video.play();
    })()`);
    mainWindow.show(); mainWindow.focus();
    await untilPage('document.querySelector("video").readyState >= 2', 'Synthetic video must play');

    assert.equal(await evaluate(`window.open('', 'monky-screen-pip-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}', 'popup') === null`), true,
      'An unauthorized PiP popup is refused');
    assert.equal(await evaluate("window.open('https://example.com/', '_blank') === null"), true, 'Other popups stay denied');
    assert.equal(pipWindows().length, 0);

    other = new BrowserWindow({ parent: mainWindow, title: 'Monky QA - Focus target', show: false, width: 280, height: 140,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await other.loadURL('data:text/html,<body>Monky QA: focus target</body>');
    other.show(); other.focus();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(await evaluate('window.inactiveEvents'), 0, 'Focusing another window is not leaving Monky');
    assert.equal(pipWindows().length, 0, 'Focus loss alone cannot open PiP');
    other.hide(); mainWindow.focus();
    await untilPage('document.hasFocus()', 'The main window regains focus');

    const mainArea = screen.getDisplayMatching(mainWindow.getNormalBounds()).workArea;
    mainWindow.minimize();
    await untilPage('window.inactiveEvents > 0', 'Minimizing must notify the renderer of inactivity');
    await untilPage('!!window.pip || !!window.pipError', 'Monky PiP must open while minimized');
    assert.equal(await evaluate('window.pipError ?? null'), null);
    const [pip] = pipWindows();
    assert.ok(pip, 'The PiP popup is a real window');
    await until(() => pip.isVisible(), 'The PiP popup becomes visible');
    assert.equal(mainWindow.isMinimized(), true, 'Showing PiP does not restore Monky');
    assert.equal(pip.isFocused(), false, 'PiP never takes focus from the app in use');
    assert.equal(pip.isAlwaysOnTop(), true);
    assert.equal(pip.getParentWindow(), null, 'PiP is not owned by the window it outlives while minimized');
    assert.equal(pip.webContents.getURL(), 'about:blank');
    const bounds = pip.getBounds();
    assert.ok(bounds.x + bounds.width <= mainArea.x + mainArea.width && bounds.x + bounds.width >= mainArea.x + mainArea.width - 40
      && bounds.y + bounds.height <= mainArea.y + mainArea.height && bounds.y + bounds.height >= mainArea.y + mainArea.height - 40,
    `The first PiP sits at the bottom right of Monky's display (${JSON.stringify(bounds)} in ${JSON.stringify(mainArea)})`);
    assert.ok(Math.abs(bounds.height - bounds.width * 9 / 16) <= 0.5, `PiP keeps the broadcast aspect ratio (${bounds.width}x${bounds.height})`);
    const frames = await evaluate('window.pipFrames()');
    await untilPage(`window.pipFrames() > ${frames + 3}`, 'PiP must keep rendering while Monky is minimized');
    const image = await pip.webContents.capturePage();
    const { width, height } = image.getSize();
    const pixels = image.toBitmap();
    const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    const [blue, green, red] = pixels.subarray(center, center + 3);
    assert.ok((red > 180 && green > 100 && blue < 80) || (blue > 180 && red < 80),
      `The PiP window paints the broadcast (center BGR ${blue},${green},${red})`);
    assert.equal(await evaluate("getComputedStyle(window.pip.document.documentElement).getPropertyValue('--monky-pip-hover').trim()"), '',
      'Controls start hidden while the cursor is elsewhere');
    pipCursor = { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) };
    await untilPage("getComputedStyle(window.pip.document.documentElement).getPropertyValue('--monky-pip-hover').trim() === '1'",
      'Hovering the PiP window reveals its controls');
    pipCursor = { x: bounds.x - 1, y: bounds.y - 1 };
    await untilPage("getComputedStyle(window.pip.document.documentElement).getPropertyValue('--monky-pip-hover').trim() === ''",
      'Leaving the PiP window hides its controls');

    const activeEvents = await evaluate('window.activeEvents');
    mainWindow.restore(); mainWindow.focus();
    await untilPage(`window.activeEvents > ${activeEvents} && !window.pip`, 'Restoring Monky closes automatic PiP');
    await until(() => pip.isDestroyed(), 'The PiP window is destroyed when Monky closes it');

    mainWindow.minimize();
    await untilPage('!!window.pip', 'PiP opens before returning through its button');
    const [returning] = pipWindows();
    returning.setBounds({ x: mainArea.x + 40, y: mainArea.y + 40, width: 320, height: 180 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const moved = returning.getBounds();
    assert.deepEqual({ ...moved }, { x: mainArea.x + 40, y: mainArea.y + 40, width: 320, height: 180 });
    await evaluate('window.api.returnFromScreenPictureInPicture()');
    await untilPage('document.hasFocus()', 'Back to Monky must restore and focus the minimized window');
    assert.equal(mainWindow.isMinimized(), false);
    await until(() => returning.isDestroyed(), 'The restored window closes automatic PiP');

    mainWindow.minimize();
    await untilPage('!!window.pip', 'The next PiP opens');
    const [remembered] = pipWindows();
    const rememberedBounds = remembered.getBounds();
    assert.deepEqual({ ...rememberedBounds }, { ...moved }, 'PiP reopens exactly where and as large as the user left it');
    mainWindow.restore(); mainWindow.focus();
    await until(() => remembered.isDestroyed(), 'Restoring closes it again');

    mainWindow.hide();
    await untilPage('!!window.pip', 'Hiding to the tray opens PiP');
    await evaluate('window.api.returnFromScreenPictureInPicture()');
    await untilPage('document.hasFocus()', 'Back to Monky must show a window hidden in the tray');
    assert.equal(mainWindow.isVisible(), true);
    await untilPage('!window.pip', 'The shown window closes automatic PiP');

    await evaluate('window.manualPip = true');
    assert.equal(await evaluate('window.openPip(false)'), true, 'The PiP button opens while Monky is focused');
    const [manual] = pipWindows();
    await until(() => manual.isVisible(), 'Manual PiP becomes visible');
    assert.equal(await evaluate('document.hasFocus()'), true, 'Opening manual PiP keeps Monky focused');
    mainWindow.minimize();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(manual.isVisible(), true, 'Manual PiP stays visible while its owner is minimized');
    const manualFrames = await evaluate('window.pipFrames()');
    await untilPage(`window.pipFrames() > ${manualFrames + 3}`, 'Minimized manual PiP keeps producing frames');
    mainWindow.restore(); mainWindow.focus();
    await untilPage('document.hasFocus()', 'The manual PiP owner can regain focus');
    assert.equal(manual.isDestroyed(), false, 'Restoring Monky keeps an explicitly opened PiP');
    const hidden = await evaluate('window.pipHidden ?? 0');
    manual.close();
    await untilPage(`(window.pipHidden ?? 0) > ${hidden}`, 'Closing the PiP window from the system notifies Monky');
    assert.equal(pipWindows().length, 0);
    console.log('Focus-free PiP popup, frames while minimized, hover controls, return/restore/tray and remembered bounds passed.');
    finish(0);
  }).catch(error => { console.error(error); finish(1); });
}
