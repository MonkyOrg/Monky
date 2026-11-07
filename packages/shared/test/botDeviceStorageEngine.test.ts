import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  BOT_STORAGE_LIMITS, type BotDeviceStorageFile, type BotDeviceStorageScope,
} from '../src/botStorage.js';
import {
  BotDeviceStorageEngine, BotDeviceStorageError, BotScreenStorageRateLimit, answerBotScreenStorageRequest,
  bindBotScreenStorage, botDeviceStorageScopeIdentity, botScreenStorageState, type BotDeviceStorageBackend,
} from '../src/botDeviceStorageEngine.js';

/** The same rules over a map, as the desktop does over files and the web over IndexedDB. */
class MemoryBackend implements BotDeviceStorageBackend {
  readonly indexes = new Map<string, unknown>();
  readonly objects = new Map<string, Map<string, Uint8Array>>();
  failIndexWrites = false;

  scopeId(identity: string): string { return createHash('sha256').update(identity).digest('hex'); }
  randomId(): string { return randomUUID(); }
  async initialize(): Promise<void> {}
  async scopes(): Promise<string[]> { return [...new Set([...this.indexes.keys(), ...this.objects.keys()])]; }
  async hasScope(scopeId: string): Promise<boolean> { return this.indexes.has(scopeId) || this.objects.has(scopeId); }
  async readIndex(scopeId: string): Promise<unknown> {
    if (this.indexes.has(scopeId)) return structuredClone(this.indexes.get(scopeId));
    this.objects.delete(scopeId);
    return null;
  }
  async writeIndex(scopeId: string, index: BotDeviceStorageFile): Promise<void> {
    if (this.failIndexWrites) throw new Error('disk full');
    this.indexes.set(scopeId, structuredClone(index));
  }
  async removeUnreferenced(scopeId: string, referenced: ReadonlySet<string>): Promise<void> {
    for (const file of this.objects.get(scopeId)?.keys() ?? []) if (!referenced.has(file)) this.objects.get(scopeId)?.delete(file);
  }
  async writeObject(scopeId: string, file: string, bytes: Uint8Array): Promise<void> {
    const files = this.objects.get(scopeId) ?? new Map<string, Uint8Array>();
    files.set(file, bytes.slice());
    this.objects.set(scopeId, files);
  }
  async readObject(scopeId: string, file: string): Promise<Uint8Array> {
    const bytes = this.objects.get(scopeId)?.get(file);
    if (!bytes) throw new Error('missing');
    return bytes.slice();
  }
  async removeObject(scopeId: string, file: string): Promise<void> { this.objects.get(scopeId)?.delete(file); }
  async removeScope(scopeId: string): Promise<void> {
    this.indexes.delete(scopeId);
    this.objects.delete(scopeId);
  }
}

const scope: BotDeviceStorageScope = {
  serverUrl: 'wss://monky.example/', serverId: 'server', serverName: 'Server', userId: 'user', botId: 'bot', botName: 'MonkyBot',
};

function fixture() {
  const backend = new MemoryBackend();
  const changes: string[] = [];
  const storage = new BotDeviceStorageEngine(backend, (scopeId) => changes.push(scopeId));
  return { backend, storage, changes, scopeId: storage.scopeId(scope) };
}

function reason(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof BotDeviceStorageError && error.reason === expected;
}

test('scope ids follow server address, server, account and bot, never display names', () => {
  const { storage, scopeId } = fixture();
  assert.match(scopeId, /^[a-f0-9]{64}$/);
  assert.equal(storage.scopeId({ ...scope, botName: 'Renamed', serverName: 'Renamed' }), scopeId);
  assert.equal(storage.scopeId({ ...scope, serverUrl: 'WSS://MONKY.example:443/' }), scopeId);
  assert.equal(botDeviceStorageScopeIdentity(scope), JSON.stringify(['wss://monky.example', '/', 'server', 'user', 'bot']));
  for (const other of [{ userId: 'other' }, { serverId: 'other' }, { botId: 'other' }, { serverUrl: 'wss://other.example/' }]) {
    assert.notEqual(storage.scopeId({ ...scope, ...other }), scopeId, JSON.stringify(other));
  }
  assert.throws(() => storage.scopeId({ ...scope, serverUrl: 'not a url' }), reason('invalid'));
});

test('reading never stores anything; the decision starts as "ask" and is remembered', async () => {
  const { backend, storage, changes, scopeId } = fixture();
  assert.equal(await storage.decision(scopeId), 'ask');
  assert.equal((await storage.get(scope, 'missing')).value, null);
  assert.deepEqual(await storage.list(), []);
  assert.equal(backend.indexes.size, 0);
  await storage.setDecision(scope, 'never');
  assert.equal(await storage.decision(scopeId), 'never');
  assert.deepEqual(changes, [scopeId]);
  assert.equal(await storage.decision('../escape'), 'never');
  const restarted = new BotDeviceStorageEngine(backend);
  assert.equal(await restarted.decision(scopeId), 'never');
});

test('values round trip; keys are validated and listed by prefix', async () => {
  const { storage } = fixture();
  await storage.set(scope, 'nes/rom/slot-1', { kind: 'bytes', bytes: new Uint8Array([0, 255, 7]) });
  await storage.set(scope, 'nes/rom/empty', { kind: 'bytes', bytes: new Uint8Array() });
  await storage.set(scope, 'doom/save', { kind: 'text', text: 'olá' });
  assert.deepEqual((await storage.get(scope, 'nes/rom/slot-1')).value, { kind: 'bytes', bytes: new Uint8Array([0, 255, 7]) });
  assert.deepEqual((await storage.get(scope, 'nes/rom/empty')).value, { kind: 'bytes', bytes: new Uint8Array() });
  assert.deepEqual((await storage.get(scope, 'doom/save')).value, { kind: 'text', text: 'olá' });
  assert.deepEqual((await storage.keys(scope, 'nes/')).keys.map((entry) => entry.key), ['nes/rom/empty', 'nes/rom/slot-1']);
  assert.equal((await storage.remove(scope, 'doom/save')).removed, true);
  assert.equal((await storage.remove(scope, 'doom/save')).removed, false);
  for (const key of ['../escape', 'a//b', '/abs', '']) {
    await assert.rejects(storage.set(scope, key, { kind: 'text', text: 'x' }), reason('invalid'), key);
  }
  await assert.rejects(storage.set(scope, 'big', { kind: 'bytes', bytes: new Uint8Array(BOT_STORAGE_LIMITS.objectBytes + 1) }), reason('invalid'));
});

test('the quota refuses writes without evicting, and the storage shows as full until space is freed', async () => {
  const { storage } = fixture();
  await storage.setQuota(scope, BOT_STORAGE_LIMITS.minQuotaBytes);
  await storage.set(scope, 'a', { kind: 'bytes', bytes: new Uint8Array(600 * 1024) });
  await storage.set(scope, 'b', { kind: 'bytes', bytes: new Uint8Array(340 * 1024) });
  assert.equal((await storage.usage(scope)).level, 'near_full');
  await assert.rejects(storage.set(scope, 'c', { kind: 'bytes', bytes: new Uint8Array(100 * 1024) }), reason('quota'));
  assert.equal((await storage.usage(scope)).level, 'full');
  assert.ok((await storage.get(scope, 'a')).value, 'Nothing is evicted to make room');
  await storage.set(scope, 'a', { kind: 'bytes', bytes: new Uint8Array(100 * 1024) });
  assert.equal((await storage.usage(scope)).level, 'ok');
  await assert.rejects(storage.setQuota(scope, BOT_STORAGE_LIMITS.minQuotaBytes - 1), reason('invalid'));
});

test('clearing keeps the preference and the quota; forgetting removes everything', async () => {
  const { backend, storage, scopeId } = fixture();
  await storage.setQuota(scope, BOT_STORAGE_LIMITS.minQuotaBytes);
  await storage.setDecision(scope, 'always');
  await storage.set(scope, 'kept', { kind: 'text', text: 'state' });
  await storage.clear(scopeId);
  const cleared = await storage.entry(scope);
  assert.deepEqual([cleared.decision, cleared.usage.usedBytes, cleared.usage.objectCount, cleared.usage.maxBytes],
    ['always', 0, 0, BOT_STORAGE_LIMITS.minQuotaBytes]);
  assert.equal(backend.objects.get(scopeId)?.size ?? 0, 0);

  await storage.set(scope, 'kept', { kind: 'text', text: 'state' });
  await storage.forget(scopeId);
  assert.equal(await backend.hasScope(scopeId), false);
  assert.equal(await storage.decision(scopeId), 'ask');
  assert.deepEqual(await storage.list(), []);
  await assert.rejects(storage.forget('not-a-scope'), reason('invalid'));
  await assert.rejects(storage.clear('not-a-scope'), reason('invalid'));
});

test('a failed index write keeps the previous state and leaves no orphan object', async () => {
  const { backend, storage, scopeId } = fixture();
  await storage.set(scope, 'kept', { kind: 'text', text: 'old' });
  backend.failIndexWrites = true;
  await assert.rejects(storage.set(scope, 'kept', { kind: 'text', text: 'new' }), reason('failed'));
  backend.failIndexWrites = false;
  assert.equal(backend.objects.get(scopeId)?.size, 1);
  assert.deepEqual((await new BotDeviceStorageEngine(backend).get(scope, 'kept')).value, { kind: 'text', text: 'old' });
});

test('unfinished first saves, orphans and corrupt indexes are handled when read', async () => {
  const { backend, storage, scopeId } = fixture();
  await backend.writeObject(scopeId, `${randomUUID()}.bin`, new Uint8Array([1]));
  assert.deepEqual(await storage.list(), []);
  assert.equal(await backend.hasScope(scopeId), false, 'An unfinished scope is removed');

  await storage.set(scope, 'kept', { kind: 'text', text: 'state' });
  await backend.writeObject(scopeId, `${randomUUID()}.bin`, new Uint8Array([2]));
  const restarted = new BotDeviceStorageEngine(backend);
  assert.deepEqual((await restarted.get(scope, 'kept')).value, { kind: 'text', text: 'state' });
  assert.equal(backend.objects.get(scopeId)?.size, 1, 'The orphan is removed');

  backend.indexes.set(scopeId, { version: 1 });
  await assert.rejects(new BotDeviceStorageEngine(backend).get(scope, 'kept'), reason('failed'));
});

test('one device keeps a bounded number of bot scopes', async () => {
  const { backend, storage } = fixture();
  for (let index = 0; index < BOT_STORAGE_LIMITS.deviceScopes; index++) {
    backend.indexes.set(createHash('sha256').update(String(index)).digest('hex'), {});
  }
  await assert.rejects(storage.setDecision(scope, 'always'), reason('quota'));
});

test('miniapp documents reach storage only while the person allows it', async () => {
  const { storage, scopeId } = fixture();
  assert.deepEqual(await botScreenStorageState(storage, null), { status: 'unavailable', scopeId: null, usage: null });
  assert.deepEqual(await answerBotScreenStorageRequest(storage, null, { op: 'usage' }), { ok: false, reason: 'unavailable', usage: null });

  const session = await bindBotScreenStorage(storage, { scope, grant: 'session' });
  assert.deepEqual([session.scopeId, session.session], [scopeId, true]);
  assert.equal(await storage.decision(scopeId), 'ask', '"Only this session" is not remembered');
  assert.equal((await botScreenStorageState(storage, session)).status, 'granted');
  const saved = await answerBotScreenStorageRequest(storage, session, { op: 'set', key: 'slot', value: { kind: 'text', text: 'x' }, autosave: false });
  assert.equal(saved.ok, true);
  assert.deepEqual(await answerBotScreenStorageRequest(storage, session, { op: 'get', key: '../x' }), { ok: false, reason: 'invalid', usage: null });

  // A later "never" in the bot settings wins over the open document.
  await storage.setDecision(scope, 'never');
  assert.equal((await botScreenStorageState(storage, session)).status, 'denied');
  assert.deepEqual(await answerBotScreenStorageRequest(storage, session, { op: 'get', key: 'slot' }), { ok: false, reason: 'denied', usage: null });
  const always = await bindBotScreenStorage(storage, { scope, grant: 'always' });
  assert.equal(await storage.decision(scopeId), 'never', '"Always" never overrides a "never"');
  assert.equal((await botScreenStorageState(storage, always)).status, 'denied');

  await storage.setDecision(scope, 'ask');
  const remembered = await bindBotScreenStorage(storage, { scope, grant: 'always' });
  assert.equal(await storage.decision(scopeId), 'always');
  assert.equal(remembered.session, false);
  const read = await answerBotScreenStorageRequest(storage, remembered, { op: 'get', key: 'slot' });
  assert.deepEqual(read.ok && read.op === 'get' ? read.value : null, { kind: 'text', text: 'x' });

  await storage.setQuota(scope, BOT_STORAGE_LIMITS.minQuotaBytes);
  const full = await answerBotScreenStorageRequest(storage, remembered,
    { op: 'set', key: 'big', value: { kind: 'bytes', bytes: new Uint8Array(BOT_STORAGE_LIMITS.minQuotaBytes) }, autosave: false });
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.reason, 'quota');
  assert.equal(full.usage?.level, 'full');
});

test('the rate limit counts per document and second', () => {
  let now = 0;
  const rates = new BotScreenStorageRateLimit(() => now);
  for (let index = 0; index < BOT_STORAGE_LIMITS.operationsPerSecond; index++) assert.equal(rates.allow('a'), true);
  assert.equal(rates.allow('a'), false);
  assert.equal(rates.allow('b'), true, 'Another document has its own budget');
  now = 1000;
  assert.equal(rates.allow('a'), true);
});

test('a request over the rate limit fails before reaching the storage', async () => {
  const { storage } = fixture();
  const binding = await bindBotScreenStorage(storage, { scope, grant: 'session' });
  assert.deepEqual(await answerBotScreenStorageRequest(storage, binding, { op: 'usage' }, () => false), { ok: false, reason: 'failed', usage: null });
  assert.deepEqual(await answerBotScreenStorageRequest(storage, binding, { op: 'nope' }, () => false), { ok: false, reason: 'invalid', usage: null });
});

test('a disposed engine waits for what runs and refuses what comes after', async () => {
  const { storage } = fixture();
  const pending = storage.set(scope, 'kept', { kind: 'text', text: 'state' });
  await storage.dispose();
  await pending;
  await assert.rejects(storage.get(scope, 'kept'), reason('unavailable'));
});
