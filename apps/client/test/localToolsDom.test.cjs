const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('local tools settings retain permission intent, identities, focus and mount isolation', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `local-tools-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_LOCAL_TOOLS_PROFILE: profile };
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
  const { app, BrowserWindow } = require('electron');
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.MONKY_LOCAL_TOOLS_PROFILE);
  let vite;
  let browser;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'local-tools-settings-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__local_tools__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite address');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = new BrowserWindow({
      show: false, width: 1100, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    timeout = setTimeout(() => { console.error('Local tools DOM regression timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`${origin}/__local_tools__`);
      const evaluate = code => browser.webContents.executeJavaScript(code, true);
      const checks = await evaluate(`(${runRegression.toString()})(${JSON.stringify(language)})`);
      browser.focus();
      browser.webContents.focus();
      await evaluate('window.localToolsKeyboardFixture.focus()');
      const press = async keyCode => {
        for (const type of ['keyDown', 'keyUp']) {
          browser.webContents.sendInputEvent({ type, keyCode });
          await evaluate(`window.localToolsKeyboardFixture.waitForKey(${JSON.stringify(type.toLowerCase())}, ${JSON.stringify(keyCode)})`);
        }
      };
      await press('Space');
      await evaluate('window.localToolsKeyboardFixture.verifySpace()');
      await press('Escape');
      await evaluate('window.localToolsKeyboardFixture.verifyClose()');
      if (browser.isVisible()) throw new Error('Local tools smoke must remain offscreen');
      console.log(`Local tools settings DOM (${language}): ${checks} checks plus native switch/close keyboard checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const { LocalToolsTab } = await import('/views/settings/tabs/LocalToolsTab.ts');
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  const waitFor = (predicate, describeFailure) => new Promise((resolve, reject) => {
    let frame;
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error(describeFailure()));
    }, 5000);
    const poll = () => {
      if (predicate()) {
        clearTimeout(timer);
        resolve();
      } else {
        frame = requestAnimationFrame(poll);
      }
    };
    poll();
  });
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const reads = [];
  const mutations = [];
  const sources = [];
  const listeners = new Set();
  const listenerHistory = [];
  const mutation = (kind, input) => {
    const request = { ...deferred(), kind, input };
    mutations.push(request);
    return request.promise;
  };
  window.api = {
    getLocalExecutionState: () => { const request = deferred(); reads.push(request); return request.promise; },
    onLocalExecutionChanged: callback => {
      listeners.add(callback);
      listenerHistory.push(callback);
      return () => listeners.delete(callback);
    },
    setLocalExecutionPermission: input => mutation('permission', input),
    removeLocalTool: tool => mutation('remove', tool),
    clearLocalExecutionCache: () => mutation('cache'),
    cancelLocalExecutionTask: id => mutation('cancel', id),
    openExternal: url => { const request = { ...deferred(), url }; sources.push(request); return request.promise; },
  };
  let state = { supported: true, tools: [], permissions: [], tasks: [], toolsBytes: 0, cacheBytes: 0 };
  const emit = value => { state = structuredClone(value); for (const listener of listeners) listener(structuredClone(state)); };
  const answerRead = async (value = state) => { reads.at(-1).resolve(structuredClone(value)); await flush(); };
  const complete = async (result, value = state) => {
    mutations.at(-1).resolve(result);
    await flush();
    await answerRead(value);
  };
  const tab = new LocalToolsTab();
  let container;
  const mount = () => {
    container = document.createElement('main');
    container.style.cssText = 'width: 650px; margin: 20px; padding: 20px; background: var(--bg-secondary);';
    container.innerHTML = tab.renderHtml();
    document.body.append(container);
    tab.attachEvents(container);
    return container;
  };
  const field = selector => {
    const element = container.querySelector(selector);
    if (!element) throw new Error(`Missing local tools fixture element: ${selector}`);
    return element;
  };
  const permission = id => field(`[data-local-permission="${id}"]`);
  const tool = id => field(`[data-local-tool-row="${id}"]`);
  const feedback = () => field('[data-local-feedback]').textContent;
  mount();
  tab.attachEvents(container);
  check(listeners.size === 1 && reads.length === 1, 'mounting twice subscribes and reads only once');
  check(!field('[data-local-loading]').hidden && field('[data-local-empty="tools"]').hidden, 'loading is not an empty success state');
  check(field('[data-local-tools-size]').textContent === t('localExecution.notLoaded'), 'unknown totals are not invented zeroes');
  check(field('[data-local-action="cache"]').disabled, 'cache action is disabled until state is known');
  await answerRead();
  for (const kind of ['tools', 'permissions', 'tasks']) {
    check(!field(`[data-local-empty="${kind}"]`).hidden, `${kind} has a real empty-state explanation`);
  }
  check(field('[data-local-tools-size]').textContent === '0 B' && field('[data-local-cache-size]').textContent === '0 B', 'actual zero totals render after loading');
  const sections = [...container.querySelectorAll('[data-settings-section]')];
  check(sections.length === 4 && new Set(sections.map(section => section.dataset.settingsSection)).size === 4, 'sections have distinct navigation anchors');
  check(sections.every(section => section.dataset.settingsLabel === section.querySelector('h3').textContent), 'section labels match localized headings');

  const bot = {
    serverOrigin: 'wss://same.example.invalid', serverId: 'server-original', serverName: 'Server <script>bad()</script>',
    botId: 'same-bot', botName: 'Helper <img src=x onerror=bad()>', botPublicKey: 'a'.repeat(64),
  };
  const ids = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
  state = {
    supported: true, toolsBytes: 4096, cacheBytes: 1024,
    permissions: ['deny', 'connection', 'always'].map((decision, index) => ({
      id: ids[index], bot: { ...bot, botPublicKey: ['a', 'b', 'c'][index].repeat(64) },
      capability: 'youtube-audio', decision, updatedAt: 1000,
    })),
    tools: [
      { id: 'node', status: 'ready', version: '22.18.0', sizeBytes: 1024, sourceUrl: 'https://example.invalid/node?artifact="><script>bad()</script>', requiredBy: [ids[1], ids[2]], progress: null, failure: null },
      { id: 'yt-dlp', status: 'installing', version: null, sizeBytes: 0, sourceUrl: 'https://example.invalid/yt-dlp', requiredBy: [ids[1]], progress: { stage: 'downloading', downloadedBytes: 512, totalBytes: 1024 }, failure: null },
      { id: 'ffmpeg', status: 'invalid', version: null, sizeBytes: 3072, sourceUrl: null, requiredBy: ['4'.repeat(64)], progress: null, failure: 'integrity_failed' },
    ],
    tasks: [{ id: 'task-1', bot, capability: 'youtube-audio', operation: 'youtube.stream', phase: 'streaming', startedAt: 1000 }],
  };
  emit(state);
  for (let index = 0; index < ids.length; index++) {
    const input = permission(ids[index]);
    const row = input.closest('[data-local-permission-row]');
    check(input.checked === (index !== 0), 'denied is off; temporary and persistent are on');
    check(input.getAttribute('role') === 'switch' && input.closest('label').classList.contains('toggle-switch'), 'permissions reuse styled keyboard-operable switches');
    check(getComputedStyle(input).opacity === '0', 'native checkboxes are never displayed in isolation');
    check(row.textContent.includes(t(`localExecution.permission.${['deny', 'connection', 'always'][index]}`)), 'permission lifetime is localized and explicit');
    check(row.textContent.includes(['a', 'b', 'c'][index].repeat(64)), 'identical display names retain distinct full public keys');
    check(row.textContent.includes(bot.serverId) && row.textContent.includes(bot.serverOrigin) && row.textContent.includes(bot.botId), 'identity includes server origin and both IDs');
  }
  check(container.textContent.includes(bot.botName) && container.textContent.includes(bot.serverName), 'untrusted labels display literally');
  check(!container.querySelector('script, img, a[href]'), 'bot, server and source strings never inject HTML or links');
  check(tool('node').textContent.includes('22.18.0') && tool('node').textContent.includes('1 KB'), 'tool version and size are visible');
  check(tool('node').querySelector('[data-field="dependents"]').textContent.includes('b'.repeat(64)), 'requiredBy resolves permission IDs to bot identities');
  check(tool('ffmpeg').textContent.includes(t('localExecution.unknownDependent', { id: '4'.repeat(64) })), 'unavailable dependency details are explicit rather than silently dropped');
  check(tool('ffmpeg').textContent.includes(t('localExecution.failure.integrity_failed')), 'tool failure is localized');
  check(tool('yt-dlp').querySelector('progress').position === 0.5, 'known download totals have determinate progress');
  check(field('[data-local-tools-size]').textContent === '4 KB' && field('[data-local-cache-size]').textContent === '1 KB', 'summary uses Main-provided totals');
  check(field('[data-local-task-row="task-1"]').textContent.includes(t('localExecution.operation.youtube.stream')), 'tasks show operation');
  check(field('[data-local-task-row="task-1"]').textContent.includes(t('localExecution.phase.streaming')), 'tasks show phase');
  const streamingTask = state.tasks[0];
  for (const phase of ['consent', 'installing']) {
    emit({ ...state, tasks: [{ ...streamingTask, operation: 'tools.prepare', phase }] });
    const preparation = field('[data-local-task-row="task-1"]');
    check(preparation.querySelector('[data-field="task-operation"]').textContent.includes(t('localExecution.operation.tools.prepare'))
      && !preparation.textContent.includes('tools.prepare'), 'client-initiated tool preparation has a localized operation label');
    check(preparation.querySelector('[data-field="task-phase"]').textContent === t(`localExecution.phase.${phase}`)
      && !preparation.querySelector('[data-local-action="cancel"]').disabled, 'preparation exposes consent/installing progress and cancellation');
  }
  emit({ ...state, tasks: [streamingTask] });

  emit({ ...state, supported: false });
  check(!field('[data-local-unsupported]').hidden && permission(ids[0]).disabled, 'unsupported platform is explained and cannot enable denied permission');
  check(!permission(ids[1]).disabled && !field('[data-local-action="cache"]').disabled, 'unsupported platform still allows revoking and cleaning existing data');
  emit({ ...state, supported: true });
  const focused = permission(ids[0]);
  const details = focused.closest('article').querySelector('details');
  details.open = true;
  focused.focus();
  for (const stage of ['resolving', 'downloading', 'verifying', 'extracting', 'checking']) {
    emit({ ...state, tools: state.tools.map(entry => entry.id === 'yt-dlp' ? { ...entry, progress: { stage, downloadedBytes: 700, totalBytes: null } } : entry) });
    const progress = tool('yt-dlp').querySelector('progress');
    check(!progress.hasAttribute('value') && progress.getAttribute('aria-label').includes(t(`localExecution.stage.${stage}`)), `${stage} exposes accurate indeterminate stage progress`);
    check(permission(ids[0]) === focused && document.activeElement === focused && details.open, 'progress never replaces focused controls or collapses identity details');
  }
  focused.click();
  check(mutations.length === 1 && mutations[0].input.permissionId === ids[0] && mutations[0].input.enabled === true, 'switch requests authorization by permission ID, not names');
  check(field('[data-local-feedback]').querySelector('.bot-loading-spinner')
    && field('[data-local-feedback]').getAttribute('aria-busy') === 'true', 'pending tool actions show an accessible animated indicator');
  for (let index = 0; index < 10; index++) emit({ ...state, cacheBytes: 2048 + index });
  check(focused.checked && document.activeElement === focused && !focused.disabled, 'pending toggle intent and focus survive frequent authoritative progress');
  check(focused.getAttribute('aria-disabled') === 'true', 'pending switch advertises that another action cannot be requested yet');
  focused.click();
  field('[data-local-action="cache"]').click();
  tool('node').querySelector('[data-local-action="remove"]').click();
  check(mutations.length === 1 && focused.checked, 'repeat clicks do not queue repeated native confirmations');
  mutations.at(-1).resolve({ status: 'cancelled' });
  await flush();
  check(!focused.checked, 'cancelled authorization restores the latest decision even while get-state is still pending');
  check(!field('[data-local-feedback]').querySelector('.bot-loading-spinner')
    && tool('node').querySelector('[data-local-action="remove"]').getAttribute('aria-disabled') === 'false',
  'settled mutations stop animating and release unrelated controls before inventory refresh');
  await answerRead();
  check(!focused.checked && feedback() === t('localExecution.actionCancelled'), 'cancelled native authorization is explicit and restores the switch');

  for (const id of [ids[1], ids[2]]) {
    permission(id).click();
    check(mutations.at(-1).input.permissionId === id && mutations.at(-1).input.enabled === false, 'temporary and persistent permissions can both be revoked');
    const revoked = { ...state, permissions: state.permissions.map(entry => entry.id === id ? { ...entry, decision: 'deny' } : entry) };
    emit(revoked);
    await complete({ status: 'completed' });
    check(!permission(id).checked, 'revoked permission reflects authoritative denial');
  }
  focused.click();
  await complete({ status: 'failed', reason: 'storage_failed' });
  check(feedback() === t('localExecution.failure.storage_failed') && !focused.checked, 'failed mutations use localized typed failures, not optimistic success');
  focused.click();
  mutations.at(-1).reject(new Error('<script>private executable path</script>'));
  await flush();
  await answerRead();
  check(feedback() === t('localExecution.failure.transport_failed') && !container.textContent.includes('private executable path'), 'unexpected IPC errors never disclose raw error text');

  const source = tool('node').querySelector('[data-local-action="source"]');
  source.click();
  check(sources.at(-1).url === state.tools[0].sourceUrl, 'source opens the exact Main URL only through openExternal');
  sources.at(-1).resolve({ success: false });
  await flush();
  check(feedback() === t('localExecution.sourceFailed'), 'external opening failures remain visible and localized');
  tool('node').querySelector('[data-local-action="remove"]').click();
  check(mutations.at(-1).kind === 'remove' && mutations.at(-1).input === 'node', 'removal identifies the shared tool');
  await complete({ status: 'cancelled' });
  check(tool('node').textContent.includes(t('localExecution.toolStatus.ready')), 'cancelled removal does not pretend to remove a tool');

  const cancel = field('[data-local-action="cancel"]');
  cancel.focus();
  cancel.click();
  check(mutations.at(-1).kind === 'cancel' && mutations.at(-1).input === 'task-1', 'task cancellation sends the task ID');
  emit({ ...state, tasks: [{ ...state.tasks[0], phase: 'cancelling' }] });
  check(cancel.getAttribute('aria-disabled') === 'true' && document.activeElement === cancel, 'cancelling retains focus while blocking duplicate actions');
  emit({ ...state, tasks: [] });
  await complete({ status: 'completed' });
  check(!field('[data-local-empty="tasks"]').hidden, 'completed cancellation removes the task without rebuilding the panel');
  check(document.activeElement === field('[data-settings-section="local-tools-tasks"] h3'), 'removing the focused task returns focus to its section');
  field('[data-local-action="cache"]').click();
  check(mutations.at(-1).kind === 'cache', 'clear cache uses its dedicated IPC');
  emit({ ...state, cacheBytes: 0 });
  await complete({ status: 'completed' });
  check(field('[data-local-cache-size]').textContent === '0 B' && field('[data-local-action="cache"]').disabled, 'cache size and action follow authoritative cleanup');
  tool('node').querySelector('[data-local-action="remove"]').click();
  const beforeRemoval = mutations.length;
  emit({ ...state, tools: state.tools.map(entry => entry.id === 'node'
    ? { ...entry, status: 'absent', sizeBytes: 0, version: null, requiredBy: [] } : entry), toolsBytes: 3072 });
  await complete({ status: 'completed' });
  check(tool('node').querySelector('[data-local-action="remove"]').disabled && mutations.length === beforeRemoval, 'removed tools stay absent without implicit authorization or reinstallation');

  field('[data-local-action="refresh"]').click();
  reads.at(-1).reject(new Error('private get-state error'));
  await flush();
  check(!field('[data-local-load-error]').hidden && field('[data-local-load-error]').textContent.includes(t('localExecution.failure.transport_failed')), 'state failures are visible and localized');
  check(permission(ids[0]).disabled && !container.textContent.includes('private get-state error'), 'stale state cannot authorize a mutation or expose exception text');
  field('[data-local-action="refresh"]').click();
  const staleRead = reads.at(-1);
  emit({ ...state, toolsBytes: 8192 });
  staleRead.resolve({ ...state, toolsBytes: 1 });
  await flush();
  check(field('[data-local-tools-size]').textContent === '8 KB' && field('[data-local-load-error]').hidden, 'a delayed get reply cannot overwrite a newer change');
  check(listeners.size === 1, 'refresh never adds duplicate change listeners');

  field('[data-local-action="refresh"]').click();
  const oldRead = reads.at(-1);
  const oldChange = listenerHistory.at(-1);
  const oldContainer = container;
  const beforeClose = oldContainer.innerHTML;
  tab.cleanup();
  oldContainer.remove();
  check(listeners.size === 0, 'cleanup removes the IPC subscription');
  mount();
  oldRead.resolve({ ...state, toolsBytes: 999 });
  oldChange({ ...state, toolsBytes: 999 });
  await flush();
  check(oldContainer.innerHTML === beforeClose, 'late responses never mutate detached DOM');
  check(field('[data-local-tools-size]').textContent === t('localExecution.notLoaded'), 'old get and change callbacks do not paint a reopened panel');
  await answerRead();
  permission(ids[0]).click();
  const oldMutation = mutations.at(-1);
  tab.cleanup();
  container.remove();
  mount();
  const readCount = reads.length;
  oldMutation.resolve({ status: 'failed', reason: 'timeout' });
  await flush();
  check(reads.length === readCount && !feedback(), 'late mutation completion cannot refresh or show errors in a reopened panel');
  await answerRead();
  const detachedSwitch = permission(ids[0]);
  tab.cleanup();
  const mutationCount = mutations.length;
  detachedSwitch.click();
  check(mutations.length === mutationCount, 'cleanup also removes delegated DOM listeners');
  container.remove();

  const { SettingsModal } = await import('/views/SettingsModal.ts');
  const modal = new SettingsModal();
  for (const [name, view] of Object.entries(modal)) {
    if (name === 'localToolsTab' || !view || typeof view.renderHtml !== 'function') continue;
    if (name !== 'voiceVideoTab') view.renderHtml = () => '<p>Unrelated settings fixture</p>';
    view.attachEvents = () => {};
    view.cleanup = () => {};
  }
  let deviceRefreshes = 0;
  modal.voiceVideoTab.refreshDevices = async () => { deviceRefreshes++; };
  modal.voiceVideoTab.startVadMeter = () => {};
  modal.voiceVideoTab.deactivate = () => {};
  let previewActivations = 0;
  modal.voiceVideoTab.activateCameraPreview = () => { previewActivations++; };
  modal.aboutTab.loadAppVersion = async () => {};
  for (const section of ['camera', 'noise-suppression']) {
    const opening = modal.open('voice_video', section);
    container = document.querySelector('.modal-backdrop--settings');
    const link = field(`[data-section-target="${section}"]`);
    check(field('.settings-tab-btn.active').dataset.tab === 'voice_video'
      && link.getAttribute('aria-current') === 'location'
      && document.getElementById(link.getAttribute('aria-controls')) === field(`[data-settings-section="${section}"]`),
    'existing voice/video deep links retain their actual sections');
    await answerRead();
    await opening;
    modal.close();
  }
  check(previewActivations === 2, 'voice/video callers still activate their preview lifecycle');
  const previousRefreshes = deviceRefreshes;
  const switchedOpening = modal.open('local_tools', 'local-tools-permissions');
  container = document.querySelector('.modal-backdrop--settings');
  field('[data-tab="account"]').click();
  await answerRead();
  await switchedOpening;
  check(field('.settings-tab-btn.active').dataset.tab === 'account'
    && field('[data-tab="local_tools"]').getAttribute('aria-expanded') === 'false',
  'a delayed local deep link does not override a tab chosen by the user');
  check(deviceRefreshes === previousRefreshes + 1, 'changing tabs while awaiting local state does not skip existing device initialization');
  modal.close();
  const obsoleteDeepLink = modal.open('local_tools', 'local-tools-permissions');
  const obsoleteDeepLinkRead = reads.at(-1);
  modal.close();
  const currentDeepLink = modal.open('local_tools', 'local-tools-tools');
  container = document.querySelector('.modal-backdrop--settings');
  obsoleteDeepLinkRead.resolve(structuredClone(state));
  await obsoleteDeepLink;
  check(field('[data-section-target="local-tools-permissions"]').getAttribute('aria-current') !== 'location',
    'an obsolete awaited deep link cannot scroll a reopened modal');
  await answerRead();
  await currentDeepLink;
  check(field('[data-section-target="local-tools-tools"]').getAttribute('aria-current') === 'location',
    'the current deep link survives a late reply from a previous modal');
  modal.close();
  const permissionsOpening = modal.open('local_tools', 'local-tools-permissions');
  container = document.querySelector('.modal-backdrop--settings');
  check(!!container && field('.settings-tab-btn.active').dataset.tab === 'local_tools', 'device-level SettingsModal exposes and opens the new tab');
  check(field('#settings-current-tab-title').textContent.includes(t('settings.tabLocalTools')), 'tab header is localized');
  check(listeners.size === 1, 'modal mounts exactly one local-tools subscriber');
  await answerRead();
  await permissionsOpening;
  check(field('[data-section-target="local-tools-permissions"]').getAttribute('aria-current') === 'location', 'direct navigation reveals the requested section');
  const permissionsSection = field('[data-settings-section="local-tools-permissions"]');
  const body = field('.settings-content-body');
  const scrollPosition = () => {
    const heading = permissionsSection.querySelector('h3').getBoundingClientRect();
    const top = body.getBoundingClientRect().top + body.clientTop;
    return { scrollTop: body.scrollTop, headingTop: heading.top - top, headingBottom: heading.bottom - top, viewportHeight: body.clientHeight };
  };
  await waitFor(() => {
    const { headingTop, headingBottom, viewportHeight } = scrollPosition();
    return headingTop >= 0 && headingBottom <= viewportHeight;
  }, () => `permissions deep link must reveal the populated section: ${JSON.stringify(scrollPosition())}`);
  check(document.getElementById(field('[data-section-target="local-tools-permissions"]').getAttribute('aria-controls')) === permissionsSection,
    'permissions shortcut targets the real section after asynchronous tools populate');
  const retained = permission(ids[0]);
  field('[data-tab="account"]').click();
  emit({ ...state, toolsBytes: 16384 });
  field('[data-tab="local_tools"]').click();
  check(permission(ids[0]) === retained && listeners.size === 1, 'tab navigation retains controls and the single mounted subscription');
  field('[data-local-action="refresh"]').click();
  const oldModalRead = reads.at(-1);
  const oldModalChange = listenerHistory.at(-1);
  modal.close();
  check(listeners.size === 0 && !document.querySelector('.settings-section-nav'), 'modal close cleans IPC and section navigation');
  const reopening = modal.open('local_tools');
  container = document.querySelector('.modal-backdrop--settings');
  oldModalRead.resolve({ ...state, toolsBytes: 1 });
  oldModalChange({ ...state, toolsBytes: 2 });
  await flush();
  check(field('[data-local-tools-size]').textContent === t('localExecution.notLoaded'), 'actual modal reopen ignores old state and change responses');
  await answerRead();
  await reopening;
  const keyboardStart = mutations.length;
  const keyboardEvents = [];
  const recordKey = event => keyboardEvents.push({
    type: event.type, key: event.key, code: event.code, trusted: event.isTrusted,
    targetIsSwitch: event.target === permission(ids[0]), defaultPrevented: event.defaultPrevented,
  });
  window.addEventListener('keydown', recordKey);
  window.addEventListener('keyup', recordKey);
  const describeKeyboard = () => JSON.stringify({
    keyboardStart, mutations: mutations.length, documentFocused: document.hasFocus(),
    focused: document.activeElement?.outerHTML.slice(0, 400), switchDisabled: permission(ids[0]).disabled,
    ariaDisabled: permission(ids[0]).getAttribute('aria-disabled'), keyboardEvents,
  });
  window.localToolsKeyboardFixture = {
    async focus() {
      const input = permission(ids[0]);
      input.focus();
      await waitFor(() => document.hasFocus() && document.activeElement === input && input.isConnected
        && !input.disabled && input.getAttribute('aria-disabled') === 'false',
      () => `native keyboard target must have real focus and be ready: ${describeKeyboard()}`);
    },
    async waitForKey(type, code) {
      await waitFor(() => keyboardEvents.some(event => event.type === type && event.code === code && event.trusted),
        () => `native ${code}/${type} must reach the renderer: ${describeKeyboard()}`);
    },
    async verifySpace() {
      await waitFor(() => mutations.length > keyboardStart,
        () => `native Space must reach the permission IPC: ${describeKeyboard()}`);
      check(mutations.length === keyboardStart + 1 && mutations.at(-1).input.enabled === true,
        `native Space toggles the accessible switch once: ${describeKeyboard()}`);
      const space = keyboardEvents.filter(event => event.code === 'Space');
      check(space.length === 2 && space[0].type === 'keydown' && space[1].type === 'keyup'
        && space.every(event => event.trusted && event.targetIsSwitch), 'exactly one trusted Space press activates the focused switch');
      check(document.activeElement === permission(ids[0]) && permission(ids[0]).checked, 'pending native keyboard action retains focus and intent');
      await complete({ status: 'cancelled' });
    },
    async verifyClose() {
      await waitFor(() => !document.querySelector('.modal-backdrop--settings') && listeners.size === 0,
        () => `native Escape must close and clean the modal: ${describeKeyboard()}`);
      check(!document.querySelector('.modal-backdrop--settings') && listeners.size === 0, 'native Escape closes and cleans local tools');
      window.removeEventListener('keydown', recordKey);
      window.removeEventListener('keyup', recordKey);
      modal.close();
      delete window.localToolsKeyboardFixture;
    },
  };
  return checks;
}
