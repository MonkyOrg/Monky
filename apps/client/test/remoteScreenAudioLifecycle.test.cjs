'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const filename = path.resolve(__dirname, '..', 'src', 'renderer', 'core', 'webrtc', 'RemoteMediaRouter.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const load = vm.runInThisContext(`(function(exports, require, AudioContext, MediaStream, document, console) { ${compiled}\n})`,
  { filename });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const contexts = [], elements = new Set(), errors = [];
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  }
  class Context {
    state = 'running';
    failures = 0;
    closeCalls = 0;
    nodes = [];
    destination = {};
    constructor() { contexts.push(this); }
    node() {
      const node = { context: this, gain: { value: 0 }, disconnected: false,
        connect() {}, disconnect() { this.disconnected = true; } };
      this.nodes.push(node);
      return node;
    }
    createMediaStreamSource() { return this.node(); }
    createGain() { return this.node(); }
    createAnalyser() { return this.node(); }
    async setSinkId() {}
    async close() {
      this.closeCalls++;
      if (this.failures-- > 0) throw new Error('modeled output close failure');
      this.state = 'closed';
    }
  }
  const document = {
    body: { appendChild(element) { elements.add(element); element.isConnected = true; } },
    createElement(tag) {
      assert.equal(tag, 'audio');
      const attributes = new Map();
      return { srcObject: null, isConnected: false, pause() {}, async play() {},
        setAttribute: (name, value) => attributes.set(name, value), hasAttribute: name => attributes.has(name),
        remove() { elements.delete(this); this.isConnected = false; } };
    },
  };
  const exports = {};
  load(exports, name => {
    if (name.endsWith('settingsStore')) return { settingsStore: {
      getScreenAudioVolume: () => 100, getUserVolume: () => 100, getAudioOutputDeviceId: () => 'default',
    } };
    if (name.endsWith('voiceStore')) return { voiceStore: { getEffectiveDeafened: () => false } };
    if (name.endsWith('audioPreferences')) return { normalizeAudioOutputId: value => value };
    if (name.endsWith('AudioOutputSink')) return { setAudioOutputSink: async (target, value) => {
      if (target.setSinkId) await target.setSinkId(value);
    } };
    assert.fail(`Unexpected dependency ${name}`);
  }, Context, Stream, document, { log() {}, warn: (...args) => errors.push(args) });
  const router = new exports.RemoteMediaRouter(() => new Map());
  const track = id => ({ id, kind: 'audio', readyState: 'live', onended: null });
  const screen = (peer, audio = track(peer)) => { router.routeScreenAudioTrack(peer, audio); return audio; };
  t.after(async () => {
    for (const context of contexts) context.failures = 0;
    router.closeAllMedia();
    await tick();
    assert.equal(elements.size, 0);
    assert.equal(router.retiringAudioContexts.size, 0);
    assert.ok(contexts.every(context => context.state === 'closed'));
    assert.ok(contexts.flatMap(context => context.nodes).every(node => node.disconnected));
  });
  return { router, contexts, elements, errors, track, screen, Stream };
}

test('the final screen closes its output context without interrupting another screen or voice', async t => {
  const f = fixture(t), first = f.screen('first'), second = f.screen('second');
  f.router.ensureVoiceAudioElement('voice', new f.Stream([f.track('microphone')]));
  await tick();
  const screenContext = f.router.audioContexts.get('screen'), voiceContext = f.router.audioContexts.get('voice');
  await f.router.cleanupScreenAudio('first', first);
  assert.equal(screenContext.closeCalls, 0);
  assert.equal(first.onended, null);
  assert.ok(f.router.getScreenAudioElement('second'));
  await f.router.cleanupScreenAudio('second', second);
  assert.equal(screenContext.state, 'closed');
  assert.equal(voiceContext.state, 'running');
  assert.equal(f.router.audioContexts.has('screen'), false);
  assert.equal(f.errors.length, 0);
});

test('failed screen context closure remains owned and retryable after its element and pipeline are gone', async t => {
  const f = fixture(t), track = f.screen('publisher');
  await tick();
  const context = f.router.audioContexts.get('screen');
  context.failures = 1;
  await assert.rejects(f.router.cleanupScreenAudio('publisher', track), /modeled output close failure/);
  assert.equal(f.router.getScreenAudioElement('publisher'), undefined);
  assert.equal(f.router.screenAudioPipelines.size, 0);
  assert.equal(f.router.retiringAudioContexts.size, 1);
  assert.equal(context.state, 'running');
  assert.equal(f.errors.length, 1);
  await f.router.cleanupScreenAudio('publisher', track);
  assert.equal(context.closeCalls, 2);
  assert.equal(context.state, 'closed');
  assert.equal(f.router.retiringAudioContexts.size, 0);
});

test('retrying an old screen output cannot remove or close its replacement track and context', async t => {
  const f = fixture(t), old = f.screen('publisher');
  await tick();
  const oldContext = f.router.audioContexts.get('screen');
  oldContext.failures = 1;
  await assert.rejects(f.router.cleanupScreenAudio('publisher', old), /modeled output close failure/);
  const replacement = f.screen('publisher', f.track('replacement'));
  await tick();
  const currentContext = f.router.audioContexts.get('screen');
  assert.notEqual(currentContext, oldContext);
  await f.router.cleanupScreenAudio('publisher', old);
  assert.equal(oldContext.state, 'closed');
  assert.equal(currentContext.state, 'running');
  assert.equal(f.router.screenAudioPipelines.get('publisher').trackId, replacement.id);
  assert.deepEqual(f.router.getScreenAudioElement('publisher').srcObject.getTracks(), [replacement]);
});

test('concurrent cleanup deduplicates closure and global teardown retries failed context ownership', async t => {
  const f = fixture(t), track = f.screen('publisher');
  await tick();
  const context = f.router.audioContexts.get('screen');
  context.failures = 1;
  const results = await Promise.allSettled([
    f.router.cleanupScreenAudio('publisher', track), f.router.cleanupScreenAudio('publisher', track),
  ]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(context.closeCalls, 1);
  assert.equal(f.router.retiringAudioContexts.size, 1);
  f.router.closeAllMedia();
  await tick();
  assert.equal(context.closeCalls, 2);
  assert.equal(context.state, 'closed');
  assert.equal(f.router.retiringAudioContexts.size, 0);
});
