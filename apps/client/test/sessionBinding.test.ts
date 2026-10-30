import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionStatus } from '../src/renderer/core/NetworkClient';
import { BoundRequests, SessionBinding } from '../src/renderer/core/sessionBinding';

interface MutableStore {
  serverDetails: { id: string } | null;
  currentUser: { id: string; sessionId?: string; isBot?: boolean } | null;
}

function fixture(store: MutableStore = {
  serverDetails: { id: 'server-a' },
  currentUser: { id: 'member', sessionId: 'member:device' },
}) {
  let status: ConnectionStatus = 'CONNECTED';
  let connectionId = 'socket-a';
  let active = true;
  const binding = new SessionBinding(
    { getStatus: () => status, getConnectionId: () => connectionId }, store, () => active,
  );
  return {
    store, binding,
    status: (next: ConnectionStatus) => { status = next; },
    reconnect: () => { connectionId = 'socket-b'; },
    hide: () => { active = false; },
  };
}

test('a binding holds while its server, connection and member stay the same', () => {
  const f = fixture();
  assert.equal(f.binding.serverId, 'server-a');
  assert.equal(f.binding.failure(), null);
  f.store.serverDetails = { id: 'server-a' };
  f.store.currentUser = { id: 'member', sessionId: 'member:device', isBot: false };
  assert.equal(f.binding.failure(), null, 'fresh objects for the same server and member are not a change');
});

test('another server on screen, or another server behind the same store, is serverChanged', () => {
  const hidden = fixture();
  hidden.hide();
  assert.equal(hidden.binding.failure(), 'serverChanged');

  const replaced = fixture();
  replaced.store.serverDetails = { id: 'server-b' };
  assert.equal(replaced.binding.failure(), 'serverChanged');

  const gone = fixture();
  gone.store.serverDetails = null;
  assert.equal(gone.binding.failure(), 'serverChanged');

  const unbound = fixture({ serverDetails: null, currentUser: { id: 'member', sessionId: 'member:device' } });
  assert.equal(unbound.binding.serverId, '');
  assert.equal(unbound.binding.failure(), 'serverChanged', 'a view opened without a server never holds');
});

test('a lost or replaced connection, or another member, is disconnected', () => {
  for (const status of ['RECONNECTING', 'CONNECTING', 'DISCONNECTED'] as const) {
    const f = fixture();
    f.status(status);
    assert.equal(f.binding.failure(), 'disconnected', status);
  }

  const reconnected = fixture();
  reconnected.reconnect();
  assert.equal(reconnected.binding.failure(), 'disconnected', 'the same status on a new socket is another connection');

  const otherMember = fixture();
  otherMember.store.currentUser = { id: 'someone-else', sessionId: 'member:device' };
  assert.equal(otherMember.binding.failure(), 'disconnected');

  const otherDevice = fixture();
  otherDevice.store.currentUser = { id: 'member', sessionId: 'member:other-device' };
  assert.equal(otherDevice.binding.failure(), 'disconnected');

  const signedOut = fixture();
  signedOut.store.currentUser = null;
  assert.equal(signedOut.binding.failure(), 'disconnected');

  const anonymous = fixture({ serverDetails: { id: 'server-a' }, currentUser: { id: 'member' } });
  assert.equal(anonymous.binding.failure(), 'disconnected', 'a member without a session never holds');
  const nobody = fixture({ serverDetails: { id: 'server-a' }, currentUser: null });
  assert.equal(nobody.binding.failure(), 'disconnected');
});

test('leaving the server is reported before losing the connection', () => {
  const f = fixture();
  f.hide();
  f.status('RECONNECTING');
  assert.equal(f.binding.failure(), 'serverChanged');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function requestFixture() {
  const cancelled: string[] = [];
  const sent: Array<{ id: string; result: ReturnType<typeof deferred<string>> }> = [];
  const requests = new BoundRequests({ cancelRequest: (id) => { cancelled.push(id); return true; } });
  const send = () => requests.send((id) => {
    const result = deferred<string>();
    sent.push({ id, result });
    return result.promise;
  });
  return { requests, send, sent, cancelled };
}

test('a bound request is retired once it settles, answered or failed', async () => {
  const f = requestFixture();
  const answered = f.send();
  const failed = f.send();
  assert.equal(f.requests.size, 2);
  assert.notEqual(f.sent[0].id, f.sent[1].id, 'each request has its own id');
  assert.deepEqual(f.cancelled, [], 'nothing is retired while it is out');

  f.sent[0].result.resolve('page');
  assert.equal(await answered, 'page');
  assert.deepEqual(f.cancelled, [f.sent[0].id], 'a late duplicate of an answered request goes nowhere');
  assert.equal(f.requests.size, 1);

  const failure = new Error('timeout');
  f.sent[1].result.reject(failure);
  await assert.rejects(failed, (error) => error === failure, 'the failure reaches the caller unchanged');
  assert.deepEqual(f.cancelled, [f.sent[0].id, f.sent[1].id]);
  assert.equal(f.requests.size, 0);
});

test('cancel retires every request still out, once', async () => {
  const f = requestFixture();
  const first = f.send();
  const second = f.send();
  f.requests.cancel();
  assert.deepEqual(f.cancelled, f.sent.map((request) => request.id));
  assert.equal(f.requests.size, 0);

  f.sent[0].result.resolve('late');
  f.sent[1].result.reject(new Error('closed'));
  assert.equal(await first, 'late');
  await assert.rejects(second);
  assert.equal(f.cancelled.length, 2, 'a request that settles after cancel is not retired again');
});
