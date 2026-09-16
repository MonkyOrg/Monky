const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { test } = require('node:test');
const { WebSocketServer } = require('ws');
const { RTCPeerConnection } = require('werift');
const {
  BotClient, LocalExecutionError, LocalExecutionRpcError, MessageType, ProtocolErrorCode,
} = require('../dist/index.js');
const {
  LOCAL_EXECUTION_PROTOCOL_LIMITS, LOCAL_MEDIA_CHANNEL_LABEL, LOCAL_MEDIA_CHANNEL_OPTIONS, LOCAL_MEDIA_PROTOCOL,
  advanceLocalMediaFlow, createLocalMediaFlowState, decodeLocalMediaRecord, encodeLocalMediaRecord,
  localBotIdentitySchema, localTaskOfferSchema,
} = require('@monky/shared');

const URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const OTHER_URL = 'https://www.youtube.com/watch?v=lmnopqrstuv';
const TRACK = { id: 'abcdefghijk', title: 'Local fixture', url: URL, duration: 120 };
const PUBLIC_KEY = localBotIdentitySchema.shape.botPublicKey.parse('a'.repeat(64));
const CALLER = {
  botId: 'bot-one', channelId: 'chat-one', invokerId: 'human-one', invokerSessionId: 'human-session',
  invokerNickname: 'Human', invokerVoiceChannelId: 'voice-one',
};
const AUTH = {
  currentUser: { id: 'bot-one', sessionId: 'bot-session' }, server: { voiceMode: 'sfu' }, iceServers: [],
};
const SILENCE = Uint8Array.from([0xf8, 0xff, 0xfe]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const observe = promise => { void promise.catch(() => undefined); return promise; };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function within(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local operation did not settle.')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await wait(10);
  assert.ok(predicate(), 'Local condition did not become true.');
}

async function remainsPending(promise) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await wait(20);
  assert.equal(settled, false);
}

async function fixture(t, options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const events = new EventEmitter();
  const frames = [], allFrames = [], errors = [], interactions = new Map();
  let socket, bot, sequence = 0;
  t.after(async () => {
    try { await bot?.close(); }
    finally {
      for (const ws of server.clients) ws.terminate();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(events.listenerCount('frame'), 0);
    }
  });
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', (bytes, binary) => {
      assert.equal(binary, false, 'Bot WebSocket must never carry local media records.');
      const message = JSON.parse(bytes.toString());
      frames.push(message);
      allFrames.push(message);
      events.emit('frame', message);
      if (message.type === MessageType.AUTH_CONNECT) {
        ws.send(JSON.stringify({ type: MessageType.AUTH_SUCCESS, payload: AUTH }));
      }
    });
  });
  function next(type, predicate = () => true) {
    const index = frames.findIndex(message => message.type === type && predicate(message));
    if (index !== -1) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.off('frame', receive); reject(new Error(`Missing ${type}`)); }, 5000);
      function receive(message) {
        if (message.type !== type || !predicate(message)) return;
        clearTimeout(timer);
        events.off('frame', receive);
        frames.splice(frames.indexOf(message), 1);
        resolve(message);
      }
      events.on('frame', receive);
    });
  }
  function send(type, payload, requestId) {
    socket.send(JSON.stringify({ type, payload, requestId }));
  }
  bot = new BotClient({
    publicKey: 'a'.repeat(64), serverUrl: `ws://127.0.0.1:${server.address().port}`,
    token: 'local-test-token', autoReconnect: false, ...options,
  });
  bot.on('error', error => errors.push(error));
  const callbacks = {};
  async function hold(kind, ctx) {
    const gate = deferred();
    const key = `${kind}:${ctx.invocationId ?? ctx.requestId}`;
    const cancelled = () => gate.resolve(kind === 'autocomplete' ? [] : undefined);
    ctx.signal.addEventListener('abort', cancelled, { once: true });
    interactions.set(key, { ctx, resolve: gate.resolve });
    try { return await gate.promise; }
    finally { ctx.signal.removeEventListener('abort', cancelled); }
  }
  bot.command({
    name: 'local', description: 'Local execution fixture', localCapabilities: ['youtube-audio'],
    options: [{ name: 'track', label: 'Track', description: 'Search locally', type: 'string', autocomplete: true }],
    handler: ctx => hold('invocation', ctx),
    autocomplete: ctx => callbacks.autocomplete ? callbacks.autocomplete(ctx) : hold('autocomplete', ctx),
    audioPreview: ctx => callbacks.preview ? callbacks.preview(ctx) : hold('audio-preview', ctx),
  });
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'fixture-server' });
  await connected;
  const client = bot.localExecution('fixture-server');
  async function interaction(kind = 'invocation', id = `interaction-${++sequence}`) {
    if (kind === 'invocation') {
      send(MessageType.COMMAND_INVOKE, { ...CALLER, invocationId: id, commandName: 'local', locale: 'en' });
    } else if (kind === 'autocomplete') {
      send(MessageType.COMMAND_AUTOCOMPLETE, {
        ...CALLER, commandName: 'local', optionName: 'track', query: 'fixture', options: {}, locale: 'en',
      }, id);
    } else {
      send(MessageType.COMMAND_AUDIO_PREVIEW, {
        ...CALLER, commandName: 'local', optionName: 'track', resourceId: URL, locale: 'en',
      }, id);
    }
    await until(() => interactions.has(`${kind}:${id}`));
    const entry = interactions.get(`${kind}:${id}`);
    return {
      ctx: entry.ctx,
      context: kind === 'invocation' ? { kind, invocationId: id } : { kind, requestId: id },
      finish: async value => {
        entry.resolve(value);
        await until(() => entry.ctx.signal.aborted);
      },
    };
  }
  function offer(request, overrides = {}) {
    return localTaskOfferSchema.parse({
      taskId: `server-task-${++sequence}`, requestId: `original-executor-ui-${sequence}`,
      context: request.payload.context,
      bot: {
        serverId: 'server-owned-identity', serverName: 'Local server', botId: CALLER.botId,
        botName: 'Local bot', botPublicKey: PUBLIC_KEY,
      },
      botSessionId: AUTH.currentUser.sessionId, invokerId: CALLER.invokerId,
      invokerSessionId: CALLER.invokerSessionId, capability: 'youtube-audio',
      spec: request.payload.spec, expiresAt: Date.now() + 60_000,
      voiceChannelId: request.payload.voiceChannelId,
      media: request.payload.spec.operation === 'youtube.stream'
        ? { protocol: LOCAL_MEDIA_PROTOCOL, generation: 7, iceServers: [] } : undefined,
      ...overrides,
    });
  }
  function reserve(request, overrides) {
    const reservation = offer(request, overrides);
    send(MessageType.BOT_LOCAL_TASK_OFFER, reservation, request.requestId);
    return reservation;
  }
  function accept(request, reservation, result) {
    send(MessageType.BOT_LOCAL_TASK_EVENT, {
      state: 'accepted', taskId: reservation.taskId, media: reservation.media,
      result: result ?? { operation: request.payload.spec.operation, track: TRACK },
    }, request.requestId);
  }
  function retained(sourceContextId = `source-${++sequence}`) {
    return {
      sourceContextId, botId: CALLER.botId, botPublicKey: PUBLIC_KEY,
      invokerId: CALLER.invokerId, invokerSessionId: CALLER.invokerSessionId,
      originChannelId: CALLER.channelId, capability: 'youtube-audio', provider: 'youtube-local',
      url: URL, expiresAt: Date.now() + 60_000,
    };
  }
  async function retain(interaction) {
    const pending = observe(client.retainSource(interaction.ctx.invocationId, URL));
    const request = await next(MessageType.BOT_LOCAL_SOURCE_REQUEST, message => message.payload.action === 'retain');
    send(MessageType.BOT_LOCAL_SOURCE_RESULT, { status: 'retained', source: retained() }, request.requestId);
    return pending;
  }
  return {
    bot, client, callbacks, next, send, allFrames, frames, errors, interaction, offer, reserve, accept, retained, retain,
    get socket() { return socket; },
  };
}

async function pairedStream(t, f, earlyReady = false) {
  const interaction = await f.interaction();
  const executor = f.client.executor(interaction.context);
  const pending = observe(executor.stream({ operation: 'youtube.stream', url: URL }, { voiceChannelId: 'voice-one' }));
  const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  const offer = f.reserve(request);
  if (earlyReady) {
    f.accept(request, offer);
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, {
      state: 'ready', taskId: offer.taskId, mediaGeneration: offer.media.generation,
    }, request.requestId);
    await remainsPending(pending);
  }
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', codecs: { audio: [], video: [] } });
  const channel = pc.createDataChannel(LOCAL_MEDIA_CHANNEL_LABEL, LOCAL_MEDIA_CHANNEL_OPTIONS);
  const records = [], peerErrors = [];
  let flow = createLocalMediaFlowState();
  const subscription = channel.onMessage.subscribe(bytes => {
    try {
      assert.ok(Buffer.isBuffer(bytes));
      const record = decodeLocalMediaRecord(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      flow = advanceLocalMediaFlow(flow, record, 'bot');
      records.push(record);
    } catch (error) { peerErrors.push(error); }
  });
  t.after(async () => {
    await f.bot.close();
    subscription.unSubscribe();
    await pc.close();
    assert.deepEqual(peerErrors, []);
  });
  for (const transport of pc.iceTransports) {
    transport.connection.stunServer = transport.connection.options.stunServer;
  }
  await pc.setLocalDescription(await pc.createOffer());
  f.send(MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
    taskId: offer.taskId, mediaGeneration: offer.media.generation,
    signal: { signalType: 'offer', sdp: { type: 'offer', sdp: pc.localDescription.sdp } },
  });
  const answer = await f.next(MessageType.BOT_LOCAL_MEDIA_SIGNAL, message => message.payload.signal.signalType === 'answer');
  assert.equal(f.allFrames.some(message => message.type === MessageType.BOT_LOCAL_TASK_ACCEPT), false);
  await pc.setRemoteDescription(answer.payload.signal.sdp);
  for (const message of f.allFrames) {
    if (message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL && message.payload.taskId === offer.taskId &&
        message.payload.signal.signalType === 'candidate') {
      await pc.addIceCandidate(message.payload.signal.candidate);
    }
  }
  await f.next(MessageType.BOT_LOCAL_TASK_EVENT, message => message.payload.state === 'ready');
  await until(() => pc.connectionState === 'connected' && channel.readyState === 'open');
  if (!earlyReady) {
    await remainsPending(pending);
    assert.deepEqual(records, [], 'PC/DC readiness must not release credit before Main acceptance and server ready.');
    f.accept(request, offer);
    await remainsPending(pending);
    assert.deepEqual(records, [], 'Acceptance alone must not release credit.');
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, {
      state: 'ready', taskId: offer.taskId, mediaGeneration: offer.media.generation,
    }, request.requestId);
  }
  const stream = await within(pending);
  await until(() => records.some(record => record.kind === 'credit'));
  return {
    stream, offer, request, pc, channel, records, interaction,
    get flow() { return flow; },
    send(record) {
      flow = advanceLocalMediaFlow(flow, record, 'executor');
      channel.send(Buffer.from(encodeLocalMediaRecord(record)));
    },
  };
}

function isTerminal(state, reason) {
  return error => error instanceof LocalExecutionError && error.event.state === state &&
    (state === 'failed' ? error.event.reason : error.event.cause) === reason;
}

test('BotClient exposes callable local RPCs with real invocation lifetimes and matching metadata', async t => {
  const f = await fixture(t);
  assert.equal(f.bot.localExecution('fixture-server'), f.client);
  assert.throws(() => f.client.executor({ kind: 'invocation', invocationId: 'not-live' }), /live interaction/);
  await assert.rejects(f.client.retainSource('not-live', URL), /live interaction/);
  assert.throws(() => f.client.executor({ kind: 'source', sourceContextId: 'source', invokerId: 'spoof' }));
  const interaction = await f.interaction();
  const executor = f.client.executor(interaction.context);
  const pending = observe(executor.execute({ operation: 'youtube.search', query: '  local fixture  ' }));
  const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  assert.deepEqual(request.payload, { context: interaction.context, spec: { operation: 'youtube.search', query: 'local fixture' } });
  const offer = f.reserve(request);
  assert.notEqual(request.requestId, offer.requestId);
  f.accept(request, offer, { operation: 'youtube.search', tracks: [TRACK] });
  assert.deepEqual(await pending, { operation: 'youtube.search', tracks: [TRACK] });
  f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId: offer.taskId }, request.requestId);
  await interaction.finish();
  await assert.rejects(executor.execute({ operation: 'youtube.resolve', url: URL }), /aborted/);
  assert.deepEqual(f.errors, []);
});

test('local source and pre-admission errors preserve ProtocolErrorCode without inventing task events', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  for (const [type, start] of [
    [MessageType.BOT_LOCAL_SOURCE_REQUEST, () => f.client.retainSource(interaction.ctx.invocationId, URL)],
    [MessageType.BOT_LOCAL_TASK_REQUEST, () => f.client.executor(interaction.context).execute({ operation: 'youtube.resolve', url: URL })],
  ]) {
    const pending = observe(start());
    const request = await f.next(type);
    f.send(MessageType.SERVER_ERROR, { code: ProtocolErrorCode.PERMISSION_DENIED, message: 'No consent.' }, request.requestId);
    await assert.rejects(pending, error => {
      assert.ok(error instanceof LocalExecutionRpcError);
      assert.equal(error.code, ProtocolErrorCode.PERMISSION_DENIED);
      assert.equal(error.message, 'No consent.');
      assert.equal('event' in error, false);
      return true;
    });
  }
  assert.deepEqual(f.errors, []);
});

test('retained sources outlive successful retention signals and invocations, with exact source URL binding', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  const controller = new AbortController();
  const pending = observe(f.client.retainSource(interaction.ctx.invocationId, URL, { signal: controller.signal }));
  const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST);
  assert.deepEqual(request.payload, { action: 'retain', invocationId: interaction.ctx.invocationId, url: URL });
  const source = f.retained();
  f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, { status: 'retained', source }, request.requestId);
  const retained = await pending;
  assert.deepEqual(retained, source);
  assert.equal(Object.isFrozen(retained), true);
  controller.abort();
  await interaction.finish();
  const executor = f.client.executor({ kind: 'source', sourceContextId: source.sourceContextId });
  await assert.rejects(executor.execute({ operation: 'youtube.resolve', url: OTHER_URL }), /retained source/);
  const resolving = observe(executor.execute({ operation: 'youtube.resolve', url: URL }));
  const task = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  const offer = f.reserve(task);
  f.accept(task, offer);
  assert.deepEqual(await resolving, { operation: 'youtube.resolve', track: TRACK });
  const release = observe(f.client.releaseSource(source.sourceContextId));
  const releaseRequest = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST);
  assert.deepEqual(releaseRequest.payload, { action: 'release', sourceContextId: source.sourceContextId });
  f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, { status: 'released', sourceContextId: source.sourceContextId }, releaseRequest.requestId);
  await release;
  assert.deepEqual(f.errors, []);
});

test('source metadata and release confirmations cannot spoof invocation, identity, URL or opaque IDs', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  for (const change of [
    { botId: 'other-bot' }, { botPublicKey: 'b'.repeat(64) }, { invokerId: 'other-human' },
    { invokerSessionId: 'other-device' }, { originChannelId: 'other-chat' }, { url: OTHER_URL },
    { expiresAt: 1 }, { audioUrl: 'https://private.invalid/media' },
  ]) {
    const pending = observe(f.client.retainSource(interaction.ctx.invocationId, URL));
    const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST);
    f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, { status: 'retained', source: { ...f.retained(), ...change } }, request.requestId);
    await assert.rejects(pending);
    assert.equal(f.client.sources.size, 0);
  }
  for (const status of ['mismatch', 'rejected', 'released', 'released']) {
    const pending = observe(f.client.releaseSource('unknown-ref'));
    const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST);
    assert.equal(request.payload.sourceContextId, 'unknown-ref');
    if (status === 'rejected') {
      f.send(MessageType.SERVER_ERROR, { code: ProtocolErrorCode.UNAUTHORIZED, message: 'Not your source.' }, request.requestId);
      await assert.rejects(pending, error => error instanceof LocalExecutionRpcError);
    } else {
      f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, {
        status: 'released', sourceContextId: status === 'mismatch' ? 'another-ref' : 'unknown-ref',
      }, request.requestId);
      if (status === 'mismatch') await assert.rejects(pending, /match/);
      else await pending;
    }
  }
  assert.deepEqual(f.errors, []);
});

test('source availability requires a matching server reply and never starts media or changes source ownership', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  const source = await f.retain(interaction);
  await interaction.finish();
  for (const change of [null, { sourceContextId: 'another-source' }, { voiceChannelId: 'other-room' }, { status: 'released' }]) {
    const pending = observe(f.client.checkSourceAvailability(source.sourceContextId, 'voice-one'));
    const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST, message => message.payload.action === 'check');
    assert.deepEqual(request.payload, { action: 'check', sourceContextId: source.sourceContextId, voiceChannelId: 'voice-one' });
    f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, {
      status: 'available', sourceContextId: source.sourceContextId, voiceChannelId: 'voice-one', ...change,
    }, request.requestId);
    if (change) await assert.rejects(pending);
    else assert.equal(await pending, undefined);
  }
  for (const cause of ['requester_left_voice', 'requester_disconnected', 'expired']) {
    const pending = observe(f.client.checkSourceAvailability(source.sourceContextId, 'voice-one'));
    const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST, message => message.payload.action === 'check');
    f.send(MessageType.SERVER_ERROR, { code: ProtocolErrorCode.BOT_INTERACTION_EXPIRED, message: cause }, request.requestId);
    await assert.rejects(pending, error =>
      error instanceof LocalExecutionRpcError && error.cancellationCause === cause && !('event' in error));
  }
  const controller = new AbortController();
  const cancelled = observe(f.client.checkSourceAvailability(source.sourceContextId, 'voice-one', { signal: controller.signal }));
  const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST, message => message.payload.action === 'check');
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, {
    status: 'available', sourceContextId: source.sourceContextId, voiceChannelId: 'voice-one',
  }, request.requestId);
  await until(() => f.client.sourceRequests.size === 0);
  assert.equal(f.client.sources.size, 1);
  assert.equal(f.allFrames.some(message => message.type === MessageType.BOT_LOCAL_TASK_REQUEST), false);
  assert.equal(f.allFrames.some(message => message.payload?.action === 'release'), false);
  await assert.rejects(f.client.checkSourceAvailability(source.sourceContextId, ''));
  assert.deepEqual(f.errors, []);
});

test('abandoned retain requests reject promptly and release a late valid result on the original socket', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  for (const endContext of [false, true]) {
    const controller = new AbortController();
    const pending = observe(f.client.retainSource(interaction.ctx.invocationId, URL, { signal: controller.signal }));
    const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST);
    if (endContext) await interaction.finish();
    else controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const source = f.retained();
    f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, { status: 'retained', source }, request.requestId);
    const release = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST);
    assert.deepEqual(release.payload, { action: 'release', sourceContextId: source.sourceContextId });
    f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, { status: 'released', sourceContextId: source.sourceContextId }, release.requestId);
    await until(() => f.client.sourceRequests.size === 0);
    assert.equal(f.client.sources.size, 0);
  }
  assert.deepEqual(f.errors, []);
});

test('interaction-derived tasks abort without an explicit signal, including autocomplete and preview', async t => {
  const f = await fixture(t);
  for (const kind of ['invocation', 'autocomplete', 'audio-preview']) {
    const interaction = await f.interaction(kind);
    const executor = f.client.executor(interaction.context);
    const pending = observe(executor.execute({ operation: 'youtube.resolve', url: URL }));
    const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
    const offer = f.reserve(request);
    await until(() => f.client.tasks.has(offer.taskId));
    if (kind === 'invocation') await interaction.finish();
    else {
      f.send(kind === 'autocomplete' ? MessageType.COMMAND_AUTOCOMPLETE_CANCEL : MessageType.COMMAND_AUDIO_PREVIEW_CANCEL,
        { requestId: interaction.ctx.requestId });
    }
    await assert.rejects(pending, isTerminal('cancelled', 'requested'));
    const cancel = await f.next(MessageType.BOT_LOCAL_TASK_CONTROL, message => message.payload.taskId === offer.taskId);
    assert.equal(cancel.payload.action, 'cancel');
    await assert.rejects(executor.execute({ operation: 'youtube.resolve', url: URL }), /aborted/);
  }
  assert.deepEqual(f.errors, []);
});

test('pending task requests and cancelled-before-offer correlations stay bounded and never create late peers', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  const executor = f.client.executor(interaction.context);
  const controller = new AbortController();
  const pending = [];
  for (let i = 0; i < LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerBot; i++) {
    pending.push(observe(executor.stream({ operation: 'youtube.stream', url: URL },
      { voiceChannelId: 'voice-one', signal: controller.signal })));
  }
  await assert.rejects(executor.execute({ operation: 'youtube.resolve', url: URL }), /Too many/);
  const requests = [];
  for (let i = 0; i < pending.length; i++) requests.push(await f.next(MessageType.BOT_LOCAL_TASK_REQUEST));
  controller.abort();
  await Promise.all(pending.map(promise => assert.rejects(promise, { name: 'AbortError' })));
  await assert.rejects(executor.execute({ operation: 'youtube.resolve', url: URL }), /Too many/);
  for (const request of requests) {
    const offer = f.reserve(request);
    const cancel = await f.next(MessageType.BOT_LOCAL_TASK_CONTROL, message => message.payload.taskId === offer.taskId);
    assert.equal(cancel.payload.action, 'cancel');
  }
  assert.equal(f.client.tasks.size, 0);
  assert.equal(f.client.requests.size, 0);
  assert.equal(f.allFrames.some(message => message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL), false);
  assert.deepEqual(f.errors, []);
});

test('unmatched, stale and tampered reservations cannot bind tasks or create a receiver', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  const executor = f.client.executor(interaction.context);
  for (const mutate of [
    offer => ({ ...offer, context: { kind: 'invocation', invocationId: 'spoof' } }),
    offer => ({ ...offer, spec: { operation: 'youtube.stream', url: OTHER_URL } }),
    offer => ({ ...offer, bot: { ...offer.bot, botId: 'another-bot' } }),
    offer => ({ ...offer, bot: { ...offer.bot, botPublicKey: 'b'.repeat(64) } }),
    offer => ({ ...offer, botSessionId: 'stale-bot-session' }),
    offer => ({ ...offer, invokerSessionId: 'replacement-device' }),
    offer => ({ ...offer, invokerId: 'other-human' }),
    offer => ({ ...offer, voiceChannelId: 'other-voice' }),
    offer => ({ ...offer, media: { ...offer.media, permit: 'must-never-leave-main' } }),
  ]) {
    const pending = observe(executor.stream({ operation: 'youtube.stream', url: URL }, { voiceChannelId: 'voice-one' }));
    const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
    const offer = f.offer(request);
    f.send(MessageType.BOT_LOCAL_TASK_OFFER, offer, 'unsolicited');
    await remainsPending(pending);
    assert.equal(f.client.tasks.size, 0);
    f.send(MessageType.BOT_LOCAL_TASK_OFFER, mutate(offer), request.requestId);
    await assert.rejects(pending, error => !(error instanceof LocalExecutionError));
    assert.equal(f.client.tasks.size, 0);
  }
  const early = observe(executor.execute({ operation: 'youtube.resolve', url: URL }));
  const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  f.send(MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'accepted', taskId: 'never-reserved', result: { operation: 'youtube.resolve', track: TRACK },
  }, request.requestId);
  await assert.rejects(early, /reservation/);
  assert.equal(f.allFrames.some(message => message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL), false);
  assert.deepEqual(f.errors, []);
});

test('preview returns the original executor reference and runAudioPreview forwards only status local', async t => {
  const f = await fixture(t);
  f.callbacks.preview = ctx => f.client.executor({ kind: 'audio-preview', requestId: ctx.requestId })
    .execute({ operation: 'youtube.preview', url: URL });
  f.send(MessageType.COMMAND_AUDIO_PREVIEW, {
    ...CALLER, commandName: 'local', optionName: 'track', resourceId: URL, locale: 'en',
  }, 'bot-preview-correlation');
  const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  const offer = f.reserve(request);
  const result = {
    operation: 'youtube.preview', taskId: offer.taskId, localPreviewId: 'main-private-preview-reference',
    requestId: offer.requestId, executorSessionId: offer.invokerSessionId,
  };
  f.accept(request, offer, result);
  const response = await f.next(MessageType.COMMAND_AUDIO_PREVIEW_RESULT);
  assert.equal(response.requestId, 'bot-preview-correlation');
  const { operation, ...reference } = result;
  assert.deepEqual(response.payload, { status: 'local', ...reference });
  assert.notEqual(response.payload.requestId, request.requestId);
  assert.equal('audioBase64' in response.payload, false);
  assert.equal(f.allFrames.some(message => message.type === MessageType.BOT_LOCAL_TASK_CONTROL), false);
  const interaction = await f.interaction();
  for (const changed of ['taskId', 'requestId', 'executorSessionId']) {
    const pending = observe(f.client.executor(interaction.context).execute({ operation: 'youtube.preview', url: URL }));
    const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
    const offer = f.reserve(request);
    f.accept(request, offer, {
      ...result, taskId: offer.taskId, requestId: offer.requestId, executorSessionId: offer.invokerSessionId,
      [changed]: 'spoofed',
    });
    await assert.rejects(pending, isTerminal('failed', 'invalid_request'));
  }
  assert.deepEqual(f.errors, []);
});

test('metadata accepts must match the reserved operation, canonical URL and metadata-only schema', async t => {
  const f = await fixture(t);
  const interaction = await f.interaction();
  for (const result of [
    { operation: 'youtube.search', tracks: [TRACK] },
    { operation: 'youtube.resolve', track: { ...TRACK, id: 'lmnopqrstuv', url: OTHER_URL } },
    { operation: 'youtube.resolve', track: { ...TRACK, audioBase64: 'AAAA' } },
  ]) {
    const pending = observe(f.client.executor(interaction.context).execute({ operation: 'youtube.resolve', url: URL }));
    const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
    const offer = f.reserve(request);
    f.accept(request, offer, result);
    await assert.rejects(pending, isTerminal('failed', 'invalid_request'));
  }
});

test('reconnect on the same ServerConnection cannot revive an old task/context, even with the same session ID', async t => {
  const f = await fixture(t, { autoReconnect: true });
  const interaction = await f.interaction();
  const source = await f.retain(interaction);
  const sourceExecutor = f.client.executor({ kind: 'source', sourceContextId: source.sourceContextId });
  const contextExecutor = f.client.executor(interaction.context);
  const pending = observe(sourceExecutor.execute({ operation: 'youtube.resolve', url: URL }));
  const request = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  const offer = f.reserve(request);
  await until(() => f.client.tasks.has(offer.taskId));
  const conn = f.bot.connections.get('fixture-server');
  const oldSocket = conn.ws;
  const disconnected = once(f.bot, 'disconnected');
  f.socket.close();
  await disconnected;
  await assert.rejects(pending, isTerminal('cancelled', 'bot_disconnected'));
  clearTimeout(conn.reconnectTimer);
  conn.reconnectTimer = null;
  const connected = once(f.bot, 'connected');
  f.bot.openSocket(conn);
  await connected;
  assert.equal(f.bot.connections.get('fixture-server'), conn);
  assert.notEqual(conn.ws, oldSocket);
  assert.equal(conn.voiceAuth.currentUser.sessionId, AUTH.currentUser.sessionId);
  oldSocket.emit('message', Buffer.from(JSON.stringify({
    type: MessageType.BOT_LOCAL_TASK_OFFER, requestId: request.requestId, payload: offer,
  })));
  f.send(MessageType.BOT_LOCAL_TASK_OFFER, offer, request.requestId);
  await assert.rejects(contextExecutor.execute({ operation: 'youtube.resolve', url: URL }), /disconnected/);
  const fresh = observe(sourceExecutor.execute({ operation: 'youtube.resolve', url: URL }));
  const freshRequest = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  assert.notEqual(freshRequest.requestId, request.requestId);
  const freshOffer = f.reserve(freshRequest);
  assert.notEqual(freshOffer.taskId, offer.taskId);
  f.accept(freshRequest, freshOffer);
  assert.deepEqual(await fresh, { operation: 'youtube.resolve', track: TRACK });
  const departed = observe(sourceExecutor.execute({ operation: 'youtube.resolve', url: URL }));
  const departedRequest = await f.next(MessageType.BOT_LOCAL_TASK_REQUEST);
  const departedOffer = f.reserve(departedRequest);
  f.send(MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'cancelled', taskId: departedOffer.taskId, cause: 'requester_disconnected',
  }, departedRequest.requestId);
  await assert.rejects(departed, isTerminal('cancelled', 'requester_disconnected'));
  assert.equal(f.client.tasks.size, 0);
  assert.deepEqual(f.errors, []);
});

test('real RTC stream negotiates before acceptance and completes only after PLAYED, drain ACK and server completion',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const peer = await pairedStream(t, f);
    const { stream, offer, request } = peer;
    assert.equal(stream.taskId, offer.taskId);
    assert.deepEqual(stream.track, TRACK);
    assert.deepEqual(peer.pc.getTransceivers(), []);
    assert.ok(peer.pc.iceTransports.every(transport => transport.connection.stunServer === undefined));
    peer.send({ kind: 'frame', sequence: 0, opus: SILENCE });
    peer.send({ kind: 'frame', sequence: 1, opus: SILENCE });
    peer.send({ kind: 'end', finalSequence: 2 });
    const iterator = stream.frames[Symbol.asyncIterator]();
    assert.deepEqual((await within(iterator.next())).value, SILENCE);
    const second = observe(iterator.next());
    await remainsPending(second);
    assert.equal(peer.records.some(record => record.kind === 'played'), false);
    stream.markFrameAdvanced();
    assert.deepEqual((await within(second)).value, SILENCE);
    const eof = observe(iterator.next());
    await remainsPending(eof);
    stream.markFrameAdvanced();
    await until(() => peer.flow.drained);
    assert.deepEqual(peer.records.slice(-2), [{ kind: 'played', playedFrames: 2 }, { kind: 'drainAck', finalSequence: 2 }]);
    const closing = observe(stream.close());
    peer.channel.close();
    await until(() => peer.channel.readyState === 'closed');
    await peer.pc.close();
    await remainsPending(eof);
    await remainsPending(closing);
    await remainsPending(stream.closed);
    assert.equal(stream.signal.aborted, false, 'Post-drain media closure must wait for the server completion.');
    assert.equal(f.allFrames.some(message => message.type === MessageType.BOT_LOCAL_TASK_CONTROL), false);
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, {
      state: 'completed', taskId: offer.taskId, mediaGeneration: offer.media.generation, playedFrames: 2,
    }, request.requestId);
    assert.deepEqual(await within(eof), { done: true, value: undefined });
    await within(stream.closed);
    await within(closing);
    assert.equal(stream.signal.aborted, false);
    const localWire = f.allFrames.filter(message => message.type.startsWith('BOT_LOCAL_'));
    assert.equal(localWire.some(message => /"audioBase64"|"bytes"|"opus"|"permit"|"mediaUrl"/.test(JSON.stringify(message.payload))), false);
    assert.equal(f.allFrames.some(message => ['RTC_SIGNAL', 'VOICE_JOIN', 'SFU_PRODUCE'].includes(message.type)), false);
    assert.deepEqual(f.errors, []);
  });

test('a post-drain peer close without server completion still expires rather than claiming success',
  { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const peer = await pairedStream(t, f);
    peer.send({ kind: 'frame', sequence: 0, opus: SILENCE });
    peer.send({ kind: 'end', finalSequence: 1 });
    const iterator = peer.stream.frames[Symbol.asyncIterator]();
    assert.deepEqual((await within(iterator.next())).value, SILENCE);
    peer.stream.markFrameAdvanced();
    await until(() => peer.flow.drained);
    peer.channel.close();
    await until(() => peer.channel.readyState === 'closed');
    await peer.pc.close();
    const eof = observe(iterator.next());
    await remainsPending(eof);
    await assert.rejects(within(peer.stream.closed, 10000), isTerminal('failed', 'timeout'));
    await assert.rejects(eof, isTerminal('failed', 'timeout'));
    assert.equal(peer.stream.signal.aborted, true);
  });

test('paused streams expose requester cancellation immediately through closed, signal, pending reads and controls',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const { stream, offer } = await pairedStream(t, f);
    const read = observe(stream.frames[Symbol.asyncIterator]().next());
    const pause = observe(stream.setPaused(true));
    const control = await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'paused', taskId: offer.taskId, revision: control.payload.revision });
    await pause;
    const resume = observe(stream.setPaused(false));
    await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    await remainsPending(read);
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'cancelled', taskId: offer.taskId, cause: 'requester_left_voice' });
    await assert.rejects(within(stream.closed), isTerminal('cancelled', 'requester_left_voice'));
    assert.equal(stream.signal.aborted, true);
    const failure = stream.signal.reason;
    await assert.rejects(read, error => error === failure);
    await assert.rejects(resume, error => error === failure);
    await stream.close();
    assert.deepEqual(f.errors, []);
  });

test('pause revisions coalesce, supersede, reject stale RPC errors and fail boundedly without matching confirmations',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const { stream, offer } = await pairedStream(t, f);
    const pause = observe(stream.setPaused(true));
    assert.equal(stream.setPaused(true), pause);
    const first = await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    const resume = observe(stream.setPaused(false));
    const second = await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    assert.equal(second.payload.revision, first.payload.revision + 1);
    await assert.rejects(pause, /superseded/);
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'paused', taskId: offer.taskId, revision: first.payload.revision });
    f.send(MessageType.SERVER_ERROR, { code: ProtocolErrorCode.BAD_REQUEST, message: 'Stale control.' }, first.requestId);
    await remainsPending(resume);
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'resumed', taskId: offer.taskId, revision: second.payload.revision });
    await resume;
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'resumed', taskId: offer.taskId, revision: second.payload.revision });
    await remainsPending(stream.closed);
    const rejected = observe(stream.setPaused(true));
    const rejectedRequest = await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    f.send(MessageType.SERVER_ERROR, { code: ProtocolErrorCode.PERMISSION_DENIED, message: 'Control rejected.' }, rejectedRequest.requestId);
    await assert.rejects(rejected, error => error instanceof LocalExecutionRpcError && error.code === ProtocolErrorCode.PERMISSION_DENIED);
    assert.equal(stream.signal.aborted, false);
    const originalTimeout = global.setTimeout;
    let boundedTimeout;
    t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
      if (delay === 8000) boundedTimeout = delay;
      return originalTimeout(callback, delay === 8000 ? 30 : delay, ...args);
    });
    const pending = observe(stream.setPaused(true));
    await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    await assert.rejects(within(pending), isTerminal('failed', 'timeout'));
    assert.equal(boundedTimeout, 8000);
    await assert.rejects(stream.closed, isTerminal('failed', 'timeout'));
    assert.deepEqual(f.errors, []);
  });

test('both authoritative events still cannot start a stream until the actual receiver is locally ready',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const { stream } = await pairedStream(t, f, true);
    await stream.close();
    await assert.rejects(stream.closed, isTerminal('cancelled', 'requested'));
  });

test('drained stream completions must still carry the exact generation and genuine played count',
  { timeout: 30000 }, async t => {
    for (const completion of [
      { mediaGeneration: 8, playedFrames: 0 },
      { mediaGeneration: 7, playedFrames: 1 },
      {},
    ]) {
      await t.test(JSON.stringify(completion), async t => {
        const f = await fixture(t);
        const peer = await pairedStream(t, f);
        peer.send({ kind: 'end', finalSequence: 0 });
        await until(() => peer.flow.drained);
        const eof = observe(peer.stream.frames[Symbol.asyncIterator]().next());
        f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId: peer.offer.taskId, ...completion });
        await assert.rejects(within(peer.stream.closed), isTerminal('failed', 'invalid_request'));
        await assert.rejects(eof, isTerminal('failed', 'invalid_request'));
      });
    }
  });

test('local task/source responses cannot cross sockets, and every post-await check pins the exact WebSocket', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const interaction = await f.interaction();
  const conn = f.bot.connections.get('fixture-server');
  const original = conn.ws;
  const replacement = other.bot.connections.get('fixture-server').ws;
  for (const sourceRpc of [true, false]) {
    const pending = observe(sourceRpc
      ? f.client.retainSource(interaction.ctx.invocationId, URL)
      : f.client.executor(interaction.context).execute({ operation: 'youtube.resolve', url: URL }));
    const request = await f.next(sourceRpc ? MessageType.BOT_LOCAL_SOURCE_REQUEST : MessageType.BOT_LOCAL_TASK_REQUEST);
    let response;
    if (sourceRpc) {
      response = {
        type: MessageType.BOT_LOCAL_SOURCE_RESULT, requestId: request.requestId,
        payload: { status: 'retained', source: f.retained() },
      };
    } else {
      const offer = f.reserve(request);
      await until(() => f.client.tasks.has(offer.taskId));
      response = {
        type: MessageType.BOT_LOCAL_TASK_EVENT, requestId: request.requestId,
        payload: { state: 'accepted', taskId: offer.taskId, result: { operation: 'youtube.resolve', track: TRACK } },
      };
    }
    f.client.handle(replacement, response);
    await remainsPending(pending);
    f.client.handle(original, response);
    conn.ws = replacement;
    try { await assert.rejects(pending, /disconnected/); }
    finally { conn.ws = original; }
  }
  assert.deepEqual(f.errors, []);
  assert.deepEqual(other.errors, []);
});

test('disconnect during lazy RTC loading cannot send a task or adopt a new socket after its await', async t => {
  const f = await fixture(t);
  const pending = observe(f.client.executor({ kind: 'source', sourceContextId: 'server-owned-ref' })
    .stream({ operation: 'youtube.stream', url: URL }, { voiceChannelId: 'voice-one' }));
  f.bot.disconnect('fixture-server');
  await assert.rejects(pending, /disconnected/);
  assert.equal(f.allFrames.some(message => message.type === MessageType.BOT_LOCAL_TASK_REQUEST), false);
  assert.equal(f.client.requests.size, 0);
  assert.equal(f.client.tasks.size, 0);
});

test('local source RPC limits and timeouts release their bounded pending slots', async t => {
  const f = await fixture(t);
  const pending = [];
  for (let i = 0; i < 100; i++) pending.push(observe(f.client.releaseSource(`source-${i}`)));
  await assert.rejects(f.client.releaseSource('overflow'), /Too many pending/);
  for (let i = 0; i < pending.length; i++) {
    const request = await f.next(MessageType.BOT_LOCAL_SOURCE_REQUEST);
    f.send(MessageType.BOT_LOCAL_SOURCE_RESULT, { status: 'released', sourceContextId: request.payload.sourceContextId }, request.requestId);
  }
  await Promise.all(pending);
  assert.equal(f.client.sourceRequests.size, 0);
  const originalTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) =>
    originalTimeout(callback, delay === 8000 ? 20 : delay, ...args));
  await assert.rejects(f.client.releaseSource('timeout-source'), /timed out/);
  assert.equal(f.client.sourceRequests.size, 0);
});

test('server completion cannot truncate undrained RTC playback or fabricate played counts',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const peer = await pairedStream(t, f);
    peer.send({ kind: 'frame', sequence: 0, opus: SILENCE });
    peer.send({ kind: 'end', finalSequence: 1 });
    const iterator = peer.stream.frames[Symbol.asyncIterator]();
    await within(iterator.next());
    const read = observe(iterator.next());
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, {
      state: 'completed', taskId: peer.offer.taskId, mediaGeneration: peer.offer.media.generation, playedFrames: 1,
    });
    await assert.rejects(within(peer.stream.closed), isTerminal('failed', 'invalid_request'));
    await assert.rejects(read, isTerminal('failed', 'invalid_request'));
    assert.equal(peer.records.some(record => record.kind === 'drainAck'), false);
  });

test('stream source failures keep optional recovery details and do not become cancellations while paused',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const { stream, offer } = await pairedStream(t, f);
    const pause = observe(stream.setPaused(true));
    const control = await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'paused', taskId: offer.taskId, revision: control.payload.revision });
    await pause;
    const event = {
      state: 'failed', taskId: offer.taskId, reason: 'provider_unavailable',
      sourceFailure: { code: 'recovery_failed', attempts: 5 },
    };
    f.send(MessageType.BOT_LOCAL_TASK_EVENT, event);
    await until(() => stream.signal.aborted);
    // Deliberately attach closed only after terminal notification: its internal rejection must already be observed.
    await wait(20);
    await assert.rejects(stream.closed, error => {
      assert.deepEqual(error.event, event);
      return error instanceof LocalExecutionError;
    });
    await stream.close();
    assert.deepEqual(f.errors, []);
  });

test('BotClient.close immediately aborts active readers/controls and awaits real receiver teardown',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const { stream, offer } = await pairedStream(t, f);
    const task = f.client.tasks.get(offer.taskId);
    const receiver = task.receiver;
    const read = observe(stream.frames[Symbol.asyncIterator]().next());
    const control = observe(stream.setPaused(true));
    await f.next(MessageType.BOT_LOCAL_TASK_CONTROL);
    const closing = f.bot.close();
    await assert.rejects(within(stream.closed), isTerminal('cancelled', 'bot_disconnected'));
    await assert.rejects(read, isTerminal('cancelled', 'bot_disconnected'));
    await assert.rejects(control, isTerminal('cancelled', 'bot_disconnected'));
    await closing;
    assert.equal(receiver.pc.connectionState, 'closed');
    assert.equal(f.client.tasks.size, 0);
    assert.equal(f.client.requests.size, 0);
    assert.equal(f.client.sourceRequests.size, 0);
    assert.equal(f.client.controlRequests.size, 0);
    assert.equal(f.client.cleanups.size, 0);
    assert.throws(() => f.client.executor({ kind: 'source', sourceContextId: 'future' }), /closed/);
  });

test('asynchronous receiver disposal failures are reported and rejected, not converted into successful cleanup',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const { stream, offer } = await pairedStream(t, f);
    const receiver = f.client.tasks.get(offer.taskId).receiver;
    const originalAbort = receiver.abort.bind(receiver);
    const failure = new Error('Fixture receiver cleanup failed.');
    t.mock.method(receiver, 'abort', async reason => {
      await originalAbort(reason);
      throw failure;
    });
    await assert.rejects(f.client.dispose(), error => error === failure);
    await assert.rejects(stream.closed, isTerminal('cancelled', 'bot_disconnected'));
    assert.deepEqual(f.errors, [failure]);
    assert.equal(receiver.pc.connectionState, 'closed');
  });
