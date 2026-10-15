const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('miniapp storage on this computer follows the person\'s choice, survives the view, pauses autosaves when full and keeps working in onClose', { timeout: 150000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `screen-storage-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SCREEN_STORAGE_PROFILE: profile };
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
  const { BOT_STORAGE_CHANGED, SHORTCUT_IPC, SOUND_DOWNLOAD_IPC } = require('@monky/shared');
  const { bindBotScreenIsolation, installBotScreenRequestGuard } = require('../dist-electron/main/botScreenIsolation.js');
  const { bindBotScreenDocuments, registerBotScreenScheme } = require('../dist-electron/main/botScreenDocuments.js');
  const { BotDeviceStorage } = require('../dist-electron/main/botStorage/BotDeviceStorage.js');
  const { bindBotDeviceStorage } = require('../dist-electron/main/botStorage/ipc.js');
  registerBotScreenScheme();
  app.setPath('userData', process.env.MONKY_SCREEN_STORAGE_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  const nativeErrors = [];
  const storageRoot = path.join(app.getPath('userData'), 'bot-storage');
  const isOwner = contents => !!window && !window.isDestroyed() && window.webContents === contents;
  const owns = event => isOwner(event.sender) && event.senderFrame === event.sender.mainFrame;
  const storage = new BotDeviceStorage(storageRoot, scopeId => {
    if (window && !window.isDestroyed()) window.webContents.send(BOT_STORAGE_CHANGED, scopeId);
  });
  const unbindDocuments = bindBotScreenDocuments(isOwner, storage);
  const unbindStorage = bindBotDeviceStorage(isOwner, storage);
  ipcMain.handle(SHORTCUT_IPC.setPttConfig, event => owns(event));
  ipcMain.handle(SOUND_DOWNLOAD_IPC.defaultFolder, () => null);
  ipcMain.handle('app:set-language', event => owns(event));
  ipcMain.handle('server-host:status', () => ({ isRunning: false, port: null, serverId: null }));
  ipcMain.handle('client-log:write', (event, entry) => {
    if (owns(event) && entry.level === 'ERROR') nativeErrors.push(entry.message);
  });
  const finish = async (code) => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
    if (vite) await vite.close();
    unbindDocuments();
    unbindStorage();
    await storage.dispose();
    app.exit(code);
  };
  const waitFor = async (check, description) => {
    for (let i = 0; i < 250; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${description}`);
  };
  const run = async (script) => {
    try { return await window.webContents.executeJavaScript(script, true); }
    catch (error) {
      console.error('Failed storage renderer snippet:', script.slice(0, 1500));
      throw error;
    }
  };
  const frames = () => window.webContents.mainFrame.frames.filter((frame) => {
    try { return frame.url.startsWith('monky-miniapp:'); } catch { return false; }
  });
  const dialog = '.modal-backdrop:not([data-ui-closing]) .dialog-card';
  const pressEnter = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}),
      });
    }
  };
  /** Opens the view, optionally picks a storage card and approves with a real key press. */
  const openView = async (choice, inspect) => {
    await run('window.storageFixture.open()');
    await waitFor(async () => await run(`!!document.querySelector(${JSON.stringify(`${dialog} [data-action=confirm]`)})`), 'miniapp review');
    if (inspect) await inspect();
    if (choice) await run(`document.querySelector(${JSON.stringify(`${dialog} [data-dialog-choice=${choice}]`)}).click()`);
    await run(`document.querySelector(${JSON.stringify(`${dialog} [data-action=confirm]`)}).focus()`);
    await pressEnter();
    await waitFor(async () => await run(`!document.querySelector(${JSON.stringify(dialog)})`), 'review closes');
    let ready;
    await waitFor(async () => {
      for (const frame of frames()) {
        try {
          if (await frame.executeJavaScript('window.storageReady === true')) { ready = frame; return true; }
        } catch { /* The frame may still be navigating. */ }
      }
      return false;
    }, 'miniapp document with its storage bridge');
    return ready;
  };
  const leaveView = async () => {
    await run('window.storageFixture.view.leave()');
    await waitFor(() => frames().length === 0, 'view released');
  };
  const call = (frame, expression) => frame.executeJavaScript(`Promise.resolve().then(() => ${expression}).then(
    value => ({ value: value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value }),
    error => ({ name: error.name, reason: error.reason ?? null }))`);
  const scopeFolders = () => fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot).filter(name => /^[a-f0-9]{64}$/.test(name)) : [];
  const statusIs = async (frame, status) => waitFor(async () => await frame.executeJavaScript('monkyScreen.storage.status') === status,
    `iframe storage status ${status}`);

  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      resolve: { alias: { '@monky/shared': path.resolve(clientRoot, '..', '..', 'packages', 'shared', 'dist', 'index.js') } },
      optimizeDeps: { include: ['@monky/shared'] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'miniapp-storage-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__storage__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="stage"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    timeout = setTimeout(() => { console.error('Miniapp storage DOM regression timed out'); void finish(1); }, 130000);
    window = new BrowserWindow({
      show: false, width: 1100, height: 900,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: false,
        backgroundThrottling: false, offscreen: true, partition: 'miniapp-storage',
        preload: path.join(clientRoot, 'dist-electron', 'preload', 'preload.js'),
      },
    });
    bindBotScreenIsolation(window.webContents);
    installBotScreenRequestGuard(window.webContents.session);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await window.loadURL(`http://127.0.0.1:${http.address().port}/__storage__`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const setupError = await run(`(${setupStorageStage.toString()})().then(() => null, error => ({ message: String(error), stack: error.stack }))`);
    assert.equal(setupError, null, JSON.stringify(setupError));
    const t = (key, params = {}) => run(`window.storageFixture.t(${JSON.stringify(key)}, ${JSON.stringify(params)})`);

    // 1. The person decides, in the same review that opens the miniapp, with cards rather than radios.
    await run('window.storageFixture.open()');
    await waitFor(async () => await run(`!!document.querySelector(${JSON.stringify(`${dialog} [data-dialog-choice]`)})`), 'storage choice');
    const review = await run(`(() => {
      const card = document.querySelector(${JSON.stringify(dialog)});
      return {
        cards: [...card.querySelectorAll("[data-dialog-choice]")].map(button => [button.dataset.dialogChoice, button.getAttribute("aria-pressed")]),
        group: card.querySelector(".input-mode-cards").getAttribute("role"),
        inputs: card.querySelectorAll("input").length,
        text: card.textContent,
        markup: !!card.querySelector("b, i"),
        focused: document.activeElement?.dataset.action,
      };
    })()`);
    assert.deepEqual(review.cards, [['none', 'true'], ['session', 'false'], ['always', 'false']], 'Nothing is stored unless the person picks it');
    assert.equal(review.group, 'group');
    assert.equal(review.inputs, 0, 'No native radio or checkbox is shown');
    assert.equal(review.markup, false, 'Bot and server names never become markup');
    assert.ok(review.text.includes('NES <b>bot</b>') && review.text.includes(await t('botScreen.storageTitle')) && review.text.includes('50'));
    assert.equal(review.focused, 'cancel', 'Cancel keeps the initial focus');
    await run(`document.querySelector(${JSON.stringify(`${dialog} [data-dialog-choice=always]`)}).focus()`);
    await pressEnter();
    assert.deepEqual(await run(`[...document.querySelectorAll(${JSON.stringify(`${dialog} [data-dialog-choice]`)})].map(button => button.getAttribute("aria-pressed"))`),
      ['false', 'false', 'true'], 'Enter on a card picks it');
    assert.equal(await run(`!!document.querySelector(${JSON.stringify(dialog)})`), true, 'Picking a card does not confirm the review');
    assert.equal(frames().length, 0, 'Nothing runs before the confirmation');
    await run(`document.querySelector(${JSON.stringify(`${dialog} [data-action=cancel]`)}).click()`);
    await waitFor(async () => await run(`!document.querySelector(${JSON.stringify(dialog)})`), 'cancelled review');
    assert.equal(await run('window.api.botStorage.get(window.storageFixture.scope).then(entry => entry.decision)'), 'ask',
      'Cancelling remembers nothing');
    assert.deepEqual(scopeFolders(), [], 'Asking writes nothing to disk');

    // 2. "Only this session" grants the open view; data lives in the profile, outside the miniapp origin.
    let frame = await openView('session');
    await statusIs(frame, 'granted');
    assert.deepEqual(await frame.executeJavaScript('window.statuses'), ['unavailable', 'granted'], 'onStatus reports the answer once connected');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/slot-1", new Uint8Array([1, 2, 3]))'), { value: true });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/slot-1")'), { value: [1, 2, 3] });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/notes", "olá")'), { value: true });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/notes")'), { value: 'olá' });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/missing")'), { value: null });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.list({ prefix: "nes/game/" }).then(keys => keys.map(entry => [entry.key, entry.size]))'),
      { value: [['nes/game/notes', 4], ['nes/game/slot-1', 3]] });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("../outside")'), { name: 'MonkyStorageError', reason: 'invalid' });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("a", { not: "bytes" })'), { name: 'TypeError', reason: null });
    const folders = scopeFolders();
    assert.equal(folders.length, 1, 'Folders never use server, account or bot names');
    const [scopeDir] = folders;
    assert.equal(fs.readdirSync(path.join(storageRoot, scopeDir, 'objects')).length, 2);
    assert.equal(await run('window.storageFixture.badge().hidden'), true, 'No warning while there is room');

    // 3. A change in the bot settings applies to the open view at once.
    await run('window.api.botStorage.setDecision(window.storageFixture.scope, "never")');
    await statusIs(frame, 'denied');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/slot-1")'), { name: 'MonkyStorageError', reason: 'denied' });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/auto", "x", { autosave: true })'), { value: false },
      'An autosave that is not allowed fails silently');
    await run('window.api.botStorage.setDecision(window.storageFixture.scope, "ask")');
    await statusIs(frame, 'granted');
    assert.deepEqual(await frame.executeJavaScript('window.statuses'), ['unavailable', 'granted', 'denied', 'granted']);

    // 4. Full storage: manual saves fail, autosaves pause, and Monky (not the app) warns on the tile.
    await run('window.api.botStorage.setQuota(window.storageFixture.scope, 1024 * 1024)');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/big", new Uint8Array(950000))'), { value: true });
    await waitFor(async () => await run('window.storageFixture.badge().dataset.level === "near_full" && !window.storageFixture.badge().hidden'), 'near-full badge');
    assert.equal(await run('window.storageFixture.badge().lastElementChild.textContent'), await t('botScreen.storageNearFull'));
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/auto", new Uint8Array(200000), { autosave: true })'), { value: false });
    await waitFor(async () => await run('window.storageFixture.badge().dataset.level === "full"'), 'full badge');
    assert.equal(await run('window.storageFixture.badge().lastElementChild.textContent'), await t('botScreen.storageFull'));
    assert.ok((await run('window.storageFixture.badge().getAttribute("aria-label")')).includes(await t('botScreen.storageBadgeHint')));
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/slot-2", new Uint8Array(200000))'),
      { name: 'MonkyStorageError', reason: 'quota' }, 'A save the person asked for reports the failure');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/huge", new Uint8Array(4 * 1024 * 1024 + 1))'),
      { name: 'MonkyStorageError', reason: 'too_large' });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.delete("nes/game/big")'), { value: true });
    await waitFor(async () => await run('window.storageFixture.badge().hidden'), 'badge clears with room again');
    // Server storage is part of the same warning, for this bot only.
    await run('window.storageFixture.serverLevel("other-bot", "full")');
    assert.equal(await run('window.storageFixture.badge().hidden'), true, 'Another bot\'s storage does not warn here');
    await run('window.storageFixture.serverLevel("nes-bot", "near_full")');
    await waitFor(async () => await run('!window.storageFixture.badge().hidden && window.storageFixture.badge().dataset.level === "near_full"'), 'server badge');
    assert.ok((await run('window.storageFixture.badge().title')).includes(await t('botScreen.storageServerDetail', { used: '95 MB', total: '100 MB' })));
    await run('window.storageFixture.serverLevel("nes-bot", "ok")');
    await waitFor(async () => await run('window.storageFixture.badge().hidden'), 'server badge clears');

    // 5. Leaving ends a session grant, but never deletes what was stored.
    await leaveView();
    assert.equal(await run('window.storageFixture.badge().hidden'), true);
    frame = await openView();
    await statusIs(frame, 'denied');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/slot-1")'), { name: 'MonkyStorageError', reason: 'denied' });
    await leaveView();
    assert.equal(fs.readdirSync(path.join(storageRoot, scopeDir, 'objects')).length, 2, 'Saying no keeps earlier data on disk');

    // 6. "Always" is remembered: the next review only says so, and the data is still there.
    frame = await openView('always');
    await statusIs(frame, 'granted');
    assert.equal(await run('window.api.botStorage.get(window.storageFixture.scope).then(entry => entry.decision)'), 'always');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/slot-1")'), { value: [1, 2, 3] });
    await leaveView();
    await run('window.storageFixture.open()');
    await waitFor(async () => await run(`!!document.querySelector(${JSON.stringify(`${dialog} .dialog-note`)})`), 'remembered decision note');
    assert.equal(await run(`document.querySelectorAll(${JSON.stringify(`${dialog} [data-dialog-choice]`)}).length`), 0);
    assert.ok((await run(`document.querySelector(${JSON.stringify(`${dialog} .dialog-note`)}).textContent`)).includes('NES <b>bot</b>'));
    await run(`document.querySelector(${JSON.stringify(`${dialog} [data-action=cancel]`)}).click()`);
    await waitFor(async () => await run(`!document.querySelector(${JSON.stringify(dialog)})`), 'cancelled review');

    // 6b. Someone who cannot manage bots: their own computer works, and nothing about the server shows on the card.
    await run('window.storageFixture.setServerVisible(false)');
    frame = await openView();
    await statusIs(frame, 'granted');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/slot-1")'), { value: [1, 2, 3] });
    await run('window.storageFixture.serverLevel("nes-bot", "full")');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await run('window.storageFixture.badge().hidden'), true, 'No server warning reaches people who cannot manage bots');
    await leaveView();
    await run('window.storageFixture.setServerVisible(true)');

    // 7. Without the administrator's permission there is nothing to ask and no storage at all.
    await run('window.storageFixture.setDeviceGranted(false)');
    frame = await openView(null, async () => {
      assert.equal(await run(`document.querySelectorAll(${JSON.stringify(`${dialog} [data-dialog-choice], ${dialog} .dialog-note`)}).length`), 0);
    });
    assert.equal(await frame.executeJavaScript('monkyScreen.storage.status'), 'unavailable');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/slot-1")'), { name: 'MonkyStorageError', reason: 'unavailable' });
    assert.deepEqual(await call(frame, 'monkyScreen.storage.set("nes/game/auto", "x", { autosave: true })'), { value: false });
    await leaveView();

    // 8. If "Sempre" cannot be remembered (a full disk, for instance), the miniapp still opens with storage for this view.
    await run('window.storageFixture.setDeviceGranted(true)');
    await run('window.api.botStorage.setDecision(window.storageFixture.scope, "ask")');
    storage.setDecision = async () => { throw new Error('Simulated full disk'); };
    try {
      frame = await openView('always');
      await statusIs(frame, 'granted');
      assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/slot-1")'), { value: [1, 2, 3] });
      assert.equal(await run('window.api.botStorage.get(window.storageFixture.scope).then(entry => entry.decision)'), 'ask',
        'Nothing was remembered');
      await leaveView();
    } finally {
      delete storage.setDecision;
    }
    await run('window.storageFixture.open()');
    await waitFor(async () => await run(`!!document.querySelector(${JSON.stringify(`${dialog} [data-dialog-choice]`)})`),
      'the next opening asks again');
    await run(`document.querySelector(${JSON.stringify(`${dialog} [data-action=cancel]`)}).click()`);
    await waitFor(async () => await run(`!document.querySelector(${JSON.stringify(dialog)})`), 'cancelled review');

    // 9. Saving on close, as the NES does: onClose runs hidden and cut from state and actions, but storage keeps
    // answering, and a session grant lasts until the document is released after onClose settles.
    frame = await openView('session');
    await statusIs(frame, 'granted');
    assert.equal(await frame.executeJavaScript(`monkyScreen.onClose(async ({ reason }) => {
      // The second save starts only once the first reply reached the closing document.
      await monkyScreen.storage.set("nes/game/autosave", new Uint8Array([9, 9, 9]), { autosave: true });
      await monkyScreen.storage.set("nes/game/closed", reason);
    }); true`), true);
    // Port messages keep their order: once this reply arrives, the stage knows about the hook.
    assert.deepEqual(await call(frame, 'monkyScreen.storage.usage().then(usage => usage !== null)'), { value: true });
    const leftAt = Date.now();
    assert.equal(await run('window.storageFixture.view.leave("leave"); !!document.querySelector(".bot-screen-holding iframe")'), true,
      'The closing view is kept off stage for its onClose');
    await waitFor(() => frames().length === 0, 'document released once onClose settles');
    assert.ok(Date.now() - leftAt < 4000, 'onClose settled instead of running into the 5-second limit');
    frame = await openView('session');
    await statusIs(frame, 'granted');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/autosave")'), { value: [9, 9, 9] }, 'The autosave in onClose landed');
    assert.deepEqual(await call(frame, 'monkyScreen.storage.get("nes/game/closed")'), { value: 'leave' }, 'Its reply reached the closing document');
    await leaveView();

    const errors = await run('window.storageFixture.errors');
    assert.deepEqual(errors, [], 'No uncaught renderer errors');
    assert.deepEqual(nativeErrors, []);
    assert.equal(await run('window.storageFixture.destroy()'), true, 'Every listener is released');
    console.log('Miniapp storage DOM regression passed');
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function setupStorageStage() {
  const errors = [];
  window.addEventListener('error', event => errors.push(event.message));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  const [{ sessionManager }, { voiceStore }, { appEvents }, routing, language, { BotScreenView }, { getBotVoiceContext }] = await Promise.all([
    import('/core/SessionManager.ts'), import('/stores/voiceStore.ts'), import('/core/EventBus.ts'), import('/core/sessionRouting.ts'),
    import('/i18n/index.ts'), import('/views/BotScreenView.ts'), import('/utils/botVoice.ts'),
  ]);
  language.setLanguage('pt-BR');
  sessionManager.install();
  const session = sessionManager.create('storage', 7890, 'alice');
  const user = { id: 'alice', clientId: 'alice', sessionId: 'alice-device', nickname: 'Alice', status: 'ONLINE', joinedAt: 1 };
  const bot = { id: 'nes-bot', clientId: 'nes-bot', sessionId: 'nes-bot-device', nickname: 'NES <b>bot</b>', status: 'ONLINE', joinedAt: 1 };
  session.serverStore.setServerDetails({
    id: 'server-id', name: 'Storage <i>server</i>', createdAt: 1, maxUsers: 10,
    channels: [{ id: 'voice', serverId: 'server-id', name: 'voice', type: 'VOICE', position: 0, createdAt: 1 }],
    members: [user], knownMembers: [user, bot], voiceStates: {}, roles: [], userRoles: [], ownerId: 'owner', myPermissions: 0xffffffff,
    protocol: { version: 39, minimumVersion: 35, features: ['bot-storage'] },
  }, user);
  session.participants.setUsers([user]);
  session.participants.updateVoiceState({
    sessionId: user.sessionId, userId: user.id, channelId: 'voice', isMuted: false, isDeafened: false, isSpeaking: false,
    isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false, serverMuted: false, serverDeafened: false,
  });
  const MIB = 1024 * 1024;
  const usage = (level, usedBytes = 0) => ({ usedBytes, maxBytes: 100 * MIB, objectCount: usedBytes ? 1 : 0, maxObjects: 10000, level });
  let deviceGranted = true;
  // Only people who manage bots receive the server part.
  let serverVisible = true;
  session.client.getStatus = () => 'CONNECTED';
  session.client.getCurrentServerUrl = () => 'ws://127.0.0.1:7890';
  session.client.send = () => {};
  session.client.sendRequest = async (type, payload) => {
    if (type === 'BOT_STORAGE_INFO_GET' && payload.botId === 'nes-bot') {
      return {
        botId: 'nes-bot', server: serverVisible ? { requested: true, granted: true, usage: usage('ok') } : null,
        device: { requested: true, granted: deviceGranted },
      };
    }
    throw new Error(`Unexpected request: ${type}`);
  };
  voiceStore.setChannel('voice', session.key);
  sessionManager.activate(session.key);
  const listenerCount = () => [...appEvents.listeners.values()].reduce((sum, entries) => sum + entries.size, 0);
  const before = listenerCount();
  const screen = {
    id: 'nes', instanceId: 'nes-instance', creatorUserId: 'alice', botId: 'nes-bot', channelId: 'voice', title: 'NES',
    revision: 0, createdAt: 1, state: {},
    html: `<p>NES</p><script>
      window.statuses = [];
      monkyScreen.storage.onStatus(status => window.statuses.push(status));
      window.storageReady = true;
    </script>`,
  };
  const stage = document.getElementById('stage');
  stage.style.cssText = 'position: relative; width: 720px; height: 460px; display: flex;';
  const view = new BotScreenView(screen, getBotVoiceContext(), () => {}, () => {}, () => {}, () => {});
  view.setLayout(true, false);
  stage.append(view.element);
  window.storageFixture = {
    view, errors,
    scope: {
      serverUrl: 'ws://127.0.0.1:7890', serverId: 'server-id', serverName: 'Storage <i>server</i>', userId: 'alice',
      botId: 'nes-bot', botName: 'NES <b>bot</b>',
    },
    t: language.t,
    open() { void view.open(); },
    badge: () => view.element.querySelector('.bot-screen-storage-badge'),
    setDeviceGranted(value) { deviceGranted = value; },
    setServerVisible(value) { serverVisible = value; },
    serverLevel(botId, level) {
      const event = { botId, usage: usage(level, level === 'ok' ? 0 : 95 * MIB) };
      routing.routeSessionEvent(session.key, 'message.BOT_STORAGE_LEVEL', () => appEvents.emit('message.BOT_STORAGE_LEVEL', event));
    },
    async destroy() {
      view.destroy();
      voiceStore.reset();
      await sessionManager.removeAll();
      return listenerCount() <= before;
    },
  };
}
