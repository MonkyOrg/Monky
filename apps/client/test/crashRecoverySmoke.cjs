const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { compileRecovery, client } = require('./crashRecoveryFixture.cjs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

if (process.versions.electron) {
  const { app, BrowserWindow, clipboard, dialog, shell } = require('electron');
  const root = process.env.MONKY_CRASH_SMOKE_ROOT;
  assert.ok(root && path.dirname(root) === client, 'Every smoke artifact must stay inside this checkout');
  const profile = path.join(root, 'profile');
  for (const folder of [profile, path.join(root, 'crashes'), path.join(root, 'logs')]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  app.setName('Monky Crash Recovery Fixture');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setPath('crashDumps', path.join(root, 'crashes'));
  app.setAppLogsPath(path.join(root, 'logs'));
  process.env.MONKY_HOME = path.join(profile, 'cli');
  app.disableHardwareAcceleration();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', (_event, _preload, error) => console.error('[fixture preload]', error));
    contents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.error('[fixture renderer]', message);
    });
  });
  app.on('window-all-closed', () => {});
  const fail = (error) => {
    fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: error.stack ?? String(error), pid: process.pid }));
    app.exit(1);
  };
  if (!app.requestSingleInstanceLock()) {
    fail(new Error('The isolated fixture could not acquire its own profile lock'));
  } else if (process.argv.includes('--crash-smoke-reopened')) {
    app.whenReady().then(() => {
      fs.writeFileSync(path.join(root, 'reopened.json'), JSON.stringify({
        pid: process.pid, profile: app.getPath('userData'), home: process.env.MONKY_HOME,
      }));
      app.exit(0);
    }).catch(fail);
  } else {
    const bootstrapScript = compileRecovery(path.join(root, 'compiled'));
    const { CrashRecovery } = require(path.join(root, 'compiled', 'main', 'crashRecovery.js'));
    const { initializeMainLanguage, setMainLanguage } = require(path.join(root, 'compiled', 'main', 'i18n.js'));
    const { BUG_REPORT_URL } = require(path.join(root, 'compiled', 'shared'));
    const checks = [];
    const opened = [];
    const copied = [];
    const nativeDialogs = [];
    const diagnostics = [];
    let relaunches = 0;
    let allowRelaunch = false;
    const realRelaunch = app.relaunch.bind(app);
    app.relaunch = () => {
      relaunches++;
      assert.ok(allowRelaunch, 'Only the final, explicit fixture action may relaunch');
      realRelaunch({ args: [...process.argv.slice(1), '--crash-smoke-reopened'] });
    };
    // Never launch the user's browser or replace the user's clipboard in tests.
    shell.openExternal = async (url) => { opened.push(url); };
    clipboard.writeText = async (text) => { copied.push(text); };
    dialog.showMessageBox = (options) => new Promise(resolve => nativeDialogs.push({ options, resolve }));
    dialog.showErrorBox = (...args) => { throw new Error(`Unexpected native failure: ${JSON.stringify(args)}`); };

    async function start(language, quitApp = false) {
      setMainLanguage(language);
      let quitting = false;
      let quitRequests = 0;
      const recovery = new CrashRecovery({
        logger: () => ({ write: (entry) => diagnostics.push(entry) }),
        isQuitting: () => quitting,
        onRecovery() {},
        quit: () => {
          quitRequests++;
          quitting = true;
          if (quitApp) {
            recovery.dispose();
            app.quit();
          }
        },
      });
      const main = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(root, 'compiled', 'preload', 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        },
      });
      recovery.watch(main);
      await main.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><div id="fixture">Startup fixture</div></body></html>',
      ));
      return {
        recovery, main, quitRequests: () => quitRequests,
        dispose: () => { recovery.dispose(); if (!main.isDestroyed()) main.destroy(); },
      };
    }

    async function recoveryWindow(fixture, language) {
      const window = await until(() => BrowserWindow.getAllWindows().find(candidate => candidate !== fixture.main), 'independent recovery window');
      await until(async () => {
        if (window.isDestroyed() || window.webContents.isLoading()) return false;
        return window.webContents.executeJavaScript('!!document.getElementById("recovery-report")');
      }, 'recovery page DOM');
      await until(() => window.isVisible(), 'recovery preload readiness');
      const state = await window.webContents.executeJavaScript(`({
        language: document.documentElement.lang,
        title: document.getElementById('recovery-title').textContent,
        report: document.getElementById('recovery-report').textContent.trim(),
        reopen: document.getElementById('recovery-reopen').textContent.trim(),
        statusRole: document.getElementById('recovery-status').getAttribute('role'),
        details: !!document.querySelector('details > summary'),
        node: typeof process, require: typeof require, originalApi: typeof window.api
      })`);
      assert.equal(state.language, language);
      assert.equal(state.reopen, language === 'en' ? 'Reopen Monky' : 'Reabrir Monky');
      assert.equal(state.report, language === 'en' ? 'Report a bug' : 'Reportar bug');
      assert.equal(state.statusRole, 'status');
      assert.equal(state.details, true);
      assert.equal(state.node, 'undefined');
      assert.equal(state.require, 'undefined');
      assert.equal(state.originalApi, 'undefined', 'no general-purpose IPC bridge in the recovery page');
      return window;
    }

    async function appearance(window) {
      const size = window.getContentSize();
      for (const [width, height] of [size, [440, 500]]) {
        window.setContentSize(width, height);
        await until(async () => window.webContents.executeJavaScript(`innerWidth === ${width} && innerHeight === ${height}`), 'recovery viewport');
        const layout = await window.webContents.executeJavaScript(`(async () => {
          await document.fonts.ready;
          const mascot = document.querySelector('.mascot');
          const title = document.getElementById('recovery-title');
          const card = document.querySelector('main');
          const titlebar = document.querySelector('.titlebar');
          const withinWidth = [...document.querySelectorAll('main, .actions, .btn, details, pre')].every(element =>
            element.clientWidth === 0 || element.scrollWidth <= element.clientWidth + 1);
          return {
            mascot: mascot instanceof SVGElement,
            decorative: mascot.getAttribute('aria-hidden'),
            monochrome: getComputedStyle(mascot).color,
            titleSize: getComputedStyle(title).fontSize,
            titleAlignment: getComputedStyle(title).textAlign,
            buttonWeight: getComputedStyle(document.getElementById('recovery-report')).fontWeight,
            cardPadding: getComputedStyle(card).padding,
            titlebarBackground: getComputedStyle(titlebar).backgroundColor,
            titlebarHeight: titlebar.getBoundingClientRect().height,
            drag: getComputedStyle(titlebar).getPropertyValue('-webkit-app-region'),
            fonts: [...document.fonts].filter(face => face.family === 'Inter' && face.status === 'loaded').map(face => face.weight),
            withinWidth,
            withinHeight: card.getBoundingClientRect().top >= titlebar.getBoundingClientRect().bottom
              && card.getBoundingClientRect().bottom <= innerHeight
          };
        })()`);
        assert.equal(layout.mascot, true);
        assert.equal(layout.decorative, 'true');
        assert.equal(layout.monochrome, 'rgb(101, 109, 118)');
        assert.equal(layout.titleSize, '18px');
        assert.equal(layout.titleAlignment, 'start');
        assert.equal(layout.buttonWeight, '500');
        assert.equal(layout.cardPadding, width <= 520 ? '20px' : '24px');
        assert.equal(layout.titlebarBackground, 'rgb(17, 21, 28)');
        assert.equal(layout.titlebarHeight, 32);
        assert.equal(layout.drag, 'drag');
        assert.deepEqual(layout.fonts.sort(), ['400', '500', '600', '700']);
        assert.equal(layout.withinWidth, true, 'no horizontal clipping at supported window sizes');
        assert.equal(layout.withinHeight, true, 'the card scrolls instead of escaping the window');
        const expanded = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('details').open = true;
          const copy = document.getElementById('recovery-copy');
          copy.focus();
          copy.scrollIntoView({ block: 'nearest' });
          await document.fonts.ready;
          const bounds = copy.getBoundingClientRect();
          const card = document.querySelector('main').getBoundingClientRect();
          const diagnostic = document.getElementById('recovery-diagnostic');
          return {
            reachable: bounds.top >= card.top && bounds.bottom <= card.bottom,
            monoFont: [...document.fonts].some(face => face.family.replaceAll('"', '') === 'JetBrains Mono' && face.status === 'loaded'),
            selectable: getComputedStyle(diagnostic).userSelect,
            wraps: diagnostic.scrollWidth <= diagnostic.clientWidth + 1
          };
        })()`);
        assert.equal(expanded.reachable, true);
        assert.equal(expanded.monoFont, true);
        assert.equal(expanded.selectable, 'text');
        assert.equal(expanded.wraps, true);
        await window.webContents.executeJavaScript("document.querySelector('details').open = false; document.querySelector('main').scrollTop = 0;");
      }
      window.setContentSize(...size);
      await until(async () => window.webContents.executeJavaScript(`innerWidth === ${size[0]} && innerHeight === ${size[1]}`), 'restored recovery viewport');
      checks.push('monochrome vector, real bundled fonts, app-style layout and reachable diagnostic at normal and minimum size');
    }

    async function report(window) {
      const count = opened.length;
      await window.webContents.executeJavaScript("document.getElementById('recovery-report').click()");
      await until(() => opened.length === count + 1, 'report action');
      await until(async () => window.webContents.executeJavaScript("!document.getElementById('recovery-report').disabled"), 'report completion');
      const url = new URL(opened.at(-1));
      const normal = new URL(BUG_REPORT_URL);
      assert.equal(url.origin + url.pathname, normal.origin + normal.pathname);
      assert.equal(url.searchParams.get('category'), 'bug-reports');
      assert.equal(url.href, BUG_REPORT_URL);
      assert.match(copied.at(-1), /Incident:/);
      assert.ok(opened.at(-1).length <= 2000);
      assert.equal(relaunches, 0);
      assert.equal(window.isDestroyed(), false);
    }

    app.whenReady().then(async () => {
      initializeMainLanguage(profile, ['en-US']);
      const renderer = await start('en');
      await renderer.main.webContents.executeJavaScript('window.api.signalRendererReady(); Promise.reject(new Error("ordinary recoverable fixture rejection")); undefined;');
      await sleep(200);
      assert.equal(renderer.recovery.isActive(), false);
      checks.push('ordinary runtime rejection does not trigger recovery');
      renderer.main.webContents.forcefullyCrashRenderer();
      const recovered = await recoveryWindow(renderer, 'en');
      await appearance(recovered);
      assert.equal(renderer.main.isDestroyed(), true);
      assert.equal(opened.length + copied.length + relaunches, 0);
      assert.equal(diagnostics.at(-1).data.kind, 'renderer-gone');
      await report(recovered);
      checks.push('real render-process-gone, independent isolated renderer, accessible English page, consent-only report');
      await recovered.webContents.executeJavaScript("document.getElementById('recovery-close').click()");
      await until(() => renderer.quitRequests() === 1, 'explicit close');
      renderer.dispose();

      for (const phase of ['constructor', 'initialization']) {
        const bootstrap = await start('pt-BR');
        const script = `(() => {
          const exports = {};
          ${bootstrapScript}
          return exports.runFatalBootstrap(${phase === 'initialization' ? 'async ' : ''}() => {
            const error = new TypeError('token=private-fixture-token');
            error.stack = 'TypeError: token=private-fixture-token\\n    at bootstrap (file:///C:/Users/PrivateUser/Monky/assets/index-fixture.js:23:7)';
            throw error;
          }, ${JSON.stringify(phase)});
        })()`;
        void bootstrap.main.webContents.executeJavaScript(script).catch(() => {});
        const window = await recoveryWindow(bootstrap, 'pt-BR');
        if (phase === 'constructor') await appearance(window);
        const data = diagnostics.at(-1).data;
        assert.equal(data.kind, 'renderer-bootstrap');
        assert.equal(data.reason, phase);
        assert.equal(JSON.stringify(data).includes('private-fixture-token'), false);
        assert.equal(JSON.stringify(data).includes('PrivateUser'), false);
        assert.match(await window.webContents.executeJavaScript("document.getElementById('recovery-diagnostic').textContent"), /index-fixture\.js:23:7/);
        checks.push(`fatal ${phase} boundary and Portuguese recovery without private error text`);
        bootstrap.dispose();
      }

      const fallback = await start('en');
      fallback.main.webContents.forcefullyCrashRenderer();
      const doomed = await recoveryWindow(fallback, 'en');
      doomed.webContents.forcefullyCrashRenderer();
      await until(() => nativeDialogs.length === 1, 'native fallback after recovery renderer crash');
      assert.equal(nativeDialogs[0].options.buttons[0], 'Report a bug');
      assert.equal(relaunches, 0);
      nativeDialogs[0].resolve({ response: 2 });
      await until(() => fallback.quitRequests() === 1, 'native fallback close');
      fallback.dispose();
      checks.push('recovery-renderer crash falls back to one native dialog, without reload/relaunch loop');

      const restart = await start('en', true);
      restart.main.webContents.forcefullyCrashRenderer();
      const final = await recoveryWindow(restart, 'en');
      assert.equal(relaunches, 0);
      checks.push('relaunch is requested only after clicking Reopen Monky');
      fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ checks, originalPid: process.pid, profile }));
      allowRelaunch = true;
      void final.webContents.executeJavaScript("document.getElementById('recovery-reopen').click()").catch(() => {});
    }).catch(fail);
  }
} else {
  const test = require('node:test');
  test('Electron: fatal renderer/bootstrap, report, fallback and real relaunch stay in a disposable profile', {
    timeout: 100000,
  }, async (t) => {
    const root = path.join(client, `.crash-recovery-smoke-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    const env = { ...process.env, MONKY_CRASH_SMOKE_ROOT: root, MONKY_HOME: path.join(root, 'profile', 'cli') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, `--user-data-dir=${path.join(root, 'profile')}`], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const log = chunk => { output = (output + chunk.toString()).slice(-14000); };
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    let reopenedPid = null;
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      if (reopenedPid) {
        try { process.kill(reopenedPid, 0); process.kill(reopenedPid); } catch { /* Already exited. */ }
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    const deadline = setTimeout(() => { child.kill(); }, 80000);
    let code;
    try { [code] = await once(child, 'exit'); } finally { clearTimeout(deadline); }
    const failure = path.join(root, 'failure.json');
    assert.equal(code, 0, `${fs.existsSync(failure) ? fs.readFileSync(failure, 'utf8') : 'Electron failed'}\n${output}`);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
    const restarted = await until(() => {
      assert.equal(fs.existsSync(failure), false, fs.existsSync(failure) ? fs.readFileSync(failure, 'utf8') : '');
      const file = path.join(root, 'reopened.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    }, 'actual relaunch completion');
    reopenedPid = restarted.pid;
    assert.notEqual(restarted.pid, result.originalPid);
    assert.equal(restarted.profile, result.profile);
    assert.equal(restarted.home, path.join(result.profile, 'cli'));
    await until(() => {
      try { process.kill(reopenedPid, 0); return false; } catch { return true; }
    }, 'reopened fixture exits');
    reopenedPid = null;
    for (const check of result.checks) t.diagnostic(check);
    t.diagnostic('real app.relaunch completed in a new PID using the same isolated profile and MONKY_HOME');
  });
}
