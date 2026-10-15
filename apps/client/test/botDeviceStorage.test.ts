import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { BOT_STORAGE_LIMITS, type BotDeviceStorageScope } from '@monky/shared';
import { BotDeviceStorage, BotDeviceStorageError, botDeviceStorageScopeId } from '../src/main/botStorage/BotDeviceStorage';

const scope: BotDeviceStorageScope = {
  serverUrl: 'wss://monky.example/', serverId: 'server', serverName: 'Server', userId: 'user', botId: 'bot', botName: 'MonkyBot',
};

async function fixture(t: TestContext) {
  const root = path.join(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'monky-bot-storage-')), 'bot-storage');
  const changes: string[] = [];
  const storage = new BotDeviceStorage(root, (scopeId) => changes.push(scopeId));
  t.after(async () => {
    await storage.dispose();
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });
  return { root, storage, changes };
}

function reason(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof BotDeviceStorageError && error.reason === expected;
}

test('scopes are kept apart per server, account and bot, and reading never creates folders', async (t) => {
  const { root, storage, changes } = await fixture(t);
  const entry = await storage.entry(scope);
  assert.deepEqual([entry.decision, entry.usage.usedBytes, entry.usage.maxBytes], ['ask', 0, BOT_STORAGE_LIMITS.deviceDefaultBytes]);
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(await storage.list(), []);

  await storage.set(scope, 'nes/rom/slot-1', { kind: 'text', text: 'olá' });
  assert.deepEqual(changes, [botDeviceStorageScopeId(scope)]);
  assert.deepEqual((await storage.get(scope, 'nes/rom/slot-1')).value, { kind: 'text', text: 'olá' });
  for (const other of [{ userId: 'other' }, { serverId: 'other' }, { botId: 'other' }, { serverUrl: 'wss://other.example/' }]) {
    assert.equal((await storage.get({ ...scope, ...other }, 'nes/rom/slot-1')).value, null, JSON.stringify(other));
  }
  // Display names follow the bot and the server; they never pick a different folder.
  assert.equal(botDeviceStorageScopeId({ ...scope, botName: 'Renamed', serverName: 'Renamed' }), botDeviceStorageScopeId(scope));
  assert.equal(botDeviceStorageScopeId({ ...scope, serverUrl: 'WSS://MONKY.example:443/' }), botDeviceStorageScopeId(scope));
  const listed = await storage.list();
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0]!.scope.botName, listed[0]!.usage.usedBytes, listed[0]!.usage.objectCount], ['MonkyBot', 4, 1]);
});

test('bytes round trip exactly, including empty values, and listing follows the prefix', async (t) => {
  const { storage } = await fixture(t);
  await storage.set(scope, 'nes/rom/slot-2', { kind: 'bytes', bytes: new Uint8Array([0, 255, 7]) });
  await storage.set(scope, 'nes/rom/empty', { kind: 'bytes', bytes: new Uint8Array() });
  await storage.set(scope, 'doom/save', { kind: 'text', text: '' });
  assert.deepEqual((await storage.get(scope, 'nes/rom/slot-2')).value, { kind: 'bytes', bytes: new Uint8Array([0, 255, 7]) });
  assert.deepEqual((await storage.get(scope, 'nes/rom/empty')).value, { kind: 'bytes', bytes: new Uint8Array() });
  assert.deepEqual((await storage.get(scope, 'doom/save')).value, { kind: 'text', text: '' });
  assert.deepEqual((await storage.keys(scope, 'nes/')).keys.map((entry) => entry.key), ['nes/rom/empty', 'nes/rom/slot-2']);
  assert.deepEqual((await storage.remove(scope, 'doom/save')).removed, true);
  assert.deepEqual((await storage.remove(scope, 'doom/save')).removed, false);
  for (const key of ['../escape', 'a//b', '/abs', '']) {
    await assert.rejects(storage.set(scope, key, { kind: 'text', text: 'x' }), reason('invalid'), key);
  }
  await assert.rejects(storage.keys(scope, '../'), reason('invalid'));
  await assert.rejects(storage.set(scope, 'big', { kind: 'bytes', bytes: new Uint8Array(BOT_STORAGE_LIMITS.objectBytes + 1) }), reason('invalid'));
});

test('a full storage refuses writes and shows as full until space is freed; clearing keeps the preference', async (t) => {
  const { storage } = await fixture(t);
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

  await storage.setDecision(scope, 'always');
  await storage.clear(botDeviceStorageScopeId(scope));
  const cleared = await storage.entry(scope);
  assert.deepEqual([cleared.decision, cleared.usage.usedBytes, cleared.usage.objectCount, cleared.usage.maxBytes],
    ['always', 0, 0, BOT_STORAGE_LIMITS.minQuotaBytes]);
});

test('the index survives a restart, interrupted writes are discarded, and forgetting removes everything', async (t) => {
  const { root, storage } = await fixture(t);
  await storage.setDecision(scope, 'never');
  await storage.set(scope, 'kept', { kind: 'text', text: 'state' });
  const scopeId = botDeviceStorageScopeId(scope);
  const objects = path.join(root, scopeId, 'objects');
  await fs.writeFile(path.join(objects, '00000000-0000-4000-8000-000000000000.bin'), 'orphan');
  await fs.writeFile(path.join(objects, 'leftover.bin.tmp'), 'partial');

  const restarted = new BotDeviceStorage(root);
  t.after(() => restarted.dispose());
  assert.equal(await restarted.decision(scopeId), 'never');
  assert.deepEqual((await restarted.get(scope, 'kept')).value, { kind: 'text', text: 'state' });
  assert.equal((await fs.readdir(objects)).length, 1);
  await fs.writeFile(path.join(root, scopeId, 'scope.json'), '{"version":1}');
  const corrupt = new BotDeviceStorage(root);
  t.after(() => corrupt.dispose());
  await assert.rejects(corrupt.get(scope, 'kept'), reason('failed'));

  await restarted.forget(scopeId);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await restarted.decision(scopeId), 'ask');
  assert.equal(await restarted.decision('../escape'), 'never');
  await assert.rejects(restarted.forget('not-a-scope'), reason('invalid'));
});

test('a first save that stopped midway leaves nothing that could block the bot', async (t) => {
  const { root, storage } = await fixture(t);
  const scopeId = botDeviceStorageScopeId(scope);
  // What a full disk, a locked file or quitting leaves behind before the index is written.
  const unfinished = async (): Promise<void> => {
    await fs.mkdir(path.join(root, scopeId, 'objects'), { recursive: true });
    await fs.writeFile(path.join(root, scopeId, 'objects', '00000000-0000-4000-8000-000000000000.bin'), 'never stored');
    await fs.writeFile(path.join(root, scopeId, '.scope.json-00000000-0000-4000-8000-000000000001.tmp'), '{}');
  };
  await unfinished();
  assert.deepEqual(await storage.list(), [], 'An unfinished folder is not stored data');
  assert.deepEqual(await fs.readdir(root), [], 'Listing removes it');
  await unfinished();
  const entry = await storage.entry(scope);
  assert.deepEqual([entry.decision, entry.usage.objectCount], ['ask', 0]);
  assert.deepEqual(await fs.readdir(root), [], 'Reading the scope removes it too');
  await storage.setDecision(scope, 'always');
  await storage.set(scope, 'nes/rom/auto', { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) });

  // An interrupted index replacement only leaves a staging file, removed when the scope is read again.
  await fs.writeFile(path.join(root, scopeId, '.scope.json-00000000-0000-4000-8000-000000000002.tmp'), '{}');
  const restarted = new BotDeviceStorage(root);
  t.after(() => restarted.dispose());
  assert.equal(await restarted.decision(scopeId), 'always');
  assert.deepEqual((await restarted.get(scope, 'nes/rom/auto')).value, { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual((await fs.readdir(path.join(root, scopeId))).sort(), ['objects', 'scope.json']);
});
