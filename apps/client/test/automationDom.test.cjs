const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('automation uses explicit sessions, safe call admission and accessible localized settings', { timeout: 90000 }, async t => {
    const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'monky-automation-dom-'));
    const env = { ...process.env, MONKY_AUTOMATION_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true });
        t.after(() => { if (child.exitCode === null) child.kill(); });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_AUTOMATION_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async code => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  timeout = setTimeout(() => { console.error('Automation DOM timed out'); void finish(1); }, 80000);
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{ name: 'automation-fixture', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__automation__') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
        });
      } }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    browser.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    browser.webContents.debugger.attach('1.3');
    for (const locale of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__automation__`);
      await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      const sharedUrl = '/@fs/' + path.resolve(root, '..', '..', 'packages/shared/src/index.ts').replaceAll('\\', '/');
      const count = await browser.webContents.executeJavaScript(`(${runAutomationSmoke.toString()})(${JSON.stringify(locale)}, ${JSON.stringify(sharedUrl)})`, true);
      await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const screenshot = await browser.webContents.capturePage();
      fs.mkdirSync(path.join(root, 'dist-test'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist-test', `automation-${locale}.png`), screenshot.toPNG());
      console.log(`Automation ${locale}: ${count} checks passed`);
    }
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runAutomationSmoke(locale, sharedUrl) {
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  let checks = 0;
  const check = (condition, description) => { if (!condition) throw new Error(description); checks++; };
  let snapshot = { enabled: true, url: 'http://127.0.0.1:45123/mcp', error: null, connections: [], audit: [] };
  let changed, mutation;
  const api = {
    platform: 'win32', capabilities: { automation: true, nativeScreenAudio: false },
    getAutomationSnapshot: async () => snapshot,
    onAutomationChanged: callback => { changed = callback; return () => { changed = undefined; }; },
    mutateAutomation: async input => {
      const result = { snapshot };
      if (input.action === 'save') {
        const connection = { ...input.connection, id: input.connection.id ?? crypto.randomUUID() };
        snapshot = { ...snapshot, connections: [...snapshot.connections.filter(item => item.id !== connection.id), connection] };
        result.credential = { id: connection.id, token: 'test-token-shown-once' };
      } else if (input.action === 'revoke') snapshot = { ...snapshot, connections: [] };
      else if (input.action === 'enable') snapshot = { ...snapshot, enabled: input.enabled };
      result.snapshot = snapshot;
      changed?.(snapshot);
      mutation?.();
      return result;
    },
  };
  window.api = api;
  const [shared, { sessionManager }, { executeAutomation }, { voiceStore }, { audioProcessor }, { webRtcManager },
    { AutomationTab }, i18n, { soundEffects }, { toggleMicrophoneMute }, { joinCallOnSession }, network] = await Promise.all([
    import(sharedUrl),
    import('/core/SessionManager.ts'), import('/core/automation/executeAutomation.ts'),
    import('/stores/voiceStore.ts'), import('/core/AudioProcessor.ts'), import('/core/WebRtcManager.ts'),
    import('/views/settings/tabs/AutomationTab.ts'), import('/i18n/index.ts'),
    import('/core/SoundEffects.ts'), import('/core/voiceControls.ts'),
    import('/core/serverConnection.ts'), import('/core/NetworkClient.ts'),
  ]);
  i18n.setLanguage(locale);
  soundEffects.play = () => {};
  const user = { id: 'owner', sessionId: 'owner-session', nickname: 'Owner', status: 'ONLINE', joinedAt: 1 };
  const sessions = ['a', 'b'].map((name, index) => {
    const session = sessionManager.create('127.0.0.1', 45000 + index, name, 'private-password');
    session.client.getStatus = () => 'CONNECTED';
    session.serverStore.currentUser = { ...user, sessionId: `${name}-owner-session` };
    session.serverStore.serverDetails = { id: `server-${name}`, name: `Server ${name}`, ownerId: 'owner',
      channels: [{ id: `chat-${name}`, name: 'Chat', type: 'TEXT' }, { id: `voice-${name}`, name: 'Voice', type: 'VOICE' }],
      members: [session.serverStore.currentUser], categories: [], roles: [], maxMessageLength: 2000,
      protocol: { features: ['chat-delivery', 'server-community'] }, voiceMode: 'p2p',
    };
    session.serverStore.ownerId = 'owner';
    session.serverStore.myPermissions = 0xffffffff;
    return session;
  });
  const [a, b] = sessions;
  sessionManager.activate(b.key);
  const ref = a.client.getConnectionId();
  const grant = { serverIds: ['server-a'], capabilities: [...shared.AUTOMATION_CAPABILITIES] };
  const run = (tool, args = {}, signal = new AbortController().signal) => executeAutomation({ requestId: crypto.randomUUID(), grant, command: { tool, args } }, signal);
  const listed = await run('list_servers');
  check(listed.ok && listed.data.servers.length === 1, 'server allowlist filters discovery');
  check(!JSON.stringify(listed).includes('private-password'), 'session credentials are never returned');
  check((await run('list_channels', { sessionRef: ref })).data.channels[0].id === 'chat-a', 'explicit session ignores the visible server');
  check(!(await run('list_channels', { sessionRef: b.client.getConnectionId() })).ok, 'unauthorized server is refused');
  const { bindAutomation } = await import('/core/automation/bridge.ts');
  delete window.api;
  try {
    bindAutomation()();
    check(true, 'a renderer without the desktop preload does not start automation');
  } finally { window.api = api; }
  let receiveRequest;
  const replies = [];
  api.onAutomationRequest = callback => { receiveRequest = callback; return () => { receiveRequest = null; }; };
  api.onAutomationCancel = () => () => {};
  api.automationReady = async () => {};
  api.replyAutomation = async reply => { replies.push(reply); };
  const unbindAutomation = bindAutomation();
  const envelope = { requestId: crypto.randomUUID(), command: { tool: 'get_state', args: {} }, grant };
  receiveRequest({ ...envelope, grant: { ...grant, id: crypto.randomUUID(), name: 'Extra metadata' } });
  check(replies.at(-1)?.result.code === 'invalid_input', 'invalid grants return a correlated error instead of a disconnected timeout');
  receiveRequest({ ...envelope, requestId: 'invalid-id' });
  check(replies.length === 1, 'invalid correlation identifiers are not echoed');
  receiveRequest(envelope);
  await Promise.resolve();
  check(replies.at(-1)?.result.ok && replies.at(-1).result.data.connectedServers === 1, 'validated bridge requests execute and return a reply');
  unbindAutomation();
  check(receiveRequest === null, 'the automation bridge removes its subscription');
  let sent = 0, saved = 0, resolveHistory;
  const events = [];
  let pendingHistory = false, pendingJoin = false, resolveJoin;
  a.client.cancelRequest = () => true;
  a.client.send = () => {};
  a.client.sendRequest = async (type, payload) => {
    if (type === shared.MessageType.CHAT_LOAD_HISTORY) {
      const result = { channelId: 'chat-a', messages: [{ id: 'm', userId: 'owner', content: '<b>text</b>', createdAt: 100 }] };
      return pendingHistory ? new Promise(resolve => { resolveHistory = () => resolve(result); }) : result;
    }
    if (type === shared.MessageType.CHAT_SEND) {
      sent++;
      return { id: payload.clientMessageId, userId: 'owner', channelId: payload.channelId, content: payload.content, createdAt: 200 };
    }
    if (type === shared.MessageType.EVENT_SAVE) {
      saved++;
      const event = { ...payload, id: crypto.randomUUID(), status: 'scheduled', revision: 1, occurrence: payload.startsAt,
        anchorStartsAt: payload.startsAt, startedAt: null, endedAt: null, createdAt: 1, creatorUserId: 'owner',
        imageUrl: null, imageUrls: [], interested: false, interestedCount: 0 };
      events.push(event);
      return { event };
    }
    if (type === shared.MessageType.COMMUNITY_GET) return { settings: { eventsEnabled: true, bannerUrl: null }, events, liveActions: [], polls: [], nativeForms: [] };
    if (type === shared.MessageType.VOICE_JOIN || type === shared.MessageType.VOICE_RECONNECT) {
      const response = { channelId: payload.channelId, userId: 'owner', sessionId: a.serverStore.currentUser.sessionId,
        voiceState: { sessionId: a.serverStore.currentUser.sessionId, userId: 'owner', channelId: payload.channelId,
          isMuted: true, isDeafened: false, serverMuted: false, serverDeafened: false }, participants: [] };
      return pendingJoin ? new Promise(resolve => { resolveJoin = () => resolve(response); }) : response;
    }
    throw new Error(`Unexpected request ${type}`);
  };
  const history = await run('read_messages', { sessionRef: ref, channelId: 'chat-a', limit: 1 });
  check(history.ok && history.data.nextBeforeTimestamp === 100, 'bounded history returns its pagination cursor');
  check(a.serverStore.activeTextChannelId === null, 'history does not navigate or mark a channel read');
  const messageId = crypto.randomUUID();
  check((await run('send_message', { sessionRef: ref, channelId: 'chat-a', content: 'hello', clientMessageId: messageId })).ok && sent === 1, 'message waits for server acknowledgement');
  const eventInput = { title: 'Meeting', description: '', startsAt: 2000000000000, endsAt: 2000003600000,
    timeZone: 'America/Sao_Paulo', location: { kind: 'voice', channelId: 'voice-a' } };
  check((await run('create_event', { sessionRef: ref, event: eventInput })).ok && saved === 1, 'event uses the existing server contract');
  check((await run('list_events', { sessionRef: ref })).data.events.length === 1, 'created event can be listed');
  pendingHistory = true;
  const stale = run('read_messages', { sessionRef: ref, channelId: 'chat-a', limit: 1 });
  const connectionId = a.client.getConnectionId;
  a.client.getConnectionId = () => 'new-connection';
  resolveHistory();
  check((await stale).code === 'disconnected', 'late responses from a replaced connection are discarded');
  a.client.getConnectionId = connectionId;
  pendingHistory = false;
  const originalRequest = a.client.sendRequest;
  a.client.sendRequest = async () => { throw new network.RequestTimeoutError('timeout'); };
  check((await run('create_event', { sessionRef: ref, event: eventInput })).code === 'unknown_outcome', 'event timeout is not retried or reported as success');
  a.client.sendRequest = originalRequest;

  let captures = 0, sfu = false, sfuJoins = 0;
  const context = new AudioContext();
  const source = context.createMediaStreamDestination();
  audioProcessor.startMicrophone = async () => { captures++; return source.stream.clone(); };
  webRtcManager.setLocalAudioTrack = async () => {};
  webRtcManager.isSfuMode = () => sfu;
  webRtcManager.initSfuForCurrentChannel = async () => { sfuJoins++; voiceStore.setReconnecting(false); };
  for (const mode of ['p2p', 'sfu']) {
    sfu = mode === 'sfu';
    const before = captures;
    const joined = await run('join_call', { sessionRef: ref, channelId: 'voice-a' });
    check(joined.ok && voiceStore.isMuted && captures === before, `${mode} joins without capturing the microphone`);
    check((await run('join_call', { sessionRef: ref, channelId: 'voice-a' })).ok, 'joining the established room is idempotent');
    check((await run('leave_call', { sessionRef: ref, channelId: 'wrong-room' })).code === 'call_conflict', 'a stale leave cannot end a different call');
    if (mode === 'sfu') {
      check(sfuJoins === 1, 'SFU admission uses its existing transport');
      toggleMicrophoneMute();
      await frame();
      check(captures === before + 1 && !voiceStore.microphoneCaptureDeferred, 'manual unmute starts the deferred microphone');
    } else {
      await joinCallOnSession(a.key, 'voice-a', { transitionId: 'reconnect', isCurrent: () => true });
      check(captures === before, 'reconnection preserves deferred capture');
    }
    check((await run('leave_call', { sessionRef: ref, channelId: 'voice-a' })).ok && !voiceStore.currentVoiceChannelId, `${mode} leave releases the call`);
  }
  await run('join_call', { sessionRef: ref, channelId: 'voice-a' });
  const status = a.client.getStatus;
  a.client.getStatus = () => 'RECONNECTING';
  voiceStore.setReconnecting(true);
  check((await run('get_call_state')).data.call.channelId === 'voice-a', 'local call intent remains visible while reconnecting');
  check((await run('leave_call', { sessionRef: ref, channelId: 'voice-a' })).ok && !voiceStore.currentVoiceChannelId, 'leaving does not wait for a disconnected server');
  a.client.getStatus = status;
  pendingJoin = true;
  const controller = new AbortController();
  const cancelledJoin = run('join_call', { sessionRef: ref, channelId: 'voice-a' }, controller.signal);
  await frame();
  const beforePendingUnmute = captures;
  toggleMicrophoneMute();
  check(voiceStore.isMuted && captures === beforePendingUnmute, 'manual unmute cannot capture before admission is confirmed');
  check((await run('join_call', { sessionRef: ref, channelId: 'voice-a' })).code === 'call_conflict', 'pending admission is not reported as joined');
  controller.abort();
  resolveJoin();
  check(!(await cancelledJoin).ok && !voiceStore.currentVoiceChannelId, 'cancelling admission removes the call and rejects the late reply');
  await context.close();

  const tab = new AutomationTab();
  document.getElementById('app').innerHTML = `<div class="modal-card" style="margin:24px auto;padding:24px;max-width:800px">${tab.renderHtml()}</div>`;
  const previousSnapshot = snapshot;
  let resolveSnapshot;
  api.getAutomationSnapshot = () => new Promise(resolve => { resolveSnapshot = resolve; });
  const mounting = tab.attachEvents(document.getElementById('app'));
  snapshot = { ...snapshot, enabled: false, url: null };
  changed(snapshot);
  resolveSnapshot(previousSnapshot);
  await mounting;
  check(!document.querySelector('#automation-enabled').checked, 'a late snapshot cannot overwrite a newer settings notification');
  snapshot = previousSnapshot;
  changed(snapshot);
  const enabled = document.querySelector('#automation-enabled');
  check(enabled.getAttribute('role') === 'switch' && enabled.checked, 'enable control uses the shared accessible switch');
  document.querySelector('[data-action=add]').click();
  await frame();
  check(document.activeElement?.matches('[name=assistant]'), 'editor receives keyboard focus');
  document.querySelector('[name=assistant]').value = '<img src=x onerror="window.injected=true">';
  document.querySelector('[data-server="server-a"]').click();
  document.querySelector('[data-scope=read]').click();
  const savedUi = new Promise(resolve => { mutation = resolve; });
  document.querySelector('[data-save]').click();
  await savedUi;
  await frame();
  check(snapshot.connections.length === 1 && snapshot.connections[0].serverIds.length === 1, 'saving grants only the selected server and capability');
  check(!window.injected && !document.querySelector('.automation-list img'), 'external names render as escaped text');
  const setup = [...document.querySelectorAll('.automation-setup pre')].at(-1)?.textContent;
  check(setup?.includes('--bearer-token-env-var MONKY_MCP_') && setup.includes('$env:'), 'setup generates a valid PowerShell command with token environment authentication');
  check(!!document.querySelector('[data-copy]') && !document.body.innerText.includes('automation.'), 'localized setup provides an accessible copy action');
  return checks;
}
