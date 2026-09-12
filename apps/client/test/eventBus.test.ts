import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/renderer/core/EventBus';

test('rebinding a view during a shared event dispatches each listener only once', () => {
  const events = new EventBus();
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
  const events = new EventBus();
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
  const events = new EventBus();
  let removedCalls = 0;
  let removeLater = () => {};
  events.on('update', () => { removeLater(); });
  removeLater = events.on('update', () => { removedCalls++; });
  events.emit('update');
  assert.equal(removedCalls, 0);
});

test('a failed listener is reported without preventing other listeners', (context) => {
  const events = new EventBus();
  const failure = new Error('Fixture listener failure');
  const logged = context.mock.method(console, 'error', () => {});
  let received = 0;
  events.on('update', () => { throw failure; });
  events.on('update', () => { received++; });
  events.emit('update');
  assert.equal(received, 1);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0].arguments[1], failure);
});
