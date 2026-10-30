import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DmIncomingBurst } from '../src/renderer/core/dmIncomingBurst';

function setup(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const sounds: number[] = [];
  const toasts: Array<{ peer: string; count: number }> = [];
  const burst = new DmIncomingBurst({
    sound: () => sounds.push(Date.now()),
    toast: (peer, count) => toasts.push({ peer, count }),
  });
  context.after(() => burst.dispose());
  return { burst, sounds, toasts };
}

test('the messages a friend sent while away ring once and end in one "N new messages" toast', (context) => {
  const { burst, sounds, toasts } = setup(context);
  for (let index = 0; index < 15; index += 1) {
    burst.add('alice');
    context.mock.timers.tick(40);
  }
  assert.equal(sounds.length, 1, 'One sound, not fifteen blips on top of each other');
  assert.deepEqual(toasts, [{ peer: 'alice', count: 1 }], 'The first message shows at once');
  context.mock.timers.tick(1_500);
  assert.deepEqual(toasts, [{ peer: 'alice', count: 1 }, { peer: 'alice', count: 15 }]);
  assert.equal(sounds.length, 1);
});

test('a single message rings and shows once, and a later one rings again', (context) => {
  const { burst, sounds, toasts } = setup(context);
  burst.add('alice');
  context.mock.timers.tick(5_000);
  assert.equal(sounds.length, 1);
  assert.deepEqual(toasts, [{ peer: 'alice', count: 1 }], 'No summary for a single message');
  burst.add('alice');
  assert.equal(sounds.length, 2);
});

test('friends writing at the same time get their own toasts but never overlapping sounds', (context) => {
  const { burst, sounds, toasts } = setup(context);
  burst.add('alice');
  burst.add('bob');
  burst.add('bob');
  assert.equal(sounds.length, 1);
  context.mock.timers.tick(1_500);
  assert.deepEqual(toasts, [{ peer: 'alice', count: 1 }, { peer: 'bob', count: 1 }, { peer: 'bob', count: 2 }]);
  burst.add('carol');
  assert.equal(sounds.length, 2, 'Once the window passed, the next friend rings');
});

test('nothing fires after the notifications are unbound', (context) => {
  const { burst, toasts } = setup(context);
  burst.add('alice');
  burst.add('alice');
  burst.dispose();
  context.mock.timers.tick(5_000);
  assert.deepEqual(toasts, [{ peer: 'alice', count: 1 }]);
});
