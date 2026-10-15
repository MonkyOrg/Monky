import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  BOT_MANIFEST_FEATURES_HEADER, BOT_STORAGE_LIMITS, MessageType, PROTOCOL_FEATURES, ProtocolErrorCode, botInstallPreviewSchema,
  botPermissionsSnapshotSchema, botSettingsListResponseSchema, botStorageGetResultSchema, botStorageInfoSchema,
  botStorageLevelEventSchema, botStorageListResultSchema, botStorageObjectInfoSchema, botStorageUsageSchema, type BotCapability,
} from '@monky/shared';
import { BotStorageFileStore } from './infrastructure/security/BotStorageFileStore';
import { botMessageCapabilities } from './infrastructure/websocket/botCapabilityPolicy';
import { createFixture, identity, record, text } from './testFixtures/bots';

const KIB = 1024;

async function fixture(t: TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Storage owner');
  const member = await f.human('Storage member');
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  assert.equal(created.type, MessageType.BOT_CREATED);
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  const keys = identity();
  const connectBot = () => f.bot(token, keys);
  const declare = async (requestedCapabilities: BotCapability[]) => {
    const bot = await connectBot();
    const registered = await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities, commands: [] });
    assert.equal(registered.type, MessageType.COMMAND_REGISTERED, JSON.stringify(registered.payload));
    return bot;
  };
  const approve = async (granted: BotCapability[]) => {
    const state = f.botPermissions.get(botId);
    assert.ok(state);
    const response = await owner.peer.request(MessageType.BOT_PERMISSIONS_UPDATE, { botId, expectedRevision: state.revision, granted });
    assert.equal(response.type, MessageType.BOT_PERMISSIONS_SNAPSHOT, JSON.stringify(response.payload));
  };
  /** Approving closes the bot's socket, so the bot comes back with the new grants. */
  const approved = async (granted: BotCapability[]) => {
    const declared = await declare(['commands', ...granted]);
    const closed = once(declared.peer.ws, 'close');
    await approve(['commands', ...granted]);
    await closed;
    return connectBot();
  };
  const info = async (peer = owner.peer) => {
    const response = await peer.request(MessageType.BOT_STORAGE_INFO_GET, { botId });
    assert.equal(response.type, MessageType.BOT_STORAGE_INFO, JSON.stringify(response.payload));
    return botStorageInfoSchema.parse(response.payload);
  };
  /** Only people who manage bots get the server part. */
  const serverInfo = async (peer = owner.peer) => {
    const { server } = await info(peer);
    assert.ok(server, 'People who manage bots see the server storage');
    return server;
  };
  return { ...f, owner, member, botId, token, connectBot, declare, approve, approved, info, serverInfo };
}

function data(size: number, fill = 7): string {
  return Buffer.alloc(size, fill).toString('base64');
}

test('storage operations are bot-only and require the approved server_storage grant', async (t) => {
  for (const type of [MessageType.BOT_STORAGE_PUT, MessageType.BOT_STORAGE_GET, MessageType.BOT_STORAGE_DELETE,
    MessageType.BOT_STORAGE_LIST, MessageType.BOT_STORAGE_USAGE]) {
    assert.deepEqual(botMessageCapabilities(type, {}), ['server_storage']);
  }
  for (const type of [MessageType.BOT_STORAGE_INFO_GET, MessageType.BOT_STORAGE_LIMIT_UPDATE, MessageType.BOT_STORAGE_CLEAR]) {
    assert.equal(botMessageCapabilities(type, {}), undefined);
  }
  const f = await fixture(t);
  const pending = await f.declare(['commands', 'server_storage']);
  await pending.peer.error(MessageType.BOT_STORAGE_PUT, { key: 'save', data: data(4) }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  await pending.peer.close();
  const bot = await f.approved(['server_storage']);
  for (const type of [MessageType.BOT_STORAGE_INFO_GET, MessageType.BOT_STORAGE_LIMIT_UPDATE, MessageType.BOT_STORAGE_CLEAR]) {
    await bot.peer.error(type, { botId: f.botId }, ProtocolErrorCode.PERMISSION_DENIED);
  }
  await f.member.peer.error(MessageType.BOT_STORAGE_PUT, { key: 'save', data: data(4) }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.BOT_STORAGE_PUT, { key: '../escape', data: data(4) }, ProtocolErrorCode.BAD_REQUEST);
  await bot.peer.error(MessageType.BOT_STORAGE_GET, { key: 'a//b' }, ProtocolErrorCode.BAD_REQUEST);
  await bot.peer.error(MessageType.BOT_STORAGE_PUT, { key: 'save', data: 'not base64' }, ProtocolErrorCode.BAD_REQUEST);

  const saved = await bot.peer.request(MessageType.BOT_STORAGE_PUT, {
    key: 'nes/rom/slot-1', data: Buffer.from('state one').toString('base64'), contentType: 'application/octet-stream',
  });
  assert.equal(saved.type, MessageType.BOT_STORAGE_SAVED, JSON.stringify(saved.payload));
  const object = botStorageObjectInfoSchema.parse(saved.payload);
  assert.deepEqual([object.key, object.sizeBytes, object.contentType], ['nes/rom/slot-1', 9, 'application/octet-stream']);
  const read = botStorageGetResultSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_GET, { key: 'nes/rom/slot-1' })).payload);
  assert.equal(Buffer.from(read.object?.data ?? '', 'base64').toString(), 'state one');
  assert.equal(botStorageGetResultSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_GET, { key: 'missing' })).payload).object, null);

  for (const key of ['nes/rom/slot-2', 'nes/rom/slot-3', 'doom/save']) {
    assert.equal((await bot.peer.request(MessageType.BOT_STORAGE_PUT, { key, data: data(3) })).type, MessageType.BOT_STORAGE_SAVED);
  }
  const first = botStorageListResultSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_LIST, { prefix: 'nes/', limit: 2 })).payload);
  assert.deepEqual(first.objects.map((entry) => entry.key), ['nes/rom/slot-1', 'nes/rom/slot-2']);
  assert.equal(first.next, 'nes/rom/slot-2');
  const second = botStorageListResultSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_LIST, {
    prefix: 'nes/', limit: 2, after: first.next,
  })).payload);
  assert.deepEqual(second.objects.map((entry) => entry.key), ['nes/rom/slot-3']);
  assert.equal(second.next, null);
  const usage = botStorageUsageSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_USAGE, {})).payload);
  assert.deepEqual([usage.usedBytes, usage.objectCount, usage.maxBytes, usage.level], [18, 4, BOT_STORAGE_LIMITS.serverDefaultBytes, 'ok']);

  const removed = await bot.peer.request(MessageType.BOT_STORAGE_DELETE, { key: 'doom/save' });
  assert.deepEqual(removed.payload, { key: 'doom/save', deleted: true });
  assert.deepEqual((await bot.peer.request(MessageType.BOT_STORAGE_DELETE, { key: 'doom/save' })).payload, { key: 'doom/save', deleted: false });

  assert.deepEqual(await f.serverInfo(), { requested: true, granted: true, usage: { ...usage, usedBytes: 15, objectCount: 3 } });
  assert.deepEqual(await f.info(f.member.peer), { botId: f.botId, server: null, device: { requested: false, granted: false } },
    'Everyone else sees nothing about the server, only whether the bot may ask for their own computer');
});

test('a full storage refuses writes without evicting, and managers raise the limit or clear it', async (t) => {
  const f = await fixture(t);
  const bot = await f.approved(['server_storage']);
  await f.member.peer.error(MessageType.BOT_STORAGE_LIMIT_UPDATE,
    { botId: f.botId, maxBytes: BOT_STORAGE_LIMITS.minQuotaBytes }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.member.peer.error(MessageType.BOT_STORAGE_CLEAR, { botId: f.botId }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.owner.peer.error(MessageType.BOT_STORAGE_LIMIT_UPDATE,
    { botId: f.botId, maxBytes: BOT_STORAGE_LIMITS.minQuotaBytes - 1 }, ProtocolErrorCode.BAD_REQUEST);
  const limited = await f.owner.peer.request(MessageType.BOT_STORAGE_LIMIT_UPDATE, { botId: f.botId, maxBytes: BOT_STORAGE_LIMITS.minQuotaBytes });
  assert.equal(limited.type, MessageType.BOT_STORAGE_INFO, JSON.stringify(limited.payload));
  assert.equal(botStorageInfoSchema.parse(limited.payload).server?.usage.maxBytes, BOT_STORAGE_LIMITS.minQuotaBytes);

  const level = async (since: number) => botStorageLevelEventSchema.parse((await f.owner.peer.wait(
    (message) => message.type === MessageType.BOT_STORAGE_LEVEL, since)).payload);
  const memberSince = f.member.peer.messages.length;
  assert.equal((await bot.peer.request(MessageType.BOT_STORAGE_PUT, { key: 'a', data: data(600 * KIB) })).type, MessageType.BOT_STORAGE_SAVED);
  const since = f.owner.peer.messages.length;
  assert.equal((await bot.peer.request(MessageType.BOT_STORAGE_PUT, { key: 'b', data: data(330 * KIB) })).type, MessageType.BOT_STORAGE_SAVED);
  const nearFull = await level(since);
  assert.deepEqual([nearFull.botId, nearFull.usage.level], [f.botId, 'near_full']);

  const fullSince = f.owner.peer.messages.length;
  await bot.peer.error(MessageType.BOT_STORAGE_PUT, { key: 'c', data: data(100 * KIB) }, ProtocolErrorCode.STORAGE_FULL);
  assert.equal((await level(fullSince)).usage.level, 'full');
  assert.equal((await f.serverInfo()).usage.level, 'full');
  assert.equal((await f.info(f.member.peer)).server, null);
  for (const key of ['a', 'b']) {
    assert.ok(botStorageGetResultSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_GET, { key })).payload).object, key);
  }
  // Replacing an object only counts the difference.
  const okSince = f.owner.peer.messages.length;
  assert.equal((await bot.peer.request(MessageType.BOT_STORAGE_PUT, { key: 'a', data: data(200 * KIB) })).type, MessageType.BOT_STORAGE_SAVED);
  assert.equal((await level(okSince)).usage.level, 'ok');
  assert.equal((await f.serverInfo()).usage.level, 'ok');
  // Warnings go out in order, so every earlier one has been delivered by now.
  assert.equal(f.member.peer.messages.slice(memberSince).some((message) => message.type === MessageType.BOT_STORAGE_LEVEL), false,
    'Only people who manage bots are warned about the server storage');
  assert.equal((await bot.peer.request(MessageType.BOT_STORAGE_PUT, { key: 'c', data: data(100 * KIB) })).type, MessageType.BOT_STORAGE_SAVED);

  const cleared = botStorageInfoSchema.parse((await f.owner.peer.request(MessageType.BOT_STORAGE_CLEAR, { botId: f.botId })).payload).server;
  assert.deepEqual([cleared?.usage.usedBytes, cleared?.usage.objectCount], [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const files = fs.readdirSync(path.join(f.dataDir, 'bot-storage'), { recursive: true }).filter((entry) => String(entry).endsWith('.bin'));
  assert.deepEqual(files, []);
});

test('revoking the grant keeps the data and removing the bot deletes it from the server', async (t) => {
  const f = await fixture(t);
  let bot = await f.approved(['server_storage']);
  assert.equal((await bot.peer.request(MessageType.BOT_STORAGE_PUT, { key: 'kept', data: data(10) })).type, MessageType.BOT_STORAGE_SAVED);
  let closed = once(bot.peer.ws, 'close');
  await f.approve(['commands']);
  await closed;
  bot = await f.connectBot();
  await bot.peer.error(MessageType.BOT_STORAGE_GET, { key: 'kept' }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  const revoked = await f.serverInfo();
  assert.deepEqual([revoked.granted, revoked.usage.objectCount], [false, 1]);
  closed = once(bot.peer.ws, 'close');
  await f.approve(['commands', 'server_storage']);
  await closed;
  bot = await f.connectBot();
  assert.ok(botStorageGetResultSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_GET, { key: 'kept' })).payload).object);

  const root = path.join(f.dataDir, 'bot-storage');
  assert.equal(fs.readdirSync(root).length, 1);
  assert.equal((await f.owner.peer.request(MessageType.BOT_REVOKE, { botId: f.botId })).type, MessageType.BOT_REVOKED);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(f.database.getDb().prepare('SELECT COUNT(*) AS total FROM bot_storage_objects').get().total, 0);
  await f.owner.peer.error(MessageType.BOT_STORAGE_INFO_GET, { botId: f.botId }, ProtocolErrorCode.BAD_REQUEST);
});

test('clients without bot-storage never see the storage capabilities and keep their grants when reviewing', async (t) => {
  const f = await fixture(t);
  const bot = await f.declare(['commands', 'server_storage', 'device_storage']);
  const closed = once(bot.peer.ws, 'close');
  await f.approve(['commands', 'server_storage', 'device_storage']);
  await closed;
  const features = PROTOCOL_FEATURES.filter((feature) => feature !== 'bot-storage');
  const legacy = await f.human('Storage owner', f.owner.keys, randomUUID(), false, 38, { minimumVersion: 35, features: [...features] });
  const snapshot = botPermissionsSnapshotSchema.parse((await legacy.peer.request(MessageType.BOT_PERMISSIONS_GET, { botId: f.botId })).payload);
  assert.deepEqual(snapshot.permissions.requested, ['commands']);
  assert.deepEqual(snapshot.permissions.granted, ['commands']);
  const list = botSettingsListResponseSchema.parse((await legacy.peer.request(MessageType.BOT_SETTINGS_LIST, {})).payload);
  assert.deepEqual(list.bots.find((entry) => entry.botId === f.botId)?.permissions?.granted, ['commands']);
  const modern = botSettingsListResponseSchema.parse((await f.owner.peer.request(MessageType.BOT_SETTINGS_LIST, {})).payload);
  assert.deepEqual(modern.bots.find((entry) => entry.botId === f.botId)?.permissions?.granted, ['commands', 'server_storage', 'device_storage']);

  const reviewed = await legacy.peer.request(MessageType.BOT_PERMISSIONS_UPDATE, {
    botId: f.botId, expectedRevision: snapshot.permissions.revision, granted: ['commands'],
  });
  assert.equal(reviewed.type, MessageType.BOT_PERMISSIONS_SNAPSHOT, JSON.stringify(reviewed.payload));
  assert.deepEqual(botPermissionsSnapshotSchema.parse(reviewed.payload).permissions.granted, ['commands']);
  assert.deepEqual(f.botPermissions.get(f.botId)?.granted, ['commands', 'server_storage', 'device_storage']);
  await legacy.peer.error(MessageType.BOT_STORAGE_INFO_GET, { botId: f.botId }, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
});

test('manifest fetches announce bot-storage, and installers without it never see the storage capabilities', async (t) => {
  const f = await fixture(t);
  let announced = '';
  const server = http.createServer((request, response) => {
    announced = String(request.headers[BOT_MANIFEST_FEATURES_HEADER] ?? '');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      name: 'Storage bot', requestedCapabilities: ['miniapps', 'server_storage', 'device_storage'],
      registrationUrl: `http://127.0.0.1:${address.port}/register`,
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const manifestUrl = `http://127.0.0.1:${address.port}/manifest`;
  const modern = await f.owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl });
  assert.equal(modern.type, MessageType.BOT_INSTALL_PREVIEW_RESULT, JSON.stringify(modern.payload));
  assert.deepEqual(botInstallPreviewSchema.parse(modern.payload).manifest.requestedCapabilities, ['miniapps', 'server_storage', 'device_storage']);
  assert.equal(announced.split(',').includes('bot-storage'), true);
  const features = PROTOCOL_FEATURES.filter((feature) => feature !== 'bot-storage');
  const legacy = await f.human('Storage owner', f.owner.keys, randomUUID(), false, 38, { minimumVersion: 35, features: [...features] });
  const old = await legacy.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl });
  assert.equal(old.type, MessageType.BOT_INSTALL_PREVIEW_RESULT, JSON.stringify(old.payload));
  assert.deepEqual(record(old.payload.manifest).requestedCapabilities, ['miniapps']);
});

test('a lost file is dropped instead of breaking reads, and reconciliation removes unreferenced files', async (t) => {
  const f = await fixture(t);
  const bot = await f.approved(['server_storage']);
  assert.equal((await bot.peer.request(MessageType.BOT_STORAGE_PUT, { key: 'lost', data: data(8) })).type, MessageType.BOT_STORAGE_SAVED);
  const root = path.join(f.dataDir, 'bot-storage');
  const [directory] = fs.readdirSync(root);
  for (const file of fs.readdirSync(path.join(root, directory!))) fs.rmSync(path.join(root, directory!, file));
  assert.equal(botStorageGetResultSchema.parse((await bot.peer.request(MessageType.BOT_STORAGE_GET, { key: 'lost' })).payload).object, null);
  assert.equal((await f.serverInfo()).usage.objectCount, 0);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-storage-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new BotStorageFileStore(dataDir, 0);
  const keep = await store.write('kept-bot', Buffer.from('keep'));
  const orphan = await store.write('kept-bot', Buffer.from('orphan'));
  await store.write('removed-bot', Buffer.from('gone'));
  assert.equal(await store.reconcile(new Map([['kept-bot', new Set([keep])]])), 2);
  assert.equal((await store.read('kept-bot', keep))?.toString(), 'keep');
  assert.equal(await store.read('kept-bot', orphan), null);
  assert.equal(await store.read('kept-bot', '../../escape.bin'), null);
  assert.equal(fs.readdirSync(store.root).length, 1);
});
