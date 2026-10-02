const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  require('node:test')('native window inactivity opens PiP and window return closes it without restarting playback', { timeout: 40000 }, async () => {
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
  app.setPath('userData', process.env.MONKY_PIP_TEST_PROFILE);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  let mainWindow, other, deadline;
  const finish = code => {
    clearTimeout(deadline);
    other?.destroy();
    mainWindow?.destroy();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    deadline = setTimeout(() => { console.error('Native PiP window smoke timeout'); finish(1); }, 30000);
    mainWindow = new BrowserWindow({ title: 'Monky QA - Native PiP', show: false, width: 480, height: 320,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        preload: path.join(root, 'dist-electron', 'preload', 'preload.js') } });
    mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const file = fs.readFileSync(path.join(root, 'src', 'main', 'ipcHandlers.ts'), 'utf8');
    const start = file.indexOf('let screenPipWindowInactive =');
    const end = file.indexOf("ipcMain.handle('window:minimize'", start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(ts.transpileModule(file.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, { mainWindow, ipcMain });
    await mainWindow.loadURL('data:text/html,<body style="background:%2322252d;color:white">Monky QA: PiP<canvas width="160" height="90"></canvas><video muted autoplay></video></body>');
    const evaluate = code => mainWindow.webContents.executeJavaScript(code, false);
    const until = async (code, label) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await evaluate(code)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(label);
    };
    await evaluate(`(() => {
      const canvas = document.querySelector('canvas'), context = canvas.getContext('2d');
      const video = document.querySelector('video');
      video.dataset.monkyScreenPip = '0bb2238a-3560-4dc1-bb1c-72b6978aa96a';
      video.srcObject = canvas.captureStream(20);
      let frame = 0;
      window.fixtureTimer = setInterval(() => {
        context.fillStyle = ++frame % 2 ? 'orange' : 'blue'; context.fillRect(0, 0, 160, 90);
      }, 50);
      window.nativeEvents = 0;
      window.activeEvents = 0;
      window.api.onWindowActive(() => {
        window.activeEvents++;
        if (!window.manualPip && window.nativeEvents && document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(error => window.pipError = String(error));
        }
      });
      window.api.onWindowInactive(() => {
        window.nativeEvents++;
        window.inactiveActivation = navigator.userActivation.isActive;
        if (window.manualPip || document.pictureInPictureElement) return;
        window.api.openScreenPictureInPicture(video.dataset.monkyScreenPip, true)
          .then(value => window.opened = value).catch(error => window.pipError = String(error));
      });
      return video.play();
    })()`);
    mainWindow.show(); mainWindow.focus();
    await until('document.querySelector("video").readyState >= 2', 'Synthetic video must play');
    assert.equal(await evaluate('navigator.userActivation.isActive'), false);
    other = new BrowserWindow({ parent: mainWindow, title: 'Monky QA - Focus target', show: false, width: 280, height: 140,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await other.loadURL('data:text/html,<body>Monky QA: native focus target</body>');
    other.show(); other.focus();
    await until('window.nativeEvents > 0', 'A second native window must notify the renderer of inactivity');
    await until('!!document.pictureInPictureElement || !!window.pipError', 'Real PiP must open');
    assert.equal(await evaluate('window.pipError ?? null'), null);
    assert.equal(await evaluate('window.inactiveActivation'), false);
    assert.equal(await evaluate('!!document.pictureInPictureElement'), true);
    const frames = await evaluate('document.pictureInPictureElement.getVideoPlaybackQuality().totalVideoFrames');
    await until(`document.pictureInPictureElement.getVideoPlaybackQuality().totalVideoFrames > ${frames + 3}`, 'PiP must keep playing');
    const inactiveEvents = await evaluate('window.nativeEvents');
    await evaluate('document.exitPictureInPicture()');
    mainWindow.minimize();
    await until(`document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames > ${frames + 6}`,
      'The source remains alive after the user dismisses PiP');
    assert.equal(await evaluate('window.nativeEvents'), inactiveEvents,
      'Minimizing an already inactive window cannot reopen a dismissed PiP');
    assert.equal(await evaluate('!!document.pictureInPictureElement'), false);
    mainWindow.restore(); mainWindow.focus();
    await until('document.hasFocus()', 'Return to the stage after dismissing PiP');
    assert.equal(await evaluate('!!document.pictureInPictureElement'), false,
      'Returning after dismissal cannot flash a PiP window');
    other.show(); other.focus();
    await until('!!document.pictureInPictureElement', 'The next real departure may open PiP again');
    const activeEvents = await evaluate('window.activeEvents');
    other.hide(); mainWindow.focus();
    await until(`window.activeEvents > ${activeEvents} && !document.pictureInPictureElement`,
      'Returning native focus must notify the renderer and close real PiP');
    await until(`document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames > ${frames + 6}`,
      'Returning to the main window must preserve playback');
    assert.equal(await evaluate('window.pipError ?? null'), null);
    const runPowerShell = async (file, args) => {
      const { stdout } = await promisify(execFile)('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'fixtures', file), ...args],
        { windowsHide: true, timeout: 10000 });
      return JSON.parse(stdout.trim());
    };
    const ownedWindows = () => runPowerShell('ownedWindowSnapshot.ps1', ['-ProcessId', String(process.pid)]);
    const beforeManual = process.platform === 'win32' ? await ownedWindows() : [];
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.manualPip = true;
      return document.querySelector('video').requestPictureInPicture().then(() => true);
    })()`, true);
    let pipWindow, targetDisplay, targetArea;
    if (process.platform === 'win32') {
      const after = await ownedWindows();
      pipWindow = after.find(window => window.visible
        && !beforeManual.some(previous => previous.handle === window.handle && previous.visible));
      assert.ok(pipWindow, 'Identify only the native PiP window owned by this fixture process');
      const mainDisplay = screen.getDisplayMatching(mainWindow.getBounds());
      targetDisplay = screen.getAllDisplays().find(display => display.id !== mainDisplay.id) ?? mainDisplay;
      targetArea = screen.dipToScreenRect(null, targetDisplay.workArea);
      await runPowerShell('resizeWindow.ps1', [
        '-Handle', String(pipWindow.handle), '-Edge', '8',
        '-Left', String(targetArea.x + 24), '-Top', String(targetArea.y + 24),
        '-Width', String(pipWindow.width), '-Height', String(pipWindow.height),
        '-AreaLeft', String(targetArea.x), '-AreaTop', String(targetArea.y),
        '-AreaWidth', String(targetArea.width), '-AreaHeight', String(targetArea.height),
      ]);
    }
    mainWindow.minimize();
    await until('!!document.pictureInPictureElement', 'Manual PiP remains open while minimizing');
    if (pipWindow) {
      const minimized = (await ownedWindows()).find(window => window.handle === pipWindow.handle);
      assert.ok(minimized?.visible, 'The moved native PiP remains visible while its owner is minimized');
      assert.ok(minimized.x >= targetArea.x && minimized.x < targetArea.x + targetArea.width
        && minimized.y >= targetArea.y && minimized.y < targetArea.y + targetArea.height,
      'Minimization preserves the PiP monitor and position');
      console.log(`Owned native PiP stayed visible after moving to display ${targetDisplay.id} and minimizing its owner.`);
    }
    const manualFrames = await evaluate('document.pictureInPictureElement.getVideoPlaybackQuality().totalVideoFrames');
    await until(`document.pictureInPictureElement?.getVideoPlaybackQuality().totalVideoFrames > ${manualFrames + 3}`,
      'Minimized manual PiP keeps producing frames');
    mainWindow.restore(); mainWindow.focus();
    await until('document.hasFocus()', 'The manual PiP owner can regain focus');
    assert.equal(await evaluate('!!document.pictureInPictureElement'), true);
    await evaluate('document.exitPictureInPicture()');
    console.log('Native focus loss/return, production preload/IPC, real PiP and uninterrupted frames passed.');
    finish(0);
  }).catch(error => { console.error(error); finish(1); });
}
