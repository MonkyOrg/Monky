import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, EVERYONE_ROLE_ID, MessageType, Permission, PROTOCOL_VERSION, ProtocolErrorCode, canAccessChannel, createProtocolOffer, resolveLegacyMemberPermissions, resolveMemberPermissions, resolveRoleDenyMemberPermissions } from '@monky/shared';
import { createApprovedBotFixture, record, records, text, type Received } from './testFixtures/bots';
import { SqlJsDriver } from './infrastructure/database/SqliteWrapper';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteChannelRepository, SqliteRoleRepository, SqliteServerRepository } from './infrastructure/database/SqliteRepositories';
import { ensureServerSeedData } from './server';

test('migration replaces only the unmodified Member role, preserves old private visibility, and survives restart', async () => {
  const folder = path.resolve('.qa', `permissions-migration-${randomUUID()}`);
  const filename = path.join(folder, 'server.db');
  const migrations = path.join(__dirname, 'infrastructure', 'database', 'migrations');
  let legacy: SqlJsDriver | undefined;
  let connection: DatabaseConnection | undefined;
  try {
    legacy = await SqlJsDriver.create(filename);
    legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql') && file < '042_').sort()) {
      legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1);
    }
    legacy.exec("INSERT INTO server_meta (id, name, password_hash, created_at) VALUES ('server', 'Legacy', '', 1)");
    const createRole = legacy.prepare('INSERT INTO roles (id, name, color, position, permissions, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)');
    createRole.run('original', 'Membro', '#5865f2', 0, 22288, 1);
    createRole.run('renamed', 'Readers', '#5865f2', 0, 22288, 1);
    createRole.run('custom', 'Membro', '#112233', 0, 22288, 1);
    createRole.run('manager', 'Manager', null, 1, Permission.MANAGE_CHANNELS, 0);
    legacy.exec("INSERT INTO channels (id, server_id, name, type, position, created_at, is_private) VALUES ('private', 'server', 'Private', 'TEXT', 0, 1, 1)");
    legacy.exec("INSERT INTO channel_allowed_roles VALUES ('private', 'original')");
    legacy.exec("INSERT INTO channel_categories (id, server_id, name, position, created_at, is_private) VALUES ('category', 'server', 'Private category', 0, 1, 1)");
    legacy.exec("INSERT INTO category_allowed_roles VALUES ('category', 'original')");
    legacy.close();
    legacy = undefined;
    connection = await DatabaseConnection.create(filename);
    for (let restart = 0; restart < 2; restart++) {
      const roles: SqliteRoleRepository = new SqliteRoleRepository(connection.getDb());
      const channels: SqliteChannelRepository = new SqliteChannelRepository(connection.getDb());
      const server: SqliteServerRepository = new SqliteServerRepository(connection.getDb());
      await ensureServerSeedData({}, server, channels, roles);
      assert.equal(await roles.findById('original'), null);
      assert.equal((await roles.findById('custom'))?.color, '#112233');
      assert.equal((await roles.findById('renamed'))?.name, 'Readers');
      assert.equal((await server.getServer())?.everyonePermissions, DEFAULT_PERMISSIONS);
      const channel = (await channels.findById('private'))!;
      assert.equal(channel.isPrivate, true);
      assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, []), true);
      assert.equal(canAccessChannel(channel, DEFAULT_PERMISSIONS, [], true), false, 'migration must not expose old private rooms to bots');
      assert.equal(channel.permissionOverwrites?.some(rule => rule.roleId === 'manager' && (rule.allow & Permission.VIEW_CHANNEL) !== 0), true);
      await channels.update('private', { name: 'Renamed channel' });
      assert.equal((await channels.findById('private'))?.isPrivate, true);
      await channels.update('private', {
        permissionOverwrites: channel.permissionOverwrites!.map(rule => ({ ...rule, deny: rule.deny | Permission.SEND_MESSAGES })),
      });
      assert.equal((await channels.findById('private'))?.isPrivate, true, 'changing sending must not expose migrated channels to bots');
      const category = (await channels.categories.findById('category'))!;
      await channels.categories.update('category', {
        permissionOverwrites: category.permissionOverwrites!.map(rule => ({ ...rule, deny: rule.deny | Permission.SEND_MESSAGES })),
      });
      assert.equal((await channels.categories.findById('category'))?.isPrivate, true, 'categories preserve the same exclusion');
      connection.close();
      connection = await DatabaseConnection.create(filename);
    }
  } finally {
    legacy?.close();
    connection?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('Everyone is persisted but never an assignable role; roles only grant on top of it and add up', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Permission owner');
  const member = await f.human('Roleless member');
  assert.equal((await f.roleRepo.listAll()).some(role => role.name === 'Membro'), false);
  assert.deepEqual(await f.roleRepo.listRolesForUser(member.id), []);
  const everyone = DEFAULT_PERMISSIONS & ~Permission.SEND_MESSAGES;
  const updated = await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: EVERYONE_ROLE_ID, permissions: everyone });
  assert.equal(updated.payload.everyonePermissions, everyone);
  assert.equal(await f.permissions.getUserPermissions(member.id), everyone);
  await owner.peer.error(MessageType.ROLE_ASSIGN, { userId: member.id, roleId: EVERYONE_ROLE_ID }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.error(MessageType.ROLE_UNASSIGN, { userId: member.id, roleId: EVERYONE_ROLE_ID }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.error(MessageType.ROLE_DELETE, { roleId: EVERYONE_ROLE_ID }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.error(MessageType.ROLE_UPDATE, { roleId: EVERYONE_ROLE_ID, name: 'Renamed' }, ProtocolErrorCode.BAD_REQUEST);
  const createdRole = async (payload: Record<string, unknown>) =>
    records(record((await owner.peer.request(MessageType.ROLE_CREATE, payload)).payload).roles).find(role => role.name === payload.name)!;
  const blank = await createdRole({ name: 'Blank', permissions: 0 });
  assert.equal(blank.permissions, 0);
  assert.equal('deny' in blank, false, 'current clients never receive role denials');
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: member.id, roleId: text(blank.id) });
  assert.equal(await f.permissions.getUserPermissions(member.id), everyone, 'a role with everything off keeps Everyone');
  await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: text(blank.id), permissions: Permission.MANAGE_CHANNELS });
  assert.equal(await f.permissions.getUserPermissions(member.id), everyone | Permission.MANAGE_CHANNELS);
  await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: text(blank.id), permissions: Permission.MANAGE_CHANNELS, deny: Permission.SPEAK });
  assert.equal(await f.permissions.getUserPermissions(member.id), everyone | Permission.MANAGE_CHANNELS, 'a denial is ignored');
  assert.equal((await f.roleRepo.findById(text(blank.id)))?.permissions, Permission.MANAGE_CHANNELS);
  await owner.peer.error(MessageType.ROLE_UPDATE, { roleId: text(blank.id), permissions: Permission.SPEAK, deny: Permission.SPEAK }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: member.id, roleId: text(blank.id) });
  for (const [id, permissions] of [['writer', Permission.SEND_MESSAGES], ['color', 0]] as const) {
    await f.roleRepo.create({ id, permissions, name: id, color: null, position: 1, isDefault: false, createdAt: 1 });
  }
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: member.id, roleId: 'color' });
  assert.equal(await f.permissions.checkPermission(member.id, Permission.SEND_MESSAGES), false);
  assert.equal(await f.permissions.checkPermission(member.id, Permission.SPEAK), true, 'a role cannot take away what Everyone grants');
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: member.id, roleId: 'writer' });
  assert.equal(await f.permissions.checkPermission(member.id, Permission.SEND_MESSAGES), true, 'one role granting it is enough');
  await owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: member.id, roleId: 'writer' });
  await f.roleService.assignAdminRole(member.id);
  assert.equal(await f.permissions.checkPermission(member.id, Permission.SEND_MESSAGES), true);
});

test('older and 36.1 clients receive roles that resolve to the same permissions, and their saves keep the same grants', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Role owner');
  const offer = createProtocolOffer('client');
  const legacyOffer = { ...offer, features: offer.features.filter(feature => feature !== 'role-deny' && feature !== 'role-grants') };
  const denyOffer = { ...offer, features: offer.features.filter(feature => feature !== 'role-grants') };
  const old = await f.human('Old client', undefined, undefined, false, PROTOCOL_VERSION, legacyOffer);
  const v361 = await f.human('36.1 client', undefined, undefined, false, PROTOCOL_VERSION, denyOffer);
  const everyone = DEFAULT_PERMISSIONS;
  const grants = Permission.MANAGE_CHANNELS | Permission.SPEAK;
  await f.roleRepo.create({ id: 'mixed', name: 'Mixed', color: null, position: 1, isDefault: false, createdAt: 1, permissions: grants });
  await f.roleService.assignAdminRole(owner.id);
  const since = [old.peer.messages.length, v361.peer.messages.length];
  const renamed = (message: Received) => message.type === MessageType.ROLES_LIST &&
    records(record(message.payload).roles).some(role => role.name === 'Mixed grants');
  const current = await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: 'mixed', name: 'Mixed grants' });
  const currentRole = records(record(current.payload).roles).find(role => role.id === 'mixed')!;
  assert.deepEqual([currentRole.permissions, 'deny' in currentRole], [grants, false]);
  const broadcast = await old.peer.wait(renamed, since[0]);
  const oldRole = records(record(broadcast.payload).roles).find(role => role.id === 'mixed')!;
  const mask = everyone | grants;
  assert.equal(oldRole.permissions, mask);
  assert.equal('deny' in oldRole, false, 'older clients never see deny they cannot resolve');
  assert.equal(resolveLegacyMemberPermissions(everyone, [{ permissions: mask }]), resolveMemberPermissions(everyone, [{ permissions: grants }]));
  const adminRole = records(record(broadcast.payload).roles).find(role => (Number(role.permissions) & Permission.ADMINISTRATOR) !== 0);
  assert.equal(adminRole?.permissions, ADMIN_PERMISSIONS, 'the Admin role keeps its full mask for older clients');
  const denyBroadcast = await v361.peer.wait(renamed, since[1]);
  const denyRole = records(record(denyBroadcast.payload).roles).find(role => role.id === 'mixed')!;
  assert.deepEqual([denyRole.permissions, denyRole.deny], [grants, 0], '36.1 clients see the grants as allowed and nothing denied');
  assert.equal(resolveRoleDenyMemberPermissions(everyone, [{ permissions: grants, deny: 0 }]), resolveMemberPermissions(everyone, [{ permissions: grants }]));
  const relogin = await f.human('Old client', old.keys, old.deviceId, false, PROTOCOL_VERSION, legacyOffer);
  const loginRole = records(record(relogin.auth.payload.server).roles).find(role => role.id === 'mixed')!;
  assert.deepEqual([loginRole.permissions, 'deny' in loginRole], [mask, false]);
  const denyRelogin = await f.human('36.1 client', v361.keys, v361.deviceId, false, PROTOCOL_VERSION, denyOffer);
  const denyLoginRole = records(record(denyRelogin.auth.payload.server).roles).find(role => role.id === 'mixed')!;
  assert.deepEqual([denyLoginRole.permissions, denyLoginRole.deny], [grants, 0]);
  await f.roleService.assignAdminRole(old.id);
  await relogin.peer.request(MessageType.ROLE_UPDATE, { roleId: 'mixed', permissions: mask | Permission.KICK_MEMBERS });
  assert.equal((await f.roleRepo.findById('mixed'))!.permissions, grants | Permission.KICK_MEMBERS,
    'an older client save converts back to the same grants');
  await relogin.peer.request(MessageType.ROLE_UPDATE, { roleId: 'mixed', permissions: (mask | Permission.KICK_MEMBERS) & ~Permission.SPEAK });
  assert.equal((await f.roleRepo.findById('mixed'))!.permissions, Permission.MANAGE_CHANNELS | Permission.KICK_MEMBERS,
    'turning off a bit Everyone grants drops only the role grant');
  await f.roleService.assignAdminRole(v361.id);
  await denyRelogin.peer.request(MessageType.ROLE_UPDATE, { roleId: 'mixed', permissions: Permission.MANAGE_CHANNELS, deny: Permission.SEND_MESSAGES });
  assert.equal((await f.roleRepo.findById('mixed'))!.permissions, Permission.MANAGE_CHANNELS, 'a 36.1 denial is dropped');
});

test('full-mask and 36.1 roles become grants: denials are dropped and server bits leave channel rules', async () => {
  const folder = path.resolve('.qa', `role-grants-migration-${randomUUID()}`);
  const filename = path.join(folder, 'server.db');
  const migrations = path.join(__dirname, 'infrastructure', 'database', 'migrations');
  let legacy: SqlJsDriver | undefined;
  let connection: DatabaseConnection | undefined;
  try {
    legacy = await SqlJsDriver.create(filename);
    legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql') && file < '046_').sort()) {
      legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1);
    }
    const everyone = DEFAULT_PERMISSIONS & ~Permission.ATTACH_FILES;
    legacy.prepare("INSERT INTO server_meta (id, name, password_hash, created_at, everyone_permissions) VALUES ('server', 'Legacy', '', 1, ?)").run(everyone);
    const masks: Record<string, number> = {
      mod: (DEFAULT_PERMISSIONS | Permission.MANAGE_CHANNELS) & ~Permission.SEND_MESSAGES,
      plain: everyone,
      empty: 0,
      Admin: ADMIN_PERMISSIONS,
    };
    const createRole = legacy.prepare('INSERT INTO roles (id, name, position, permissions, is_default, created_at) VALUES (?, ?, 1, ?, 0, 1)');
    for (const [id, mask] of Object.entries(masks)) createRole.run(id, id, mask);
    legacy.exec("INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES ('room', 'server', 'Room', 'TEXT', 0, 1)");
    legacy.prepare("INSERT INTO channel_permission_overwrites (channel_id, target_id, role_id, allow_bits, deny_bits) VALUES ('room', 'role:mod', 'mod', ?, ?)")
      .run(Permission.MANAGE_EVENTS | Permission.SEND_MESSAGES, Permission.EMIT_LIVE_ACTIONS);
    legacy.prepare("INSERT INTO channel_permission_overwrites (channel_id, target_id, role_id, allow_bits, deny_bits) VALUES ('room', 'role:plain', 'plain', ?, 0)")
      .run(Permission.MANAGE_EVENTS);
    for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql') && file >= '046_' && file < '048_').sort()) {
      legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1);
    }
    const denied = legacy.prepare("SELECT deny_permissions as deny FROM roles WHERE id = 'mod'").get() as { deny: number };
    assert.equal(denied.deny, Permission.SEND_MESSAGES, 'the 36.1 schema denied what the mask had off');
    legacy.close();
    legacy = undefined;
    connection = await DatabaseConnection.create(filename);
    const roles = new SqliteRoleRepository(connection.getDb());
    for (const [id, mask] of Object.entries(masks)) {
      const role = (await roles.findById(id))!;
      const expected = id === 'Admin' ? mask : (mask & ~everyone) >>> 0;
      assert.equal(role.permissions, expected, `${id} keeps what it granted beyond Everyone`);
      assert.equal(resolveMemberPermissions(everyone, [role]), resolveMemberPermissions(everyone, [{ permissions: expected }]));
    }
    assert.equal(resolveMemberPermissions(everyone, [(await roles.findById('mod'))!]) & Permission.SEND_MESSAGES, Permission.SEND_MESSAGES,
      'a role no longer takes away what Everyone grants');
    const remaining = connection.getDb().prepare('SELECT COUNT(*) as count FROM roles WHERE deny_permissions <> 0').get() as { count: number };
    assert.equal(remaining.count, 0, 'every denial is dropped');
    const room = (await new SqliteChannelRepository(connection.getDb()).findById('room'))!;
    assert.deepEqual(room.permissionOverwrites?.map(rule => [rule.roleId, rule.allow, rule.deny]), [['mod', Permission.SEND_MESSAGES, 0]]);
  } finally {
    legacy?.close();
    connection?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('upgrading role-only overwrite tables preserves rules and member targets survive two restarts', async () => {
  const folder = path.resolve('.qa', `member-permissions-migration-${randomUUID()}`);
  const filename = path.join(folder, 'server.db');
  const migrations = path.join(__dirname, 'infrastructure', 'database', 'migrations');
  let legacy: SqlJsDriver | undefined;
  let connection: DatabaseConnection | undefined;
  try {
    legacy = await SqlJsDriver.create(filename);
    legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql') && file < '043_').sort()) {
      legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1);
    }
    legacy.exec("INSERT INTO server_meta (id, name, password_hash, created_at) VALUES ('server', 'Role rules', '', 1)");
    legacy.exec("INSERT INTO roles (id, name, color, position, permissions, is_default, created_at) VALUES ('same', 'Existing role', NULL, 1, 546576, 0, 1)");
    legacy.exec("INSERT INTO users (id, client_id, nickname, created_at, last_seen_at) VALUES ('same', 'member-client', 'Member', 1, 1)");
    legacy.exec("INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES ('chat', 'server', 'Chat', 'TEXT', 0, 1)");
    legacy.exec("INSERT INTO channel_categories (id, server_id, name, position, created_at) VALUES ('category', 'server', 'Category', 0, 1)");
    legacy.exec("INSERT INTO channel_permission_overwrites VALUES ('chat', 'same', 'same', 256, 0)");
    legacy.exec("INSERT INTO category_permission_overwrites VALUES ('category', '@everyone', NULL, 0, 256)");
    legacy.close();
    legacy = undefined;
    connection = await DatabaseConnection.create(filename);
    let channels = new SqliteChannelRepository(connection.getDb());
    assert.deepEqual((await channels.findById('chat'))?.permissionOverwrites, [{ roleId: 'same', allow: 256, deny: 0 }]);
    assert.deepEqual((await channels.categories.findById('category'))?.permissionOverwrites, [{ roleId: null, allow: 0, deny: 256 }]);
    await channels.update('chat', { permissionOverwrites: [
      { roleId: 'same', allow: 256, deny: 0 }, { userId: 'same', allow: 0, deny: 256 },
    ] });
    await channels.categories.update('category', { permissionOverwrites: [
      { roleId: null, allow: 0, deny: 256 }, { userId: 'same', allow: 256, deny: 0 },
    ] });
    for (let restart = 0; restart < 2; restart++) {
      connection.close();
      connection = await DatabaseConnection.create(filename);
      channels = new SqliteChannelRepository(connection.getDb());
      assert.deepEqual((await channels.findById('chat'))?.permissionOverwrites, [
        { roleId: 'same', allow: 256, deny: 0 }, { userId: 'same', allow: 0, deny: 256 },
      ]);
      assert.deepEqual((await channels.categories.findById('category'))?.permissionOverwrites, [
        { roleId: null, allow: 0, deny: 256 }, { userId: 'same', allow: 256, deny: 0 },
      ]);
    }
    connection.getDb().prepare('DELETE FROM users WHERE id = ?').run('same');
    assert.deepEqual((await channels.findById('chat'))?.permissionOverwrites, [{ roleId: 'same', allow: 256, deny: 0 }]);
    assert.deepEqual((await channels.categories.findById('category'))?.permissionOverwrites, [{ roleId: null, allow: 0, deny: 256 }]);
  } finally {
    legacy?.close();
    connection?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('migration strips server-only bits from channel and category overwrites', async () => {
  const folder = path.resolve('.qa', `server-only-overwrites-${randomUUID()}`);
  const filename = path.join(folder, 'server.db');
  const migrations = path.join(__dirname, 'infrastructure', 'database', 'migrations');
  let legacy: SqlJsDriver | undefined;
  let connection: DatabaseConnection | undefined;
  try {
    legacy = await SqlJsDriver.create(filename);
    legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql') && file < '044_').sort()) {
      legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1);
    }
    legacy.exec("INSERT INTO server_meta (id, name, password_hash, created_at) VALUES ('server', 'Server-only', '', 1)");
    legacy.exec("INSERT INTO roles (id, name, color, position, permissions, is_default, created_at) VALUES ('manager', 'Manager', NULL, 1, 546576, 0, 1)");
    legacy.exec("INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES ('chat', 'server', 'Chat', 'TEXT', 0, 1)");
    legacy.exec("INSERT INTO channel_categories (id, server_id, name, position, created_at) VALUES ('category', 'server', 'Category', 0, 1)");
    legacy.prepare(`INSERT INTO channel_permission_overwrites
      (channel_id, target_id, role_id, user_id, allow_bits, deny_bits) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('chat', '@everyone', null, null, Permission.MANAGE_CHANNELS | Permission.READ_MESSAGES, Permission.MOVE_MEMBERS);
    legacy.prepare(`INSERT INTO category_permission_overwrites
      (category_id, target_id, role_id, user_id, allow_bits, deny_bits) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('category', 'role:manager', 'manager', null, Permission.MOVE_MEMBERS, Permission.MANAGE_CHANNELS);
    legacy.close();
    legacy = undefined;
    connection = await DatabaseConnection.create(filename);
    const channels = new SqliteChannelRepository(connection.getDb());
    assert.deepEqual((await channels.findById('chat'))?.permissionOverwrites, [{ roleId: null, allow: Permission.READ_MESSAGES, deny: 0 }]);
    assert.deepEqual((await channels.categories.findById('category'))?.permissionOverwrites, []);
    assert.equal(record(connection.getDb().prepare('SELECT count(*) AS count FROM category_permission_overwrites').get()).count, 0);
  } finally {
    legacy?.close();
    connection?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('channel Everyone denial is overridden by a role grant, but a second role denial wins; reading stays available', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Channel owner');
  const member = await f.human('Channel reader');
  for (const id of ['writer', 'muted']) {
    await f.roleRepo.create({ id, name: id, color: null, position: 1, permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: 1 });
  }
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'Read only', type: 'TEXT', inheritCategoryPermissions: false,
    permissionOverwrites: [
      { roleId: null, allow: 0, deny: Permission.SEND_MESSAGES },
      { roleId: 'writer', allow: Permission.SEND_MESSAGES, deny: 0 },
      { roleId: 'muted', allow: 0, deny: Permission.SEND_MESSAGES },
    ],
  });
  const channelId = text(record(created.payload.channel).id);
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Visible history' });
  const history = await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  assert.equal(records(history.payload.messages).some(message => message.content === 'Visible history'), true);
  await member.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Denied' }, ProtocolErrorCode.PERMISSION_DENIED);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: member.id, roleId: 'writer' });
  assert.equal((await member.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Allowed by writer' })).type, MessageType.CHAT_MESSAGE);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: member.id, roleId: 'muted' });
  await member.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Conflict denies' }, ProtocolErrorCode.PERMISSION_DENIED);
  await member.peer.error(MessageType.CHAT_REQUEST_UPLOAD_TOKEN, { channelId }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.READ_MESSAGES), true);
  await owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: member.id, roleId: 'muted' });
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.SEND_MESSAGES), true);
});

test('category synchronization and local overrides include action permissions and persist after detaching', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Category owner');
  const member = await f.human('Category reader');
  const saved = await owner.peer.request(MessageType.CATEGORY_CREATE, {
    name: 'Announcements',
    permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.SEND_MESSAGES }],
  });
  const categoryId = text(records(saved.payload.categories).find(category => category.name === 'Announcements')!.id);
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'News', type: 'TEXT', categoryId });
  const channelId = text(record(created.payload.channel).id);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.SEND_MESSAGES), false);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [{ roleId: null, allow: Permission.SEND_MESSAGES, deny: 0 }],
  });
  assert.equal((await f.channelRepo.findById(channelId))?.inheritCategoryPermissions, false);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.SEND_MESSAGES), true);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, inheritCategoryPermissions: true });
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.SEND_MESSAGES), false);
  await owner.peer.request(MessageType.CATEGORY_DELETE, { categoryId });
  assert.equal((await f.channelRepo.findById(channelId))?.categoryId, null);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.SEND_MESSAGES), false);
  await owner.peer.error(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [{ roleId: 'missing', allow: Permission.SEND_MESSAGES, deny: 0 }],
  }, ProtocolErrorCode.BAD_REQUEST);
});

test('visible channels do not broadcast messages to members without read permission', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('History owner');
  const member = await f.human('Hidden history');
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'Hidden messages', type: 'TEXT',
    permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.READ_MESSAGES }],
  });
  const channelId = text(record(created.payload.channel).id);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId), true);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.READ_MESSAGES), false);
  const marker = member.peer.messages.length;
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Must not be broadcast' });
  await member.peer.barrier();
  assert.equal(member.peer.messages.slice(marker).some(message =>
    message.type === MessageType.CHAT_MESSAGE && message.payload.channelId === channelId), false);
  await member.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.deepEqual(await f.chatService.loadHistory(channelId, 50, undefined, undefined, member.id), []);
});

test('channel management is server-level and cannot be delegated by overwrites', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Scoped owner');
  const manager = await f.human('Scoped manager');
  await owner.peer.request(MessageType.CATEGORY_CREATE, { name: 'Hidden category', isPrivate: true });
  await f.roleRepo.create({ id: 'local-manager', name: 'Local manager', permissions: DEFAULT_PERMISSIONS, color: null, position: 1, isDefault: false, createdAt: 1 });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: manager.id, roleId: 'local-manager' });
  await owner.peer.error(MessageType.CATEGORY_CREATE, {
    name: 'Managed category', permissionOverwrites: [{ roleId: 'local-manager', allow: Permission.MANAGE_CHANNELS, deny: 0 }],
  }, ProtocolErrorCode.BAD_REQUEST);
  const saved = await owner.peer.request(MessageType.CATEGORY_CREATE, { name: 'Managed category' });
  const categoryId = text(records(saved.payload.categories).find(category => category.name === 'Managed category')!.id);
  assert.equal(await f.permissions.checkPermission(manager.id, Permission.MANAGE_CHANNELS), false);
  await manager.peer.error(MessageType.CATEGORY_UPDATE, { categoryId, name: 'Denied category' }, ProtocolErrorCode.PERMISSION_DENIED);
  await owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: manager.id, roleId: 'local-manager' });
  await f.roleRepo.create({ id: 'global-manager', name: 'Global manager', permissions: DEFAULT_PERMISSIONS | Permission.MANAGE_CHANNELS,
    color: null, position: 2, isDefault: false, createdAt: 1 });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: manager.id, roleId: 'global-manager' });
  const renamed = await manager.peer.request(MessageType.CATEGORY_UPDATE, { categoryId, name: 'Renamed category' });
  assert.equal(records(renamed.payload.categories).some(category => category.name === 'Renamed category'), true);
  const created = await manager.peer.request(MessageType.CHANNEL_CREATE, { name: 'Managed room', type: 'TEXT', categoryId });
  const channelId = text(record(created.payload.channel).id);
  await manager.peer.request(MessageType.CHANNEL_UPDATE, { channelId, name: 'Renamed room' });
  await manager.peer.request(MessageType.CHANNEL_UPDATE, { channelId, categoryId: null });
  await manager.peer.request(MessageType.CHANNEL_CREATE, { name: 'Outside category', type: 'TEXT' });
});

test('voice admission uses visibility and missing speaking applies a live permission mute', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Voice owner');
  const member = await f.human('Voice member');
  const memberSessionId = text(record(member.auth.payload.currentUser).sessionId);
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'Controlled voice', type: 'VOICE', permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.SPEAK }],
  });
  const channelId = text(record(created.payload.channel).id);
  const joined = await member.peer.request(MessageType.VOICE_JOIN, { channelId });
  assert.equal(record(joined.payload.voiceState).permissionMuted, true);
  await owner.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: member.id, muted: true });
  await owner.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: member.id, muted: false });
  assert.equal(f.wsServer['signalingService'].getVoiceState(memberSessionId)?.permissionMuted, true,
    'administrative unmute does not clear a permission mute');
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, permissionOverwrites: [] });
  await member.peer.wait(message => message.type === MessageType.VOICE_STATE_CHANGED &&
    record(record(message.payload).voiceState).sessionId === memberSessionId &&
    record(record(message.payload).voiceState).permissionMuted === false);
  assert.equal(f.wsServer['signalingService'].getVoiceState(memberSessionId)?.permissionMuted, false);
  assert.equal((await member.peer.request(MessageType.VOICE_JOIN, { channelId })).type, MessageType.VOICE_USER_JOINED);
  const marker = member.peer.messages.length;
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.SPEAK }],
  });
  await member.peer.barrier();
  assert.equal(member.peer.messages.slice(marker).some(message => message.type === MessageType.VOICE_USER_LEFT), false);
  assert.equal(member.peer.messages.slice(marker).some(message =>
    message.type === MessageType.VOICE_STATE_CHANGED &&
    record(record(message.payload).voiceState).permissionMuted === true), true);
  const hiddenMarker = member.peer.messages.length;
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.VIEW_CHANNEL }],
  });
  await member.peer.wait(message => message.type === MessageType.VOICE_STATE_CHANGED &&
    record(record(message.payload).voiceState).sessionId === memberSessionId &&
    record(record(message.payload).voiceState).permissionMuted === false, hiddenMarker);
  assert.equal(f.wsServer['signalingService'].getVoiceState(memberSessionId)?.channelId, channelId,
    'losing the view never drops someone already inside');
  assert.equal(member.peer.messages.slice(hiddenMarker).some(message => message.type === MessageType.VOICE_USER_LEFT ||
    (message.type === MessageType.CHANNEL_DELETED && message.payload.channelId === channelId)), false,
  'the room stays listed while they are inside');
  assert.equal((await member.peer.request(MessageType.VOICE_JOIN, { channelId })).type, MessageType.VOICE_USER_JOINED);
  const leaveMarker = member.peer.messages.length;
  member.peer.send(MessageType.VOICE_LEAVE, { channelId });
  await member.peer.wait(message => message.type === MessageType.CHANNEL_DELETED && message.payload.channelId === channelId, leaveMarker);
  await member.peer.error(MessageType.VOICE_JOIN, { channelId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
});

test('global channel management reorders channels at server level', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Reorder owner');
  const manager = await f.human('Reorder manager');
  await f.roleRepo.create({ id: 'global-manager', name: 'Global manager', permissions: DEFAULT_PERMISSIONS | Permission.MANAGE_CHANNELS,
    color: null, position: 1, isDefault: false, createdAt: 1 });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: manager.id, roleId: 'global-manager' });
  const first = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Protected order', type: 'TEXT' });
  const second = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Other order', type: 'TEXT' });
  const reordered = await manager.peer.request(MessageType.CHANNEL_REORDER, {
    categoryId: null, orderedIds: [text(record(second.payload.channel).id), text(record(first.payload.channel).id)],
  });
  assert.equal(reordered.type, MessageType.CHANNELS_REORDERED);
});

test('moving voice members brings them into rooms they cannot see, which they keep until they leave', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Move owner');
  const member = await f.human('Move member');
  const mover = await f.human('Move helper');
  const memberSessionId = text(record(member.auth.payload.currentUser).sessionId);
  const source = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Source voice', type: 'VOICE' });
  const destination = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Destination voice', type: 'VOICE' });
  const sourceId = text(record(source.payload.channel).id);
  const destinationId = text(record(destination.payload.channel).id);
  await f.roleRepo.create({ id: 'mover', name: 'Mover', permissions: Permission.MOVE_MEMBERS, color: null,
    position: 1, isDefault: false, createdAt: 1 });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: mover.id, roleId: 'mover' });
  await member.peer.request(MessageType.VOICE_JOIN, { channelId: sourceId });
  const hidden = [{ roleId: null, allow: 0, deny: Permission.VIEW_CHANNEL | Permission.SPEAK }];
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: destinationId, permissionOverwrites: hidden });
  await mover.peer.error(MessageType.ADMIN_MOVE_USER, { targetSessionId: memberSessionId, channelId: destinationId },
    ProtocolErrorCode.CHANNEL_NOT_FOUND);
  assert.equal(f.wsServer['signalingService'].getVoiceState(memberSessionId)?.channelId, sourceId,
    'a mover cannot use a room they cannot reach themselves');

  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId: destinationId, permissionOverwrites: [...hidden, { userId: mover.id, allow: Permission.VIEW_CHANNEL, deny: 0 }],
  });
  await member.peer.error(MessageType.VOICE_JOIN, { channelId: destinationId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const marker = member.peer.messages.length;
  const moved = await mover.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: memberSessionId, channelId: destinationId });
  assert.equal(moved.type, MessageType.ADMIN_MOVE_USER);
  await member.peer.wait(message => message.type === MessageType.ADMIN_MOVE_USER, marker);
  const received = member.peer.messages.slice(marker);
  const listed = received.findIndex(message => message.type === MessageType.CHANNEL_CREATED &&
    record(message.payload.channel).id === destinationId);
  assert.ok(listed >= 0 && listed < received.findIndex(message => message.type === MessageType.ADMIN_MOVE_USER),
    'the room is listed before the member is told to follow the move');
  const state = f.wsServer['signalingService'].getVoiceState(memberSessionId);
  assert.equal(state?.channelId, destinationId);
  assert.equal(state?.permissionMuted, true, 'SPEAK still applies to whoever was moved in');
  assert.equal((await member.peer.request(MessageType.VOICE_JOIN, { channelId: destinationId })).type, MessageType.VOICE_USER_JOINED,
    'their client can follow the move into a room it cannot join alone');
  const selectors = await member.peer.request(MessageType.SELECTOR_LIST, { channelId: destinationId });
  assert.ok(Array.isArray(record(selectors.payload).selectors), 'bot controls in the room follow the same presence rules');

  await member.peer.close();
  const back = await f.human('Move member', member.keys, member.deviceId);
  assert.equal(records(record(back.auth.payload.server).channels).some(channel => channel.id === destinationId), true,
    'a dropped connection still finds the room to rejoin');
  assert.equal((await back.peer.request(MessageType.VOICE_JOIN, { channelId: destinationId })).type, MessageType.VOICE_USER_JOINED);

  const leaveMarker = back.peer.messages.length;
  back.peer.send(MessageType.VOICE_LEAVE, { channelId: destinationId });
  await back.peer.wait(message => message.type === MessageType.CHANNEL_DELETED && message.payload.channelId === destinationId, leaveMarker);
  await back.peer.error(MessageType.VOICE_JOIN, { channelId: destinationId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
});

test('live read revocation, scoped reading grants, and direct service sending use the same rules', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Read owner');
  const member = await f.human('Read member');
  await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: EVERYONE_ROLE_ID, permissions: DEFAULT_PERMISSIONS & ~Permission.READ_MESSAGES });
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'Granted history', type: 'TEXT',
    permissionOverwrites: [{ roleId: null, allow: Permission.READ_MESSAGES, deny: 0 }],
  });

  const channelId = text(record(created.payload.channel).id);
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Read locally' });
  assert.equal(records((await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId })).payload.messages).length, 1);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.READ_MESSAGES | Permission.SEND_MESSAGES }],
  });
  const marker = member.peer.messages.length;
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Not delivered after revocation' });
  await member.peer.barrier();
  assert.equal(member.peer.messages.slice(marker).some(message => message.type === MessageType.CHAT_MESSAGE && message.payload.channelId === channelId), false);
  await member.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal((await f.chatService.sendMessage(member.id, channelId, 'Direct send denied')).errorCode, ProtocolErrorCode.PERMISSION_DENIED);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, permissionOverwrites: [{ roleId: null, allow: Permission.READ_MESSAGES, deny: 0 }] });
  assert.equal(records((await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId })).payload.messages).length, 2);
  assert.equal((await f.chatService.sendMessage(member.id, channelId, 'Retired operation', undefined, undefined, undefined, undefined, () => false)).success, false);
  assert.equal(records((await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId })).payload.messages).length, 2);
  await owner.peer.error(MessageType.CHANNEL_UPDATE, {
    channelId, isPrivate: false, permissionOverwrites: [{ roleId: null, allow: 0, deny: Permission.VIEW_CHANNEL }],
  }, ProtocolErrorCode.BAD_REQUEST);
});

test('individual category rules filter login, preserve history access, and win over assigned roles in either direction', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Individual owner');
  const member = await f.human('Individual member');
  const outsider = await f.human('Individual outsider');
  await f.roleRepo.create({ id: 'publisher', name: 'Publisher', color: null, permissions: DEFAULT_PERMISSIONS,
    position: 1, isDefault: false, createdAt: 1 });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: member.id, roleId: 'publisher' });
  const baseRules = [
    { roleId: null, allow: 0, deny: Permission.VIEW_CHANNEL },
    { userId: member.id, allow: Permission.VIEW_CHANNEL, deny: Permission.SEND_MESSAGES },
    { roleId: 'publisher', allow: Permission.SEND_MESSAGES, deny: 0 },
  ];
  const categoryResult = await owner.peer.request(MessageType.CATEGORY_CREATE, {
    name: 'Individual category', permissionOverwrites: baseRules,
  });
  const categoryId = text(records(categoryResult.payload.categories).find(category => category.name === 'Individual category')!.id);
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Individual chat', type: 'TEXT', categoryId });
  const channelId = text(record(created.payload.channel).id);
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Individual history' });
  assert.equal(records((await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId })).payload.messages).length, 1);
  await member.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Member denial wins over a role grant' }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(await f.channelService.canUserAccessChannel(outsider.id, channelId), false);
  const rejoined = await f.human('Individual member', member.keys);
  const snapshot = record(rejoined.auth.payload.server);
  assert.equal(records(snapshot.channels).some(channel => channel.id === channelId), true);
  assert.equal(records(snapshot.categories).some(category => category.id === categoryId), true);
  const outsiderLogin = await f.human('Individual outsider', outsider.keys);
  assert.equal(records(record(outsiderLogin.auth.payload.server).channels).some(channel => channel.id === channelId), false);
  assert.equal(records(record(outsiderLogin.auth.payload.server).categories).some(category => category.id === categoryId), false);
  await owner.peer.request(MessageType.CATEGORY_UPDATE, {
    categoryId, permissionOverwrites: [
      baseRules[0],
      { userId: member.id, allow: Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES, deny: 0 },
      { roleId: 'publisher', allow: 0, deny: Permission.SEND_MESSAGES },
    ],
  });
  await rejoined.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Member grant wins over a role denial' });
  assert.equal(await f.channelService.canUserAccessChannel(outsider.id, channelId), false);
  await f.roleRepo.create({ id: 'muted', name: 'Muted', color: null, permissions: 0, position: 1, isDefault: false, createdAt: 1 });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: outsider.id, roleId: 'publisher' });
  await owner.peer.request(MessageType.CATEGORY_UPDATE, {
    categoryId, permissionOverwrites: [baseRules[0], { roleId: 'publisher', allow: Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES, deny: 0 },
      { roleId: 'muted', allow: 0, deny: Permission.SEND_MESSAGES }],
  });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: outsider.id, roleId: 'muted' });
  assert.equal(await f.channelService.canUserAccessChannel(outsider.id, channelId), true, 'a role allowed in opens the private category');
  assert.equal(await f.channelService.canUserAccessChannel(outsider.id, channelId, Permission.SEND_MESSAGES), false,
    'between roles, a denial wins');
  await owner.peer.request(MessageType.CATEGORY_UPDATE, {
    categoryId, permissionOverwrites: [baseRules[0], { userId: member.id, allow: Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES, deny: 0 }],
  });
  await rejoined.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Individual grant' });
  await owner.peer.request(MessageType.CATEGORY_DELETE, { categoryId });
  const detached = (await f.channelRepo.findById(channelId))!;
  assert.equal(detached.categoryId, null);
  assert.equal(detached.permissionOverwrites?.some(rule => rule.userId === member.id), true);
  assert.equal(await f.channelService.canUserAccessChannel(member.id, channelId, Permission.SEND_MESSAGES), true);
  await owner.peer.error(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [{ userId: 'missing-member', allow: Permission.VIEW_CHANNEL, deny: 0 }],
  }, ProtocolErrorCode.BAD_REQUEST);
  const marker = rejoined.peer.messages.length;
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [baseRules[0], { userId: member.id, allow: Permission.VIEW_CHANNEL, deny: Permission.READ_MESSAGES }],
  });
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Revoked individual read' });
  await rejoined.peer.barrier();
  assert.equal(rejoined.peer.messages.slice(marker).some(message => message.type === MessageType.CHAT_MESSAGE), false);
  await rejoined.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId }, ProtocolErrorCode.PERMISSION_DENIED);
});

test('individual voice speaking denial mutes only its member and individual rules cascade when the member is deleted', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Voice rule owner');
  const member = await f.human('Voice rule member');
  const memberSessionId = text(record(member.auth.payload.currentUser).sessionId);
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Personal voice', type: 'VOICE' });
  const channelId = text(record(created.payload.channel).id);
  await member.peer.request(MessageType.VOICE_JOIN, { channelId });
  const marker = member.peer.messages.length;
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [{ userId: member.id, allow: 0, deny: Permission.SPEAK }],
  });
  await member.peer.barrier();
  assert.equal(member.peer.messages.slice(marker).some(message => message.type === MessageType.VOICE_USER_LEFT), false);
  assert.equal(f.wsServer['signalingService'].getVoiceState(memberSessionId)?.permissionMuted, true);
  assert.equal(member.peer.messages.slice(marker).some(message =>
    message.type === MessageType.VOICE_STATE_CHANGED &&
    record(record(message.payload).voiceState).permissionMuted === true), true);
  assert.equal(await f.channelService.canUserAccessChannel(owner.id, channelId, Permission.SPEAK), true);
  await f.userRepo.delete(member.id);
  assert.deepEqual((await f.channelRepo.findById(channelId))?.permissionOverwrites, []);
});
