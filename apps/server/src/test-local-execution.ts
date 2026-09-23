import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  LIMITS,
  LOCAL_EXECUTION_PROTOCOL_LIMITS as limits,
  LOCAL_EXECUTION_RUNTIME_LIMITS,
  MessageType,
  ProtocolErrorCode,
  localSourceResultSchema,
  localTaskEventSchema,
  localTaskOfferSchema,
  type LocalRequestContext,
  type LocalTaskOffer,
  type LocalTaskSpec,
  type ProtocolMessage,
} from '@monky/shared';
import {
  BotLocalExecutionService,
  type BotLocalContext,
  type BotLocalExecutionTransport,
  type BotLocalSession,
} from './application/services/BotLocalExecutionService';

const URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const TRACK = { id: 'abcdefghijk', title: 'Authored fixture', url: URL, duration: 1 };
const SDP = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n';

interface Session extends BotLocalSession {
  user: { id: string };
  sessionId: string;
  isBot: boolean;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function settles<T>(pending: Promise<T>): Promise<T> {
  const outcome = await Promise.race([
    pending.then((value) => ({ settled: true as const, value })),
    new Promise<{ settled: false }>((resolve) => setImmediate(() => resolve({ settled: false }))),
  ]);
  assert.ok(outcome.settled, 'The public handler must settle without waiting for its abandoned dependency');
  return outcome.value;
}

function fixture(t: TestContext) {
  const current = new Set<Session>();
  const bindings = new Map<string, string>();
  const voices = new Map<Session, string>();
  const contexts = new Map<string, BotLocalContext<Session>>();
  const sent: { session: Session; message: ProtocolMessage<unknown> }[] = [];
  const errors: { session: Session; code: ProtocolErrorCode; reason: string; requestId?: string }[] = [];
  const unexpected: unknown[] = [];
  const state = { allowed: true, declared: true, version: '0', unstable: false };
  const session = (isBot = false): Session => {
    const id = randomUUID();
    const result: Session = {
      ws: {}, user: { id }, sessionId: `${isBot ? 'bot' : 'user'}:${id}`, isBot,
      ...(isBot ? { botId: id, botPublicKey: 'ab'.repeat(32) } : {}),
    };
    if (isBot) bindings.set(id, 'ab'.repeat(32));
    current.add(result);
    return result;
  };
  const origin = session();
  const bot = session(true);
  const key = (context: LocalRequestContext) => context.kind === 'invocation'
    ? context.invocationId : context.kind === 'source' ? context.sourceContextId : context.requestId;
  const context = (kind: 'invocation' | 'autocomplete' | 'audio-preview' = 'invocation', caller = origin, owner = bot) => {
    const id = randomUUID();
    const input: Exclude<LocalRequestContext, { kind: 'source' }> = kind === 'invocation'
      ? { kind, invocationId: id } : { kind, requestId: id };
    const scope: BotLocalContext<Session> = {
      origin: caller, bot: owner, requestId: `ui-${id}`, invokerId: caller.user.id,
      originChannelId: 'text', commandName: 'local', capability: 'youtube-audio',
      expiresAt: Date.now() + 300_000, isCurrent: () => contexts.get(id) === scope,
    };
    contexts.set(id, scope);
    return { input, scope, id };
  };
  const transport: BotLocalExecutionTransport<Session> = {
    isCurrent: (value) => current.has(value),
    accessVersion: () => state.unstable ? null : state.version,
    authorizeContext: async (owner, input) => {
      const scope = contexts.get(key(input));
      return scope?.bot === owner && scope.isCurrent() ? scope : undefined;
    },
    authorizeCaller: async () => state.allowed,
    authorizeVoice: async () => state.allowed,
    botBinding: async (id) => bindings.get(id),
    botIdentity: async (owner) => {
      const id = owner.botId;
      const binding = id && bindings.get(id);
      return id && binding
        ? { serverId: 'server', serverName: 'Fixture', botId: id, botName: 'Fixture bot', botPublicKey: binding } : undefined;
    },
    commandHasCapability: () => state.declared,
    voiceChannelId: (value) => voices.get(value) ?? null,
    iceServers: async (recipient) => [{ urls: ['stun:fixture.invalid'], username: recipient.sessionId }],
    send: (recipient, message) => { sent.push({ session: recipient, message }); return current.has(recipient); },
    error: (recipient, code, reason, requestId) => { errors.push({ session: recipient, code, reason, requestId }); },
    reportError: (error) => { unexpected.push(error); },
  };
  const service = new BotLocalExecutionService(transport);
  t.after(() => service.close());
  const request = async (input: LocalRequestContext = context().input, spec: LocalTaskSpec = { operation: 'youtube.resolve', url: URL }, owner = bot) => {
    const requestId = randomUUID();
    await service.handle(owner, MessageType.BOT_LOCAL_TASK_REQUEST, {
      context: input, spec, ...(spec.operation === 'youtube.stream' ? { voiceChannelId: 'voice' } : {}),
    }, requestId);
    const message = sent.find((entry) => entry.session === owner && entry.message.type === MessageType.BOT_LOCAL_TASK_OFFER &&
      entry.message.requestId === requestId)?.message;
    assert.ok(message, `Expected offer, got ${JSON.stringify(errors.slice(-1))}`);
    return localTaskOfferSchema.parse(message.payload);
  };
  const retain = async (owner = bot, caller = origin) => {
    const invocation = context('invocation', caller, owner);
    const requestId = randomUUID();
    await service.handle(owner, MessageType.BOT_LOCAL_SOURCE_REQUEST, {
      action: 'retain', invocationId: invocation.id, url: URL,
    }, requestId);
    contexts.delete(invocation.id);
    const message = sent.find((entry) => entry.message.requestId === requestId)?.message;
    assert.ok(message, `Expected retained source, got ${JSON.stringify(errors.slice(-1))}`);
    const result = localSourceResultSchema.parse(message.payload);
    assert.equal(result.status, 'retained');
    if (result.status !== 'retained') throw new Error('Expected retained source');
    return result.source;
  };
  const events = (offer: LocalTaskOffer, recipient = bot) => sent.filter((entry) =>
    entry.session === recipient && entry.message.type === MessageType.BOT_LOCAL_TASK_EVENT)
    .map((entry) => localTaskEventSchema.parse(entry.message.payload)).filter((event) => event.taskId === offer.taskId);
  const negotiate = async (offer: LocalTaskOffer, caller = origin, owner = bot) => {
    assert.ok(offer.media);
    await service.handle(caller, MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
      taskId: offer.taskId, mediaGeneration: offer.media.generation,
      signal: { signalType: 'offer', sdp: { type: 'offer', sdp: SDP } },
    });
    await service.handle(owner, MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
      taskId: offer.taskId, mediaGeneration: offer.media.generation,
      signal: { signalType: 'answer', sdp: { type: 'answer', sdp: SDP } },
    });
  };
  const accept = async (offer: LocalTaskOffer, caller = origin) => service.handle(caller, MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: offer.taskId, result: offer.spec.operation === 'youtube.search'
      ? { operation: offer.spec.operation, tracks: [TRACK] }
      : offer.spec.operation === 'youtube.preview'
        ? { operation: offer.spec.operation, localPreviewId: randomUUID(), taskId: offer.taskId,
          requestId: offer.requestId, executorSessionId: offer.invokerSessionId }
        : { operation: offer.spec.operation, track: TRACK },
  });
  const ready = (offer: LocalTaskOffer, endpoint: Session) => service.handle(endpoint, MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'ready', taskId: offer.taskId, mediaGeneration: offer.media?.generation,
  });
  return {
    service, transport, current, bindings, voices, contexts, state, sent, errors, unexpected, session, origin, bot,
    context, request, retain, events, negotiate, accept, ready,
  };
}

test('local execution forwards optional canonical source failures only from the exact executor without inventing details', async (t) => {
  const f = fixture(t);
  for (const sourceFailure of [
    undefined,
    { code: 'recovery_failed', attempts: LOCAL_EXECUTION_RUNTIME_LIMITS.sourceRecoveryAttempts },
  ]) {
    const offer = await f.request();
    const event = localTaskEventSchema.parse({
      state: 'failed', taskId: offer.taskId, reason: 'provider_unavailable',
      ...(sourceFailure === undefined ? {} : { sourceFailure }),
    });
    await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, event);
    assert.deepEqual(f.events(offer), [event]);
    assert.deepEqual(f.events(offer, f.origin), [event]);
    assert.equal(f.service.counts.tasks, 0);
  }
  const offer = await f.request();
  const failure = {
    state: 'failed', taskId: offer.taskId, reason: 'transport_failed',
    sourceFailure: { code: 'recovery_failed', attempts: 5 },
  };
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_EVENT, failure);
  assert.equal(f.errors.at(-1)?.code, ProtocolErrorCode.BAD_REQUEST);
  await f.service.handle(f.session(), MessageType.BOT_LOCAL_TASK_EVENT, failure);
  assert.equal(f.errors.at(-1)?.code, ProtocolErrorCode.PERMISSION_DENIED);
  for (const sourceFailure of [
    { code: 'recovery_failed' },
    { code: 'recovery_failed', attempts: LOCAL_EXECUTION_RUNTIME_LIMITS.sourceRecoveryAttempts + 1 },
    { code: 'recovery_failed', attempts: 5, stderr: 'Native diagnostic output' },
    { code: 'recovery_failed', attempts: 5, url: 'https://example.invalid/media' },
  ]) {
    await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, { ...failure, sourceFailure });
    assert.equal(f.errors.at(-1)?.code, ProtocolErrorCode.BAD_REQUEST);
  }
  assert.deepEqual(f.events(offer), []);
  assert.equal(f.service.counts.tasks, 1);
  assert.deepEqual(f.unexpected, []);
});

test('source availability is a read-only check of the original socket, voice room and current access', async (t) => {
  const f = fixture(t);
  const source = await f.retain();
  f.voices.set(f.bot, 'voice');
  f.voices.set(f.origin, 'voice');
  const ice = t.mock.method(f.transport, 'iceServers');
  const contexts = t.mock.method(f.transport, 'authorizeContext');
  const since = f.sent.length;
  const check = async (owner = f.bot) => {
    const requestId = randomUUID();
    await f.service.handle(owner, MessageType.BOT_LOCAL_SOURCE_REQUEST, {
      action: 'check', sourceContextId: source.sourceContextId, voiceChannelId: 'voice',
    }, requestId);
    return f.sent.find((entry) => entry.message.requestId === requestId)?.message.payload;
  };
  const available = { status: 'available', sourceContextId: source.sourceContextId, voiceChannelId: 'voice' };
  assert.deepEqual(await check(), available);
  f.voices.delete(f.origin);
  f.service.voiceChanged();
  assert.equal(await check(), undefined);
  assert.equal(f.errors.at(-1)?.reason, 'requester_left_voice');
  f.voices.set(f.origin, 'voice');
  f.service.voiceChanged();
  assert.deepEqual(await check(), available, 'A same-socket voice rejoin needs no fresh invocation or native work');
  f.state.allowed = false;
  assert.equal(await check(), undefined);
  assert.equal(f.errors.at(-1)?.reason, 'permission_denied');
  f.state.allowed = true;
  const otherBot = f.session(true);
  f.voices.set(otherBot, 'voice');
  assert.equal(await check(otherBot), undefined);
  assert.equal(f.errors.at(-1)?.reason, 'permission_denied');
  f.origin.ws = {};
  assert.equal(await check(), undefined);
  assert.equal(f.errors.at(-1)?.reason, 'requester_disconnected', 'A reused user/session ID cannot rebind a source');
  assert.equal(f.service.counts.sources, 1);
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(ice.mock.callCount(), 0);
  assert.equal(contexts.mock.callCount(), 0);
  assert.ok(f.sent.slice(since).every((entry) =>
    entry.session === f.bot && entry.message.type === MessageType.BOT_LOCAL_SOURCE_RESULT));
  assert.deepEqual(f.unexpected, []);
});

test('source availability rechecks socket and access after awaiting authority and cannot accept a released source', async (t) => {
  for (const change of ['socket', 'voice', 'access', 'release'] as const) {
    const f = fixture(t);
    const source = await f.retain();
    f.voices.set(f.bot, 'voice');
    f.voices.set(f.origin, 'voice');
    const entered = deferred<void>();
    const gate = deferred<boolean>();
    f.transport.authorizeVoice = () => { entered.resolve(); return gate.promise; };
    const requestId = `check-${change}`;
    const pending = f.service.handle(f.bot, MessageType.BOT_LOCAL_SOURCE_REQUEST, {
      action: 'check', sourceContextId: source.sourceContextId, voiceChannelId: 'voice',
    }, requestId);
    await entered.promise;
    if (change === 'socket') f.origin.ws = {};
    else if (change === 'voice') f.voices.delete(f.origin);
    else if (change === 'access') f.state.version = '1';
    else await f.service.handle(f.bot, MessageType.BOT_LOCAL_SOURCE_REQUEST, {
      action: 'release', sourceContextId: source.sourceContextId,
    }, 'release-check');
    gate.resolve(true);
    await pending;
    assert.equal(f.sent.some((entry) => entry.message.requestId === requestId), false);
    assert.equal(f.errors.find((entry) => entry.requestId === requestId)?.reason,
      { socket: 'requester_disconnected', voice: 'requester_left_voice', access: 'busy', release: 'source_released' }[change]);
    assert.equal(f.service.counts.tasks, 0);
    assert.deepEqual(f.unexpected, []);
  }
});

test('source availability bounds even first authentication and cannot publish a late success after shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  for (const cause of ['timeout', 'server_shutdown'] as const) {
    const f = fixture(t);
    const source = await f.retain();
    f.voices.set(f.bot, 'voice');
    f.voices.set(f.origin, 'voice');
    const entered = deferred<void>();
    const gate = deferred<void>();
    const identity = f.transport.botIdentity;
    f.transport.botIdentity = async (owner) => { entered.resolve(); await gate.promise; return identity(owner); };
    const pending = f.service.handle(f.bot, MessageType.BOT_LOCAL_SOURCE_REQUEST, {
      action: 'check', sourceContextId: source.sourceContextId, voiceChannelId: 'voice',
    }, `check-${cause}`);
    await entered.promise;
    if (cause === 'server_shutdown') f.service.close();
    else t.mock.timers.tick(limits.taskStartTimeoutMs);
    await settles(pending);
    assert.equal(f.errors.at(-1)?.reason, cause);
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.sent.some((entry) => entry.message.requestId === `check-${cause}`), false);
    assert.equal(f.service.counts.tasks, 0);
    assert.deepEqual(f.unexpected, []);
  }
});

test('local execution reserves both endpoints before SDP, requires valid acceptance and dual ready, and drains only its generation', async (t) => {
  const f = fixture(t);
  f.voices.set(f.origin, 'voice');
  f.voices.set(f.bot, 'voice');
  const invocation = f.context();
  const offer = await f.request(invocation.input, { operation: 'youtube.stream', url: URL });
  assert.ok(offer.media);
  const originOffer = f.sent.find((entry) => entry.session === f.origin && entry.message.type === MessageType.BOT_LOCAL_TASK_OFFER);
  assert.ok(originOffer);
  assert.equal(originOffer.message.requestId, undefined);
  assert.equal(offer.requestId, invocation.scope.requestId);
  assert.equal(offer.expiresAt, invocation.scope.expiresAt, 'setup deadline must not become the stream lifetime');
  assert.notEqual(offer.media.iceServers[0].username,
    localTaskOfferSchema.parse(originOffer.message.payload).media?.iceServers[0].username);
  await f.negotiate(offer);
  assert.deepEqual(f.sent.slice(0, 4).map((entry) => entry.message.type), [
    MessageType.BOT_LOCAL_TASK_OFFER, MessageType.BOT_LOCAL_TASK_OFFER,
    MessageType.BOT_LOCAL_MEDIA_SIGNAL, MessageType.BOT_LOCAL_MEDIA_SIGNAL,
  ]);
  await f.ready(offer, f.bot);
  await f.ready(offer, f.origin);
  assert.deepEqual(f.events(offer), []);
  await f.accept(offer);
  assert.deepEqual(f.events(offer).map((event) => event.state), ['accepted', 'ready']);
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'completed', taskId: offer.taskId, mediaGeneration: offer.media.generation, playedFrames: 1,
  });
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'completed', taskId: offer.taskId, mediaGeneration: offer.media.generation + 1, playedFrames: 1,
  });
  assert.equal(f.errors.length, 2);
  assert.equal(f.service.counts.tasks, 1);
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'completed', taskId: offer.taskId, mediaGeneration: offer.media.generation, playedFrames: 1,
  });
  assert.deepEqual(f.events(offer).map((event) => event.state), ['accepted', 'ready', 'completed']);
  assert.equal(f.service.counts.tasks, 0);
  await f.ready(offer, f.bot);
  assert.equal(f.errors.at(-1)?.reason, 'expired');

  const afterAccept = await f.request(invocation.input, { operation: 'youtube.stream', url: URL });
  assert.notEqual(afterAccept.media?.generation, offer.media.generation);
  await f.negotiate(afterAccept);
  await f.accept(afterAccept);
  await f.ready(afterAccept, f.origin);
  assert.deepEqual(f.events(afterAccept).map((event) => event.state), ['accepted']);
  await f.ready(afterAccept, f.bot);
  assert.deepEqual(f.events(afterAccept).map((event) => event.state), ['accepted', 'ready']);
});

test('local execution uses monotone confirmed controls, ignores superseded acknowledgements and cancellation wins', async (t) => {
  const f = fixture(t);
  f.voices.set(f.origin, 'voice');
  f.voices.set(f.bot, 'voice');
  const offer = await f.request(f.context().input, { operation: 'youtube.stream', url: URL });
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: offer.taskId, revision: 0, action: 'pause' });
  assert.equal(f.errors.at(-1)?.reason, 'executor_unavailable');
  await f.negotiate(offer);
  await f.accept(offer);
  await f.ready(offer, f.bot);
  await f.ready(offer, f.origin);
  const control = (revision: number, action: 'pause' | 'resume' | 'cancel') =>
    f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: offer.taskId, revision, action });
  const ack = (revision: number, state: 'paused' | 'resumed') =>
    f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, { taskId: offer.taskId, revision, state });
  await control(1, 'pause');
  await control(2, 'resume');
  await ack(1, 'paused');
  assert.equal(f.events(offer).some((event) => event.state === 'paused'), false);
  await ack(2, 'resumed');
  await ack(2, 'resumed');
  assert.equal(f.events(offer).filter((event) => event.state === 'resumed').length, 1);
  const before = f.sent.length;
  await control(2, 'resume');
  assert.equal(f.sent.length, before, 'a duplicate control is not replayed to Main');
  await control(3, 'pause');
  await ack(3, 'paused');
  await control(2, 'resume');
  assert.equal(f.errors.at(-1)?.reason, 'invalid_request');
  await control(0, 'cancel');
  await ack(3, 'paused');
  assert.deepEqual(f.events(offer).at(-1), { taskId: offer.taskId, state: 'cancelled', cause: 'requested' });
  assert.equal(f.service.counts.tasks, 0);
});

test('local execution role and payload allowlists reject WS audio, SDP audio, spoofed endpoints and server-owned departure causes', async (t) => {
  const f = fixture(t);
  f.voices.set(f.origin, 'voice');
  f.voices.set(f.bot, 'voice');
  const offer = await f.request(f.context().input, { operation: 'youtube.stream', url: URL });
  const signal = {
    taskId: offer.taskId, mediaGeneration: offer.media?.generation,
    signal: { signalType: 'offer', sdp: { type: 'offer', sdp: SDP } },
  };
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_MEDIA_SIGNAL, signal);
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_MEDIA_SIGNAL, { ...signal, targetSessionId: f.bot.sessionId });
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
    ...signal, signal: { signalType: 'offer', sdp: { type: 'offer', sdp: `${SDP}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` } },
  });
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_MEDIA_SIGNAL, { ...signal, audioBase64: 'AAAA' });
  await f.accept(offer, f.session());
  await f.accept(offer, f.bot);
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, { state: 'accepted', taskId: offer.taskId,
    result: { operation: 'youtube.stream', track: TRACK }, media: offer.media });
  for (const cause of ['bot_disconnected', 'requester_left_voice', 'voice_mode_changed', 'server_shutdown']) {
    await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, { state: 'cancelled', taskId: offer.taskId, cause });
  }
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_EVENT, { state: 'cancelled', taskId: offer.taskId, cause: 'requested' });
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_EVENT, { state: 'failed', taskId: offer.taskId, reason: 'worker_failed' });
  assert.equal(f.errors.length, 13);
  assert.equal(f.service.counts.tasks, 1);
  assert.deepEqual(f.events(offer), []);
  assert.equal(f.sent.filter((entry) => entry.message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL).length, 0);
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'cancelled', taskId: offer.taskId, cause: 'permission_revoked',
  });
  assert.equal(f.events(offer).at(-1)?.state, 'cancelled');
});

test('local execution queues at most 128 early signals and permits at most 256 candidates without SDP renegotiation', async (t) => {
  const f = fixture(t);
  f.voices.set(f.origin, 'voice');
  f.voices.set(f.bot, 'voice');
  const candidate = async (offer: LocalTaskOffer) => f.service.handle(f.origin, MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
    taskId: offer.taskId, mediaGeneration: offer.media?.generation,
    signal: { signalType: 'candidate', candidate: null },
  });
  const first = await f.request(f.context().input, { operation: 'youtube.stream', url: URL });
  for (let i = 0; i < limits.queuedSignals; i++) await candidate(first);
  assert.equal(f.sent.filter((entry) => entry.message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL).length, 0);
  await candidate(first);
  assert.deepEqual(f.events(first).at(-1), { state: 'failed', taskId: first.taskId, reason: 'transport_failed' });
  const second = await f.request(f.context().input, { operation: 'youtube.stream', url: URL });
  await candidate(second);
  await f.negotiate(second);
  assert.equal(f.sent.filter((entry) => entry.message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL).length, 3);
  for (let i = 1; i < limits.iceCandidates; i++) await candidate(second);
  assert.equal(f.service.counts.tasks, 1);
  await candidate(second);
  assert.equal(f.service.counts.tasks, 0);
});

test('local execution source refs survive command/voice/bot lifetimes but never rebind a replacement human socket', async (t) => {
  const f = fixture(t);
  const source = await f.retain();
  f.voices.set(f.bot, 'voice');
  f.voices.set(f.origin, 'voice');
  const input: LocalRequestContext = { kind: 'source', sourceContextId: source.sourceContextId };
  const first = await f.request(input, { operation: 'youtube.stream', url: URL });
  f.voices.delete(f.origin);
  f.service.voiceChanged();
  assert.deepEqual(f.events(first).at(-1), { state: 'cancelled', taskId: first.taskId, cause: 'requester_left_voice' });
  assert.equal(f.service.counts.sources, 1);
  f.voices.set(f.origin, 'voice');
  const second = await f.request(input, { operation: 'youtube.stream', url: URL });
  f.current.delete(f.bot);
  f.service.disconnect(f.bot);
  assert.deepEqual(f.events(second).at(-1), { state: 'cancelled', taskId: second.taskId, cause: 'bot_disconnected' });
  const reconnectedBot = { ...f.bot, ws: {} };
  f.current.add(reconnectedBot);
  const metadata = await f.request(input, { operation: 'youtube.resolve', url: URL }, reconnectedBot);
  await f.accept(metadata);
  assert.equal(f.service.counts.sources, 1);
  f.current.delete(f.origin);
  f.service.disconnect(f.origin);
  const otherDevice = { ...f.origin, ws: {} };
  f.current.add(otherDevice);
  await f.service.handle(reconnectedBot, MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: input, spec: { operation: 'youtube.resolve', url: URL },
  }, 'replacement-device');
  assert.equal(f.errors.at(-1)?.reason, 'requester_disconnected');
  assert.equal(f.service.counts.sources, 1);
  assert.equal(f.sent.some((entry) => entry.session === otherDevice), false);
});

test('local execution source release ownership, quotas, TTL and tombstones remain globally bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const source = await f.retain();
  const foreign = f.session(true);
  const release = (id: string, owner = f.bot) => f.service.handle(owner, MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: id }, randomUUID());
  await release(source.sourceContextId, foreign);
  await release('unknown-source');
  assert.equal(f.errors.length, 2);
  await release(source.sourceContextId);
  await release(source.sourceContextId);
  assert.equal(f.service.counts.sources, 0);
  assert.equal(f.service.counts.released, 1);
  const values = [];
  for (let i = 0; i < limits.sourceContextsPerBot; i++) values.push(await f.retain());
  const over = f.context();
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_SOURCE_REQUEST, {
    action: 'retain', invocationId: over.id, url: URL,
  }, 'over-source-limit');
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  for (const retained of values) await release(retained.sourceContextId);
  assert.equal(f.service.counts.released, limits.sourceContextsPerBot);
  await release(source.sourceContextId);
  assert.equal(f.errors.at(-1)?.reason, 'permission_denied', 'oldest tombstone was evicted, never a blanket release success');
  for (let bot = 0; bot < LIMITS.MAX_BOTS_DEFAULT; bot++) {
    const owner = f.session(true);
    for (let i = 0; i < limits.sourceContextsPerBot; i++) await f.retain(owner);
  }
  assert.equal(f.service.counts.sources, LIMITS.MAX_BOTS_DEFAULT * limits.sourceContextsPerBot);
  const last = f.context('invocation', f.origin, foreign);
  await f.service.handle(foreign, MessageType.BOT_LOCAL_SOURCE_REQUEST, {
    action: 'retain', invocationId: last.id, url: URL,
  }, 'global-source-limit');
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  t.mock.timers.tick(limits.sourceContextTtlMs + 1000);
  assert.deepEqual(f.service.counts, { tasks: 0, sources: 0, released: 0, previews: 0, retired: 0 });
});

test('local execution task quotas, setup/media/control deadlines and shutdown clear all task resources', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const same = f.context();
  for (let i = 0; i < limits.tasksPerExecutor; i++) await f.request(same.input);
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: same.input, spec: { operation: 'youtube.resolve', url: URL },
  }, 'executor-limit');
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  for (let caller = 1; caller < limits.tasksPerBot / limits.tasksPerExecutor; caller++) {
    const scope = f.context('invocation', f.session());
    for (let i = 0; i < limits.tasksPerExecutor; i++) await f.request(scope.input);
  }
  const overflow = f.context('invocation', f.session());
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: overflow.input, spec: { operation: 'youtube.resolve', url: URL },
  }, 'bot-limit');
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  t.mock.timers.tick(limits.taskStartTimeoutMs);
  assert.equal(f.service.counts.tasks, 0);
  f.voices.set(f.bot, 'voice');
  f.voices.set(f.origin, 'voice');
  const media = await f.request(f.context().input, { operation: 'youtube.stream', url: URL });
  await f.negotiate(media);
  t.mock.timers.tick(limits.mediaConnectTimeoutMs);
  assert.deepEqual(f.events(media).at(-1), { state: 'failed', taskId: media.taskId, reason: 'transport_failed' });
  const control = await f.request(f.context().input, { operation: 'youtube.stream', url: URL });
  await f.negotiate(control);
  await f.accept(control);
  await f.ready(control, f.bot);
  await f.ready(control, f.origin);
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: control.taskId, revision: 1, action: 'pause' });
  t.mock.timers.tick(limits.mediaConnectTimeoutMs);
  assert.equal(f.events(control).at(-1)?.state, 'failed');
  const source = await f.retain();
  const pending = await f.request({ kind: 'source', sourceContextId: source.sourceContextId });
  f.service.close();
  assert.deepEqual(f.events(pending).at(-1), { state: 'cancelled', taskId: pending.taskId, cause: 'server_shutdown' });
  assert.deepEqual(f.service.counts, { tasks: 0, sources: 0, released: 0, previews: 0, retired: 0 });
  const before = f.sent.length;
  t.mock.timers.tick(limits.sourceContextTtlMs * 2);
  assert.equal(f.sent.length, before);
});

test('local execution rechecks sessions, binding, access and context after asynchronous authorization and ICE failures', async (t) => {
  const f = fixture(t);
  const invocation = f.context();
  let resume!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const original = f.transport.authorizeCaller;
  f.transport.authorizeCaller = async () => { entered(); await gate; return true; };
  const request = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: invocation.input, spec: { operation: 'youtube.resolve', url: URL },
  }, 'held-request');
  await barrier;
  f.current.delete(f.origin);
  f.current.add({ ...f.origin, ws: {} });
  resume();
  await request;
  assert.equal(f.errors.at(-1)?.reason, 'requester_disconnected');
  assert.equal(f.service.counts.tasks, 0);
  f.current.add(f.origin);
  f.transport.authorizeCaller = original;
  const pending = await f.request();
  f.bindings.set(f.bot.user.id, 'cd'.repeat(32));
  await f.accept(pending);
  assert.equal(f.events(pending).at(-1)?.state, 'cancelled');
  assert.equal(f.service.counts.tasks, 0);
  f.bindings.set(f.bot.user.id, f.bot.botPublicKey ?? '');
  f.voices.set(f.origin, 'voice');
  f.voices.set(f.bot, 'voice');
  f.transport.iceServers = async () => { throw new Error('Controlled ICE failure'); };
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: f.context().input, spec: { operation: 'youtube.stream', url: URL }, voiceChannelId: 'voice',
  }, 'no-ice-fallback');
  assert.equal(f.errors.at(-1)?.reason, 'transport_failed');
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(f.unexpected.length, 1);
  assert.equal(f.sent.some((entry) => entry.message.type === MessageType.BOT_LOCAL_TASK_OFFER &&
    entry.message.requestId === 'no-ice-fallback'), false);
  const context = f.context();
  const metadata = await f.request(context.input);
  f.contexts.delete(context.id);
  f.service.contextEnded(context.input, 'expired');
  assert.deepEqual(f.events(metadata).at(-1), { state: 'cancelled', taskId: metadata.taskId, cause: 'expired' });
});

test('local execution preview proofs are opaque, one-shot, scoped and bounded after atomic metadata acceptance', async (t) => {
  const f = fixture(t);
  const preview = f.context('audio-preview');
  const offer = await f.request(preview.input, { operation: 'youtube.preview', url: URL });
  await f.accept(offer);
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(f.service.counts.previews, 1);
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId: offer.taskId });
  assert.deepEqual(f.errors, [], 'a queued renderer completion after atomic acceptance is harmless');
  const accepted = f.events(offer).find((event) => event.state === 'accepted');
  assert.ok(accepted?.state === 'accepted' && accepted.result.operation === 'youtube.preview');
  const result = accepted.result;
  assert.equal('audioBase64' in result, false);
  assert.equal('url' in result, false);
  assert.equal(await f.service.consumePreview(f.bot, f.session(), preview.id, preview.scope.requestId, result), false);
  assert.equal(await f.service.consumePreview(f.bot, f.origin, 'other-preview', preview.scope.requestId, result), false);
  assert.equal(await f.service.consumePreview(f.bot, f.origin, preview.id, 'other-ui-request', result), false);
  assert.equal(await f.service.consumePreview(f.bot, f.origin, preview.id, preview.scope.requestId,
    { ...result, localPreviewId: 'other-handle' }), false);
  assert.equal(await f.service.consumePreview(f.bot, f.origin, preview.id, preview.scope.requestId, result), true);
  assert.equal(await f.service.consumePreview(f.bot, f.origin, preview.id, preview.scope.requestId, result), false);
  for (let i = 0; i < LIMITS.MAX_BOT_AUDIO_PREVIEW_REQUESTS; i++) {
    const context = f.context('audio-preview');
    const offered = await f.request(context.input, { operation: 'youtube.preview', url: URL });
    await f.accept(offered);
  }
  const overflow = await f.request(f.context('audio-preview').input, { operation: 'youtube.preview', url: URL });
  await f.accept(overflow);
  assert.equal(f.service.counts.previews, LIMITS.MAX_BOT_AUDIO_PREVIEW_REQUESTS);
  assert.equal(f.service.counts.tasks, 0);
  assert.ok(f.service.counts.retired <= limits.tasksPerBot, 'late-report receipts have an independent bounded lifetime');
  assert.deepEqual(f.events(overflow).at(-1), { state: 'failed', taskId: overflow.taskId, reason: 'busy' });
  f.service.disconnect(f.origin);
  assert.equal(f.service.counts.previews, 0);
  assert.equal(f.service.counts.retired, 0);
});

test('local execution accepted streams outlive setup deadlines but not source or server lifetimes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const source = await f.retain();
  f.voices.set(f.origin, 'voice');
  f.voices.set(f.bot, 'voice');
  const offer = await f.request({ kind: 'source', sourceContextId: source.sourceContextId },
    { operation: 'youtube.stream', url: URL });
  assert.equal(offer.expiresAt, source.expiresAt);
  await f.negotiate(offer);
  await f.accept(offer);
  await f.ready(offer, f.origin);
  await f.ready(offer, f.bot);
  t.mock.timers.tick(limits.taskStartTimeoutMs + 1000);
  assert.equal(f.service.counts.tasks, 1);
  await f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: offer.taskId, revision: 0, action: 'pause' });
  await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, { taskId: offer.taskId, state: 'paused', revision: 0 });
  t.mock.timers.tick(limits.sourceContextTtlMs);
  assert.deepEqual(f.events(offer).at(-1), { state: 'cancelled', taskId: offer.taskId, cause: 'expired' });
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(f.service.counts.sources, 0);
});

test('local execution rejects operation, URL and preview identity substitution without accepting or retaining false proofs', async (t) => {
  const f = fixture(t);
  const wrongTrack = { ...TRACK, id: 'zyxwvutsrqp', url: 'https://www.youtube.com/watch?v=zyxwvutsrqp' };
  for (const result of [
    { operation: 'youtube.resolve', track: wrongTrack },
    { operation: 'youtube.search', tracks: [TRACK] },
  ]) {
    const offer = await f.request();
    await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_ACCEPT, { taskId: offer.taskId, result });
    assert.deepEqual(f.events(offer), [{ state: 'failed', taskId: offer.taskId, reason: 'invalid_request' }]);
  }
  for (const field of ['requestId', 'executorSessionId']) {
    const preview = f.context('audio-preview');
    const offer = await f.request(preview.input, { operation: 'youtube.preview', url: URL });
    await f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_ACCEPT, {
      taskId: offer.taskId,
      result: { operation: 'youtube.preview', taskId: offer.taskId, requestId: offer.requestId,
        executorSessionId: offer.invokerSessionId, localPreviewId: 'opaque-preview', [field]: 'forged' },
    });
    assert.equal(f.events(offer).some((event) => event.state === 'accepted'), false);
  }
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(f.service.counts.previews, 0);
});

test('local execution bounds the global task registry across otherwise valid independent bots and executors', async (t) => {
  const f = fixture(t);
  for (let total = 0; total < LIMITS.MAX_BOT_INVOCATIONS;) {
    const bot = f.session(true);
    for (let owned = 0; owned < limits.tasksPerBot && total < LIMITS.MAX_BOT_INVOCATIONS; owned++, total++) {
      const context = f.context('invocation', f.session(), bot);
      await f.request(context.input, { operation: 'youtube.resolve', url: URL }, bot);
    }
  }
  assert.equal(f.service.counts.tasks, LIMITS.MAX_BOT_INVOCATIONS);
  const bot = f.session(true);
  const context = f.context('invocation', f.session(), bot);
  await f.service.handle(bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: context.input, spec: { operation: 'youtube.resolve', url: URL },
  }, 'global-task-limit');
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  f.service.close();
  assert.deepEqual(f.service.counts, { tasks: 0, sources: 0, released: 0, previews: 0, retired: 0 });
});

test('local execution cancellation and deadlines settle reserved work even while ICE authorization is still pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  for (const cause of ['server_shutdown', 'timeout', 'requester_disconnected', 'expired'] as const) {
    const f = fixture(t);
    f.voices.set(f.origin, 'voice');
    f.voices.set(f.bot, 'voice');
    let enter!: () => void;
    let rejectIce!: (error: Error) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<{ urls: string[] }[]>((_resolve, reject) => { rejectIce = reject; });
    f.transport.iceServers = async () => { enter(); return gate; };
    const context = f.context();
    const pending = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
      context: context.input, spec: { operation: 'youtube.stream', url: URL }, voiceChannelId: 'voice',
    }, cause);
    await entered;
    assert.equal(f.service.counts.tasks, 1);
    if (cause === 'server_shutdown') f.service.close();
    else if (cause === 'timeout') t.mock.timers.tick(limits.taskStartTimeoutMs);
    else if (cause === 'requester_disconnected') {
      f.current.delete(f.origin);
      f.service.disconnect(f.origin);
    } else {
      f.contexts.delete(context.id);
      f.service.contextEnded(context.input, 'expired');
    }
    await pending;
    assert.equal(f.errors.at(-1)?.reason, cause);
    assert.equal(f.service.counts.tasks, 0);
    rejectIce(new Error('Controlled late ICE failure after cancellation'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.sent.some((entry) => entry.message.type === MessageType.BOT_LOCAL_TASK_OFFER), false);
    assert.deepEqual(f.unexpected, []);
    f.service.close();
  }
});

for (const dependency of ['botIdentity', 'botBinding', 'authorizeContext', 'authorizeCaller'] as const) {
  test(`local execution bounds stuck ${dependency} before task or source admission and ignores late settlement`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    for (const kind of ['retain', 'invocation', 'autocomplete', 'audio-preview'] as const) {
      for (const cause of ['timeout', 'server_shutdown', 'bot_disconnected', 'requested', 'expired', 'requester_disconnected'] as const) {
        for (const late of ['success', 'failure'] as const) {
          const f = fixture(t);
          const context = f.context(kind === 'retain' ? 'invocation' : kind);
          const gate = deferred<void>();
          const entered = deferred<void>();
          const identity = f.transport.botIdentity;
          const binding = f.transport.botBinding;
          const authorizeContext = f.transport.authorizeContext;
          const authorizeCaller = f.transport.authorizeCaller;
          const calls = { identity: 0, binding: 0, context: 0, caller: 0 };
          f.transport.botIdentity = async (session) => {
            calls.identity++;
            if (dependency === 'botIdentity') { entered.resolve(); await gate.promise; }
            return identity(session);
          };
          f.transport.botBinding = async (botId) => {
            calls.binding++;
            if (dependency === 'botBinding') { entered.resolve(); await gate.promise; }
            return binding(botId);
          };
          f.transport.authorizeContext = async (session, input, capability) => {
            calls.context++;
            if (dependency === 'authorizeContext') { entered.resolve(); await gate.promise; }
            return authorizeContext(session, input, capability);
          };
          f.transport.authorizeCaller = async (userId, channelId) => {
            calls.caller++;
            if (dependency === 'authorizeCaller') { entered.resolve(); await gate.promise; }
            return authorizeCaller(userId, channelId);
          };
          const requestId = `${dependency}-${kind}-${cause}-${late}`;
          const request = kind === 'retain'
            ? f.service.handle(f.bot, MessageType.BOT_LOCAL_SOURCE_REQUEST,
              { action: 'retain', invocationId: context.id, url: URL }, requestId)
            : f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
              context: context.input, spec: kind === 'audio-preview' ? { operation: 'youtube.preview', url: URL }
                : kind === 'autocomplete' ? { operation: 'youtube.search', query: 'fixture' }
                  : { operation: 'youtube.resolve', url: URL },
            }, requestId);
          await settles(entered.promise);
          assert.equal(f.service.counts.tasks, 0);
          assert.equal(f.service.counts.sources, 0);
          if (cause === 'timeout') t.mock.timers.tick(limits.taskStartTimeoutMs + 1);
          else if (cause === 'server_shutdown') f.service.close();
          else if (cause === 'bot_disconnected') f.service.disconnect(f.bot);
          else if (cause === 'requester_disconnected') {
            f.current.delete(f.origin);
            f.service.disconnect(f.origin);
            // The transport ends owned invocation/selector contexts synchronously on human disconnect.
            f.service.contextEnded(context.input, cause);
          } else f.service.contextEnded(context.input, cause);
          await settles(request);
          assert.deepEqual(f.errors, [{
            session: f.bot, requestId, reason: cause,
            code: cause === 'bot_disconnected' ? ProtocolErrorCode.BOT_OFFLINE : ProtocolErrorCode.BOT_INTERACTION_EXPIRED,
          }]);
          assert.deepEqual(f.sent, [], 'Pre-offer errors are correlated RPC failures, never fabricated task events');
          const before = { ...calls };
          if (late === 'success') gate.resolve();
          else gate.reject(new Error('Controlled abandoned authorization failure'));
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.deepEqual(calls, before, 'A late dependency must not start the next authorization');
          assert.deepEqual(f.sent, []);
          assert.equal(f.errors.length, 1);
          assert.equal(f.service.counts.tasks, 0);
          assert.equal(f.service.counts.sources, 0);
          assert.deepEqual(f.unexpected, []);
          f.service.close();
        }
      }
    }
  });
}

test('local execution pending work stays charged to the bot across socket, key and context churn until dependencies settle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  for (const dependency of ['botIdentity', 'botBinding', 'authorizeContext', 'authorizeCaller'] as const) {
    const f = fixture(t);
    const originalIdentity = f.transport.botIdentity;
    const originalBinding = f.transport.botBinding;
    const originalContext = f.transport.authorizeContext;
    const originalCaller = f.transport.authorizeCaller;
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let calls = 0;
    const pause = async () => {
      calls++;
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
    };
    if (dependency === 'botIdentity') f.transport.botIdentity = async (session) => { await pause(); return originalIdentity(session); };
    if (dependency === 'botBinding') f.transport.botBinding = async (botId) => { await pause(); return originalBinding(botId); };
    if (dependency === 'authorizeContext') f.transport.authorizeContext = async (...args) => { await pause(); return originalContext(...args); };
    if (dependency === 'authorizeCaller') f.transport.authorizeCaller = async (...args) => { await pause(); return originalCaller(...args); };
    let owner = f.bot;
    for (let index = 0; index < limits.tasksPerBot; index++) {
      const context = f.context(index % 2 ? 'autocomplete' : 'invocation', f.session(), owner);
      const requestId = `churn-${index}`;
      const pending = index % 2
        ? f.service.handle(owner, MessageType.BOT_LOCAL_TASK_REQUEST,
          { context: context.input, spec: { operation: 'youtube.search', query: 'fixture' } }, requestId)
        : f.service.handle(owner, MessageType.BOT_LOCAL_SOURCE_REQUEST,
          { action: 'retain', invocationId: context.id, url: URL }, requestId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, index + 1);
      f.current.delete(owner);
      f.service.disconnect(owner);
      f.service.contextEnded(context.input, 'bot_disconnected');
      await settles(pending);
      owner = { ...owner, ws: {}, sessionId: `replacement-${index}`, botPublicKey: index % 2 ? 'ab'.repeat(32) : 'cd'.repeat(32) };
      f.bindings.set(owner.user.id, owner.botPublicKey ?? '');
      f.current.add(owner);
      f.service.invalidateBot(owner.user.id);
    }
    assert.equal(f.service.counts.tasks, 0);
    assert.equal(f.service.counts.sources, 0);
    const overflow = f.context('invocation', f.session(), owner);
    const request = (requestId: string) => f.service.handle(owner, MessageType.BOT_LOCAL_TASK_REQUEST,
      { context: overflow.input, spec: { operation: 'youtube.resolve', url: URL } }, requestId);
    await settles(request('over-pending-limit'));
    assert.equal(f.errors.at(-1)?.reason, 'busy');
    assert.equal(f.errors.at(-1)?.requestId, 'over-pending-limit');
    assert.equal(calls, limits.tasksPerBot, 'Socket replacement must not start a seventeenth dependency');
    t.mock.timers.tick(limits.taskStartTimeoutMs * 2);
    await settles(request('still-pending-after-timeout'));
    assert.equal(f.errors.at(-1)?.reason, 'busy', 'An aborted Promise has not necessarily stopped doing work');
    assert.equal(calls, limits.tasksPerBot);
    gates[0].reject(new Error('Release one abandoned work slot'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const admitted = request('slot-reused-only-after-settlement');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, limits.tasksPerBot + 1);
    f.service.close();
    await settles(admitted);
    for (const gate of gates.slice(1)) gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.unexpected, []);
  }
});

test('local execution reserves executor slots before authorization and notices expiry and physical replacements without a settled dependency', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  for (const cause of ['expired', 'requester_disconnected', 'bot_disconnected'] as const) {
    const f = fixture(t);
    const gate = deferred<boolean>();
    const entered = deferred<void>();
    f.transport.authorizeCaller = () => { entered.resolve(); return gate.promise; };
    const context = f.context();
    if (cause === 'expired') context.scope.expiresAt = Date.now() + 500;
    const request = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
      { context: context.input, spec: { operation: 'youtube.resolve', url: URL } }, cause);
    await settles(entered.promise);
    if (cause === 'expired') t.mock.timers.tick(500);
    else {
      const endpoint = cause === 'bot_disconnected' ? f.bot : f.origin;
      f.current.delete(endpoint);
      f.current.add({ ...endpoint, ws: {} });
      t.mock.timers.tick(1000);
    }
    await settles(request);
    if (cause !== 'bot_disconnected') assert.equal(f.errors.at(-1)?.reason, cause);
    gate.resolve(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.sent, []);
    f.service.close();
  }
  const f = fixture(t);
  const gate = deferred<boolean>();
  let calls = 0;
  f.transport.authorizeCaller = () => { calls++; return gate.promise; };
  const requests = [];
  for (let index = 0; index < limits.tasksPerExecutor; index++) {
    requests.push(f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
      { context: f.context().input, spec: { operation: 'youtube.resolve', url: URL } }, `executor-${index}`));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await settles(f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
    { context: f.context().input, spec: { operation: 'youtube.resolve', url: URL } }, 'pending-executor-limit'));
  assert.equal(calls, limits.tasksPerExecutor);
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  f.service.disconnect(f.origin);
  await settles(Promise.all(requests));
  gate.reject(new Error('Controlled abandoned executor failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.unexpected, []);
});

test('local execution cancellation retains every unsettled sibling of failed ICE and voice authorization', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  for (const stage of ['voice', 'ice'] as const) {
    const f = fixture(t);
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let calls = 0;
    f.voices.set(f.bot, 'voice');
    if (stage === 'voice') f.transport.authorizeCaller = async () => { throw new Error('Controlled caller failure'); };
    f.transport.authorizeVoice = async () => {
      if (stage === 'voice') {
        calls++;
        const gate = deferred<void>();
        gates.push(gate);
        await gate.promise;
      }
      return true;
    };
    f.transport.iceServers = async (session) => {
      if (session === f.bot) throw new Error('Controlled bot ICE failure');
      calls++;
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return [];
    };
    for (let index = 0; index < limits.tasksPerBot; index++) {
      const origin = f.session();
      f.voices.set(origin, 'voice');
      await settles(f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
        context: f.context('invocation', origin).input, spec: { operation: 'youtube.stream', url: URL }, voiceChannelId: 'voice',
      }, `sibling-${index}`));
    }
    assert.equal(calls, limits.tasksPerBot);
    assert.equal(f.service.counts.tasks, 0);
    await settles(f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
      { context: f.context().input, spec: { operation: 'youtube.resolve', url: URL } }, 'sibling-overflow'));
    assert.equal(f.errors.at(-1)?.reason, 'busy', 'Promise.all rejection must not free a still-running sibling');
    assert.equal(f.unexpected.length, limits.tasksPerBot);
    for (const gate of gates) gate.reject(new Error('Controlled late sibling failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.unexpected.length, limits.tasksPerBot, 'Late sibling failures are observed without duplicate reports');
    assert.deepEqual(f.sent, []);
    f.service.close();
  }
});

test('local execution source release remains owned and idempotent at full quota while pending source-backed metadata is cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  let source = await f.retain();
  for (let index = 1; index < limits.sourceContextsPerBot; index++) source = await f.retain();
  const gate = deferred<boolean>();
  const entered = deferred<void>();
  f.transport.authorizeCaller = () => { entered.resolve(); return gate.promise; };
  const request = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: { kind: 'source', sourceContextId: source.sourceContextId }, spec: { operation: 'youtube.resolve', url: URL },
  }, 'pending-source-metadata');
  await settles(entered.promise);
  const release = (owner = f.bot) => f.service.handle(owner, MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: source.sourceContextId }, randomUUID());
  await settles(release(f.session(true)));
  assert.equal(f.errors.at(-1)?.reason, 'permission_denied');
  await settles(release());
  await settles(request);
  assert.equal(f.errors.at(-1)?.reason, 'source_released');
  assert.equal(f.errors.at(-1)?.requestId, 'pending-source-metadata');
  await settles(release());
  assert.equal(f.service.counts.sources, limits.sourceContextsPerBot - 1);
  assert.equal(f.service.counts.released, 1);
  gate.resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(f.sent.some((entry) => entry.message.type === MessageType.BOT_LOCAL_TASK_OFFER), false);
  assert.deepEqual(f.unexpected, []);
});

test('local execution active task messages bound authorization and settle on deadline, context end and shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  for (const kind of ['accept', 'control', 'signal', 'event'] as const) {
    for (const cause of ['timeout', 'server_shutdown', 'requester_disconnected', 'expired'] as const) {
      const f = fixture(t);
      f.voices.set(f.bot, 'voice');
      f.voices.set(f.origin, 'voice');
      const context = f.context();
      const offer = await f.request(context.input, { operation: 'youtube.stream', url: URL });
      if (kind === 'control' || kind === 'event') {
        await f.negotiate(offer);
        await f.accept(offer);
        await f.ready(offer, f.bot);
        await f.ready(offer, f.origin);
      }
      const before = f.sent.length;
      const gate = deferred<boolean>();
      const entered = deferred<void>();
      f.transport.authorizeCaller = () => { entered.resolve(); return gate.promise; };
      const pending = kind === 'accept' ? f.accept(offer)
        : kind === 'control' ? f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_CONTROL,
          { taskId: offer.taskId, action: 'pause', revision: 1 })
          : kind === 'signal' ? f.service.handle(f.origin, MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
            taskId: offer.taskId, mediaGeneration: offer.media?.generation,
            signal: { signalType: 'offer', sdp: { type: 'offer', sdp: SDP } },
          }) : f.service.handle(f.origin, MessageType.BOT_LOCAL_TASK_EVENT, {
            state: 'completed', taskId: offer.taskId, mediaGeneration: offer.media?.generation, playedFrames: 1,
          });
      await settles(entered.promise);
      if (cause === 'timeout') t.mock.timers.tick(limits.taskStartTimeoutMs);
      else if (cause === 'server_shutdown') f.service.close();
      else if (cause === 'requester_disconnected') f.service.disconnect(f.origin);
      else f.service.contextEnded(context.input, 'expired');
      await settles(pending);
      assert.equal(f.service.counts.tasks, 0);
      assert.deepEqual(f.events(offer).at(-1), cause === 'timeout'
        ? { state: 'failed', taskId: offer.taskId, reason: 'timeout' }
        : { state: 'cancelled', taskId: offer.taskId, cause });
      assert.equal(f.sent.length, before + 2, 'Only termination is published after authorization is abandoned');
      gate.reject(new Error('Controlled abandoned task-message authorization'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.sent.length, before + 2);
      assert.deepEqual(f.unexpected, []);
      f.service.close();
    }
  }
});

test('local execution metadata proof consumption and source reconciliation close without awaiting authorization', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const preview = f.context('audio-preview');
  const offer = await f.request(preview.input, { operation: 'youtube.preview', url: URL });
  await f.accept(offer);
  const accepted = f.events(offer).find((event) => event.state === 'accepted');
  assert.ok(accepted?.state === 'accepted' && accepted.result.operation === 'youtube.preview');
  await f.retain();
  await f.retain();
  const proofGate = deferred<BotLocalContext<Session> | undefined>();
  const sourceGate = deferred<boolean>();
  const proofEntered = deferred<void>();
  const sourceEntered = deferred<void>();
  let sourceCalls = 0;
  f.transport.authorizeContext = () => { proofEntered.resolve(); return proofGate.promise; };
  f.transport.authorizeCaller = () => { sourceCalls++; sourceEntered.resolve(); return sourceGate.promise; };
  const proof = f.service.consumePreview(f.bot, f.origin, preview.id, preview.scope.requestId, accepted.result);
  const sources = f.service.reconcileAccess();
  await settles(Promise.all([proofEntered.promise, sourceEntered.promise]));
  assert.equal(sourceCalls, 1, 'One sequential source reconciliation is sufficient for each owner');
  f.service.close();
  assert.equal(await settles(proof), false);
  await settles(sources);
  proofGate.resolve(preview.scope);
  sourceGate.reject(new Error('Controlled late source reconciliation failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sourceCalls, 1);
  assert.deepEqual(f.service.counts, { tasks: 0, sources: 0, released: 0, previews: 0, retired: 0 });
  assert.deepEqual(f.unexpected, []);
});

test('local execution error and diagnostic failures cannot reject a socket handler or a cancelled late dependency', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const diagnostics: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { diagnostics.push(args); });
  const f = fixture(t);
  f.transport.error = () => { throw new Error('Controlled error delivery failure'); };
  f.transport.reportError = () => { throw new Error('Controlled reporter failure'); };
  f.transport.botIdentity = async () => { throw new Error('Controlled authentication failure'); };
  await settles(f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
    { context: f.context().input, spec: { operation: 'youtube.resolve', url: URL } }, 'auth-error'));
  const gate = deferred<LocalTaskOffer['bot'] | undefined>();
  f.transport.botIdentity = () => gate.promise;
  const pending = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
    { context: f.context().input, spec: { operation: 'youtube.resolve', url: URL } }, 'late-auth-error');
  t.mock.timers.tick(limits.taskStartTimeoutMs);
  await settles(pending);
  gate.reject(new Error('Controlled late authentication failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sent, []);
  assert.equal(f.service.counts.tasks, 0);
  const active = fixture(t);
  const offer = await active.request();
  const authorization = deferred<boolean>();
  const entered = deferred<void>();
  active.transport.authorizeCaller = () => { entered.resolve(); return authorization.promise; };
  const acceptance = active.accept(offer);
  await settles(entered.promise);
  active.transport.send = () => { throw new Error('Controlled shutdown delivery failure'); };
  active.transport.error = f.transport.error;
  active.transport.reportError = f.transport.reportError;
  assert.doesNotThrow(() => active.service.close());
  await settles(acceptance);
  authorization.reject(new Error('Controlled late authorization after failed shutdown delivery'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active.service.counts.tasks, 0);
  assert.ok(diagnostics.length > 0, 'Reporter failures must remain visible without interrupting cleanup');
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic[0], '[BOT] Local execution diagnostic delivery failed.');
    assert.ok(diagnostic[1] instanceof Error);
    assert.ok(diagnostic[2] instanceof Error);
  }
});

test('local execution globally bounds abandoned admissions from different bot identities including source operations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const gate = deferred<LocalTaskOffer['bot'] | undefined>();
  let calls = 0;
  f.transport.botIdentity = () => { calls++; return gate.promise; };
  const requests = [];
  for (let index = 0; index < LIMITS.MAX_BOT_INVOCATIONS; index++) {
    const bot = f.session(true);
    const context = f.context('invocation', f.origin, bot);
    requests.push(index % 2 ? f.service.handle(bot, MessageType.BOT_LOCAL_TASK_REQUEST,
      { context: context.input, spec: { operation: 'youtube.resolve', url: URL } }, `global-${index}`)
      : f.service.handle(bot, MessageType.BOT_LOCAL_SOURCE_REQUEST,
        { action: 'retain', invocationId: context.id, url: URL }, `global-${index}`));
    f.current.delete(bot);
    f.service.disconnect(bot);
  }
  await settles(Promise.all(requests));
  assert.equal(calls, LIMITS.MAX_BOT_INVOCATIONS);
  const owner = f.session(true);
  await settles(f.service.handle(owner, MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: f.context('invocation', f.origin, owner).id, url: URL }, 'global-admission-overflow'));
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  assert.equal(calls, LIMITS.MAX_BOT_INVOCATIONS);
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(f.service.counts.sources, 0);
  gate.reject(new Error('Controlled late failures for globally bounded work'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.unexpected, []);
  assert.deepEqual(f.sent, []);
});

test('local execution dropped tasks keep their unsettled message authorization quota', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const original = f.transport.authorizeCaller;
  const gate = deferred<boolean>();
  let calls = 0;
  for (let index = 0; index < limits.tasksPerBot; index++) {
    const context = f.context('invocation', f.session());
    f.transport.authorizeCaller = original;
    const offer = await f.request(context.input);
    const entered = deferred<void>();
    f.transport.authorizeCaller = () => { calls++; entered.resolve(); return gate.promise; };
    const pending = f.accept(offer, context.scope.origin);
    await settles(entered.promise);
    f.service.contextEnded(context.input);
    await settles(pending);
    assert.equal(f.service.counts.tasks, 0);
  }
  f.transport.authorizeCaller = original;
  await settles(f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
    { context: f.context().input, spec: { operation: 'youtube.resolve', url: URL } }, 'dropped-task-overflow'));
  assert.equal(calls, limits.tasksPerBot);
  assert.equal(f.errors.at(-1)?.reason, 'busy');
  gate.resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const offer = await f.request();
  await f.accept(offer);
  assert.equal(f.service.counts.tasks, 0);
  assert.deepEqual(f.unexpected, []);
});

test('local execution voice departure cancels only pending source streams and preserves metadata admissions and references', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const source = await f.retain();
  f.voices.set(f.bot, 'voice');
  f.voices.set(f.origin, 'voice');
  const identity = await f.transport.botIdentity(f.bot);
  const gate = deferred<LocalTaskOffer['bot'] | undefined>();
  f.transport.botIdentity = () => gate.promise;
  const context: LocalRequestContext = { kind: 'source', sourceContextId: source.sourceContextId };
  const metadata = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
    { context, spec: { operation: 'youtube.resolve', url: URL } }, 'metadata-keeps-running');
  const stream = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
    { context, spec: { operation: 'youtube.stream', url: URL }, voiceChannelId: 'voice' }, 'stream-leaves-voice');
  let metadataSettled = false;
  void metadata.then(() => { metadataSettled = true; });
  f.voices.delete(f.origin);
  f.service.voiceChanged();
  await settles(stream);
  assert.equal(f.errors.at(-1)?.reason, 'requester_left_voice');
  assert.equal(f.errors.at(-1)?.requestId, 'stream-leaves-voice');
  assert.equal(metadataSettled, false);
  assert.equal(f.service.counts.sources, 1);
  gate.resolve(identity);
  await settles(metadata);
  const offers = f.sent.filter((entry) => entry.message.type === MessageType.BOT_LOCAL_TASK_OFFER);
  assert.equal(offers.length, 2, 'Only metadata receives its two authenticated offers');
  const offer = localTaskOfferSchema.parse(offers[0].message.payload);
  assert.equal(offer.spec.operation, 'youtube.resolve');
  await f.accept(offer);
  assert.equal(f.service.counts.sources, 1);
  assert.deepEqual(f.unexpected, []);
});

test('local execution retained-source expiry cancels first authentication before a task is reserved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const f = fixture(t);
  const source = await f.retain();
  t.mock.timers.tick(limits.sourceContextTtlMs - 500);
  const gate = deferred<LocalTaskOffer['bot'] | undefined>();
  f.transport.botIdentity = () => gate.promise;
  const pending = f.service.handle(f.bot, MessageType.BOT_LOCAL_TASK_REQUEST,
    { context: { kind: 'source', sourceContextId: source.sourceContextId }, spec: { operation: 'youtube.resolve', url: URL } },
    'source-expiry-during-identity');
  t.mock.timers.tick(500);
  await settles(pending);
  assert.equal(f.errors.at(-1)?.reason, 'expired');
  assert.equal(f.errors.at(-1)?.requestId, 'source-expiry-during-identity');
  assert.equal(f.service.counts.tasks, 0);
  assert.equal(f.service.counts.sources, 0);
  gate.reject(new Error('Controlled late identity after source expiry'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.sent.some((entry) => entry.message.type === MessageType.BOT_LOCAL_TASK_OFFER), false);
  assert.deepEqual(f.unexpected, []);
});

test('local execution bounded source reconciliation preserves unrelated references after one caller authorization fails', async (t) => {
  const f = fixture(t);
  const unavailable = f.session();
  const denied = f.session();
  await f.retain(f.bot, unavailable);
  await f.retain(f.bot, denied);
  const permitted = await f.retain();
  f.transport.authorizeCaller = async (userId) => {
    if (userId === unavailable.user.id) throw new Error('Controlled per-caller authorization failure');
    return userId !== denied.user.id;
  };
  await settles(f.service.reconcileAccess());
  assert.equal(f.service.counts.sources, 1);
  assert.equal(f.unexpected.length, 1);
  const offer = await f.request({ kind: 'source', sourceContextId: permitted.sourceContextId });
  await f.accept(offer);
  assert.equal(f.service.counts.sources, 1);
});
