'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { within, notifyObserver } = require('../runtime/asyncTools.cjs');

test('within settles like its own promise and rejects with its message only after the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await within(Promise.resolve('done'), 50, 'Too late.'), 'done');
  const ownFailure = new Error('Own failure.');
  await assert.rejects(within(Promise.reject(ownFailure), 50, 'Too late.'), error => error === ownFailure);
  let settled = false;
  const pending = within(new Promise(() => {}), 50, 'Retirement did not finish.');
  void pending.catch(() => {}).finally(() => { settled = true; });
  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, /^Error: Retirement did not finish\.$/u);
});

test('within refuses a deadline that is not a duration instead of timing out at once', async () => {
  // The old boundedCleanup(promise, message, ms) order passed to within(promise, ms, message).
  for (const milliseconds of ['Retirement did not finish.', undefined, -1, NaN, Infinity]) {
    await assert.rejects(within(Promise.resolve('done'), milliseconds, 'Retirement did not finish.'), TypeError);
  }
  assert.equal(await within(Promise.resolve('done'), 0, 'Too late.'), 'done');
});

test('notifyObserver delivers every argument and logs synchronous or asynchronous observer failures', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...values) => logged.push(values));
  const received = [];
  notifyObserver('Recording observer', (...args) => { received.push(args); }, 'error', { shareId: 'screen-1' });
  assert.deepEqual(received, [['error', { shareId: 'screen-1' }]]);
  const thrown = new Error('Synchronous observer failure.');
  assert.doesNotThrow(() => notifyObserver('Throwing observer', () => { throw thrown; }));
  const rejected = new Error('Asynchronous observer failure.');
  notifyObserver('Rejecting observer', async () => { throw rejected; });
  notifyObserver('Quiet observer', async () => 'handled');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(logged, [['Throwing observer failed:', thrown], ['Rejecting observer failed:', rejected]]);
});
