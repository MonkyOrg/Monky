import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { MessageType, Permission, ProtocolErrorCode, canAccessChannel, DEFAULT_PERMISSIONS, resolveChannelPermissions } from '@monky/shared';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqlJsDriver } from './infrastructure/database/SqliteWrapper';
import { SqliteChannelRepository, SqliteRoleRepository, SqliteServerRepository } from './infrastructure/database/SqliteRepositories';
import { ensureServerSeedData, MonkyServer } from './server';
import { AttachmentService } from './application/services/AttachmentService';
import { AttachmentStorageService } from './infrastructure/security/AttachmentStorageService';
import { createApprovedBotFixture, record, records, text } from './testFixtures/bots';

test('category permissions fail closed and channel overrides replace inheritance', () => {
  const inherited = { categoryId: 'category', isPrivate: false, allowedRoleIds: [] };
  const category = { isPrivate: true, allowedRoleIds: ['team'] };
  assert.deepEqual(resolveChannelPermissions(inherited, category), category);
  assert.deepEqual(resolveChannelPermissions(inherited, null), { isPrivate: true, allowedRoleIds: [] });
  assert.equal(canAccessChannel(resolveChannelPermissions(inherited, category), DEFAULT_PERMISSIONS, []), false);
  assert.equal(canAccessChannel(resolveChannelPermissions(inherited, category), DEFAULT_PERMISSIONS, ['team']), true);
  assert.deepEqual(resolveChannelPermissions({ ...inherited, inheritCategoryPermissions: false }, category), {
    isPrivate: false, allowedRoleIds: [],
  });
});

test('legacy migration preserves private channels, history and ordering and survives reopen', async () => {
  const folder = path.resolve('.qa', `category-migration-${randomUUID()}`);
  const filename = path.join(folder, 'server.db');
  const migrationFolder = path.join(__dirname, 'infrastructure', 'database', 'migrations');
  let legacy: SqlJsDriver | undefined;
  let connection: DatabaseConnection | undefined;
  try {
    legacy = await SqlJsDriver.create(filename);
    legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const file of fs.readdirSync(migrationFolder).filter((file) => file.endsWith('.sql') && file < '031_').sort()) {
      legacy.exec(fs.readFileSync(path.join(migrationFolder, file), 'utf8'));
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1);
    }
    legacy.prepare('INSERT INTO server_meta (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)').run('server', 'Legacy', '', 1);
    legacy.prepare('INSERT INTO roles (id, name, position, permissions, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('team', 'Team', 1, DEFAULT_PERMISSIONS, 0, 1);
    legacy.prepare('INSERT INTO channels (id, server_id, name, type, position, created_at, is_private) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('text', 'server', 'Private', 'TEXT', 4, 1, 1);
    legacy.prepare('INSERT INTO channel_allowed_roles VALUES (?, ?)').run('text', 'team');
    legacy.prepare('INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('voice', 'server', 'Voice', 'VOICE', 2, 2);
    legacy.close();
    legacy = undefined;
    connection = await DatabaseConnection.create(filename);
    let repo = new SqliteChannelRepository(connection.getDb());
    assert.deepEqual((await repo.categories.listByServerId('server')).map((category) => category.name), ['Canais de texto', 'Canais de voz']);
    assert.equal((await repo.findById('text'))?.inheritCategoryPermissions, false);
    assert.equal((await repo.findById('text'))?.position, 4);
    assert.deepEqual((await repo.findById('text'))?.allowedRoleIds, ['team']);
    assert.equal((await repo.findById('voice'))?.inheritCategoryPermissions, true);
    connection.close();
    connection = await DatabaseConnection.create(filename);
    repo = new SqliteChannelRepository(connection.getDb());
    assert.equal((await repo.categories.listByServerId('server')).length, 2);
    assert.equal((await repo.findById('text'))?.isPrivate, true);
  } finally {
    legacy?.close();
    connection?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('new server seeds two localized categories exactly once', async () => {
  const folder = path.resolve('.qa', `category-seed-${randomUUID()}`);
  const connection = await DatabaseConnection.create(path.join(folder, 'server.db'));
  try {
    const server = new SqliteServerRepository(connection.getDb());
    const channels = new SqliteChannelRepository(connection.getDb());
    const roles = new SqliteRoleRepository(connection.getDb());
    await ensureServerSeedData({ categoryLocale: 'en' }, server, channels, roles);
    await ensureServerSeedData({ categoryLocale: 'pt-BR' }, server, channels, roles);
    const id = (await server.getServer())!.id;
    assert.deepEqual((await channels.categories.listByServerId(id)).map((category) => category.name), ['Text channels', 'Voice channels']);
    assert.equal((await channels.listByServerId(id)).every((channel) => !!channel.categoryId && channel.inheritCategoryPermissions), true);
  } finally {
    connection.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('category CRUD/mixed ordering and revocation cover auth, voice, chat, attachments and bots', async (t) => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Category owner');
  const member = await f.human('Category member');
  const outsider = await f.human('Category outsider');
  await f.roleRepo.create({ id: 'team', name: 'Team', color: null, position: 4, permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: 1 });
  await f.roleRepo.assignRole(member.id, 'team');
  await outsider.peer.error(MessageType.CATEGORY_CREATE, { name: 'Forbidden' }, ProtocolErrorCode.PERMISSION_DENIED);
  const created = await owner.peer.request(MessageType.CATEGORY_CREATE, { name: 'Mixed', isPrivate: true, allowedRoleIds: ['team', 'missing'] });
  assert.equal(created.type, MessageType.CATEGORIES_UPDATED);
  const category = records(created.payload.categories).find((item) => item.name === 'Mixed')!;
  const categoryId = text(category.id);
  assert.deepEqual(category.allowedRoleIds, ['team']);
  const create = async (type: 'TEXT' | 'VOICE', inheritCategoryPermissions = true) => {
    const response = await owner.peer.request(MessageType.CHANNEL_CREATE, {
      name: `${type} channel`, type, categoryId, inheritCategoryPermissions,
    });
    assert.equal(response.type, MessageType.CHANNEL_CREATED, JSON.stringify(response));
    return record(response.payload.channel);
  };
  const chat = await create('TEXT');
  const voice = await create('VOICE');
  const publicOverride = await create('TEXT', false);
  const chatId = text(chat.id);
  const voiceId = text(voice.id);
  assert.equal(chat.isPrivate, true);
  assert.equal(publicOverride.isPrivate, false);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, chatId), true);
  assert.equal(await f.channelService.canUserAccessChannel(outsider.id, chatId), false);
  await outsider.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: chatId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await outsider.peer.error(MessageType.VOICE_JOIN, { channelId: voiceId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await outsider.peer.error(MessageType.CHAT_REQUEST_UPLOAD_TOKEN, { channelId: chatId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const botLink = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(botLink.payload.token));
  assert.equal(records(record(bot.auth.payload.server).channels).some((channel) => channel.id === chatId), false);
  await bot.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: chatId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const joined = await member.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  assert.notEqual(joined.type, MessageType.SERVER_ERROR);
  const hiddenRoster = await f.human('Roster outsider');
  assert.equal(Object.values(record(record(hiddenRoster.auth.payload.server).voiceStates))
    .some((state) => record(state).channelId === voiceId), false);
  const marker = member.peer.messages.length;
  const updated = await owner.peer.request(MessageType.CATEGORY_UPDATE, { categoryId, allowedRoleIds: [] });
  assert.equal(updated.type, MessageType.CATEGORIES_UPDATED);
  await member.peer.wait((message) => message.type === MessageType.CHANNEL_DELETED && message.payload.channelId === voiceId, marker);
  assert.equal(f.signalingService.getParticipantsInChannel(voiceId).length, 0);
  await member.peer.error(MessageType.CHAT_SEND, { channelId: chatId, content: 'Revoked' }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const rejoined = await f.human('Category member', member.keys);
  assert.equal(records(record(rejoined.auth.payload.server).channels).some((channel) => channel.id === chatId), false);
  const order = await owner.peer.request(MessageType.CHANNEL_REORDER, { categoryId, orderedIds: [voiceId, chatId, voiceId, 'missing'] });
  assert.equal(order.type, MessageType.CHANNELS_REORDERED);
  assert.deepEqual(records(order.payload.positions).map((item) => item.channelId), [voiceId, chatId, text(publicOverride.id)]);
  const removed = await owner.peer.request(MessageType.CATEGORY_DELETE, { categoryId });
  assert.equal(removed.type, MessageType.CATEGORIES_UPDATED);
  const persisted = await f.channelRepo.findById(chatId);
  assert.equal(persisted?.categoryId, null);
  assert.equal(persisted?.inheritCategoryPermissions, false);
  assert.equal(persisted?.isPrivate, true);
  assert.deepEqual(persisted?.allowedRoleIds, []);
  assert.equal((await f.channelRepo.findById(text(publicOverride.id)))?.isPrivate, false);
  assert.equal(await f.channelService.canUserAccessChannel(outsider.id, chatId), false);
  assert.equal(canAccessChannel(persisted!, Permission.MANAGE_CHANNELS, []), true);
});

test('moving, deleting, role deletion and explicit overrides never silently publish access', async (t) => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  await f.human('Move owner');
  const member = await f.human('Move member');
  const serverId = (await f.serverRepo.getServer())!.id;
  const repo = f.channelRepo.categories;
  const seeded = (await f.channelService.listChannels()).find((channel) => channel.type === 'TEXT')!;
  const override = await f.channelService.updateChannel({ channelId: seeded.id, isPrivate: true, allowedRoleIds: [] });
  assert.equal(override.success, true);
  assert.equal(override.channel?.inheritCategoryPermissions, false, 'an explicit ACL edit overrides an inherited default');
  assert.equal(await f.channelService.canUserAccessChannel(member.id, seeded.id), false);
  await f.channelService.updateChannel({ channelId: seeded.id, name: 'Renamed private' });
  assert.equal(await f.channelService.canUserAccessChannel(member.id, seeded.id), false, 'metadata edits preserve overrides');
  await f.channelService.updateChannel({ channelId: seeded.id, inheritCategoryPermissions: true });
  assert.equal(await f.channelService.canUserAccessChannel(member.id, seeded.id), true, 'explicit resync restores category access');
  await f.roleRepo.create({ id: 'allowed', name: 'Allowed', color: null, position: 4, permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: 1 });
  await f.roleRepo.assignRole(member.id, 'allowed');
  await repo.create({ id: 'private', serverId, name: 'Private', position: 2, createdAt: 1, isPrivate: true, allowedRoleIds: ['allowed'] });
  await repo.create({ id: 'public', serverId, name: 'Public', position: 3, createdAt: 1, isPrivate: false, allowedRoleIds: [] });
  const created = await f.channelService.createChannel({ name: 'Inherited', type: 'TEXT', categoryId: 'private' });
  assert.ok(created.channel);
  const channelId = created.channel.id;
  assert.equal(created.channel.isPrivate, true);
  await f.channelService.updateChannel({ channelId, categoryId: null });
  assert.deepEqual((await f.channelRepo.findById(channelId))?.allowedRoleIds, ['allowed']);
  assert.equal((await f.channelRepo.findById(channelId))?.inheritCategoryPermissions, false);
  await f.channelService.updateChannel({ channelId, categoryId: 'public' });
  assert.equal((await f.channelRepo.findById(channelId))?.isPrivate, true, 'an existing override survives a move');
  await f.channelService.updateChannel({ channelId, inheritCategoryPermissions: true });
  assert.equal((await f.channelRepo.findById(channelId))?.isPrivate, false, 'explicit sync adopts category access');
  await f.channelService.updateChannel({ channelId, categoryId: 'private' });
  assert.equal((await f.channelRepo.findById(channelId))?.isPrivate, true, 'inherited moves adopt private destination');
  await repo.deletePreservingAccess('private');
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId), true);
  assert.deepEqual((await f.channelRepo.findById(channelId))?.allowedRoleIds, ['allowed']);
  await f.roleRepo.delete('allowed');
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId), false);
  assert.equal((await f.channelRepo.findById(channelId))?.isPrivate, true, 'deleting the last allowed role fails closed');
  assert.equal((await f.channelService.createChannel({ name: 'Bad category', type: 'VOICE', categoryId: 'missing' })).success, false);
  assert.equal((await f.channelService.updateChannel({ channelId, categoryId: 'missing' })).success, false);
  assert.equal((await f.channelService.mutateCategory('update', { categoryId: 'public', name: '' })).success, false);
});

test('HTTP upload tokens cannot outlive inherited access, including an in-flight upload', async (t) => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  await f.human('Upload owner');
  const member = await f.human('Upload member');
  const channels = await f.channelService.listChannels();
  const channel = channels.find((item) => item.type === 'TEXT')!;
  assert.ok(channel.categoryId);
  const storage = new AttachmentStorageService(f.dataDir);
  const attachments = new AttachmentService(f.attachmentRepo, f.serverRepo, storage, f.rateLimiter);
  let accepted: (() => void) | undefined;
  const listener = http.createServer((request, response) => {
    void MonkyServer['handleAttachmentUpload'](request, response, attachments, storage, async (userId, channelId) => {
      const allowed = await f.channelService.canUserAccessChannel(userId, channelId);
      if (accepted) { const done = accepted; accepted = undefined; setImmediate(done); }
      return allowed;
    });
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(async () => { listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const token = attachments.issueUploadToken(member.id, channel.id)!.token;
  const url = `http://127.0.0.1:${address.port}/attachments?token=${token}&name=file.txt`;
  const admitted = new Promise<void>((resolve) => { accepted = resolve; });
  const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' } });
  const response = once(request, 'response');
  request.write(Buffer.from('begin '));
  await admitted;
  await f.channelRepo.categories.update(channel.categoryId, { isPrivate: true, allowedRoleIds: [] });
  request.end(Buffer.from('end'));
  const [received] = await response;
  assert.equal((received as http.IncomingMessage).statusCode, 400);
  (received as http.IncomingMessage).resume();
  await once(received, 'end');
  const rejected = await fetch(url, { method: 'POST', body: 'later' });
  assert.equal(rejected.status, 401);
  assert.equal(await f.attachmentRepo.sumActiveBytes(), 0);
});
