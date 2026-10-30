import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  AUTOMATIC_REWATCH_DELAYS_MS, RewatchPolicy, SOURCE_REPLACEMENT_GRACE_MS, presentedWatchState, rewatchStep,
  type RewatchEntry,
} from '../src/renderer/core/webrtc/nativeScreen/RewatchPolicy';
import type { NativeScreenWatchState } from '../src/renderer/core/webrtc/nativeScreen/RemoteScreenPresentations';

const broken: NativeScreenWatchState = { state: 'unavailable', reason: 'connection-failed' };
const retired: NativeScreenWatchState = { state: 'unavailable', reason: 'source-unavailable' };
const KEY = 'publisher\0screen';

interface Entry extends RewatchEntry {
  state: NativeScreenWatchState;
  readonly attempt: number;
}

const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };

/** One Watch of a call: every restart replaces its presentation with a new attempt that fails again by default. */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const presentations = new Map<string, Entry>();
  const restarted: Entry[] = [];
  const state = { ended: false, wanted: true, changes: 0, next: broken };
  const policy = new RewatchPolicy<Entry>({
    ended: () => state.ended,
    presentation: key => presentations.get(key),
    wanted: () => state.wanted,
    restart: async entry => {
      restarted.push(entry);
      presentations.set(KEY, { state: state.next, attempt: entry.attempt + 1 });
    },
    changed: () => { state.changes++; },
  });
  const show = (entry: Entry): Entry => { presentations.set(KEY, entry); return entry; };
  const current = (): Entry => {
    const entry = presentations.get(KEY);
    assert.ok(entry);
    return entry;
  };
  return { policy, presentations, restarted, state, show, current };
}

test('a picture starts the attempts over; only a broken connection is watched again, a bounded number of times', () => {
  assert.deepEqual(rewatchStep({ state: 'playing' }, { attempts: 2, pending: false }), { kind: 'reset' });
  assert.deepEqual(rewatchStep({ state: 'connecting' }, undefined), { kind: 'keep' });
  assert.deepEqual(rewatchStep(retired, undefined), { kind: 'keep' }, 'A replaced source waits for its replacement instead.');
  for (const reason of ['unsupported', 'capture-failed', 'capacity-exceeded'] as const)
    assert.deepEqual(rewatchStep({ state: 'unavailable', reason }, undefined), { kind: 'keep' }, `${reason} is not retried on its own.`);
  AUTOMATIC_REWATCH_DELAYS_MS.forEach((delayMs, attempts) =>
    assert.deepEqual(rewatchStep(broken, { attempts, pending: false }), { kind: 'retry', attempt: attempts + 1, delayMs }));
  assert.deepEqual(rewatchStep(broken, { attempts: AUTOMATIC_REWATCH_DELAYS_MS.length, pending: false }), { kind: 'keep' });
  assert.deepEqual(rewatchStep(broken, { attempts: 0, pending: true }), { kind: 'keep' }, 'One attempt at a time.');
});

test('a failure still being handled reads as reconnecting, never as an error with a retry action', () => {
  assert.deepEqual(presentedWatchState(broken, true), { state: 'connecting' });
  assert.equal(presentedWatchState(broken, false), broken);
  const playing: NativeScreenWatchState = { state: 'playing' };
  assert.equal(presentedWatchState(playing, true), playing);
});

test('a broken connection is watched again after each delay, then left to the manual retry', async t => {
  const f = fixture(t);
  f.policy.outcome(KEY, f.show({ state: broken, attempt: 0 }));
  for (const [index, delay] of AUTOMATIC_REWATCH_DELAYS_MS.entries()) {
    assert.deepEqual(f.policy.presented(KEY, f.current()), { state: 'connecting' }, 'A pending attempt reads as reconnecting.');
    t.mock.timers.tick(delay - 1);
    assert.equal(f.restarted.length, index, `Attempt ${index + 1} waits its whole delay.`);
    t.mock.timers.tick(1);
    assert.equal(f.restarted.length, index + 1);
    await flush();
  }
  assert.equal(f.current().attempt, AUTOMATIC_REWATCH_DELAYS_MS.length);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.restarted.length, AUTOMATIC_REWATCH_DELAYS_MS.length, 'A persistent failure stops reconnecting on its own.');
  assert.deepEqual(f.policy.presented(KEY, f.current()), broken, 'Then the viewer sees the failure and its retry action.');
});

test('a picture between attempts gives the next drop the first delay again', async t => {
  const f = fixture(t);
  f.policy.outcome(KEY, f.show({ state: broken, attempt: 0 }));
  f.state.next = { state: 'connecting' };
  t.mock.timers.tick(AUTOMATIC_REWATCH_DELAYS_MS[0]);
  await flush();
  const replacement = f.current();
  replacement.state = { state: 'playing' };
  f.policy.outcome(KEY, replacement);
  replacement.state = broken;
  f.policy.outcome(KEY, replacement);
  t.mock.timers.tick(AUTOMATIC_REWATCH_DELAYS_MS[0] - 1);
  assert.equal(f.restarted.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.restarted.length, 2, 'The attempts started over with the picture.');
});

test('a pending reconnection is abandoned when the Watch ends, is replaced or the call retires', async t => {
  const f = fixture(t);
  f.policy.outcome(KEY, f.show({ state: broken, attempt: 0 }));
  f.state.wanted = false;
  t.mock.timers.tick(AUTOMATIC_REWATCH_DELAYS_MS[0]);
  assert.equal(f.restarted.length, 0, 'An ended Watch is never restarted by a stale reconnection.');
  assert.equal(f.state.changes, 1);
  assert.deepEqual(f.policy.presented(KEY, f.current()), broken);

  f.state.wanted = true;
  const manual = f.show({ state: broken, attempt: 10 });
  f.policy.outcome(KEY, manual);
  f.show({ state: { state: 'connecting' }, attempt: 11 });
  t.mock.timers.tick(AUTOMATIC_REWATCH_DELAYS_MS[1]);
  assert.equal(f.restarted.length, 0, 'A manual retry already replaced the presentation.');

  f.policy.outcome(KEY, f.show({ state: broken, attempt: 20 }));
  f.policy.end(f.presentations.values());
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.restarted.length, 0, 'A retired call cancels its pending reconnection.');

  f.state.ended = true;
  f.policy.outcome(KEY, f.show({ state: broken, attempt: 30 }));
  t.mock.timers.tick(60_000);
  assert.equal(f.restarted.length, 0, 'Nothing is scheduled for a call that ended.');
});

test('a replaced source reads as reconnecting during its grace, once per presentation', t => {
  const f = fixture(t);
  const entry = f.show({ state: retired, attempt: 0 });
  f.policy.awaitReplacement(entry);
  assert.deepEqual(f.policy.presented(KEY, entry), { state: 'connecting' });
  t.mock.timers.tick(SOURCE_REPLACEMENT_GRACE_MS - 1);
  assert.deepEqual(f.policy.presented(KEY, entry), { state: 'connecting' });
  t.mock.timers.tick(1);
  assert.equal(f.state.changes, 1, 'The stage learns that the grace ended.');
  assert.deepEqual(f.policy.presented(KEY, entry), retired, 'A source that stays gone becomes a failure.');
  f.policy.awaitReplacement(entry);
  assert.deepEqual(f.policy.presented(KEY, entry), retired, 'The grace runs once per presentation.');

  const stopped = f.show({ state: { state: 'connecting' }, attempt: 1 });
  f.policy.endReplacement(stopped);
  stopped.state = retired;
  f.policy.awaitReplacement(stopped);
  assert.deepEqual(f.policy.presented(KEY, stopped), retired, 'A presentation being replaced starts no grace.');

  const broken2 = f.show({ state: broken, attempt: 2 });
  f.policy.awaitReplacement(broken2);
  assert.equal(broken2.replacementGrace, undefined, 'Only a replaced source gets the grace.');
});
