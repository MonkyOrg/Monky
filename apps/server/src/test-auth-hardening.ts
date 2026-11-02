import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { randomUUID, sign } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { deriveClientIdFromPublicKey, LIMITS, MessageType, Permission, PROTOCOL_VERSION, ProtocolErrorCode } from '@monky/shared';
import { createFixture, identity, record } from './testFixtures/bots';
import { PasswordService } from './infrastructure/security/PasswordService';
import { RateLimiter } from './infrastructure/security/RateLimiter';
import { MonkyServer } from './server';

async function authenticateWithIdentity(f: Awaited<ReturnType<typeof createFixture>>, keys: ReturnType<typeof identity>, nickname: string) {
  const peer = await f.connect();
  const challenge = await peer.request(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION,
    nickname,
    publicKey: keys.publicKey,
  });
  assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
  const signature = sign(null, Buffer.from(String(challenge.payload.nonce), 'hex'), keys.privateKey).toString('hex');
  return peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature });
}

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

/** 16 wrong passwords at once, each connection sending the given forwarding headers. */
async function wrongPasswordsWithHeaders(
  f: Awaited<ReturnType<typeof createFixture>>, headersOf: (index: number) => Record<string, string>,
): Promise<{ limited: number; refused: number }> {
  await f.serverRepo.updateServer({ passwordHash: PasswordService.hashPassword('fixture') });
  const peers = await Promise.all(Array.from({ length: 16 }, (_, i) => f.connect(headersOf(i))));
  const key = identity().publicKey;
  const results = await Promise.all(peers.map(peer => peer.request(MessageType.AUTH_CONNECT,
    { protocolVersion: PROTOCOL_VERSION, nickname: 'Proxy fixture', publicKey: key, password: 'wrong' })));
  return {
    limited: results.filter(result => result.payload.code === ProtocolErrorCode.AUTH_RATE_LIMITED).length,
    refused: results.filter(result => result.payload.code === ProtocolErrorCode.AUTH_INVALID_PASSWORD).length,
  };
}

test('clients behind a trusted proxy get separate login quotas (#829)', async (t) => {
  const f = await createFixture({ trustedProxies: ['127.0.0.1'] });
  t.after(() => f.dispose());
  const outcome = await wrongPasswordsWithHeaders(f, i => ({ 'x-forwarded-for': i % 2 ? '203.0.113.7' : '198.51.100.9' }));
  assert.deepEqual(outcome, { limited: 0, refused: 16 });
  // Each forwarded client still has its own cap.
  const peer = await f.connect({ 'x-forwarded-for': '203.0.113.7' });
  const again = await peer.request(MessageType.AUTH_CONNECT,
    { protocolVersion: PROTOCOL_VERSION, nickname: 'Proxy fixture', publicKey: identity().publicKey, password: 'wrong' });
  assert.equal(again.payload.code, ProtocolErrorCode.AUTH_RATE_LIMITED);
});

test('forwarding headers from an untrusted socket cannot choose a login quota (#829)', async (t) => {
  // No proxy configured: the default, where every header is a client's word.
  const f = await createFixture();
  t.after(() => f.dispose());
  const outcome = await wrongPasswordsWithHeaders(f, i => ({
    'x-forwarded-for': `203.0.113.${i}`, forwarded: `for=198.51.100.${i}`,
  }));
  assert.deepEqual(outcome, { limited: 8, refused: 8 });
});

test('a client cannot prepend a fake hop in front of a trusted proxy (#829)', async (t) => {
  const f = await createFixture({ trustedProxies: ['127.0.0.1'] });
  t.after(() => f.dispose());
  // The proxy appends the address it saw; whatever the client wrote before it is ignored.
  const outcome = await wrongPasswordsWithHeaders(f, i => ({ 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` }));
  assert.deepEqual(outcome, { limited: 8, refused: 8 });
});

test('bot diagnostics are keyed by the forwarded client too (#829)', async (t) => {
  const f = await createFixture({ trustedProxies: ['127.0.0.1'] });
  t.after(() => f.dispose());
  const diagnostics = f.wsServer['botDiagnostics'];
  assert.ok(diagnostics);
  const requesters: string[] = [];
  const original = diagnostics.diagnose.bind(diagnostics);
  t.mock.method(diagnostics, 'diagnose', (payload: unknown, requesterIp: string) => {
    requesters.push(requesterIp);
    return original(payload, requesterIp);
  });
  const cases: Record<string, string>[] = [{ 'x-forwarded-for': '203.0.113.7' }, {}, { 'x-forwarded-for': 'unknown' }];
  for (const headers of cases) {
    const peer = await f.connect(headers);
    await peer.request(MessageType.BOT_DIAGNOSTIC, { protocolVersion: PROTOCOL_VERSION });
  }
  assert.deepEqual(requesters, ['203.0.113.7', '127.0.0.1', '127.0.0.1']);
});

test('a server refuses to start with a trusted proxy list it cannot read (#829)', async () => {
  // Refused before the data directory is touched.
  const dataDir = path.join(os.tmpdir(), `monky-never-created-${randomUUID()}`);
  await assert.rejects(MonkyServer.create({ port: 0, dataDir, trustedProxies: ['0.0.0.0/0'] }), /would trust every address/);
  await assert.rejects(MonkyServer.create({ port: 0, dataDir, trustedProxies: ['proxy.local'] }), /Invalid trusted proxy "proxy.local"/);
  assert.equal(fs.existsSync(dataDir), false);
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

test('clientId collision with a different stored public key refuses login without overwriting identity', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const attacker = identity();
  const victim = identity();
  const clientId = deriveClientIdFromPublicKey(attacker.publicKey);
  const now = Date.now();
  await f.userRepo.create({
    id: randomUUID(),
    clientId,
    publicKey: victim.publicKey,
    nickname: 'Victim',
    avatarPath: null,
    createdAt: now,
    lastSeenAt: now,
  });
  const response = await authenticateWithIdentity(f, attacker, 'Attacker');
  assert.equal(response.type, MessageType.AUTH_FAILED);
  assert.equal(response.payload.code, ProtocolErrorCode.UNAUTHORIZED);
  const stored = await f.userRepo.findByClientId(clientId);
  assert.equal(stored?.publicKey, victim.publicKey);
  assert.equal(await f.userRepo.findByPublicKey(attacker.publicKey), null);
});

test('clientId fallback only adopts legacy records with no stored public key', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const keys = identity();
  const clientId = deriveClientIdFromPublicKey(keys.publicKey);
  const id = randomUUID();
  const now = Date.now();
  await f.userRepo.create({
    id,
    clientId,
    publicKey: null,
    nickname: 'Legacy',
    avatarPath: null,
    createdAt: now,
    lastSeenAt: now,
  });
  const response = await authenticateWithIdentity(f, keys, 'Legacy Updated');
  assert.equal(response.type, MessageType.AUTH_SUCCESS);
  const stored = await f.userRepo.findById(id);
  assert.equal(stored?.publicKey, keys.publicKey);
  assert.equal((await f.userRepo.findByPublicKey(keys.publicKey))?.id, id);
  assert.equal(await f.userRepo.count(), 1);
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

test('nicknames keep accents and emoji, are stored in NFC and refuse invisible characters (#567)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  // Some keyboards send the accent as a separate combining mark.
  const joao = await f.human('Joa\u0303o 🐒');
  assert.equal(record(joao.auth.payload.currentUser).nickname, 'João 🐒');
  assert.equal((await f.userRepo.findById(joao.id))?.nickname, 'João 🐒');

  const lookalike = await authenticateWithIdentity(f, identity(), 'JOÃO 🐒');
  assert.equal(lookalike.type, MessageType.SERVER_ERROR);
  assert.equal(lookalike.payload.code, ProtocolErrorCode.NICKNAME_ALREADY_EXISTS);

  const renamed = await joao.peer.request(MessageType.USER_CHANGE_NICKNAME, { newNickname: ' Ângela 👩🏽‍💻 ' });
  assert.equal(renamed.type, MessageType.USER_UPDATED);
  assert.equal(record(renamed.payload.user).nickname, 'Ângela 👩🏽‍💻');
  await joao.peer.error(MessageType.USER_CHANGE_NICKNAME, { newNickname: 'Ad\u200Bmin' }, ProtocolErrorCode.NICKNAME_INVALID);
  assert.equal((await f.userRepo.findById(joao.id))?.nickname, 'Ângela 👩🏽‍💻');

  const peer = await f.connect();
  const spoofed = await peer.request(MessageType.AUTH_CONNECT,
    { protocolVersion: PROTOCOL_VERSION, nickname: '\u202Enimda', publicKey: identity().publicKey });
  assert.equal(spoofed.type, MessageType.SERVER_ERROR);
  assert.equal(spoofed.payload.code, ProtocolErrorCode.BAD_REQUEST);
  // Up-to-date clients read the old text as "this server predates accents".
  assert.notEqual(spoofed.payload.message, 'Nickname contém caracteres inválidos');
});
