'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');
const { NativeCommandLedger } = require('../runtime/nativeCommandLedger.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const results = new Map(), cancellations = [];
  const engine = {
    request(id) {
      const result = deferred();
      results.set(id, result);
      return result.promise;
    },
    cancel(id) { cancellations.push(id); },
    close: async () => ({ closed: true }),
  };
  const commands = new NativeRtcCommands(engine);
  return { engine, commands, ledger: new NativeCommandLedger(engine, commands), results, cancellations };
}

test('every native request Promise carries the immutable ID it consumed, including a synchronous failure', async () => {
  const f = fixture();
  const first = f.commands.request('peer.getStats', 7, {});
  const second = f.commands.request('peer.getStats', 7, {});
  assert.deepEqual([first.requestId, second.requestId], [1, 2]);
  assert.throws(() => { first.requestId = 9; }, TypeError);
  assert.equal(Object.keys(first).includes('requestId'), false);
  f.engine.request = () => { throw new Error('Native dispatch failed.'); };
  const failed = f.commands.request('peer.getStats', 7, {});
  assert.equal(failed.requestId, 3);
  await assert.rejects(failed, /dispatch failed/u);
  assert.equal(f.commands.getPendingRequest(3), null);
  f.results.get(1).resolve({ reports: [] });
  f.results.get(2).resolve({ reports: [] });
  await Promise.all([first, second]);
});

test('a ledger cancels only its exact pending command, never a finished one or another command under a forged ID', async () => {
  const f = fixture();
  const issued = f.ledger.issue('sfu.createTransport', 3, { direction: 'send' });
  assert.equal(issued.id, 1);
  const command = { id: issued.id, operation: 'sfu.createTransport', target: 3, data: { direction: 'send' } };
  assert.equal(f.ledger.cancel({ ...command, data: { direction: 'recv' } }), false);
  assert.equal(f.ledger.cancel({ ...command, target: 4 }), false);
  assert.equal(f.ledger.cancel(command), true);
  assert.deepEqual(f.cancellations, [1]);
  f.results.get(1).resolve({ transportId: 11 });
  await issued.completion;
  assert.equal(f.ledger.cancel(command), false, 'A completed command has nothing left to cancel.');
  assert.deepEqual(f.cancellations, [1]);

  const separate = f.commands.request('peer.create', 0, { syncGroup: 'call' });
  const request = f.commands.request.bind(f.commands);
  f.commands.request = (operation, target, data) => {
    const forged = request(operation, target, data).then(value => value);
    Object.defineProperty(forged, 'requestId', { value: separate.requestId });
    return forged;
  };
  assert.equal(f.ledger.issue('sfu.load', 0, {}).id, null);
  f.results.get(2).resolve({ peerId: 5 });
  f.results.get(3).resolve({ deviceId: 6 });
  await separate;
});

test('a cancellation that lost the race to completion is not an error, while any other failure is', () => {
  const f = fixture();
  const { id } = f.ledger.issue('peer.setPublicationEnabled', 8, { enabled: false });
  const command = { id, operation: 'peer.setPublicationEnabled', target: 8, data: { enabled: false } };
  for (const error of [{ code: 'ERR_RTC_REQUEST_ID', status: 4 }, { code: 'ERR_RTC_UNKNOWN_REQUEST' },
    { code: 'ERR_RTC_NOT_FOUND' }, { code: 'NOT_FOUND' }]) {
    f.engine.cancel = () => { throw Object.assign(new Error('Request is no longer pending'), error); };
    assert.equal(f.ledger.cancel(command), false);
  }
  f.engine.cancel = () => { throw Object.assign(new Error('Owned host failed.'), { code: 'ERR_RTC_HOST_EXIT' }); };
  assert.throws(() => f.ledger.cancel(command), /Owned host failed/u);
  f.results.get(id).resolve({ enabled: false });
});

test('retirement ends every wait at once, even over a result resolved in the same turn, and only with the private proof', async () => {
  const f = fixture();
  const answered = f.ledger.untilRetired(Promise.resolve('reports'));
  assert.deepEqual(await answered, { retired: false, value: 'reports' });
  const own = new Error('Native failure.');
  await assert.rejects(f.ledger.untilRetired(Promise.reject(own)), error => error === own);

  const late = deferred(), lateResult = deferred();
  const waiting = [f.ledger.untilRetired(late.promise), f.ledger.untilRetired(lateResult.promise)];
  assert.equal(f.ledger.waiting, 2);
  assert.throws(() => f.ledger.proveRetired(), /has not been proven/u);
  assert.equal(f.ledger.retired, false);
  await f.commands.closeEngine();
  lateResult.resolve('delivered after the proof');
  f.ledger.proveRetired();
  assert.equal(f.ledger.retired, true);
  assert.deepEqual(await Promise.all(waiting), [{ retired: true }, { retired: true }]);
  assert.equal(f.ledger.waiting, 0);
  late.reject(new Error('A rejection after retirement is not reported.'));
  assert.deepEqual(await f.ledger.untilRetired(Promise.reject(new Error('stale'))), { retired: true });
});

test('a ledger requires the engine and its own command registry', () => {
  const f = fixture(), other = fixture();
  assert.throws(() => new NativeCommandLedger(f.engine, other.commands), /NativeRtcCommands/u);
  assert.throws(() => new NativeCommandLedger(f.engine, {}), /NativeRtcCommands/u);
});
