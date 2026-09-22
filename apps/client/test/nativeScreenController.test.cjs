'use strict';

// Renderer ownership and races without devices. nativeScreenAppSmoke covers the
// actual Main/preload, captured media and DOM presentation.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');
const filename = path.resolve(__dirname, '..', 'src', 'renderer', 'core', 'webrtc', 'NativeScreenController.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const load = vm.runInThisContext(`(function(exports, require, window, document, MediaStream) { ${compiled}\n})`, { filename });
const managerFilename = path.resolve(__dirname, '..', 'src', 'renderer', 'core', 'WebRtcManager.ts');
const managerSource = ts.createSourceFile(managerFilename, fs.readFileSync(managerFilename, 'utf8'), ts.ScriptTarget.ES2022, true);
const managerClass = managerSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'WebRtcManager');
const startMethod = managerClass?.members.find(node => ts.isMethodDeclaration(node)
  && node.name.getText(managerSource) === 'startNativeScreenShare');
assert.ok(startMethod, 'The real native source-start method must remain covered.');
// Exercise the production method without constructing unrelated device/transport owners.
const startCompiled = ts.transpileModule(`class SourceStartCore { ${startMethod.getText(managerSource)} }
exports.SourceStartCore = SourceStartCore;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const loadStart = vm.runInThisContext(
  `(function(exports, videoService, settingsStore, nativeScreenProfile, t, MediaStream) { ${startCompiled}\n})`,
  { filename: managerFilename });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
const input = { shareId: 'local-screen', desktopSourceId: 'window:123:0', video, audio: true, audioBitrateKbps: 128, thumbnail: '' };
const profile = (width = 1280, height = 720, fps = 60) => ({
  ...shared.QUALITY_PRESETS.ULTRA, screenWidth: width, screenHeight: height, screenFps: fps, screenBitrateKbps: 6000,
});
const cancelled = () => new DOMException('Modeled operation was cancelled.', 'AbortError');

function fixture(t, { iceServers = [], capabilities = {
  capture: true, captureAudio: true, receive: true, backend: 'libobs-amf', reason: null,
} } = {}) {
  const appBus = new EventEmitter();
  const commands = [], replies = [], events = [], errors = [], captures = new Map(), participants = new Map(), captureStreams = new Map();
  const mainListeners = new Set(), presentationListeners = new Set(), networkListeners = new Set();
  const calls = new Set(), sources = new Map(), sourceIntents = new Map(), watches = new Map();
  const elements = new Map(), attached = new Map(), retired = [], stopped = [], requests = [], replyGates = new Map();
  let commandHook = async () => {}, attachHook = async () => {}, current = true, connectionId = 'connection-one';
  let diagnosticsRetired = false;
  let status = 'CONNECTED', watching = false, quality = 'source', muted = false, deafened = false, volume = 100, announces = 0;
  const remote = { shareId: 'remote-screen', instanceId: randomUUID(), video, audio: true };
  class Stream {
    tracks = [];
    getVideoTracks() { return [...this.tracks]; }
    addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(value => value !== track); }
  }
  class Video {
    srcObject = null;
    setAttribute() {}
    remove() { elements.delete(this.id); }
  }
  const emit = event => {
    const parsed = shared.nativeScreenEventSchema.parse(event);
    for (const listener of mainListeners) listener(parsed);
  };
  const api = {
    async nativeScreenCommand(value) {
      const command = shared.nativeScreenCommandSchema.parse(value);
      commands.push(command);
      const key = `${command.callId}\0${command.shareId ?? ''}`;
      const intent = Symbol();
      if (command.action === 'source-add') sourceIntents.set(key, intent);
      if (command.action === 'source-remove') { sourceIntents.delete(key); sources.delete(key); }
      if (command.action === 'watch') watches.set(key, command.presentationId);
      if (command.action === 'stop' && watches.get(key) === command.presentationId) watches.delete(key);
      if (['leave', 'leave-local'].includes(command.action)) {
        calls.delete(command.callId);
        for (const map of [sources, sourceIntents, watches])
          for (const id of map.keys()) if (id.startsWith(`${command.callId}\0`)) map.delete(id);
      }
      await commandHook(command);
      switch (command.action) {
        case 'capabilities': return { kind: 'capabilities', capabilities };
        case 'join': calls.add(command.callId); return { kind: 'ok' };
        case 'source-add': {
          if (!calls.has(command.callId) || sourceIntents.get(key) !== intent) throw cancelled();
          const source = { shareId: command.shareId, instanceId: randomUUID(), video: command.video, audio: command.audio };
          sources.set(key, source);
          return { kind: 'source', source };
        }
        case 'watch':
          if (!calls.has(command.callId) || watches.get(key) !== command.presentationId) throw cancelled();
          emit({ type: 'state', callId: command.callId, publisherSessionId: 'publisher', shareId: remote.shareId,
            sourceInstanceId: remote.instanceId, presentationId: command.presentationId, state: 'playing' });
          return { kind: 'subscription', subscriptionId: randomUUID(), presentationId: command.presentationId };
        case 'diagnostics':
          if (diagnosticsRetired) return { kind: 'diagnostics-retired' };
          return { kind: 'diagnostics', sourceInstanceId: command.sourceInstanceId,
            presentationId: command.presentationId ?? null, viewers: command.presentationId ? null : 0, endpoints: [] };
        default: return { kind: 'ok' };
      }
    },
    async nativeScreenReply(value) {
      replies.push(shared.nativeScreenReplySchema.parse(value));
      replyGates.get(value.requestId)?.resolve(value);
    },
    onNativeScreenEvent(listener) { mainListeners.add(listener); return () => mainListeners.delete(listener); },
    onNativeScreenPresentationError(listener) { presentationListeners.add(listener); return () => presentationListeners.delete(listener); },
    async attachNativeScreenPresentation(value) {
      await attachHook(value);
      const element = elements.get(value.elementId);
      assert.ok(element, 'Do not remove a presentation owner before its pending attachment retires.');
      element.srcObject = new Stream();
      attached.set(value.presentationId, element);
    },
    async attachNativeScreenPreview(value) { return api.attachNativeScreenPresentation(value); },
    async stopNativeScreenPresentation(id) {
      stopped.push(id);
      const element = attached.get(id);
      if (element) element.srcObject = null;
      attached.delete(id);
    },
  };
  const client = {
    getConnectionId: () => connectionId, getStatus: () => status, getIceServers: () => iceServers,
    onEvent(listener) { networkListeners.add(listener); return () => networkListeners.delete(listener); },
    async sendRequest(method, value) {
      requests.push({ owner: 'call-client', method, value });
      return method === shared.MessageType.NATIVE_SCREEN_SIGNAL
        ? { accepted: true, subscriptionId: value.subscriptionId } : { acknowledged: true };
    },
  };
  const context = {
    client, sessionId: 'self', channelId: 'room', mode: 'p2p', isCurrent: () => current,
    announceSources: () => { announces++; },
    participants: {
      get: id => participants.get(id),
      getInVoiceChannel: channel => [...participants.values()].filter(value => value.voiceState.channelId === channel),
      setRemoteScreenStream(sessionId, shareId, stream) { participants.get(sessionId)?.remoteScreenStreams.set(shareId, stream); },
      removeRemoteScreenStream(sessionId, shareId) { participants.get(sessionId)?.remoteScreenStreams.delete(shareId); },
    },
  };
  let visibleContext = context;
  const dependencies = {
    '@monky/shared': shared,
    './BrowserScreenSubscription': { BrowserScreenSubscription: class {
      constructor() { throw new Error('Native controller scenarios must not create a browser receiver.'); }
    } },
    '../EventBus': { appEvents: { on: (event, listener) => {
      appBus.on(event, listener);
      return () => appBus.removeListener(event, listener);
    }, emit: (...value) => {
      events.push(value);
      appBus.emit(...value);
      if (value[0] === 'local.screen_ended_externally') captures.delete(value[1]);
    } } },
    '../sessionRouting': { emitOutsideRouting: run => run() },
    '../ClientLogService': { clientLog: {
      error: (...value) => errors.push(value), warn: (...value) => errors.push(value),
    } },
    '../VideoService': { videoService: {
      getNativeScreenCapture: id => captures.get(id) ?? null,
      getNativeScreenCaptures: () => [...captures.values()],
      getScreenStream: id => captureStreams.get(id) ?? null,
      updateNativeScreenCapture: capture => {
        assert.ok(captures.has(capture.source.shareId));
        captures.set(capture.source.shareId, capture);
      },
    } },
    '../../stores/settingsStore': { settingsStore: {
      getScreenAudioVolume: () => volume, screenSharePreviewPauseWhenUnfocused: true,
    } },
    '../../stores/voiceStore': { voiceStore: {
      getScreenWatchers: () => watching ? [['publisher', [remote.shareId]]] : [],
      isWatchingScreen: (sessionId, shareId) => watching && sessionId === 'publisher' && shareId === remote.shareId,
      getScreenQuality: () => quality, getEffectiveDeafened: () => deafened, isScreenAudioMuted: () => muted,
    } },
    '../../utils/audioPreferences': { resolveAudioOutput: () => 'default' },
  };
  const exports = {};
  load(exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unmodeled renderer dependency: ${name}`);
    return dependencies[name];
  }, { api }, { createElement: () => new Video(), body: { append: element => elements.set(element.id, element) } }, Stream);
  const controller = new exports.NativeScreenController(() => visibleContext, async stream => { retired.push(stream); });
  const attachRemote = () => participants.set('publisher', { user: { sessionId: 'publisher', clientId: 'remote-client' },
    voiceState: { channelId: 'room', nativeScreenShares: [remote] }, remoteScreenStreams: new Map() });
  const local = async (selection = input) => {
    const source = await controller.addSource(selection);
    captures.set(source.shareId, { ...selection, source });
    captureStreams.set(source.shareId, new Stream());
    return source;
  };
  const emitForCall = value => emit({ callId: commands.findLast(command => command.action === 'join').callId, ...value });
  t.after(async () => {
    commandHook = async () => {};
    await controller.close();
    assert.equal(calls.size, 0);
    assert.equal(mainListeners.size + networkListeners.size + presentationListeners.size, 0);
    assert.equal(elements.size + attached.size, 0);
    assert.equal(appBus.listenerCount('settings.updated'), 0);
  });
  return { controller, local, captures, sources, commands, events, errors, replies, requests, watches, elements, stopped, retired, Stream,
    registerCapture: (stream, capture) => { captures.set(stream.id, capture); captureStreams.set(stream.id, stream); },
    mainListeners, networkListeners, context, remote, nativeScreenProfile: exports.nativeScreenProfile,
    emit: emitForCall, announceCount: () => announces,
    retireDiagnostics: () => { diagnosticsRetired = true; },
    previewPreference: value => {
      dependencies['../../stores/settingsStore'].settingsStore.screenSharePreviewPauseWhenUnfocused = value;
      appBus.emit('settings.updated');
    },
    hook: callback => { commandHook = callback; }, attachHook: callback => { attachHook = callback; },
    quality: value => { quality = value; }, watching: value => { attachRemote(); watching = value; },
    audio: value => { ({ muted = muted, deafened = deafened, volume = volume } = value); },
    otherVisibleContext: () => { visibleContext = { ...context, client: { ...client, sendRequest: async () => assert.fail('Visible server used.') } }; },
    disconnected: () => {
      status = 'RECONNECTING'; connectionId = 'replacement-connection';
      for (const listener of networkListeners) listener('network.status', status);
    },
    request: (command, type = 'rpc') => {
      const requestId = randomUUID(), gate = deferred();
      replyGates.set(requestId, gate);
      emit({ type, requestId, callId: command.callId,
        ...(type === 'rpc' ? { method: shared.MessageType.SFU_GET_PRODUCERS, payload: { channelId: 'room' } }
          : { presentationId: randomUUID() }) });
      return gate.promise;
    },
  };
}

for (const scenario of [
  { name: 'probe permission without kinds', capture: false, requiresSelectionProbe: true, kind: 'window', allowed: false },
  { name: 'explicit empty kinds', capture: false, requiresSelectionProbe: true, kinds: [], kind: 'window', allowed: false },
  { name: 'verified capture with explicit empty kinds', capture: true, kinds: [], kind: 'window', allowed: false },
  { name: 'declared window preparation', capture: false, requiresSelectionProbe: true, kinds: ['window'], kind: 'window', allowed: true },
  { name: 'declared monitor preparation', capture: false, requiresSelectionProbe: true, kinds: ['monitor'], kind: 'monitor', allowed: true },
  { name: 'declared Game preparation', capture: false, requiresSelectionProbe: true, kinds: ['game'], kind: 'game', allowed: true },
  { name: 'a different advertised kind', capture: false, requiresSelectionProbe: true, kinds: ['monitor'], kind: 'window', allowed: false },
  { name: 'verified legacy window', capture: true, kind: 'window', allowed: true },
  { name: 'legacy capabilities never imply Game', capture: true, kind: 'game', allowed: false },
  { name: 'kinds without capture or preparation permission', capture: false, kinds: ['window'], kind: 'window', allowed: false },
]) {
  test(`source-start core: ${scenario.name}`, async t => {
    const capabilities = { capture: scenario.capture, captureAudio: true, receive: true, backend: null, reason: null,
      ...(scenario.requiresSelectionProbe ? { requiresSelectionProbe: true } : {}),
      ...(scenario.kinds ? { captureKinds: scenario.kinds } : {}) };
    const f = fixture(t, { capabilities }), exports = {};
    let streams = 0;
    loadStart(exports, { getProfile: () => profile(), registerNativeScreenShare: f.registerCapture },
      { preferredVideoCodec: 'auto' }, f.nativeScreenProfile, key => key, class extends f.Stream {
        id = randomUUID();
        constructor() { super(); streams++; }
      });
    const owner = { nativeScreens: f.controller, voiceReconnectSuspended: false };
    const id = scenario.kind === 'monitor' ? `native-monitor:${'a'.repeat(64)}` : `window:123:${'b'.repeat(64)}`;
    const starting = exports.SourceStartCore.prototype.startNativeScreenShare.call(owner, id, false, '', () => true, scenario.kind);
    if (!scenario.allowed) {
      await assert.rejects(starting, /screenShare.nativeUnavailable/);
      assert.equal(streams, 0);
      assert.equal(f.commands.some(command => command.action === 'source-add' || command.action === 'join'), false);
      assert.equal(f.captures.size, 0);
      return;
    }
    const stream = await starting;
    assert.equal(streams, 1);
    const command = f.commands.find(command => command.action === 'source-add');
    assert.equal(command.captureKind, scenario.kind);
    assert.equal(command.desktopSourceId, id);
    assert.equal(command.preserveAspectRatio, false, 'Legacy callers explicitly retain stretch');
    assert.equal(f.captures.get(stream.id).desktopSourceId, id);
    assert.equal(f.captures.get(stream.id).preserveAspectRatio, false);
    assert.deepEqual(f.errors, []);
  });
}

for (const captureKind of ['window', 'monitor', 'game']) {
  for (const preserveAspectRatio of [false, true]) {
    test(`source-start core forwards ${captureKind} preserveAspectRatio=${preserveAspectRatio} only to the publisher`, async t => {
      const f = fixture(t, { capabilities: {
        capture: false, requiresSelectionProbe: true, captureKinds: [captureKind],
        captureAudio: true, receive: true, backend: null, reason: null,
      } }), exports = {};
      loadStart(exports, { getProfile: () => profile(), registerNativeScreenShare: f.registerCapture },
        { preferredVideoCodec: 'h264' }, f.nativeScreenProfile, key => key, class extends f.Stream {
          id = randomUUID();
        });
      const owner = { nativeScreens: f.controller, voiceReconnectSuspended: false };
      const id = captureKind === 'monitor' ? `native-monitor:${'b'.repeat(64)}` : `window:123:${'c'.repeat(64)}`;
      const stream = await exports.SourceStartCore.prototype.startNativeScreenShare.call(
        owner, id, false, '', () => true, captureKind, preserveAspectRatio);
      const command = f.commands.find(command => command.action === 'source-add');
      assert.equal(command.preserveAspectRatio, preserveAspectRatio);
      assert.equal(command.captureKind, captureKind);
      assert.equal(command.desktopSourceId, id);
      const capture = f.captures.get(stream.id);
      assert.equal(capture.preserveAspectRatio, preserveAspectRatio);
      assert.equal(Object.hasOwn(capture.source, 'preserveAspectRatio'), false, 'The public descriptor does not carry publisher settings');
      assert.deepEqual(f.errors, []);
    });
  }
}

test('independent aspect-ratio choices survive quality replacement and reconnect without becoming a global preference', async t => {
  const f = fixture(t);
  await f.local({ ...input, shareId: 'fit-screen', preserveAspectRatio: true });
  await f.local({ ...input, shareId: 'stretch-screen', preserveAspectRatio: false });
  await f.controller.applyQuality(profile());
  await f.controller.close();
  await f.controller.sync();
  for (const [shareId, preserveAspectRatio] of [['fit-screen', true], ['stretch-screen', false]]) {
    const additions = f.commands.filter(command => command.action === 'source-add' && command.shareId === shareId);
    assert.equal(additions.length, 3);
    assert.ok(additions.every(command => command.preserveAspectRatio === preserveAspectRatio));
    assert.equal(f.captures.get(shareId).preserveAspectRatio, preserveAspectRatio);
    assert.equal(Object.hasOwn(f.captures.get(shareId).source, 'preserveAspectRatio'), false);
  }
});

test('native profile alignment is explicit and unsupported ceilings are not silently clamped', t => {
  const f = fixture(t);
  assert.equal(f.nativeScreenProfile(profile(854, 480)).width, 852);
  assert.equal(f.nativeScreenProfile(profile(2560, 1440)), null);
  assert.equal(f.nativeScreenProfile(profile(1920, 1080, 121)), null);
});

test('preview preference is synchronized on join and changes without creating a remote Watch', async t => {
  const f = fixture(t);
  const source = await f.local();
  const preferences = () => f.commands.filter(command => command.action === 'preview-preferences');
  assert.equal(preferences().at(-1).pauseWhenUnfocused, true);
  f.previewPreference(false);
  await tick();
  assert.equal(preferences().at(-1).pauseWhenUnfocused, false);
  const count = preferences().length;
  f.previewPreference(false);
  await tick();
  assert.equal(preferences().length, count);
  f.emit({ type: 'preview-state', publisherSessionId: 'self', shareId: source.shareId,
    sourceInstanceId: source.instanceId, state: 'paused' });
  assert.equal(f.controller.getLocalPreviewState(source.shareId), 'paused');
  assert.equal(f.commands.some(command => command.action === 'watch'), false);
});

test('fallback notifies once and keeps Normal for quality/reconnect without replacing the current source or options', async t => {
  const f = fixture(t);
  const source = await f.local({ ...input, captureKind: 'game', preserveAspectRatio: true });
  const before = f.commands.length;
  const event = { type: 'capture-fallback', publisherSessionId: 'self', shareId: source.shareId, sourceInstanceId: source.instanceId };
  f.emit({ ...event, sourceInstanceId: randomUUID() });
  f.emit({ ...event, publisherSessionId: 'other' });
  assert.equal(f.events.some(([type]) => type === 'native_screen.capture_fallback'), false);
  f.emit(event);
  f.emit(event);
  assert.deepEqual(f.events.filter(([type]) => type === 'native_screen.capture_fallback'),
    [['native_screen.capture_fallback', { shareId: source.shareId }]]);
  assert.equal(f.commands.length, before, 'Fallback does not remove/recreate the source or subscriptions.');
  const capture = f.captures.get(source.shareId);
  assert.equal(capture.source, source);
  assert.equal(capture.captureKind, 'window');
  assert.equal(capture.desktopSourceId, input.desktopSourceId);
  assert.equal(capture.preserveAspectRatio, true);
  assert.equal(capture.audioBitrateKbps, input.audioBitrateKbps);
  assert.equal(f.controller.getCaptureMode('self', source.shareId), null, 'Retrying Normal is not proof of frames.');
  await f.controller.applyQuality(profile());
  const replacement = f.commands.findLast(command => command.action === 'source-add');
  assert.equal(replacement.captureKind, 'window');
  assert.equal(replacement.preserveAspectRatio, true);
});

test('capture badge updates are presentation/source scoped for local preview and native spectators', async t => {
  const f = fixture(t);
  const source = await f.local();
  await f.controller.attachLocalPreview(source.shareId);
  const preview = f.commands.findLast(command => command.action === 'preview-start');
  const local = { type: 'capture-mode', publisherSessionId: 'self', shareId: source.shareId, sourceInstanceId: source.instanceId,
    presentationId: preview.presentationId, mode: 'game' };
  f.emit({ ...local, presentationId: randomUUID() });
  assert.equal(f.controller.getCaptureMode('self', source.shareId), null);
  f.emit(local);
  assert.equal(f.controller.getCaptureMode('self', source.shareId), null, 'A waiting preview must not advertise a retired pipeline.');
  f.emit({ type: 'preview-state', publisherSessionId: 'self', shareId: source.shareId,
    sourceInstanceId: source.instanceId, state: 'playing' });
  assert.equal(f.controller.getCaptureMode('self', source.shareId), 'game');
  f.watching(true);
  await f.controller.sync();
  const watch = f.commands.findLast(command => command.action === 'watch');
  const remote = { ...local, publisherSessionId: 'publisher', shareId: f.remote.shareId, sourceInstanceId: f.remote.instanceId,
    presentationId: watch.presentationId, mode: 'normal' };
  f.emit({ ...remote, sourceInstanceId: randomUUID() });
  f.emit({ ...remote, presentationId: randomUUID() });
  assert.equal(f.controller.getCaptureMode('publisher', f.remote.shareId), null);
  f.emit(remote);
  assert.equal(f.controller.getCaptureMode('publisher', f.remote.shareId), 'normal');
  assert.equal(f.controller.getWatchState('publisher', f.remote.shareId).state, 'playing');
  assert.equal(f.controller.getCaptureMode('self', source.shareId), 'game', 'Different renditions may use different methods.');
  f.emit({ type: 'preview-state', publisherSessionId: 'self', shareId: source.shareId,
    sourceInstanceId: source.instanceId, state: 'paused' });
  assert.equal(f.controller.getCaptureMode('self', source.shareId), null, 'A paused preview has no current capture rendition.');
  f.emit({ type: 'state', publisherSessionId: 'publisher', shareId: f.remote.shareId,
    sourceInstanceId: f.remote.instanceId, presentationId: watch.presentationId, state: 'closed' });
  f.emit(remote);
  assert.equal(f.controller.getCaptureMode('publisher', f.remote.shareId), null, 'Late mode metadata cannot revive a closed presentation.');
  f.watching(false);
  await f.controller.sync();
  f.emit(remote);
  assert.equal(f.controller.getCaptureMode('publisher', f.remote.shareId), null);
});

test('active local Game Capture errors preserve the typed code, public reason and raw diagnostics without fallback', async t => {
  const f = fixture(t);
  const source = await f.local({ ...input, captureKind: 'game' });
  const message = 'Raw native Game Capture diagnostic';
  const failure = { type: 'error', publisherSessionId: 'self', shareId: source.shareId,
    sourceInstanceId: source.instanceId, reason: 'capture-failed',
    code: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE', message };
  const before = f.commands.length;
  f.emit(failure);
  await tick();
  const notices = () => f.events.filter(([type]) => type === 'native_screen.source_failed');
  assert.deepEqual(notices(), [['native_screen.source_failed', {
    reason: 'capture-failed', shareId: source.shareId, code: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE',
  }]]);
  assert.ok(f.errors.some(value => value[2]?.error === message), 'Keep the native detail in diagnostics');
  assert.equal(f.commands.length, before, 'Error presentation must not retry, change method or source');
  f.emit({ ...failure, sourceInstanceId: randomUUID() });
  f.emit({ ...failure, publisherSessionId: 'another-publisher' });
  await tick();
  assert.equal(notices().length, 1, 'Stale or foreign errors must not reach the local sharing alert');
  const { code, ...generic } = failure;
  f.emit(generic);
  await tick();
  assert.deepEqual(notices()[1], ['native_screen.source_failed', { reason: 'capture-failed', shareId: source.shareId }]);
});

test('all configured STUN/TURN URLs and credentials survive the bounded IPC grouping', async t => {
  const urls = Array.from({ length: 5 }, (_, id) => `stun:test-${id}.invalid:3478`);
  const f = fixture(t, { iceServers: [{ urls }, { urls: 'turn:relay.invalid:3478', username: 'test-user', credential: 'test-password' }] });
  await f.local();
  assert.deepEqual(f.commands.find(command => command.action === 'join').iceServers, [
    { urls: urls.slice(0, 4) }, { urls: urls.slice(4) },
    { urls: ['turn:relay.invalid:3478'], username: 'test-user', credential: 'test-password' },
  ]);
});

test('overlapping source admission and restore have a single source owner', async t => {
  const f = fixture(t), gate = deferred();
  f.hook(async command => { if (command.action === 'source-add') await gate.promise; });
  const first = f.controller.addSource(input), second = f.controller.addSource(input);
  await tick(); gate.resolve();
  assert.equal(await first, await second);
  assert.equal(f.commands.filter(command => command.action === 'source-add').length, 1);
  assert.equal(f.sources.size, 1);
});

test('two concurrent reconnect syncs cannot retire the source restored by the first', async t => {
  const f = fixture(t), gate = deferred();
  const old = { shareId: input.shareId, instanceId: randomUUID(), video, audio: true };
  f.captures.set(old.shareId, { ...input, source: old });
  f.hook(async command => { if (command.action === 'source-add') await gate.promise; });
  const first = f.controller.sync(), second = f.controller.sync();
  await tick(); gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.commands.filter(command => command.action === 'source-add').length, 1);
  assert.equal(f.commands.filter(command => command.action === 'source-remove').length, 0);
  assert.notEqual(f.captures.get(old.shareId).source.instanceId, old.instanceId);
  assert.equal(f.sources.size, 1);
  assert.equal(f.announceCount(), 1);
});

test('roster sync and late old Closed cannot restore or terminate a profile replacement', async t => {
  const f = fixture(t), gate = deferred(), old = await f.local();
  f.hook(async command => { if (command.action === 'source-add') await gate.promise; });
  const changing = f.controller.applyQuality(profile());
  await tick();
  const syncing = f.controller.sync();
  f.emit({ type: 'state', publisherSessionId: 'self', shareId: old.shareId, sourceInstanceId: old.instanceId, state: 'closed' });
  await tick();
  assert.equal(f.events.filter(([type]) => type === 'local.screen_ended_externally').length, 0);
  gate.resolve(); await Promise.all([changing, syncing]);
  assert.equal(f.commands.filter(command => command.action === 'source-add').length, 2);
  assert.equal(f.commands.filter(command => command.action === 'source-remove').length, 1);
  assert.equal(f.captures.get(old.shareId).source.video.width, 1280);
  assert.equal(f.sources.size, 1);
});

test('Stop during a profile replacement prevents a queued sync from resurrecting the source', async t => {
  const f = fixture(t), gate = deferred(), old = await f.local();
  f.hook(async command => { if (command.action === 'source-remove') await gate.promise; });
  const changing = f.controller.applyQuality(profile());
  await tick();
  const syncing = f.controller.sync();
  f.captures.delete(old.shareId);
  let retired = false;
  const stopping = f.controller.removeSource(old.shareId).then(() => { retired = true; });
  await tick();
  assert.equal(retired, false, 'Stop cannot claim retirement while the Main acknowledgement is pending.');
  gate.resolve(); await Promise.all([changing, syncing, stopping]);
  assert.equal(f.commands.filter(command => command.action === 'source-add').length, 1);
  assert.equal(f.sources.size, 0);
});

test('failed source removal retains its original cleanup obligation until the Main acknowledges retry', async t => {
  const f = fixture(t), source = await f.local();
  let failures = 1;
  f.hook(async command => {
    if (command.action === 'source-remove' && failures-- > 0) throw new Error('modeled Main cleanup failure');
  });
  await assert.rejects(f.controller.removeSource(source.shareId), /modeled Main cleanup failure/);
  await assert.rejects(f.controller.addSource(input), /still retiring/);
  await f.controller.removeSource(source.shareId);
  assert.equal(f.commands.filter(command => command.action === 'source-remove').length, 2);
  assert.equal(f.sources.size, 0);
});

test('native diagnostics use the captured source owner and discard observations from a retired source', async t => {
  const f = fixture(t), source = await f.local();
  f.otherVisibleContext();
  const idle = await f.controller.diagnostics('self', source.shareId);
  assert.equal(idle.backend, 'native');
  assert.equal(idle.viewers, 0);
  assert.deepEqual(idle.endpoints, []);
  assert.equal(await f.controller.diagnostics('another-publisher', source.shareId), null);
  const gate = deferred();
  f.hook(async command => { if (command.action === 'diagnostics') await gate.promise; });
  const pending = f.controller.diagnostics('self', source.shareId);
  await tick();
  await f.controller.removeSource(source.shareId);
  gate.resolve();
  assert.equal(await pending, null);
});

test('retired diagnostic ownership returns unavailable metrics instead of a stream error or zero-valued sample', async t => {
  const f = fixture(t), source = await f.local();
  f.retireDiagnostics();
  assert.equal(await f.controller.diagnostics('self', source.shareId), null);
  assert.equal(f.errors.length, 0);
  assert.equal(f.sources.size, 1, 'Telemetry cancellation must not retire the broadcast.');
});

test('active native settings reject incompatible codecs and profiles before changing a source', async t => {
  const f = fixture(t);
  assert.equal(f.controller.settingsIssue(profile(3840, 2160, 144), 'vp9'), null, 'Inactive/browser sharing keeps its existing settings range.');
  const source = await f.local();
  const before = f.commands.length;
  assert.equal(f.controller.settingsIssue(profile(), 'vp9'), 'codec');
  assert.equal(f.controller.settingsIssue(profile(), 'av1'), 'codec');
  assert.equal(f.controller.settingsIssue(profile(), 'vp8'), 'codec');
  assert.equal(f.controller.settingsIssue(profile(), 'auto'), null);
  assert.equal(f.controller.settingsIssue(profile(), 'h264'), null);
  assert.equal(f.controller.settingsIssue(profile(3840, 2160), 'h264'), 'profile');
  assert.equal(f.controller.settingsIssue(profile(1920, 1080, 144), 'h264'), 'profile');
  assert.equal(f.controller.settingsIssue({ ...profile(), screenBitrateKbps: 1501 }, 'h264'), 'profile');
  assert.equal(f.controller.settingsIssue({ ...profile(), audioBitrateKbps: 512 }, 'h264'), 'profile');
  assert.equal(f.commands.length, before, 'Validation cannot mutate a running source.');
  assert.equal(f.captures.get(source.shareId).source, source);
});

test('failed quality admission restores the last profile under a new source instance and surfaces the error', async t => {
  const f = fixture(t), old = await f.local();
  f.hook(async command => {
    if (command.action === 'source-add' && command.video.width === 1280) throw new Error('modeled selected profile failure');
  });
  await assert.rejects(f.controller.applyQuality(profile()), /modeled selected profile failure/);
  const restored = f.captures.get(old.shareId).source;
  assert.notEqual(restored.instanceId, old.instanceId);
  assert.deepEqual(restored.video, old.video);
  assert.equal(f.sources.size, 1);
  assert.equal(f.announceCount(), 1);
  assert.equal(f.events.filter(([type]) => type === 'local.screen_ended_externally').length, 0);
});

for (const captureKind of ['window', 'monitor', 'game']) {
  for (const preserveAspectRatio of [false, true]) {
    test(`${captureKind}: quality restoration preserves the exact ID, kind and aspect ratio ${preserveAspectRatio}`, async t => {
      const f = fixture(t);
      const selection = { ...input, captureKind, preserveAspectRatio,
        desktopSourceId: captureKind === 'monitor' ? `native-monitor:${'a'.repeat(64)}` : input.desktopSourceId };
      const old = await f.local(selection);
      f.hook(async command => {
        if (command.action === 'source-add' && command.video.width === 1280)
          throw new Error('modeled selected profile failure');
      });
      await assert.rejects(f.controller.applyQuality(profile()), /modeled selected profile failure/);
      const additions = f.commands.filter(command => command.action === 'source-add');
      assert.equal(additions.length, 3);
      assert.ok(additions.every(command => command.captureKind === captureKind && command.preserveAspectRatio === preserveAspectRatio
        && command.desktopSourceId === selection.desktopSourceId));
      const restored = f.captures.get(old.shareId);
      assert.equal(restored.captureKind, captureKind);
      assert.equal(restored.preserveAspectRatio, preserveAspectRatio);
      assert.equal(restored.desktopSourceId, selection.desktopSourceId);
      assert.notEqual(restored.source.instanceId, old.instanceId);
      assert.equal(f.events.some(([type]) => type === 'local.screen_ended_externally'), false);
    });
  }
}

test('a failed replacement and rollback withdraw the retired source instead of announcing a stale descriptor', async t => {
  const f = fixture(t), old = await f.local();
  f.hook(async command => { if (command.action === 'source-add') throw new Error('modeled unavailable window'); });
  await assert.rejects(f.controller.applyQuality(profile()), /quality change and restoration failed/);
  assert.equal(f.captures.has(old.shareId), false);
  assert.equal(f.sources.size, 0);
  assert.equal(f.announceCount(), 0);
  assert.equal(f.events.filter(([type, id]) => type === 'local.screen_ended_externally' && id === old.shareId).length, 1);
  const attempts = f.commands.filter(command => command.action === 'source-add').length;
  await f.controller.sync();
  assert.equal(f.commands.filter(command => command.action === 'source-add').length, attempts);
});

test('a failed join releases listeners and permits a fresh call', async t => {
  const f = fixture(t);
  f.hook(async command => { if (command.action === 'join') throw new Error('Admission rejected.'); });
  await assert.rejects(f.controller.addSource(input), /Admission rejected/);
  assert.equal(f.mainListeners.size + f.networkListeners.size, 0);
  f.hook(async () => {});
  await f.local();
  const joined = f.commands.filter(command => command.action === 'join');
  assert.equal(joined.length, 2);
  assert.notEqual(joined[0].callId, joined[1].callId);
});

test('closing during join waits for admission and retires it without admitting a source', async t => {
  const f = fixture(t), gate = deferred();
  f.hook(async command => { if (command.action === 'join') await gate.promise; });
  const rejected = assert.rejects(f.controller.addSource(input), { name: 'AbortError' });
  await tick();
  const closing = f.controller.close();
  await tick();
  assert.equal(f.commands.some(command => command.action === 'leave'), false);
  gate.resolve(); await Promise.all([rejected, closing]);
  assert.equal(f.commands.some(command => command.action === 'source-add'), false);
  assert.equal(f.mainListeners.size, 0);
});

test('Main requests are replied to outside source queues and use the captured call client', async t => {
  const f = fixture(t);
  f.hook(async command => {
    if (command.action === 'source-add') {
      f.otherVisibleContext();
      const reply = await f.request(command);
      assert.equal(reply.ok, true);
    }
  });
  await f.local();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].owner, 'call-client');
  assert.deepEqual(f.replies[0].value, { acknowledged: true });
});

test('presentation-stop acknowledgements carry explicit null rather than undefined JSON', async t => {
  const f = fixture(t);
  f.hook(async command => {
    if (command.action === 'source-add') {
      const reply = await f.request(command, 'presentation-stop');
      assert.equal(reply.ok, true);
      assert.equal(reply.value, null);
    }
  });
  await f.local();
});

test('Watch uses the owned DOM stream and current mute, deafen and per-user volume', async t => {
  const f = fixture(t);
  f.watching(true);
  f.audio({ muted: true, volume: 175 });
  await f.controller.sync();
  const command = f.commands.find(value => value.action === 'watch');
  assert.deepEqual(command.audio, { sinkId: 'default', muted: true, volume: 1.75 });
  assert.equal(f.context.participants.get('publisher').remoteScreenStreams.size, 1);
  f.audio({ muted: false, deafened: true, volume: 40 });
  await f.controller.updateAudio();
  assert.deepEqual(f.commands.at(-1), { action: 'watch-audio', callId: command.callId, presentationId: command.presentationId,
    publisherSessionId: 'publisher', shareId: f.remote.shareId, muted: true, volume: 0.4 });
  f.watching(false); await f.controller.sync();
  assert.equal(f.watches.size, 0);
  assert.equal(f.elements.size, 0);
  assert.equal(f.retired.length, 1);
  assert.equal(f.context.participants.get('publisher').remoteScreenStreams.size, 0);
});

test('Stop cancels a pending Watch immediately instead of waiting behind its readiness', async t => {
  const f = fixture(t), gate = deferred();
  f.watching(true);
  f.hook(async command => {
    if (command.action === 'watch') await gate.promise;
    if (command.action === 'stop') gate.resolve();
  });
  const rejected = assert.rejects(f.controller.sync(), { name: 'AbortError' });
  await tick();
  assert.equal(f.commands.some(command => command.action === 'watch'), true);
  f.watching(false);
  await Promise.all([rejected, f.controller.sync()]);
  assert.equal(f.watches.size, 0);
  assert.equal(f.elements.size, 0);
});

test('Stop during attachment waits for its owner and never starts a late subscription', async t => {
  const f = fixture(t), gate = deferred();
  f.attachHook(async () => gate.promise);
  f.watching(true);
  const rejected = assert.rejects(f.controller.sync(), { name: 'AbortError' });
  await tick(); f.watching(false);
  const stopped = f.controller.sync();
  await tick();
  assert.equal(f.elements.size, 1, 'Attachment still owns its element.');
  gate.resolve(); await Promise.all([rejected, stopped]);
  assert.equal(f.commands.some(command => command.action === 'watch'), false);
  assert.equal(f.elements.size, 0);
});

test('quality and output-device changes replace the actual receiver and retain current audio preferences', async t => {
  const f = fixture(t);
  f.watching(true); await f.controller.sync();
  f.quality('480p30'); await f.controller.sync();
  f.audio({ muted: true, volume: 80 });
  await f.controller.setOutputDeviceId('another-output');
  const watches = f.commands.filter(command => command.action === 'watch');
  assert.deepEqual(watches.map(command => command.quality), ['source', '480p30', '480p30']);
  assert.equal(new Set(watches.map(command => command.presentationId)).size, 3);
  assert.deepEqual(watches[2].audio, { sinkId: 'another-output', muted: true, volume: 0.8 });
  assert.equal(f.retired.length, 2);
});

test('failed quality retirement displays an error and Retry completes cleanup before restarting', async t => {
  const f = fixture(t);
  f.watching(true); await f.controller.sync();
  f.hook(async command => { if (command.action === 'stop') throw new Error('Retirement was not acknowledged.'); });
  f.quality('480p30');
  await assert.rejects(f.controller.sync(), /retirement failed/);
  assert.deepEqual(f.controller.getWatchState('publisher', f.remote.shareId), {
    state: 'unavailable', reason: 'connection-failed',
  });
  f.hook(async () => {});
  await f.controller.retry('publisher', f.remote.shareId);
  assert.equal(f.commands.filter(command => command.action === 'watch').at(-1).quality, '480p30');
  assert.equal(f.controller.getWatchState('publisher', f.remote.shareId).state, 'playing');
});

test('network loss retires local owners without forwarding to the replacement connection', async t => {
  const f = fixture(t);
  await f.local();
  f.disconnected();
  await f.controller.close();
  assert.equal(f.commands.at(-1).action, 'leave-local');
  assert.equal(f.requests.length, 0);
  assert.equal(f.mainListeners.size, 0);
});
