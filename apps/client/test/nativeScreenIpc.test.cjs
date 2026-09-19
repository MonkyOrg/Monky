'use strict';

// Device-free IPC boundaries; the production publisher/subscription controllers
// run against a modeled endpoint. Native retirement is exercised by nativeAvSmoke.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const shared = require('@monky/shared');
const runtime = require('../native/screen-share/index.cjs');
const sourceFile = path.resolve(__dirname, '..', 'src', 'main', 'nativeScreenSharing.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const load = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname, console, process) { ${compiled}\n})`,
  { filename: sourceFile });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
const audio = { sinkId: 'selected-output', muted: false, volume: 1 };

function fixture(t, { gpu, directory, role = 'publisher', platform = 'win32' } = {}) {
  const handlers = new Map(), sent = [], endpoints = [], selections = [], errors = [], captures = [], directories = [];
  let target = { hwnd: 12345, expectedProcessId: 56789 }, frameDestroyed = false, contentDestroyed = false;
  const frame = { url: 'file:///C:/monky-test/index.html', detached: false, isDestroyed: () => frameDestroyed, postMessage() {} };
  const contents = new EventEmitter();
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => contentDestroyed, getURL: () => contents.mainFrame.url });
  const window = { webContents: contents, isDestroyed: () => false };
  const electron = {
    app: {
      getGPUInfo: async type => {
        assert.equal(type, 'complete', 'The Windows basic inventory does not identify the active adapter.');
        if (gpu) await gpu.promise;
        return { gpuDevice: [{ active: true, vendorId: 0x1002 }] };
      },
      getPath: () => path.join(__dirname, 'modeled-native-profile'),
    },
    ipcMain: {
      handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    sharedTexture: {}, MessageChannelMain: class {},
  };
  class Endpoint {
    constructor(options) { this.options = options; this.ready = Promise.resolve(); this.closed = false; endpoints.push(this); }
    async setDemand(count) { if (!count) await this.close(); }
    async connectPeer() {}
    async closePeer() {}
    async receiveControl() {}
    async addRemoteProducer() {}
    async removeRemoteProducer() {}
    async setAudioPreferences(preferences) { this.preferences = preferences; }
    async diagnostics() {
      return { pipelineId: this.options.pipelineId, profile: shared.getScreenShareProfile(this.options.source.video, this.options.quality),
        readErrors: 0, rtp: [], decoders: [] };
    }
    async close() { this.closed = true; }
    snapshot() { return { closed: this.closed, nativeClosed: this.closed }; }
  }
  const captureModule = {
    isPacketCaptureSupported: () => true,
    createPacketCapture() { captures.push(true); assert.fail('IPC/source admission cannot itself capture audio.'); },
  };
  const module = { exports: {} };
  load(module.exports, name => {
    if (name === 'electron') return electron;
    if (name === '@monky/screen-share') return { ...runtime, loadRuntime: () => ({}), NativeScreenEndpoint: Endpoint };
    if (name === '@monky/screen-audio') return captureModule;
    if (name === 'node:fs/promises') return {
      async mkdir(filename) { directories.push(filename); if (directory) await directory.promise; },
    };
    return require(name);
  }, module, sourceFile, path.dirname(sourceFile), {
    error: (...values) => errors.push(values), warn: (...values) => errors.push(values),
  }, { platform, arch: 'x64' });
  const service = module.exports.setupNativeScreenSharingIpc(window, id => {
    selections.push(id);
    assert.match(id, /^window:/);
    return { ...target };
  });
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  const invoke = (input, caller = event()) => handlers.get(shared.NATIVE_SCREEN_IPC.invoke)(caller, input);
  const reply = input => handlers.get(shared.NATIVE_SCREEN_IPC.reply)(event(), input);
  contents.send = (channel, value) => {
    assert.equal(channel, shared.NATIVE_SCREEN_EVENT);
    sent.push(value);
    if ('requestId' in value) queueMicrotask(() => {
      const response = value.type === 'rpc' && value.method === shared.MessageType.SFU_GET_PRODUCERS
        ? { channelId: config.channelId, producers: [] } : null;
      void reply({ callId: value.callId, requestId: value.requestId, ok: true, value: response }).catch(error => errors.push([error]));
    });
  };
  const config = { callId: randomUUID(), sessionId: role, channelId: 'test-channel', mode: 'p2p', iceServers: [] };
  const command = value => invoke({ callId: config.callId, ...value });
  const source = { shareId: 'screen-one', instanceId: randomUUID(), video, audio: true };
  const join = () => invoke({ ...config, action: 'join' });
  const addSource = (shareId = source.shareId, changes = {}) => command({
    action: 'source-add', shareId, desktopSourceId: 'window:12345:0', video, audio: true, audioBitrateKbps: 128, ...changes,
  });
  const participants = () => command({ action: 'participants', participants: [
    { sessionId: 'publisher', nativeScreenShares: [source] }, { sessionId: 'viewer', nativeScreenShares: [] },
  ] });
  const watch = (presentationId = randomUUID()) => command({
    action: 'watch', publisherSessionId: 'publisher', shareId: source.shareId, quality: 'source', presentationId, audio,
  });
  const accepted = signal => command({ action: 'signal', signal: {
    ...signal, fromSessionId: 'publisher', targetSessionId: 'viewer',
    action: 'accepted', generation: 1, backend: 'native',
  } });
  t.after(async () => {
    gpu?.resolve(); directory?.resolve();
    await service.dispose();
    assert.equal(handlers.size, 0);
    assert.equal(contents.listenerCount('did-start-navigation'), 0);
    assert.equal(contents.listenerCount('render-process-gone'), 0);
    assert.equal(contents.listenerCount('destroyed'), 0);
  });
  return { service, config, command, invoke, source, join, addSource, participants, watch, accepted,
    frame, contents, event, endpoints, sent, errors, selections, captures, directories,
    replaceTarget: value => { target = value; },
    destroyFrame: () => { frameDestroyed = true; contentDestroyed = true; contents.emit('render-process-gone'); },
  };
}

test('native IPC rejects other WebContents, subframes, unknown payload fields and renderer-supplied HWNDs', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke({ action: 'capabilities' }, { ...f.event(), sender: {} }), /owned main frame/);
  await assert.rejects(f.invoke({ action: 'capabilities' }, { ...f.event(), senderFrame: {} }), /owned main frame/);
  await f.join();
  await assert.rejects(f.addSource('bad-window', { target: { hwnd: 1, expectedProcessId: 2 } }));
  await assert.rejects(f.addSource('monitor', { desktopSourceId: 'screen:0:0' }));
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.selections.length, 0);
});

test('unsupported native platforms report browser-only capabilities without touching GPU or capture', async t => {
  const f = fixture(t, { platform: 'darwin' });
  const result = await f.invoke({ action: 'capabilities' });
  assert.deepEqual(result, { kind: 'capabilities', capabilities: {
    capture: false, captureAudio: false, receive: false, backend: null, reason: 'platform',
  } });
  assert.equal(f.selections.length + f.captures.length + f.endpoints.length, 0);
});

test('announcing a validated window with audio creates neither an encoder nor a PCM capture before Watch', async t => {
  const f = fixture(t);
  await f.join();
  const result = await f.addSource();
  assert.equal(result.kind, 'source');
  assert.equal(result.source.audio, true);
  assert.deepEqual(f.selections, ['window:12345:0', 'window:12345:0']);
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.captures.length, 0);
  const stats = await f.command({ action: 'stats' });
  assert.equal(stats.publishers.length, 1);
  assert.equal(stats.publishers[0].pipelines.length, 0);
  await f.command({ action: 'source-remove', shareId: result.source.shareId });
  const closed = f.sent.find(value => value.type === 'state' && value.state === 'closed');
  assert.equal(closed.sourceInstanceId, result.source.instanceId);
});

test('retiring a missing or already retired call is idempotent without accepting other operations', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.command({ action: 'leave-local' }), { kind: 'ok' });
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await f.join();
  await f.addSource();
  await f.command({ action: 'leave' });
  assert.deepEqual(await f.command({ action: 'leave' }), { kind: 'ok' });
  assert.deepEqual(await f.command({ action: 'leave-local' }), { kind: 'ok' });
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
});

test('native diagnostics are source-instance scoped and do not start capture when nobody is watching', async t => {
  const f = fixture(t);
  await f.join();
  const { source } = await f.addSource();
  const query = { action: 'diagnostics', publisherSessionId: f.config.sessionId,
    shareId: source.shareId, sourceInstanceId: source.instanceId };
  const diagnostics = await f.command(query);
  assert.deepEqual(diagnostics, { kind: 'diagnostics', sourceInstanceId: source.instanceId,
    presentationId: null, viewers: 0, endpoints: [] });
  assert.equal(f.endpoints.length + f.captures.length, 0);
  await assert.rejects(f.command({ ...query, sourceInstanceId: randomUUID() }), { name: 'AbortError' });
  await assert.rejects(f.command({ ...query, presentationId: randomUUID() }), { name: 'AbortError' });
  await assert.rejects(f.command({ ...query, publisherSessionId: 'someone-else' }), { name: 'AbortError' });
  await f.command({ action: 'source-remove', shareId: source.shareId });
  await assert.rejects(f.command(query), { name: 'AbortError' });
});
test('Stop while capability discovery is pending prevents late source admission', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const adding = f.addSource();
  const rejected = assert.rejects(adding, { name: 'AbortError' });
  await f.command({ action: 'source-remove', shareId: f.source.shareId });
  gpu.resolve(); await rejected;
  assert.equal(f.selections.length, 0);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
});

test('leaving during source preparation cannot attach capture to a subsequent call', async t => {
  const directory = deferred(), f = fixture(t, { directory });
  await f.join();
  const adding = f.addSource(), rejected = assert.rejects(adding, { name: 'AbortError' });
  await tick();
  await f.command({ action: 'leave' });
  directory.resolve(); await rejected;
  assert.equal(f.endpoints.length, 0);
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await f.invoke({ action: 'join', ...f.config, callId: randomUUID() });
});

test('window owner changes during asynchronous preparation fail before publication', async t => {
  const directory = deferred(), f = fixture(t, { directory });
  await f.join();
  const adding = f.addSource(), rejected = assert.rejects(adding, /window changed/);
  await tick();
  f.replaceTarget({ hwnd: 12345, expectedProcessId: 56790 });
  directory.resolve(); await rejected;
  assert.equal(f.endpoints.length, 0);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 0);
});

test('pending sources reserve capacity before yielding to asynchronous discovery', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const pending = ['one', 'two', 'replacement'].map(id => f.addSource(id, { audio: false }));
  await assert.rejects(f.addSource('four'), /limit/);
  await assert.rejects(f.addSource('one'), /already exists/);
  gpu.resolve();
  await Promise.all(pending);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 3);
});

test('application audio is reserved before discovery and remains exclusive until source retirement', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const pending = f.addSource('audio-owner');
  await assert.rejects(f.addSource('second-audio'), /reserve application audio/);
  const silent = f.addSource('silent-window', { audio: false });
  assert.equal(f.selections.length, 0);
  assert.equal(f.captures.length, 0);
  gpu.resolve(); await Promise.all([pending, silent]);
  await assert.rejects(f.addSource('second-audio'), /reserve application audio/);
  await f.command({ action: 'source-remove', shareId: 'audio-owner' });
  assert.equal((await f.addSource('second-audio')).source.audio, true);
  assert.equal(f.captures.length, 0, 'An audio reservation must not capture before Watch.');
});

test('cancelling pending audio admission releases only its own reservation', async t => {
  const gpu = deferred(), f = fixture(t, { gpu });
  await f.join();
  const old = f.addSource('audio-owner'), rejected = assert.rejects(old, { name: 'AbortError' });
  await f.command({ action: 'source-remove', shareId: 'audio-owner' });
  const replacement = f.addSource('audio-owner');
  gpu.resolve(); await rejected; await replacement;
  await assert.rejects(f.addSource('second-audio'), /reserve application audio/);
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
});

test('an authenticated Watch opens the selected source and shares its original capture hub and target', async t => {
  const f = fixture(t);
  await f.join(); await f.participants();
  const { source } = await f.addSource();
  await f.command({ action: 'signal', signal: {
    fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  assert.equal(f.endpoints.length, 1);
  const options = f.endpoints[0].options;
  assert.deepEqual(options.target, { hwnd: 12345, expectedProcessId: 56789 });
  assert.ok(options.audio.captureHub instanceof runtime.NativePcmCaptureHub);
  assert.equal(options.audio.output.frame, f.frame);
  assert.equal(options.audio.output.expectedUrl, f.frame.url);
  assert.equal(options.audio.captureHub.getStats().captureStarts, 0);
});

test('a viewer-only codec failure closes that subscription without reporting a source-wide failure', async t => {
  const f = fixture(t);
  await f.join();
  await f.command({ action: 'participants', participants: [
    { sessionId: 'publisher', nativeScreenShares: [] }, { sessionId: 'viewer', nativeScreenShares: [] },
    { sessionId: 'compatible', nativeScreenShares: [] },
  ] });
  const { source } = await f.addSource();
  for (const fromSessionId of ['viewer', 'compatible']) await f.command({ action: 'signal', signal: {
    fromSessionId, targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: f.config.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), action: 'watch', quality: 'source', backend: 'native',
  } });
  assert.equal(f.endpoints.length, 1);
  f.endpoints[0].options.onError(Object.assign(new Error('modeled incompatible decoder'), { code: 'ERR_RTC_ENCODED_FORMAT' }),
    { remoteSessionId: 'viewer' });
  await tick();
  const stats = await f.command({ action: 'stats' });
  assert.equal(stats.publishers[0].viewers, 1);
  assert.equal(stats.publishers[0].pipelines.length, 1);
  assert.equal(f.endpoints[0].closed, false);
  assert.equal(f.sent.some(value => value.type === 'error'), false);
  assert.ok(f.sent.some(value => value.type === 'signal' && value.signal.action === 'closed'
    && value.signal.targetSessionId === 'viewer' && value.signal.reason === 'unsupported'));
  assert.ok(f.errors.some(values => values[0].includes('Screen viewer failed')), 'The failed peer must still be diagnosed.');
});

test('mute and volume changed before Accepted are applied before the receiver can admit any audio', async t => {
  const f = fixture(t, { role: 'viewer' });
  await f.join(); await f.participants();
  const watched = await f.watch();
  await f.command({ action: 'watch-audio', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: watched.presentationId, muted: true, volume: .35 });
  assert.equal(f.endpoints.length, 0);
  await f.accepted(f.sent.find(value => value.type === 'signal' && value.signal.action === 'watch').signal);
  assert.equal(f.endpoints.length, 1);
  assert.deepEqual({
    sinkId: f.endpoints[0].options.audio.sinkId, muted: f.endpoints[0].options.audio.muted,
    volume: f.endpoints[0].options.audio.volume,
  }, { sinkId: 'selected-output', muted: true, volume: .35 });
  await f.command({ action: 'watch-audio', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: watched.presentationId, muted: false, volume: 1.5 });
  assert.deepEqual(f.endpoints[0].preferences, { muted: false, volume: 1.5 });
});

test('overlapping Watches reserve identity immediately and an old Stop cannot cancel a replacement', async t => {
  const gpu = deferred(), f = fixture(t, { gpu, role: 'viewer' });
  await f.join(); await f.participants();
  const oldId = randomUUID(), newId = randomUUID();
  const first = f.watch(oldId), old = assert.rejects(first, { name: 'AbortError' });
  const second = f.watch(newId);
  gpu.resolve(); await old;
  const watched = await second;
  assert.equal(watched.presentationId, newId);
  await f.command({ action: 'stop', publisherSessionId: 'publisher', shareId: f.source.shareId, presentationId: oldId });
  assert.equal((await f.command({ action: 'stats' })).subscriptions.length, 1);
  await assert.rejects(f.command({ action: 'watch-audio', publisherSessionId: 'publisher', shareId: f.source.shareId,
    presentationId: oldId, muted: false, volume: 1 }), { name: 'AbortError' });
});

test('same-document and child-frame navigation preserve the call; main-document navigation invalidates it immediately', async t => {
  const f = fixture(t);
  await f.join(); await f.addSource();
  f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal((await f.command({ action: 'stats' })).publishers.length, 1);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await tick();
  await f.invoke({ action: 'join', ...f.config, callId: randomUUID() });
});

test('renderer loss retires an idle source without sending cleanup requests into another document', async t => {
  const f = fixture(t);
  await f.join(); await f.addSource();
  const messages = f.sent.length;
  f.destroyFrame();
  await tick();
  assert.equal(f.sent.length, messages);
  assert.equal(f.captures.length, 0);
  assert.equal(f.endpoints.length, 0);
});

test('disconnected leave surfaces the missing remote acknowledgement but releases a locally retired call slot', async t => {
  const f = fixture(t, { role: 'viewer' });
  await f.join(); await f.participants();
  await f.watch();
  await f.accepted(f.sent.find(value => value.type === 'signal' && value.signal.action === 'watch').signal);
  const result = await f.command({ action: 'leave-local' });
  assert.equal(result.kind, 'retired-with-errors');
  assert.equal(result.remoteAcknowledged, false);
  assert.match(result.error, /shutdown reported failures/);
  assert.equal(f.endpoints[0].closed, true);
  await assert.rejects(f.command({ action: 'stats' }), { name: 'AbortError' });
  await f.invoke({ ...f.config, callId: randomUUID(), action: 'join' });
});
