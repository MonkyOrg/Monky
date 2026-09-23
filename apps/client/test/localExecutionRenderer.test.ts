import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIMITS, type LocalConnectionState, type LocalExecutionSnapshot, type LocalPreparationInput,
  type LocalPreparationResult, type LocalRuntimeSourceFailure, type LocalTaskFailureEvent,
} from '@monky/shared';
import { LocalExecutionController, localExecutionFor } from '../src/renderer/core/LocalExecutionController';
import { LocalPreviewStore } from '../src/renderer/core/LocalPreviewStore';
import {
  LocalExecutionError, observeWithSignal, requireLocalMutation, toLocalExecutionError, type LocalExecutionApi,
} from '../src/renderer/core/localExecutionSupport';
import { NetworkClient, type ConnectionStatus } from '../src/renderer/core/NetworkClient';
import { createServerStore } from '../src/renderer/stores/serverStore';
import { EventBus } from '../src/renderer/core/EventBus';

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function deferred<T>() {
  const callbacks: { resolve?: (value: T) => void; reject?: (error: Error) => void } = {};
  const promise = new Promise<T>((resolve, reject) => { callbacks.resolve = resolve; callbacks.reject = reject; });
  return {
    promise,
    resolve(value: T) { assert.ok(callbacks.resolve); callbacks.resolve(value); },
    reject(error: Error) { assert.ok(callbacks.reject); callbacks.reject(error); },
  };
}

class Client extends NetworkClient {
  public currentStatus: ConnectionStatus = 'CONNECTED';
  public wireId = 'connection-a';
  public origin = 'wss://server.example.invalid';
  public observers = new Set<(event: string, data: unknown) => void>();
  public override getStatus(): ConnectionStatus { return this.currentStatus; }
  public override getConnectionId(): string { return this.wireId; }
  public override getCurrentServerUrl(): string { return this.origin; }
  public override onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }
  public emit(event: string, data?: unknown): void {
    for (const listener of this.observers) listener(event, data);
  }
}

const bot = { botId: 'bot-a', botName: 'Same name', botPublicKey: 'a'.repeat(64) };
const permit = '1'.repeat(64);

function fixture(apiEnabled = true) {
  const client = new Client();
  const server = createServerStore();
  server.bus = new EventBus();
  server.setServerDetails({
    id: 'server-a', name: 'Server', createdAt: 1, maxUsers: 10, hasPassword: false,
    channels: [], members: [], voiceStates: {}, roles: [], userRoles: [],
  }, { id: 'user-a', clientId: 'client-a', sessionId: 'physical-session-a', nickname: 'User', status: 'ONLINE', joinedAt: 1 });
  const connections: LocalConnectionState[] = [];
  const preparations: Array<{ input: LocalPreparationInput; result: ReturnType<typeof deferred<LocalPreparationResult>> }> = [];
  const cancelled: string[] = [];
  const changes = new Set<(snapshot: LocalExecutionSnapshot) => void>();
  const failures = new Set<(failure: LocalTaskFailureEvent) => void>();
  let voice: string | null = null;
  const api: LocalExecutionApi = {
    setLocalExecutionConnection: async (state) => { connections.push(state); return { status: 'completed' }; },
    prepareLocalExecution: (input) => {
      const result = deferred<LocalPreparationResult>();
      preparations.push({ input, result });
      return result.promise;
    },
    cancelLocalExecutionRequest: async ({ requestId }) => { cancelled.push(requestId); return { status: 'completed' }; },
    startLocalExecutionTask: async () => { throw new Error('Unexpected native task in preparation fixture'); },
    readLocalExecutionFrames: async () => { throw new Error('Unexpected audio read in preparation fixture'); },
    acknowledgeLocalExecutionFrames: async () => { throw new Error('Unexpected playback ACK in preparation fixture'); },
    setLocalExecutionPaused: async () => { throw new Error('Unexpected audio pause in preparation fixture'); },
    cancelLocalExecutionTask: async () => { throw new Error('Unexpected native task cancellation in preparation fixture'); },
    onLocalExecutionChanged: (callback) => { changes.add(callback); return () => { changes.delete(callback); }; },
    onLocalExecutionTaskFailed: (callback) => { failures.add(callback); return () => { failures.delete(callback); }; },
  };
  const controller = new LocalExecutionController(client, server, () => voice, apiEnabled ? api : null);
  return {
    client, server, controller, api, connections, preparations, cancelled, changes, failures,
    voice(channel: string | null) { voice = channel; controller.syncVoiceContext(); },
  };
}

test('native preparation is coalesced by exact bot key and physical connection, not by a display name', async (context) => {
  const f = fixture();
  context.after(() => f.controller.dispose());
  const firstOwner = new AbortController();
  const secondOwner = new AbortController();
  const first = f.controller.prepare(bot, 'youtube-audio', firstOwner.signal);
  const second = f.controller.prepare(bot, 'youtube-audio', secondOwner.signal);
  await flush();
  assert.equal(f.preparations.length, 1);
  assert.equal(f.preparations[0].input.subject.connectionId, 'connection-a');
  assert.equal(f.preparations[0].input.subject.botPublicKey, bot.botPublicKey);
  assert.deepEqual(f.connections, [{ connectionId: 'connection-a', connected: true, voiceChannelId: null }]);
  f.preparations[0].result.resolve({ status: 'prepared', permit });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal((await f.controller.prepare(bot, 'youtube-audio', firstOwner.signal)).permit, permit);
  assert.equal(f.preparations.length, 1);
  const changedKey = f.controller.prepare({ ...bot, botPublicKey: 'b'.repeat(64) }, 'youtube-audio', firstOwner.signal);
  await flush();
  assert.equal(f.preparations.length, 2, 'an equal bot name is not another public key authorization');
  f.preparations[1].result.resolve({ status: 'cancelled' });
  await assert.rejects(changedKey, (error: unknown) => error instanceof LocalExecutionError && error.reason === 'cancelled');
  firstOwner.abort();
  secondOwner.abort();
  assert.equal(f.cancelled.length, 0, 'finished native preparations are not cancelled again');
});

test('typing cancels a query observer, not its composer installation; closing the last composer cancels Main', async (context) => {
  const f = fixture();
  context.after(() => f.controller.dispose());
  const composer = new AbortController();
  const query = new AbortController();
  const shared = f.controller.prepare(bot, 'youtube-audio', composer.signal);
  const observed = observeWithSignal(shared, query.signal);
  const cancelledQuery = assert.rejects(observed, { name: 'AbortError' });
  query.abort();
  await cancelledQuery;
  await flush();
  assert.equal(f.preparations.length, 1);
  assert.deepEqual(f.cancelled, []);
  const next = f.controller.prepare(bot, 'youtube-audio', composer.signal);
  const firstCancelled = assert.rejects(shared, { name: 'AbortError' });
  const secondCancelled = assert.rejects(next, { name: 'AbortError' });
  composer.abort();
  await Promise.all([firstCancelled, secondCancelled]);
  assert.deepEqual(f.cancelled, [f.preparations[0].input.requestId]);
  f.preparations[0].result.resolve({ status: 'prepared', permit });
  await flush();
  const reopened = new AbortController();
  const retry = f.controller.prepare(bot, 'youtube-audio', reopened.signal);
  await flush();
  assert.equal(f.preparations.length, 2, 'a cancelled late permit is never cached for the reopened composer');
  f.preparations[1].result.resolve({ status: 'prepared', permit: '2'.repeat(64) });
  assert.equal((await retry).permit, '2'.repeat(64));
  reopened.abort();
});

test('one composer closing cannot cancel another owner of the same native preparation', async (context) => {
  const f = fixture();
  context.after(() => f.controller.dispose());
  const first = new AbortController();
  const second = new AbortController();
  const a = f.controller.prepare(bot, 'youtube-audio', first.signal);
  const b = f.controller.prepare(bot, 'youtube-audio', second.signal);
  const cancelled = assert.rejects(a, { name: 'AbortError' });
  first.abort();
  await cancelled;
  await flush();
  assert.equal(f.cancelled.length, 0);
  f.preparations[0].result.resolve({ status: 'prepared', permit });
  assert.equal((await b).permit, permit);
  second.abort();
});

test('an already-cancelled observer still consumes a later rejection of its underlying operation', async () => {
  const operation = deferred<string>();
  const owner = new AbortController();
  owner.abort();
  await assert.rejects(observeWithSignal(operation.promise, owner.signal), { name: 'AbortError' });
  operation.reject(new Error('Underlying operation failed after cancellation'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

for (const failure of ['failed', 'cancelled', 'rejected'] as const) {
  test(`${failure} native connection synchronization can retry when the composer is reopened`, async (context) => {
    const f = fixture();
    context.after(() => f.controller.dispose());
    const synchronize = f.api.setLocalExecutionConnection;
    let fail = true;
    f.api.setLocalExecutionConnection = async (state) => {
      if (!fail) return synchronize(state);
      f.connections.push(state);
      if (failure === 'rejected') throw new Error('Native connection IPC unavailable');
      return failure === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', reason: 'transport_failed' };
    };
    const first = new AbortController();
    await assert.rejects(f.controller.prepare(bot, 'youtube-audio', first.signal),
      (error: unknown) => error instanceof LocalExecutionError &&
        error.reason === (failure === 'cancelled' ? 'cancelled' : 'transport_failed'));
    assert.equal(f.preparations.length, 0, 'A failed connection update must not prepare native work');
    first.abort();
    fail = false;
    const reopened = new AbortController();
    const retry = f.controller.prepare(bot, 'youtube-audio', reopened.signal);
    await flush();
    assert.equal(f.connections.length, 2, 'A failed update must not remain cached as synchronized');
    assert.equal(f.preparations.length, 1);
    f.preparations[0].result.resolve({ status: 'prepared', permit });
    assert.equal((await retry).permit, permit);
    reopened.abort();
  });
}

test('entering RECONNECTING invalidates preparation immediately and rejects a late permit from the old socket', async (context) => {
  const f = fixture();
  context.after(() => f.controller.dispose());
  const owner = new AbortController();
  const old = f.controller.prepare(bot, 'youtube-audio', owner.signal);
  const cancelled = assert.rejects(old, (error: unknown) => error instanceof LocalExecutionError && error.reason === 'cancelled');
  await flush();
  f.client.currentStatus = 'RECONNECTING';
  f.client.emit('network.status', 'RECONNECTING');
  await cancelled;
  assert.equal(f.cancelled.length, 1);
  await flush();
  assert.equal(f.connections.at(-1)?.connected, false);
  assert.equal(f.connections.at(-1)?.connectionId, 'connection-a');
  f.client.wireId = 'connection-b';
  f.client.currentStatus = 'CONNECTED';
  f.client.emit('network.connected');
  const current = f.controller.prepare(bot, 'youtube-audio', owner.signal);
  await flush();
  f.preparations[0].result.resolve({ status: 'prepared', permit });
  f.preparations[1].result.resolve({ status: 'prepared', permit: '2'.repeat(64) });
  assert.equal((await current).subject.connectionId, 'connection-b');
  assert.equal((await f.controller.prepare(bot, 'youtube-audio', owner.signal)).permit, '2'.repeat(64));
  owner.abort();
});

test('voice changes synchronize only this physical connection and do not revoke future metadata permission', async (context) => {
  const f = fixture();
  context.after(() => f.controller.dispose());
  const owner = new AbortController();
  const result = f.controller.prepare(bot, 'youtube-audio', owner.signal);
  await flush();
  f.preparations[0].result.resolve({ status: 'prepared', permit });
  await result;
  f.voice('room-a');
  f.voice(null);
  f.voice('room-b');
  await flush();
  assert.deepEqual(f.connections.map((state) => state.voiceChannelId), [null, 'room-a', null, 'room-b']);
  assert.equal((await f.controller.prepare(bot, 'youtube-audio', owner.signal)).permit, permit);
  assert.equal(f.preparations.length, 1);
  owner.abort();
});

test('unsupported native bridge fails explicitly without any network or installation fallback', async (context) => {
  const f = fixture(false);
  context.after(() => f.controller.dispose());
  await assert.rejects(f.controller.prepare(bot, 'youtube-audio', new AbortController().signal),
    (error: unknown) => error instanceof LocalExecutionError && error.reason === 'executor_unavailable');
  assert.equal(f.preparations.length, 0);
  assert.equal(f.connections.length, 0);
});

test('native rejection stays localized and cached for one composer instead of prompting on every keystroke', async (context) => {
  const f = fixture();
  context.after(() => f.controller.dispose());
  const owner = new AbortController();
  const denied = f.controller.prepare(bot, 'youtube-audio', owner.signal);
  const check = assert.rejects(denied, (error: unknown) => error instanceof LocalExecutionError && error.reason === 'transport_failed'
    && !error.message.includes('private'));
  await flush();
  f.preparations[0].result.reject(new Error('private native executable path'));
  await check;
  await assert.rejects(f.controller.prepare(bot, 'youtube-audio', owner.signal), LocalExecutionError);
  assert.equal(f.preparations.length, 1);
  owner.abort();
});

test('native permission removal invalidates a cached permit and controller disposal removes observers', async () => {
  const f = fixture();
  const owner = new AbortController();
  const result = f.controller.prepare(bot, 'youtube-audio', owner.signal);
  await flush();
  f.preparations[0].result.resolve({ status: 'prepared', permit });
  await result;
  for (const change of f.changes) change({ supported: true, tools: [], permissions: [], tasks: [], toolsBytes: 0, cacheBytes: 0 });
  const fresh = f.controller.prepare(bot, 'youtube-audio', owner.signal);
  await flush();
  assert.equal(f.preparations.length, 2);
  f.preparations[1].result.resolve({ status: 'prepared', permit: '3'.repeat(64) });
  await fresh;
  owner.abort();
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(f.client.observers.size, 0);
  assert.equal(f.changes.size, 0);
  assert.throws(() => localExecutionFor(f.client), LocalExecutionError);
});

test('preview handles are single-use and isolated by request, task, bot key and physical connection', () => {
  const store = new LocalPreviewStore();
  const context = { connectionId: 'connection-a', botId: 'bot-a', botPublicKey: 'a'.repeat(64), requestId: 'preview-a' };
  const preview = { operation: 'youtube.preview', mimeType: 'audio/ogg', audioBase64: 'T2dnUw==' };
  const id = store.put(context, 'task-a', preview);
  for (const wrong of [
    { ...context, connectionId: 'connection-b' }, { ...context, botId: 'bot-b' },
    { ...context, botPublicKey: 'b'.repeat(64) }, { ...context, requestId: 'preview-b' },
  ]) assert.throws(() => store.take(id, wrong, 'task-a'), LocalExecutionError);
  assert.throws(() => store.take(id, context, 'other-task'), LocalExecutionError);
  assert.equal(store.take(id, context, 'task-a').audioBase64, preview.audioBase64);
  assert.throws(() => store.take(id, context, 'task-a'), LocalExecutionError);
  const cancelled = store.put(context, 'task-b', preview);
  store.releaseTask('task-b');
  assert.throws(() => store.take(cancelled, context, 'task-b'), LocalExecutionError);
  const closed = store.put(context, 'task-c', preview);
  store.releaseRequest(context);
  assert.throws(() => store.take(closed, context, 'task-c'), LocalExecutionError);
  store.clear();
});

test('preview storage has a short TTL, bounded byte/count limits, and clears its expiry timer', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const store = new LocalPreviewStore();
  const owner = { connectionId: 'connection-a', botId: 'bot-a', botPublicKey: 'a'.repeat(64), requestId: 'preview-a' };
  const preview = { operation: 'youtube.preview', mimeType: 'audio/ogg', audioBase64: 'T2dnUw==' };
  const id = store.put(owner, 'task-a', preview);
  for (let index = 1; index < LIMITS.MAX_BOT_AUDIO_PREVIEW_HANDLERS; index++) store.put(owner, `task-${index}`, preview);
  assert.throws(() => store.put(owner, 'overflow', preview), (error: unknown) => error instanceof LocalExecutionError && error.reason === 'busy');
  context.mock.timers.tick(LIMITS.BOT_AUDIO_PREVIEW_TIMEOUT_MS + 1);
  assert.throws(() => store.take(id, owner, 'task-a'), LocalExecutionError);
  assert.throws(() => store.put(owner, 'oversized', { ...preview, audioBase64: 'AAAA'.repeat(LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES) }), LocalExecutionError);
  const final = store.put(owner, 'last', preview);
  store.clear();
  assert.throws(() => store.take(final, owner, 'last'), LocalExecutionError);
  context.mock.timers.runAll();
});

test('renderer errors preserve validated source details without changing localized UI reasons', () => {
  const sourceFailure: LocalRuntimeSourceFailure = { code: 'recovery_failed', attempts: 37 };
  const error = new LocalExecutionError('worker_failed', sourceFailure);
  sourceFailure.attempts = 99;
  assert.deepEqual(error.sourceFailure, { code: 'recovery_failed', attempts: 37 });
  assert.equal(error.reason, 'worker_failed');
  assert.equal(toLocalExecutionError(error), error);
  assert.throws(() => requireLocalMutation({
    status: 'failed', reason: 'provider_unavailable', sourceFailure: { code: 'unavailable' },
  }), (failure: unknown) => failure instanceof LocalExecutionError && failure.reason === 'provider_unavailable'
    && failure.sourceFailure?.code === 'unavailable');
  assert.equal(toLocalExecutionError(new Error('private provider stderr')).sourceFailure, undefined);
  assert.equal(toLocalExecutionError(new Error('private provider stderr')).message.includes('private provider'), false);
});

test('invalid source counts or extra fields fail validation rather than being clamped, relayed or displayed', () => {
  const invalid: Array<LocalRuntimeSourceFailure & { raw?: string }> = [
    { code: 'recovery_failed', attempts: 0 }, { code: 'recovery_failed', attempts: 101 },
    { code: 'recovery_failed', attempts: 1.5 }, { code: 'recovery_failed', attempts: Number.NaN },
    { code: 'runtime', raw: 'private provider stderr' },
  ];
  for (const sourceFailure of invalid) {
    const error = new LocalExecutionError('worker_failed', sourceFailure);
    assert.equal(error.reason, 'invalid_request');
    assert.equal(error.sourceFailure, undefined);
    assert.equal(error.message.includes('private provider'), false);
    for (const reason of ['cancelled', 'permission_revoked'] as const) {
      const cancellation = new LocalExecutionError(reason, sourceFailure);
      assert.equal(cancellation.reason, reason);
      assert.equal(cancellation.sourceFailure, undefined, 'Cancellation is not replaced by a provider validation failure');
    }
  }
});
