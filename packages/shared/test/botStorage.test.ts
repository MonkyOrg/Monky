import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_CAPABILITIES, BOT_SCREEN_PERMISSION_POLICY_VERSION, BOT_STORAGE_LIMITS, base64ByteLength, botDeviceStorageRequestSchema,
  botDeviceStorageScopeSchema, botPermissionsSchema, botScreenDocumentConsentSchema, botStorageDataSchema, botStorageInfoSchema,
  botStorageKeySchema, botStorageLevel, botStorageListSchema, botStorageObjectSchema, botStoragePrefixSchema, botStoragePutSchema,
  botStorageQuotaSchema, createProtocolOffer, isBotStorageKey, withoutBotStorageCapabilities, withoutBotStoragePermissions,
} from '../src/index.js';

test('storage capabilities are explicit, separate and hidden from peers that cannot parse them', () => {
  assert.deepEqual(BOT_CAPABILITIES.slice(-2), ['server_storage', 'device_storage']);
  assert.deepEqual(withoutBotStorageCapabilities(['commands', 'server_storage', 'miniapps', 'device_storage']), ['commands', 'miniapps']);
  const permissions = botPermissionsSchema.parse({
    requested: ['miniapps', 'server_storage', 'device_storage'], granted: ['miniapps', 'device_storage'],
    revision: 3, reviewRequired: false, reviewedBy: 'admin', reviewedAt: 1,
  });
  const legacy = withoutBotStoragePermissions(permissions);
  assert.deepEqual(legacy.requested, ['miniapps']);
  assert.deepEqual(legacy.granted, ['miniapps']);
  assert.equal(botPermissionsSchema.safeParse(legacy).success, true);
  assert.equal(createProtocolOffer('client').features.includes('bot-storage'), true);
  assert.equal(createProtocolOffer('bot').features.includes('bot-storage'), true);
});

test('keys are logical names that can never become paths outside the bot area', () => {
  for (const key of ['save', 'nes/7f3a/slot-1', 'a.b_c-d/e', 'A'.repeat(BOT_STORAGE_LIMITS.keyLength), 'x/.hidden']) {
    assert.equal(isBotStorageKey(key), true, key);
  }
  for (const key of ['', '/abs', '../up', 'a/../b', 'a/./b', 'a//b', 'a/', '.dot', 'with space', 'é', 'a\\b', 'C:x',
    'A'.repeat(BOT_STORAGE_LIMITS.keyLength + 1), 42, null]) {
    assert.equal(botStorageKeySchema.safeParse(key).success, false, String(key));
  }
  for (const prefix of ['', 'nes/', 'nes/7f3a', 'nes/7f3a/']) assert.equal(botStoragePrefixSchema.safeParse(prefix).success, true, prefix);
  for (const prefix of ['/', '../', 'nes//', 'nes/../']) assert.equal(botStoragePrefixSchema.safeParse(prefix).success, false, prefix);
  assert.equal(botStorageListSchema.safeParse({ prefix: 'nes/', after: 'nes/a', limit: BOT_STORAGE_LIMITS.listPageSize }).success, true);
  assert.equal(botStorageListSchema.safeParse({ limit: BOT_STORAGE_LIMITS.listPageSize + 1 }).success, false);
});

test('object bytes are canonical base64 bounded by the per-object limit', () => {
  const data = Buffer.from('save state').toString('base64');
  assert.equal(base64ByteLength(data), 10);
  assert.equal(botStoragePutSchema.safeParse({ key: 'save', data, contentType: 'application/octet-stream' }).success, true);
  assert.equal(botStoragePutSchema.safeParse({ key: 'save', data, contentType: 'application/json; charset=utf-8' }).success, true);
  assert.equal(botStoragePutSchema.safeParse({ key: 'save', data: '' }).success, true);
  for (const invalid of ['abc', 'ab=c', '====', '@@@@', 'YQ==YQ==']) {
    assert.equal(botStorageDataSchema.safeParse(invalid).success, false, invalid);
  }
  const limit = Buffer.alloc(BOT_STORAGE_LIMITS.objectBytes).toString('base64');
  assert.equal(botStorageDataSchema.safeParse(limit).success, true);
  assert.equal(botStorageDataSchema.safeParse(Buffer.alloc(BOT_STORAGE_LIMITS.objectBytes + 1).toString('base64')).success, false);
  assert.equal(botStoragePutSchema.safeParse({ key: 'save', data, contentType: 'not a type' }).success, false);
  const object = { key: 'save', sizeBytes: 10, contentType: null, updatedAt: 1, data };
  assert.equal(botStorageObjectSchema.safeParse(object).success, true);
  assert.equal(botStorageObjectSchema.safeParse({ ...object, sizeBytes: 11 }).success, false);
});

test('warning levels follow the quota and an autosave refused for lack of space', () => {
  assert.equal(botStorageLevel(0, 100), 'ok');
  assert.equal(botStorageLevel(89, 100), 'ok');
  assert.equal(botStorageLevel(90, 100), 'near_full');
  assert.equal(botStorageLevel(100, 100), 'full');
  assert.equal(botStorageLevel(120, 100), 'full');
  assert.equal(botStorageLevel(10, 100, true), 'full');
  assert.equal(botStorageQuotaSchema.safeParse(BOT_STORAGE_LIMITS.minQuotaBytes - 1).success, false);
  assert.equal(botStorageQuotaSchema.safeParse(BOT_STORAGE_LIMITS.serverDefaultBytes).success, true);
  assert.equal(botStorageQuotaSchema.safeParse(BOT_STORAGE_LIMITS.maxQuotaBytes + 1).success, false);
});

test('storage info never reports a grant that was not requested, and hides the server from non-managers', () => {
  const usage = { usedBytes: 0, maxBytes: BOT_STORAGE_LIMITS.serverDefaultBytes, objectCount: 0, maxObjects: 10, level: 'ok' };
  const info = { botId: 'bot', server: { requested: true, granted: true, usage }, device: { requested: true, granted: false } };
  assert.equal(botStorageInfoSchema.safeParse(info).success, true);
  assert.equal(botStorageInfoSchema.safeParse({ ...info, device: { requested: false, granted: true } }).success, false);
  assert.equal(botStorageInfoSchema.safeParse({ ...info, server: { ...info.server, requested: false } }).success, false);
  assert.equal(botStorageInfoSchema.safeParse({ ...info, extra: true }).success, false);
  assert.equal(botStorageInfoSchema.safeParse({ ...info, server: null }).success, true, 'People who cannot manage bots get no server data');
  const { server: _server, ...withoutServer } = info;
  assert.equal(botStorageInfoSchema.safeParse(withoutServer).success, false, 'The server part is explicit, never silently missing');
});

test('miniapp consent binds storage to the same bot and to a concrete server account', () => {
  const scope = {
    serverUrl: 'wss://monky.example/', serverId: 'server', serverName: 'Server', userId: 'user', botId: 'bot', botName: 'MonkyBot',
  };
  assert.equal(botDeviceStorageScopeSchema.safeParse(scope).success, true);
  for (const serverUrl of ['https://monky.example/', 'wss://user:pass@monky.example/', 'not a url', 'wss://monky.example/#x']) {
    assert.equal(botDeviceStorageScopeSchema.safeParse({ ...scope, serverUrl }).success, false, serverUrl);
  }
  const consent = { policyVersion: BOT_SCREEN_PERMISSION_POLICY_VERSION, serverKey: 'key', botId: 'bot', screenId: 'game', instanceId: 'one' };
  assert.equal(BOT_SCREEN_PERMISSION_POLICY_VERSION, 2);
  assert.equal(botScreenDocumentConsentSchema.safeParse(consent).success, true);
  assert.equal(botScreenDocumentConsentSchema.safeParse({ ...consent, storage: { scope, grant: 'session' } }).success, true);
  assert.equal(botScreenDocumentConsentSchema.safeParse({ ...consent, storage: { scope, grant: 'forever' } }).success, false);
  assert.equal(botScreenDocumentConsentSchema.safeParse({ ...consent, storage: { scope: { ...scope, botId: 'other' }, grant: 'always' } }).success, false);
  assert.equal(botScreenDocumentConsentSchema.safeParse({ ...consent, policyVersion: 1 }).success, false);
});

test('device requests accept text or bytes within the object limit and nothing else', () => {
  assert.equal(botDeviceStorageRequestSchema.safeParse({ op: 'set', key: 'save', value: { kind: 'text', text: 'é' }, autosave: true }).success, true);
  assert.equal(botDeviceStorageRequestSchema.safeParse({ op: 'set', key: 'save', value: { kind: 'bytes', bytes: new Uint8Array(4) }, autosave: false }).success, true);
  assert.equal(botDeviceStorageRequestSchema.safeParse({
    op: 'set', key: 'save', value: { kind: 'bytes', bytes: new Uint8Array(BOT_STORAGE_LIMITS.objectBytes + 1) }, autosave: false,
  }).success, false);
  assert.equal(botDeviceStorageRequestSchema.safeParse({
    op: 'set', key: 'save', value: { kind: 'text', text: 'é'.repeat(BOT_STORAGE_LIMITS.objectBytes / 2 + 1) }, autosave: false,
  }).success, false);
  assert.equal(botDeviceStorageRequestSchema.safeParse({ op: 'set', key: 'save', value: { kind: 'bytes', bytes: [1, 2] }, autosave: false }).success, false);
  assert.equal(botDeviceStorageRequestSchema.safeParse({ op: 'list', prefix: 'nes/' }).success, true);
  assert.equal(botDeviceStorageRequestSchema.safeParse({ op: 'delete', key: 'save' }).success, false);
  assert.equal(botDeviceStorageRequestSchema.safeParse({ op: 'get', key: '../x' }).success, false);
});
