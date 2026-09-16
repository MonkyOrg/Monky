const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  test('branded Main-owned consent, disclosure, real progress states and cancellation', { timeout: 120000 }, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-preparation-dialog-'));
    const env = { ...process.env, MONKY_PREPARATION_DIALOG_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], {
          cwd: clientRoot, env, stdio: 'inherit', timeout: 110000,
        });
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { LOCAL_PREPARATION_DIALOG_IPC } = require('@monky/shared');
  const main = path.join(clientRoot, 'dist-electron', 'main');
  const { LocalExecutionService } = require(path.join(main, 'localExecution', 'service.js'));
  const { LocalExecutionDialogs } = require(path.join(main, 'localExecution', 'dialogs.js'));
  const { LocalPermissions } = require(path.join(main, 'localExecution', 'LocalPermissions.js'));
  const { LocalExecutionError } = require(path.join(main, 'localExecution', 'errors.js'));
  const { setMainLanguage, mt } = require(path.join(main, 'i18n.js'));
  app.setPath('userData', process.env.MONKY_PREPARATION_DIALOG_PROFILE);
  app.on('window-all-closed', () => {});
  const handlers = new Map();
  const handle = ipcMain.handle.bind(ipcMain);
  const remove = ipcMain.removeHandler.bind(ipcMain);
  const show = BrowserWindow.prototype.show;
  const showRequests = new Set();
  // Parenting offscreen BrowserWindows crashes Electron on Windows even without
  // Monky. Keep real native modal windows and suppress only their visibility.
  BrowserWindow.prototype.show = function () { showRequests.add(this.id); };
  ipcMain.handle = (channel, callback) => { handlers.set(channel, callback); handle(channel, callback); };
  ipcMain.removeHandler = channel => { handlers.delete(channel); remove(channel); };
  const fixtures = [];
  const releasePending = [];
  let parent;

  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const until = async (condition, description) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await condition();
      if (result) return result;
      await delay(10);
    }
    throw new Error(`Preparation UI timed out: ${description}`);
  };
  const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);
  const click = (window, id) => evaluate(window, `document.getElementById(${JSON.stringify(id)}).click()`);
  const phase = (window, expected) => until(
    () => !window.isDestroyed() && evaluate(window, `document.body.dataset.phase === ${JSON.stringify(expected)}`), expected);
  const dialog = async () => {
    const window = await until(() => BrowserWindow.getAllWindows().find(candidate => candidate !== parent), 'dialog creation');
    await until(() => !window.isDestroyed() && evaluate(window,
      'document.getElementById("allow")?.disabled === false'), 'trusted preload readiness');
    await until(() => showRequests.has(window.id), 'production visibility request');
    return window;
  };
  const settled = promise => {
    const result = { done: false, promise };
    void promise.then(() => { result.done = true; }, () => { result.done = true; });
    return result;
  };
  const fixture = async (unsafeIdentity = false) => {
    const number = fixtures.length;
    const subject = {
      connectionId: `connection-${number}`, serverOrigin: 'wss://example.invalid', serverId: 'server',
      serverName: unsafeIdentity ? 'Server <script>unexpected()</script>' : 'Monky - QA local', botId: `bot-${number}`,
      botName: unsafeIdentity ? 'MonkyBot <img src=x onerror=unexpected()>' : 'MonkyBot', botPublicKey: 'a'.repeat(64),
    };
    const inventory = {
      maximumCacheBytes: 512 * 1024 ** 2,
      tools: ['node', 'yt-dlp', 'ffmpeg'].map(id => ({
        maximumAdditionalBytes: (id === 'ffmpeg' ? 700 : 350) * 1024 ** 2,
        info: { id, status: 'absent', version: null, sizeBytes: 0, sourceUrl: null, requiredBy: [], progress: null, failure: null },
      })),
    };
    let prepare = async () => undefined;
    let preparationCalls = 0;
    const tools = {
      initialize: async () => undefined,
      snapshot: async () => ({
        supported: true, tools: structuredClone(inventory.tools.map(tool => tool.info)),
        toolsBytes: inventory.tools.reduce((sum, tool) => sum + tool.info.sizeBytes, 0), cacheBytes: 0,
      }),
      preparationInfo: () => structuredClone(inventory),
      prepare: async (signal, retryCleanup) => {
        preparationCalls++;
        await prepare(signal, retryCleanup);
        signal.throwIfAborted();
        return { node: 'fixture-node', ytDlp: 'fixture-extractor', ffmpeg: 'fixture-ffmpeg' };
      },
      remove: async () => undefined, clearCache: async () => undefined, dispose: async () => undefined,
    };
    const dialogs = new LocalExecutionDialogs(parent, tools);
    const permissions = new LocalPermissions(path.join(app.getPath('userData'), `permissions-${number}.json`));
    const service = new LocalExecutionService({
      owner: parent.webContents.id, tools, permissions, dialogs,
      createRuntime: async () => { throw new Error('A consent dialog must never start a media task'); },
      changed: () => dialogs.toolsChanged(), failed: () => assert.fail('No stream exists'),
      logError: (message, error) => console.log('Expected UI failure:', message, error.reason),
    });
    await service.setConnection({ connectionId: subject.connectionId, connected: true, voiceChannelId: 'voice' });
    const result = {
      service, permissions, dialogs, subject, inventory, tools,
      calls: () => preparationCalls,
      prepare: (requestId = `request-${number}`) => service.prepare({ requestId, subject, capability: 'youtube-audio' }),
      setPrepare: operation => { prepare = operation; },
      ready: () => {
        for (const tool of inventory.tools) {
          Object.assign(tool.info, { status: 'ready', version: '1.2.3', sizeBytes: 10 * 1024 ** 2, progress: null });
          tool.maximumAdditionalBytes = 0;
        }
        dialogs.toolsChanged();
      },
    };
    fixtures.push(result);
    return result;
  };
  const screenshot = async (window, name) => {
    const directory = process.env.MONKY_PREPARATION_DIALOG_SCREENSHOTS;
    if (!directory) return;
    assert.ok(path.isAbsolute(directory));
    fs.mkdirSync(directory, { recursive: true });
    await evaluate(window, 'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    fs.writeFileSync(path.join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const audit = async (window, unsafeIdentity = false) => {
    const prefs = window.webContents.getLastWebPreferences();
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(window.getParentWindow(), parent);
    assert.equal(window.isModal(), true);
    assert.equal(window.isVisible(), false);
    assert.equal(await evaluate(window, 'typeof window.api + ":" + typeof window.require'), 'undefined:undefined');
    assert.equal(await evaluate(window, '!!document.querySelector("script, img[src=x], input[type=checkbox], input[type=radio]")'), false);
    assert.equal(await evaluate(window, 'document.body.textContent.includes("<img src=x")'), unsafeIdentity);
    assert.throws(() => handlers.get(LOCAL_PREPARATION_DIALOG_IPC.action)({
      sender: parent.webContents, senderFrame: parent.webContents.mainFrame,
    }, 'always'), { reason: 'invalid_request' });
    assert.throws(() => handlers.get(LOCAL_PREPARATION_DIALOG_IPC.action)({
      sender: window.webContents, senderFrame: {},
    }, 'always'), { reason: 'invalid_request' });
    assert.equal(await evaluate(window, `Array.from(document.querySelectorAll('[data-tool]')).length`), 3);
    assert.equal(await evaluate(window, `document.querySelector('.footer').getBoundingClientRect().bottom <= innerHeight`), true);
    assert.equal(await evaluate(window, `document.getElementById('always-choice').getBoundingClientRect().bottom < document.getElementById('allow').getBoundingClientRect().top`), true);
    assert.equal(await evaluate(window, `getComputedStyle(document.body).backgroundColor`), 'rgb(22, 27, 34)');
    assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('.content'), '::-webkit-scrollbar').width`), '6px');
    assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('.content'), '::-webkit-scrollbar-thumb').backgroundColor`), 'rgb(47, 56, 70)');
    assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('.content'), '::-webkit-scrollbar-track').backgroundColor`), 'rgba(0, 0, 0, 0)');
    assert.equal(await evaluate(window, 'document.activeElement.id'), 'title',
      'Initial focus describes the prerequisite instead of highlighting a consent decision');
    assert.equal(await evaluate(window, 'document.getElementById("deny").matches(":focus-visible")'), false);
    assert.equal(await evaluate(window, 'getComputedStyle(document.getElementById("deny")).outlineStyle'), 'none');
    assert.equal(await evaluate(window, 'document.getElementById("retry").hidden'), true);
    assert.throws(() => handlers.get(LOCAL_PREPARATION_DIALOG_IPC.action)({
      sender: window.webContents, senderFrame: window.webContents.mainFrame,
    }, 'retry'), { reason: 'invalid_request' }, 'Retry cannot bypass initial consent');
  };

  const run = async () => {
    parent = new BrowserWindow({
      show: false, width: 1100, height: 950, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    await parent.loadURL('data:text/html,<html><body>Isolated preparation owner</body></html>');
    for (const language of ['pt-BR', 'en']) {
      setMainLanguage(language);
      const denied = await fixture(true);
      const denying = denied.prepare();
      const denial = await dialog();
      await audit(denial, true);
      await evaluate(denial, 'document.getElementById("allow").focus()');
      denial.webContents.focus();
      for (const type of ['keyDown', 'keyUp']) denial.webContents.sendInputEvent({ type, keyCode: 'Tab', modifiers: ['shift'] });
      await until(() => evaluate(denial, 'document.activeElement.id === "deny"'), 'keyboard focus on Deny');
      assert.equal(await evaluate(denial, 'getComputedStyle(document.getElementById("deny")).outlineWidth'), '2px',
        'Keyboard navigation must retain a visible focus indicator');
      await click(denial, 'deny');
      assert.deepEqual(await denying, { status: 'failed', reason: 'permission_denied' });
      assert.equal(denied.calls(), 0);
      assert.equal((await denied.permissions.list())[0].decision, 'deny');
      assert.equal(handlers.size, 0);

      const f = await fixture();
      const release = deferred();
      f.setPrepare(async () => release.promise);
      const pending = settled(f.prepare());
      const window = await dialog();
      await audit(window);
      await screenshot(window, `local-consent-${language}`);
      assert.equal(f.calls(), 0);
      if (language === 'en') {
        await evaluate(window, 'document.getElementById("connection-choice").focus()');
        window.webContents.focus();
        for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode: 'Right' });
        await until(() => evaluate(window, 'document.getElementById("always-choice").getAttribute("aria-checked") === "true"'), 'keyboard choice');
      }
      await click(window, 'allow');
      await phase(window, 'installing');
      assert.equal(pending.done, false);
      assert.deepEqual(await f.permissions.list(), []);
      assert.equal(f.calls(), 1);
      assert.throws(() => handlers.get(LOCAL_PREPARATION_DIALOG_IPC.action)({
        sender: window.webContents, senderFrame: window.webContents.mainFrame,
      }, 'always'), { reason: 'invalid_request' });
      const tool = f.inventory.tools[0].info;
      tool.status = 'installing';
      tool.progress = { stage: 'downloading', downloadedBytes: 25 * 1024 ** 2, totalBytes: 100 * 1024 ** 2 };
      f.dialogs.toolsChanged();
      await until(() => evaluate(window, 'document.getElementById("progress").getAttribute("aria-valuenow") === "25"'), 'byte percentage');
      assert.equal(await evaluate(window, 'document.getElementById("progress-fill").style.width'), '25%');
      await until(() => evaluate(window, `Math.abs(document.getElementById('progress-fill').getBoundingClientRect().width /
        document.getElementById('progress').getBoundingClientRect().width - .25) < .005`), 'painted byte percentage');
      assert.ok((await evaluate(window, 'document.getElementById("detail").textContent')).includes('25 MB'));
      assert.equal(await evaluate(window, 'document.getElementById("progress").getBoundingClientRect().bottom < document.getElementById("cancel").getBoundingClientRect().top'), true,
        'The progress bar must remain visible above the actions, not clipped in the scrollable content');
      await screenshot(window, `local-installation-${language}`);
      for (const stage of ['verifying', 'extracting', 'checking']) {
        tool.progress = { stage, downloadedBytes: 100 * 1024 ** 2, totalBytes: 100 * 1024 ** 2 };
        f.dialogs.toolsChanged();
        await until(() => evaluate(window, '!document.getElementById("progress").hasAttribute("aria-valuenow")'), stage);
        assert.equal(pending.done, false);
        assert.equal(window.isDestroyed(), false);
      }
      tool.progress = { stage: 'downloading', downloadedBytes: 5, totalBytes: null };
      f.dialogs.toolsChanged();
      await until(() => evaluate(window, 'document.getElementById("progress").classList.contains("indeterminate")'), 'unknown download total');
      f.ready();
      release.resolve();
      const prepared = await pending.promise;
      assert.equal(prepared.status, 'prepared');
      assert.match(prepared.permit, /^[a-f0-9]{64}$/);
      const permission = (await f.permissions.list())[0];
      assert.equal(permission.decision, language === 'en' ? 'always' : 'connection');
      assert.equal(window.isDestroyed(), true);
      assert.equal(handlers.size, 0);
      assert.equal((await f.prepare('same-binding-again')).permit, prepared.permit);
      assert.equal(BrowserWindow.getAllWindows().length, 1, 'Existing authorization must not show another consent dialog');

      await f.service.setPermission({ permissionId: permission.id, enabled: false });
      const reenabling = f.service.setPermission({ permissionId: permission.id, enabled: true });
      const enabledWindow = await dialog();
      assert.equal(await evaluate(enabledWindow, 'document.getElementById("choices").hidden'), true);
      assert.ok((await evaluate(enabledWindow, 'document.getElementById("storage").textContent')).includes('30 MB'));
      await click(enabledWindow, 'allow');
      assert.deepEqual(await reenabling, { status: 'completed' });
      assert.equal((await f.permissions.list())[0].decision, 'always');

      const failed = await fixture();
      failed.setPrepare(async () => { throw new LocalExecutionError('storage_failed'); });
      const failing = settled(failed.prepare());
      const failureWindow = await dialog();
      await click(failureWindow, 'allow');
      await phase(failureWindow, 'failed');
      assert.equal(failing.done, false);
      assert.deepEqual(await failed.permissions.list(), []);
      assert.equal(await evaluate(failureWindow, 'document.getElementById("detail").textContent'), mt('localExecution.installStorageFailed'));
      await screenshot(failureWindow, `local-installation-failed-${language}`);
      await click(failureWindow, 'dismiss');
      assert.deepEqual(await failing.promise, { status: 'failed', reason: 'storage_failed' });
      assert.equal(handlers.size, 0);

      const retried = await fixture();
      const interrupted = deferred();
      retried.setPrepare(async () => {
        const installed = retried.inventory.tools[0];
        Object.assign(installed.info, { status: 'ready', version: '1.2.3', sizeBytes: 10 * 1024 ** 2 });
        installed.maximumAdditionalBytes = 0;
        const downloading = retried.inventory.tools[1].info;
        downloading.status = 'installing';
        downloading.progress = { stage: 'downloading', downloadedBytes: 25, totalBytes: 100 };
        retried.dialogs.toolsChanged();
        await interrupted.promise;
        downloading.status = 'failed';
        downloading.progress = null;
        throw new LocalExecutionError('provider_unavailable');
      });
      const retrying = settled(retried.prepare());
      const retryWindow = await dialog();
      if (language === 'en') await click(retryWindow, 'always-choice');
      await click(retryWindow, 'allow');
      await phase(retryWindow, 'installing');
      await until(() => evaluate(retryWindow, 'document.getElementById("progress").getAttribute("aria-valuenow") === "25"'), 'interrupted download');
      interrupted.resolve();
      await phase(retryWindow, 'failed');
      assert.equal(await evaluate(retryWindow, 'document.getElementById("retry").textContent'), mt('localExecution.retry'));
      assert.equal(await evaluate(retryWindow, 'document.getElementById("retry").hidden || document.getElementById("retry").disabled'), false);
      assert.equal(await evaluate(retryWindow, 'document.getElementById("detail").textContent'), mt('localExecution.installDownloadFailed'));
      assert.deepEqual(await retried.permissions.list(), []);
      assert.equal(retrying.done, false);

      retried.setPrepare(async () => { throw new LocalExecutionError('timeout'); });
      await click(retryWindow, 'retry');
      await until(() => retried.calls() === 2, 'second preparation attempt');
      await until(() => evaluate(retryWindow, `document.body.dataset.phase === 'failed' &&
        document.getElementById('detail').textContent === ${JSON.stringify(mt('localExecution.installTimeout'))}`), 'retried failure');
      assert.equal(await evaluate(retryWindow, 'document.getElementById("detail").textContent'), mt('localExecution.installTimeout'));
      assert.equal(await evaluate(retryWindow, 'document.getElementById("retry").disabled'), false,
        'A repeated failure must not leave the retry button disabled');
      assert.deepEqual(await retried.permissions.list(), []);

      const resumed = deferred();
      retried.setPrepare(async signal => {
        assert.equal(signal.aborted, false, 'A failed attempt must not poison later cancellation signals');
        assert.equal(retried.inventory.tools[0].info.status, 'ready', 'Completed tools stay installed');
        await resumed.promise;
        retried.ready();
      });
      await click(retryWindow, 'retry');
      await phase(retryWindow, 'installing');
      assert.equal(retried.calls(), 3);
      assert.equal(retrying.done, false);
      assert.equal(await evaluate(retryWindow, 'document.getElementById("choices").hidden && document.getElementById("retry").hidden'), true);
      assert.equal(await evaluate(retryWindow, 'document.getElementById("progress").hasAttribute("aria-valuenow")'), false);
      assert.deepEqual(await retried.permissions.list(), []);
      assert.throws(() => handlers.get(LOCAL_PREPARATION_DIALOG_IPC.action)({
        sender: retryWindow.webContents, senderFrame: retryWindow.webContents.mainFrame,
      }, 'retry'), { reason: 'invalid_request' }, 'Concurrent retry clicks cannot start a second installation');
      assert.equal(retried.calls(), 3);
      await screenshot(retryWindow, `local-installation-retry-${language}`);
      resumed.resolve();
      assert.equal((await retrying.promise).status, 'prepared');
      assert.equal((await retried.permissions.list())[0].decision, language === 'en' ? 'always' : 'connection');
      assert.equal(retried.calls(), 3, 'Only successful preparation grants access; no extra install is needed');
      assert.equal(retryWindow.isDestroyed(), true);
      assert.equal(handlers.size, 0);
    }

    const cancelled = await fixture();
    cancelled.setPrepare(async () => { throw new LocalExecutionError('provider_unavailable'); });
    const cancelling = settled(cancelled.prepare());
    const cancelledWindow = await dialog();
    await click(cancelledWindow, 'allow');
    await phase(cancelledWindow, 'failed');
    const aborted = deferred();
    const cleaned = deferred();
    cancelled.setPrepare(async signal => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise;
      await cleaned.promise;
      signal.throwIfAborted();
    });
    await click(cancelledWindow, 'retry');
    await phase(cancelledWindow, 'installing');
    await click(cancelledWindow, 'cancel');
    await phase(cancelledWindow, 'cancelling');
    await aborted.promise;
    assert.equal(cancelling.done, false, 'Cancellation must join cleanup before releasing preparation');
    assert.equal(await evaluate(cancelledWindow, 'document.getElementById("cancel").disabled'), true);
    cleaned.resolve();
    assert.deepEqual(await cancelling.promise, { status: 'cancelled' });
    assert.equal(cancelled.calls(), 2, 'The retried attempt still joins cancellation cleanup');
    assert.deepEqual(await cancelled.permissions.list(), []);
    assert.equal(handlers.size, 0);

    const closed = await fixture();
    const closing = closed.prepare();
    const closedWindow = await dialog();
    await click(closedWindow, 'close');
    assert.deepEqual(await closing, { status: 'cancelled' });
    assert.equal(closed.calls(), 0);
    assert.deepEqual(await closed.permissions.list(), []);

    const queued = await fixture();
    const first = queued.prepare('queue-first');
    const firstWindow = await dialog();
    const other = queued.service.prepare({
      requestId: 'queue-other', subject: { ...queued.subject, botId: 'another-bot', botName: 'Another bot' },
      capability: 'youtube-audio',
    });
    await new Promise(resolve => setImmediate(resolve));
    await queued.service.cancelRequest({ requestId: 'queue-other' });
    assert.deepEqual(await other, { status: 'cancelled' });
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'A queued request must not open a second modal');
    await click(firstWindow, 'deny');
    assert.deepEqual(await first, { status: 'failed', reason: 'permission_denied' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'An aborted queued request must never open a late modal');

    const shared = await fixture();
    const ownerA = shared.prepare('shared-a');
    const sharedWindow = await dialog();
    const ownerB = shared.prepare('shared-b');
    await new Promise(resolve => setImmediate(resolve));
    await shared.service.cancelRequest({ requestId: 'shared-a' });
    assert.deepEqual(await ownerA, { status: 'cancelled' });
    assert.equal(sharedWindow.isDestroyed(), false, 'Another owner still needs the shared permission dialog');
    await click(sharedWindow, 'allow');
    assert.equal((await ownerB).status, 'prepared');
    assert.equal(handlers.size, 0);

    for (const language of ['pt-BR', 'en']) {
      setMainLanguage(language);
      const f = await fixture();
      let removals = 0;
      let clears = 0;
      f.tools.remove = async () => { removals++; };
      f.tools.clearCache = async () => { clears++; };
      const cancelled = f.service.removeTool('node');
      let window = await dialog();
      assert.equal(await evaluate(window, 'document.body.dataset.mode'), 'remove');
      assert.equal(await evaluate(window, 'document.activeElement.id'), 'title');
      assert.equal(await evaluate(window, 'document.getElementById("choices").hidden'), true);
      assert.equal(await evaluate(window, 'document.getElementById("allow").textContent'), mt('localExecution.remove'));
      assert.equal(await evaluate(window, 'document.getElementById("capability").textContent'), mt('localExecution.removeMessage', { tool: 'Node.js' }));
      assert.equal(window.getParentWindow(), parent);
      assert.equal(window.isModal(), true);
      assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
      assert.equal(await evaluate(window, 'typeof window.api + ":" + typeof window.require'), 'undefined:undefined');
      assert.equal(removals, 0, 'Opening maintenance must not change files');
      assert.throws(() => handlers.get(LOCAL_PREPARATION_DIALOG_IPC.action)({
        sender: window.webContents, senderFrame: window.webContents.mainFrame,
      }, 'always'), { reason: 'invalid_request' }, 'Maintenance cannot grant a capability');
      await screenshot(window, `local-tools-remove-${language}`);
      await click(window, 'deny');
      assert.deepEqual(await cancelled, { status: 'cancelled' });
      assert.equal(removals, 0);

      let fail = true;
      let release = deferred();
      releasePending.push(() => release.resolve());
      f.tools.remove = async () => {
        removals++;
        await release.promise;
        if (fail) throw new LocalExecutionError('storage_failed', { cause: new Error('Controlled storage failure') });
      };
      const removal = settled(f.service.removeTool('node'));
      window = await dialog();
      await click(window, 'allow');
      await phase(window, 'installing');
      await until(() => removals === 1, 'first removal starts after task and permission teardown');
      assert.equal(removal.done, false);
      assert.equal(removals, 1);
      assert.equal(await evaluate(window, 'document.getElementById("cancel").hidden && document.getElementById("close").disabled'), true);
      assert.equal(await evaluate(window, 'document.getElementById("progress").hasAttribute("aria-valuenow")'), false);
      window.close();
      assert.equal(window.isDestroyed(), false, 'Window close must not abandon an in-progress cleanup');
      release.resolve();
      await phase(window, 'failed');
      assert.equal(await evaluate(window, 'document.getElementById("status").textContent'), mt('localExecution.attemptFailed', { count: '1' }));
      assert.equal(await evaluate(window, 'document.getElementById("detail").textContent'), mt('localExecution.installStorageFailed'));
      assert.equal(f.service.maintaining, false, 'Failed maintenance must release its lock before retry');
      await screenshot(window, `local-tools-remove-failed-${language}`);
      fail = false;
      release = deferred();
      await click(window, 'retry');
      await phase(window, 'installing');
      await until(() => removals === 2, 'retried removal starts');
      assert.throws(() => handlers.get(LOCAL_PREPARATION_DIALOG_IPC.action)({
        sender: window.webContents, senderFrame: window.webContents.mainFrame,
      }, 'retry'), { reason: 'invalid_request' }, 'A running removal cannot queue another retry');
      release.resolve();
      assert.deepEqual(await removal.promise, { status: 'completed' });
      assert.equal(window.isDestroyed(), true);
      assert.equal(f.service.maintaining, false);

      const clearing = f.service.clearCache();
      window = await dialog();
      assert.equal(await evaluate(window, 'document.body.dataset.mode'), 'cache');
      assert.equal(await evaluate(window, 'document.getElementById("allow").textContent'), mt('localExecution.clearCache'));
      assert.equal(clears, 0);
      await screenshot(window, `local-tools-cache-${language}`);
      await click(window, 'allow');
      assert.deepEqual(await clearing, { status: 'completed' });
      assert.equal(clears, 1, 'Cache cleanup runs only after Main-owned confirmation');
      assert.equal(handlers.size, 0);
      assert.deepEqual(await f.permissions.list(), [], 'Maintenance must never grant local capabilities');
    }

    const recovery = await fixture();
    const retryFlags = [];
    recovery.setPrepare(async (_signal, retryCleanup) => {
      retryFlags.push(retryCleanup);
      if (!retryCleanup) throw new LocalExecutionError('storage_failed');
    });
    const recovered = recovery.prepare('explicit-storage-recovery');
    const recoveryWindow = await dialog();
    await click(recoveryWindow, 'allow');
    await phase(recoveryWindow, 'failed');
    await click(recoveryWindow, 'retry');
    assert.equal((await recovered).status, 'prepared');
    assert.deepEqual(retryFlags, [false, true], 'Only the explicit retry action authorizes retained-file recovery');

    const lost = await fixture();
    lost.setPrepare(async () => { throw new LocalExecutionError('provider_unavailable'); });
    const lostOwner = lost.prepare('owner-disappears');
    const lostWindow = await dialog();
    await click(lostWindow, 'allow');
    await phase(lostWindow, 'failed');
    parent.destroy();
    assert.deepEqual(await lostOwner, { status: 'cancelled' });
    assert.equal(lostWindow.isDestroyed(), true);
    assert.deepEqual(await lost.permissions.list(), []);
    assert.equal(handlers.size, 0);
    console.log('Branded tool dialogs: both languages, neutral focus, scoped consent, progress, cleanup retry, removal/cache confirmation, maintenance recovery and cancellation passed.');
  };
  const finish = async code => {
    for (const release of releasePending) release();
    for (const f of fixtures) await f.service.dispose();
    if (parent && !parent.isDestroyed()) parent.destroy();
    ipcMain.handle = handle;
    ipcMain.removeHandler = remove;
    BrowserWindow.prototype.show = show;
    if (code === 0) app.quit();
    else app.exit(code);
  };
  app.whenReady().then(run).then(() => finish(0), async error => {
    console.error(error);
    await finish(1);
  });
}
