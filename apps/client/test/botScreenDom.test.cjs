const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('voice-stage miniapps are opt-in, session-bound and preserve opaque frames across live UI updates', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `screen-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SCREEN_PROFILE: profile };
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
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { SHORTCUT_IPC } = require('@monky/shared');
  const { bindBotScreenIsolation, installBotScreenRequestGuard } = require('../dist-electron/main/botScreenIsolation.js');
  app.setPath('userData', process.env.MONKY_SCREEN_PROFILE);
  let vite;
  let timeout;
  let leaks = 0;
  let popups = 0;
  const windows = [];
  const nativeErrors = [];
  const owns = event => windows.some(window => !window.isDestroyed()
    && window.webContents === event.sender && event.senderFrame === event.sender.mainFrame);
  ipcMain.handle(SHORTCUT_IPC.setPttConfig, event => owns(event));
  ipcMain.handle('app:set-language', event => owns(event));
  ipcMain.handle('server-host:status', event => owns(event) ? { isRunning: false, port: null, serverId: null } : null);
  ipcMain.handle('client-log:write', (event, entry) => {
    if (owns(event) && entry.level === 'ERROR') nativeErrors.push(entry.message);
  });
  const finish = async (code) => {
    clearTimeout(timeout);
    for (const window of windows) {
      if (!window.isDestroyed()) {
        if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
        window.destroy();
      }
    }
    if (vite) await vite.close();
    app.exit(code);
  };
  const waitFor = async (check, description) => {
    for (let i = 0; i < 250; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${description}`);
  };
  const run = (window, script) => window.webContents.executeJavaScript(script, true);
  const frames = (window) => window.webContents.mainFrame.frames.filter((frame) => frame.url.startsWith('about:srcdoc'));
  const gameFrame = async (window, id = 'game') => {
    for (const frame of frames(window)) if (await frame.executeJavaScript('window.gameId') === id) return frame;
    return undefined;
  };

  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      resolve: { alias: { '@monky/shared': path.resolve(clientRoot, '..', '..', 'packages', 'shared', 'dist', 'index.js') } },
      optimizeDeps: { include: ['@monky/shared'] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'voice-screen-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url.startsWith('/__leak')) { leaks++; response.end('blocked'); return; }
            if (request.url !== '/__screens__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/footerControls.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const url = `http://127.0.0.1:${http.address().port}/__screens__`;
    const leak = `http://127.0.0.1:${http.address().port}/__leak`;
    timeout = setTimeout(() => { console.error('Voice screen DOM regression timed out'); void finish(1); }, 100000);
    for (const [id, locale] of [['alice', 'pt-BR'], ['spectator', 'en']]) {
      const window = new BrowserWindow({
        show: false, width: 1280, height: 1000,
        webPreferences: {
          contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
          sandbox: false, backgroundThrottling: false, offscreen: true,
          partition: `voice-screen-${id}`,
          preload: path.join(clientRoot, 'dist-electron', 'preload', 'preload.js'),
        },
      });
      windows.push(window);
      bindBotScreenIsolation(window.webContents);
      installBotScreenRequestGuard(window.webContents.session);
      window.webContents.setWindowOpenHandler(() => { popups++; return { action: 'deny' }; });
      await window.loadURL(url);
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await run(window, `(${setupVoiceStage.toString()})(${JSON.stringify(id)},${JSON.stringify(locale)})`);
      assert.equal(frames(window).length, 0);
      assert.equal(await run(window, 'window.screenFixture.listRequests()'), 0);
      assert.equal(await run(window, '!!document.querySelector("#chat-bot-screens, .bot-screen-cards, .bot-screen-card")'), false);
      await run(window, 'window.screenFixture.join("voice")');
      await waitFor(async () => await run(window, 'document.querySelectorAll("[data-watch-bot-screen]").length === 4'), 'four separate voice invitations');
      assert.equal(frames(window).length, 0, 'Receiving an invitation must never execute a miniapp');
      assert.equal(await run(window, '!!document.querySelector("#screenshare-notice-slot .bot-screen-invitation")'), true);
      assert.equal(await run(window, '!!document.querySelector("#screenshare-notice-btn")'), true, 'remote screen invitation survives');
    }
    const [aliceWindow, spectatorWindow] = windows;
    await run(aliceWindow, 'window.screenFixture.selfShare(); document.querySelector("#screenshare-self-stop-btn").click()');
    await waitFor(async () => await run(aliceWindow, '!window.screenFixture.isSelfSharing()'), 'self screen-share stop');
    assert.equal(await run(aliceWindow, 'window.screenFixture.sent.some(entry => entry.type === "VOICE_STATE_UPDATE" && entry.payload.isScreenSharing === false)'), true);
    await run(aliceWindow, 'document.querySelector("#screenshare-notice-btn").click()');
    assert.equal(await run(aliceWindow, '!!document.querySelector("#stage-participants-area .stage-focused-main[data-kind=screen]") && !document.querySelector("#stage-participants-area [data-kind=screen] .screen-locked")'), true);
    assert.equal(frames(aliceWindow).length, 0, 'Watching a screen does not opt into miniapps');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-bot-screen-id]").length'), 4, 'Every room miniapp has a persistent stage tile before opt-in');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("#stage-participants-area [data-bot-screen-slot]").length'), 4, 'Miniapps participate in the ordinary stage filmstrip');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").textContent.includes("Abrir miniapp")'), true);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game"'), 'closed tile fullscreen');
    assert.equal(frames(aliceWindow).length, 0, 'Fullscreen is layout only and never opens a closed miniapp');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement'), 'closed tile fullscreen exit');
    await run(aliceWindow, 'window.savedGameInvitation = document.querySelector("[data-watch-bot-screen=game]"); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").click()');
    await waitFor(() => frames(aliceWindow).length === 1, 'ordinary tile opt-in');
    assert.equal(await run(aliceWindow, '!!document.querySelector("#stage-participants-area .stage-focused-main[data-kind=screen]")'), true, 'Ordinary Open does not replace screen focus');
    await run(aliceWindow, 'window.savedGameInvitation.click(); window.savedGameInvitation.click(); delete window.savedGameInvitation');
    await run(spectatorWindow, 'document.querySelector("[data-watch-bot-screen=game]").click()');
    for (const window of windows) await waitFor(() => frames(window).length === 1, 'opted-in stage frame');
    let alice = await gameFrame(aliceWindow);
    let spectator = await gameFrame(spectatorWindow);
    await waitFor(async () => await alice.executeJavaScript('document.querySelector("#state")?.textContent === "0"'), 'game bootstrap');
    for (const window of windows) {
      assert.equal(await run(window, '!!document.querySelector(".voice-stage-container #stage-content-area .stage-bot-screen-card iframe")'), true);
      assert.equal(await run(window, 'document.querySelectorAll("[data-watch-bot-screen]").length'), 3);
      assert.equal(await run(window, '!!document.querySelector("#stage-participants-area [data-kind=camera]") && !!document.querySelector("#stage-participants-area [data-kind=screen]")'), true);
      assert.equal(await run(window, 'document.querySelectorAll("#stage-participants-area .stage-focused-main").length === 1 && !!document.querySelector("#stage-participants-area .stage-focused-main[data-bot-screen-slot=game]")'), true, 'An invitation opens an already-focused miniapp, including an already-open view');
      assert.equal(await run(window, '!!document.querySelector("[data-kind=miniapp] .stage-focus-hint-badge")'), false, 'Miniapps never carry the generic camera/screen focus overlay');
    }
    const safety = await alice.executeJavaScript(`(async () => {
      let parentBlocked = false, storageBlocked = false, nestedBlocked = false, fetchBlocked = false;
      try { void parent.document.body; } catch { parentBlocked = true; }
      try { localStorage.setItem('credential', 'bad'); } catch { storageBlocked = true; }
      const child = document.createElement('iframe'); document.body.append(child);
      try { void child.contentWindow.RTCPeerConnection; } catch { nestedBlocked = true; } child.remove();
      try { await fetch(${JSON.stringify(leak)}); } catch { fetchBlocked = true; }
      return { parentBlocked, storageBlocked, nestedBlocked, fetchBlocked, api: typeof window.api,
        node: typeof require, process: typeof process, rtc: typeof RTCPeerConnection,
        transport: typeof WebTransport, viewer: monkyScreen.viewer.id };
    })()`);
    assert.deepEqual(safety, {
      parentBlocked: true, storageBlocked: true, nestedBlocked: true, fetchBlocked: true,
      api: 'undefined', node: 'undefined', process: 'undefined', rtc: 'undefined', transport: 'undefined', viewer: 'alice',
    });
    assert.equal(await run(aliceWindow, 'typeof window.api'), 'object');
    await alice.executeJavaScript('monkyScreen.sendAction("move", {cell: 1})');
    await waitFor(async () => await alice.executeJavaScript('document.querySelector("#state").textContent === "1"'), 'player action');
    const shared = await run(aliceWindow, 'window.screenFixture.snapshot()');
    await run(spectatorWindow, `window.screenFixture.receive(${JSON.stringify(shared)})`);
    await waitFor(async () => await spectator.executeJavaScript('document.querySelector("#state").textContent === "1"'), 'spectator state');
    await spectator.executeJavaScript('monkyScreen.sendAction("move", {cell: 2})');
    await waitFor(async () => await run(spectatorWindow, 'window.screenFixture.actions.length === 1'), 'spectator request');
    assert.equal(await spectator.executeJavaScript('document.querySelector("#state").textContent'), '1');
    assert.deepEqual(await spectator.executeJavaScript('window.lastState.players'), ['alice', 'bob']);

    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=second]").click()');
    await waitFor(() => frames(aliceWindow).length === 2, 'second app opt-in without opening other apps');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("#stage-participants-area .stage-focused-main").length === 1 && !!document.querySelector("#stage-participants-area .stage-focused-main[data-bot-screen-slot=second]")'), true, 'Choosing another invitation focuses only that miniapp');
    await run(aliceWindow, 'document.querySelector("#stage-participants-area [data-kind=screen] .stage-stopwatch-btn").click()');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-kind=screen] .screen-locked") && !!document.querySelector(".stage-focused-main[data-bot-screen-slot=second]")'), true, 'Stopping an unfocused share applies its gate without changing miniapp focus');
    await run(aliceWindow, 'document.querySelector("#stage-participants-area [data-kind=screen] .stage-watch-btn").click()');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".stage-focused-main[data-kind=screen]") && !document.querySelector("[data-kind=screen] .screen-locked")'), true, 'Screen watch controls still apply media changes independently of miniapp viewing');
    const before = await alice.executeJavaScript('({token: window.gameToken, state: window.lastState, revision: window.lastRevision})');
    const englishBefore = await spectator.executeJavaScript('({token: window.gameToken, renders: window.renders})');
    await run(aliceWindow, 'window.screenFixture.redraw(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").focus()');
    aliceWindow.webContents.focus();
    assert.equal(await run(aliceWindow, 'document.activeElement?.dataset.botScreenAction'), 'focus');
    await aliceWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
    });
    await aliceWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    });
    await waitFor(async () => await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").getAttribute("aria-pressed") === "true"'), 'keyboard focus control');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("#stage-participants-area .stage-focused-stack--split > .stage-focused-main").length'), 2, 'A miniapp shares normal split focus with the screen');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".stage-focused-main[data-kind=screen] .stage-focus-hint-badge") && !document.querySelector(".stage-focused-main[data-kind=miniapp] .stage-focus-hint-badge")'), true, 'Shared focus preserves the screen hint without overlaying the miniapp toolbar');
    assert.equal(await run(aliceWindow, `(() => {
      const tile = document.querySelector('[data-bot-screen-id=game]').getBoundingClientRect();
      const slot = document.querySelector('[data-bot-screen-slot=game]').getBoundingClientRect();
      return ['left', 'top', 'width', 'height'].every(key => Math.abs(tile[key] - slot[key]) < 1);
    })()`), true, 'Live content occupies exactly its shared stage layout slot');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    assert.equal(await run(aliceWindow, '!!document.querySelector("#stage-grid") && !document.querySelector("#stage-participants-area .stage-focused-main")'), true, 'Back to grid changes only the shared layout');
    assert.equal(await gameFrame(aliceWindow), alice, 'Returning to grid keeps the exact iframe');
    await run(aliceWindow, 'document.querySelector("#stage-grid [data-kind=camera]").click()');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game]").classList.contains("stage-mini-card")'), true, 'Camera focus moves an open miniapp into the shared filmstrip');
    assert.equal(await gameFrame(aliceWindow), alice);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    assert.equal(await run(aliceWindow, '!!document.querySelector("#stage-participants-area .stage-focused-main[data-kind=camera]") && !!document.querySelector("#stage-participants-area .stage-focused-main[data-kind=miniapp]")'), true, 'Camera and miniapp share the same focus state');
    await run(aliceWindow, 'window.screenFixture.setLanguage("en")');
    await waitFor(async () => await alice.executeJavaScript('document.querySelector("#label").textContent === "Play"'), 'live locale update');
    assert.equal(await gameFrame(aliceWindow), alice, 'MainView and stage locale redraws must not detach the frame');
    assert.deepEqual(await alice.executeJavaScript('({token: window.gameToken, state: window.lastState, revision: window.lastRevision})'), before);
    assert.deepEqual(await spectator.executeJavaScript('({token: window.gameToken, renders: window.renders})'), englishBefore);
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-action=close]").getAttribute("aria-label")'), 'Leave miniapp');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=third] [data-bot-screen-action=open]").getAttribute("aria-label")'), 'Open miniapp', 'Closed placeholders follow the selected locale too');
    assert.equal(await run(aliceWindow, 'window.screenFixture.listRequests()'), 1);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game"'), 'stage miniapp fullscreen');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement && !!document.querySelector("#stage-grid")'), 'miniapp Back to grid exits native fullscreen');
    assert.equal(await gameFrame(aliceWindow), alice);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click(); document.querySelector(".voice-stage-container").requestFullscreen()');
    await waitFor(async () => await run(aliceWindow, 'document.fullscreenElement?.classList.contains("voice-stage-container")'), 'whole-stage fullscreen');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement && !!document.querySelector("#stage-grid")'), 'miniapp Back to grid also exits whole-stage fullscreen');
    await run(aliceWindow, 'document.querySelector("#stage-grid [data-kind=camera]").click(); document.querySelector(".voice-stage-container").requestFullscreen()');
    await waitFor(async () => await run(aliceWindow, '!!document.fullscreenElement'), 'camera focus in stage fullscreen');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".stage-focused-main[data-kind=camera] .stage-focus-hint-badge")'), true, 'Camera focus retains its ordinary hint');
    await run(aliceWindow, 'document.querySelector(".stage-focused-main[data-kind=camera]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement && !!document.querySelector("#stage-grid")'), 'ordinary camera focus exit also leaves native fullscreen');
    await run(aliceWindow, 'document.querySelector("#stage-grid [data-kind=screen]").click(); document.querySelector(".voice-stage-container").requestFullscreen()');
    await waitFor(async () => await run(aliceWindow, '!!document.fullscreenElement'), 'screen focus in stage fullscreen');
    await run(aliceWindow, 'window.screenFixture.rejectFullscreenExit(); document.querySelector(".stage-focused-main .stage-stopwatch-btn").click()');
    await waitFor(async () => await run(aliceWindow, '!!document.fullscreenElement?.querySelector(".stage-focus-error")'), 'screen fullscreen failure');
    assert.equal(await run(aliceWindow, '!document.querySelector("[data-kind=screen] .screen-locked") && !!document.querySelector(".stage-focused-main[data-kind=screen]")'), true, 'A failed fullscreen transition does not partially commit screen viewing state');
    await run(aliceWindow, 'window.screenFixture.restoreFullscreenExit()');
    await run(aliceWindow, 'document.querySelector(".stage-focused-main .stage-stopwatch-btn").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement && !!document.querySelector("#stage-grid")'), 'stop watching exits fullscreen before restoring the grid');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game"'), 'fullscreen before rejected exit');
    await run(aliceWindow, 'window.screenFixture.rejectFullscreenExit(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    await waitFor(async () => await run(aliceWindow, '!!document.fullscreenElement?.querySelector(".stage-focus-error[role=alert]")'), 'visible fullscreen error');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").getAttribute("aria-pressed") === "true" && document.querySelector(".stage-focus-error").textContent === "Could not exit fullscreen. Please try again."'), true, 'Rejected fullscreen exit preserves focus and explains the failure');
    await run(aliceWindow, 'window.screenFixture.setLanguage("pt-BR")');
    assert.equal(await run(aliceWindow, 'document.querySelector(".stage-focus-error").textContent === "Não foi possível sair da tela cheia. Tente novamente."'), true);
    await run(aliceWindow, 'window.screenFixture.restoreFullscreenExit(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement && !!document.querySelector("#stage-grid") && !document.querySelector(".stage-focus-error")'), 'retry exits fullscreen and clears the inline error');
    assert.equal(await gameFrame(aliceWindow), alice);
    assert.deepEqual(await alice.executeJavaScript('({token: window.gameToken, state: window.lastState, revision: window.lastRevision})'), before, 'All fullscreen and focus changes preserve the live game and player seats');
    await run(aliceWindow, 'window.screenFixture.setLanguage("en"); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');

    await run(aliceWindow, 'window.screenFixture.delayReload(); document.querySelector("[data-bot-screen-id=second] [data-bot-screen-action=close]").click()');
    await waitFor(() => frames(aliceWindow).length === 1, 'local close');
    assert.equal(await run(aliceWindow, 'window.screenFixture.screenCount()'), 4);
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-bot-screen-id]").length'), 4, 'Leaving a view retains its tile');
    assert.equal(await run(aliceWindow, '!document.querySelector("[data-bot-screen-id=second] iframe") && !document.querySelector("[data-bot-screen-id=second] .bot-screen-placeholder").hidden'), true);
    assert.equal(await run(aliceWindow, 'window.screenFixture.sent.some(entry => entry.type === "BOT_SCREEN_CLOSE")'), false);
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=second]")'), false, 'Explicit exit does not immediately invite the viewer back');
    await run(aliceWindow, 'window.screenFixture.resolveReload(); window.screenFixture.redraw(); window.screenFixture.setLanguage("pt-BR")');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=second]")'), false, 'Pending snapshots, redraws and locale changes preserve explicit exit');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length'), 2, 'Unopened miniapps retain their own invitations');
    assert.equal(await run(aliceWindow, 'window.screenFixture.listRequests()'), 2, 'Local exit never restarts the pending list request');
    assert.equal(await gameFrame(aliceWindow), alice, 'Dismissing another invitation does not reload the game');
    await run(aliceWindow, 'window.screenFixture.setLanguage("en")');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game"'), 'fullscreen before local leave');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=close]").click()');
    await waitFor(() => frames(aliceWindow).length === 0, 'leave the game view without leaving its player seat');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=game], [data-watch-bot-screen=second]")'), false, 'Both explicit exits stay quiet while their persistent cards remain');
    assert.equal(await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game" && !document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").hidden'), true, 'Leaving only the view retains an operable fullscreen layout');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement'), 'fullscreen exit after local view closes');
    assert.equal(await run(aliceWindow, '!!document.querySelector("#stage-participants-area .stage-focused-main[data-bot-screen-slot=game]")'), true, 'Leaving a view does not change its focus');
    assert.deepEqual(await run(aliceWindow, 'window.screenFixture.snapshot().state.players'), ['alice', 'bob']);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").click()');
    await waitFor(() => frames(aliceWindow).length === 1, 'reopen from the persistent stage CTA');
    alice = await gameFrame(aliceWindow);
    await waitFor(async () => await alice.executeJavaScript('window.lastState?.count === 1'), 'reopen restores shared state');
    assert.deepEqual(await alice.executeJavaScript('window.lastState.players'), ['alice', 'bob'], 'Opening or closing a view never changes player/spectator roles');

    await alice.executeJavaScript(`window.name = ""; location.href = ${JSON.stringify(leak + '?navigation')}`);
    await spectator.executeJavaScript(`(() => {
      const image = new Image(); image.src = ${JSON.stringify(leak + '?image')}; document.body.append(image);
      const form = document.createElement('form'); form.action = ${JSON.stringify(leak + '?form')}; document.body.append(form); form.submit();
      window.open(${JSON.stringify(leak + '?popup')});
      try { top.location = ${JSON.stringify(leak + '?top')}; } catch {}
      const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = '0;url=' + ${JSON.stringify(leak + '?refresh')}; document.head.append(meta);
      const link = document.createElement('a'); link.href = ${JSON.stringify(leak + '?download')}; link.download = 'leak.html'; document.body.append(link); link.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(alice.url.startsWith('about:srcdoc'));
    assert.equal(aliceWindow.webContents.getURL(), url);
    assert.equal(leaks, 0); assert.equal(popups, 0);

    await run(aliceWindow, 'document.querySelector(".voice-stage-container").requestFullscreen()');
    await waitFor(async () => await run(aliceWindow, '!!document.fullscreenElement'), 'fullscreen before a delayed focus exit');
    await run(aliceWindow, 'window.screenFixture.deferFullscreenExit(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    await waitFor(async () => await run(aliceWindow, 'window.screenFixture.isFullscreenExitPending()'), 'pending native exit');
    await run(aliceWindow, 'window.screenFixture.browseOtherServer(); window.screenFixture.restoreFullscreenExit()');
    await waitFor(() => frames(aliceWindow).length === 0, 'switching away closes local viewing');
    assert.equal(await run(aliceWindow, '!document.querySelector(".stage-focus-error") && document.querySelector("#server-name-title").textContent === "Other server"'), true, 'A late fullscreen completion cannot repaint or reopen the retired voice stage');
    await run(aliceWindow, 'window.screenFixture.backgroundSnapshot()');
    await waitFor(async () => await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]")?.getAttribute("aria-label").includes("Background voice game")'), 'background voice invitation');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=second]")'), false, 'Background voice updates do not undo another explicit exit');
    assert.equal(await run(aliceWindow, 'document.querySelector("#server-name-title").textContent'), 'Other server');
    assert.equal(await run(aliceWindow, 'window.screenFixture.backgroundNotificationsSafe()'), true);
    assert.equal(await run(aliceWindow, 'document.querySelector("#screenshare-notice-slot").textContent.includes("WRONG SERVER")'), false);
    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]").click()');
    await waitFor(() => frames(aliceWindow).length === 1, 'opening background call activates its own server');
    alice = await gameFrame(aliceWindow);
    assert.equal(await alice.executeJavaScript('monkyScreen.viewer.id'), 'alice');
    assert.equal(await run(aliceWindow, 'document.querySelector("#server-name-title").textContent'), 'Voice server');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("#stage-participants-area .stage-focused-main").length === 1 && !!document.querySelector(".stage-focused-main[data-bot-screen-slot=game]")'), true, 'Background invitations activate the exact voice server and arrive focused');

    await run(aliceWindow, 'window.screenFixture.delayReload(); window.screenFixture.leave(); window.screenFixture.resolveReload()');
    await waitFor(() => frames(aliceWindow).length === 0, 'leave tears down frame immediately');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length'), 0);
    assert.equal(await run(aliceWindow, 'window.screenFixture.cachedScreens()'), 0, 'late responses cannot restore left-room screens');
    assert.equal(await run(aliceWindow, 'window.screenFixture.screenCount()'), 4, 'leave never erases the bot-owned game');
    await run(aliceWindow, 'window.screenFixture.join("voice")');
    await waitFor(async () => await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length === 4'), 'return reloads room invitations');
    assert.equal(frames(aliceWindow).length, 0, 'return still requires consent');
    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]").click()');
    await waitFor(() => frames(aliceWindow).length === 1, 'reopen');
    await run(aliceWindow, 'window.screenFixture.join("other")');
    await waitFor(() => frames(aliceWindow).length === 0, 'move tears down old room');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length'), 0);
    await run(aliceWindow, 'window.screenFixture.otherDeviceOnly()');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length'), 0);
    assert.equal(frames(aliceWindow).length, 0, 'same account in voice on another device cannot opt in');
    await run(aliceWindow, 'window.screenFixture.join("voice")');
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=game]")'), 'voice after second-device rejection');
    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]").click(); window.screenFixture.disconnect()');
    await waitFor(() => frames(aliceWindow).length === 0, 'disconnect destroys local view');
    await run(aliceWindow, 'window.screenFixture.reconnect()');
    await waitFor(async () => await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length === 4'), 'reconnected list');
    assert.equal(frames(aliceWindow).length, 0);
    for (const window of windows) {
      assert.deepEqual(await run(window, 'window.screenFixture.errors'), [], 'No unhandled renderer lifecycle errors');
      assert.equal(await run(window, 'window.screenFixture.destroy()'), true, 'view and lifecycle listeners are removed');
      await waitFor(() => frames(window).length === 0, 'final teardown');
    }
    assert.deepEqual(nativeErrors, [], 'No native client-log errors during stage lifecycle');
    console.log('Voice stage DOM: focused/idempotent invitations, miniapp-only hint removal, native miniapp/stage/camera/screen fullscreen-to-grid, rejected/stale fullscreen exits, four persistent placeholders, live frames/locale/seats, sandbox, background isolation and teardown passed.');
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function setupVoiceStage(id, locale) {
  const errors = [];
  const onError = event => errors.push(event.message);
  const onRejection = event => errors.push(String(event.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const [{ MainView }, { sessionManager }, { voiceStore }, { appEvents }, routing, language, { bindBotScreenEvents }] = await Promise.all([
    import('/views/MainView.ts'), import('/core/SessionManager.ts'), import('/stores/voiceStore.ts'),
    import('/core/EventBus.ts'), import('/core/sessionRouting.ts'), import('/i18n/index.ts'), import('/core/botScreenEvents.ts'),
  ]);
  language.setLanguage(locale);
  sessionManager.install();
  const session = sessionManager.create(`voice-${id}`, 7890, id);
  const other = sessionManager.create(`other-${id}`, 7891, 'foreign-user');
  const user = { id, clientId: id, sessionId: `${id}-device`, nickname: id, status: 'ONLINE', joinedAt: 1 };
  const remote = { id: 'remote', clientId: 'remote', sessionId: 'remote-device', nickname: 'Remote', status: 'ONLINE', joinedAt: 1 };
  const state = (person, channelId, extra = {}) => ({
    sessionId: person.sessionId, userId: person.id, channelId, isMuted: false, isDeafened: false, isSpeaking: false,
    isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false, serverMuted: false, serverDeafened: false, ...extra,
  });
  const channels = [
    { id: 'chat', serverId: 'server', name: 'Chat', type: 'TEXT', position: 0, createdAt: 1, botCommandsEnabled: true },
    ...['voice', 'other'].map((channelId) => ({ id: channelId, serverId: 'server', name: channelId, type: 'VOICE', position: 0, createdAt: 1 })),
  ];
  const seed = (entry, self, name) => {
    entry.serverStore.setServerDetails({
      id: entry.key, name, createdAt: 1, maxUsers: 10, channels: structuredClone(channels), members: [self, remote],
      knownMembers: [self, remote], voiceStates: {}, roles: [], userRoles: [], ownerId: self.id, myPermissions: 0xffffffff,
    }, self);
    entry.participants.setUsers([self, remote]);
  };
  seed(session, user, 'Voice server');
  seed(other, { ...user, id: 'foreign-user', sessionId: 'foreign-device' }, 'Other server');
  const screens = new Map(['game', 'second', 'third', 'fourth'].map((screenId) => [screenId, {
    id: screenId, botId: 'bot', channelId: 'voice', title: screenId === 'game' ? 'Voice game <not markup>' : screenId,
    revision: 0, createdAt: 1, state: { count: 0, players: ['alice', 'bob'] },
    html: `<style>body{background:#162033;color:white;font:16px sans-serif;margin:12px}</style><p id="label"></p><p id="state"></p><script>
      window.gameId = ${JSON.stringify(screenId)}; window.gameToken = Math.random(); window.renders = 0;
      monkyScreen.onState((state, revision) => {
        window.lastState = state; window.lastRevision = revision; window.renders++;
        document.querySelector('#state').textContent = String(state.count);
        document.querySelector('#label').textContent = monkyScreen.viewer.locale === 'pt-BR' ? 'Jogar' : 'Play';
      });
    </script>`,
  }]));
  let connected = true;
  let connection = 1;
  let requests = 0;
  let holdList = false;
  let resolveList;
  let safeNotifications = true;
  const actions = [];
  const sent = [];
  const nativeExitFullscreen = document.exitFullscreen;
  let finishFullscreenExit;
  session.client.getStatus = () => connected ? 'CONNECTED' : 'DISCONNECTED';
  session.client.getConnectionId = () => `${id}-${connection}`;
  other.client.getStatus = () => 'CONNECTED';
  for (const entry of [session, other]) entry.client.send = (type, payload) => { sent.push({ type, payload }); };
  other.client.sendRequest = async (type) => {
    if (type === 'SELECTOR_LIST') return { selectors: [] };
    throw new Error(`Unexpected other-server request: ${type}`);
  };
  session.client.sendRequest = async (type, payload) => {
    if (type === 'SELECTOR_LIST') return { selectors: [] };
    if (type === 'BOT_SCREEN_LIST') {
      requests++;
      const result = { channelId: payload.channelId, screens: payload.channelId === 'voice' ? [...screens.values()].map((screen) => structuredClone(screen)) : [] };
      if (holdList) {
        holdList = false;
        return await new Promise((resolve) => { resolveList = () => resolve(result); });
      }
      return result;
    }
    if (type !== 'BOT_SCREEN_ACTION') throw new Error(`Unexpected request: ${type}`);
    actions.push({ actor: id, ...payload });
    let screen = screens.get(payload.id);
    if (id === 'alice' && payload.action === 'move' && screen.revision === payload.revision) {
      screen = { ...screen, revision: screen.revision + 1, state: { ...screen.state, count: screen.state.count + 1 } };
      screens.set(screen.id, screen);
    }
    return structuredClone(screen);
  };
  sessionManager.activate(session.key);
  const listenerCount = () => [...appEvents.listeners.values()].reduce((sum, entries) => sum + entries.size, 0);
  const before = listenerCount();
  const offScreens = bindBotScreenEvents();
  const view = new MainView(document.getElementById('app'));
  const offLanguage = appEvents.on('i18n.language_changed', () => view.render(true));
  const offNotifications = appEvents.on('voice.bot_screens_updated', () => {
    safeNotifications &&= routing.isForegroundEvent() && routing.currentEventOrigin() === null;
  });
  view.render();
  const receive = (snapshot) => {
    screens.set(snapshot.id, snapshot);
    routing.routeSessionEvent(session.key, 'message.BOT_SCREEN_SNAPSHOT', () => appEvents.emit('message.BOT_SCREEN_SNAPSHOT', snapshot));
  };
  const join = (channelId) => {
    session.participants.updateVoiceState(state(user, channelId));
    session.participants.updateVoiceState(state(remote, channelId, { isCameraOn: true, isScreenSharing: true, screenShareIds: ['generated-share'] }));
    voiceStore.setChannel(channelId, session.key);
    appEvents.emit('participants.updated');
  };
  window.screenFixture = {
    actions, sent, join, receive, errors,
    listRequests: () => requests,
    screenCount: () => screens.size,
    cachedScreens: () => session.botScreenStore.list('voice').length,
    snapshot: () => structuredClone(screens.get('game')),
    rejectFullscreenExit() { document.exitFullscreen = () => Promise.reject(new Error('Expected fixture fullscreen rejection')); },
    deferFullscreenExit() { document.exitFullscreen = () => new Promise(resolve => { finishFullscreenExit = resolve; }); },
    isFullscreenExitPending: () => typeof finishFullscreenExit === 'function',
    restoreFullscreenExit() {
      document.exitFullscreen = nativeExitFullscreen;
      const finish = finishFullscreenExit;
      finishFullscreenExit = undefined;
      finish?.();
    },
    setLanguage: language.setLanguage,
    isSelfSharing: () => voiceStore.isScreenSharing,
    selfShare() { voiceStore.setScreenSharing(true); appEvents.emit('participants.updated'); },
    redraw() {
      appEvents.emit('participants.updated');
      voiceStore.setSpeaking(false);
      appEvents.emit('voice.state_updated');
      view.voiceStageView.renderParticipants();
    },
    browseOtherServer() {
      other.botScreenStore.upsert({ ...screens.get('game'), title: 'WRONG SERVER', state: { count: 999 }, revision: 99 });
      sessionManager.activate(other.key);
    },
    backgroundSnapshot() {
      const previous = screens.get('game');
      receive({ ...previous, title: 'Background voice game', revision: previous.revision + 1 });
    },
    backgroundNotificationsSafe: () => safeNotifications,
    delayReload() { holdList = true; appEvents.emit('voice.bot_screens_reload'); },
    resolveReload() { resolveList(); },
    leave() { voiceStore.setChannel(null); session.participants.removeVoiceState(user.sessionId); },
    otherDeviceOnly() {
      voiceStore.setChannel(null);
      session.participants.removeVoiceState(user.sessionId);
      const extraDevice = { ...user, sessionId: `${id}-other-device` };
      session.participants.addUser(extraDevice);
      session.participants.updateVoiceState(state(extraDevice, 'voice'));
      voiceStore.setChannel('voice', session.key);
      appEvents.emit('participants.updated');
      view.voiceStageView.watchBotScreen('game');
    },
    disconnect() {
      connected = false;
      routing.routeSessionEvent(session.key, 'network.status', () => appEvents.emit('network.status', 'DISCONNECTED'));
    },
    reconnect() {
      connected = true; connection++;
      routing.routeSessionEvent(session.key, 'network.status', () => appEvents.emit('network.status', 'CONNECTED'));
    },
    destroy() {
      document.exitFullscreen = nativeExitFullscreen;
      finishFullscreenExit?.();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      offLanguage(); offNotifications(); view.destroy(); offScreens();
      voiceStore.reset(); sessionManager.removeAll();
      return listenerCount() === before;
    },
  };
}
