import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { requestIdle } from '../src/renderer/utils/idleCallback';

function withIdleCallbacks(
  request: typeof globalThis.requestIdleCallback | undefined,
  cancel: typeof globalThis.cancelIdleCallback | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const saved = [Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback'), Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')] as const;
  const set = (name: 'requestIdleCallback' | 'cancelIdleCallback', value: unknown, original?: PropertyDescriptor) => {
    if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    else if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  };
  set('requestIdleCallback', request);
  set('cancelIdleCallback', cancel);
  return run().finally(() => {
    set('requestIdleCallback', undefined, saved[0]);
    set('cancelIdleCallback', undefined, saved[1]);
  });
}

test('without requestIdleCallback (Safari) idle work still runs, in short slices (#883)', () => withIdleCallbacks(undefined, undefined, async () => {
  assert.equal(typeof globalThis.requestIdleCallback, 'undefined');
  const slices: number[] = [];
  requestIdle((deadline) => slices.push(deadline.timeRemaining()));
  await sleep(20);
  assert.equal(slices.length, 1);
  assert.ok(slices[0] > 0 && slices[0] <= 8, `slice of ${slices[0]} ms`);

  let ran = false;
  const cancel = requestIdle(() => { ran = true; });
  cancel();
  await sleep(20);
  assert.equal(ran, false, 'a cancelled task never runs');
}));

test('the native requestIdleCallback is used where it exists', () => {
  const requested: IdleRequestCallback[] = [];
  const cancelled: number[] = [];
  const request = (callback: IdleRequestCallback) => requested.push(callback);
  const cancel = (handle: number) => { cancelled.push(handle); };
  return withIdleCallbacks(request, cancel, async () => {
    const callback: IdleRequestCallback = () => {};
    requestIdle(callback)();
    assert.deepEqual(requested, [callback]);
    assert.deepEqual(cancelled, [1]);
  });
});
