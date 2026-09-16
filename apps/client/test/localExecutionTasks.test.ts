import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  LOCAL_EXECUTION_PROTOCOL_LIMITS,
  LOCAL_MEDIA_PROTOCOL,
  MessageType,
  localTaskAcceptSchema,
  localTaskEventSchema,
  type LocalBotIdentity,
  type LocalConnectionState,
  type LocalExecutionFailure,
  type LocalExecutionSnapshot,
  type LocalMediaSignal,
  type LocalMediaTrack,
  type LocalPreparationInput,
  type LocalPreparationResult,
  type LocalPreviewReference,
  type LocalRuntimeSourceFailure,
  type LocalTaskEvent,
  type LocalTaskFailureEvent,
  type LocalTaskOffer,
  type LocalTaskResult,
  type LocalTaskStartInput,
  type LocalTaskStartResult,
  type SlashCommand,
} from '@monky/shared';
import {
  LocalExecutionController,
  type LocalExecutionTaskNotice,
  type PreparedLocalCapability,
} from '../src/renderer/core/LocalExecutionController';
import type { LocalAudioSenderOptions, LocalAudioSenderTransport } from '../src/renderer/core/LocalAudioSender';
import { LocalExecutionError, type LocalExecutionApi } from '../src/renderer/core/localExecutionSupport';
import { NetworkClient, type ConnectionStatus } from '../src/renderer/core/NetworkClient';
import { appEvents, EventBus } from '../src/renderer/core/EventBus';
import {
  currentEventOrigin, isForegroundEvent, setEventOrigin, setForegroundContext,
} from '../src/renderer/core/sessionRouting';
import {
  createServerStore, getActiveServerStore, serverStore, setActiveServerStore,
} from '../src/renderer/stores/serverStore';

const bot = { botId: 'bot-a', botName: 'Same display name', botPublicKey: 'a'.repeat(64) };
const permit = '1'.repeat(64);
const track: LocalMediaTrack = {
  id: 'abcdefghijk', title: 'Controlled local track',
  url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 12,
};
const preview: Extract<LocalTaskResult, { operation: 'youtube.preview' }> = {
  operation: 'youtube.preview', mimeType: 'audio/ogg', audioBase64: 'T2dnUw==',
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  const callbacks: { resolve?: (value: T) => void; reject?: (error: Error) => void } = {};
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });
  return {
    promise,
    get settled() { return settled; },
    resolve(value: T) {
      assert.ok(callbacks.resolve);
      settled = true;
      callbacks.resolve(value);
    },
    reject(error: Error) {
      assert.ok(callbacks.reject);
      settled = true;
      callbacks.reject(error);
    },
  };
}

class Client extends NetworkClient {
  public currentStatus: ConnectionStatus = 'CONNECTED';
  public wireId: string;
  public origin: string;
  public readonly observers = new Set<(event: string, data: unknown, requestId?: string) => void>();
  public readonly sent: Array<{
    type: MessageType; payload: unknown; requestId?: string; connectionId: string;
  }> = [];

  constructor(scope: string) {
    super();
    this.wireId = `connection-${scope}`;
    this.origin = `wss://${scope}.example.invalid`;
    this.sessionKey = this.origin;
  }

  public override getStatus(): ConnectionStatus { return this.currentStatus; }
  public override getConnectionId(): string { return this.wireId; }
  public override getCurrentServerUrl(): string { return this.origin; }
  public override onEvent(listener: (event: string, data: unknown, requestId?: string) => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }
  public override send(type: MessageType, payload: unknown, requestId?: string): void {
    this.sent.push({ type, payload, requestId, connectionId: this.wireId });
  }
  public emit(event: string, data?: unknown, requestId?: string): void {
    for (const listener of this.observers) listener(event, data, requestId);
  }
  public message(type: MessageType, payload: unknown, requestId?: string): void {
    this.emit(`message.${type}`, payload, requestId);
  }
}

function nativeFixture() {
  const connections: LocalConnectionState[] = [];
  const preparations: Array<{
    input: LocalPreparationInput; result: ReturnType<typeof deferred<LocalPreparationResult>>;
  }> = [];
  const starts: Array<{
    input: LocalTaskStartInput; result: ReturnType<typeof deferred<LocalTaskStartResult>>;
  }> = [];
  const cancelledRequests: string[] = [];
  const cancelledTasks: string[] = [];
  const changes = new Set<(snapshot: LocalExecutionSnapshot) => void>();
  const failures = new Set<(failure: LocalTaskFailureEvent) => void>();
  const api: LocalExecutionApi = {
    setLocalExecutionConnection: async (state) => {
      connections.push(state);
      return { status: 'completed' };
    },
    prepareLocalExecution: (input) => {
      const result = deferred<LocalPreparationResult>();
      preparations.push({ input, result });
      return result.promise;
    },
    startLocalExecutionTask: (input) => {
      const result = deferred<LocalTaskStartResult>();
      starts.push({ input, result });
      return result.promise;
    },
    cancelLocalExecutionRequest: async ({ requestId }) => {
      cancelledRequests.push(requestId);
      return { status: 'completed' };
    },
    cancelLocalExecutionTask: async (taskId) => {
      cancelledTasks.push(taskId);
      return { status: 'completed' };
    },
    readLocalExecutionFrames: async () => { throw new Error('Controller must not read real media'); },
    acknowledgeLocalExecutionFrames: async () => { throw new Error('Fake sender owns playback acknowledgements'); },
    setLocalExecutionPaused: async () => { throw new Error('Controller must route pause through its sender'); },
    onLocalExecutionChanged: (callback) => {
      changes.add(callback);
      return () => { changes.delete(callback); };
    },
    onLocalExecutionTaskFailed: (callback) => {
      failures.add(callback);
      return () => { failures.delete(callback); };
    },
  };
  return {
    api, connections, preparations, starts, cancelledRequests, cancelledTasks, changes, failures,
    fail(taskId: string, reason: LocalExecutionFailure = 'worker_failed', sourceFailure?: LocalRuntimeSourceFailure) {
      for (const callback of failures) callback({ taskId, reason, ...(sourceFailure ? { sourceFailure } : {}) });
    },
    change(snapshot: LocalExecutionSnapshot) {
      for (const callback of changes) callback(snapshot);
    },
  };
}

class FakeSender implements LocalAudioSenderTransport {
  public readonly connection = deferred<void>();
  public readonly signals: LocalMediaSignal[] = [];
  public readonly starts: string[] = [];
  public readonly pauses: boolean[] = [];
  public connectCalls = 0;
  public closeCalls = 0;
  public readyCalls = 0;
  private ended = false;
  private drained = false;
  private nativeAcknowledged = false;
  private played = 0;

  constructor(public readonly options: LocalAudioSenderOptions) {}

  public get sourceEnded(): boolean { return this.ended; }
  public get nativePlaybackComplete(): boolean { return this.nativeAcknowledged; }
  public get completed(): boolean { return this.drained; }
  public get playedFrames(): number { return this.played; }
  public connect(): Promise<void> {
    this.connectCalls++;
    return this.connection.promise;
  }
  public async acceptSignal(signal: LocalMediaSignal): Promise<void> { this.signals.push(signal); }
  public start(mainTaskId: string): void { this.starts.push(mainTaskId); }
  public markReady(): void {
    if (!this.closeCalls && !this.readyCalls) this.readyCalls++;
  }
  public async setPaused(paused: boolean): Promise<void> { this.pauses.push(paused); }
  public close(): void { this.closeCalls++; }
  public endSource(): void { this.ended = true; }
  public drain(playedFrames: number): void {
    assert.equal(this.sourceEnded, true, 'Only the media owner may report a validated EOF/drain');
    this.drained = true;
    this.nativeAcknowledged = true;
    this.played = playedFrames;
    this.options.onDrained(playedFrames);
  }
  public fail(reason: LocalExecutionFailure = 'transport_failed', sourceFailure?: LocalRuntimeSourceFailure): void {
    this.options.onFailure(reason, sourceFailure);
  }
}

function command(identity = bot): SlashCommand {
  return { ...identity, name: 'play', description: 'Controlled local command', localCapabilities: ['youtube-audio'] };
}

function fixture(context: TestContext, scope = 'a', apiEnabled = true) {
  const client = new Client(scope);
  const server = createServerStore();
  server.bus = new EventBus();
  const details = {
    id: `server-${scope}`, name: `Server ${scope}`, createdAt: 1, maxUsers: 10, hasPassword: false,
    channels: [], members: [], voiceStates: {}, roles: [], userRoles: [],
  };
  server.setServerDetails(details, {
    id: `user-${scope}`, clientId: `device-${scope}`, sessionId: `physical-session-${scope}`,
    nickname: 'Executor', status: 'ONLINE', joinedAt: 1,
  });
  server.setSlashCommands([command()]);
  const native = nativeFixture();
  const senders: FakeSender[] = [];
  const owners: AbortController[] = [];
  const voiceChecks: Array<{ botId: string; botSessionId: string; channelId: string }> = [];
  const room = `voice-${scope}`;
  const botSessionId = `bot-session-${scope}`;
  let voice: string | null = room;
  let botVoice: { sessionId: string; channelId: string } | null = { sessionId: botSessionId, channelId: room };
  const controller = new LocalExecutionController(client, server, () => voice, apiEnabled ? native.api : null, {
    botIsInVoice: (botId, sessionId, channelId) => {
      voiceChecks.push({ botId, botSessionId: sessionId, channelId });
      return botId === bot.botId && botVoice?.sessionId === sessionId && botVoice.channelId === channelId;
    },
    createSender: (options) => {
      const sender = new FakeSender(options);
      senders.push(sender);
      return sender;
    },
  });
  context.after(async () => {
    controller.dispose();
    for (const owner of owners) owner.abort();
    for (const preparation of native.preparations) {
      if (!preparation.result.settled) preparation.result.resolve({ status: 'cancelled' });
    }
    for (const start of native.starts) {
      if (!start.result.settled) start.result.resolve({ status: 'cancelled' });
    }
    await flush();
    assert.equal(client.observers.size, 0);
    assert.equal(native.changes.size, 0);
    assert.equal(native.failures.size, 0);
  });
  return {
    client, server, controller, native, senders, details, room, botSessionId, voiceChecks,
    owner() {
      const owner = new AbortController();
      owners.push(owner);
      return owner;
    },
    voice(channelId: string | null) { voice = channelId; controller.syncVoiceContext(); },
    botVoice(value: typeof botVoice) { botVoice = value; controller.syncVoiceContext(); },
  };
}
type Fixture = ReturnType<typeof fixture>;

function offer(f: Fixture, overrides: Partial<LocalTaskOffer> = {}): LocalTaskOffer {
  const user = f.server.currentUser;
  assert.ok(user?.sessionId);
  return {
    taskId: 'wire-task-a', requestId: 'ui-request-a',
    context: { kind: 'invocation', invocationId: 'invocation-a' },
    bot: { ...bot, serverId: f.details.id, serverName: f.details.name },
    botSessionId: f.botSessionId, invokerId: user.id, invokerSessionId: user.sessionId,
    capability: 'youtube-audio', spec: { operation: 'youtube.resolve', url: track.url },
    expiresAt: Date.now() + 30_000, ...overrides,
  };
}

function streamOffer(f: Fixture, overrides: Partial<LocalTaskOffer> = {}): LocalTaskOffer {
  return offer(f, {
    spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: f.room,
    media: { protocol: LOCAL_MEDIA_PROTOCOL, generation: 7, iceServers: [] }, ...overrides,
  });
}

function sourceOffer(f: Fixture, taskId = 'wire-source-a'): LocalTaskOffer {
  return streamOffer(f, {
    taskId, requestId: `server-correlation-${taskId}`, context: { kind: 'source', sourceContextId: 'retained-source-a' },
  });
}

function candidate(taskId: string, generation = 7): LocalMediaSignal {
  return { taskId, mediaGeneration: generation, signal: { signalType: 'candidate', candidate: null } };
}

function events(f: Fixture, taskId?: string): LocalTaskEvent[] {
  return f.client.sent.filter((message) => message.type === MessageType.BOT_LOCAL_TASK_EVENT)
    .map((message) => localTaskEventSchema.parse(message.payload))
    .filter((event) => taskId === undefined || event.taskId === taskId);
}

function accepts(f: Fixture, taskId?: string) {
  return f.client.sent.filter((message) => message.type === MessageType.BOT_LOCAL_TASK_ACCEPT)
    .map((message) => localTaskAcceptSchema.parse(message.payload))
    .filter((accept) => taskId === undefined || accept.taskId === taskId);
}

function terminals(f: Fixture, taskId?: string): LocalTaskEvent[] {
  return events(f, taskId).filter((event) => event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled');
}

function denied(error: unknown): boolean {
  return error instanceof LocalExecutionError && error.reason === 'permission_denied';
}

async function prepare(f: Fixture, identity = bot, value = permit): Promise<PreparedLocalCapability> {
  const previous = f.native.preparations.length;
  const result = f.controller.prepare(identity, 'youtube-audio', f.owner().signal);
  await flush();
  if (f.native.preparations.length > previous) {
    assert.equal(f.native.preparations.length, previous + 1);
    f.native.preparations[previous].result.resolve({ status: 'prepared', permit: value });
  }
  return result;
}

function register(
  f: Fixture, grant: PreparedLocalCapability, kind: 'invocation' | 'autocomplete' | 'audio-preview' = 'invocation',
  requestId = 'ui-request-a', owner = f.owner(),
): AbortController {
  assert.deepEqual(f.controller.registerRequest(kind, requestId, grant, {
    channelId: 'text-a', commandName: 'play', signal: owner.signal,
  }), { capability: 'youtube-audio' });
  return owner;
}

function acknowledgeStream(f: Fixture, task: LocalTaskOffer): void {
  const accept = accepts(f, task.taskId)[0];
  assert.ok(accept);
  assert.ok(task.media);
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'accepted', ...accept, media: task.media });
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'ready', taskId: task.taskId, mediaGeneration: task.media.generation,
  });
}

async function startStream(f: Fixture, task: LocalTaskOffer, mainTaskId: string, ready = true): Promise<FakeSender> {
  const previousSenders = f.senders.length;
  const previousStarts = f.native.starts.length;
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  const preparation = f.native.preparations.at(-1);
  if (preparation && !preparation.result.settled) {
    preparation.result.resolve({ status: 'prepared', permit });
    await flush();
  }
  assert.equal(f.senders.length, previousSenders + 1);
  const sender = f.senders[previousSenders];
  sender.connection.resolve();
  await flush();
  assert.equal(f.native.starts.length, previousStarts + 1);
  f.native.starts[previousStarts].result.resolve({
    status: 'started', taskId: mainTaskId, result: { operation: 'youtube.stream', track },
  });
  await flush();
  assert.deepEqual(sender.starts, [mainTaskId]);
  assert.equal(accepts(f, task.taskId).length, 1);
  assert.equal(sender.readyCalls, 0, 'Main acceptance does not authorize frame reads');
  if (ready) acknowledgeStream(f, task);
  return sender;
}

function snapshot(f: Fixture, decision?: 'deny' | 'always' | 'connection', updatedAt = Date.now()): LocalExecutionSnapshot {
  const identity: LocalBotIdentity = { ...bot, serverId: f.details.id, serverName: f.details.name, serverOrigin: f.client.origin };
  return {
    supported: true, tools: [], tasks: [], toolsBytes: 0, cacheBytes: 0,
    permissions: decision ? [{ id: '9'.repeat(64), bot: identity, capability: 'youtube-audio', decision, updatedAt }] : [],
  };
}

test('autocomplete maps the original UI request separately from the remapped bot context and Main UUID', async (context) => {
  const f = fixture(context);
  const grant = await prepare(f);
  register(f, grant, 'autocomplete', 'ui-query');
  const task = offer(f, {
    requestId: 'ui-query', context: { kind: 'autocomplete', requestId: 'bot-query' },
    spec: { operation: 'youtube.search', query: 'controlled query' },
  });
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  assert.equal(f.native.starts.length, 1);
  assert.equal(f.senders.length, 0, 'Metadata starts without creating a private media link');
  const start = f.native.starts[0];
  assert.match(start.input.requestId, uuid);
  assert.notEqual(start.input.requestId, task.taskId);
  assert.notEqual(start.input.requestId, task.requestId);
  assert.notEqual(start.input.requestId, 'bot-query');
  assert.deepEqual(start.input, { requestId: start.input.requestId, permit, spec: task.spec });
  const result: LocalTaskResult = { operation: 'youtube.search', tracks: [track] };
  start.result.resolve({ status: 'started', taskId: 'native-metadata-uuid', result });
  await flush();
  assert.deepEqual(accepts(f), [{ taskId: task.taskId, result }]);
  assert.deepEqual(terminals(f), [{ state: 'completed', taskId: task.taskId }]);
  assert.deepEqual(f.native.cancelledTasks, [], 'Main metadata is already closed');
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, { ...task, taskId: 'wire-remapped', requestId: 'bot-query' });
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, {
    ...task, taskId: 'wire-rebound', context: { kind: 'autocomplete', requestId: 'other-bot-query' },
  });
  await flush();
  assert.equal(f.native.starts.length, 1);
  assert.equal(f.native.preparations.length, 1);
  assert.deepEqual(terminals(f, 'wire-remapped'), [{ state: 'failed', taskId: 'wire-remapped', reason: 'permission_denied' }]);
  assert.deepEqual(terminals(f, 'wire-rebound'), [{ state: 'failed', taskId: 'wire-rebound', reason: 'permission_denied' }]);
});

test('an invocation offer may precede its ACK, but later ACK and offers must preserve its binding', async (context) => {
  const f = fixture(context);
  register(f, await prepare(f));
  const task = streamOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  const acknowledgement = { invocationId: 'invocation-a', botId: bot.botId, channelId: 'text-a', commandName: 'play' };
  f.client.message(MessageType.COMMAND_INVOKED, acknowledgement, 'ui-request-a');
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, {
    ...task, taskId: 'invocation-id-is-not-rpc-id', requestId: acknowledgement.invocationId,
  });
  assert.deepEqual(terminals(f, 'invocation-id-is-not-rpc-id'), [{
    state: 'failed', taskId: 'invocation-id-is-not-rpc-id', reason: 'permission_denied',
  }]);
  assert.equal(f.senders.length, 1, 'Promoting invocation context preserves the original UI request ID');
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, {
    ...task, taskId: 'other-invocation-task', context: { kind: 'invocation', invocationId: 'other-invocation' },
  });
  assert.equal(f.senders[0].closeCalls, 0);
  assert.deepEqual(terminals(f, 'other-invocation-task'), [{
    state: 'failed', taskId: 'other-invocation-task', reason: 'permission_denied',
  }]);
  f.client.message(MessageType.COMMAND_INVOKED, { ...acknowledgement, invocationId: 'wrong-invocation' }, 'bot-remapped-request');
  assert.equal(f.senders[0].closeCalls, 0, 'An ACK without original UI correlation cannot touch the request');
  f.client.message(MessageType.COMMAND_INVOKED, { ...acknowledgement, invocationId: 'wrong-invocation' }, 'ui-request-a');
  assert.equal(f.senders[0].closeCalls, 1);
  f.senders[0].connection.resolve();
  await flush();
  assert.equal(f.native.starts.length, 0);
  assert.equal(accepts(f).length, 0);
  assert.deepEqual(terminals(f, task.taskId), [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]);
});

for (const change of [
  { botId: 'same-name-other-bot' }, { channelId: 'other-channel' }, { commandName: 'other-command' },
  { invocationId: '' }, { invocationId: 'x'.repeat(129) },
]) {
  test(`an invocation ACK rejects changed caller context ${JSON.stringify(change)}`, async (context) => {
    const f = fixture(context);
    register(f, await prepare(f));
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, streamOffer(f));
    await flush();
    f.controller.acknowledgeRequest('ui-request-a', {
      invocationId: 'invocation-a', botId: bot.botId, channelId: 'text-a', commandName: 'play', ...change,
    });
    assert.equal(f.senders[0].closeCalls, 1);
    f.senders[0].connection.resolve();
    await flush();
    assert.equal(f.native.starts.length, 0);
    assert.equal(accepts(f).length, 0);
  });
}

const invalidOffers: ReadonlyArray<{
  name: string;
  change: (task: LocalTaskOffer, f: Fixture) => unknown;
  reason?: LocalExecutionFailure;
  source?: boolean;
}> = [
  { name: 'another key on the same bot and name', change: (task) => ({ ...task, bot: { ...task.bot, botPublicKey: 'b'.repeat(64) } }), reason: 'permission_denied', source: true },
  {
    name: 'an authenticated equal-name bot using another bot grant',
    change: (task, f) => {
      const other = { ...bot, botId: 'other-bot', botPublicKey: 'b'.repeat(64) };
      f.server.setSlashCommands([command(), command(other)]);
      return { ...task, bot: { ...task.bot, ...other } };
    },
    reason: 'permission_denied',
  },
  { name: 'another user', change: (task) => ({ ...task, invokerId: 'other-user' }), reason: 'permission_denied', source: true },
  { name: 'another device of the same user', change: (task) => ({ ...task, invokerSessionId: 'other-physical-session' }), reason: 'permission_denied', source: true },
  { name: 'another server', change: (task) => ({ ...task, bot: { ...task.bot, serverId: 'other-server' } }), reason: 'permission_denied', source: true },
  { name: 'an unknown UI request', change: (task) => ({ ...task, requestId: 'unknown-ui-request' }), reason: 'permission_denied' },
  { name: 'another request kind', change: (task) => ({ ...task, context: { kind: 'autocomplete', requestId: 'bot-query' } }), reason: 'permission_denied' },
  { name: 'an expired offer', change: (task) => ({ ...task, expiresAt: Date.now() - 1 }), reason: 'timeout', source: true },
  { name: 'an absent catalog', change: (task, f) => { f.server.setSlashCommands([]); return task; }, reason: 'permission_denied', source: true },
  {
    name: 'a catalog without this local capability',
    change: (task, f) => { f.server.setSlashCommands([{ ...command(), localCapabilities: [] }]); return task; },
    reason: 'permission_denied', source: true,
  },
  {
    name: 'a catalog without an authenticated bot key',
    change: (task, f) => { f.server.setSlashCommands([{ ...command(), botPublicKey: undefined }]); return task; },
    reason: 'permission_denied', source: true,
  },
  { name: 'an unknown capability', change: (task) => ({ ...task, capability: 'not-a-local-capability' }), source: true },
];

for (const scenario of invalidOffers) {
  test(`offers reject ${scenario.name} before calling Main or opening a sender`, async (context) => {
    const f = fixture(context);
    register(f, await prepare(f));
    const task = offer(f);
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, scenario.change(task, f));
    await flush();
    assert.equal(f.native.preparations.length, 1, 'Only the original explicit UI preparation reached Main');
    assert.equal(f.native.starts.length, 0);
    assert.equal(f.senders.length, 0);
    assert.equal(accepts(f).length, 0);
    if (scenario.reason) {
      assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: scenario.reason }]);
    } else assert.deepEqual(terminals(f), [], 'Malformed offers must not become routable wire tasks');
  });
}

for (const scenario of invalidOffers.filter((entry) => entry.source)) {
  test(`retained-source offers reject ${scenario.name} without prompting Main`, async (context) => {
    const f = fixture(context);
    const task = sourceOffer(f);
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, scenario.change(task, f));
    await flush();
    assert.equal(f.native.preparations.length, 0);
    assert.equal(f.native.starts.length, 0);
    assert.equal(f.senders.length, 0);
    assert.equal(accepts(f).length, 0);
    if (scenario.reason) {
      assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: scenario.reason }]);
    } else assert.deepEqual(terminals(f), []);
  });
}

test('retained sources still reject searches and previews without an original preview request', async (context) => {
  const f = fixture(context);
  const specs: ReadonlyArray<LocalTaskOffer['spec']> = [
    { operation: 'youtube.search', query: 'must not run' },
    { operation: 'youtube.preview', url: track.url },
  ];
  for (const spec of specs) {
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, offer(f, {
      taskId: spec.operation, context: { kind: 'source', sourceContextId: 'retained-source-a' }, spec,
    }));
  }
  await flush();
  assert.equal(f.native.preparations.length, 0);
  assert.equal(f.native.starts.length, 0);
  assert.deepEqual(terminals(f).map((event) => event.state), ['failed', 'failed']);
});

for (const missing of ['caller', 'bot', 'bot-session', 'native-api'] as const) {
  test(`retained stream rejects a missing ${missing} before asking for native permission`, async (context) => {
    const f = fixture(context, 'a', missing !== 'native-api');
    const task = sourceOffer(f);
    if (missing === 'caller') f.voice(null);
    if (missing === 'bot') f.botVoice(null);
    if (missing === 'bot-session') task.botSessionId = 'replacement-bot-session';
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
    await flush();
    assert.equal(f.native.preparations.length, 0);
    assert.equal(f.native.starts.length, 0);
    assert.equal(f.senders.length, 0);
    assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'executor_unavailable' }]);
  });
}

test('the per-executor task quota rejects excess offers before another native start', async (context) => {
  const f = fixture(context);
  register(f, await prepare(f));
  for (let index = 0; index < LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerExecutor; index++) {
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, offer(f, { taskId: `wire-quota-${index}` }));
  }
  await flush();
  assert.equal(f.native.starts.length, LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerExecutor);
  const otherBot = { ...bot, botId: 'other-bot', botPublicKey: 'b'.repeat(64) };
  f.server.setSlashCommands([command(), command(otherBot)]);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, offer(f, {
    taskId: 'wire-over-quota', context: { kind: 'source', sourceContextId: 'another-source' },
    bot: { ...otherBot, serverId: f.details.id, serverName: f.details.name },
  }));
  await flush();
  assert.equal(f.native.preparations.length, 1);
  assert.equal(f.native.starts.length, LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerExecutor);
  assert.deepEqual(terminals(f, 'wire-over-quota'), [{ state: 'failed', taskId: 'wire-over-quota', reason: 'busy' }]);
  assert.equal(accepts(f).length, 0);
});

test('a stream cannot start Main, ACCEPT or report ready before its private link connects', async (context) => {
  const f = fixture(context);
  register(f, await prepare(f));
  const task = streamOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  const sender = f.senders[0];
  assert.equal(sender.connectCalls, 1);
  assert.equal(sender.options.taskId, task.taskId);
  assert.deepEqual(sender.options.media, task.media);
  assert.equal(sender.options.api, f.native.api);
  assert.equal(f.native.starts.length, 0);
  assert.equal(f.client.sent.length, 0);
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate(task.taskId));
  assert.deepEqual(sender.signals, [candidate(task.taskId)]);
  sender.options.sendSignal(candidate(task.taskId));
  assert.equal(f.client.sent[0].type, MessageType.BOT_LOCAL_MEDIA_SIGNAL);
  assert.equal(f.native.starts.length, 0);
  sender.connection.resolve();
  await flush();
  assert.equal(f.native.starts.length, 1);
  const start = f.native.starts[0];
  assert.match(start.input.requestId, uuid);
  assert.deepEqual(start.input, { requestId: start.input.requestId, permit, spec: task.spec, voiceChannelId: f.room });
  assert.equal(accepts(f).length, 0);
  assert.deepEqual(events(f), []);
  start.result.resolve({ status: 'started', taskId: 'native-stream-a', result: { operation: 'youtube.stream', track } });
  await flush();
  assert.deepEqual(accepts(f), [{ taskId: task.taskId, result: { operation: 'youtube.stream', track } }]);
  assert.deepEqual(events(f), [{ state: 'ready', taskId: task.taskId, mediaGeneration: 7 }]);
  assert.deepEqual(sender.starts, ['native-stream-a']);
  assert.deepEqual(sender.pauses, [false]);
  assert.deepEqual(f.client.sent.slice(1).map((message) => message.type), [
    MessageType.BOT_LOCAL_TASK_ACCEPT, MessageType.BOT_LOCAL_TASK_EVENT,
  ]);
});

test('authoritative readiness follows matching server acceptance and cannot cross tasks or generations', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-waiting-ready', false);
  const ready = { state: 'ready', taskId: task.taskId, mediaGeneration: 7 };
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, ready);
  assert.equal(sender.readyCalls, 0);
  const accept = accepts(f, task.taskId)[0];
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'accepted', ...accept, media: { protocol: LOCAL_MEDIA_PROTOCOL, generation: 6, iceServers: [] },
  });
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, ready);
  assert.equal(sender.readyCalls, 0, 'Stale acceptance cannot authorize this generation');
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'accepted', ...accept, media: task.media });
  assert.equal(sender.readyCalls, 0, 'Earlier readiness must not be cached as authoritative');
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { ...ready, taskId: 'other-task' });
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { ...ready, mediaGeneration: 6 });
  assert.equal(sender.readyCalls, 0);
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, ready);
  assert.equal(sender.readyCalls, 1);
  acknowledgeStream(f, task);
  assert.equal(sender.readyCalls, 1, 'Duplicate acceptance/readiness never restarts the sender');
  assert.deepEqual(terminals(f), []);
});

test('server acceptance cannot replace the URL of an already-started native stream', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-mismatched-accept', false);
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, {
    state: 'accepted', taskId: task.taskId, media: task.media,
    result: { operation: 'youtube.stream', track: { ...track, id: 'zzzzzzzzzzz', url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz' } },
  });
  assert.equal(sender.readyCalls, 0);
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-mismatched-accept']);
  assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'invalid_request' }]);
});

test('cancellation before authoritative readiness stops Main and ignores late accepted/ready events', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-cancel-before-ready', false);
  f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'cancel', revision: 1 });
  acknowledgeStream(f, task);
  assert.equal(sender.readyCalls, 0);
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-cancel-before-ready']);
  assert.deepEqual(terminals(f), [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]);
});

test('the startup deadline still cancels Main when authoritative readiness never arrives', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-ready-timeout', false);
  context.mock.timers.tick(30_001);
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-ready-timeout']);
  assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'timeout' }]);
});

test('authoritative readiness clears only the startup deadline, not the live stream', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-ready-before-timeout');
  context.mock.timers.tick(30_001);
  assert.equal(sender.closeCalls, 0);
  assert.equal(sender.readyCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, []);
  assert.deepEqual(terminals(f), []);
});

test('a failed private connection never starts native media or emits ACCEPT/ready', async (context) => {
  const f = fixture(context);
  register(f, await prepare(f));
  const task = streamOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  const sender = f.senders[0];
  sender.connection.reject(new LocalExecutionError('transport_failed'));
  await flush();
  sender.fail();
  assert.equal(f.native.starts.length, 0);
  assert.equal(accepts(f).length, 0);
  assert.deepEqual(events(f), [{ state: 'failed', taskId: task.taskId, reason: 'transport_failed' }]);
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledRequests, []);
  assert.deepEqual(f.native.cancelledTasks, []);
});

for (const result of [
  { status: 'failed', reason: 'permission_denied' }, { status: 'cancelled' },
] satisfies ReadonlyArray<LocalTaskStartResult>) {
  test(`Main still has the final decision on a prepared stream: ${result.status}`, async (context) => {
    const f = fixture(context);
    register(f, await prepare(f));
    const task = streamOffer(f);
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
    await flush();
    const sender = f.senders[0];
    sender.connection.resolve();
    await flush();
    f.native.starts[0].result.resolve(result);
    await flush();
    assert.equal(accepts(f).length, 0);
    assert.deepEqual(sender.starts, []);
    assert.equal(sender.closeCalls, 1);
    assert.deepEqual(events(f), result.status === 'cancelled'
      ? [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]
      : [{ state: 'failed', taskId: task.taskId, reason: result.reason }]);
  });
}

test('matching ICE is buffered while retained-source consent is pending, but stale generations are discarded', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  assert.equal(f.native.preparations.length, 1, 'Retained source metadata cannot replace Main authorization');
  assert.equal(f.senders.length, 0);
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate(task.taskId, 6));
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate('other-task'));
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate(task.taskId));
  f.native.preparations[0].result.resolve({ status: 'prepared', permit });
  await flush();
  const sender = f.senders[0];
  assert.deepEqual(sender.signals, [candidate(task.taskId)]);
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate(task.taskId, 8));
  assert.equal(sender.signals.length, 1);
  assert.equal(f.native.starts.length, 0);
  assert.equal(accepts(f).length, 0);
  sender.connection.resolve();
  await flush();
  assert.equal(f.native.starts.length, 1);
});

test('cancellation uses the native request UUID before start replies and cancels a late native stream UUID', async (context) => {
  const f = fixture(context);
  register(f, await prepare(f));
  const task = streamOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  const sender = f.senders[0];
  sender.connection.resolve();
  await flush();
  const start = f.native.starts[0];
  assert.match(start.input.requestId, uuid);
  f.controller.releaseRequest(task.requestId);
  assert.deepEqual(f.native.cancelledRequests, [start.input.requestId]);
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, []);
  f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'cancel', revision: 0 });
  start.result.resolve({ status: 'started', taskId: 'late-native-stream', result: { operation: 'youtube.stream', track } });
  await flush();
  assert.deepEqual(f.native.cancelledTasks, ['late-native-stream']);
  assert.deepEqual(f.native.cancelledRequests, [start.input.requestId]);
  assert.equal(accepts(f).length, 0);
  assert.deepEqual(sender.starts, []);
  assert.deepEqual(terminals(f), [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]);
});

test('reconnect invalidates the active source immediately and reauthorizes a fresh task on the new connection', async (context) => {
  const f = fixture(context);
  const oldTask = sourceOffer(f);
  const oldSender = await startStream(f, oldTask, 'old-native-stream');
  const before = f.client.sent.length;
  f.client.currentStatus = 'RECONNECTING';
  f.client.emit('network.status', 'RECONNECTING');
  assert.equal(oldSender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['old-native-stream']);
  assert.equal(f.client.sent.length, before, 'No old-generation cancellation is sent on a replacement socket');
  await flush();
  assert.deepEqual(f.native.connections.at(-1), { connectionId: 'connection-a', connected: false, voiceChannelId: null });
  f.client.wireId = 'connection-new';
  f.client.currentStatus = 'CONNECTED';
  f.client.emit('network.connected');
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, oldTask);
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate(oldTask.taskId));
  f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: oldTask.taskId, action: 'resume', revision: 8 });
  oldSender.options.onDrained(12);
  f.native.fail('old-native-stream');
  assert.equal(f.native.preparations.length, 1);
  const freshTask = sourceOffer(f, 'wire-source-fresh');
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, freshTask);
  await flush();
  assert.equal(f.native.preparations.length, 2);
  assert.equal(f.native.preparations[1].input.subject.connectionId, 'connection-new');
  assert.equal(f.senders.length, 1);
  f.native.preparations[1].result.resolve({ status: 'prepared', permit: '2'.repeat(64) });
  await flush();
  const currentSender = f.senders[1];
  currentSender.connection.resolve();
  await flush();
  assert.equal(f.native.starts[1].input.permit, '2'.repeat(64));
  f.native.starts[1].result.resolve({ status: 'started', taskId: 'new-native-stream', result: { operation: 'youtube.stream', track } });
  await flush();
  assert.deepEqual(currentSender.starts, ['new-native-stream']);
  assert.deepEqual(oldSender.signals, []);
  assert.deepEqual(oldSender.pauses, [false]);
  assert.equal(terminals(f, oldTask.taskId).length, 0);
  assert.ok(f.client.sent.slice(before).every((message) => message.connectionId === 'connection-new'));
  assert.deepEqual(f.native.connections.at(-1), { connectionId: 'connection-new', connected: true, voiceChannelId: f.room });
});

test('a reconnect during retained-source preparation cancels its native request and ignores late permission and ICE', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate(task.taskId));
  f.client.currentStatus = 'RECONNECTING';
  f.client.emit('network.status', 'RECONNECTING');
  assert.deepEqual(f.native.cancelledRequests, [f.native.preparations[0].input.requestId]);
  f.native.preparations[0].result.resolve({ status: 'prepared', permit });
  f.client.wireId = 'connection-new';
  f.client.currentStatus = 'CONNECTED';
  f.client.emit('network.connected');
  f.client.message(MessageType.BOT_LOCAL_MEDIA_SIGNAL, candidate(task.taskId));
  await flush();
  assert.equal(f.senders.length, 0);
  assert.equal(f.native.starts.length, 0);
  assert.equal(accepts(f).length, 0);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f, 'wire-source-new'));
  await flush();
  assert.equal(f.native.preparations.length, 2);
  assert.equal(f.native.preparations[1].input.subject.connectionId, 'connection-new');
});

test('pause and resume revisions are idempotent, monotonic and bound to the live wire task', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-controlled');
  const control = (action: 'pause' | 'resume' | 'cancel', revision: number, taskId = task.taskId) => {
    f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId, action, revision });
  };
  control('pause', 4, 'native-controlled');
  control('pause', 4, 'unknown-task');
  assert.deepEqual(sender.pauses, [false]);
  control('pause', 4);
  await flush();
  control('pause', 4);
  control('resume', 3);
  await flush();
  assert.deepEqual(sender.pauses, [false, true]);
  control('resume', 5);
  await flush();
  assert.deepEqual(sender.pauses, [false, true, false]);
  assert.deepEqual(events(f), [
    { state: 'ready', taskId: task.taskId, mediaGeneration: 7 },
    { state: 'paused', taskId: task.taskId, revision: 4 },
    { state: 'resumed', taskId: task.taskId, revision: 5 },
  ]);
  control('cancel', 0);
  control('cancel', 0);
  control('pause', 6);
  await flush();
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-controlled']);
  assert.deepEqual(sender.pauses, [false, true, false]);
  assert.deepEqual(terminals(f), [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]);
});

test('conflicting actions at one control revision fail and close the live stream exactly once', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-conflicting');
  f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'pause', revision: 2 });
  await flush();
  f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'resume', revision: 2 });
  f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'resume', revision: 3 });
  await flush();
  assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'invalid_request' }]);
  assert.deepEqual(sender.pauses, [false, true]);
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-conflicting']);
});

test('invocation completion releases only its matching request and cancellation stops pending native work', async (context) => {
  const f = fixture(context);
  register(f, await prepare(f));
  const task = streamOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  const sender = f.senders[0];
  sender.connection.resolve();
  await flush();
  f.client.message(MessageType.COMMAND_FINISHED, { invocationId: 'other-invocation', channelId: 'text-a', reason: 'cancelled' });
  assert.deepEqual(f.native.cancelledRequests, []);
  f.client.message(MessageType.COMMAND_FINISHED, { invocationId: 'invocation-a', channelId: 'text-a', reason: 'cancelled' });
  assert.deepEqual(f.native.cancelledRequests, [f.native.starts[0].input.requestId]);
  assert.equal(sender.closeCalls, 1);
  assert.equal(accepts(f).length, 0);
});

test('early native failure is correlated to the late native UUID and reported once without ACCEPT', async (context) => {
  const f = fixture(context);
  const notices: LocalExecutionTaskNotice[] = [];
  context.after(appEvents.on<LocalExecutionTaskNotice>('localExecution.task_failed', (notice) => { notices.push(notice); }));
  register(f, await prepare(f));
  const task = streamOffer(f);
  f.native.fail('native-no-start-yet');
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  const sender = f.senders[0];
  sender.connection.resolve();
  await flush();
  f.native.fail(task.taskId, 'provider_unavailable');
  for (let index = 0; index < LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerExecutor + 2; index++) {
    f.native.fail(`unrelated-native-${index}`);
  }
  f.native.fail('native-early');
  f.native.fail('native-early');
  f.native.starts[0].result.resolve({ status: 'started', taskId: 'native-early', result: { operation: 'youtube.stream', track } });
  await flush();
  f.native.fail('native-early');
  sender.fail();
  assert.equal(accepts(f).length, 0);
  assert.deepEqual(sender.starts, []);
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-early']);
  assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'worker_failed' }]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].taskId, task.taskId);
  assert.equal(notices[0].reason, 'worker_failed');
});

test('late native failure ignores wire IDs and closes only its matching live stream once', async (context) => {
  const f = fixture(context);
  const notices: LocalExecutionTaskNotice[] = [];
  context.after(appEvents.on<LocalExecutionTaskNotice>('localExecution.task_failed', (notice) => { notices.push(notice); }));
  const firstTask = sourceOffer(f);
  const first = await startStream(f, firstTask, 'native-first');
  const secondTask = sourceOffer(f, 'wire-source-second');
  const second = await startStream(f, secondTask, 'native-second');
  f.native.fail(firstTask.taskId);
  f.native.fail('unknown-native');
  assert.equal(first.closeCalls, 0);
  assert.equal(second.closeCalls, 0);
  f.native.fail('native-first', 'provider_unavailable');
  f.native.fail('native-first');
  first.fail();
  assert.equal(first.closeCalls, 1);
  assert.equal(second.closeCalls, 0);
  assert.deepEqual(f.native.cancelledTasks, ['native-first']);
  assert.deepEqual(terminals(f), [{ state: 'failed', taskId: firstTask.taskId, reason: 'provider_unavailable' }]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].taskId, firstTask.taskId);
});

for (const leaving of ['caller', 'bot'] as const) {
  test(`source ${leaving} voice leave cancels only the live stream and rejoin reuses its permit for a fresh task`, async (context) => {
    const f = fixture(context);
    const task = sourceOffer(f);
    const sender = await startStream(f, task, 'native-before-leave');
    const metadata = offer(f, {
      taskId: 'wire-source-metadata', requestId: 'server-metadata-correlation', context: task.context,
    });
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, metadata);
    await flush();
    assert.equal(f.native.starts.length, 2);
    if (leaving === 'caller') f.voice(null);
    else f.botVoice(null);
    assert.equal(sender.closeCalls, 1);
    assert.deepEqual(f.native.cancelledTasks, ['native-before-leave']);
    assert.deepEqual(f.native.cancelledRequests, [], 'Voice membership does not cancel metadata work');
    f.native.starts[1].result.resolve({ status: 'started', taskId: 'native-metadata', result: { operation: 'youtube.resolve', track } });
    await flush();
    assert.equal(accepts(f, metadata.taskId).length, 1);
    assert.deepEqual(terminals(f, metadata.taskId), [{ state: 'completed', taskId: metadata.taskId }]);
    if (leaving === 'caller') f.voice(f.room);
    else f.botVoice({ sessionId: f.botSessionId, channelId: f.room });
    const nextTask = sourceOffer(f, 'wire-source-after-rejoin');
    await startStream(f, nextTask, 'native-after-rejoin');
    assert.equal(f.native.preparations.length, 1, 'Leaving voice does not discard the physical connection permit');
    assert.equal(f.native.starts[2].input.permit, permit);
    assert.ok(f.voiceChecks.every((check) => check.botId === bot.botId && check.botSessionId === f.botSessionId && check.channelId === f.room));
    assert.deepEqual(terminals(f, task.taskId), [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]);
  });
}

test('EOF tails survive WebSocket completion and only their own sender drain closes a successful stream', async (context) => {
  const f = fixture(context);
  const firstTask = sourceOffer(f);
  const first = await startStream(f, firstTask, 'native-ended-first');
  const secondTask = sourceOffer(f, 'wire-source-second');
  const second = await startStream(f, secondTask, 'native-ended-second');
  first.endSource();
  second.endSource();
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId: firstTask.taskId, mediaGeneration: 6, playedFrames: 99 });
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId: firstTask.taskId, mediaGeneration: 7, playedFrames: 99 });
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId: secondTask.taskId, mediaGeneration: 7, playedFrames: 99 });
  assert.equal(first.closeCalls, 0);
  assert.equal(second.closeCalls, 0);
  assert.deepEqual(terminals(f), []);
  first.drain(12);
  first.options.onDrained(99);
  assert.equal(first.closeCalls, 1);
  assert.equal(second.closeCalls, 0);
  assert.deepEqual(terminals(f), [{ state: 'completed', taskId: firstTask.taskId, mediaGeneration: 7, playedFrames: 12 }]);
  second.drain(18);
  assert.equal(second.closeCalls, 1);
  assert.deepEqual(terminals(f, secondTask.taskId), [{ state: 'completed', taskId: secondTask.taskId, mediaGeneration: 7, playedFrames: 18 }]);
  assert.deepEqual(f.native.cancelledRequests, []);
  assert.deepEqual(f.native.cancelledTasks, [], 'Successful drain includes final native playback acknowledgement');
});

test('permission revocation closes an EOF tail and cancels its retained Main playback lease', async (context) => {
  const f = fixture(context);
  const task = sourceOffer(f);
  const sender = await startStream(f, task, 'native-ended');
  sender.endSource();
  f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'completed', taskId: task.taskId, mediaGeneration: 7, playedFrames: 12 });
  assert.equal(sender.closeCalls, 0);
  f.native.change(snapshot(f));
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-ended']);
  assert.deepEqual(f.native.cancelledRequests, []);
  sender.drain(12);
  assert.deepEqual(terminals(f), [{ state: 'cancelled', taskId: task.taskId, cause: 'permission_revoked' }]);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f, 'wire-retry-revoked'));
  await flush();
  assert.equal(f.native.preparations.length, 1);
  assert.equal(f.native.starts.length, 1);
  assert.deepEqual(terminals(f, 'wire-retry-revoked'), [{ state: 'cancelled', taskId: 'wire-retry-revoked', cause: 'permission_revoked' }]);
});

for (const termination of ['cancel', 'leave', 'reconnect'] as const) {
  test(`${termination} cancels Main's paused EOF playback lease instead of only closing its peer`, async (context) => {
    const f = fixture(context);
    const task = sourceOffer(f);
    const sender = await startStream(f, task, 'native-paused-tail');
    sender.endSource();
    f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'pause', revision: 1 });
    await flush();
    if (termination === 'cancel') {
      f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'cancel', revision: 2 });
    } else if (termination === 'leave') f.voice(null);
    else {
      f.client.currentStatus = 'RECONNECTING';
      f.client.emit('network.status', 'RECONNECTING');
    }
    assert.equal(sender.closeCalls, 1);
    assert.deepEqual(f.native.cancelledTasks, ['native-paused-tail']);
    f.native.fail('native-paused-tail', 'worker_failed', { code: 'recovery_failed', attempts: 37 });
    assert.equal(sender.closeCalls, 1);
    assert.equal(terminals(f).some((event) => event.state === 'failed'), false);
  });
}

test('permission invalidation matches the full grant identity rather than its JavaScript object reference', async (context) => {
  const f = fixture(context);
  const grant = await prepare(f);
  register(f, { ...grant, subject: { ...grant.subject } });
  const task = streamOffer(f);
  const sender = await startStream(f, task, 'native-copied-grant');
  sender.endSource();
  f.native.change(snapshot(f, 'deny'));
  assert.equal(sender.closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-copied-grant']);
  assert.deepEqual(terminals(f), [{ state: 'cancelled', taskId: task.taskId, cause: 'permission_revoked' }]);
});

test('a changed physical caller during native start releases the pending task even before lifecycle notification', async (context) => {
  const f = fixture(context);
  register(f, await prepare(f));
  const task = streamOffer(f);
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  f.senders[0].connection.resolve();
  await flush();
  const user = f.server.currentUser;
  assert.ok(user);
  f.server.updateCurrentUser({ ...user, sessionId: 'replacement-physical-session' });
  f.native.starts[0].result.resolve({ status: 'started', taskId: 'native-stale-caller', result: { operation: 'youtube.stream', track } });
  await flush();
  assert.equal(f.senders[0].closeCalls, 1);
  assert.deepEqual(f.native.cancelledTasks, ['native-stale-caller']);
  assert.deepEqual(accepts(f), []);
  assert.deepEqual(terminals(f), [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]);
  f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, revision: 1, action: 'cancel' });
  assert.equal(f.senders[0].closeCalls, 1);
});

async function completedPreview(
  f: Fixture, grant: PreparedLocalCapability, requestId = 'ui-preview', taskId = 'wire-preview',
) {
  const owner = register(f, grant, 'audio-preview', requestId);
  const task = offer(f, {
    taskId, requestId, context: { kind: 'audio-preview', requestId: `bot-${requestId}` },
    spec: { operation: 'youtube.preview', url: track.url },
  });
  const before = f.native.starts.length;
  f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
  await flush();
  assert.equal(f.native.starts.length, before + 1);
  const nativeTaskId = `native-${taskId}`;
  f.native.starts[before].result.resolve({ status: 'started', taskId: nativeTaskId, result: preview });
  await flush();
  const accepted = accepts(f, taskId)[0];
  assert.ok(accepted);
  assert.equal(accepted.result.operation, 'youtube.preview');
  if (accepted.result.operation !== 'youtube.preview') throw new Error('Expected a local preview reference');
  const { operation, ...reference } = accepted.result;
  assert.equal(operation, 'youtube.preview');
  return { task, reference, owner, nativeTaskId, grant };
}

test('preview bytes never enter outgoing ACCEPT/events; only the original task/request/session can resolve the single-use handle', async (context) => {
  const f = fixture(context);
  const result = await completedPreview(f, await prepare(f));
  const { reference, task } = result;
  assert.match(reference.localPreviewId, uuid);
  assert.deepEqual(reference, {
    localPreviewId: reference.localPreviewId, taskId: task.taskId, requestId: task.requestId,
    executorSessionId: 'physical-session-a',
  });
  const outgoing = JSON.stringify(f.client.sent);
  for (const privateValue of [preview.audioBase64, 'audioBase64', 'mimeType', result.nativeTaskId, result.grant.permit]) {
    assert.equal(outgoing.includes(privateValue), false, `Outgoing traffic must not contain ${privateValue}`);
  }
  assert.deepEqual(terminals(f), [{ state: 'completed', taskId: task.taskId }]);
  assert.deepEqual(f.native.cancelledTasks, []);
  const wrongReferences: LocalPreviewReference[] = [
    { ...reference, taskId: 'other-wire-task' },
    { ...reference, taskId: result.nativeTaskId },
    { ...reference, requestId: `bot-${task.requestId}` },
    { ...reference, executorSessionId: 'same-user-other-device' },
    { ...reference, localPreviewId: 'unknown-local-handle' },
  ];
  for (const wrong of wrongReferences) {
    assert.throws(() => f.controller.resolvePreview(wrong, task.requestId, f.owner().signal), denied);
  }
  assert.throws(() => f.controller.resolvePreview(reference, `bot-${task.requestId}`, f.owner().signal), denied);
  const aborted = f.owner();
  aborted.abort();
  assert.throws(() => f.controller.resolvePreview(reference, task.requestId, aborted.signal), denied);
  assert.deepEqual(f.controller.resolvePreview(reference, task.requestId, f.owner().signal), preview);
  assert.throws(() => f.controller.resolvePreview(reference, task.requestId, f.owner().signal), denied);
});

test('a preview handle cannot cross authenticated bot keys or physical connections even with rewritten reference fields', async (context) => {
  const f = fixture(context);
  const result = await completedPreview(f, await prepare(f));
  const otherBot = { ...bot, botId: 'other-bot', botPublicKey: 'b'.repeat(64) };
  f.server.setSlashCommands([command(), command(otherBot)]);
  const otherGrant = await prepare(f, otherBot, '2'.repeat(64));
  register(f, otherGrant, 'audio-preview', 'other-ui-preview');
  assert.throws(() => f.controller.resolvePreview(
    { ...result.reference, requestId: 'other-ui-preview' }, 'other-ui-preview', f.owner().signal,
  ), denied);
  const other = fixture(context, 'other');
  register(other, await prepare(other), 'audio-preview', result.task.requestId);
  assert.throws(() => other.controller.resolvePreview(
    { ...result.reference, executorSessionId: 'physical-session-other' }, result.task.requestId, other.owner().signal,
  ), denied);
  assert.deepEqual(f.controller.resolvePreview(result.reference, result.task.requestId, f.owner().signal), preview);
});

for (const invalidation of [
  'request-abort', 'release', 'dispose', 'reconnect', 'catalog-key', 'server-cancel', 'server-fail', 'server-control',
] as const) {
  test(`preview ${invalidation} removes local bytes and prevents later handle reuse`, async (context) => {
    const f = fixture(context);
    const result = await completedPreview(f, await prepare(f));
    if (invalidation === 'request-abort') result.owner.abort();
    if (invalidation === 'release') f.controller.releaseRequest(result.task.requestId);
    if (invalidation === 'dispose') f.controller.dispose();
    if (invalidation === 'reconnect') {
      f.client.currentStatus = 'RECONNECTING';
      f.client.emit('network.status', 'RECONNECTING');
    }
    if (invalidation === 'catalog-key') {
      f.server.setSlashCommands([command({ ...bot, botPublicKey: 'b'.repeat(64) })]);
      f.client.message(MessageType.COMMANDS_LIST_RESPONSE, { commands: f.server.slashCommands });
    }
    if (invalidation === 'server-cancel') {
      f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'cancelled', taskId: result.task.taskId, cause: 'source_released' });
    }
    if (invalidation === 'server-fail') {
      f.client.message(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'failed', taskId: result.task.taskId, reason: 'permission_denied' });
    }
    if (invalidation === 'server-control') {
      f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: result.task.taskId, action: 'cancel', revision: 1 });
    }
    assert.throws(() => f.controller.resolvePreview(result.reference, result.task.requestId, f.owner().signal), denied);
    assert.throws(() => f.controller.previews.take(result.reference.localPreviewId, {
      connectionId: result.grant.subject.connectionId, botId: bot.botId,
      botPublicKey: bot.botPublicKey, requestId: result.task.requestId,
    }, result.task.taskId), denied, 'Public store must release bytes, not merely make the request unresolvable');
    assert.deepEqual(f.native.cancelledTasks, []);
  });
}

test('preview resolution rechecks the current authenticated user and physical session', async (context) => {
  const f = fixture(context);
  const result = await completedPreview(f, await prepare(f));
  const user = f.server.currentUser;
  assert.ok(user);
  f.server.updateCurrentUser({ ...user, sessionId: 'replacement-device-session' });
  assert.throws(() => f.controller.resolvePreview(result.reference, result.task.requestId, f.owner().signal), denied);
  f.server.updateCurrentUser({ ...user, id: 'replacement-user' });
  assert.throws(() => f.controller.resolvePreview(result.reference, result.task.requestId, f.owner().signal), denied);
});

for (const failure of ['denied', 'cancelled', 'tools-missing'] as const) {
  test(`automatic ${failure} source setup stays blocked across retries until an explicit UI prepare succeeds`, async (context) => {
    const f = fixture(context);
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f));
    await flush();
    f.native.preparations[0].result.resolve(failure === 'cancelled' ? { status: 'cancelled' } : {
      status: 'failed', reason: failure === 'denied' ? 'permission_denied' : 'tools_missing',
    });
    await flush();
    for (let index = 0; index < 3; index++) {
      f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f, `wire-retry-${index}`));
      await flush();
    }
    assert.equal(f.native.preparations.length, 1, 'A bot retry must never reopen native confirmation');
    assert.equal(f.native.starts.length, 0);
    assert.equal(f.senders.length, 0);
    assert.equal(terminals(f).length, 4);
    await prepare(f, bot, '2'.repeat(64));
    assert.equal(f.native.preparations.length, 2, 'A new explicit UI gesture may authorize again');
    await startStream(f, sourceOffer(f, 'wire-explicit-recovery'), 'native-recovered');
    assert.equal(f.native.preparations.length, 2);
    assert.equal(f.native.starts[0].input.permit, '2'.repeat(64));
  });
}

for (const failure of ['denied', 'cancelled'] as const) {
  test(`native reauthorization releases a ${failure} composer-only preparation without closing its owner`, async (context) => {
    let now = 1_800_000_000_000;
    context.mock.method(Date, 'now', () => now);
    const f = fixture(context);
    const owner = f.owner();
    const failed = f.controller.prepare(bot, 'youtube-audio', owner.signal);
    const rejected = assert.rejects(failed, LocalExecutionError);
    await flush();
    f.native.preparations[0].result.resolve(failure === 'denied'
      ? { status: 'failed', reason: 'permission_denied' } : { status: 'cancelled' });
    await rejected;
    now += 1000;
    f.native.change(snapshot(f, 'always', now));
    const retry = f.controller.prepare(bot, 'youtube-audio', owner.signal);
    await flush();
    assert.equal(f.native.preparations.length, 2);
    f.native.preparations[1].result.resolve({ status: 'prepared', permit: '6'.repeat(64) });
    assert.equal((await retry).permit, '6'.repeat(64));
  });

  test(`native reauthorization retires a coalesced ${failure} promise still owned by an open composer`, async (context) => {
    let now = 1_800_000_000_000;
    context.mock.method(Date, 'now', () => now);
    const f = fixture(context);
    const composer = f.owner();
    const preparation = f.controller.prepare(bot, 'youtube-audio', composer.signal);
    const rejected = assert.rejects(preparation, (error: unknown) => error instanceof LocalExecutionError &&
      error.reason === (failure === 'denied' ? 'permission_denied' : 'cancelled'));
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f));
    await flush();
    assert.equal(f.native.preparations.length, 1);
    f.native.preparations[0].result.resolve(failure === 'denied'
      ? { status: 'failed', reason: 'permission_denied' } : { status: 'cancelled' });
    await rejected;
    await flush();
    assert.equal(composer.signal.aborted, false, 'The composer remains mounted and owns its old observer');
    now += 1000;
    f.native.change(snapshot(f, 'always', now));
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f, 'wire-new-permission'));
    await flush();
    assert.equal(f.native.preparations.length, 2, 'New permission must not reuse a permanently rejected promise');
    const updated = f.controller.prepare(bot, 'youtube-audio', composer.signal);
    f.native.preparations[1].result.resolve({ status: 'prepared', permit: '7'.repeat(64) });
    assert.equal((await updated).permit, '7'.repeat(64));
    await flush();
    assert.equal(f.senders.length, 1, 'The original composer and retained source can share the fresh Main permit');
  });

  test(`only a newer matching permission can retry ${failure} source setup, and Main must still authorize it`, async (context) => {
    let now = 1_800_000_000_000;
    context.mock.method(Date, 'now', () => now);
    const f = fixture(context);
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f));
    await flush();
    f.native.preparations[0].result.resolve(failure === 'cancelled'
      ? { status: 'cancelled' } : { status: 'failed', reason: 'permission_denied' });
    await flush();
    f.native.change(snapshot(f, 'always', now));
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f, 'wire-equal-timestamp'));
    await flush();
    assert.equal(f.native.preparations.length, 1);
    now += 1000;
    const reauthorizedAt = now;
    const wrongKey = snapshot(f, 'always', now);
    wrongKey.permissions[0].bot.botPublicKey = 'b'.repeat(64);
    f.native.change(wrongKey);
    now += 1000;
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f, 'wire-other-permission'));
    await flush();
    assert.equal(f.native.preparations.length, 1, 'A matching display name is not a matching permission');
    f.native.change(snapshot(f, 'connection', reauthorizedAt));
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, sourceOffer(f, 'wire-reauthorized'));
    await flush();
    assert.equal(f.native.preparations.length, 2);
    assert.equal(f.senders.length, 0);
    assert.equal(f.native.starts.length, 0, 'The permission snapshot itself never becomes a Main permit');
    f.native.preparations[1].result.resolve({ status: 'prepared', permit: '3'.repeat(64) });
    await flush();
    assert.equal(f.senders.length, 1);
    f.senders[0].connection.resolve();
    await flush();
    assert.equal(f.native.starts[0].input.permit, '3'.repeat(64));
  });
}

test('side-server native subjects and output stay physical, and failure notices emit after temporary UI routing is restored', async (context) => {
  const active = fixture(context, 'active');
  const side = fixture(context, 'side');
  const previousStore = getActiveServerStore();
  const previousForeground = isForegroundEvent();
  const previousOrigin = currentEventOrigin();
  const notices: Array<{ notice: LocalExecutionTaskNotice; visibleServerId?: string; foreground: boolean; origin: string | null }> = [];
  const off = appEvents.on<LocalExecutionTaskNotice>('localExecution.task_failed', (notice) => {
    notices.push({ notice, visibleServerId: serverStore.serverDetails?.id, foreground: isForegroundEvent(), origin: currentEventOrigin() });
  });
  context.after(() => {
    off();
    setActiveServerStore(previousStore);
    setForegroundContext(previousForeground);
    setEventOrigin(previousOrigin);
  });
  setActiveServerStore(active.server);
  setForegroundContext(true);
  setEventOrigin(null);
  const task = sourceOffer(side);
  const sender = await startStream(side, task, 'native-side-stream');
  assert.deepEqual(side.native.preparations[0].input.subject, {
    ...bot, serverId: side.details.id, serverName: side.details.name,
    serverOrigin: side.client.origin, connectionId: side.client.wireId,
  });
  assert.equal(side.native.starts[0].input.voiceChannelId, side.room);
  sender.options.sendSignal(candidate(task.taskId));
  setActiveServerStore(side.server);
  setForegroundContext(false);
  setEventOrigin(side.client.sessionKey);
  try {
    side.native.fail('native-side-stream');
    assert.equal(notices.length, 0, 'UI handlers must not run while active proxies temporarily point at a side server');
    assert.equal(sender.closeCalls, 1);
  } finally {
    setActiveServerStore(active.server);
    setForegroundContext(true);
    setEventOrigin(null);
  }
  await flush();
  assert.deepEqual(notices, [{
    notice: {
      sessionKey: side.client.sessionKey, taskId: task.taskId, botName: bot.botName,
      serverName: side.details.name, reason: 'worker_failed',
    },
    visibleServerId: active.details.id, foreground: true, origin: null,
  }]);
  assert.deepEqual(active.client.sent, []);
  assert.equal(active.native.preparations.length, 0);
  assert.equal(active.native.starts.length, 0);
  assert.deepEqual(active.native.cancelledTasks, []);
  assert.deepEqual(side.native.cancelledTasks, ['native-side-stream']);
  assert.ok(side.client.sent.every((message) => message.connectionId === side.client.wireId));
  assert.equal(accepts(side).length, 1);
  assert.deepEqual(terminals(side), [{ state: 'failed', taskId: task.taskId, reason: 'worker_failed' }]);
});

test('native source failure wire fidelity', async (context) => {
  const runtimeFailures: readonly LocalRuntimeSourceFailure[] = [
    { code: 'input' }, { code: 'unsupported' }, { code: 'tools' }, { code: 'runtime' },
    { code: 'unavailable' }, { code: 'timeout' }, { code: 'busy' },
    { code: 'recovery_failed', attempts: 1 }, { code: 'recovery_failed', attempts: 37 },
    { code: 'recovery_failed', attempts: 100 },
  ];

  for (const sourceFailure of runtimeFailures) {
    await context.test(`native task start relays the exact source failure ${JSON.stringify(sourceFailure)}`, async (context) => {
      const f = fixture(context);
      register(f, await prepare(f));
      const task = offer(f);
      f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
      await flush();
      f.native.starts[0].result.resolve({ status: 'failed', reason: 'worker_failed', sourceFailure });
      await flush();
      assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'worker_failed', sourceFailure }]);
      assert.deepEqual(accepts(f), []);
    });
  }

  await context.test('failed source preparation and its blocked automatic retries preserve the original recovery count', async (context) => {
    const f = fixture(context);
    const task = sourceOffer(f);
    const sourceFailure: LocalRuntimeSourceFailure = { code: 'recovery_failed', attempts: 37 };
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
    await flush();
    f.native.preparations[0].result.resolve({ status: 'failed', reason: 'worker_failed', sourceFailure });
    await flush();
    const retry = sourceOffer(f, 'retry-source-failure');
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, retry);
    await flush();
    assert.equal(f.native.preparations.length, 1);
    assert.deepEqual(terminals(f), [
      { state: 'failed', taskId: task.taskId, reason: 'worker_failed', sourceFailure },
      { state: 'failed', taskId: retry.taskId, reason: 'worker_failed', sourceFailure },
    ]);
  });

  await context.test('native connection mutation failures retain their source detail through preparation and task routing', async (context) => {
    const f = fixture(context);
    const sourceFailure: LocalRuntimeSourceFailure = { code: 'runtime' };
    f.native.api.setLocalExecutionConnection = async () => ({ status: 'failed', reason: 'worker_failed', sourceFailure });
    const task = sourceOffer(f);
    f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
    await flush();
    assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'worker_failed', sourceFailure }]);
    assert.equal(f.native.preparations.length, 0);
    assert.equal(f.native.starts.length, 0);
  });

  for (const path of ['sender', 'pause', 'native-event', 'early-native-event'] as const) {
    await context.test(`${path} failures preserve source details through the Main UUID and wire task mapping`, async (context) => {
      const f = fixture(context);
      const sourceFailure: LocalRuntimeSourceFailure = { code: 'recovery_failed', attempts: 37 };
      const task = sourceOffer(f);
      if (path === 'early-native-event') {
        await prepare(f);
        f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
        await flush();
        f.senders[0].connection.resolve();
        await flush();
        f.native.fail('native-detailed', 'worker_failed', sourceFailure);
        f.native.starts[0].result.resolve({
          status: 'started', taskId: 'native-detailed', result: { operation: 'youtube.stream', track },
        });
      } else {
        const sender = await startStream(f, task, 'native-detailed');
        if (path === 'sender') sender.fail('worker_failed', sourceFailure);
        else if (path === 'pause') {
          sender.setPaused = async () => { throw new LocalExecutionError('worker_failed', sourceFailure); };
          f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'pause', revision: 1 });
        } else f.native.fail('native-detailed', 'worker_failed', sourceFailure);
      }
      await flush();
      assert.deepEqual(terminals(f), [{ state: 'failed', taskId: task.taskId, reason: 'worker_failed', sourceFailure }]);
      assert.equal(f.senders[0].closeCalls, 1);
    });
  }

  for (const cancellation of ['cancelled', 'permission_revoked'] as const) {
    await context.test(`early native ${cancellation} wins over a later provider failure before start replies`, async (context) => {
      const f = fixture(context);
      await prepare(f);
      const task = sourceOffer(f);
      f.client.message(MessageType.BOT_LOCAL_TASK_OFFER, task);
      await flush();
      f.senders[0].connection.resolve();
      await flush();
      f.native.fail('native-cancelled-first', cancellation);
      f.native.fail('native-cancelled-first', 'worker_failed', { code: 'recovery_failed', attempts: 37 });
      f.native.starts[0].result.resolve({
        status: 'started', taskId: 'native-cancelled-first', result: { operation: 'youtube.stream', track },
      });
      await flush();
      assert.deepEqual(terminals(f), [{
        state: 'cancelled', taskId: task.taskId, cause: cancellation === 'permission_revoked' ? cancellation : 'requested',
      }]);
      assert.deepEqual(accepts(f), []);
    });
  }

  await context.test('explicit cancellation remains terminal when native cancellation and later provider events fail', async (context) => {
    const f = fixture(context);
    const task = sourceOffer(f);
    const sender = await startStream(f, task, 'native-cancelled');
    const sourceFailure: LocalRuntimeSourceFailure = { code: 'recovery_failed', attempts: 37 };
    f.native.api.cancelLocalExecutionTask = async () => ({ status: 'failed', reason: 'worker_failed', sourceFailure });
    f.client.message(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: task.taskId, action: 'cancel', revision: 0 });
    f.native.fail('native-cancelled', 'worker_failed', sourceFailure);
    sender.fail('worker_failed', sourceFailure);
    await flush();
    assert.deepEqual(terminals(f), [{ state: 'cancelled', taskId: task.taskId, cause: 'requested' }]);
    assert.equal(sender.closeCalls, 1);
  });
});
