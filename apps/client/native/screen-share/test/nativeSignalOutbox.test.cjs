'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeSignalOutbox } = require('../runtime/nativeSignalOutbox.cjs');

class Clock {
  constructor() { this.now = 0; this.next = 1; this.tasks = new Map(); }
  setTimeout = (callback, delay) => {
    const id = this.next++;
    this.tasks.set(id, { callback, due: this.now + delay });
    return id;
  };
  clearTimeout = id => { this.tasks.delete(id); };
  advance(milliseconds) {
    this.now += milliseconds;
    for (const [id, task] of [...this.tasks].sort((left, right) => left[1].due - right[1].due)) {
      if (task.due > this.now) continue;
      this.tasks.delete(id);
      task.callback();
    }
  }
}

const settled = () => new Promise(resolve => setImmediate(resolve));
const control = (sequence, scope = {}) => ({ callId: 'call', channelId: 'channel', connectionId: 'pair-1', generation: 1,
  type: 'ice', sequence, ...scope });

function fixture({ maximumInFlight, current = () => true } = {}) {
  const clock = new Clock(), deliveries = [], failures = [];
  const outbox = new NativeSignalOutbox({
    carrier: (remote, message) => {
      let resolve, reject;
      const acknowledgement = new Promise((yes, no) => { resolve = yes; reject = no; });
      deliveries.push({ remote, message, resolve, reject });
      return acknowledgement;
    },
    onFailure: (error, scope) => failures.push({ error, scope }),
    isCurrent: (remote, message) => current(remote, message), timers: clock, ...(maximumInFlight ? { maximumInFlight } : {}),
  });
  return { clock, deliveries, failures, outbox };
}

test('every message reaches the carrier at once and in order, and sending resolves before any acknowledgement', async () => {
  const f = fixture();
  await Promise.all([1, 2, 3].map(sequence => f.outbox.send('viewer', control(sequence))));
  assert.deepEqual(f.deliveries.map(delivery => delivery.message.sequence), [1, 2, 3]);
  assert.equal(f.clock.tasks.size, 3, 'Each unacknowledged delivery keeps its own deadline.');
  for (const delivery of f.deliveries) delivery.resolve();
  await settled();
  assert.equal(f.clock.tasks.size, 0);
  assert.deepEqual(f.failures, []);
});

test('past its bound the outbox waits for a free slot in order and skips a pair that is no longer current', async () => {
  const gone = new Set();
  const f = fixture({ maximumInFlight: 2, current: (_remote, message) => !gone.has(message.sequence) });
  const sends = [1, 2, 3, 4, 5].map(sequence => f.outbox.send('viewer', control(sequence)));
  const outcomes = sends.map(work => work.then(() => 'sent', error => error.code));
  await settled();
  assert.deepEqual(f.deliveries.map(delivery => delivery.message.sequence), [1, 2]);
  gone.add(4);
  f.deliveries[0].resolve();
  await settled();
  assert.deepEqual(f.deliveries.map(delivery => delivery.message.sequence), [1, 2, 3]);
  f.deliveries[1].resolve();
  await settled();
  assert.deepEqual(f.deliveries.map(delivery => delivery.message.sequence), [1, 2, 3, 5]);
  assert.deepEqual(await Promise.all(outcomes), ['sent', 'sent', 'sent', 'P2P_CANCELLED', 'sent']);
  for (const delivery of f.deliveries.slice(2)) delivery.resolve();
  await settled();
  assert.equal(f.clock.tasks.size, 0);
});

test('a rejected delivery fails only its pair, once, and that pair\'s later messages are refused with it', async () => {
  const f = fixture();
  await f.outbox.send('viewer', control(1));
  await f.outbox.send('other', control(1, { connectionId: 'pair-2' }));
  const failure = Object.assign(new Error('The participant cannot receive this screen.'), { code: 'PERMISSION_DENIED' });
  f.deliveries[0].reject(failure);
  await settled();
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].error, failure);
  assert.deepEqual(f.failures[0].scope, { callId: 'call', channelId: 'channel', remoteSessionId: 'viewer',
    connectionId: 'pair-1', generation: 1 });
  await assert.rejects(f.outbox.send('viewer', control(2)), error => error === failure);
  await f.outbox.send('other', control(2, { connectionId: 'pair-2' }));
  await f.outbox.send('viewer', control(1, { connectionId: 'pair-3', generation: 2 }));
  assert.deepEqual(f.deliveries.map(delivery => [delivery.remote, delivery.message.connectionId]),
    [['viewer', 'pair-1'], ['other', 'pair-2'], ['other', 'pair-2'], ['viewer', 'pair-3']],
    'A replacement pair of the same participant is not refused by an older failure.');
  for (const delivery of f.deliveries.slice(1)) delivery.resolve();
  await settled();
  assert.equal(f.failures.length, 1);
  assert.equal(f.clock.tasks.size, 0);
});

test('an acknowledgement that never arrives is bounded and fails its pair', async () => {
  const f = fixture();
  await f.outbox.send('viewer', control(1));
  f.clock.advance(11999);
  assert.deepEqual(f.failures, []);
  f.clock.advance(1);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].error.code, 'P2P_TIMEOUT');
  assert.equal(f.failures[0].scope.remoteSessionId, 'viewer');
  await assert.rejects(f.outbox.send('viewer', control(2)), { code: 'P2P_TIMEOUT' });
  f.deliveries[0].resolve();
  await settled();
  assert.equal(f.failures.length, 1, 'A late acknowledgement cannot report or revive the failed delivery.');
});

test('closing abandons unacknowledged deliveries without timers and refuses queued and later messages', async () => {
  const f = fixture({ maximumInFlight: 1 });
  await f.outbox.send('viewer', control(1));
  const queued = f.outbox.send('viewer', control(2));
  f.outbox.close();
  await assert.rejects(queued, { code: 'P2P_CANCELLED' });
  await assert.rejects(f.outbox.send('viewer', control(3)), { code: 'P2P_CANCELLED' });
  assert.equal(f.clock.tasks.size, 0);
  f.deliveries[0].reject(new Error('The carrier closed.'));
  await settled();
  assert.deepEqual(f.failures, [], 'A retired endpoint does not report abandoned deliveries.');
  assert.equal(f.deliveries.length, 1);
});
