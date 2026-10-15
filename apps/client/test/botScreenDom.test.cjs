const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('voice-stage miniapps are opt-in, session-bound and preserve opaque frames across live UI updates', { timeout: 180000 }, async () => {
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
  const { BOT_SCREEN_PERMISSION_POLICY_VERSION, SHORTCUT_IPC, SOUND_DOWNLOAD_IPC, Permission } = require('@monky/shared');
  const { bindBotScreenIsolation, installBotScreenRequestGuard } = require('../dist-electron/main/botScreenIsolation.js');
  const { bindBotScreenDocuments, registerBotScreenScheme } = require('../dist-electron/main/botScreenDocuments.js');
  registerBotScreenScheme();
  app.setPath('userData', process.env.MONKY_SCREEN_PROFILE);
  // finish() destroys every window before app.exit(code); the default quit would report failures as exit 0.
  app.on('window-all-closed', () => {});
  let vite;
  let timeout;
  let leaks = 0;
  let popups = 0;
  // A stuck await raises no error of its own: the global timeout names the step it interrupted.
  let lastStep = 'startup';
  // What miniapp lifecycle hooks report to "their own server", even after their document is gone.
  const hookEvents = [];
  const windows = [];
  const nativeErrors = [];
  const owns = event => windows.some(window => !window.isDestroyed()
    && window.webContents === event.sender && event.senderFrame === event.sender.mainFrame);
  const unbindDocuments = bindBotScreenDocuments(contents => windows.some(window =>
    !window.isDestroyed() && window.webContents === contents));
  ipcMain.handle(SHORTCUT_IPC.setPttConfig, event => owns(event));
  ipcMain.handle(SOUND_DOWNLOAD_IPC.defaultFolder, event => {
    assert.ok(owns(event));
    return null;
  });
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
    unbindDocuments();
    app.exit(code);
  };
  const waitFor = async (check, description) => {
    lastStep = `waiting for ${description}`;
    for (let i = 0; i < 250; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${description}`);
  };
  const waitForQuiet = async (sample, description, quietMs = 250, timeoutMs = 5000) => {
    const started = Date.now();
    let lastValue = await sample();
    let lastSerialized = JSON.stringify(lastValue);
    let quietSince = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const value = await sample();
      const serialized = JSON.stringify(value);
      if (serialized !== lastSerialized) {
        lastValue = value;
        lastSerialized = serialized;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quietMs) {
        return lastValue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for quiet state: ${description}; last=${lastSerialized}`);
      }
    }
  };
  const run = async (window, script) => {
    lastStep = `renderer snippet ${script.slice(0, 200)}`;
    try { return await window.webContents.executeJavaScript(script, true); }
    catch (error) {
      console.error('Failed miniapp renderer snippet:', script.slice(0, 1500));
      throw error;
    }
  };
  const isDisposedFrameError = error => error instanceof Error &&
    error.message.includes('Render frame was disposed before WebFrameMain could be accessed');
  const frameUrl = frame => {
    try {
      return frame.url;
    } catch (error) {
      if (isDisposedFrameError(error)) return null;
      throw error;
    }
  };
  const frames = (window) => window.webContents.mainFrame.frames.filter((frame) => frameUrl(frame)?.startsWith('monky-miniapp:'));
  const approveMiniapp = async window => {
    await waitFor(async () => await run(window, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=confirm]")'), 'individual miniapp permission review');
    await run(window, 'document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=confirm]").focus()');
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
    });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    });
    await waitFor(async () => await run(window, '!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), 'trusted permission confirmation');
  };
  const gameFrame = async (window, id = 'game') => {
    let initializedFrame;
    await waitFor(async () => {
      for (const frame of frames(window)) {
        try {
          if (await frame.executeJavaScript('window.gameId') === id) {
            initializedFrame = frame;
            return true;
          }
        } catch (error) {
          if (!isDisposedFrameError(error)) throw error;
        }
      }
      return false;
    }, `initialized ${id} frame`);
    assert.ok(initializedFrame);
    return initializedFrame;
  };
  // A pristine nested realm reads what a probe <audio> really outputs inside the miniapp.
  const probeVolume = `(() => {
    if (!window.volumeProbe) {
      const realm = document.createElement("iframe");
      realm.hidden = true;
      document.body.append(realm);
      const native = Object.getOwnPropertyDescriptor(realm.contentWindow.HTMLMediaElement.prototype, "volume").get;
      window.volumeProbe = new Audio();
      window.volumeProbe.volume = 0.8;
      window.readProbeVolume = () => Math.round(native.call(window.volumeProbe) * 1000) / 1000;
    }
    return [window.volumeProbe.volume, window.readProbeVolume()];
  })()`;

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
            if (request.url === '/__destination') {
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><script>window.receivedBridge=false;addEventListener("message",event=>{if(event.ports.length)window.receivedBridge=true;});</script><p>Independent web page</p>');
              return;
            }
            if (request.url.startsWith('/__leak')) {
              leaks++;
              response.setHeader('Access-Control-Allow-Origin', '*');
              response.end('web resource');
              return;
            }
            if (request.url.startsWith('/__hook?')) {
              hookEvents.push(decodeURIComponent(request.url.slice('/__hook?'.length)));
              response.setHeader('Access-Control-Allow-Origin', '*');
              response.end('saved');
              return;
            }
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
    timeout = setTimeout(() => { console.error(`Voice screen DOM regression timed out; last step: ${lastStep}`); void finish(1); }, 160000);
    for (const [id, locale] of [['alice', 'pt-BR'], ['spectator', 'en']]) {
      const window = new BrowserWindow({
        show: false, width: 1280, height: 1000,
        webPreferences: {
          contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
          sandbox: false, backgroundThrottling: false, offscreen: true,
          // Exercise real HTML fullscreen without macOS Spaces transitions on a hidden window.
          disableHtmlFullscreenWindowResize: true,
          partition: `voice-screen-${id}`,
          preload: path.join(clientRoot, 'dist-electron', 'preload', 'preload.js'),
        },
      });
      windows.push(window);
      bindBotScreenIsolation(window.webContents);
      installBotScreenRequestGuard(window.webContents.session);
      window.webContents.setWindowOpenHandler(() => { popups++; return { action: 'deny' }; });
      await window.loadURL(url);
      const consent = JSON.stringify({ policyVersion: BOT_SCREEN_PERMISSION_POLICY_VERSION,
        serverKey: 'fixture', botId: 'bot', screenId: 'lifecycle', instanceId: 'lifecycle-instance' });
      const temporaryDocument = await run(window, `window.api.createBotScreenDocument("<p>document lifecycle</p>", ${consent})`);
      assert.match(temporaryDocument, /^monky-miniapp:\/\/[a-f0-9-]+\/index.html$/);
      const requested = await window.webContents.session.fetch(temporaryDocument);
      assert.equal(requested.status, 200);
      assert.equal(requested.headers.get('cache-control'), 'no-store');
      await run(window, `window.api.removeBotScreenDocument(${JSON.stringify(temporaryDocument)})`);
      assert.equal((await window.webContents.session.fetch(temporaryDocument)).status, 404);
      assert.equal(await run(window, `window.api.createBotScreenDocument("", ${consent}).then(()=>false,()=>true)`), true);
      assert.equal(await run(window, `window.api.createBotScreenDocument("x".repeat(1024*1024), ${consent}).then(()=>false,()=>true)`), true);
      assert.equal(await run(window, 'window.api.createBotScreenDocument("<p>no consent</p>").then(()=>false,()=>true)'), true);
      assert.equal(await run(window, `window.api.createBotScreenDocument("<p>old consent</p>", {...${consent},policyVersion:0}).then(()=>false,()=>true)`), true);
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      const setupError = await run(window, `(${setupVoiceStage.toString()})(${JSON.stringify(id)},${JSON.stringify(locale)},${Permission.ADMINISTRATOR}).then(() => null, error => ({ message: String(error), stack: error.stack }))`);
      assert.equal(setupError, null, JSON.stringify(setupError));
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
    assert.deepEqual(await run(aliceWindow, `(${verifyVolumeHook.toString()})()`), {
      chosen: [0.8, 0.4, 0.25, 0.125], errors: ['IndexSizeError', 'IndexSizeError', 'TypeError'], afterErrors: [0.8, 0.4],
      played: [1, 0.5], attached: [1, 0.5], external: [0.6, 0.3], chained: true, routed: true, outputs: [1, 0.5],
      disconnected: 'InvalidAccessError', offline: [true, 1], graphed: [0.3, 0.6, 0.6],
      amplified: [1, 0.5, 1, 1, 0.6, 2], muted: [0, 0, 0.6, 0, 0, 0.7], ignored: 0, restored: [0.8, 0.25, 0.8, 1, 0.7],
    }, 'The miniapp volume scales media up to 100% and live Web Audio up to 200%, once per source, including native controls');
    await run(aliceWindow, 'window.screenFixture.selfShare(); document.querySelector("#screenshare-self-stop-btn").click()');
    await waitFor(async () => await run(aliceWindow, '!window.screenFixture.isSelfSharing()'), 'self screen-share stop');
    assert.equal(await run(aliceWindow, 'window.screenFixture.sent.some(entry => entry.type === "VOICE_STATE_UPDATE" && entry.payload.isScreenSharing === false)'), true);
    const dialog = '.modal-backdrop:not([data-ui-closing]) .dialog-card';
    const focusedScreen = '!!document.querySelector("#stage-participants-area .stage-focused-main[data-kind=screen]")';
    // Your own share icon and LIVE badge stay informational: there is nothing to watch.
    await run(aliceWindow, 'window.screenFixture.selfLive(true)');
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector("#voice-mini-user-alice-device .voice-mini-icon.live")'), 'own share icon');
    assert.deepEqual(await run(aliceWindow, `[
      document.querySelector("#voice-mini-user-alice-device .voice-mini-icon.live").tagName,
      document.querySelector(".member-item[data-user-id=alice] .member-live-badge")?.tagName,
      [...document.querySelectorAll("[data-watch-live]")].map(button => button.dataset.watchLive),
    ]`), ['SPAN', 'SPAN', ['remote-device', 'remote-device']]);
    await run(aliceWindow, 'window.screenFixture.selfLive(false)');
    await waitFor(async () => await run(aliceWindow, '!document.querySelector("#voice-mini-user-alice-device .voice-mini-icon.live")'), 'own share icon gone');
    // Someone else's share icon asks first; cancelling opens nothing.
    await run(aliceWindow, 'document.querySelector(".voice-participant-mini [data-watch-live]").click()');
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${JSON.stringify(dialog)})`), 'watch question from the share icon');
    assert.equal(await run(aliceWindow, `document.querySelector(${JSON.stringify(`${dialog} .dialog-message`)}).textContent`),
      'Remote está compartilhando a tela. Abrir o palco e assistir agora?');
    assert.equal(await run(aliceWindow, 'document.querySelector(".voice-participant-mini [data-watch-live]").getAttribute("aria-label")'),
      'Assistir à transmissão de Remote');
    await run(aliceWindow, `document.querySelector(${JSON.stringify(`${dialog} [data-action=cancel]`)}).click()`);
    await waitFor(async () => await run(aliceWindow, '!document.querySelector(".modal-backdrop .dialog-card")'), 'watch question dismissed');
    assert.equal(await run(aliceWindow, focusedScreen), false, 'Cancelling neither focuses nor watches the broadcast');
    // The LIVE badge in the member list asks the same; confirming focuses and watches it.
    await run(aliceWindow, 'document.querySelector(".member-item [data-watch-live]").click()');
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${JSON.stringify(dialog)})`), 'watch question from the LIVE badge');
    assert.equal(await run(aliceWindow, `document.querySelector(${JSON.stringify(`${dialog} [data-action=confirm]`)}).textContent`), 'Assistir transmissão');
    await run(aliceWindow, `document.querySelector(${JSON.stringify(`${dialog} [data-action=confirm]`)}).click()`);
    await waitFor(async () => await run(aliceWindow, `${focusedScreen} && !document.querySelector(".modal-backdrop .dialog-card")`),
      'stage focused on the broadcast once the question is gone');
    assert.equal(await run(aliceWindow, `${focusedScreen} && !document.querySelector("#stage-participants-area [data-kind=screen] .screen-locked")`), true);
    assert.equal(frames(aliceWindow).length, 0, 'Watching a screen does not opt into miniapps');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-bot-screen-id]").length'), 4, 'Every room miniapp has a persistent stage tile before opt-in');
    assert.equal(await run(aliceWindow, '!document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").hidden'), true, 'The creator can end a miniapp before opening its iframe');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("#stage-participants-area [data-bot-screen-slot]").length'), 4, 'Miniapps participate in the ordinary stage filmstrip');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").textContent.includes("Abrir miniapp")'), true);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game"'), 'closed tile fullscreen');
    assert.equal(frames(aliceWindow).length, 0, 'Fullscreen is layout only and never opens a closed miniapp');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement'), 'closed tile fullscreen exit');
    await run(aliceWindow, 'window.savedGameInvitation = document.querySelector("[data-watch-bot-screen=game]"); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").click()');
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), 'review before any execution');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").click()');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll(".modal-backdrop:not([data-ui-closing]) .dialog-card").length'), 1, 'Repeated opening does not stack permission prompts');
    aliceWindow.setContentSize(800, 600);
    await waitFor(async () => await run(aliceWindow, 'innerHeight === 600'), 'small review viewport');
    assert.equal(await run(aliceWindow, `(() => {
      const message = document.querySelector(".dialog-message");
      const card = document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card").getBoundingClientRect();
      const confirm = document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=confirm]").getBoundingClientRect();
      return card.top >= 0 && card.bottom <= innerHeight && confirm.bottom <= innerHeight &&
        message.scrollHeight > message.clientHeight && message.scrollTop === 0;
    })()`), true, 'Long permission text scrolls without hiding its beginning or the deny/allow controls');
    const beforeConsent = leaks;
    assert.equal(frames(aliceWindow).length, 0, 'Opening a tile is not consent to execute the bot app');
    assert.equal(await run(aliceWindow, 'document.activeElement?.dataset.action'), 'cancel', 'Deny has initial keyboard focus');
    assert.equal(await run(aliceWindow, 'document.querySelector(".dialog-message").textContent.includes("rede local")'), true, 'The review discloses local-network access too');
    assert.equal(await run(aliceWindow, 'document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=confirm]").textContent'), 'Continuar e abrir');
    assert.equal(await run(aliceWindow, 'document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=cancel]").textContent'), 'Cancelar');
    assert.equal(await run(aliceWindow, 'document.querySelector(".dialog-message").textContent.includes("não concede novas permissões ao bot")'), true, 'The participant notice does not replace administrator authorization');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll(".modal-backdrop:not([data-ui-closing]) .dialog-card input").length'), 0, 'The viewer never selects or grants bot capabilities');
    await run(aliceWindow, 'document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=confirm]").click()');
    assert.equal(frames(aliceWindow).length, 0, 'A synthetic click cannot authorize execution');
    await run(aliceWindow, 'document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=cancel]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), 'denied review closes');
    assert.equal(frames(aliceWindow).length, 0);
    assert.equal(leaks, beforeConsent, 'Denied miniapps cannot issue HTTP requests');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] .bot-error").textContent.includes("não foi executado")'), true);
    aliceWindow.setContentSize(1280, 1000);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, '!!document.fullscreenElement'), 'fullscreen before review');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").click()');
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card") && !document.fullscreenElement'), 'review remains visible outside fullscreen');
    await approveMiniapp(aliceWindow);
    await waitFor(() => frames(aliceWindow).length === 1, 'ordinary tile opt-in');
    assert.equal(await run(aliceWindow, '!!document.querySelector("#stage-participants-area .stage-focused-main[data-bot-screen-slot=game]") && !document.querySelector(".stage-focused-main[data-kind=screen]")'), true, 'Opening a stage tile focuses the miniapp just like its invitation');
    await run(aliceWindow, 'window.savedGameInvitation.click(); window.savedGameInvitation.click(); delete window.savedGameInvitation');
    await run(spectatorWindow, 'document.querySelector("[data-watch-bot-screen=game]").click()');
    assert.equal(frames(spectatorWindow).length, 0, 'The creator opening a view does not skip another participant notice');
    assert.equal(await run(spectatorWindow, 'document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card [data-action=confirm]").textContent'), 'Continue and open');
    await approveMiniapp(spectatorWindow);
    for (const window of windows) await waitFor(() => frames(window).length === 1, 'opted-in stage frame');
    await run(spectatorWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=close]").click(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").click()');
    await approveMiniapp(spectatorWindow);
    await waitFor(() => frames(spectatorWindow).length === 1, 'spectator reopens using the stage tile');
    assert.equal(await run(spectatorWindow, '!!document.querySelector(".stage-focused-main[data-bot-screen-slot=game]")'), true, 'Spectator tile opt-in also enters focus automatically');
    let alice = await gameFrame(aliceWindow);
    let spectator = await gameFrame(spectatorWindow);
    assert.equal(await run(spectatorWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").hidden'), true, 'Ordinary viewers cannot end the shared miniapp');
    await run(spectatorWindow, 'window.screenFixture.setAdmin(true)');
    assert.equal(await run(spectatorWindow, '!document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").hidden'), true, 'An administrator gains the control immediately');
    await run(spectatorWindow, 'window.screenFixture.setAdmin(false); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").click()');
    assert.equal(await run(spectatorWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").hidden && !window.screenFixture.sent.some(entry => entry.type === "BOT_SCREEN_END")'), true, 'Revocation hides the control and stale/programmatic clicks cannot send END');
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
      try { localStorage.setItem('miniapp-test', 'own origin'); } catch { storageBlocked = true; }
      const child = document.createElement('iframe'); document.body.append(child);
      try { void child.contentWindow.RTCPeerConnection; } catch { nestedBlocked = true; } child.remove();
      try { await fetch(${JSON.stringify(leak)}); } catch { fetchBlocked = true; }
      return { parentBlocked, storageBlocked, nestedBlocked, fetchBlocked, api: typeof window.api,
        node: typeof require, process: typeof process, rtc: typeof RTCPeerConnection,
        transport: typeof WebTransport, viewer: monkyScreen.viewer.id };
    })()`);
    assert.deepEqual(safety, {
      parentBlocked: true, storageBlocked: false, nestedBlocked: false, fetchBlocked: false,
      api: 'undefined', node: 'undefined', process: 'undefined', rtc: 'function', transport: 'function', viewer: 'alice',
    });
    assert.equal(await spectator.executeJavaScript('localStorage.getItem("miniapp-test")'), null,
      'Another miniapp document never shares application storage');
    assert.deepEqual(await alice.executeJavaScript(`(async () => {
      const bytes = new Uint8Array([0,97,115,109,1,0,0,0]);
      const wasm = await WebAssembly.instantiate(bytes);
      const source = URL.createObjectURL(new Blob(['onmessage = event => postMessage(event.data + 1)'], {type: 'text/javascript'}));
      const worker = new Worker(source);
      try {
        const result = await new Promise((resolve, reject) => {
          worker.onmessage = event => resolve(event.data);
          worker.onerror = reject;
          worker.postMessage(41);
        });
        return {wasm: wasm.instance instanceof WebAssembly.Instance, worker: result};
      } finally { worker.terminate(); URL.revokeObjectURL(source); }
    })()`), { wasm: true, worker: 42 });
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
    await approveMiniapp(aliceWindow);
    await waitFor(() => frames(aliceWindow).length === 2, 'second app opt-in without opening other apps');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("#stage-participants-area .stage-focused-main").length === 1 && !!document.querySelector("#stage-participants-area .stage-focused-main[data-bot-screen-slot=second]")'), true, 'Choosing another invitation focuses only that miniapp');
    assert.equal(await run(aliceWindow, `[...document.querySelectorAll("[data-bot-screen-id]")].map(tile =>
      tile.dataset.botScreenId + ":" + tile.querySelector(".stage-card-controls").hidden).sort().join()`),
    'fourth:true,game:false,second:false,third:true', 'Only open views, which can play audio, offer a volume control');
    assert.deepEqual(await run(aliceWindow, `(() => {
      const shape = wrapper => JSON.stringify([...wrapper.querySelectorAll("*")]
        .map(node => node.tagName + "." + [...node.classList].sort().join(".")).sort());
      const corner = wrapper => {
        const tile = wrapper.closest("[data-tile-key], [data-bot-screen-id]").getBoundingClientRect();
        const bar = wrapper.closest(".stage-card-controls").getBoundingClientRect();
        return [Math.round(tile.right - bar.right), Math.round(tile.bottom - bar.bottom)];
      };
      const screen = document.querySelector("#stage-participants-area [data-kind=screen] .stage-volume-wrapper");
      const miniapp = document.querySelector("[data-bot-screen-id=second] .stage-volume-wrapper");
      const slider = miniapp.querySelector("input");
      return [shape(miniapp) === shape(screen), JSON.stringify(corner(miniapp)) === JSON.stringify(corner(screen)),
        slider.min, slider.max, slider.value, getComputedStyle(slider).writingMode];
    })()`), [true, true, '0', '200', '100', 'vertical-lr'], 'A miniapp reuses the screen share volume control, in the same corner and range');
    assert.equal(await run(aliceWindow, `(() => {
      const tile = document.querySelector("[data-bot-screen-id=game]");
      return tile.classList.contains("stage-mini-card") &&
        getComputedStyle(tile.querySelector(".stage-card-controls")).display !== "none" &&
        getComputedStyle(tile.querySelector(".stage-volume-btn")).display !== "none";
    })()`), true, 'Like screen share thumbnails, a filmstrip miniapp keeps its volume button');
    const second = await gameFrame(aliceWindow, 'second');
    for (const frame of [alice, second]) {
      assert.deepEqual(await frame.executeJavaScript(probeVolume), [0.8, 0.8], 'An unadjusted miniapp keeps its own levels');
    }
    const secondVolume = '[data-bot-screen-id=second] [data-bot-screen-volume]';
    const secondMute = `${secondVolume} [data-bot-screen-action=mute]`;
    const secondSlider = `${secondVolume} input`;
    const botMutes = JSON.stringify(`[data-bot-screen-id=game] [data-bot-screen-action=mute], ${secondMute}`);
    await run(aliceWindow, `(() => {
      const slider = document.querySelector(${JSON.stringify(secondSlider)});
      slider.value = "50";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    for (const frame of [alice, second]) {
      await waitFor(async () => (await frame.executeJavaScript(probeVolume))[1] === 0.4, 'saved level reaches every view of the bot');
    }
    assert.deepEqual(await alice.executeJavaScript(probeVolume), [0.8, 0.4], 'The miniapp keeps reading the volume it chose');
    assert.deepEqual(await run(aliceWindow, `[
      document.querySelector("[data-bot-screen-id=game] [data-bot-screen-volume] input").value,
      document.querySelector(${JSON.stringify(secondSlider)}).getAttribute("aria-valuetext"),
      JSON.parse(localStorage.getItem("monky_settings")).miniappVolumes.bot,
    ]`), ['50', '50%', 50], 'Like a sharer, a bot has one saved volume shown on all of its tiles');
    await run(aliceWindow, `document.querySelector(${JSON.stringify(secondMute)}).click()`);
    for (const frame of [alice, second]) {
      await waitFor(async () => (await frame.executeJavaScript(probeVolume))[1] === 0, 'muting the bot silences all of its views');
    }
    const muteState = `[...document.querySelectorAll(${botMutes})].map(button => [button.getAttribute("aria-pressed"),
      button.querySelector(".material-symbols-outlined").textContent, button.title,
      button.closest(".stage-volume-wrapper").classList.contains("screen-audio-muted")])`;
    assert.deepEqual(await run(aliceWindow, muteState), [
      ['true', 'volume_off', 'Áudio do miniapp mutado (clique para desmutar)', true],
      ['true', 'volume_off', 'Áudio do miniapp mutado (clique para desmutar)', true],
    ], 'Like a sharer, a bot is muted on every tile at once');
    const pointerTo = async (selector) => {
      const point = selector ? await run(aliceWindow, `(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`) : { x: 2, y: 2 };
      await aliceWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    };
    const popupOpen = `getComputedStyle(document.querySelector(${JSON.stringify(`${secondVolume} .stage-volume-popup`)})).display !== "none"`;
    await pointerTo(secondMute);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await run(aliceWindow, popupOpen), false, 'Like a screen share, a muted miniapp keeps its slider closed');
    await run(aliceWindow, `document.querySelector(${JSON.stringify(secondMute)}).click()`);
    await waitFor(async () => await run(aliceWindow, popupOpen), 'unmuting under the pointer opens the slider');
    for (const frame of [alice, second]) {
      await waitFor(async () => (await frame.executeJavaScript(probeVolume))[1] === 0.4, 'unmuting the bot restores all of its views');
    }
    assert.deepEqual((await run(aliceWindow, muteState)).map(state => state[0]), ['false', 'false']);
    assert.equal(await run(aliceWindow, `(() => {
      const tile = document.querySelector("[data-bot-screen-id=second]").getBoundingClientRect();
      const button = document.querySelector(${JSON.stringify(secondMute)}).getBoundingClientRect();
      const popup = document.querySelector(${JSON.stringify(`${secondVolume} .stage-volume-popup`)}).getBoundingClientRect();
      return popup.bottom <= button.top + 1 && popup.top >= tile.top && popup.left >= tile.left && popup.right <= tile.right;
    })()`), true, 'Like a screen share, the vertical slider opens above the button, inside the tile');
    await pointerTo(null);
    await waitFor(async () => !(await run(aliceWindow, popupOpen)), 'leaving the control closes the slider');
    const key = async (key, keyCode) => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await aliceWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type, key, code: key, windowsVirtualKeyCode: keyCode,
        });
      }
    };
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=second] [data-bot-screen-action=end]").focus()');
    aliceWindow.webContents.focus();
    await key('Tab', 9);
    await waitFor(async () => await run(aliceWindow, `document.activeElement === document.querySelector(${JSON.stringify(secondMute)})`) &&
      await run(aliceWindow, popupOpen), 'keyboard focus on the volume button opens the slider');
    await key('Tab', 9);
    assert.equal(await run(aliceWindow, `document.activeElement === document.querySelector(${JSON.stringify(secondSlider)})`), true, 'Tab reaches the slider');
    await key('ArrowUp', 38);
    let keyboardVolume = 50;
    await waitFor(async () => {
      keyboardVolume = await run(aliceWindow, `document.querySelector(${JSON.stringify(secondSlider)}).valueAsNumber`);
      return keyboardVolume !== 50;
    }, 'keyboard volume adjustment');
    assert.equal(Math.abs(keyboardVolume - 50), 1, 'An arrow key moves the slider by one step');
    const keyboardLevel = Math.round(0.8 * keyboardVolume / 100 * 1000) / 1000;
    for (const frame of [alice, second]) {
      await waitFor(async () => (await frame.executeJavaScript(probeVolume))[1] === keyboardLevel, 'keyboard level reaches every view of the bot');
    }
    await key('Escape', 27);
    await waitFor(async () => !(await run(aliceWindow, popupOpen)) &&
      await run(aliceWindow, `document.activeElement === document.querySelector(${JSON.stringify(secondMute)})`), 'Escape closes the slider and returns focus');
    assert.equal(await run(aliceWindow, 'JSON.parse(localStorage.getItem("monky_settings")).miniappVolumes.bot'), keyboardVolume);
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
    const localizedAlice = await gameFrame(aliceWindow);
    assert.equal(localizedAlice, alice, 'MainView and stage locale redraws must not detach the frame');
    await waitFor(async () => await localizedAlice.executeJavaScript('document.querySelector("#label").textContent === "Play"'), 'live locale update');
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
    assert.equal(await run(aliceWindow, 'window.screenFixture.sent.some(entry => entry.type === "BOT_SCREEN_END")'), false, 'Local Leave never sends shared END');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=second]")'), false, 'Explicit exit does not immediately invite the viewer back');
    await run(aliceWindow, 'window.screenFixture.resolveReload(); window.screenFixture.redraw(); window.screenFixture.setLanguage("pt-BR")');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=second]")'), false, 'Pending snapshots, redraws and locale changes preserve explicit exit');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length'), 2, 'Unopened miniapps retain their own invitations');
    assert.equal(await run(aliceWindow, 'window.screenFixture.listRequests()'), 2, 'Local exit never restarts the pending list request');
    assert.equal(await gameFrame(aliceWindow), alice, 'Dismissing another invitation does not reload the game');
    await run(aliceWindow, 'window.screenFixture.setLanguage("en")');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game"'), 'fullscreen before local leave');
    const beforeWorker = leaks;
    await alice.executeJavaScript(`(() => {
      const source = ${JSON.stringify(`setInterval(() => { void fetch(${JSON.stringify(leak + '?revocation')}); }, 40);`)};
      window.permissionWorker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    })()`);
    await waitFor(() => leaks >= beforeWorker + 2, 'authorized worker can actually access the network');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=close]").click()');
    await waitFor(() => frames(aliceWindow).length === 0, 'leave the game view without leaving its player seat');
    // Out-of-process frame teardown can lag on slow runners: require a quiet window, not a fixed grace period.
    const quietDeadline = Date.now() + 5000;
    for (let afterRevoke = leaks; ; afterRevoke = leaks) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (leaks === afterRevoke) break;
      assert.ok(Date.now() < quietDeadline, `Revoking consent stops the real worker and its network activity (${leaks - beforeWorker} requests)`);
    }
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=game], [data-watch-bot-screen=second]")'), false, 'Both explicit exits stay quiet while their persistent cards remain');
    assert.equal(await run(aliceWindow, 'document.fullscreenElement?.dataset.botScreenId === "game" && !document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").hidden'), true, 'Leaving only the view retains an operable fullscreen layout');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=fullscreen]").click()');
    await waitFor(async () => await run(aliceWindow, '!document.fullscreenElement'), 'fullscreen exit after local view closes');
    assert.equal(await run(aliceWindow, '!!document.querySelector("#stage-participants-area .stage-focused-main[data-bot-screen-slot=game]")'), true, 'Leaving a view does not change its focus');
    assert.deepEqual(await run(aliceWindow, 'window.screenFixture.snapshot().state.players'), ['alice', 'bob']);
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=open]").click()');
    await approveMiniapp(aliceWindow);
    await waitFor(() => frames(aliceWindow).length === 1, 'reopen from the persistent stage CTA');
    alice = await gameFrame(aliceWindow);
    await waitFor(async () => await alice.executeJavaScript('window.lastState?.count === 1'), 'reopen restores shared state');
    assert.deepEqual(await alice.executeJavaScript('window.lastState.players'), ['alice', 'bob'], 'Opening or closing a view never changes player/spectator roles');
    assert.deepEqual(await alice.executeJavaScript(probeVolume), [0.8, keyboardLevel], 'A reopened view starts at the saved volume of its bot');

    const requestsBefore = leaks;
    await alice.executeJavaScript('window.name = ""; location.href = "file:///not-a-monky-resource"');
    await spectator.executeJavaScript(`(() => {
      const image = new Image(); image.src = ${JSON.stringify(leak + '?image')}; document.body.append(image);
      window.open(${JSON.stringify(leak + '?popup')});
      try { top.location = ${JSON.stringify(leak + '?top')}; } catch {}
    })()`);
    // Wait for the allowed image instead of racing it; blocked navigations then get the same window to show up.
    await waitFor(() => leaks >= requestsBefore + 1, 'the miniapp image request reaches the web');
    const blockedNavigation = await waitForQuiet(() => ({
      aliceUrl: frameUrl(alice),
      ownerUrl: aliceWindow.webContents.getURL(),
      leaks,
      popups,
    }), 'blocked miniapp navigation');
    assert.ok(blockedNavigation.aliceUrl?.startsWith('monky-miniapp:'));
    assert.equal(blockedNavigation.ownerUrl, url);
    assert.equal(blockedNavigation.leaks, requestsBefore + 1, 'Web assets are allowed, application navigation is not');
    assert.equal(blockedNavigation.popups, 0);

    await alice.executeJavaScript(`location.href = ${JSON.stringify(url)}`);
    const privilegedNavigation = await waitForQuiet(() => ({ aliceUrl: frameUrl(alice) }),
      'privileged development-origin navigation remains blocked');
    assert.ok(privilegedNavigation.aliceUrl?.startsWith('monky-miniapp:'),
      'A miniapp cannot navigate into the privileged development origin');
    const destination = `http://localhost:${http.address().port}/__destination`;
    await alice.executeJavaScript(`location.href = ${JSON.stringify(destination)}`);
    let navigated;
    await waitFor(() => {
      navigated = aliceWindow.webContents.mainFrame.frames.find(frame => frameUrl(frame) === destination);
      return !!navigated;
    }, 'ordinary cross-origin web navigation');
    await waitFor(async () => await navigated.executeJavaScript('document.readyState === "complete"'), 'destination loaded');
    assert.equal(await navigated.executeJavaScript(`(() => {
      let parentBlocked = false; try { void parent.document; } catch { parentBlocked = true; }
      return parentBlocked && !window.receivedBridge && !window.monkyScreen && !window.api && !window.require;
    })()`), true, 'The navigated page remains visible without receiving the privileged bridge');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-bot-screen-id=game] iframe")'), true);
    const navigatedToken = await navigated.executeJavaScript('window.navigatedToken = Math.random()');

    await run(aliceWindow, 'document.querySelector(".voice-stage-container").requestFullscreen()');
    await waitFor(async () => await run(aliceWindow, '!!document.fullscreenElement'), 'fullscreen before a delayed focus exit');
    await run(aliceWindow, 'window.screenFixture.deferFullscreenExit(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=focus]").click()');
    await waitFor(async () => await run(aliceWindow, 'window.screenFixture.isFullscreenExitPending()'), 'pending native exit');
    await run(aliceWindow, 'window.screenFixture.browseOtherServer(); window.screenFixture.restoreFullscreenExit()');
    // Browsing another server parks the open view instead of closing it.
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector(".bot-screen-parking [data-bot-screen-id=game] iframe")'), 'switching servers parks the open view');
    assert.equal(await run(aliceWindow, '!document.querySelector(".stage-focus-error") && document.querySelector("#server-name-title").textContent === "Other server"'), true, 'A late fullscreen completion cannot repaint or reopen the retired voice stage');
    assert.equal(await navigated.executeJavaScript('window.navigatedToken'), navigatedToken, 'A parked view keeps even a page it navigated to');
    assert.deepEqual(await run(aliceWindow, `(() => {
      const area = document.querySelector(".bot-screen-parking");
      return [area.hidden, area.inert, area.getAttribute("aria-hidden"), !!document.querySelector("#main-center-stage [data-bot-screen-id]")];
    })()`), [true, true, 'true', false], 'The parked tile waits hidden and inert, outside the server on screen');
    await run(aliceWindow, 'window.screenFixture.backgroundSnapshot()');
    const gameReturn = JSON.stringify('[data-bot-screen-background=game] button');
    await waitFor(async () => await run(aliceWindow, `document.querySelector(${gameReturn})?.getAttribute("aria-label") === "Back to miniapp: Background voice game"`), 'background notice follows the voice room');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-background=game] .screenshare-notice-text").textContent'),
      'Background voice game is still open in the background.');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=game]")'), false, 'An open view is not invited again');
    assert.equal(await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=second]")'), false, 'Background voice updates do not undo another explicit exit');
    assert.equal(await run(aliceWindow, 'document.querySelector("#server-name-title").textContent'), 'Other server');
    assert.equal(await run(aliceWindow, 'window.screenFixture.backgroundNotificationsSafe()'), true);
    assert.equal(await run(aliceWindow, '[...document.querySelectorAll("#screenshare-notice-slot, #bot-screen-background-slot")].some(slot => slot.textContent.includes("WRONG SERVER"))'), false);
    await run(aliceWindow, `document.querySelector(${gameReturn}).click()`);
    await waitFor(async () => await run(aliceWindow, 'document.querySelector("#server-name-title").textContent === "Voice server" && !!document.querySelector("#stage-bot-screens [data-bot-screen-id=game] iframe")'), 'Back to miniapp activates the call server');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), false, 'Coming back is not a new opening: no permission review');
    assert.equal(await navigated.executeJavaScript('window.navigatedToken'), navigatedToken, 'The view comes back without reloading');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("#stage-participants-area .stage-focused-main").length === 1 && !!document.querySelector(".stage-focused-main[data-bot-screen-slot=game]")'), true, 'Back to miniapp arrives focused on it');
    await waitFor(async () => await run(aliceWindow, '!document.querySelector("[data-bot-screen-background]")'), 'the background notice leaves once the view is back');

    await run(aliceWindow, 'window.screenFixture.delayReload(); window.screenFixture.leave(); window.screenFixture.resolveReload()');
    await waitFor(() => !aliceWindow.webContents.mainFrame.frames.some(frame => frameUrl(frame) === destination), 'leave tears down frame immediately');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length'), 0);
    assert.equal(await run(aliceWindow, 'window.screenFixture.cachedScreens()'), 0, 'late responses cannot restore left-room screens');
    assert.equal(await run(aliceWindow, 'window.screenFixture.screenCount()'), 4, 'leave never erases the bot-owned game');
    await run(aliceWindow, 'window.screenFixture.join("voice")');
    await waitFor(async () => await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length === 4'), 'return reloads room invitations');
    assert.equal(frames(aliceWindow).length, 0, 'return still requires consent');
    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]").click()');
    await approveMiniapp(aliceWindow);
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
    assert.equal(await run(aliceWindow, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), false, 'Disconnect cancels a pending consent dialog');
    await run(aliceWindow, 'window.screenFixture.reconnect()');
    await waitFor(async () => await run(aliceWindow, 'document.querySelectorAll("[data-watch-bot-screen]").length === 4'), 'reconnected list');
    assert.equal(frames(aliceWindow).length, 0);
    const endedSnapshot = await run(aliceWindow, 'window.screenFixture.snapshot()');
    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]").click()');
    await approveMiniapp(aliceWindow);
    await waitFor(() => frames(aliceWindow).length === 1, 'authorized frame before END');
    await run(aliceWindow, 'window.screenFixture.delayReload(); window.screenFixture.delayEnd(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").click(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").click()');
    await waitFor(async () => await run(aliceWindow, 'window.screenFixture.endPending()'), 'pending explicit end');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-bot-screen-action=end]").disabled'), true);
    assert.equal(await run(aliceWindow, 'window.screenFixture.sent.filter(entry => entry.type === "BOT_SCREEN_END").length'), 1, 'Duplicate End clicks are coalesced');
    await run(aliceWindow, 'window.screenFixture.resolveEnd(); window.screenFixture.resolveReload()');
    await waitFor(() => frames(aliceWindow).length === 0, 'END destroys the iframe and message ports');
    await waitFor(async () => await run(aliceWindow, '!document.querySelector("[data-bot-screen-id=game], [data-watch-bot-screen=game]") && window.screenFixture.cachedScreens() === 3'), 'END invalidates the stage tile, invitation and delayed list');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), false, 'The local End action does not notify its initiator again');
    const ended = await run(aliceWindow, 'window.screenFixture.lastRemoval()');
    assert.deepEqual(ended, {
      id: 'game', instanceId: endedSnapshot.instanceId, channelId: 'voice', reason: 'ended', endedByUserId: 'alice',
    });
    const spectatorTitle = await run(spectatorWindow, 'window.screenFixture.snapshot().title');
    await run(spectatorWindow, 'document.querySelector("[data-bot-screen-id=game]").requestFullscreen()');
    await run(spectatorWindow, `window.screenFixture.remove(${JSON.stringify(ended)})`);
    await waitFor(() => frames(spectatorWindow).length === 0, 'authoritative removal tears down another viewer');
    await waitFor(async () => await run(spectatorWindow, '!document.fullscreenElement && !!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), 'an ended fullscreen miniapp leaves a visible viewer notice');
    assert.equal(await run(spectatorWindow, 'document.querySelector(".chat-copy-toast:not([data-ui-closing]) .chat-copy-toast-label").textContent'), `The miniapp "${spectatorTitle}" has ended.`);
    assert.equal(await run(spectatorWindow, 'document.querySelector(".chat-copy-toast:not([data-ui-closing])").getAttribute("role")'), 'status');
    await run(spectatorWindow, 'document.querySelector(".chat-copy-toast:not([data-ui-closing])").dataset.noticeMarker = "first"');
    await run(spectatorWindow, `window.screenFixture.remove(${JSON.stringify(ended)})`);
    assert.equal(await run(spectatorWindow, 'document.querySelector(".chat-copy-toast:not([data-ui-closing])").dataset.noticeMarker'), 'first', 'Duplicate delivery cannot replace or restart a notice');
    assert.equal(await run(spectatorWindow, '!!document.querySelector("[data-bot-screen-id=game], [data-watch-bot-screen=game]")'), false);
    const replacement = { ...endedSnapshot, instanceId: 'fresh-instance', createdAt: endedSnapshot.createdAt + 1, revision: 0 };
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(replacement)})`);
    assert.equal(frames(aliceWindow).length, 0, 'A replacement with the same logical ID needs fresh opt-in');
    await run(aliceWindow, 'window.retiredMiniappInvitation = document.querySelector("[data-watch-bot-screen=game]")');
    await run(aliceWindow, 'window.retiredMiniappInvitation.click()');
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), 'pending review for an instance being replaced');
    const currentReplacement = { ...replacement, instanceId: 'current-instance', createdAt: replacement.createdAt + 1 };
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(currentReplacement)})`);
    assert.equal(await run(aliceWindow, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), false, 'Replacing the instance cancels its pending review');
    assert.equal(await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]") !== window.retiredMiniappInvitation'), true, 'Replacing an instance retires its invitation even when the title is unchanged');
    await run(aliceWindow, 'window.retiredMiniappInvitation.click(); delete window.retiredMiniappInvitation');
    assert.equal(await run(aliceWindow, 'document.querySelectorAll("[data-bot-screen-id=game] iframe").length'), 0, 'A stale invitation cannot opt into the new instance');
    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=game]").click()');
    await approveMiniapp(aliceWindow);
    await waitFor(() => frames(aliceWindow).length === 1, 'open new instance');
    const replacementFrame = await gameFrame(aliceWindow);
    await run(aliceWindow, `window.screenFixture.remove(${JSON.stringify(ended)})`);
    assert.equal(await gameFrame(aliceWindow), replacementFrame, 'A late old-instance removal cannot close the replacement');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), false, 'A stale instance cannot produce a viewer notice');
    await run(aliceWindow, 'window.screenFixture.delayEnd(); document.querySelector("[data-bot-screen-id=game] [data-bot-screen-action=end]").click()');
    await waitFor(async () => await run(aliceWindow, 'window.screenFixture.endPending()'), 'background end pending');
    await run(aliceWindow, 'window.screenFixture.browseOtherServer(); window.screenFixture.resolveEnd()');
    await waitFor(async () => await run(aliceWindow, 'window.screenFixture.cachedScreens() === 3'), 'background END reaches the owning store');
    assert.equal(await run(aliceWindow, 'window.screenFixture.otherServerHasGame() && document.querySelector("#server-name-title").textContent === "Other server"'), true, 'Late END never removes another server instance or navigates away');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), false, 'Background teardown does not leak a notice into another server');
    await run(aliceWindow, 'window.screenFixture.setLanguage("pt-BR")');
    const noticeScreen = { ...endedSnapshot, id: 'toast-check', instanceId: 'notice-pt',
      title: '<b>Jogo & aviso</b>', createdAt: endedSnapshot.createdAt + 3, revision: 0 };
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(noticeScreen)})`);
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector("[data-watch-bot-screen=toast-check]")'), 'viewer notice fixture invitation');
    await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=toast-check]").click()');
    await approveMiniapp(aliceWindow);
    await waitFor(() => frames(aliceWindow).length === 1, 'viewer notice fixture opened');
    const noticeEnd = { id: noticeScreen.id, instanceId: noticeScreen.instanceId, channelId: 'voice',
      reason: 'ended', endedByUserId: 'alice' };
    await run(aliceWindow, `window.screenFixture.remove(${JSON.stringify(noticeEnd)})`);
    assert.equal(await run(aliceWindow, 'document.querySelector(".chat-copy-toast:not([data-ui-closing]) .chat-copy-toast-label")?.textContent'),
      `O miniapp "${noticeScreen.title}" foi encerrado.`, 'Another device ending the same account miniapp still notifies this viewer in PT-BR');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".chat-copy-toast:not([data-ui-closing]) b")'), false, 'Miniapp titles cannot inject toast markup');
    await run(aliceWindow, 'window.screenFixture.browseOtherServer()');
    assert.equal(await run(aliceWindow, '!!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), true, 'The notice is about the call: browsing elsewhere keeps it');
    await waitFor(async () => await run(aliceWindow, '!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), 'the notice expires on its own');
    for (const mode of ['invitation-only', 'local-leave', 'bot-closed']) {
      const screen = { ...noticeScreen, instanceId: mode, createdAt: noticeScreen.createdAt + 1 };
      await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(screen)})`);
      if (mode !== 'invitation-only') {
        await run(aliceWindow, 'document.querySelector("[data-watch-bot-screen=toast-check]").click()');
        await approveMiniapp(aliceWindow);
        await waitFor(() => frames(aliceWindow).length === 1, 'non-notifying removal fixture opened');
      }
      if (mode === 'local-leave') {
        await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=toast-check] [data-bot-screen-action=close]").click()');
      }
      const removed = mode === 'bot-closed'
        ? { id: screen.id, instanceId: screen.instanceId, channelId: 'voice', reason: 'closed' }
        : { ...noticeEnd, instanceId: screen.instanceId };
      await run(aliceWindow, `window.screenFixture.remove(${JSON.stringify(removed)})`);
      assert.equal(await run(aliceWindow, '!!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), false, `${mode} does not notify a viewer`);
      await waitFor(() => frames(aliceWindow).length === 0, 'non-notifying fixture teardown');
    }
    await waitFor(async () => await run(spectatorWindow, '!document.querySelector(".chat-copy-toast:not([data-ui-closing])")'), 'viewer notice expires automatically');

    // Lifecycle hooks: the miniapp decides what happens around a close; its person can always leave.
    const hookUrl = `http://127.0.0.1:${http.address().port}/__hook`;
    const reportOnClose = `monkyScreen.onClose(async ({ reason }) => {
        window.hookLog.push('close:' + reason);
        const observed = [reason, window.gameToken, window.audible(), monkyScreen.sendAction('late', {})].join('|');
        await new Promise((resolve) => setTimeout(resolve, window.closeMs));
        await fetch(${JSON.stringify(hookUrl)} + '?' + encodeURIComponent(observed));
      });`;
    const hooksHtml = (withClose) => `<p>Hooks</p><script>
      window.gameId = 'hooks'; window.gameToken = Math.random(); window.hookLog = [];
      window.beforeCloseMode = 'proceed'; window.closeMs = 0;
      const realm = document.createElement('iframe');
      realm.hidden = true;
      document.body.append(realm);
      const nativeVolume = Object.getOwnPropertyDescriptor(realm.contentWindow.HTMLMediaElement.prototype, 'volume').get;
      const probe = new Audio();
      probe.volume = 0.8;
      window.audible = () => Math.round(nativeVolume.call(probe) * 1000) / 1000;
      window.saveAndAnswer = (proceed) => {
        const link = document.createElement('a');
        link.download = 'save-state.json';
        link.href = URL.createObjectURL(new Blob([JSON.stringify({ token: window.gameToken })], { type: 'application/json' }));
        document.body.append(link);
        link.click();
        window.answer(proceed);
      };
      monkyScreen.onBeforeClose(({ reason }) => {
        window.hookLog.push('before:' + reason);
        if (window.beforeCloseMode === 'cancel') return false;
        if (window.beforeCloseMode === 'ask') return new Promise((resolve) => { window.answer = resolve; });
      });
      ${withClose ? reportOnClose : ''}
    </script>`;
    const hooksScreen = (instanceId, createdAt, withClose = true) => ({
      id: 'hooks', instanceId, creatorUserId: 'alice', botId: 'bot', channelId: 'voice', title: 'Hooks',
      revision: 0, createdAt, state: { count: 0 }, html: hooksHtml(withClose),
    });
    const hookTile = '[data-bot-screen-id=hooks]';
    const hookClose = JSON.stringify(`${hookTile} [data-bot-screen-action=close]`);
    const hookEnd = JSON.stringify(`${hookTile} [data-bot-screen-action=end]`);
    const busyHooks = 'document.querySelector("[data-bot-screen-id=hooks]")?.getAttribute("aria-busy") === "true"';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let readyActions = 0;
    const openHooks = async (exclude = []) => {
      const opener = `document.querySelector("[data-watch-bot-screen=hooks]") ?? (document.querySelector("${hookTile} .bot-screen-placeholder")?.hidden === false
        ? document.querySelector("${hookTile} [data-bot-screen-action=open]") : null)`;
      await waitFor(async () => await run(aliceWindow, `!!(${opener})`), 'a way to open hooks');
      await run(aliceWindow, `(${opener}).click()`);
      await approveMiniapp(aliceWindow);
      let opened;
      await waitFor(async () => {
        for (const frame of frames(aliceWindow)) {
          try {
            const [gameId, token] = await frame.executeJavaScript('[window.gameId, window.gameToken]');
            if (gameId === 'hooks' && !exclude.includes(token)) {
              opened = { frame, token };
              return true;
            }
          } catch (error) {
            if (!isDisposedFrameError(error)) throw error;
          }
        }
        return false;
      }, 'hooks frame');
      // An action follows the hook announcement on the same port: once it arrives, the stage knows the hooks.
      const ready = `ready${++readyActions}`;
      await waitFor(async () => await opened.frame.executeJavaScript(`monkyScreen.sendAction(${JSON.stringify(ready)}, {})`), 'hooks bridge connected');
      await waitFor(async () => await run(aliceWindow, `window.screenFixture.actions.some(entry => entry.id === "hooks" && entry.action === ${JSON.stringify(ready)})`), 'hooks announced');
      return opened;
    };
    const waitUntil = async (check, description, timeoutMs) => {
      for (const deadline = Date.now() + timeoutMs; !check(); await sleep(25)) {
        assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      }
    };

    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(hooksScreen('hooks-1', 100))})`);
    let hooks = await openHooks();
    assert.ok(await hooks.frame.executeJavaScript('window.audible()') > 0, 'The probe plays while the view is open');
    await hooks.frame.executeJavaScript('window.beforeCloseMode = "cancel"');
    await run(aliceWindow, `document.querySelector(${hookClose}).click()`);
    await waitFor(async () => await hooks.frame.executeJavaScript('window.hookLog.join()') === 'before:leave', 'onBeforeClose asked about leaving');
    await waitFor(async () => await run(aliceWindow, `!(${busyHooks})`), 'the miniapp answered');
    assert.equal(await hooks.frame.executeJavaScript('window.gameToken'), hooks.token, 'Answering false keeps the same live view');
    assert.equal(await run(aliceWindow, `document.querySelector(${hookClose}).getAttribute("aria-label")`), 'Sair do miniapp');

    // In the filmstrip a frame ignores the pointer, so a pending question brings the miniapp into focus.
    await run(aliceWindow, `document.querySelector("${hookTile} [data-bot-screen-action=focus]").click()`);
    await waitFor(async () => await run(aliceWindow, '!document.querySelector("#stage-participants-area .stage-focused-main")'), 'grid layout');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=second] [data-bot-screen-action=focus]").click()');
    await waitFor(async () => await run(aliceWindow, `document.querySelector("${hookTile}").classList.contains("stage-mini-card")`), 'hooks in the filmstrip');
    await hooks.frame.executeJavaScript('window.beforeCloseMode = "ask"; window.closeMs = 1500');
    await run(aliceWindow, `document.querySelector(${hookClose}).click()`);
    await waitFor(async () => await run(aliceWindow, `${busyHooks} && document.querySelector("${hookTile}").classList.contains("stage-focused-main")`), 'pending question in focus');
    assert.deepEqual(await run(aliceWindow, `(() => {
      const tile = document.querySelector("${hookTile}");
      return [tile.querySelector("[data-bot-screen-action=close]").getAttribute("aria-label"),
        tile.querySelector(".bot-screen-notice").textContent, tile.querySelector("[data-bot-screen-action=end]").disabled];
    })()`), ['Fechar agora', 'Hooks está confirmando antes de fechar.', true], 'A pending question is explained and always escapable');
    await sleep(3500);
    assert.equal(await run(aliceWindow, `${busyHooks} && !!document.querySelector("${hookTile} iframe")`), true, 'A miniapp that answered the request may ask for as long as its person needs');
    await run(aliceWindow, `document.querySelector(${hookClose}).click()`);
    await waitFor(async () => await run(aliceWindow, `!document.querySelector("${hookTile} iframe") && !(${busyHooks})`), 'Close now');
    assert.deepEqual(await run(aliceWindow, `(() => {
      const area = document.querySelector(".bot-screen-holding");
      return [!!area?.querySelector("iframe"), area?.hidden, area?.inert, area?.getAttribute("aria-hidden"),
        !document.querySelector("${hookTile} .bot-screen-placeholder").hidden];
    })()`), [true, true, true, 'true', true], 'The tile closes at once while the document waits off stage, hidden and inert');
    assert.equal(await hooks.frame.executeJavaScript('window.gameToken'), hooks.token, 'Parking keeps the document instead of reloading it');
    assert.equal(await hooks.frame.executeJavaScript('window.hookLog.join()'), 'before:leave,before:leave,close:leave');
    await waitUntil(() => hookEvents.includes(`leave|${hooks.token}|0|false`), 'onClose reports from a muted view without a bridge', 5000);
    await waitUntil(() => frames(aliceWindow).length === 0, 'document released once onClose settles', 3000);

    // End: a false answer keeps the miniapp for everyone; proceeding ends it and reports `end`.
    hooks = await openHooks();
    await hooks.frame.executeJavaScript('window.beforeCloseMode = "cancel"');
    await run(aliceWindow, `document.querySelector(${hookEnd}).click()`);
    await waitFor(async () => await hooks.frame.executeJavaScript('window.hookLog.join()') === 'before:end', 'onBeforeClose asked about ending');
    await waitFor(async () => await run(aliceWindow, `!(${busyHooks})`), 'the end answer');
    assert.equal(await run(aliceWindow, 'window.screenFixture.sent.some(entry => entry.type === "BOT_SCREEN_END" && entry.payload.id === "hooks")'), false, 'Answering false sends no END');
    await hooks.frame.executeJavaScript('window.beforeCloseMode = "proceed"');
    await run(aliceWindow, `document.querySelector(${hookEnd}).click()`);
    await waitUntil(() => hookEvents.includes(`end|${hooks.token}|0|false`), 'END reaches onClose as end', 5000);
    assert.equal(await run(aliceWindow, 'window.screenFixture.sent.filter(entry => entry.type === "BOT_SCREEN_END" && entry.payload.id === "hooks").length'), 1);
    await waitUntil(() => frames(aliceWindow).length === 0, 'ended document released', 3000);

    // A stuck document cannot hold its person: without an acknowledgement the view closes.
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(hooksScreen('hooks-2', 101))})`);
    hooks = await openHooks();
    const busyUntil = await hooks.frame.executeJavaScript('window.busyUntil = Date.now() + 4800; setTimeout(() => { while (Date.now() < window.busyUntil); }, 100); window.busyUntil');
    await sleep(500);
    const askedAt = Date.now();
    await run(aliceWindow, `document.querySelector(${hookClose}).click()`);
    for (const deadline = askedAt + 4500; await run(aliceWindow, `!!document.querySelector("${hookTile} iframe")`); await sleep(25)) {
      assert.ok(Date.now() < deadline, 'A stuck miniapp cannot hold the view open');
    }
    const closedAt = Date.now();
    assert.ok(closedAt - askedAt >= 2800, `The stage first waited for an acknowledgement (${closedAt - askedAt} ms)`);
    assert.ok(closedAt < busyUntil, 'The view closed while its document was still stuck');
    await waitUntil(() => hookEvents.includes(`leave|${hooks.token}|0|false`), 'the recovered document still ran onClose', 6000);
    await waitUntil(() => frames(aliceWindow).length === 0, 'stuck document released', 3000);

    // Revocations never wait for a question; onClose gets its grace period, which survives the stage teardown.
    hooks = await openHooks();
    await hooks.frame.executeJavaScript('window.beforeCloseMode = "ask"; window.closeMs = 60000');
    await run(aliceWindow, `document.querySelector(${hookClose}).click()`);
    await waitFor(async () => await run(aliceWindow, busyHooks), 'a question pending before the revocation');
    await waitFor(async () => await hooks.frame.executeJavaScript('typeof window.answer === "function"'), 'the miniapp is asking');
    const revokedAt = Date.now();
    await run(aliceWindow, 'window.screenFixture.leave()');
    await waitFor(async () => await run(aliceWindow, `!document.querySelector("${hookTile}") && !!document.querySelector(".bot-screen-holding iframe")`), 'leaving the room closes at once');
    assert.equal(await hooks.frame.executeJavaScript('window.hookLog.join()'), 'before:leave,close:revoked', 'The closing document survived the stage teardown');
    assert.equal(await hooks.frame.executeJavaScript('window.gameToken'), hooks.token);
    await waitUntil(() => frames(aliceWindow).length === 0, 'the grace period ends a document whose onClose never settles', 8000);
    assert.ok(Date.now() - revokedAt >= 4500, 'onClose had its grace period');
    assert.equal(hookEvents.some(event => event.startsWith('revoked|')), false, 'An unfinished onClose is cut at the limit');

    // The person saves from inside the miniapp; the download survives even an immediate close (no onClose).
    await run(aliceWindow, 'window.screenFixture.join("voice")');
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(hooksScreen('hooks-3', 102, false))})`);
    hooks = await openHooks();
    const downloads = [];
    const onDownload = (_event, item) => {
      const entry = { name: item.getFilename(), state: 'progressing', path: path.join(app.getPath('userData'), `hooks-download-${downloads.length}.json`) };
      item.setSavePath(entry.path);
      item.once('done', (_done, state) => { entry.state = state; });
      downloads.push(entry);
    };
    aliceWindow.webContents.session.on('will-download', onDownload);
    try {
      await hooks.frame.executeJavaScript('window.beforeCloseMode = "ask"');
      await run(aliceWindow, `document.querySelector(${hookClose}).click()`);
      await waitFor(async () => await hooks.frame.executeJavaScript('typeof window.answer === "function"'), 'the save question');
      await hooks.frame.executeJavaScript('window.saveAndAnswer(true)', true);
      await waitUntil(() => frames(aliceWindow).length === 0, 'closed after saving', 5000);
      await waitUntil(() => downloads[0]?.state === 'completed', 'the download started before closing completes', 5000)
        .catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(downloads)}`); });
      assert.equal(downloads[0].name, 'save-state.json');
      assert.deepEqual(JSON.parse(fs.readFileSync(downloads[0].path, 'utf8')), { token: hooks.token });
    } finally {
      aliceWindow.webContents.session.removeListener('will-download', onDownload);
    }

    // A closing document gives way to a view being opened within the window's two documents.
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(hooksScreen('hooks-4', 103))})`);
    hooks = await openHooks();
    const parkedToken = hooks.token;
    await hooks.frame.executeJavaScript('window.beforeCloseMode = "proceed"; window.closeMs = 60000');
    // The stage closes only after the bridge's hand-off; without it, after a short fallback.
    await run(aliceWindow, 'window.blockHandOff = (event) => { if (event.data?.type === "monky-screen-handoff") event.stopImmediatePropagation(); }; addEventListener("message", window.blockHandOff, true)');
    const proceededAt = Date.now();
    await run(aliceWindow, `document.querySelector(${hookClose}).click()`);
    await sleep(400);
    assert.equal(await run(aliceWindow, `${busyHooks} && !!document.querySelector("${hookTile} iframe")`), true,
      'Agreeing to close waits for the hand-off of downloads the answer may have started');
    await waitFor(async () => await run(aliceWindow, `!document.querySelector("${hookTile} iframe") && !!document.querySelector(".bot-screen-holding iframe")`), 'closing document parked');
    assert.ok(Date.now() - proceededAt >= 900, 'A missing hand-off only delays the close by its fallback');
    await run(aliceWindow, 'removeEventListener("message", window.blockHandOff, true); delete window.blockHandOff');
    hooks = await openHooks([parkedToken]);
    assert.equal(frames(aliceWindow).length, 2, 'Reopening does not wait for the closing document');
    await run(aliceWindow, 'document.querySelector("[data-bot-screen-id=second] [data-bot-screen-action=open]").click()');
    await approveMiniapp(aliceWindow);
    await gameFrame(aliceWindow, 'second');
    const liveTokens = [];
    for (const frame of frames(aliceWindow)) {
      try { liveTokens.push(await frame.executeJavaScript('window.gameToken')); } catch (error) { if (!isDisposedFrameError(error)) throw error; }
    }
    assert.equal(liveTokens.length, 2, 'The closing document was released for the new view');
    assert.equal(liveTokens.includes(parkedToken), false);
    for (const id of ['hooks', 'second']) await run(aliceWindow, `document.querySelector("[data-bot-screen-id=${id}] [data-bot-screen-action=close]").click()`);
    await waitUntil(() => frames(aliceWindow).length === 0, 'both views closed', 3000);

    // Browsing elsewhere keeps an open miniapp: parked off stage, hidden but connected and still playing.
    const parkedHooks = JSON.stringify(`.bot-screen-parking ${hookTile} iframe`);
    const dockedHooks = JSON.stringify(`#stage-bot-screens ${hookTile} iframe`);
    const hooksReturn = JSON.stringify('[data-bot-screen-background=hooks] button');
    const textChannel = 'document.querySelector(".channel-item[data-channel-id=chat]").click()';
    const pressEnter = async (window) => {
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
      });
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
    };
    const watchVisibility = async () => {
      await hooks.frame.executeJavaScript(`window.visibility = []; window.revisions = [];
        monkyScreen.onVisibilityChange((visible) => window.visibility.push(visible));
        monkyScreen.onState((_state, revision) => window.revisions.push(revision));`);
    };
    const visible = async (expected, description) => waitFor(async () =>
      await hooks.frame.executeJavaScript('window.visibility.at(-1)') === expected, description);
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(hooksScreen('hooks-5', 104))})`);
    hooks = await openHooks();
    await watchVisibility();
    assert.deepEqual(await hooks.frame.executeJavaScript('window.visibility'), [true], 'onVisibilityChange answers at once');
    const audible = await hooks.frame.executeJavaScript('window.audible()');
    assert.ok(audible > 0);

    await run(aliceWindow, textChannel);
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${parkedHooks})`), 'a text channel parks the open view');
    await visible(false, 'the miniapp learns it is in the background');
    assert.equal(await hooks.frame.executeJavaScript('window.gameToken'), hooks.token, 'Parking keeps the same document');
    assert.equal(await hooks.frame.executeJavaScript('window.hookLog.join()'), '', 'Browsing is not a close: no hook runs');
    assert.equal(await hooks.frame.executeJavaScript('window.audible()'), audible, 'It keeps playing at the chosen volume');
    assert.deepEqual(await run(aliceWindow, `(() => {
      const row = document.querySelector("[data-bot-screen-background=hooks]");
      const button = row.querySelector("button");
      return [row.querySelector(".screenshare-notice-text").textContent, button.textContent, button.getAttribute("aria-label"),
        !!document.querySelector("[data-watch-bot-screen=hooks]")];
    })()`), ['Hooks continua aberto em segundo plano.', 'Voltar ao miniapp', 'Voltar ao miniapp: Hooks', false],
    'One line per open miniapp, with the way back, instead of a new invitation');
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify({ ...hooksScreen('hooks-5', 104), revision: 1, state: { count: 1 } })})`);
    await waitFor(async () => (await hooks.frame.executeJavaScript('window.revisions')).includes(1), 'state reaches a parked view');
    assert.equal(await hooks.frame.executeJavaScript('monkyScreen.sendAction("parked", {})'), true);
    await waitFor(async () => await run(aliceWindow, 'window.screenFixture.actions.some(entry => entry.id === "hooks" && entry.action === "parked")'), 'a parked view still acts');

    // Back through the notice, from the keyboard: the same document, focused, without a new review.
    // The channel's composer takes focus a few frames after opening; like a person, move back to the notice.
    await waitFor(async () => {
      if (await run(aliceWindow, `!!document.querySelector(${dockedHooks})`)) return true;
      const focused = await run(aliceWindow, `(() => {
        const button = document.querySelector(${hooksReturn});
        button?.focus();
        return !!button && document.activeElement === button;
      })()`);
      if (focused) {
        aliceWindow.webContents.focus();
        await pressEnter(aliceWindow);
      }
      return false;
    }, 'Back to miniapp from the keyboard');
    await waitFor(async () => await run(aliceWindow, '!!document.querySelector(".stage-focused-main[data-bot-screen-slot=hooks]")'), 'back on stage, focused');
    await visible(true, 'back on stage');
    assert.equal(await hooks.frame.executeJavaScript('window.gameToken'), hooks.token);
    assert.equal(await run(aliceWindow, '!!document.querySelector(".modal-backdrop:not([data-ui-closing]) .dialog-card")'), false, 'Coming back needs no new permission review');
    await waitFor(async () => await run(aliceWindow, '!document.querySelector("[data-bot-screen-background]")'), 'the notice leaves once the view is back');

    // Home replaces the whole layout, but not the document.
    await run(aliceWindow, 'window.screenFixture.goHome()');
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${parkedHooks}) && !!document.querySelector(".main-layout--home [data-bot-screen-background=hooks]")`), 'Home parks the open view');
    await visible(false, 'hidden at Home');
    await run(aliceWindow, `document.querySelector(${hooksReturn}).click()`);
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${dockedHooks})`), 'back from Home');
    await visible(true, 'visible after Home');
    assert.equal(await hooks.frame.executeJavaScript('window.gameToken'), hooks.token);

    // Another room's stage previews that room: the call's miniapps wait off stage meanwhile.
    await run(aliceWindow, 'window.screenFixture.viewRoom("other")');
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${parkedHooks}) && !!document.querySelector("[data-bot-screen-background=hooks]")`), 'another room parks the open view');
    await visible(false, 'hidden behind another room');
    await run(aliceWindow, 'window.screenFixture.viewRoom("voice")');
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${dockedHooks})`), 'back to the call room');

    // Cut off by the filmstrip, or a window that is minimized or in the tray, is not visible either.
    await run(aliceWindow, 'document.querySelector("#stage-grid [data-kind=camera]").click()');
    aliceWindow.setContentSize(800, 600);
    await waitFor(async () => await run(aliceWindow, `innerWidth === 800 && document.querySelector("${hookTile}").classList.contains("stage-mini-card")`), 'a narrow filmstrip');
    const strip = '.stage-focused-strip';
    await run(aliceWindow, `document.querySelector("${strip}").scrollLeft = document.querySelector("${strip}").scrollWidth`);
    await visible(true, 'in view at the end of the filmstrip');
    await run(aliceWindow, `document.querySelector("${strip}").scrollLeft = 0`);
    assert.equal(await run(aliceWindow, `document.querySelector("[data-bot-screen-slot=hooks]").getBoundingClientRect().left >= document.querySelector("${strip}").getBoundingClientRect().right`), true, 'Fixture: the miniapp is past the visible strip');
    await visible(false, 'clipped out of the filmstrip');
    await run(aliceWindow, `document.querySelector("${strip}").scrollLeft = document.querySelector("${strip}").scrollWidth`);
    await visible(true, 'scrolled back into view');
    aliceWindow.webContents.send('window:inactive');
    await visible(false, 'a minimized window hides the view');
    aliceWindow.webContents.send('window:active');
    await visible(true, 'a restored window shows it again');
    aliceWindow.setContentSize(1280, 1000);
    const changes = await hooks.frame.executeJavaScript('window.visibility');
    assert.ok(changes.every((value, index) => index === 0 || value !== changes[index - 1]), `Only changes are reported: ${changes.join()}`);

    // Leaving the call from elsewhere revokes the parked view at once; its onClose still runs.
    await hooks.frame.executeJavaScript('window.closeMs = 0');
    await run(aliceWindow, textChannel);
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${parkedHooks})`), 'parked before leaving the call');
    assert.equal(await run(aliceWindow, 'window.screenFixture.leave(); !document.querySelector("[data-bot-screen-background]") && !document.querySelector(".bot-screen-parking [data-bot-screen-id]")'), true,
      'A revoked view leaves no tile or line behind');
    await waitUntil(() => hookEvents.includes(`revoked|${hooks.token}|0|false`), 'a parked view saves on revocation', 5000);
    await waitUntil(() => frames(aliceWindow).length === 0, 'the revoked document is released once onClose settles', 3000);

    // Switching rooms revokes it too.
    await run(aliceWindow, 'window.screenFixture.join("voice")');
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(hooksScreen('hooks-6', 105))})`);
    hooks = await openHooks();
    await run(aliceWindow, textChannel);
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${parkedHooks})`), 'parked before switching rooms');
    await run(aliceWindow, 'window.screenFixture.join("other")');
    await waitUntil(() => hookEvents.includes(`revoked|${hooks.token}|0|false`), 'switching rooms revokes the parked view', 5000);
    await waitUntil(() => frames(aliceWindow).length === 0, 'the old room document is released', 3000);

    // Someone else ending it reaches onClose as ended, with the same notice as on stage.
    await run(aliceWindow, 'window.screenFixture.join("voice")');
    await run(aliceWindow, `window.screenFixture.receive(${JSON.stringify(hooksScreen('hooks-7', 106))})`);
    hooks = await openHooks();
    await run(aliceWindow, textChannel);
    await waitFor(async () => await run(aliceWindow, `!!document.querySelector(${parkedHooks})`), 'parked before ending');
    await run(aliceWindow, `window.screenFixture.remove(${JSON.stringify({ id: 'hooks', instanceId: 'hooks-7', channelId: 'voice', reason: 'ended', endedByUserId: 'remote' })})`);
    await waitUntil(() => hookEvents.includes(`ended|${hooks.token}|0|false`), 'ended while parked', 5000);
    assert.equal(await run(aliceWindow, 'document.querySelector(".chat-copy-toast:not([data-ui-closing]) .chat-copy-toast-label")?.textContent'),
      'O miniapp "Hooks" foi encerrado.', 'A view open in the background still learns it ended');
    await waitUntil(() => frames(aliceWindow).length === 0, 'the ended document is released', 3000);

    for (const window of windows) {
      assert.deepEqual(await run(window, 'window.screenFixture.errors'), [], 'No unhandled renderer lifecycle errors');
      assert.equal(await run(window, 'window.screenFixture.destroy()'), true, 'view and lifecycle listeners are removed');
      await waitFor(() => frames(window).length === 0, 'final teardown');
    }
    assert.deepEqual(nativeErrors, [], 'No native client-log errors during stage lifecycle');
    console.log('Voice stage DOM: creator/admin END, live permission revocation, duplicate/delayed END, shared removal, stale-instance and background isolation; lifecycle hooks (onBeforeClose answers, Close now, stuck documents, muted onClose grace off stage, saves on close); browsing elsewhere (text channel, Home, other server and room parked without reloading, state/actions/audio while parked, visibility, back to miniapp, revoked/ended while parked); existing local leave/watch, fullscreen, locale, seats, sandbox and teardown passed.');
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function verifyVolumeHook() {
  const { installMiniappVolume } = await import('/views/botScreenVolume.ts');
  // A fresh realm stands in for the miniapp document; its pristine copy reads the real output.
  const frame = document.createElement('iframe');
  frame.hidden = true;
  document.body.append(frame);
  const realm = frame.contentWindow;
  const nativeVolume = Object.getOwnPropertyDescriptor(realm.HTMLMediaElement.prototype, 'volume').get;
  const nativeDisconnect = realm.AudioNode.prototype.disconnect;
  const createGain = realm.BaseAudioContext.prototype.createGain;
  const outputs = [];
  realm.BaseAudioContext.prototype.createGain = function () {
    const gain = createGain.call(this);
    outputs.push(gain);
    return gain;
  };
  const setVolume = installMiniappVolume(realm, 0.5);
  const level = element => Math.round(nativeVolume.call(element) * 1000) / 1000;
  const direct = (node, destination) => {
    try { nativeDisconnect.call(node, destination); return true; } catch { return false; }
  };
  const failure = action => {
    try { action(); return null; } catch (error) { return error.name; }
  };
  const result = {};
  const chosen = new realm.Audio();
  chosen.volume = 0.8;
  const quiet = new realm.Audio();
  quiet.volume = 0.25;
  result.chosen = [chosen.volume, level(chosen), quiet.volume, level(quiet)];
  result.errors = [1.5, -0.1, Number.NaN].map(value => failure(() => { chosen.volume = value; }));
  result.afterErrors = [chosen.volume, level(chosen)];
  const played = new realm.Audio();
  void played.play().catch(() => {});
  result.played = [played.volume, level(played)];
  const attached = realm.document.createElement('audio');
  const started = new Promise(resolve => attached.addEventListener('loadstart', resolve, { once: true }));
  attached.src = 'data:,';
  realm.document.body.append(attached);
  await started;
  result.attached = [attached.volume, level(attached)];
  // Native media controls change the volume in the browser, without the patched accessor.
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').set;
  const external = async (element, value) => {
    const changed = new Promise(resolve => element.addEventListener('volumechange', resolve, { once: true }));
    nativeSet.call(element, value);
    await changed;
  };
  await external(attached, 0.3);
  attached.dispatchEvent(new realm.Event('play'));
  result.external = [attached.volume, level(attached)];

  const context = new realm.AudioContext();
  const source = context.createConstantSource();
  result.chained = source.connect(context.destination) === context.destination;
  context.createOscillator().connect(context.destination);
  result.routed = !direct(source, context.destination);
  result.outputs = [outputs.length, outputs[0]?.gain.value];
  source.disconnect(context.destination);
  result.disconnected = failure(() => source.disconnect(context.destination));
  const offline = new realm.OfflineAudioContext(1, 128, 44100);
  const offlineSource = offline.createConstantSource();
  offlineSource.connect(offline.destination);
  result.offline = [direct(offlineSource, offline.destination), outputs.length];
  const graphed = new realm.Audio();
  graphed.volume = 0.6;
  const beforeGraph = level(graphed);
  context.createMediaElementSource(graphed).connect(context.destination);
  result.graphed = [beforeGraph, level(graphed), graphed.volume];

  setVolume(2);
  result.amplified = [level(chosen), level(quiet), level(played), level(attached), level(graphed), outputs[0].gain.value];
  setVolume(0);
  await external(attached, 0.7);
  result.muted = [level(chosen), level(quiet), level(graphed), outputs[0].gain.value, level(attached), attached.volume];
  setVolume(Number.NaN);
  result.ignored = outputs[0].gain.value;
  setVolume(1);
  result.restored = [level(chosen), level(quiet), chosen.volume, outputs[0].gain.value, level(attached)];
  await context.close();
  frame.remove();
  return result;
}

async function setupVoiceStage(id, locale, adminPermission) {
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
      knownMembers: [self, remote], voiceStates: {}, roles: [], userRoles: [], ownerId: 'server-owner', myPermissions: 0xffffffff,
    }, self);
    entry.participants.setUsers([self, remote]);
  };
  seed(session, user, 'Voice server');
  seed(other, { ...user, id: 'foreign-user', sessionId: 'foreign-device' }, 'Other server');
  const screens = new Map(['game', 'second', 'third', 'fourth'].map((screenId) => [screenId, {
    id: screenId, instanceId: `${screenId}-instance`, creatorUserId: 'alice',
    botId: 'bot', channelId: 'voice', title: screenId === 'game' ? 'Voice game <not markup>' : screenId,
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
  let holdEnd = false;
  let resolveEnd;
  let lastRemoval;
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
    if (type === 'BOT_SCREEN_END') {
      sent.push({ type, payload: structuredClone(payload) });
      if (holdEnd) {
        holdEnd = false;
        await new Promise(resolve => { resolveEnd = () => { resolveEnd = undefined; resolve(); }; });
      }
      const screen = screens.get(payload.id);
      if (!screen || screen.instanceId !== payload.instanceId) throw new Error('Screen instance not found.');
      if (id !== screen.creatorUserId && !session.serverStore.isAdminMember(id)) throw new Error('Permission denied.');
      const removed = { id: screen.id, instanceId: screen.instanceId, channelId: screen.channelId, reason: 'ended', endedByUserId: id };
      remove(removed);
      return removed;
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
  const view = new MainView(document.getElementById('app'), { suspend() {}, render() {} });
  const offLanguage = appEvents.on('i18n.language_changed', () => view.render(true));
  // The application, rather than MainView, owns session navigation rendering.
  const offNavigation = appEvents.on('session.changed', ({ key }) => {
    if (key && !sessionManager.isHome() && sessionManager.get(key)?.serverStore.serverDetails) view.render();
  });
  const offNotifications = appEvents.on('voice.bot_screens_updated', () => {
    safeNotifications &&= routing.isForegroundEvent() && routing.currentEventOrigin() === null;
  });
  view.render();
  const receive = (snapshot) => {
    screens.set(snapshot.id, snapshot);
    routing.routeSessionEvent(session.key, 'message.BOT_SCREEN_SNAPSHOT', () => appEvents.emit('message.BOT_SCREEN_SNAPSHOT', snapshot));
  };
  const remove = (removed) => {
    if (screens.get(removed.id)?.instanceId === removed.instanceId) screens.delete(removed.id);
    lastRemoval = removed;
    routing.routeSessionEvent(session.key, 'message.BOT_SCREEN_REMOVED', () => appEvents.emit('message.BOT_SCREEN_REMOVED', removed));
  };
  const join = (channelId) => {
    session.participants.updateVoiceState(state(user, channelId));
    session.participants.updateVoiceState(state(remote, channelId, { isCameraOn: true, isScreenSharing: true, screenShareIds: ['generated-share'] }));
    voiceStore.setChannel(channelId, session.key);
    appEvents.emit('participants.updated');
  };
  window.screenFixture = {
    actions, sent, join, receive, remove, errors,
    lastRemoval: () => structuredClone(lastRemoval),
    otherServerHasGame: () => !!other.botScreenStore.get('game'),
    delayEnd() { holdEnd = true; },
    endPending: () => typeof resolveEnd === 'function',
    resolveEnd() { resolveEnd(); },
    setAdmin(enabled) {
      session.serverStore.roles = enabled ? [{ id: 'admin-role', name: 'Admin', color: null, position: 1, permissions: adminPermission, isDefault: false, createdAt: 1 }] : [];
      session.serverStore.userRoles = enabled ? [{ userId: id, roleIds: ['admin-role'] }] : [];
      session.serverStore.recalculateMyPermissions();
      appEvents.emit('server.roles_updated');
    },
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
    selfLive(enabled) {
      session.participants.updateVoiceState(state(user, 'voice', enabled ? { isScreenSharing: true, screenShareIds: ['own-share'] } : {}));
      appEvents.emit('participants.updated');
    },
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
    goHome() { sessionManager.showHome(); view.render(); },
    // The stage of another room, as its voice chat shows it, without joining that room.
    viewRoom(channelId) { view.voiceStageView.setChannel(channelId); },
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
    async destroy() {
      document.exitFullscreen = nativeExitFullscreen;
      finishFullscreenExit?.();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      offLanguage(); offNavigation(); offNotifications(); view.destroy(); offScreens();
      voiceStore.reset(); await sessionManager.removeAll();
      return listenerCount() === before;
    },
  };
}
