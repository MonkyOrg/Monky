'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativePcmCaptureHub } = require('../runtime/nativePcmCaptureHub.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function fixture({ stopGate, closedGate } = {}) {
  const captures = [], errors = [];
  const selection = { includeWindowId: 101 };
  const captureModule = {
    createPacketCapture(options, onEvent) {
      assert.deepEqual(options, selection);
      const ready = deferred(), closed = deferred();
      const capture = {
        sessionId: `capture-${captures.length + 1}`, stopping: false, closed: false, stops: 0, onEvent,
        ready: ready.promise,
        closedPromise: closed.promise,
        getStats() { return { state: this.closed ? 'closed' : this.stopping ? 'stopping' : 'capturing', sessionId: this.sessionId }; },
        async stop() {
          this.stops++;
          this.stopping = true;
          if (stopGate) await stopGate.promise;
          void (async () => {
            if (closedGate) await closedGate.promise;
            this.closed = true;
            closed.resolve(this.getStats());
          })();
          return this.getStats();
        },
      };
      captures.push(capture);
      const event = { type: 'ready', sessionId: capture.sessionId, format: { sampleRate: 48000, channels: 2 } };
      onEvent(event);
      ready.resolve(event);
      return { ready: ready.promise, closed: closed.promise, stop: () => capture.stop(), getStats: () => capture.getStats() };
    },
  };
  const hub = new NativePcmCaptureHub(captureModule, selection, error => errors.push(error));
  return { captures, errors, hub, selection, captureModule };
}

test('one owned capture fans out the original packets to multiple real subscriptions', async () => {
  const f = fixture();
  const a = [], b = [];
  assert.equal(f.captures.length, 0);
  const first = f.hub.subscribe(f.selection, event => a.push(event));
  const second = f.hub.subscribe(f.selection, event => b.push(event));
  await Promise.all([first.ready, second.ready]);
  assert.equal(f.captures.length, 1);
  const packet = { type: 'packet', pcm: Buffer.alloc(3840), sequence: 19, frameIndex: 9120 };
  f.captures[0].onEvent(packet);
  assert.equal(a.at(-1), packet);
  assert.equal(b.at(-1), packet);
  await first.detach();
  assert.equal(f.captures[0].stops, 0);
  assert.equal(first.getStats().detached, true);
  assert.equal(first.getStats().captureClosed, false, 'Detaching one subscriber is not native capture closure.');
  f.captures[0].onEvent({ ...packet, sequence: 20 });
  assert.equal(a.at(-1).sequence, 19);
  assert.equal(b.at(-1).sequence, 20);
  await second.detach();
  await f.hub.waitUntilIdle();
  assert.equal(f.captures[0].stops, 1);
  assert.equal(second.getStats().captureClosed, true);
  await f.hub.close();
  assert.equal(f.hub.getStats().closed, true);
  assert.deepEqual(f.errors, []);
});

test('last detach waits for the actual capture closed promise, not the stop method result', async () => {
  const closedGate = deferred();
  const f = fixture({ closedGate });
  const subscription = f.hub.subscribe(f.selection, () => {});
  await subscription.ready;
  let detached = false;
  const stopping = subscription.detach().then(() => { detached = true; });
  await tick();
  assert.equal(detached, false);
  assert.equal(subscription.getStats().captureClosed, false);
  closedGate.resolve();
  await stopping;
  assert.equal(subscription.getStats().captureClosed, true);
  await f.hub.close();
});

test('Retry uses actual PCM closure instead of replaying a rejected stop forever', async () => {
  const f = fixture();
  const subscription = f.hub.subscribe(f.selection, () => {});
  await subscription.ready;
  const capture = f.captures[0], stop = capture.stop.bind(capture);
  capture.stop = async () => {
    await stop();
    throw new Error('Stop reported an error after its owned capture closed');
  };
  await assert.rejects(f.hub.close(), /ownership did not retire/);
  assert.equal(capture.closed, true);
  assert.equal(subscription.getStats().detached, false);
  await f.hub.close();
  await f.hub.waitUntilIdle();
  assert.equal(f.hub.getStats().closed, true);
  assert.equal(capture.stops, 1, 'An already proven native closure needs no second stop request.');
  assert.ok(f.errors.length > 0, 'The first stop failure must remain observable.');
});

test('a replacement rendition does not inherit a retired capture owner rejected stop', async () => {
  const f = fixture();
  const first = f.hub.subscribe(f.selection, () => {});
  await first.ready;
  const capture = f.captures[0], stop = capture.stop.bind(capture);
  capture.stop = async () => { await stop(); throw new Error('Stop diagnostic after closure'); };
  await assert.rejects(first.detach(), /Stop diagnostic/);
  await first.detach();
  await f.hub.waitUntilIdle();
  const replacement = f.hub.subscribe(f.selection, () => {});
  await replacement.ready;
  assert.equal(f.captures.length, 2);
  assert.equal(first.getStats().captureClosed, true);
  assert.equal(replacement.getStats().captureClosed, false);
  await replacement.detach();
  await f.hub.close();
});

test('packet delivery waits for every subscriber admission, not just callback invocation', async () => {
  const f = fixture(), a = deferred(), b = deferred();
  const first = f.hub.subscribe(f.selection, event => event.type === 'packet' ? a.promise : undefined);
  const second = f.hub.subscribe(f.selection, event => event.type === 'packet' ? b.promise : undefined);
  await Promise.all([first.ready, second.ready]);
  const admission = f.captures[0].onEvent({ type: 'packet', sequence: 1 });
  assert.equal(typeof admission?.then, 'function');
  let admitted = false;
  void admission.then(() => { admitted = true; });
  a.resolve();
  await tick();
  assert.equal(admitted, false);
  b.resolve();
  await admission;
  assert.equal(admitted, true);
  await f.hub.close();
  assert.deepEqual(f.errors, []);
});

test('detaching one rendition releases only its delivery wait while the other keeps its credit', async () => {
  const f = fixture(), a = deferred(), b = deferred();
  const first = f.hub.subscribe(f.selection, event => event.type === 'packet' ? a.promise : undefined);
  const second = f.hub.subscribe(f.selection, event => event.type === 'packet' ? b.promise : undefined);
  await Promise.all([first.ready, second.ready]);
  const admission = f.captures[0].onEvent({ type: 'packet', sequence: 1 });
  assert.equal(typeof admission?.then, 'function');
  let admitted = false;
  void admission.then(() => { admitted = true; });
  await first.detach();
  await tick();
  assert.equal(admitted, false);
  assert.equal(f.captures[0].stops, 0);
  b.resolve();
  await admission;
  assert.equal(first.getStats().captureClosed, false);
  a.resolve();
  await second.detach();
  await f.hub.close();
  assert.deepEqual(f.errors, []);
});

test('a new rendition waits for the last capture retirement before creating a new capture', async () => {
  const stopGate = deferred();
  const f = fixture({ stopGate });
  const old = f.hub.subscribe(f.selection, () => {});
  await old.ready;
  const retiring = old.detach();
  const current = f.hub.subscribe(f.selection, () => {});
  await tick();
  assert.equal(f.captures.length, 1);
  stopGate.resolve();
  await Promise.all([retiring, current.ready]);
  assert.equal(f.captures.length, 2);
  assert.equal(f.captures[0].closed, true);
  assert.equal(f.captures[1].closed, false);
  await current.detach();
  await f.hub.close();
});

test('detaching during a pending restart cannot start an unowned capture later', async () => {
  const stopGate = deferred();
  const f = fixture({ stopGate });
  const first = f.hub.subscribe(f.selection, () => {});
  await first.ready;
  const stopping = first.detach();
  const second = f.hub.subscribe(f.selection, () => {});
  await second.detach();
  stopGate.resolve();
  await stopping;
  await assert.rejects(second.ready, { name: 'AbortError' });
  assert.equal(f.captures.length, 1);
  await f.hub.close();
});

test('capture identity and the four-rendition limit cannot be replaced by a subscriber', async () => {
  const f = fixture();
  assert.ok(NativePcmCaptureHub.matches(f.hub, f.captureModule, f.selection));
  assert.equal(NativePcmCaptureHub.matches({}, f.captureModule, f.selection), false);
  assert.equal(NativePcmCaptureHub.matches(f.hub, {}, f.selection), false);
  assert.throws(() => f.hub.subscribe({ includeWindowId: 102 }, () => {}));
  const subscriptions = Array.from({ length: 4 }, () => f.hub.subscribe(f.selection, () => {}));
  await Promise.all(subscriptions.map(value => value.ready));
  assert.throws(() => f.hub.subscribe(f.selection, () => {}), /four/);
  await f.hub.close();
  assert.equal(f.captures[0].stops, 1);
  assert.throws(() => f.hub.subscribe(f.selection, () => {}), /closed/);
});

test('a trusted window process identity is validated and remains part of subscriber ownership', async () => {
  const captureModule = { createPacketCapture() { assert.fail('Validation must not acquire capture.'); } };
  for (const expectedProcessId of [0, -1, 1.5, 0x100000000, NaN]) {
    assert.throws(() => new NativePcmCaptureHub(captureModule,
      { includeWindowId: 101, expectedProcessId }, () => {}));
  }
  assert.throws(() => new NativePcmCaptureHub(captureModule, { expectedProcessId: 42 }, () => {}));
  const selection = { includeWindowId: 101, expectedProcessId: 42 };
  const hub = new NativePcmCaptureHub(captureModule, selection, () => {});
  assert.ok(NativePcmCaptureHub.matches(hub, captureModule, selection));
  assert.equal(NativePcmCaptureHub.matches(hub, captureModule, { ...selection, expectedProcessId: 43 }), false);
  assert.throws(() => hub.subscribe({ includeWindowId: 101 }, () => {}));
  await hub.close();
});
