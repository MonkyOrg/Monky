const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Covering the window with another process needs a desktop the runner may not offer: opt in locally.
const withOcclusion = process.argv.includes('--occlusion');

if (!process.versions.electron) {
  require('node:test')('Compositor refresh resets Chromium frame metrics only while the window is out of sight', {
    timeout: 90000, skip: process.platform !== 'win32' && 'The compositor refresh only runs on Windows.',
  }, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-compositor-refresh-'));
    const env = { ...process.env, MONKY_COMPOSITOR_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, ...(withOcclusion ? ['--occlusion'] : [])],
          { cwd: root, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow, contentTracing, screen } = require('electron');
  const { bindCompositorRefresh } = require(path.join(root, 'dist-electron', 'main', 'compositorRefresh.js'));
  app.setPath('userData', process.env.MONKY_COMPOSITOR_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  const tracePath = path.join(process.env.MONKY_COMPOSITOR_TEST_PROFILE, 'trace.json');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let deadline;
  const finish = code => {
    clearTimeout(deadline);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(code);
  };
  const page = `<!doctype html><body style="margin:0;background:#0e1117">
<div style="width:48px;height:48px;background:#f80;animation:spin 1s linear infinite"></div>
<style>@keyframes spin{to{transform:rotate(360deg)}}</style>
<script>
window.visibilityLog = [];
document.addEventListener('visibilitychange', () => visibilityLog.push(document.visibilityState));
window.rates = () => new Promise(resolve => {
  let frames = 0, timers = 0; const start = performance.now();
  const frame = () => { frames++; if (performance.now() - start < 1000) requestAnimationFrame(frame); };
  const timer = () => { timers++; if (performance.now() - start < 1000) setTimeout(timer, 10); };
  requestAnimationFrame(frame); setTimeout(timer, 10);
  setTimeout(() => resolve({ frames, timers }), 1100);
});
</script></body>`;

  async function waitFor(predicate, what, timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  // LayerTreeHostImpl::SetVisible(true) only starts a visibility slice after the compositor
  // went invisible, which is exactly when cc::FrameSorter::Reset runs.
  async function compositorResets(window, action) {
    await contentTracing.startRecording({ included_categories: ['cc', 'benchmark', '__metadata'], excluded_categories: ['*'] });
    await sleep(300);
    await action();
    await sleep(500);
    await contentTracing.stopRecording(tracePath);
    const raw = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const pid = window.webContents.getOSProcessId();
    return (Array.isArray(raw) ? raw : raw.traceEvents)
      .filter(event => event.pid === pid && event.name === 'LayerTreeHostImpl::SetVisible' && /[bB]/.test(event.ph)).length;
  }

  app.whenReady().then(async () => {
    deadline = setTimeout(() => { console.error('Compositor refresh smoke timeout'); finish(1); }, 80000);
    const { workArea } = screen.getPrimaryDisplay();
    // Always on top so "visible" really means visible on a busy desktop. The local occlusion run
    // cannot use it: Chromium stops tracking occlusion for a window that has been always on top.
    const window = new BrowserWindow({ title: 'Monky QA - compositor refresh', show: false, width: 360, height: 220,
      x: workArea.x + workArea.width - 400, y: workArea.y + workArea.height - 260, alwaysOnTop: !withOcclusion,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const contents = window.webContents;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    let captures = 0;
    const capturePage = contents.capturePage.bind(contents);
    contents.capturePage = (...args) => { captures++; return capturePage(...args); };
    window.showInactive();
    await sleep(1500);
    assert.equal(window.isFocused(), false, 'The smoke drives the window the way an unfocused Monky is left behind.');
    const errors = [];
    const dispose = bindCompositorRefresh(window, { intervalMs: 10 * 60_000, onError: error => errors.push(error) });
    const settled = async (count) => {
      await waitFor(() => captures >= count, `capture ${count}`);
      await waitFor(() => !contents.getBackgroundThrottling(), 'throttling restored');
    };

    // A window the user can see: nothing may change, not even page visibility.
    const visibleResets = await compositorResets(window, async () => { window.emit('blur'); await settled(1); });
    assert.equal(visibleResets, 0, 'A visible window must not lose its compositor.');
    assert.deepEqual(await contents.executeJavaScript('visibilityLog'), []);
    const visibleRates = await contents.executeJavaScript('rates()');
    assert.ok(visibleRates.frames >= 20 && visibleRates.timers >= 40, JSON.stringify(visibleRates));

    // Minimized: the stalled frame metrics are reset, painting and timers keep running.
    const minimizedResets = await compositorResets(window, async () => { window.minimize(); await settled(2); });
    assert.ok(minimizedResets >= 1, 'Minimizing must reset the compositor frame metrics.');
    assert.equal(contents.getBackgroundThrottling(), false);
    assert.ok((await contents.executeJavaScript('rates()')).timers >= 40, 'Timers stay unthrottled after the refresh.');
    window.showInactive();
    await waitFor(() => !window.isMinimized(), 'restore');
    await sleep(800);
    assert.equal(await contents.executeJavaScript('document.visibilityState'), 'visible');
    const restoredRates = await contents.executeJavaScript('rates()');
    assert.ok(restoredRates.frames >= 20 && restoredRates.timers >= 40, JSON.stringify(restoredRates));

    // Hidden in the tray: a capture would only complete once shown, so nothing runs.
    window.hide();
    window.emit('blur');
    await sleep(2500);
    assert.equal(captures, 2, 'A tray-hidden window must not be refreshed.');
    assert.equal(contents.getBackgroundThrottling(), false);
    window.showInactive();
    await sleep(800);

    if (withOcclusion) {
      const bounds = window.getBounds();
      const cover = path.join(process.env.MONKY_COMPOSITOR_TEST_PROFILE, 'cover.ps1');
      fs.writeFileSync(cover, `param([int]$x,[int]$y,[int]$w,[int]$h)
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.TopMost = $true; $f.ShowInTaskbar = $false
$f.Bounds = New-Object System.Drawing.Rectangle($x,$y,$w,$h)
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 7000; $t.Add_Tick({ $f.Close() }); $t.Start()
[void]$f.ShowDialog()`);
      const coverWindow = spawn('powershell', ['-NoProfile', '-File', cover,
        String(bounds.x - 20), String(bounds.y - 20), String(bounds.width + 40), String(bounds.height + 40)]);
      const covered = new Promise(resolve => coverWindow.once('exit', resolve));
      await sleep(2500);
      const occludedResets = await compositorResets(window, async () => { window.emit('blur'); await settled(3); });
      assert.ok(occludedResets >= 1, 'A window covered by another app must reset the compositor frame metrics.');
      assert.ok((await contents.executeJavaScript('rates()')).frames >= 20, 'A covered window keeps painting after the refresh.');
      await covered;
      await sleep(800);
      assert.equal(await contents.executeJavaScript('document.visibilityState'), 'visible');
    }

    dispose();
    assert.deepEqual(errors, []);
    console.log('Compositor refresh smoke passed.');
    finish(0);
  }).catch(error => {
    console.error(error);
    finish(1);
  });
}
