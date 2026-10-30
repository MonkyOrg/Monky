import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ClientLogEntry } from '@monky/shared';
import { EventBus, appEvents } from '../src/renderer/core/EventBus';

/** Events of the buses these tests build. */
interface FixtureEvents {
  'session.activated': void;
  update: string;
  refresh: void;
  'voice.frequent': void;
  'voice.other': void;
}

function captureClientLog(context: TestContext): ClientLogEntry[] {
  const written: ClientLogEntry[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { writeClientLog: async (entry: ClientLogEntry) => { written.push(entry); } } },
  });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return written;
}

test('rebinding a view during a shared event dispatches each listener only once', () => {
  const events = new EventBus<FixtureEvents>();
  let persistent = 0;
  let renders = 0;
  let unbind = () => {};
  events.on('session.activated', () => { persistent++; });
  const bind = () => {
    unbind = events.on('session.activated', () => {
      renders++;
      if (renders < 3) {
        unbind();
        bind();
      }
    });
  };
  bind();
  events.emit('session.activated');
  assert.equal(persistent, 1);
  assert.equal(renders, 1);
  events.emit('session.activated');
  assert.equal(persistent, 2);
  assert.equal(renders, 2);
});

test('listeners added during dispatch start receiving the next event', () => {
  const events = new EventBus<FixtureEvents>();
  const received: string[] = [];
  const added = (value: string) => { received.push(`added:${value}`); };
  events.on('update', (value: string) => {
    received.push(`original:${value}`);
    events.on('update', added);
  });
  events.emit('update', 'first');
  assert.deepEqual(received, ['original:first']);
  events.emit('update', 'second');
  assert.deepEqual(received, ['original:first', 'original:second', 'added:second']);
});

test('listeners removed before their turn do not run', () => {
  const events = new EventBus<FixtureEvents>();
  let removedCalls = 0;
  let removeLater = () => {};
  events.on('refresh', () => { removeLater(); });
  removeLater = events.on('refresh', () => { removedCalls++; });
  events.emit('refresh');
  assert.equal(removedCalls, 0);
});

test('a failed listener is reported without preventing other listeners', (context) => {
  const events = new EventBus<FixtureEvents>();
  const failure = new Error('Fixture listener failure');
  const logged = context.mock.method(console, 'error', () => {});
  const written = captureClientLog(context);
  let received = 0;
  events.on('refresh', () => { throw failure; });
  events.on('refresh', () => { received++; });
  events.emit('refresh');
  assert.equal(received, 1);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0].arguments[1], failure);
  assert.equal(written.length, 1);
  assert.equal(written[0].level, 'ERROR');
  assert.equal(written[0].category, 'APP');
  assert.equal(written[0].message, 'Event handler failed');
  assert.equal(written[0].data?.event, 'refresh');
  assert.equal(written[0].data?.error, 'Fixture listener failure');
  assert.equal(typeof written[0].data?.stack, 'string');
});

test('a handler failing on every event writes a few entries per window and then counts what it left out', (context) => {
  context.mock.method(console, 'error', () => {});
  const written = captureClientLog(context);
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const events = new EventBus<FixtureEvents>();
  events.on('voice.frequent', () => { throw new Error('Always fails'); });
  events.on('voice.other', () => { throw 'plain value'; });
  for (let index = 0; index < 10; index++) events.emit('voice.frequent');
  events.emit('voice.other');
  const frequent = () => written.filter(entry => entry.data?.event === 'voice.frequent');
  assert.equal(frequent().length, EventBus.HANDLER_ERROR_LOG_LIMIT);
  assert.equal(frequent().some(entry => 'skipped' in (entry.data ?? {})), false);
  // Another event has its own allowance; a thrown value that is not an Error is still described.
  assert.deepEqual(written.filter(entry => entry.data?.event === 'voice.other').map(entry => entry.data),
    [{ event: 'voice.other', error: 'plain value' }]);

  now += EventBus.HANDLER_ERROR_LOG_WINDOW_MS;
  events.emit('voice.frequent');
  assert.equal(frequent().length, EventBus.HANDLER_ERROR_LOG_LIMIT + 1);
  assert.equal(frequent().at(-1)?.data?.skipped, 10 - EventBus.HANDLER_ERROR_LOG_LIMIT);
  events.emit('voice.frequent');
  assert.equal(frequent().at(-1)?.data?.skipped, undefined);
});

// Checked by `tsc` only: a name or payload that disagrees with the event map does not compile.
export function eventMapContract(events: EventBus<FixtureEvents>): void {
  events.emit('refresh');
  events.emit('update', 'value');
  events.on('update', (value) => value.toUpperCase());
  // @ts-expect-error an event missing from the map
  events.on('session.activatd', () => {});
  // @ts-expect-error the payload of another type
  events.emit('update', 1);
  // @ts-expect-error a payload the event requires
  events.emit('update');
  // @ts-expect-error a `void` event carries nothing
  events.emit('refresh', 'value');
  // @ts-expect-error a subscriber expecting another payload
  events.on('update', (value: number) => value);

  // The app bus: server messages carry the protocol payload; the rest is unknown.
  appEvents.on('message.USER_LEFT', (payload) => payload.userId.length);
  appEvents.on('message.SERVER_STATE', (payload: unknown) => payload);
  // @ts-expect-error SERVER_STATE has no payload in the protocol map
  appEvents.on('message.SERVER_STATE', (payload: { userId: string }) => payload);
  // @ts-expect-error the notice only takes a reason the user can be told (R-SHELL-8)
  appEvents.emit('native_screen.source_failed', { reason: 'runtime' });
}