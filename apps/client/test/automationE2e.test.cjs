const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const { MonkyServer } = require(path.join(repo, 'apps/server/dist/server.js'));
  const { LanBroadcaster } = require(path.join(repo, 'apps/server/dist/infrastructure/discovery/LanBroadcaster.js'));
  const { configureRealSfu } = require('./localExecutionE2e/sfuFixture.cjs');
  for (const mode of ['p2p', 'sfu']) test(`MCP controls real chat, events and two ${mode} participants`, { timeout: 90000 }, async t => {
    const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'monky-mcp-e2e-'));
    const previousHome = process.env.MONKY_HOME;
    let server, child;
    process.env.MONKY_HOME = path.join(profile, 'home');
    t.after(async () => {
      if (child && child.exitCode === null) child.kill();
      if (server) await server.stop();
      if (previousHome === undefined) delete process.env.MONKY_HOME; else process.env.MONKY_HOME = previousHome;
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    });
    t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
    const sfu = mode === 'sfu' ? await configureRealSfu(t, path.join(repo, 'apps/server/dist/infrastructure/sfu/SfuManager.js')) : null;
    server = await MonkyServer.create({ port: 0, discoveryPort: 0, dataDir: path.join(profile, 'server'),
      serverName: 'Isolated MCP QA', voiceMode: mode, initialVoiceChannel: 'MCP call', initialTextChannel: 'MCP chat' });
    const listener = server.listener.listener;
    const listen = listener.listen;
    listener.listen = function(_port, _host, ...rest) { return Reflect.apply(listen, this, [0, '127.0.0.1', ...rest]); };
    await server.start();
    if (sfu) { await server.sfuManager.init(); sfu.assertReady(); }
    const env = { ...process.env, MONKY_AUTOMATION_E2E_PROFILE: path.join(profile, 'desktop'),
      MONKY_AUTOMATION_E2E_PORT: String((await server.getStats()).port), MONKY_AUTOMATION_E2E_MODE: mode };
    delete env.ELECTRON_RUN_AS_NODE;
    fs.mkdirSync(env.MONKY_AUTOMATION_E2E_PROFILE, { recursive: true });
    const code = await new Promise((resolve, reject) => {
      child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { loadMain } = require('./mainModules.cjs');
  const { AutomationService } = loadMain('automation/AutomationService');
  const { AutomationStore } = loadMain('automation/AutomationStore');
  const { AUTOMATION_CAPABILITIES } = require('@monky/shared');
  app.setPath('userData', process.env.MONKY_AUTOMATION_E2E_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, service, client;
  const windows = [];
  const finish = async code => {
    clearTimeout(timeout);
    if (client) await client.close();
    if (service) await service.close();
    for (const browser of windows) if (!browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  const timeout = setTimeout(() => { console.error('Real MCP E2E timed out'); void finish(1); }, 80000);
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, open: false }, plugins: [{ name: 'mcp-e2e', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__mcp_e2e__') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><body></body></html>');
        });
      } }] });
    await new Promise(resolve => vite.httpServer.listen(0, '127.0.0.1', resolve));
    const contexts = [];
    for (let index = 0; index < 2; index++) {
      const browser = new BrowserWindow({ show: false, webPreferences: {
        partition: `mcp-participant-${index}`, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      } });
      windows.push(browser);
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__mcp_e2e__`);
      const sharedUrl = '/@fs/' + path.join(repo, 'packages/shared/src/index.ts').replaceAll('\\', '/');
      contexts.push(await browser.webContents.executeJavaScript(`(${prepareParticipant.toString()})(${Number(process.env.MONKY_AUTOMATION_E2E_PORT)}, ${index}, ${JSON.stringify(sharedUrl)})`, true));
    }
    const [a, b] = contexts;
    assert.equal(a.serverId, b.serverId);
    assert.notEqual(a.userId, b.userId);
    assert.equal(a.mode, process.env.MONKY_AUTOMATION_E2E_MODE);
    const browser = windows[0];
    await browser.webContents.executeJavaScript('window.enableEvents()');
    service = new AutomationService(new AutomationStore(app.getPath('userData')), (command, grant) =>
      browser.webContents.executeJavaScript(`window.executeMcp(${JSON.stringify(command)}, ${JSON.stringify(grant)})`));
    await service.mutate({ action: 'enable', enabled: true });
    const setup = await service.mutate({ action: 'save', connection: { name: 'Real MCP QA', serverIds: [a.serverId], capabilities: [...AUTOMATION_CAPABILITIES] } });
    client = new Client({ name: 'monky-e2e', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(setup.snapshot.url), { requestInit: {
      headers: { Authorization: `Bearer ${setup.credential.token}` },
    } }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.structuredContent;
    };
    assert.equal((await call('list_servers')).servers.length, 1);
    assert.equal((await call('get_state')).connectedServers, 1);
    assert.ok((await call('list_channels', { sessionRef: a.sessionRef })).channels.some(channel => channel.id === a.textId));
    assert.ok((await call('list_members', { sessionRef: a.sessionRef })).members.some(member => member.id === a.userId));
    assert.equal((await call('get_call_state')).call, null);
    const id = require('node:crypto').randomUUID();
    const input = { sessionRef: a.sessionRef, channelId: a.textId, clientMessageId: id, content: 'Isolated MCP message' };
    assert.equal((await call('send_message', input)).message.id, id);
    assert.equal((await call('send_message', input)).message.id, id);
    const messages = (await call('read_messages', { sessionRef: a.sessionRef, channelId: a.textId })).messages;
    assert.equal(messages.filter(message => message.id === id).length, 1);
    const begins = Date.now() + 3600000;
    const created = await call('create_event', { sessionRef: a.sessionRef, event: {
      title: 'Isolated MCP event', description: '', startsAt: begins, endsAt: begins + 3600000,
      timeZone: 'America/Sao_Paulo', location: { kind: 'voice', channelId: a.voiceId },
    } });
    assert.ok((await call('list_events', { sessionRef: a.sessionRef })).events.some(event => event.id === created.event.id));
    assert.equal((await call('join_call', { sessionRef: a.sessionRef, channelId: a.voiceId })).call.isMuted, true);
    const second = await windows[1].webContents.executeJavaScript(`window.executeMcp(${JSON.stringify({ tool: 'join_call', args: { sessionRef: b.sessionRef, channelId: b.voiceId } })})`);
    assert.equal(second.ok, true, JSON.stringify(second));
    await browser.webContents.executeJavaScript('window.waitForTwoParticipants()');
    for (const participant of windows) assert.equal(await participant.webContents.executeJavaScript('window.microphoneCaptures'), 0);
    assert.equal((await call('leave_call', { sessionRef: a.sessionRef, channelId: a.voiceId })).left, true);
    await windows[1].webContents.executeJavaScript(`window.executeMcp(${JSON.stringify({ tool: 'leave_call', args: { sessionRef: b.sessionRef, channelId: b.voiceId } })})`);
    await service.mutate({ action: 'revoke', id: setup.credential.id });
    await assert.rejects(client.listTools());
    console.log(`Real ${a.mode} MCP: messages, deduplication, events, two participants and revocation passed`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function prepareParticipant(port, index, sharedUrl) {
  const identity = await import('/platform/web/webIdentity.ts');
  window.api = { platform: 'win32', capabilities: { localExecution: false, botScreens: false, nativeScreenAudio: false, plainRemoteServers: true },
    signChallenge: identity.signWebChallenge };
  const [{ sessionManager }, { hydrateServerSession, bindServerStateEvents }, { bindVoiceEvents }, { executeAutomation },
    { appEvents }, { soundEffects }, { voiceStore }, { MessageType, automationRequestSchema }, { webRtcManager }] = await Promise.all([
    import('/core/SessionManager.ts'), import('/core/serverStateEvents.ts'), import('/core/voiceEvents.ts'),
    import('/core/automation/executeAutomation.ts'), import('/core/EventBus.ts'), import('/core/SoundEffects.ts'),
    import('/stores/voiceStore.ts'), import(sharedUrl),
    import('/core/WebRtcManager.ts'),
  ]);
  soundEffects.play = () => {};
  window.microphoneCaptures = 0;
  navigator.mediaDevices.getUserMedia = async () => { window.microphoneCaptures++; throw new Error('Physical capture is forbidden in this test'); };
  sessionManager.install();
  bindServerStateEvents({ reconnect: { settingsUpdated() {} } });
  bindVoiceEvents({ reconnect: { departed() {} }, render() {}, rejoinOnScreen() {} });
  const session = sessionManager.create('127.0.0.1', port, `MCP participant ${index}`);
  sessionManager.activate(session.key);
  const auth = await session.client.connect('127.0.0.1', port, await identity.createWebIdentity(), session.nickname);
  hydrateServerSession(auth);
  webRtcManager.setIceServers(auth.iceServers);
  const serverId = auth.server.id;
  window.executeMcp = (command, grant = { serverIds: [serverId], capabilities: ['read', 'send_messages', 'create_events', 'control_calls'] }) => {
    const request = automationRequestSchema.parse({ requestId: crypto.randomUUID(), command, grant });
    return executeAutomation(request, new AbortController().signal);
  };
  window.enableEvents = () => session.client.sendRequest(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: true });
  window.waitForTwoParticipants = () => new Promise((resolve, reject) => {
    let timer;
    const done = () => {
      if (session.participants.getInVoiceChannel(voiceStore.currentVoiceChannelId).length < 2) return;
      unbind(); clearTimeout(timer); resolve();
    };
    const unbind = appEvents.on('participants.updated', done);
    timer = setTimeout(() => { unbind(); reject(new Error('Two real voice participants were not observed')); }, 10000);
    done();
  });
  return { serverId, sessionRef: session.client.getConnectionId(), userId: auth.currentUser.id, mode: auth.server.voiceMode,
    textId: auth.server.channels.find(channel => channel.type === 'TEXT').id,
    voiceId: auth.server.channels.find(channel => channel.type === 'VOICE').id };
}
