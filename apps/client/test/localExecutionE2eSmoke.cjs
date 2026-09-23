const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const dns = require('node:dns');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');
const { BotClient } = require('@monky/bot-sdk');
const {
  botCapabilitiesSchema, MessageType, PROTOCOL_VERSION, localTaskOfferSchema, localMediaSignalSchema,
} = require('@monky/shared');
const clientRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');
const helpers = path.join(__dirname, 'localExecutionE2e');
const { configureRealSfu } = require(path.join(helpers, 'sfuFixture.cjs'));
const ffmpeg = process.env.MONKY_WORKER_TEST_FFMPEG;
const musicBotRoot = process.env.MONKY_LOCAL_E2E_MUSIC_BOT_ROOT;

async function until(condition, description, timeout = 20_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const result = await condition();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`E2E timed out: ${description}`);
}

function observeAuthority(rows, wireStringTags, violations) {
  const serverSockets = new WeakSet();
  const peers = new WeakMap();
  const send = WebSocket.prototype.send;
  const emit = WebSocket.prototype.emit;
  const serverEmit = WebSocketServer.prototype.emit;
  const ownedEmit = Object.hasOwn(WebSocket.prototype, 'emit');
  const ownedServerEmit = Object.hasOwn(WebSocketServer.prototype, 'emit');
  const inspect = (socket, direction, bytes) => {
    if (!serverSockets.has(socket)) return;
    const message = JSON.parse(bytes.toString());
    const payload = message.payload ?? {};
    if (direction === 'in' && message.type === MessageType.AUTH_CONNECT) {
      peers.set(socket, typeof payload.botToken === 'string' ? 'bot'
        : payload.nickname === 'Local executor' ? 'executor' : 'listener');
      assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
    }
    const peer = peers.get(socket);
    if (!peer) return;
    const visit = value => {
      if (typeof value === 'string') {
        wireStringTags.add(createHash('sha256').update(value).digest('hex'));
        assert.doesNotMatch(value, /googlevideo\.com|data:audio\/|[?&](?:sig|signature|expire)=/i,
          'Provider media/signed URLs must not travel over WebSocket.');
      } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          assert.ok(!['permit', 'subject', 'connectionId', 'audioBase64', 'audioUrl', 'frames'].includes(key),
            `A private Main/media field reached WebSocket: ${key}`);
          visit(item);
        }
      }
    };
    visit(payload);
    if (message.requestId) wireStringTags.add(createHash('sha256').update(message.requestId).digest('hex'));
    if (message.type === MessageType.COMMAND_INVOKE && direction === 'in' && peer === 'executor') {
      if (['play', 'local-smoke'].includes(payload.commandName)) {
        assert.deepEqual(payload.localPreparation, { capability: 'youtube-audio' });
      } else assert.equal(payload.localPreparation, undefined, 'Controls do not require a local capability.');
    }
    if (message.type === MessageType.COMMAND_INVOKE && direction === 'out' && peer === 'bot') {
      assert.equal(payload.localPreparation, undefined, 'Server-to-bot invocation must omit client preparation.');
    }
    if (message.type === MessageType.BOT_LOCAL_TASK_OFFER) localTaskOfferSchema.parse(payload);
    if (message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL) localMediaSignalSchema.parse(payload);
    rows.push({
      at: Date.now(), event: 'wire', peer, direction, type: message.type, requestId: message.requestId,
      taskId: payload.taskId, payloadRequestId: payload.requestId,
      state: payload.state, cause: payload.cause, revision: payload.revision, action: payload.action,
      status: payload.status, operation: payload.spec?.operation ?? payload.result?.operation,
      contextKind: payload.context?.kind,
      sourceContextId: payload.source?.sourceContextId ?? payload.sourceContextId ?? payload.context?.sourceContextId,
      url: payload.source?.url ?? payload.url, invokerSessionId: payload.source?.invokerSessionId,
      playedFrames: payload.playedFrames, generation: payload.media?.generation ?? payload.mediaGeneration,
      signalType: payload.signalType,
      sfuPorts: Array.isArray(payload.transportOptions?.iceCandidates)
        ? payload.transportOptions.iceCandidates.map(candidate => candidate.port) : undefined,
    });
  };
  const observe = (...args) => {
    try { inspect(...args); }
    catch (error) {
      if (!(error instanceof Error) ||
          !['AssertionError', 'SyntaxError', 'ZodError'].includes(error.name)) throw error;
      violations.push(error);
      rows.push({ event: 'invariant.failed', message: error.message });
    }
  };
  WebSocketServer.prototype.emit = function(event, ...args) {
    if (event === 'connection') serverSockets.add(args[0]);
    return Reflect.apply(serverEmit, this, [event, ...args]);
  };
  WebSocket.prototype.send = function(bytes, ...args) {
    observe(this, 'out', bytes);
    return Reflect.apply(send, this, [bytes, ...args]);
  };
  WebSocket.prototype.emit = function(event, ...args) {
    if (event === 'message') observe(this, 'in', args[0]);
    return Reflect.apply(emit, this, [event, ...args]);
  };
  return () => {
    WebSocket.prototype.send = send;
    if (ownedEmit) WebSocket.prototype.emit = emit;
    else delete WebSocket.prototype.emit;
    if (ownedServerEmit) WebSocketServer.prototype.emit = serverEmit;
    else delete WebSocketServer.prototype.emit;
  };
}

function startActor(config, rows) {
  const env = { ...process.env, MONKY_LOCAL_E2E_CONFIG: JSON.stringify(config), MONKY_HOME: config.profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(require('electron'), [path.join(helpers, 'electronActor.cjs')], {
    cwd: clientRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', exited = false, confirmed = false, nextId = 0;
  const pending = new Map();
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-48_000); });
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-48_000); });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error(`${config.role} startup timed out.\n${output}`)), 60_000);
  child.on('message', message => {
    if (message.type === 'event') {
      rows.push(message.row);
      if (message.row.event === 'cleanup.confirmed') confirmed = true;
    }
    if (message.type === 'ready') { clearTimeout(readyTimer); readyResolve(message.value); }
    if (message.type === 'startupFailed') {
      clearTimeout(readyTimer);
      readyReject(new Error(`${config.role}: ${message.error}\n${output}`));
    }
    if (message.type === 'cleanupFailed') rows.push({ event: 'cleanup.failed', role: config.role, error: message.error });
    if (message.type === 'response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${config.role}: ${message.error}\n${output}`));
      else request.resolve(message.value);
    }
  });
  const closed = new Promise(resolve => child.once('close', code => {
    exited = true;
    clearTimeout(readyTimer);
    const error = new Error(`${config.role} exited (${code}).\n${output}`);
    readyReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    resolve(code);
  }));
  child.once('error', error => { clearTimeout(readyTimer); readyReject(error); });
  const call = (action, ...args) => new Promise((resolve, reject) => {
    if (exited || !child.connected) return reject(new Error(`${config.role} is no longer available.\n${output}`));
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${config.role}.${action} timed out.\n${output}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, action, args }, error => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
  return {
    ready, call, child,
    async stop() {
      if (confirmed) { await closed; return; }
      if (exited) throw new Error(`${config.role} exited without confirmed native cleanup.\n${output}`);
      const result = await call('shutdown');
      assert.equal(result.clean, true);
      assert.equal(await closed, 0);
      confirmed = true;
    },
  };
}

async function startRealServer(root, mode) {
  const { MonkyServer } = require(path.join(repoRoot, 'apps', 'server', 'dist', 'server.js'));
  const { LanBroadcaster } = require(path.join(repoRoot, 'apps', 'server', 'dist', 'infrastructure', 'discovery', 'LanBroadcaster.js'));
  const create = http.createServer;
  const announce = LanBroadcaster.prototype.start;
  let server;
  let listeners = 0;
  http.createServer = (...args) => {
    const listener = Reflect.apply(create, http, args);
    const listen = listener.listen;
    listener.listen = function(port, _host, ...rest) {
      assert.equal(port, 0, 'A real server must not acquire a normal application port.');
      listeners++;
      return Reflect.apply(listen, this, [0, '127.0.0.1', ...rest]);
    };
    return listener;
  };
  LanBroadcaster.prototype.start = async () => {
    throw new Error('LAN broadcasting is intentionally disabled in this loopback-only smoke.');
  };
  try {
    server = await MonkyServer.create({
      port: 0, discoveryPort: 0, dataDir: path.join(root, 'server'),
      serverName: 'Isolated local execution E2E', voiceMode: mode,
      initialVoiceChannel: 'Authored audio', initialTextChannel: 'Smoke commands',
    });
    await server.start();
    assert.equal(listeners, 1);
    assert.ok((await server.getStats()).port > 0);
    return server;
  } catch (error) {
    if (server) await server.stop();
    throw error;
  } finally {
    http.createServer = create;
    LanBroadcaster.prototype.start = announce;
  }
}

async function startRendererServer(root) {
  const { createServer } = await import('vite');
  const main = path.join(clientRoot, 'src', 'renderer', 'main.ts');
  const renderer = path.join(helpers, 'renderer.mjs');
  const vite = await createServer({
    configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
    cacheDir: path.join(root, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
    plugins: [{
      name: 'local-execution-real-renderer-smoke', enforce: 'pre',
      resolveId(id) { if (id === '/__local_execution_e2e_renderer__.mjs') return renderer; },
      transform(code, id) {
        if (path.normalize(id.split('?')[0]) === main) {
          return { code: `${code}\nexport { App as LocalExecutionE2eApp };`, map: null };
        }
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__local_execution_e2e__') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/footerControls.css"></head><body><div id="app"></div></body></html>');
        });
      },
    }],
  });
  try {
    const listener = vite.httpServer;
    assert.ok(listener, 'The real Vite renderer server must have an HTTP listener.');
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => { listener.removeListener('error', reject); resolve(); });
    });
    const address = listener.address();
    assert.ok(address && typeof address !== 'string' && address.address === '127.0.0.1');
    return { vite, url: `http://127.0.0.1:${address.port}/__local_execution_e2e__` };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

async function assertTaskTrace(rows, taskId, frames, startIndex) {
  // WebSocket completion may arrive before the independent SCTP/IPC acknowledgements.
  await until(() => {
    const pending = rows.slice(startIndex);
    const created = pending.find(row => row.role === 'executor' && row.event === 'private.created');
    return created && pending.some(row => row.role === 'executor' && row.event === 'private.record' &&
      row.peer === created.peer && row.kind === 'drainAck') &&
      pending.some(row => row.role === 'executor' && row.event === 'ipc.played.end' &&
        row.playedFrames === frames && row.status === 'completed');
  }, 'ordered private drain ACK and final Main playback acknowledgement', 5_000);
  const taskRows = rows.slice(startIndex);
  const wire = rows.filter(row => row.event === 'wire' && row.taskId === taskId);
  const offers = wire.filter(row => row.direction === 'out' && row.type === MessageType.BOT_LOCAL_TASK_OFFER);
  assert.equal(offers.length, 2, 'The real server must reserve the task for both endpoints.');
  const botOffer = offers.find(row => row.peer === 'bot');
  const executorOffer = offers.find(row => row.peer === 'executor');
  assert.ok(botOffer?.requestId);
  assert.equal(executorOffer?.requestId, undefined, 'Executor offers must not settle an unrelated RPC.');
  assert.equal(botOffer.payloadRequestId, executorOffer.payloadRequestId);
  if (executorOffer.contextKind === 'source') {
    assert.ok(rows.some(row => row.type === MessageType.BOT_LOCAL_SOURCE_RESULT &&
      row.status === 'retained' && row.sourceContextId === executorOffer.sourceContextId));
  } else {
    assert.ok(rows.some(row => row.event === 'wire' && row.type === MessageType.COMMAND_INVOKE &&
      row.direction === 'in' && row.requestId === executorOffer.payloadRequestId));
  }
  assert.ok(rows.some(row => row.event === 'wire' && row.type === MessageType.BOT_LOCAL_TASK_REQUEST &&
    row.direction === 'in' && row.peer === 'bot' && row.requestId === botOffer.requestId));
  const firstSignal = wire.findIndex(row => row.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL);
  assert.ok(firstSignal > wire.indexOf(botOffer) && firstSignal > wire.indexOf(executorOffer));
  const accepted = wire.findIndex(row => row.direction === 'out' && row.state === 'accepted');
  const ready = wire.findIndex(row => row.direction === 'out' && row.state === 'ready');
  assert.ok(accepted >= 0 && ready > accepted);
  assert.equal(wire.filter(row => row.direction === 'in' && row.state === 'ready').length, 2);
  const completed = wire.find(row => row.direction === 'out' && row.state === 'completed');
  assert.equal(completed?.playedFrames, frames);
  assert.ok(!wire.some(row => row.state === 'cancelled' || row.state === 'failed'));

  const created = taskRows.find(row => row.role === 'executor' && row.event === 'private.created');
  assert.ok(created, 'This task must create its own private connection.');
  const records = taskRows.filter(row => row.event === 'private.record' &&
    row.role === 'executor' && row.peer === created.peer);
  let sent = 0, consumed = 0, played = 0, windowEnd = 0, previousSequence;
  let ended = false, latePlayed = 0, drained = false, finalSequence;
  for (const record of records) {
    if (record.kind === 'credit') {
      assert.equal(record.direction, 'in');
      assert.ok(record.consumedFrames >= consumed && record.consumedFrames <= sent);
      assert.ok(record.windowEnd >= record.consumedFrames && record.windowEnd - record.consumedFrames <= 25);
      consumed = record.consumedFrames;
      windowEnd = record.windowEnd;
    } else if (record.kind === 'frame') {
      assert.equal(record.direction, 'out');
      assert.equal(ended, false);
      if (previousSequence !== undefined) assert.equal(record.sequence, previousSequence + 1);
      previousSequence = record.sequence;
      sent++;
      assert.ok(sent <= windowEnd, 'Producer exceeded actual receiver consumption credit.');
      assert.ok(record.bytes >= 1 && record.bytes <= 1275);
    } else if (record.kind === 'played') {
      assert.equal(record.direction, 'in');
      assert.ok(record.playedFrames >= played && record.playedFrames <= consumed,
        'PLAYED must not regress or precede its related CREDIT.');
      if (ended && record.playedFrames > played) latePlayed++;
      played = record.playedFrames;
    } else if (record.kind === 'end') {
      assert.equal(record.direction, 'out');
      assert.equal(ended, false);
      ended = true;
      finalSequence = record.finalSequence;
    } else if (record.kind === 'drainAck') {
      assert.equal(record.direction, 'in');
      assert.equal(ended, true);
      assert.equal(played, sent);
      assert.equal(record.finalSequence, finalSequence);
      drained = true;
    }
  }
  assert.equal(sent, frames);
  assert.equal(played, frames);
  assert.ok(drained && latePlayed > 0, 'EOF must retain playback progress until the actual final drain.');
  const nativeClosed = taskRows.find(row => row.role === 'executor' && row.event === 'native.closed' &&
    row.operation === 'youtube.stream');
  assert.ok(nativeClosed);
  assert.ok(taskRows.some(row => row.role === 'executor' && row.event === 'ipc.played.end' &&
    row.playedFrames === frames && row.at >= nativeClosed.at && row.status !== 'failed'),
  'The real Main EOF lease must accept the final PLAYED after native/cache closure.');
  const prepared = rows.findLast(row => row.role === 'executor' && row.event === 'ipc.prepare.end' &&
    row.status === 'prepared' && row.at <= created.at);
  const opened = taskRows.find(row => row.role === 'executor' && row.event === 'private.open');
  const started = taskRows.find(row => row.role === 'executor' && row.event === 'native.start' &&
    row.operation === 'youtube.stream');
  assert.ok(prepared && created && opened && started &&
    prepared.at <= created.at && created.at <= opened.at && opened.at <= started.at);
  const firstRead = taskRows.find(row => row.role === 'executor' && row.event === 'ipc.read.begin');
  assert.ok(firstRead && wire[ready].at <= firstRead.at, 'Native reads must wait for authoritative ready.');
}

for (const mode of ['p2p', 'sfu']) {
  test(`${musicBotRoot ? 'production MonkyBot commands and mixed requester queue' : 'real protocol20 local executor -> private RTC -> SDK bot voice'} -> decoded renderer PCM (${mode.toUpperCase()})`, {
    timeout: 180_000, concurrency: false,
  }, t => runMediaSmoke(t, mode));
}

async function runMediaSmoke(t, mode) {
  assert.ok(ffmpeg && path.isAbsolute(ffmpeg),
    'Set MONKY_WORKER_TEST_FFMPEG to an existing explicit fixture FFmpeg; this smoke never installs tools.');
  assert.ok((await fs.stat(ffmpeg)).isFile());
  assert.equal(PROTOCOL_VERSION, 20);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `monky-local-execution-e2e-${mode}-`));
  const oldHome = process.env.MONKY_HOME;
  process.env.MONKY_HOME = path.join(root, 'monky-home');
  const rows = [], actors = [], jobs = [], botErrors = [];
  const wireStringTags = new Set();
  const violations = [];
  const restoreAuthority = observeAuthority(rows, wireStringTags, violations);
  let server, vite, bot, sfu, disposeMusic;
  let clean = true;
  let successful = false;
  const evidence = {};
  // Offline DNS is a test-process restriction, not a replacement ICE configuration.
  const lookup = dns.lookup;
  const promiseLookup = dns.promises.lookup;
  const localDnsNames = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  dns.lookup = (hostname, options, callback) => {
    if (localDnsNames.has(hostname)) return lookup(hostname, options, callback);
    const done = typeof options === 'function' ? options : callback;
    queueMicrotask(() => done(Object.assign(new Error('External DNS disabled by isolated E2E.'), { code: 'ENOTFOUND' })));
  };
  dns.promises.lookup = async (hostname, ...options) => {
    if (localDnsNames.has(hostname)) return promiseLookup(hostname, ...options);
    throw Object.assign(new Error('External DNS disabled by isolated E2E.'), { code: 'ENOTFOUND' });
  };
  t.after(async () => {
    if (!successful) t.diagnostic(JSON.stringify({
      evidence, sfu: sfu?.snapshot(),
      jobs: jobs.map(job => ({
        state: job.state, played: job.played,
        error: job.error && { name: job.error.name, code: job.error.code, message: job.error.message, event: job.error.event },
      })),
      recent: rows.filter(row => row.event !== 'wire' || row.type.startsWith('COMMAND') || row.type.startsWith('BOT_LOCAL'))
        .slice(-45).map(row => ({
          event: row.event, role: row.role, peer: row.peer, type: row.type, direction: row.direction,
          state: row.state, status: row.status, reason: row.reason, message: row.message,
          operation: row.operation, sourceContextId: row.sourceContextId, error: row.error,
          kind: row.kind, playedFrames: row.playedFrames, finalSequence: row.finalSequence,
        })),
    }));
    const failures = [...violations];
    for (const job of jobs) {
      if (job.local) {
        try { await job.local.close(); } catch (error) { clean = false; failures.push(error); }
      }
    }
    if (disposeMusic) try { await disposeMusic(); } catch (error) { clean = false; failures.push(error); }
    if (bot) try { await bot.close(); } catch (error) { clean = false; failures.push(error); }
    for (const actor of actors) {
      try { await actor.stop(); } catch (error) { clean = false; failures.push(error); }
    }
    if (server) try { await server.stop(); } catch (error) { clean = false; failures.push(error); }
    if (vite) try { await vite.close(); } catch (error) { clean = false; failures.push(error); }
    restoreAuthority();
    dns.lookup = lookup;
    dns.promises.lookup = promiseLookup;
    if (oldHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = oldHome;
    if (clean) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else t.diagnostic(`Unconfirmed cleanup: preserving the exact isolated fixture directory ${root}`);
    if (failures.length) throw new AggregateError(failures, 'E2E cleanup failed.');
  });
  if (mode === 'sfu') {
    sfu = await configureRealSfu(t, path.join(repoRoot, 'apps', 'server', 'dist', 'infrastructure', 'sfu', 'SfuManager.js'));
  }
  server = await startRealServer(root, mode);
  const rendering = await startRendererServer(root);
  vite = rendering.vite;
  const port = (await server.getStats()).port;
  const launch = async role => {
    const profile = path.join(root, role);
    await fs.mkdir(profile);
    const actor = startActor({
      role, profile, node: process.execPath, ffmpeg, port, rendererUrl: rendering.url,
      allowLocalExecution: role === 'executor' || !!musicBotRoot,
    }, rows);
    actors.push(actor);
    const identity = await actor.ready;
    return { actor, identity };
  };
  const { actor: executor, identity: requester } = await launch('executor');
  const { actor: listener, identity: audience } = await launch('listener');
  assert.equal(requester.serverId, audience.serverId);
  assert.equal(requester.mode, mode);
  assert.equal(audience.mode, mode);
  assert.notEqual(requester.userId, audience.userId);
  assert.notEqual(requester.sessionId, audience.sessionId);
  const registration = await executor.call('createBot');
  const botKeys = generateKeyPairSync('ed25519');
  let Bot = BotClient;
  let requestedCapabilities = ['commands', 'send_messages', 'publish_voice', 'local_execution'];
  if (musicBotRoot) {
    assert.ok(path.isAbsolute(musicBotRoot), 'MONKY_LOCAL_E2E_MUSIC_BOT_ROOT must be an explicit absolute checkout path.');
    const fromBot = createRequire(path.join(musicBotRoot, 'package.json'));
    const sdk = fromBot('@monky/bot-sdk');
    assert.equal(sdk.PROTOCOL_VERSION, PROTOCOL_VERSION);
    requestedCapabilities = botCapabilitiesSchema.parse(fromBot('./dist/commands').requestedCapabilities);
    Bot = sdk.BotClient;
  }
  bot = new Bot({
    requestedCapabilities,
    serverUrl: `ws://127.0.0.1:${port}`, token: registration.token,
    publicKey: botKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    name: 'Authored local smoke', avatarBase64: null, autoReconnect: false,
    registrationFile: path.join(root, 'bot-registrations.json'),
  });
  bot.on('error', error => botErrors.push(error));
  if (musicBotRoot) {
    const { registerMusicCommands } = require(path.join(musicBotRoot, 'dist', 'commands', 'music.js'));
    disposeMusic = registerMusicCommands(bot);
  } else bot.command({
    name: 'local-smoke', description: 'Play a local test-authored tone.',
    voiceRequirement: 'joined', localCapabilities: ['youtube-audio'],
    handler: async ctx => {
      const job = { state: 'starting', played: 0, paused: false };
      jobs.push(job);
      try {
        assert.equal(ctx.invokerSessionId, requester.sessionId);
        assert.equal(ctx.invokerId, requester.userId);
        const channelId = await ctx.getVoiceChannel();
        assert.equal(channelId, requester.voiceChannelId);
        const voice = await bot.joinVoice(ctx.serverId, channelId);
        await until(async () => (await listener.call('sample')).connection === 'connected',
          'actual publisher/listener voice connection');
        const client = bot.localExecution(ctx.serverId);
        const local = await client.executor({ kind: 'invocation', invocationId: ctx.invocationId }).stream({
          operation: 'youtube.stream', url: 'https://www.youtube.com/watch?v=abcdefghijk',
        }, { voiceChannelId: channelId, signal: ctx.signal });
        job.local = local;
        job.taskId = local.taskId;
        job.state = 'playing';
        const completion = local.closed.then(
          () => ({ state: 'completed' }),
          error => ({ state: 'failed', error }),
        );
        job.pause = async paused => {
          if (paused) { job.paused = true; voice.stopSpeaking(); }
          await local.setPaused(paused);
          if (!paused) job.paused = false;
        };
        for await (const frame of local.frames) {
          while (job.paused) await delay(10, undefined, { signal: local.signal });
          assert.equal(voice.isClosed, false);
          const started = performance.now();
          await voice.writeOpus(frame);
          // Playback advances on the bot's 20 ms clock, not iterator reads or
          // writeOpus resolution. The separate renderer independently proves PCM.
          await delay(Math.max(1, 20 - (performance.now() - started)), undefined, { signal: local.signal });
          local.markFrameAdvanced();
          job.played++;
        }
        voice.stopSpeaking();
        const terminal = await completion;
        if (terminal.state === 'failed') throw terminal.error;
        await local.close();
        job.state = 'completed';
        await ctx.reply('Authored local media completed.');
      } catch (error) {
        job.error = error;
        const terminal = error.event ?? job.local?.signal.reason?.event;
        job.terminal = terminal;
        job.state = terminal?.state === 'cancelled' || (!terminal && ctx.signal.aborted) ? 'cancelled' : 'failed';
        if (job.local) await job.local.close();
      }
    },
  });
  const connected = once(bot, 'connected');
  const declaration = once(bot, 'permissionsChanged');
  bot.connect({ serverId: requester.serverId });
  await connected;
  const [unreviewed] = await declaration;
  assert.deepEqual(unreviewed.requested, requestedCapabilities);
  assert.deepEqual(unreviewed.granted, []);
  const disconnectedForReview = once(bot, 'disconnected');
  await executor.call('approveBot', registration.bot.id, unreviewed.revision, unreviewed.requested);
  await disconnectedForReview;
  const approvedRegistration = once(bot, 'permissionsChanged');
  bot.connect({ serverId: requester.serverId });
  const [approved] = await approvedRegistration;
  assert.equal(approved.reviewedBy, requester.userId);
  assert.deepEqual(approved.granted, unreviewed.requested);
  await until(() => rows.some(row => row.type === MessageType.COMMAND_REGISTERED && row.direction === 'out'),
    'real bot command registration');
  await executor.call('join');
  await listener.call('join');
  await executor.call('invoke', ...(musicBotRoot ? ['play', { busca: 'https://www.youtube.com/watch?v=abcdefghijk' }] : []));
  await until(() => rows.some(row => row.event === 'consent.denied'), 'actual Main consent denial');
  await delay(300);
  const denied = await executor.call('status');
  assert.equal(denied.spawnedWorkers, 0);
  assert.equal(jobs.length, 0);
  assert.equal(rows.some(row => row.event === 'private.created'), false);
  evidence.consentDenied = { workers: denied.spawnedWorkers, privateConnections: 0 };
  assert.equal((await executor.call('enablePermission')).status, 'completed');

  if (musicBotRoot) {
    await runRegisteredMusicScenario({ executor, listener, requester, audience, rows, evidence });
    await assertRunInvariants({ executor, listener, botErrors, violations, sfu, rows, evidence, wireStringTags });
    t.diagnostic(JSON.stringify({ protocol: PROTOCOL_VERSION, mode, registeredMonkyBot: true, evidence }));
    successful = true;
    return;
  }

  const startPlayback = async () => {
    const index = jobs.length;
    assert.equal(await executor.call('invoke'), 'submitted');
    return until(() => {
      const job = jobs[index];
      if (job?.state === 'failed' || job?.state === 'cancelled') throw job.error;
      return job?.state === 'playing' && job.played > 10 && job;
    }, 'concrete SDK stream');
  };
  const nativeCleanup = description => until(async () => {
    const state = await executor.call('status');
    return state.workers === 0 && state.caches === 0 && state.state.tasks.length === 0 &&
      state.state.cacheBytes === 0 && state.nativeAlive.length === 0 && state.privateClosed && state;
  }, description);
  let cancellationPassed = false, eofPassed = false;
  await t.test('exact requester voice departure cancels before natural EOF', { timeout: 45_000 }, async () => {
    const job = await startPlayback();
    await executor.call('leave');
    const event = await until(() => rows.find(row => row.event === 'wire' && row.direction === 'out' &&
      row.taskId === job.taskId && row.state === 'cancelled'),
    'real server exact-requester voice-leave cancellation');
    const cleaned = await nativeCleanup('cancelled worker, cache and private RTC teardown');
    await until(() => job.state === 'cancelled' || job.state === 'failed', 'SDK cancellation result');
    evidence.requesterLeave = {
      cause: event.cause, sdkState: job.state, sdkCause: job.terminal?.cause, playedFrames: job.played,
      workers: cleaned.workers, cacheBytes: cleaned.state.cacheBytes, privateClosed: cleaned.privateClosed,
    };
    assert.equal(event.cause, 'requester_left_voice');
    assert.equal(job.state, 'cancelled');
    assert.equal(job.terminal?.cause, 'requester_left_voice');
    assert.ok(job.played < 400, 'Cancellation must not masquerade as natural EOF.');
    cancellationPassed = true;
  });

  // A separate node:test result preserves an EOF failure without preventing
  // the independent cancellation scenario from exercising the real authority.
  await nativeCleanup('released first scenario before starting the natural-EOF case');
  await executor.call('join');
  await t.test('decoded authored PCM, mute/PTT, pause/resume and natural EOF drain', { timeout: 45_000 }, async () => {
    const startIndex = rows.length;
    const job = await startPlayback();
    const baseline = await listener.call('sample');
    const audible = await until(async () => {
      const sample = await listener.call('sample');
      return sample.packets > baseline.packets + 15 && sample.samples > baseline.samples && sample.rms > 0.005 &&
        sample.frequency > 800 && sample.frequency < 960 && sample;
    }, 'decoded authored 880 Hz PCM in another actual renderer');
    evidence.audio = audible;
    const muted = await executor.call('mute');
    assert.deepEqual(muted, { muted: true, inputMode: 'push_to_talk', tracksEnabled: false });
    await delay(400);
    const duringMute = await listener.call('sample');
    assert.ok(duringMute.rms > 0.005 && duringMute.packets > audible.packets + 8,
      'Requester microphone mute/PTT must not mute the local generated stream.');
    evidence.mutedRequesterAudio = duringMute;
    const beforePause = job.played;
    await job.pause(true);
    await delay(700);
    const paused = await listener.call('sample');
    assert.ok(job.played <= beforePause + 1);
    await delay(250);
    const stillPaused = await listener.call('sample');
    assert.ok(stillPaused.packets <= paused.packets + 1 && stillPaused.rms < 0.001);
    evidence.pausedRms = stillPaused.rms;
    await job.pause(false);
    await until(async () => {
      const sample = await listener.call('sample');
      return sample.rms > 0.005 && sample.packets > stillPaused.packets + 10;
    }, 'actual audible PCM after resume');
    await until(() => ['completed', 'failed', 'cancelled'].includes(job.state), 'final played/drain completion', 30_000);
    if (job.state !== 'completed') throw job.error;
    assert.ok(job.played >= 400 && job.played <= 405, 'The entire authored eight-second Opus source must drain.');
    await assertTaskTrace(rows, job.taskId, job.played, startIndex);
    const completed = await nativeCleanup('completed natural EOF native/cache/RTC cleanup');
    assert.equal(completed.spawnedWorkers, 2);
    evidence.playedFrames = job.played;
    eofPassed = true;
  });
  assert.equal((await listener.call('status')).spawnedWorkers, 0);
  await assertRunInvariants({ executor, listener, botErrors, violations, sfu, rows, evidence, wireStringTags });
  t.diagnostic(JSON.stringify({
    protocol: PROTOCOL_VERSION, mode, cancellationPassed, eofPassed, evidence,
  }));
  successful = cancellationPassed && eofPassed;
}

async function assertRunInvariants({ executor, listener, botErrors, violations, sfu, rows, evidence, wireStringTags }) {
  assert.deepEqual(await executor.call('failures'), []);
  assert.deepEqual(await listener.call('failures'), []);
  assert.deepEqual(botErrors, []);
  assert.equal(violations.length, 0, 'Observed wire invariants must not change or suppress real server traffic.');
  if (sfu) {
    sfu.assertReady();
    const ports = rows.filter(row => row.type === MessageType.SFU_WEBRTC_TRANSPORT_CREATED && row.direction === 'out')
      .flatMap(row => row.sfuPorts ?? []);
    assert.ok(ports.length > 0, 'The actual server must allocate native SFU transports.');
    assert.ok(ports.every(port => Number.isSafeInteger(port) && port >= sfu.ports.minPort && port <= sfu.ports.maxPort),
      'No actual SFU transport may escape the test-owned range.');
    evidence.sfu = { ...sfu.snapshot(), allocatedCandidatePorts: [...new Set(ports)] };
  }
  for (const row of rows) for (const tag of row.privateTags ?? []) {
    assert.equal(wireStringTags.has(tag), false,
      'An opaque Main permit, connection identity or native task UUID leaked under another WebSocket field.');
  }
  for (const peer of ['executor', 'listener']) {
    assert.ok(rows.some(row => row.type === MessageType.AUTH_CHALLENGE && row.peer === peer && row.direction === 'out'));
    assert.ok(rows.some(row => row.type === MessageType.AUTH_CHALLENGE_RESPONSE && row.peer === peer && row.direction === 'in'));
    assert.ok(rows.some(row => row.type === MessageType.AUTH_SUCCESS && row.peer === peer && row.direction === 'out'));
  }
}

async function runRegisteredMusicScenario({ executor, listener, requester, audience, rows, evidence }) {
  const url = id => `https://www.youtube.com/watch?v=${id}`;
  const firstUrl = url('abcdefghijk');
  const futureUrl = url('lmnopqrstuv');
  const otherUrl = url('12345678901');
  const sourceFor = sourceUrl => until(() => rows.find(row => row.direction === 'out' && row.peer === 'bot' &&
    row.type === MessageType.BOT_LOCAL_SOURCE_RESULT && row.status === 'retained' && row.url === sourceUrl),
  `retained music source ${sourceUrl.slice(-11)}`);
  const streamFor = source => until(() => rows.find(row => row.direction === 'out' && row.peer === 'bot' &&
    row.type === MessageType.BOT_LOCAL_TASK_OFFER && row.operation === 'youtube.stream' &&
    row.sourceContextId === source.sourceContextId), 'real registered queue stream');
  const terminal = (task, state) => rows.find(row => row.peer === 'bot' && row.direction === 'out' &&
    row.type === MessageType.BOT_LOCAL_TASK_EVENT && row.taskId === task.taskId && row.state === state);
  const audible = () => until(async () => {
    const sample = await listener.call('sample');
    return sample.connection === 'connected' && sample.rms > 0.005 &&
      sample.frequency > 800 && sample.frequency < 960 && sample;
  }, 'actual MonkyBot 880 Hz PCM in the other renderer');
  const chatMatches = (expression, actor = listener) => until(async () =>
    (await actor.call('chat')).some(text => expression.test(text)), `music chat notice ${expression}`);
  const pause = async (actor, task) => {
    const since = rows.length;
    assert.equal(await actor.call('invoke', 'pause'), 'submitted');
    await until(() => rows.slice(since).some(row => row.taskId === task.taskId && row.peer === 'bot' &&
      row.direction === 'out' && row.state === 'paused'), 'actual registered /pause confirmation');
    await delay(700);
    const first = await listener.call('sample');
    await delay(250);
    const second = await listener.call('sample');
    assert.ok(second.rms < 0.001 && second.packets <= first.packets + 1,
      'Paused queue must neither advance Opus nor emit audible PCM.');
    evidence.pausedRms = second.rms;
  };
  assert.equal(await executor.call('invoke', 'play', { busca: firstUrl }, true), 'submitted');
  await chatMatches(/track received|recebi a música/i, executor);
  assert.ok(rows.some(row => row.role === 'executor' && row.event === 'preview.playing'));
  const first = await sourceFor(firstUrl);
  assert.equal(first.invokerSessionId, requester.sessionId);
  const current = await streamFor(first);
  await chatMatches(/preparing to play.*abcdefghijk|preparando para tocar.*abcdefghijk/i);
  evidence.audio = await audible();
  await pause(executor, current);
  assert.equal(await executor.call('invoke', 'play', { busca: futureUrl }), 'submitted');
  const future = await sourceFor(futureUrl);
  assert.equal(future.invokerSessionId, requester.sessionId);
  await chatMatches(/added to queue.*lmnopqrstuv|adicionado à fila.*lmnopqrstuv/i, executor);

  assert.equal(await listener.call('invoke', 'play', { busca: otherUrl }), 'denied');
  assert.equal((await listener.call('status')).spawnedWorkers, 0, 'Another requester needs their own consent.');
  assert.equal((await listener.call('enablePermission')).status, 'completed');
  assert.equal(await listener.call('invoke', 'play', { busca: otherUrl }), 'submitted');
  const other = await sourceFor(otherUrl);
  assert.equal(other.invokerSessionId, audience.sessionId);
  await chatMatches(/added to queue.*12345678901|adicionado à fila.*12345678901/i);
  assert.equal(rows.some(row => row.type === MessageType.BOT_LOCAL_TASK_OFFER &&
    row.operation === 'youtube.stream' && row.sourceContextId === future.sourceContextId), false);

  await executor.call('leave');
  const cancelled = await until(() => terminal(current, 'cancelled'), 'requester departure stops the registered current track');
  assert.equal(cancelled.cause, 'requester_left_voice');
  await chatMatches(/left voice|saiu da.*voz/i);
  const next = await streamFor(other);
  await audible();
  await pause(listener, next);
  assert.equal(rows.some(row => row.type === MessageType.BOT_LOCAL_SOURCE_REQUEST &&
    row.action === 'release' && row.sourceContextId === future.sourceContextId), false);
  await listener.call('invoke', 'queue');
  await chatMatches(/lmnopqrstuv.*waiting for requester|lmnopqrstuv.*aguardando solicitante/i);
  const rejoinIndex = rows.length;
  await executor.call('join');
  await until(() => rows.slice(rejoinIndex).some(row => row.type === MessageType.BOT_LOCAL_SOURCE_RESULT &&
    row.status === 'available' && row.sourceContextId === future.sourceContextId),
  'original physical source becomes eligible after voice rejoin without another /play');
  const resumedIndex = rows.length;
  assert.equal(await listener.call('invoke', 'skip'), 'submitted');
  await chatMatches(/skip received|pedido para pular/i);
  const resumed = await streamFor(future);
  await chatMatches(/preparing to play.*lmnopqrstuv|preparando para tocar.*lmnopqrstuv/i);
  const resumedAudio = await audible();
  assert.ok(resumedAudio.packets > evidence.audio.packets);
  const muted = await executor.call('mute');
  assert.deepEqual(muted, { muted: true, inputMode: 'push_to_talk', tracksEnabled: false });
  await delay(400);
  evidence.mutedRequesterAudio = await listener.call('sample');
  assert.ok(evidence.mutedRequesterAudio.rms > 0.005);
  const completed = await until(() => {
    const failed = terminal(resumed, 'failed') ?? terminal(resumed, 'cancelled');
    if (failed) throw new Error(`Registered queue did not finish naturally: ${JSON.stringify(failed)}`);
    return terminal(resumed, 'completed');
  }, 'registered queue natural EOF and server-confirmed drain', 30_000);
  assert.ok(completed.playedFrames >= 400 && completed.playedFrames <= 405);
  await assertTaskTrace(rows, resumed.taskId, completed.playedFrames, resumedIndex);
  await chatMatches(/queue finished|fim da fila/i);
  const messages = await listener.call('chat');
  evidence.sourceMetadataTasks = 0;
  for (const source of [first, future, other]) {
    const metadataTasks = rows.filter(row => row.direction === 'out' && row.peer === 'bot' &&
      row.type === MessageType.BOT_LOCAL_TASK_OFFER && row.operation === 'youtube.resolve' &&
      row.sourceContextId === source.sourceContextId);
    assert.equal(metadataTasks.length, 1, 'Each accepted source must avoid a second metadata task before its self-resolving stream');
    evidence.sourceMetadataTasks += metadataTasks.length;
    const id = source.url.slice(-11);
    const preparing = new RegExp(`preparing to play.*${id}|preparando para tocar.*${id}`, 'i');
    const playing = new RegExp(`now playing.*${id}|tocando:.*${id}`, 'i');
    assert.equal(messages.filter(text => preparing.test(text)).length, 1);
    assert.ok(messages.findIndex(text => playing.test(text)) > messages.findIndex(text => preparing.test(text)),
      'The public preparation notice must precede the proven playback notice');
    await until(() => rows.some(row => row.type === MessageType.BOT_LOCAL_SOURCE_RESULT &&
      row.sourceContextId === source.sourceContextId && row.status === 'released'), 'queue source released');
    assert.equal(rows.filter(row => row.type === MessageType.BOT_LOCAL_SOURCE_REQUEST && row.direction === 'in' &&
      row.sourceContextId === source.sourceContextId && row.action === 'release').length, 1);
  }
  for (const actor of [executor, listener]) {
    await until(async () => {
      const state = await actor.call('status');
      return state.workers === 0 && state.caches === 0 && state.nativeAlive.length === 0 &&
        state.state.tasks.length === 0 && state.state.cacheBytes === 0 && state.privateClosed;
    }, 'registered music native workers, sources, cache and transports released');
  }
  evidence.playedFrames = completed.playedFrames;
  evidence.requesterLeave = { cause: cancelled.cause, skipped: first.url, next: other.url, resumedOriginal: future.url };
}
