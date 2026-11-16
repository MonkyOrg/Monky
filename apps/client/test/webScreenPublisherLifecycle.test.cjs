'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');
const { randomUUID } = require('node:crypto');

const filename = path.resolve(__dirname, '..', 'src', 'renderer', 'platform', 'web', 'webScreen', 'webScreenPublisher.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleExports = { exports: {} };
vm.runInNewContext(`(function(exports,require,module){${code}\n})`, { console, DOMException, crypto })(moduleExports.exports,
  request => request === '@monky/shared' ? shared : {}, moduleExports);
const { WebScreenPublisher } = moduleExports.exports;

function fixture() {
  const notice = Promise.withResolvers(), signals = [];
  const source = { shareId: 'browser', instanceId: randomUUID() };
  const publisher = new WebScreenPublisher({
    call: { sessionId: 'host', channelId: 'room' }, source,
    signal: value => { signals.push(value); return notice.promise; },
  });
  const track = () => ({ readyState: 'live', stop() { this.readyState = 'ended'; } });
  const video = track(), audio = track();
  publisher.pipelines.set('source', {
    id: randomUUID(), key: 'source', video, audio, viewers: new Map(), ready: Promise.resolve(), closing: null, sfu: null,
  });
  publisher.viewers.set('viewer', {
    sessionId: 'viewer', subscriptionId: randomUUID(), quality: 'source', backend: 'browser', generation: 1,
    peer: null, pipeline: null, retirement: null, retiring: false, setup: null,
  });
  return { publisher, video, audio, notice, signals, track };
}

test('publisher stops cloned video/audio synchronously before a slow close ACK, and close is idempotent', async () => {
  const f = fixture();
  const closing = f.publisher.close();
  assert.equal(f.video.readyState, 'ended');
  assert.equal(f.audio.readyState, 'ended');
  assert.equal(f.publisher.close(), closing);
  assert.equal(f.signals.length, 1);
  assert.equal(f.signals[0].action, 'closed');
  f.notice.resolve(); await closing;
  assert.equal(f.publisher.pipelines.size, 0);
  assert.equal(f.publisher.viewers.size, 0);
});

test('publisher normal server withdrawal stops media without sending an unavailable notice', async () => {
  const f = fixture();
  await f.publisher.close('source-unavailable', false);
  assert.equal(f.video.readyState, 'ended');
  assert.equal(f.audio.readyState, 'ended');
  assert.deepEqual(f.signals, []);
  assert.equal(f.publisher.pipelines.size, 0);
});

test('publisher teardown also retires a rendition whose asynchronous setup finishes after close', async () => {
  const f = fixture(), pending = Promise.withResolvers();
  const late = f.track();
  f.publisher.pending.add(pending.promise.then(() => {
    f.publisher.pipelines.set('late', {
      id: randomUUID(), key: 'late', video: late, audio: null,
      viewers: new Map(), ready: Promise.resolve(), closing: null, sfu: null,
    });
  }));
  const closing = f.publisher.close('source-unavailable', false);
  assert.equal(f.video.readyState, 'ended');
  pending.resolve(); await closing;
  assert.equal(late.readyState, 'ended');
  assert.equal(f.publisher.pipelines.size, 0);
});

const compile = (file, imports) => {
  const source = path.resolve(__dirname, '..', 'src', 'renderer', 'platform', 'web', 'webScreen', file);
  const output = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(exports,require,module){${output}\n})`, { console, DOMException, crypto })(module.exports,
    request => request === '@monky/shared' ? shared : imports(request), module);
  return module.exports;
};

/** A publisher whose connections are spies, sharing a capture that keeps `size` after `applyConstraints`. */
function scaledFixture(mode, size, constraints = Promise.resolve()) {
  const peers = [], renditions = [];
  const profile = compile('browserScreenProfile.ts', () => ({ runsOnWebKit: () => false }));
  const { WebScreenPublisher: Publisher } = compile('webScreenPublisher.ts', request => {
    if (request === './browserScreenProfile') return profile;
    if (request === './browserScreenPeer') return { BrowserScreenPeer: class { constructor(options) { peers.push(options); } } };
    if (request === './screenP2pPublisherPeer') return { ScreenP2pPublisherPeer: class { start() {} close() { return Promise.resolve(); } } };
    if (request === './webScreenSfuRendition') return { WebScreenSfuRendition: class {
      constructor(options) { renditions.push(options); this.ready = Promise.resolve(); }
      close() { return Promise.resolve(); }
    } };
    return {};
  });
  const copy = {
    readyState: 'live', applyConstraints: () => constraints, getSettings: () => size,
    stop() { this.readyState = 'ended'; },
  };
  const source = {
    shareId: 'browser', instanceId: randomUUID(), audio: false, codec: 'h264',
    video: { width: 328, height: 720, fps: 30, maxBitrateKbps: 2500 },
  };
  const publisher = new Publisher({
    call: { sessionId: 'host', channelId: 'room', mode, iceServers: [] }, source, format: 'compatible',
    capture: { video: { clone: () => copy }, audioTrack: null, ended: false }, audioBitrateKbps: 128,
    signal: () => Promise.resolve(), rpc: () => Promise.resolve(), onError: error => { throw error; },
  });
  const watch = () => publisher.receive({
    action: 'watch', fromSessionId: 'viewer', targetSessionId: 'host', publisherSessionId: 'host', channelId: 'room',
    shareId: source.shareId, sourceInstanceId: source.instanceId, subscriptionId: randomUUID(), quality: 'source', backend: 'browser',
  });
  return { publisher, peers, renditions, watch };
}

test('an iPhone capture Safari keeps whole is scaled by the encoder to the rendition, in P2P and on the SFU', async () => {
  // Safari ignores applyConstraints on the copy of a 1206x2622 portrait screen; at that size its encoder emitted no frame.
  const p2p = scaledFixture('p2p', { width: 1206, height: 2622 });
  await p2p.watch();
  assert.equal(p2p.peers.length, 1);
  assert.equal(p2p.peers[0].scaleResolutionDownBy, 1206 / 328);
  await p2p.publisher.close('source-unavailable', false);

  const constraints = Promise.withResolvers();
  const sfu = scaledFixture('sfu', { width: 1206, height: 2622 }, constraints.promise);
  const watching = sfu.watch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sfu.renditions.length, 0, 'the producer waits for the copy to settle its size');
  constraints.resolve();
  await watching;
  assert.equal(sfu.renditions.length, 1);
  assert.equal(sfu.renditions[0].scaleResolutionDownBy, 1206 / 328);
  await sfu.publisher.close('source-unavailable', false);
});

test('a copy the browser already resized to its rendition is sent as it is', async () => {
  const f = scaledFixture('p2p', { width: 328, height: 720 });
  await f.watch();
  assert.equal(f.peers[0].scaleResolutionDownBy, 1);
  await f.publisher.close('source-unavailable', false);
});
