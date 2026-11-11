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
