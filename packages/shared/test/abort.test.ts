import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, linkedSignal, raceSignal } from '../src/abort.js';

/** A signal that counts its live abort listeners, to prove every path removes them. */
function countedSignal(): { controller: AbortController; listeners: () => number } {
  const controller = new AbortController();
  const live = new Set<unknown>();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    live.add(listener);
    add(type, listener, options);
  };
  signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    live.delete(listener);
    remove(type, listener, options);
  };
  return { controller, listeners: () => live.size };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('raceSignal settles like the promise and releases the listener on every path', async () => {
  const resolved = countedSignal();
  assert.equal(await raceSignal(Promise.resolve('value'), resolved.controller.signal), 'value');
  assert.equal(resolved.listeners(), 0);

  const rejected = countedSignal();
  const failure = new Error('failed');
  await assert.rejects(raceSignal(Promise.reject(failure), rejected.controller.signal), (error) => error === failure);
  assert.equal(rejected.listeners(), 0);

  const aborted = countedSignal();
  const pending = deferred<string>();
  const race = raceSignal(pending.promise, aborted.controller.signal);
  const reason = new Error('stopped');
  aborted.controller.abort(reason);
  await assert.rejects(race, (error) => error === reason);
  assert.equal(aborted.listeners(), 0);
  // A rejection after the cancellation stays observed instead of becoming unhandled.
  pending.reject(new Error('late'));
  await tick();

  assert.equal(await raceSignal(Promise.resolve(1), undefined), 1);
});

test('raceSignal lets each caller choose its own rejection, and an aborted signal wins', async () => {
  const controller = new AbortController();
  controller.abort(new Error('original'));
  const mapped = new Error('mapped');
  await assert.rejects(raceSignal(Promise.resolve('ready'), controller.signal, { abortReason: () => mapped }),
    (error) => error === mapped);
  await assert.rejects(raceSignal(Promise.resolve('ready'), controller.signal), /original/);
});

test('raceSignal deadlines reject with their own reason and stop when the promise settles first', async () => {
  const counted = countedSignal();
  const late = deferred<void>();
  const timeout = new Error('timeout');
  await assert.rejects(raceSignal(late.promise, counted.controller.signal, { timeout: { ms: 5, reason: () => timeout } }),
    (error) => error === timeout);
  assert.equal(counted.listeners(), 0);
  late.resolve();

  let fired = false;
  const quick = await raceSignal(Promise.resolve('quick'), undefined, {
    timeout: { ms: 5, reason: () => { fired = true; return new Error('late'); } },
  });
  assert.equal(quick, 'quick');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fired, false, 'the timer is cleared once the promise settles');
});

test('linkedSignal follows its parent, its deadline and its own abort, and detaches on dispose', async () => {
  const parent = countedSignal();
  const followed = linkedSignal(parent.controller.signal);
  assert.equal(parent.listeners(), 1);
  const reason = new Error('parent');
  parent.controller.abort(reason);
  assert.equal(followed.signal.reason, reason);
  followed.dispose();
  assert.equal(parent.listeners(), 0);

  const already = new AbortController();
  already.abort(new Error('before'));
  assert.match(String(linkedSignal(already.signal).signal.reason), /before/);

  const own = countedSignal();
  const manual = linkedSignal(own.controller.signal);
  manual.abort(new Error('own'));
  assert.match(String(manual.signal.reason), /own/);
  assert.equal(own.controller.signal.aborted, false, 'the parent is left alone');
  manual.dispose();
  assert.equal(own.listeners(), 0);

  const timeout = new Error('deadline');
  const timed = linkedSignal(undefined, { ms: 5, reason: () => timeout });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timed.signal.reason, timeout);

  const disposed = linkedSignal(undefined, { ms: 5, reason: () => new Error('never') });
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposed.signal.aborted, false, 'dispose stops the deadline');
});

test('deferred exposes the resolvers of its promise', async () => {
  const value = deferred<number>();
  value.resolve(7);
  assert.equal(await value.promise, 7);
  const failure = deferred<number>();
  failure.reject(new Error('no'));
  await assert.rejects(failure.promise, /no/);
});
