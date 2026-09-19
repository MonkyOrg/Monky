'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { NativeScreenEndpoint, assertNativeScreenEndpointLocallyClosed } = require('../runtime/nativeEndpoint.cjs');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');

function fixture({ incomplete = false } = {}) {
  let finish, closeCalls = 0;
  const errors = [];
  const closing = new Promise(resolve => { finish = resolve; });
  const engine = {
    ready: Promise.resolve(),
    request: async () => assert.fail('An unwatched receive endpoint cannot allocate transport resources.'),
    cancel() {}, submitFrame() {}, releaseFrame() {},
    close() { closeCalls++; return closing; },
  };
  if (incomplete) delete engine.submitFrame;
  const endpoint = new NativeScreenEndpoint({
    runtime: { rtc: { createEngine: () => engine } }, textures: { importSharedTexture() {}, sendSharedTexture() {} },
    role: 'receive', mode: 'p2p', sessionId: 'viewer', publisherSessionId: 'publisher', channelId: 'channel',
    pipelineId: randomUUID(), source: { shareId: 'screen', instanceId: randomUUID(), audio: false,
      video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } },
    quality: 'source', destination: { frame: { isDestroyed: () => false }, presentationId: randomUUID() },
    send: async () => {}, onError: error => errors.push(error), onState() {}, onDiagnostic() {},
  });
  return { endpoint, engine, errors, finish, closeCalls: () => closeCalls };
}

test('public snapshots and a borrowed closed engine cannot forge local endpoint retirement', async () => {
  const engine = { request: async () => ({}), close: async () => ({ closed: true }) };
  const commands = new NativeRtcCommands(engine);
  await commands.closeEngine();
  assert.throws(() => assertNativeScreenEndpointLocallyClosed({
    engine, commands, closed: true, nativeClosed: true, snapshot: () => ({ closed: true, nativeClosed: true }),
  }), /original native screen endpoint/);
});

test('local retirement waits for its own native close and ignores writable success-shaped fields', async () => {
  const f = fixture();
  await f.endpoint.ready;
  f.endpoint.nativeClosed = true;
  f.endpoint.closed = true;
  assert.throws(() => assertNativeScreenEndpointLocallyClosed(f.endpoint), /retains local media/);
  const closing = f.endpoint.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closeCalls(), 1);
  assert.throws(() => assertNativeScreenEndpointLocallyClosed(f.endpoint), /retains local media/);
  f.finish({ closed: true });
  await closing;
  assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
  assert.deepEqual(f.errors, []);
});

test('composition failure after native allocation returns a failed owner with a genuine cleanup path', async () => {
  const f = fixture({ incomplete: true });
  await assert.rejects(f.endpoint.ready, /Native presentation requires/);
  const closing = f.endpoint.close();
  f.finish({ closed: true });
  await closing;
  assert.equal(f.closeCalls(), 1);
  assert.equal(f.errors.length, 1);
  assert.doesNotThrow(() => assertNativeScreenEndpointLocallyClosed(f.endpoint));
});
