import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Permission, type ServerDetails } from '@monky/shared';
import { ServerSettingsOperations } from '../src/renderer/views/serverSettings/ServerSettingsOperations';
import { serverSettingsValidationError } from '../src/renderer/views/serverSettings/serverSettingsValidation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture() {
  let current = true;
  let allowed = true;
  const counts: number[] = [];
  const operations = new ServerSettingsOperations({
    validate: (permission) => {
      if (!current) throw new Error('Session changed');
      if (permission !== undefined && !allowed) throw new Error('Permission denied');
    },
    changed: () => { counts.push(operations.pendingCount); },
    errorMessage: (error) => error instanceof Error ? error.message : 'Apply failed',
  });
  return {
    operations, counts, switchSession: () => { current = false; },
    revoke: () => { allowed = false; }, restore: () => { allowed = true; },
  };
}

test('every dismissal stays locked from enqueue through the actual last acknowledgement, across tabs', async () => {
  const f = fixture();
  const turn = deferred<void>();
  const role = deferred<void>();
  const sends: string[] = [];
  const first = f.operations.run('turn', 'TURN', Permission.MANAGE_SERVER, async () => {
    sends.push('turn');
    await turn.promise;
  });
  const second = f.operations.run('role', 'Role', Permission.MANAGE_ROLES, async () => {
    sends.push('role');
    await role.promise;
  });
  assert.equal(f.operations.pendingCount, 2, 'queued work locks synchronously, before the socket sends');
  assert.deepEqual(sends, []);
  await flush();
  assert.deepEqual(sends, ['turn']);
  assert.equal(f.operations.pendingCount, 2, 'sending or switching tabs is not completion');
  turn.resolve();
  await first;
  await flush();
  assert.equal(f.operations.pendingCount, 1);
  assert.deepEqual(sends, ['turn', 'role']);
  role.resolve();
  assert.equal((await second).ok, true);
  assert.equal(f.operations.pendingCount, 0);
  assert.deepEqual(f.counts, [1, 2, 1, 0]);
});

test('failed operations do not unlock unrelated work or poison retries; errors never imply success', async () => {
  const f = fixture();
  const first = deferred<void>();
  const other = deferred<void>();
  const rejected = f.operations.run('name', 'Name', Permission.MANAGE_SERVER, () => first.promise);
  const pending = f.operations.run('bot', 'Bot', Permission.MANAGE_BOTS, () => other.promise);
  first.reject(new Error('Rejected by the server'));
  assert.deepEqual(await rejected, { ok: false, message: 'Rejected by the server' });
  assert.equal(f.operations.pendingCount, 1);
  assert.equal(f.operations.failures[0]?.key, 'name');
  other.resolve();
  await pending;
  assert.equal(f.operations.pendingCount, 0, 'a rejected operation cannot trap the operator forever');
  const retry = f.operations.run('name', 'Name', Permission.MANAGE_SERVER, async () => 'Confirmed');
  assert.equal(f.operations.failures.length, 0, 'retry clears the old error');
  assert.deepEqual(await retry, { ok: true, value: 'Confirmed' });
});

test('rapid same-field edits remain ordered and never mark the last value applied early', async () => {
  const f = fixture();
  let persisted = false;
  const acknowledgements = [deferred<void>(), deferred<void>(), deferred<void>()];
  const values = [true, false, true];
  const requests = values.map((value, index) => f.operations.run('turn', 'TURN', Permission.MANAGE_SERVER, async () => {
    await acknowledgements[index].promise;
    persisted = value;
  }));
  for (const [index, ack] of acknowledgements.entries()) {
    assert.equal(f.operations.isPending('turn'), true);
    ack.resolve();
    await requests[index];
    assert.equal(persisted, values[index]);
    assert.equal(f.operations.pendingCount, values.length - index - 1);
  }
  assert.equal(f.operations.isPending('turn'), false);
});

test('queued edits recheck session and permissions before sending, without touching a replacement session', async () => {
  for (const invalidate of ['session', 'permission']) {
    const f = fixture();
    const acknowledgement = deferred<void>();
    const inFlight = f.operations.run('turn', 'TURN', Permission.MANAGE_SERVER, () => acknowledgement.promise);
    let sent = false;
    const queued = f.operations.run('role', 'Role', Permission.MANAGE_ROLES, async () => { sent = true; });
    await flush();
    if (invalidate === 'session') f.switchSession();
    else f.revoke();
    assert.equal(f.operations.pendingCount, 2, 'in-flight work remains genuinely pending after invalidation');
    acknowledgement.resolve();
    await inFlight;
    const result = await queued;
    assert.equal(result.ok, false);
    assert.equal(sent, false);
    assert.equal(f.operations.pendingCount, 0);
  }
});

test('permission restoration enables correction; a queued retry clears an earlier failure on execution', async () => {
  const f = fixture();
  const error = deferred<void>();
  const first = f.operations.run('name', 'Name', Permission.MANAGE_SERVER, () => error.promise);
  const retry = f.operations.run('name', 'Name', Permission.MANAGE_SERVER, async () => 'New name');
  error.reject(new Error('Bad first edit'));
  assert.equal((await first).ok, false);
  assert.equal((await retry).ok, true);
  assert.deepEqual(f.operations.failures, []);
  f.revoke();
  assert.equal((await f.operations.run('role', 'Role', Permission.MANAGE_ROLES, async () => {})).ok, false);
  f.restore();
  assert.equal((await f.operations.run('role', 'Role', Permission.MANAGE_ROLES, async () => {})).ok, true);
});

function server(overrides: Partial<ServerDetails> = {}): ServerDetails {
  return {
    id: 'server', name: 'Server', createdAt: 1, maxUsers: 0,
    channels: [], members: [], voiceStates: {}, voiceMode: 'p2p',
    attachmentStorage: { usedBytes: 0, maxFileBytes: 10, maxTotalBytes: 100 },
    ...overrides,
  };
}

test('per-field validation uses current persisted prerequisites and does not resubmit unrelated settings', () => {
  const s = server();
  assert.equal(serverSettingsValidationError({ name: 'A' }, s), 'serverSettings.nameInvalid');
  assert.equal(serverSettingsValidationError({ name: '  Good name  ' }, s), null);
  assert.equal(serverSettingsValidationError({ password: '   ' }, s), 'serverSettings.passwordInvalid');
  assert.equal(serverSettingsValidationError({ password: null }, s), null);
  assert.equal(serverSettingsValidationError({ maxAttachmentFileBytes: 101 }, s), 'serverSettings.limitError');
  assert.equal(serverSettingsValidationError({ maxAttachmentStorageBytes: 9 }, s), 'serverSettings.limitError');
  for (const value of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(serverSettingsValidationError({ maxAttachmentFileBytes: value }, s), 'serverSettings.storageLimitInvalid');
  }
  assert.equal(serverSettingsValidationError({ name: 'Rename only' }, server({ voiceMode: 'sfu' })), null);
});

test('membership validation counts registered people and never truncates fractional limits', () => {
  const member = { id: 'alice', clientId: 'alice-key', nickname: 'Alice', status: 'ONLINE' as const, joinedAt: 1 };
  const s = server({ members: [member, { ...member, sessionId: 'phone' }] });
  assert.equal(serverSettingsValidationError({ maxUsers: 1 }, s), null);
  const known = server({ ...s, knownMembers: [member, { ...member, id: 'bob', status: 'DISCONNECTED' }] });
  assert.equal(serverSettingsValidationError({ maxUsers: 1 }, known), 'serverSettings.memberLimitBelowCurrent');
  assert.equal(serverSettingsValidationError({ maxUsers: 0 }, known), null);
  assert.equal(serverSettingsValidationError({ maxUsers: 2 }, known, 3), 'serverSettings.memberLimitBelowCurrent');
  for (const value of [-1, NaN, 2.1, Infinity]) {
    assert.equal(serverSettingsValidationError({ maxUsers: value }, known), 'serverSettings.memberLimitInvalid');
  }
});

test('TURN respects unknown support, unsupported hosts, install privileges and current SFU mode', () => {
  const enabling = { turnEnabled: true };
  assert.equal(serverSettingsValidationError(enabling, server()), 'serverSettings.turnUnknownSupport');
  assert.equal(serverSettingsValidationError(enabling, server({ turnAvailability: { supported: false, reason: 'unsupported-platform' } })), 'serverSettings.turnUnsupportedPlatform');
  assert.equal(serverSettingsValidationError(enabling, server({ turnAvailability: { supported: false, reason: 'not-installed' } })), 'serverSettings.turnNotInstalled');
  assert.equal(serverSettingsValidationError(enabling, server({ turnAvailability: { supported: false, reason: 'not-installed', autoInstallable: true } })), null);
  assert.equal(serverSettingsValidationError(enabling, server({ turnAvailability: { supported: true } })), null);
  assert.equal(serverSettingsValidationError(enabling, server({ voiceMode: 'sfu', turnAvailability: { supported: true } })), 'serverSettings.turnBlockedBySfu');
  assert.equal(serverSettingsValidationError({ turnEnabled: false }, server({ voiceMode: 'sfu' })), null);
});
