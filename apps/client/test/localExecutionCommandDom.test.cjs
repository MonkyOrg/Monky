const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { authoredOggPreview } = require(path.join(__dirname, 'fixtures', 'authoredAudio.cjs'));
const { runLocalMediaDom } = require(path.join(__dirname, 'fixtures', 'localMediaDom.cjs'));
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('local command preflight, client-only previews and private RTC use isolated fixtures', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `local-command-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_LOCAL_COMMAND_PROFILE: profile };
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
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { AUDIO_PREVIEW_IPC } = require('@monky/shared');
  const { AudioPreviews } = require(path.join(clientRoot, 'dist-electron', 'main', 'audioPreviews.js'));
  app.setPath('userData', process.env.MONKY_LOCAL_COMMAND_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let browser;
  let timeout;
  const previews = new AudioPreviews({
    resolve: async () => { throw new Error('Local preview fixture must not resolve provider DNS'); },
    request: async () => { throw new Error('Local preview fixture must not download provider audio'); },
  });
  const finish = async code => {
    clearTimeout(timeout);
    if (browser) previews.cancelOwner(browser.webContents.id);
    ipcMain.removeHandler(AUDIO_PREVIEW_IPC.load);
    ipcMain.removeHandler(AUDIO_PREVIEW_IPC.cancel);
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
        name: 'local-command-preflight-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__local_command__') return next();
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
      show: false, width: 1100, height: 850,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true,
        preload: path.join(__dirname, 'fixtures', 'localExecutionPreload.cjs'),
      },
    });
    const owner = browser.webContents.id;
    const owns = event => event.sender === browser.webContents && event.senderFrame === browser.webContents.mainFrame;
    ipcMain.handle(AUDIO_PREVIEW_IPC.load, (event, input) => owns(event)
      ? previews.load(owner, input) : { status: 'failed', reason: 'invalid_request' });
    ipcMain.handle(AUDIO_PREVIEW_IPC.cancel, (event, input) => owns(event) && previews.cancel(owner, input));
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).origin !== origin }));
    timeout = setTimeout(() => { console.error('Local command DOM smoke timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`${origin}/__local_command__`);
      const selectionChecks = await browser.webContents.executeJavaScript(
        `(${runSelectionPreflight.toString()})(${JSON.stringify(language)})`, true,
      );
      console.log(`Local command selection DOM (${language}): ${selectionChecks} checks passed`);
      await browser.loadURL(`${origin}/__local_command__`);
      const checks = await browser.webContents.executeJavaScript(
        `(${runPreflight.toString()})(${JSON.stringify(language)}, ${JSON.stringify(authoredOggPreview().toString('base64'))})`, true,
      );
      console.log(`Local command preflight DOM (${language}): ${checks} checks passed`);
    }
    const sharedUrl = '/@fs/' + path.resolve(clientRoot, '..', '..', 'packages', 'shared', 'src', 'index.ts').replaceAll('\\', '/');
    const mediaChecks = await browser.webContents.executeJavaScript(`(${runLocalMediaDom.toString()})(${JSON.stringify(sharedUrl)})`, true);
    console.log(`Controlled private RTC: ${mediaChecks} checks passed`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runSelectionPreflight(language) {
  const [{ ChatView }, { sessionManager }, { setLanguage, t }] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/i18n/index.ts'),
  ]);
  setLanguage(language);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  const native = [], cancelled = [], sent = [];
  const listeners = new Set();
  const previousApi = window.api;
  const forbidden = async () => { throw new Error('Selecting a command must not start media or tools without Main preparation'); };
  window.api = {
    ...previousApi,
    setLocalExecutionConnection: async () => ({ status: 'completed' }),
    prepareLocalExecution: input => new Promise(resolve => native.push({ input, resolve })),
    cancelLocalExecutionRequest: async ({ requestId }) => { cancelled.push(requestId); return { status: 'completed' }; },
    startLocalExecutionTask: forbidden, readLocalExecutionFrames: forbidden,
    acknowledgeLocalExecutionFrames: forbidden, setLocalExecutionPaused: forbidden,
    cancelLocalExecutionTask: async () => ({ status: 'completed' }),
    onLocalExecutionChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    onLocalExecutionTaskFailed: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  sessionManager.install();
  const session = sessionManager.create('selection.example.invalid', 3000, 'Caller');
  const { client, chatStore: store, serverStore: server } = session;
  const user = { id: 'caller', clientId: 'caller', sessionId: 'selection-device', nickname: 'Caller', status: 'ONLINE', joinedAt: 1 };
  server.setServerDetails({
    id: 'selection-server', name: 'Selection', createdAt: 1, maxUsers: 10, hasPassword: false,
    members: [user], knownMembers: [user], voiceStates: {}, ownerId: user.id,
    channels: ['text', 'other'].map((id, position) => ({
      id, serverId: 'selection-server', name: id, type: 'TEXT', position, createdAt: 1,
      botCommandsEnabled: true, isPrivate: false, allowedRoleIds: [],
    })),
    myPermissions: 0xffffffff, roles: [], userRoles: [],
  }, user);
  session.participants.setUsers([user]);
  client.currentServerUrl = 'wss://selection.example.invalid';
  client.ws = { readyState: WebSocket.OPEN, close() { this.readyState = WebSocket.CLOSED; } };
  client.send = (type, payload, requestId) => {
    sent.push({ type, payload, requestId });
    if (type === 'COMMAND_INVOKE') queueMicrotask(() => client.handleIncomingMessage({
      type: 'COMMAND_INVOKED', requestId, payload: {
        invocationId: `invocation-${requestId}`, botId: payload.botId,
        commandName: payload.commandName, channelId: payload.channelId,
      },
    }));
  };
  const sendRequest = client.sendRequest.bind(client);
  client.sendRequest = (type, ...args) => type === 'SELECTOR_LIST' ? Promise.resolve({ selectors: [] }) : sendRequest(type, ...args);
  client.setStatus('CONNECTED');
  client.emitScoped('network.connected', {});
  sessionManager.activate(session.key);
  const command = (name, options) => ({
    name, description: name, botId: `bot-${name}`, botName: 'Fixture', botPublicKey: 'a'.repeat(64),
    localCapabilities: ['youtube-audio'], options,
  });
  const query = [{ name: 'query', description: 'Query', type: 'string', required: true, autocomplete: true }];
  const plain = [{ name: 'text', description: 'Text', type: 'string', required: true }];
  const commands = [
    command('mouse', query), command('keyboard', query), command('plain', plain),
    command('direct', []), command('denied', plain), command('leave', plain),
    { name: 'utility', description: 'No local execution', botId: 'utility', botName: 'Fixture' },
  ];
  store.setCommands(commands);
  server.setSlashCommands(commands);
  const root = document.createElement('div');
  document.body.append(root);
  const view = new ChatView(root);
  view.setChannel('text');
  const type = (input, value) => {
    if (!input) throw new Error('Missing command input');
    input.focus();
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const select = async (name, keyboard = false) => {
    const before = native.length;
    const input = root.querySelector('#chat-message-input');
    type(input, `/${name}`);
    await waitFor(() => !!root.querySelector('[data-cmd-index]'), 'Command catalog did not open');
    const row = root.querySelector('[data-cmd-index]');
    row.dispatchEvent(new MouseEvent('mouseenter'));
    check(native.length === before, 'Browsing or highlighting a command must not request consent');
    if (keyboard) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    else row.click();
  };
  const close = async () => {
    root.querySelector('[data-bot-action="cancel-command"]').click();
    await waitFor(() => !store.getCommandDraft(view.currentChannelId), 'Command did not close');
  };
  const operations = () => sent.filter(request => ['COMMAND_AUTOCOMPLETE', 'COMMAND_AUDIO_PREVIEW', 'COMMAND_INVOKE'].includes(request.type));
  try {
    for (const [name, keyboard] of [['mouse', false], ['keyboard', true]]) {
      const before = native.length;
      const beforeOperations = operations().length;
      await select(name, keyboard);
      await waitFor(() => native.length === before + 1, `${name} selection did not prepare prerequisites before typing`);
      const input = root.querySelector('[data-bot-autocomplete]');
      check(input?.value === '' && store.getCommandDraft('text').autocomplete.query.query === '',
        'An empty selected command starts preparation without waiting for a search query');
      check(input.disabled && root.querySelector('.bot-command-run').getAttribute('aria-busy') === 'true',
        'Arguments and execution wait for the Main-owned prerequisite');
      check(operations().length === beforeOperations, 'Selection must not send a search, preview or invocation');
      native.at(-1).resolve({ status: 'prepared', permit: '1'.repeat(64) });
      await waitFor(() => !!root.querySelector('[data-bot-autocomplete]') && !root.querySelector('[data-bot-autocomplete]').disabled,
        'Prepared command did not become editable');
      check(document.activeElement === root.querySelector('[data-bot-autocomplete]'), 'Focus returns to the command after preparation');
      check(operations().length === beforeOperations, 'An empty query stays idle after successful preparation');
      type(root.querySelector('[data-bot-autocomplete]'), 'prepared search');
      await waitFor(() => operations().length > beforeOperations, 'Prepared search did not dispatch');
      const request = operations().at(-1);
      check(request.type === 'COMMAND_AUTOCOMPLETE' && request.payload.query === 'prepared search'
        && native.length === before + 1, 'Typing uses the selected command preparation without another prompt');
      client.handleIncomingMessage({ type: 'COMMAND_AUTOCOMPLETE_RESULT', requestId: request.requestId, payload: { status: 'ok', choices: [] } });
      await close();
      await select(name, keyboard);
      await waitFor(() => !!root.querySelector('[data-bot-autocomplete]') && !root.querySelector('[data-bot-autocomplete]').disabled,
        'Cached preparation did not unlock the reselected command');
      check(native.length === before + 1, 'Reselecting an authorized command reuses its prepared tools');
      await close();
    }

    const beforeUtility = native.length;
    await select('utility');
    await waitFor(() => sent.some(request => request.type === 'COMMAND_INVOKE' && request.payload.commandName === 'utility'),
      'Utility command did not execute');
    await waitFor(() => !store.getCommandDraft('text'), 'Utility acknowledgement did not clear the command');
    check(native.length === beforeUtility, 'Commands without local capabilities never prompt for tools');

    await select('plain');
    await waitFor(() => native.length === beforeUtility + 1, 'A non-autocomplete command did not prepare at selection');
    const plainRequest = native.at(-1);
    check(root.querySelector('[data-bot-input]').disabled && !root.querySelector('[data-bot-autocomplete]'),
      'Selection preflight is generic, not tied to autocomplete');
    const beforeCancelled = operations().length;
    await close();
    await waitFor(() => cancelled.includes(plainRequest.input.requestId), 'Closing the selected command did not cancel preparation');
    plainRequest.resolve({ status: 'prepared', permit: '2'.repeat(64) });
    await flush();
    check(operations().length === beforeCancelled && !store.getCommandDraft('text'),
      'Late preparation cannot revive or invoke a cancelled command');

    const beforeDirect = native.length;
    await select('direct');
    await waitFor(() => native.length === beforeDirect + 1, 'Zero-argument command did not prepare');
    check(!sent.some(request => request.type === 'COMMAND_INVOKE' && request.payload.commandName === 'direct'),
      'Zero-argument auto-execution must wait for consent and tools');
    native.at(-1).resolve({ status: 'prepared', permit: '3'.repeat(64) });
    await waitFor(() => !store.getCommandDraft('text'), 'Prepared zero-argument command did not complete');
    check(sent.filter(request => request.type === 'COMMAND_INVOKE' && request.payload.commandName === 'direct').length === 1
      && native.length === beforeDirect + 1, 'Selection and invocation share one preparation and execute only once');

    const beforeDenial = native.length;
    await select('denied', true);
    await waitFor(() => native.length === beforeDenial + 1, 'Denial scenario did not request preparation');
    native.at(-1).resolve({ status: 'failed', reason: 'permission_denied' });
    await waitFor(() => store.getCommandDraft('text')?.error === t('localExecution.failure.permission_denied'),
      'Selection denial did not surface a localized error');
    view.botChat.renderComposer();
    await flush();
    check(native.length === beforeDenial + 1 && !root.querySelector('[data-bot-input]').disabled,
      'Rendering a denied command neither traps its controls nor reopens consent');
    await close();

    const beforeLeave = native.length;
    await select('leave');
    await waitFor(() => native.length === beforeLeave + 1, 'Channel-change scenario did not start');
    const leaving = native.at(-1);
    const beforeChannelChange = operations().length;
    view.setChannel('other');
    await waitFor(() => cancelled.includes(leaving.input.requestId), 'Changing channel did not cancel selection preparation');
    leaving.resolve({ status: 'prepared', permit: '4'.repeat(64) });
    await flush();
    check(operations().length === beforeChannelChange && !root.querySelector('[data-command-form]'),
      'A late preparation cannot execute or steal the new channel composer');
  } finally {
    view.destroy();
    sessionManager.dispose();
    root.remove();
    window.api = previousApi;
  }
  await flush();
  check(listeners.size === 0, 'Selection preflight observers are released with their session');
  return checks;
}

async function runPreflight(language, audioBase64) {
  const { t, setLanguage } = await import('/i18n/index.ts');
  setLanguage(language);
  const [{ sessionManager }, { BotChatView }, { voiceStore }, { appEvents }, { audioPreviewService }] = await Promise.all([
    import('/core/SessionManager.ts'), import('/views/BotChatView.ts'), import('/stores/voiceStore.ts'), import('/core/EventBus.ts'),
    import('/core/AudioPreviewService.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  const waitFor = predicate => new Promise((resolve, reject) => {
    let frame;
    const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Local command condition did not settle')); }, 5000);
    const poll = () => {
      if (predicate()) { clearTimeout(timer); resolve(); }
      else frame = requestAnimationFrame(poll);
    };
    poll();
  });
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const preparations = [];
  const cancelled = [];
  const connections = [];
  const nativeListeners = new Set();
  const failureListeners = new Set();
  const starts = [];
  const loadedPreviews = [];
  const audios = [];
  const revokedUrls = [];
  const OriginalAudio = window.Audio;
  const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
  window.Audio = class extends OriginalAudio {
    constructor() { super(); this.muted = true; audios.push(this); }
  };
  URL.revokeObjectURL = url => { revokedUrls.push(url); revokeObjectUrl(url); };
  window.api = {
    setLocalExecutionConnection: async state => { connections.push(structuredClone(state)); return { status: 'completed' }; },
    prepareLocalExecution: input => { const request = { input, ...deferred() }; preparations.push(request); return request.promise; },
    cancelLocalExecutionRequest: async ({ requestId }) => { cancelled.push(requestId); return { status: 'completed' }; },
    startLocalExecutionTask: async input => {
      if (input.spec.operation !== 'youtube.preview') throw new Error('Fixture must not start real tools');
      starts.push(input);
      return { status: 'started', taskId: `native-preview-${starts.length}`, result: {
        operation: 'youtube.preview', mimeType: 'audio/ogg', audioBase64,
      } };
    },
    readLocalExecutionFrames: async () => { throw new Error('Fixture must not read provider audio'); },
    acknowledgeLocalExecutionFrames: async () => { throw new Error('Fixture has no playback'); },
    setLocalExecutionPaused: async () => { throw new Error('Fixture has no stream'); },
    cancelLocalExecutionTask: async () => ({ status: 'completed' }),
    onLocalExecutionTaskFailed: listener => { failureListeners.add(listener); return () => failureListeners.delete(listener); },
    onLocalExecutionChanged: listener => { nativeListeners.add(listener); return () => nativeListeners.delete(listener); },
    loadAudioPreview: async input => {
      loadedPreviews.push(input);
      return window.localExecutionFixture.loadAudioPreview(input);
    },
    cancelAudioPreview: input => window.localExecutionFixture.cancelAudioPreview(input),
  };
  sessionManager.install();
  const sent = [];
  const makeSession = name => {
    const session = sessionManager.create(`${name}.example.invalid`, 3000, 'User');
    const user = { id: `user-${name}`, clientId: `key-${name}`, sessionId: `physical-${name}`, nickname: 'User', status: 'ONLINE', joinedAt: 1 };
    session.serverStore.setServerDetails({
      id: `server-${name}`, name: `Server ${name}`, createdAt: 1, maxUsers: 20, hasPassword: false,
      channels: [{ id: 'text', name: 'Text', type: 'TEXT', position: 0, botCommandsEnabled: true },
        { id: 'voice', name: 'Voice', type: 'VOICE', position: 1 }],
      members: [user], voiceStates: {}, roles: [], userRoles: [], myPermissions: 0xffffffff,
    }, user);
    session.client.currentServerUrl = `wss://${name}.example.invalid`;
    session.client.ws = { readyState: WebSocket.OPEN, close() { this.readyState = WebSocket.CLOSED; } };
    session.client.send = (type, payload, requestId) => sent.push({ client: session.client, type, payload, requestId });
    session.client.setStatus('CONNECTED');
    session.client.emitScoped('network.connected', {});
    return session;
  };
  const primary = makeSession('a');
  const background = makeSession('b');
  sessionManager.activate(primary.key);
  const search = {
    botId: 'bot-a', botName: 'Helper <script>bad()</script>', botPublicKey: 'a'.repeat(64),
    name: 'search', description: 'Search', localCapabilities: ['youtube-audio'],
    options: [{ name: 'query', description: 'Search query', type: 'string', required: true, autocomplete: true }],
  };
  const utility = { botId: 'bot-a', botName: 'Helper', name: 'pause', description: 'Pause' };
  primary.chatStore.setCommands([search, utility]);
  primary.serverStore.setSlashCommands([search, utility]);
  const root = document.createElement('div');
  root.innerHTML = '<div id="composer"></div><div id="feed"></div>';
  document.body.append(root);
  const composer = root.querySelector('#composer');
  const feed = root.querySelector('#feed');
  let view = new BotChatView(primary.chatStore, primary.client, primary.serverStore, 'text', composer, feed, () => {}, () => {});
  const originalSetTimeout = window.setTimeout.bind(window);
  const deadlines = [];
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 15000 || delay === 31000) deadlines.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  };
  const type = value => {
    const input = composer.querySelector('[data-bot-autocomplete]');
    if (!input) throw new Error('Missing real autocomplete input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const response = (request, type, payload) => request.client.handleIncomingMessage({ type, requestId: request.requestId, payload });
  try {
    primary.chatStore.selectCommand('text', search);
    type('first');
    await waitFor(() => preparations.length === 1);
    check(sent.length === 0 && deadlines.length === 0, 'installation does not start autocomplete or preview deadlines');
    check(composer.textContent.includes(t('botChat.autocompleteLoading'))
      && !composer.textContent.includes(t('localExecution.preparing')),
    'the composer waits without duplicating the Main-owned preparation dialog');
    check(preparations[0].input.subject.connectionId === primary.client.getConnectionId()
      && preparations[0].input.subject.botPublicKey === search.botPublicKey
      && preparations[0].input.subject.serverOrigin === 'wss://a.example.invalid', 'native subject uses authenticated bot key and the captured socket');
    type('latest');
    await waitFor(() => view.autocomplete.query === 'latest' && composer.textContent.includes(t('botChat.autocompleteLoading')));
    check(preparations.length === 1 && cancelled.length === 0, 'typing reuses the active composer setup instead of cancelling or prompting again');
    preparations[0].resolve({ status: 'prepared', permit: '1'.repeat(64) });
    await waitFor(() => sent.some(request => request.type === 'COMMAND_AUTOCOMPLETE'));
    let query = sent.find(request => request.type === 'COMMAND_AUTOCOMPLETE');
    check(query.payload.query === 'latest' && sent.filter(request => request.type === 'COMMAND_AUTOCOMPLETE').length === 1,
      'only the newest query is sent after preparation');
    check(deadlines.join() === '15000', 'the provider deadline starts only when the prepared query is sent');
    check(!composer.textContent.includes(t('localExecution.preparing')),
      'a running provider search must never be labelled as tool preparation');
    type('cached-edit');
    await waitFor(() => sent.some(request => request.type === 'COMMAND_AUTOCOMPLETE' && request.payload.query === 'cached-edit'));
    query = sent.find(request => request.type === 'COMMAND_AUTOCOMPLETE' && request.payload.query === 'cached-edit');
    check(preparations.length === 1 && composer.textContent.includes(t('botChat.autocompleteLoading'))
      && !composer.textContent.includes(t('localExecution.preparing')),
    'editing an already prepared command shows search loading, without another native preparation or permission hint');
    check(JSON.stringify(query.payload.localPreparation) === '{"capability":"youtube-audio"}',
      'autocomplete carries only public capability readiness, never the Main permit or subject');
    response(query, 'COMMAND_AUTOCOMPLETE_RESULT', { status: 'ok', choices: [{
      label: 'Controlled <img src=x onerror=bad()>', value: 'opaque-result',
      audio: { resourceId: 'controlled-resource', fileName: 'controlled.ogg', durationMs: 500 },
    }] });
    await waitFor(() => !!composer.querySelector('[data-parameter-option="0"]'));
    check(!composer.querySelector('img[src="x"]') && composer.textContent.includes('<img src=x onerror=bad()>'),
      'untrusted local result labels remain escaped');
    composer.querySelector('[data-audio-preview-action="toggle"]').click();
    await waitFor(() => sent.some(request => request.type === 'COMMAND_AUDIO_PREVIEW'));
    const previewRequest = sent.find(request => request.type === 'COMMAND_AUDIO_PREVIEW');
    check(JSON.stringify(previewRequest.payload.localPreparation) === JSON.stringify(query.payload.localPreparation)
      && preparations.length === 1 && !sent.some(request => request.type === 'COMMAND_INVOKE'),
    'preview reuses the prepared capability without selecting or invoking the command');
    const offer = {
      taskId: 'wire-preview', requestId: previewRequest.requestId,
      context: { kind: 'audio-preview', requestId: 'server-remapped-preview' },
      bot: { serverId: 'server-a', serverName: 'Server a', botId: search.botId, botName: search.botName, botPublicKey: search.botPublicKey },
      botSessionId: 'bot-session', invokerId: primary.serverStore.currentUser.id,
      invokerSessionId: primary.serverStore.currentUser.sessionId, capability: 'youtube-audio',
      spec: { operation: 'youtube.preview', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
      expiresAt: Date.now() + 30000,
    };
    response(previewRequest, 'BOT_LOCAL_TASK_OFFER', offer);
    await waitFor(() => sent.some(request => request.type === 'BOT_LOCAL_TASK_ACCEPT'));
    const accepted = sent.find(request => request.type === 'BOT_LOCAL_TASK_ACCEPT').payload.result;
    check(starts.length === 1 && starts[0].requestId !== previewRequest.requestId && starts[0].permit === '1'.repeat(64)
      && accepted.taskId === 'wire-preview' && accepted.requestId === previewRequest.requestId,
    'wire/UI/native request identities remain distinct and correctly correlated');
    check(loadedPreviews.length === 0 && !JSON.stringify(sent).includes(audioBase64) && !JSON.stringify(sent).includes('1'.repeat(64)),
      'task events cannot settle the preview response or send preview bytes/private permits over WebSocket');
    const reference = {
      localPreviewId: accepted.localPreviewId, taskId: accepted.taskId,
      requestId: accepted.requestId, executorSessionId: accepted.executorSessionId,
    };
    response(previewRequest, 'COMMAND_AUDIO_PREVIEW_RESULT', { status: 'local', ...reference });
    await waitFor(() => audios.length === 1 && !audios[0].paused);
    const audio = audios[0];
    check(loadedPreviews.length === 1 && loadedPreviews[0].audioBase64 === audioBase64 && !loadedPreviews[0].url
      && audio.src.startsWith('blob:') && !audio.error,
    'the real composer resolves only local bytes through native validation and the actual isolated player');
    const decoded = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(
      Uint8Array.from(atob(audioBase64), byte => byte.charCodeAt(0)).buffer,
    );
    check(decoded.numberOfChannels === 2 && decoded.sampleRate === 48000 && Math.abs(decoded.duration - 0.5) < 0.01,
      'the authored preview is real decodable 48 kHz stereo Opus, not arbitrary test bytes');
    const blobUrl = audio.src;
    audioPreviewService.release(composer);
    check(audio.paused && !audio.getAttribute('src') && revokedUrls.includes(blobUrl),
      'releasing the preview revokes its Blob and detaches the player');
    composer.querySelector('[data-audio-preview-action="toggle"]').click();
    await waitFor(() => sent.filter(request => request.type === 'COMMAND_AUDIO_PREVIEW').length === 2);
    const otherDevice = sent.filter(request => request.type === 'COMMAND_AUDIO_PREVIEW')[1];
    response(otherDevice, 'COMMAND_AUDIO_PREVIEW_RESULT', {
      status: 'local', ...reference, requestId: otherDevice.requestId, executorSessionId: 'another-device',
    });
    await waitFor(() => composer.querySelector('[data-audio-choice-controls]')?.dataset.audioPreviewState === 'failed');
    check(loadedPreviews.length === 1 && audios.length === 1
      && composer.textContent.includes(t('localExecution.failure.permission_denied')),
    'a stale or other-device preview reference produces a localized error without loading bytes');
    composer.querySelector('[data-parameter-option="0"]').click();
    const invocation = view.invoke();
    await waitFor(() => sent.some(request => request.type === 'COMMAND_INVOKE'));
    const invoke = sent.find(request => request.type === 'COMMAND_INVOKE');
    check(preparations.length === 1 && invoke.payload.options.query === 'opaque-result'
      && JSON.stringify(invoke.payload.localPreparation) === JSON.stringify(query.payload.localPreparation)
      && !JSON.stringify(sent).includes('1'.repeat(64)),
    'invocation carries only readiness and preserves canonical selected values while its permit stays local');
    response(invoke, 'COMMAND_INVOKED', {
      invocationId: 'invocation-a', botId: search.botId, commandName: search.name, channelId: 'text',
    });
    await invocation;

    primary.chatStore.selectCommand('text', utility);
    const utilityInvocation = view.invoke();
    await waitFor(() => sent.some(request => request.type === 'COMMAND_INVOKE' && request.payload.commandName === 'pause'));
    const pause = sent.find(request => request.type === 'COMMAND_INVOKE' && request.payload.commandName === 'pause');
    check(preparations.length === 1 && pause.payload.localPreparation === undefined,
      'utility commands without declarations do not request or carry local execution');
    response(pause, 'COMMAND_INVOKED', { invocationId: 'pause-a', botId: utility.botId, commandName: utility.name, channelId: 'text' });
    await utilityInvocation;

    const changedKey = { ...search, botPublicKey: 'b'.repeat(64) };
    primary.chatStore.setCommands([changedKey, utility]);
    primary.serverStore.setSlashCommands([changedKey, utility]);
    primary.chatStore.selectCommand('text', changedKey);
    type('closing');
    await waitFor(() => preparations.length === 2);
    view.destroy();
    check(cancelled.includes(preparations[1].input.requestId), 'destroying the real composer cancels pending native preparation');
    const beforeLate = sent.length;
    preparations[1].resolve({ status: 'prepared', permit: '2'.repeat(64) });
    await flush();
    check(sent.length === beforeLate, 'late setup completion cannot send a request from a destroyed composer');

    view = new BotChatView(primary.chatStore, primary.client, primary.serverStore, 'text', composer, feed, () => {}, () => {});
    primary.chatStore.selectCommand('text', changedKey, 'reopened');
    type('reopened latest');
    await waitFor(() => preparations.length === 3);
    const latestKey = { ...search, botPublicKey: 'c'.repeat(64) };
    primary.chatStore.setCommands([latestKey, utility]);
    primary.serverStore.setSlashCommands([latestKey, utility]);
    preparations[2].resolve({ status: 'prepared', permit: '3'.repeat(64) });
    await flush();
    check(cancelled.includes(preparations[2].input.requestId)
      && !sent.some(request => request.type === 'COMMAND_AUTOCOMPLETE' && request.payload.query === 'reopened latest'),
    'a public-key change invalidates preparation even when the same command draft object survives');
    type('current identity');
    await waitFor(() => preparations.length === 4);
    sessionManager.activate(background.key);
    preparations[3].resolve({ status: 'prepared', permit: '4'.repeat(64) });
    await flush();
    check(!sent.some(request => request.type === 'COMMAND_AUTOCOMPLETE' && request.payload.query === 'current identity'),
      'browsing another server never sends a late composer request through either active proxy');
    check(preparations[3].input.subject.serverId === 'server-a'
      && preparations[3].input.subject.botPublicKey === latestKey.botPublicKey,
    'background routing never changes the original native subject');

    primary.participants.get = sessionId => sessionId === primary.serverStore.currentUser.sessionId
      ? { user: primary.serverStore.currentUser, voiceState: { channelId: 'voice' } } : undefined;
    voiceStore.voiceSessionKey = primary.key;
    voiceStore.currentVoiceChannelId = 'voice';
    appEvents.emit('voice.channel_changed');
    await flush();
    check(connections.filter(state => state.connectionId === primary.client.getConnectionId()).at(-1).voiceChannelId === 'voice'
      && connections.filter(state => state.connectionId === background.client.getConnectionId()).at(-1).voiceChannelId === null,
    'native voice state follows the real voice owner while another server is visible');
    const beforeMute = connections.length;
    voiceStore.isMuted = true;
    voiceStore.isDeafened = true;
    appEvents.emit('voice.updated');
    await flush();
    check(connections.length === beforeMute, 'mute and deafen are not local source lifecycle controls');
    primary.client.setStatus('RECONNECTING');
    await flush();
    check(connections.filter(state => state.connectionId === primary.client.getConnectionId()).at(-1).connected === false,
      'entering reconnecting immediately invalidates native connection state');
  } finally {
    window.setTimeout = originalSetTimeout;
    view.destroy();
    voiceStore.reset();
    sessionManager.dispose();
    root.remove();
    window.Audio = OriginalAudio;
    URL.revokeObjectURL = revokeObjectUrl;
  }
  await flush();
  check(nativeListeners.size === 0 && failureListeners.size === 0, 'session disposal removes native observers');
  return checks;
}
