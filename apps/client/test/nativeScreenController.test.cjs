'use strict';

// Renderer ownership and races without devices. nativeScreenAppSmoke covers the
// actual Main/preload, captured media and DOM presentation.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
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

function fixture(t, { iceServers = [] } = {}) {
  const commands = [], replies = [], events = [], errors = [], captures = new Map(), participants = new Map();
  const mainListeners = new Set(), presentationListeners = new Set(), networkListeners = new Set();
  const calls = new Set(), sources = new Map(), sourceIntents = new Map(), watches = new Map();
  const elements = new Map(), attached = new Map(), retired = [], stopped = [], requests = [], replyGates = new Map();
  let commandHook = async () => {}, attachHook = async () => {}, current = true, connectionId = 'connection-one';
  let status = 'CONNECTED', watching = false, quality = 'source', muted = false, deafened = false, volume = 100, announces = 0;
  const remote = { shareId: 'remote-screen', instanceId: randomUUID(), video, audio: true };
  class Stream {}
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
        case 'capabilities': return { kind: 'capabilities',
          capabilities: { capture: true, captureAudio: true, receive: true, backend: 'libobs-amf', reason: null } };
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
    '../EventBus': { appEvents: { emit: (...value) => {
      events.push(value);
      if (value[0] === 'local.screen_ended_externally') captures.delete(value[1]);
    } } },
    '../sessionRouting': { emitOutsideRouting: run => run() },
    '../ClientLogService': { clientLog: {
      error: (...value) => errors.push(value), warn: (...value) => errors.push(value),
    } },
    '../VideoService': { videoService: {
      getNativeScreenCapture: id => captures.get(id) ?? null,
      getNativeScreenCaptures: () => [...captures.values()],
      updateNativeScreenCapture: capture => {
        assert.ok(captures.has(capture.source.shareId));
        captures.set(capture.source.shareId, capture);
      },
    } },
    '../../stores/settingsStore': { settingsStore: { getScreenAudioVolume: () => volume } },
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
  const local = async () => {
    const source = await controller.addSource(input);
    captures.set(source.shareId, { ...input, source });
    return source;
  };
  const emitForCall = value => emit({ callId: commands.findLast(command => command.action === 'join').callId, ...value });
  t.after(async () => {
    commandHook = async () => {};
    await controller.close();
    assert.equal(calls.size, 0);
    assert.equal(mainListeners.size + networkListeners.size + presentationListeners.size, 0);
    assert.equal(elements.size + attached.size, 0);
  });
  return { controller, local, captures, sources, commands, events, errors, replies, requests, watches, elements, stopped, retired,
    mainListeners, networkListeners, context, remote, nativeScreenProfile: exports.nativeScreenProfile,
    emit: emitForCall, announceCount: () => announces,
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

test('native profile alignment is explicit and unsupported ceilings are not silently clamped', t => {
  const f = fixture(t);
  assert.equal(f.nativeScreenProfile(profile(854, 480)).width, 852);
  assert.equal(f.nativeScreenProfile(profile(2560, 1440)), null);
  assert.equal(f.nativeScreenProfile(profile(1920, 1080, 121)), null);
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
