import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { LIMITS, MessageType, Permission, PROTOCOL_VERSION, ProtocolErrorCode } from '@monky/shared';
import { createFixture, identity } from './testFixtures/bots';
import { PasswordService } from './infrastructure/security/PasswordService';
import { RateLimiter } from './infrastructure/security/RateLimiter';

test('authentication cleanup retains the full window and reservations release once', (t) => {
  let now = 54_000;
  t.mock.method(Date, 'now', () => now);
  const limiter = new RateLimiter();
  t.after(() => limiter.dispose());
  for (let i = 0; i < 8; i++) assert.equal(limiter.checkLimit('auth:ip', 8, 60_000), true);
  now = 60_000;
  limiter.cleanup();
  assert.equal(limiter.peek('auth:ip', 8, 60_000), false);
  assert.equal(limiter.reserve('auth:ip', 8, 60_000), null);
  now = 114_000;
  limiter.cleanup();
  const release = limiter.reserve('auth:ip', 1, 60_000);
  assert.ok(release);
  assert.equal(limiter.reserve('auth:ip', 1, 60_000), null);
  release(); release();
  assert.ok(limiter.reserve('auth:ip', 1, 60_000));
});

test('same-IP concurrent authentication is admitted before password derivation', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  await f.serverRepo.updateServer({ passwordHash: PasswordService.hashPassword('fixture') });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = PasswordService.verifyPassword;
  let calls = 0;
  t.mock.method(PasswordService, 'verifyPassword', async (password: string, hash: string) => {
    calls++;
    await gate;
    return original(password, hash);
  });
  const peers = await Promise.all(Array.from({ length: 16 }, () => f.connect()));
  const key = identity().publicKey;
  const responses = peers.map(peer => peer.request(MessageType.AUTH_CONNECT,
    { protocolVersion: PROTOCOL_VERSION, nickname: 'Auth fixture', publicKey: key, password: 'wrong' }));
  try {
    for (let i = 0; i < 100 && calls < 8; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 8);
    for (let i = 0; i < 10; i++) await immediate();
    assert.equal(calls, 8);
  } finally { release(); }
  const results = await Promise.all(responses);
  assert.equal(results.filter(result => result.payload.code === ProtocolErrorCode.AUTH_RATE_LIMITED).length, 8);
  assert.equal(results.filter(result => result.payload.code === ProtocolErrorCode.AUTH_INVALID_PASSWORD).length, 8);
});

test('disconnect during real asynchronous scrypt cannot resurrect a challenge', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  await f.serverRepo.updateServer({ passwordHash: PasswordService.hashPassword('fixture') });
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = PasswordService.verifyPassword;
  t.mock.method(PasswordService, 'verifyPassword', async (password: string, hash: string) => {
    started();
    await gate;
    return original(password, hash);
  });
  const peer = await f.connect();
  peer.send(MessageType.AUTH_CONNECT,
    { protocolVersion: PROTOCOL_VERSION, nickname: 'Disconnect fixture', publicKey: identity().publicKey, password: 'fixture' });
  await entered;
  await peer.close();
  release();
  for (let i = 0; i < 100 && f.rateLimiter['reservations'].size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.authService['pendingChallenges'].size, 0);
  assert.equal(f.authService['challengeTimers'].size, 0);
  assert.equal(f.rateLimiter['reservations'].size, 0);
});

test('valid connections sharing NAT do not consume failure quota', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  await f.serverRepo.updateServer({ maxUsers: 0 });
  for (let i = 0; i < LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS + 2; i++) {
    const human = await f.human(`NAT ${i}`);
    await human.peer.close();
  }
  assert.equal(f.rateLimiter['userMessageTimestamps'].size, 0);
});

test('MANAGE_ROLES cannot promote directly, edit Admin, or grant it as a default', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const moderator = await f.human('Moderator');
  const admin = await f.roleRepo.findByName('Admin');
  assert.ok(admin);
  const role = { id: randomUUID(), name: 'Moderator', color: null, position: 1,
    permissions: Permission.MANAGE_ROLES, isDefault: false, createdAt: Date.now() };
  await f.roleRepo.create(role);
  assert.equal((await f.roleService.assignRole(owner.id, { userId: moderator.id, roleId: role.id })).success, true);
  assert.equal((await f.roleService.assignRole(moderator.id, { userId: moderator.id, roleId: admin.id })).success, false);
  assert.equal((await f.roleService.updateRole(moderator.id, { roleId: admin.id, isDefault: true })).success, false);
  assert.equal((await f.roleService.updateRole(owner.id, { roleId: admin.id, color: '#123456' })).success, true);
  assert.equal((await f.roleService.updateRole(owner.id, { roleId: admin.id, isDefault: true })).success, false);
  await f.roleRepo.update(admin.id, { isDefault: true });
  await f.roleRepo.update(role.id, { isDefault: true });
  await f.roleService.ensureDefaultRolesAssigned(moderator.id);
  assert.equal(await f.permissions.checkPermission(moderator.id, Permission.ADMINISTRATOR), false);
  assert.equal(await f.permissions.checkPermission(moderator.id, Permission.MANAGE_ROLES), true);
});
