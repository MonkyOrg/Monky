import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { LocalConsentDecision, LocalExecutionSubject } from '@monky/shared';
import { LocalPermissions, localPermissionId } from '../src/main/localExecution/LocalPermissions';
import { LocalExecutionError } from '../src/main/localExecution/errors';

const subject: LocalExecutionSubject = {
  serverOrigin: 'wss://example.test', serverId: 'server', serverName: 'Server',
  botId: 'bot', botName: 'Music bot', botPublicKey: `302a300506032b6570032100${'ab'.repeat(32)}`,
  connectionId: 'connection',
};
const capability = 'youtube-audio';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error('Deferred was not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext): Promise<{ root: string; filename: string; permissions: LocalPermissions }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-local-permissions-'));
  const filename = path.join(root, 'permissions.json');
  const permissions = new LocalPermissions(filename);
  t.after(async () => {
    await permissions.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  await permissions.initialize();
  return { root, filename, permissions };
}

function reason(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof LocalExecutionError && error.reason === expected;
}

test('stored permission is bound to origin, server, bot installation and identity, not display names', async (t) => {
  const { permissions, filename } = await fixture(t);
  const id = await permissions.authorize(1, subject, capability, new AbortController().signal, async () => 'always');
  assert.equal(await permissions.assertAllowed(2, {
    ...subject, connectionId: 'reconnected', botName: 'New name', serverName: 'Renamed server',
  }, capability), id);
  for (const changed of [
    { serverOrigin: 'wss://other.test' }, { serverId: 'other' }, { botId: 'other' },
    { botPublicKey: `302a300506032b6570032100${'cd'.repeat(32)}` },
  ]) {
    await assert.rejects(permissions.assertAllowed(1, { ...subject, ...changed }, capability), reason('permission_denied'));
  }
  const restarted = new LocalPermissions(filename);
  try {
    assert.equal(await restarted.assertAllowed(3, subject, capability), id);
  } finally {
    await restarted.dispose();
  }
  assert.equal(localPermissionId({ ...subject, serverOrigin: 'WSS://EXAMPLE.test:443/' }, capability), id);
});

test('connection consent is isolated to the owner and connection and never persisted', async (t) => {
  const { permissions, filename } = await fixture(t);
  const id = await permissions.authorize(1, subject, capability, new AbortController().signal, async () => 'connection');
  assert.equal(await permissions.assertAllowed(1, subject, capability), id);
  await assert.rejects(permissions.assertAllowed(2, subject, capability), reason('permission_denied'));
  await assert.rejects(permissions.assertAllowed(1, { ...subject, connectionId: 'other' }, capability), reason('permission_denied'));
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  permissions.cancelConnection(1, subject.connectionId);
  await assert.rejects(permissions.assertAllowed(1, subject, capability), reason('permission_denied'));
  assert.deepEqual(await permissions.list(), []);
});

test('denial is remembered without repeated prompts; only explicit settings approval can re-enable it', async (t) => {
  const { permissions } = await fixture(t);
  let prompts = 0;
  const confirm = async (): Promise<LocalConsentDecision> => { prompts++; return 'deny'; };
  await assert.rejects(permissions.authorize(1, subject, capability, new AbortController().signal, confirm), reason('permission_denied'));
  await assert.rejects(permissions.authorize(1, subject, capability, new AbortController().signal, confirm), reason('permission_denied'));
  assert.equal(prompts, 1);
  const id = localPermissionId(subject, capability);
  assert.equal(await permissions.enable(id, new AbortController().signal, async () => false), false);
  await assert.rejects(permissions.assertAllowed(1, subject, capability), reason('permission_denied'));
  assert.equal(await permissions.enable(id, new AbortController().signal, async () => true), true);
  assert.equal(await permissions.assertAllowed(1, subject, capability), id);
});

test('concurrent requests share the native prompt and cancelling one does not cancel another', async (t) => {
  const { permissions } = await fixture(t);
  const answer = deferred<LocalConsentDecision>();
  const started = deferred<void>();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let prompts = 0;
  let confirmationSignal: AbortSignal | undefined;
  const confirm = async (_bot: unknown, _capability: unknown, signal: AbortSignal): Promise<LocalConsentDecision> => {
    prompts++;
    confirmationSignal = signal;
    started.resolve();
    return answer.promise;
  };
  const first = permissions.authorize(1, subject, capability, firstController.signal, confirm);
  const second = permissions.authorize(1, subject, capability, secondController.signal, confirm);
  await started.promise;
  firstController.abort(new LocalExecutionError('cancelled'));
  await assert.rejects(first, reason('cancelled'));
  assert.equal(prompts, 1);
  assert.equal(confirmationSignal?.aborted, false);
  answer.resolve('always');
  assert.equal(await second, localPermissionId(subject, capability));
  assert.equal((await permissions.list())[0]?.decision, 'always');
});

test('last waiter cancellation prevents late approval and disposal does not wait for a stale dialog', async (t) => {
  const { permissions, filename } = await fixture(t);
  const answer = deferred<LocalConsentDecision>();
  const started = deferred<void>();
  const controller = new AbortController();
  const pending = permissions.authorize(1, subject, capability, controller.signal, async () => {
    started.resolve();
    return answer.promise;
  });
  await started.promise;
  controller.abort(new LocalExecutionError('cancelled'));
  await assert.rejects(pending, reason('cancelled'));
  await permissions.dispose();
  answer.resolve('always');
  await Promise.resolve();
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
});

test('revocation invalidates an outstanding approval and persists denial before a restart', async (t) => {
  const { permissions, filename } = await fixture(t);
  const answer = deferred<LocalConsentDecision>();
  const started = deferred<void>();
  const pending = permissions.authorize(1, subject, capability, new AbortController().signal, async () => {
    started.resolve();
    return answer.promise;
  });
  const rejected = assert.rejects(pending, reason('permission_revoked'));
  await started.promise;
  await permissions.revoke(localPermissionId(subject, capability));
  answer.resolve('always');
  await rejected;
  assert.equal((await permissions.list())[0]?.decision, 'deny');
  const restarted = new LocalPermissions(filename);
  try {
    await assert.rejects(restarted.assertAllowed(1, subject, capability), reason('permission_denied'));
  } finally {
    await restarted.dispose();
  }
});

test('connection loss prevents delayed native approval without revoking existing permanent rights', async (t) => {
  const { permissions } = await fixture(t);
  const answer = deferred<LocalConsentDecision>();
  const started = deferred<void>();
  const pending = permissions.authorize(1, subject, capability, new AbortController().signal, async () => {
    started.resolve();
    return answer.promise;
  });
  const rejected = assert.rejects(pending, reason('executor_unavailable'));
  await started.promise;
  permissions.cancelConnection(1, subject.connectionId);
  answer.resolve('always');
  await rejected;
  assert.deepEqual(await permissions.list(), []);
  await permissions.authorize(1, subject, capability, new AbortController().signal, async () => 'always');
  permissions.cancelOwner(1);
  assert.equal(await permissions.assertAllowed(2, subject, capability), localPermissionId(subject, capability));
});

test('removing a capability revokes persistent, temporary and still-pending authorizations', async (t) => {
  const { permissions } = await fixture(t);
  const other = { ...subject, botId: 'other' };
  const pendingBot = { ...subject, botId: 'pending' };
  await permissions.authorize(1, subject, capability, new AbortController().signal, async () => 'always');
  await permissions.authorize(1, other, capability, new AbortController().signal, async () => 'connection');
  const started = deferred<void>();
  const answer = deferred<LocalConsentDecision>();
  const pending = permissions.authorize(1, pendingBot, capability, new AbortController().signal, async () => {
    started.resolve();
    return answer.promise;
  });
  const rejected = assert.rejects(pending, reason('permission_revoked'));
  await started.promise;
  await permissions.revokeCapability(capability);
  answer.resolve('always');
  await rejected;
  const list = await permissions.list();
  assert.equal(list.length, 3);
  assert.ok(list.every((entry) => entry.decision === 'deny'));
  for (const bot of [subject, other, pendingBot]) {
    await assert.rejects(permissions.authorize(1, bot, capability, new AbortController().signal, async () => {
      assert.fail('Revoked tools must not be silently authorized again');
    }), reason('permission_revoked'));
  }
});

test('corrupt or forged permission files fail closed and are not replaced with empty defaults', async (t) => {
  const { root } = await fixture(t);
  const filename = path.join(root, 'corrupt.json');
  await fs.writeFile(filename, '{ broken');
  const corrupt = new LocalPermissions(filename);
  await assert.rejects(corrupt.list(), reason('storage_failed'));
  assert.equal(await fs.readFile(filename, 'utf8'), '{ broken');
  const forgedFile = path.join(root, 'forged.json');
  await fs.writeFile(forgedFile, JSON.stringify({
    version: 1,
    permissions: [{
      id: '0'.repeat(64), bot: {
        serverOrigin: subject.serverOrigin, serverId: subject.serverId, serverName: subject.serverName,
        botId: subject.botId, botName: subject.botName, botPublicKey: subject.botPublicKey,
      }, capability, decision: 'always', updatedAt: Date.now(),
    }],
  }));
  const forged = new LocalPermissions(forgedFile);
  await assert.rejects(forged.assertAllowed(1, subject, capability), reason('storage_failed'));
  await corrupt.dispose();
  await forged.dispose();
});

test('a transient permission-file access failure can be reread without replacing saved decisions', async (t) => {
  const { permissions, filename } = await fixture(t);
  await permissions.authorize(1, subject, capability, new AbortController().signal, async () => 'always');
  const saved = await fs.readFile(filename, 'utf8');
  const reader = new LocalPermissions(filename);
  t.after(() => reader.dispose());
  const open = fs.open.bind(fs);
  let inaccessible = true;
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => {
    if (inaccessible && args[0] === filename) throw Object.assign(new Error('Controlled permission-file lock'), { code: 'EACCES' });
    return open(...args);
  });
  await assert.rejects(reader.list(), reason('storage_failed'));
  inaccessible = false;
  assert.deepEqual(await reader.list(), await permissions.list());
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
});

test('a failed permission-file validation cannot retain a partial grant across a retry', async (t) => {
  const { permissions, root } = await fixture(t);
  await permissions.authorize(1, subject, capability, new AbortController().signal, async () => 'always');
  const [valid] = await permissions.list();
  const filename = path.join(root, 'partial.json');
  await fs.writeFile(filename, JSON.stringify({ version: 1, permissions: [valid, { ...valid, id: '0'.repeat(64) }] }));
  const reader = new LocalPermissions(filename);
  t.after(() => reader.dispose());
  await assert.rejects(reader.list(), reason('storage_failed'));
  await fs.writeFile(filename, JSON.stringify({ version: 1, permissions: [] }));
  assert.deepEqual(await reader.list(), []);
  await assert.rejects(reader.assertAllowed(1, subject, capability), reason('permission_denied'));
});

test('unknown permission IDs and invalid owners cannot create authorizations', async (t) => {
  const { permissions } = await fixture(t);
  await assert.rejects(permissions.revoke('unknown'), reason('invalid_request'));
  await assert.rejects(permissions.enable('unknown', new AbortController().signal, async () => true), reason('invalid_request'));
  await assert.rejects(permissions.authorize(0, subject, capability, new AbortController().signal, async () => 'always'), reason('invalid_request'));
  assert.deepEqual(await permissions.list(), []);
});

test('permission files cannot import a hard-linked grant store from another location', async (t) => {
  const { permissions, root, filename } = await fixture(t);
  await permissions.authorize(1, subject, capability, new AbortController().signal, async () => 'always');
  const linked = path.join(root, 'linked.json');
  await fs.link(filename, linked);
  const other = new LocalPermissions(linked);
  await assert.rejects(other.assertAllowed(1, subject, capability), reason('storage_failed'));
  await other.dispose();
});
