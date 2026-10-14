const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('several screen shares are told apart by live previews before one is stopped or switched', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `share-chooser-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SHARE_CHOOSER_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_SHARE_CHOOSER_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Screen share chooser DOM timeout'); void finish(1); }, 90000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'share-chooser-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__share_chooser__') return next();
            response.setHeader('Content-Type', 'text/html');
            const fonts = ['@fontsource/inter/400.css', '@fontsource/inter/600.css', 'material-symbols/outlined.css']
              .map(name => `<link rel="stylesheet" href="/@fs/${require.resolve(name).replaceAll('\\', '/')}">`).join('');
            response.end(`<!doctype html><html><head>${fonts}<link rel="stylesheet" href="/styles/theme.css"></head>`
              + '<body><p id="outside" style="margin:24px">Elsewhere on the stage</p>'
              + '<button id="anchor" type="button" class="btn btn-danger" style="position:fixed;right:40px;bottom:24px">Stop sharing</button>'
              + '</body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 900, height: 640, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, true);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const waitFor = async (expression, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await frames();
      }
      return false;
    };
    const check = async (condition, message) => {
      if (!condition) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.chooserState()'))}`);
    };
    const press = async (keyCode) => {
      browser.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode === 'Return') browser.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      browser.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await frames();
    };
    const center = (selector) => evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`);
    // Real Chromium pointer input, the path a user's mouse takes.
    const clickAt = async (point) => {
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await frames();
    };
    const open = async (purpose) => {
      await evaluate(`window.openChooser(${JSON.stringify(purpose)})`);
      await check(await waitFor(`!!document.querySelector('.screen-share-chooser[role="menu"]:not([data-ui-closing])')`),
        `${purpose} opens the share menu`);
    };
    const result = (index) => evaluate(`JSON.stringify(window.chooserFixture.results[${index}])`);
    const closed = `!document.querySelector('.screen-share-chooser:not([data-ui-closing])')`;
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__share_chooser__`);
      browser.webContents.focus();
      const setup = await evaluate(`(${setupChooser.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // One live preview per share, above a trigger that sits at the bottom.
      await open('stop');
      const layout = await evaluate(`(() => {
        const surface = document.querySelector('.screen-share-chooser').getBoundingClientRect();
        const anchor = document.getElementById('anchor').getBoundingClientRect();
        return { surfaceBottom: surface.bottom, surfaceTop: surface.top, anchorTop: anchor.top, right: surface.right,
          width: document.documentElement.clientWidth };
      })()`);
      await check(layout.surfaceBottom <= layout.anchorTop && layout.surfaceTop >= 0 && layout.right <= layout.width,
        'The dropdown opens upward from a bottom control and stays on screen');
      await check(await evaluate(`(() => {
        const { first, second } = window.chooserFixture;
        const items = [...document.querySelectorAll('.screen-share-chooser [role="menuitem"]')];
        return items.length === 3 && items[0].dataset.shareId === first && items[1].dataset.shareId === second
          && items[2].classList.contains('screen-share-choice--all') && document.activeElement === items[0]
          && document.getElementById('anchor').getAttribute('aria-expanded') === 'true'
          && document.querySelector('.screen-share-chooser').getAttribute('aria-label') === 'Which screen should stop?';
      })()`), 'Each share and "stop all" are menu items, the first one focused');
      await check(await evaluate(`(() => {
        const items = [...document.querySelectorAll('.screen-share-chooser [data-share-id]')];
        const names = items.map(item => item.querySelector('.screen-share-choice-name').textContent);
        return names[0] === 'Main monitor' && names[1] === 'Game <b>Valorant</b>'
          && !document.querySelector('.screen-share-chooser b')
          && items[0].getAttribute('aria-label') === 'Stop Main monitor, With audio'
          && items[1].getAttribute('aria-label') === 'Stop Game <b>Valorant</b>, Without audio'
          && items[0].querySelector('.screen-share-choice-meta').hasAttribute('data-audio')
          && !items[1].querySelector('.screen-share-choice-meta').hasAttribute('data-audio');
      })()`), 'Names are plain text and the audio owner is marked');
      await check(await waitFor(`(() => {
        const { first, second, videoService } = window.chooserFixture;
        const videos = [first, second].map(id => document.querySelector('.screen-share-chooser [data-share-id="' + id + '"] video'));
        return videos.every((video, index) => video && video.srcObject === videoService.getScreenStream([first, second][index])
          && video.muted && !video.paused && video.videoWidth === 320);
      })()`, 6000), 'Each preview plays the live share it stands for');
      await check(await evaluate(`(() => {
        const surface = getComputedStyle(document.querySelector('.screen-share-chooser'));
        const name = getComputedStyle(document.querySelector('.screen-share-choice-name'));
        return surface.position === 'fixed' && surface.zIndex === '10000'
          && surface.backgroundColor === 'rgb(22, 27, 34)' && name.fontFamily === getComputedStyle(document.body).fontFamily;
      })()`), 'The dropdown uses the app surface, font and stacking');
      if (process.env.MONKY_SHARE_CHOOSER_SCREENSHOT) {
        await new Promise(resolve => setTimeout(resolve, 300));
        fs.writeFileSync(process.env.MONKY_SHARE_CHOOSER_SCREENSHOT, (await browser.webContents.capturePage()).toPNG());
      }

      // Real keyboard: arrows wrap, Home/End jump, Escape cancels back to the trigger.
      const focused = `document.activeElement?.dataset.shareId ?? (document.activeElement?.classList.contains('screen-share-choice--all') ? 'all' : document.activeElement?.id)`;
      const focusedIs = async (expected, message) => {
        const value = await evaluate(`(() => { const { first, second } = window.chooserFixture; return ${focused} === ${expected}; })()`);
        await check(value, message);
      };
      await press('Down');
      await focusedIs('second', 'ArrowDown moves to the next share');
      await press('End');
      await focusedIs("'all'", 'End reaches "stop all"');
      await press('Down');
      await focusedIs('first', 'ArrowDown wraps to the first share');
      await press('Up');
      await focusedIs("'all'", 'ArrowUp wraps to the last item');
      await press('Home');
      await focusedIs('first', 'Home returns to the first share');
      await press('Escape');
      await check(await waitFor(`window.chooserFixture.results[0] === null`), 'Escape resolves without a choice');
      await check(await evaluate(`[...document.querySelectorAll('.screen-share-chooser video')].every(video => video.srcObject === null)`),
        'Previews release the share streams at once, even while the box animates out');
      await check(await evaluate(`document.activeElement?.id === 'anchor' && document.getElementById('anchor').getAttribute('aria-expanded') === 'false'`),
        'Escape returns focus to the trigger');
      await check(await waitFor(closed), 'Escape closes the dropdown');

      // Picking with the mouse acts on that share only.
      await open('stop');
      await clickAt(await center('.screen-share-chooser:not([data-ui-closing]) [data-share-id]:nth-of-type(2)'));
      await check(await waitFor(`window.chooserFixture.results[1] !== undefined`), 'A click picks a share');
      await check(await result(1) === JSON.stringify({ shareId: await evaluate('window.chooserFixture.second') }),
        'The clicked share is the one chosen');
      await check(await waitFor(closed), 'Choosing closes the dropdown');

      // "Stop all" by keyboard.
      await open('stop');
      await press('End');
      await press('Return');
      await check(await waitFor(`window.chooserFixture.results[2] !== undefined`), 'Enter activates "stop all"');
      await check(await result(2) === JSON.stringify({ all: true }), '"Stop all" resolves every share');
      await check(await evaluate(`document.activeElement?.id === 'anchor'`), 'A keyboard choice returns focus to the trigger');

      // Pressing the trigger leaves toggling to it; any other click dismisses.
      await open('stop');
      const anchor = await center('#anchor');
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...anchor });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...anchor });
      await frames();
      await check(await evaluate(`!!document.querySelector('.screen-share-chooser:not([data-ui-closing])')
        && window.chooserFixture.screenShareChooser.isOpenFor(document.getElementById('anchor'))`), 'Pressing the trigger does not dismiss');
      await clickAt(await center('#outside'));
      await check(await waitFor(`window.chooserFixture.results[3] === null`), 'An outside click dismisses without a choice');
      await check(await waitFor(closed), 'An outside click closes the dropdown');

      // A list that no longer matches the live shares is retired.
      await open('stop');
      await evaluate(`window.chooserFixture.appEvents.emit('local.screen_stopped', window.chooserFixture.first)`);
      await check(await waitFor(`window.chooserFixture.results[4] === null`), 'A listed share ending dismisses the stale list');
      await check(await waitFor(closed), 'The stale list closes');

      // Switching offers the shares only, labelled as a swap.
      await open('switch');
      await check(await evaluate(`(() => {
        const surface = document.querySelector('.screen-share-chooser:not([data-ui-closing])');
        const first = surface.querySelector('[data-share-id]');
        return surface.getAttribute('aria-label') === 'Which screen should switch?'
          && !surface.querySelector('.screen-share-choice--all')
          && surface.querySelectorAll('[role="menuitem"]').length === 2
          && first.getAttribute('aria-label') === 'Switch the source of Main monitor, With audio'
          && first.querySelector('.screen-share-choice-action').textContent === 'swap_horiz';
      })()`), 'Switching lists each share with a swap action and no "stop all"');
      await press('Escape');
      await check(await waitFor(`window.chooserFixture.results[5] === null`), 'Escape cancels the switch choice');

      // A single share needs no question, and an id without a live capture never turns stop into a no-op.
      await check(await evaluate(`(async () => {
        const { voiceStore, chooseSharesToStop, second } = window.chooserFixture;
        voiceStore.removeScreenShare(second);
        voiceStore.addScreenShare('share-without-capture');
        const selection = await chooseSharesToStop(document.getElementById('anchor'));
        return voiceStore.screenShareIds.length === 2 && JSON.stringify(selection) === JSON.stringify({ all: true })
          && !document.querySelector('.screen-share-chooser:not([data-ui-closing])');
      })()`), 'With one live share the stop control acts at once');
      await evaluate('window.chooserFixture.cleanup()');
      console.log('Screen share chooser DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupChooser() {
  localStorage.clear();
  const [chooser, { videoService }, { voiceStore }, { appEvents }, i18n] = await Promise.all([
    import('/views/ScreenShareChooser.ts'), import('/core/VideoService.ts'), import('/stores/voiceStore.ts'),
    import('/core/EventBus.ts'), import('/i18n/index.ts'),
  ]);
  i18n.setLanguage('en');
  const painters = [];
  const tracks = [];
  // A moving square keeps real frames flowing into each fake capture.
  const share = (color, label, desktopSourceId, captureKind) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    let frame = 0;
    const paint = () => {
      context.fillStyle = color;
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#ffffff';
      context.fillRect((frame++ * 9) % 300, 80, 20, 20);
    };
    paint();
    painters.push(setInterval(paint, 50));
    const track = canvas.captureStream(20).getVideoTracks()[0];
    tracks.push(track);
    // Same shape as a native share: a descriptor stream that later receives its preview track.
    const descriptor = new MediaStream();
    videoService.registerNativeScreenShare(descriptor, {
      source: { shareId: descriptor.id, instanceId: crypto.randomUUID(), video: { width: 320, height: 180, fps: 20, maxBitrateKbps: 1000 }, audio: false },
      desktopSourceId, captureKind, audioBitrateKbps: 128,
    });
    descriptor.addTrack(track);
    voiceStore.addScreenShare(descriptor.id);
    videoService.setScreenShareLabel(descriptor.id, label);
    return descriptor.id;
  };
  const first = share('#c0392b', 'Main monitor', 'native-monitor:1', 'monitor');
  const second = share('#2471a3', 'Game <b>Valorant</b>', 'window:7:0', 'game');
  voiceStore.setScreenAudioShare(first);
  const results = [];
  window.chooserFixture = {
    ...chooser, videoService, voiceStore, appEvents, first, second, results,
    cleanup() {
      painters.forEach(clearInterval);
      tracks.forEach(track => track.stop());
    },
  };
  window.openChooser = (purpose) => {
    const index = results.length;
    results.push(undefined);
    void chooser.screenShareChooser.choose(document.getElementById('anchor'), purpose).then(value => { results[index] = value; });
  };
  window.chooserState = () => ({
    results,
    open: !!document.querySelector('.screen-share-chooser:not([data-ui-closing])'),
    active: document.activeElement?.outerHTML.slice(0, 160),
    html: document.querySelector('.screen-share-chooser')?.outerHTML.slice(0, 600) ?? null,
  });
}
