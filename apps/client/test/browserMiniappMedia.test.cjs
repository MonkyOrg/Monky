'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');
const { randomUUID } = require('node:crypto');
const tick = () => new Promise(resolve => setImmediate(resolve));
const root = path.resolve(__dirname, '..', 'src', 'renderer');

function fixture(t, { sessionId = 'host', current = true, ice = [] } = {}) {
  const requests = [], publishers = [], receivers = [], videos = [], probes = [], errors = [], logs = [];
  const listeners = new Set();
  let connectionId = 'original', status = 'CONNECTED', publications = 0, publishReply, cleanupError;
  const publishGate = Promise.withResolvers();
  const closeGate = Promise.withResolvers();
  const screen = {
    id: 'browser', instanceId: randomUUID(), botId: 'bot', channelId: 'room', title: 'Browser',
    kind: 'browser', html: '', state: null, hostSessionId: 'host', broadcastSource: null, revision: 0, createdAt: 1,
  };
  class Track extends EventTarget {
    kind = 'video';
    readyState = 'live';
    getSettings() { return { width: 1280, height: 720, frameRate: 30 }; }
    clone() { return new Track(); }
    stop() { this.readyState = 'ended'; }
  }
  class Processor {
    constructor({ track, maxBufferSize }) {
      assert.equal(maxBufferSize, 1);
      const read = Promise.withResolvers();
      const probe = {
        track, cancelled: false, released: false, cleanupError: null,
        frame(width = 1280, height = 720) {
          const value = { displayWidth: width, displayHeight: height, closed: false, close() { this.closed = true; } };
          read.resolve({ done: false, value }); return value;
        },
        reject: read.reject,
      };
      probes.push(probe);
      this.readable = { getReader: () => ({
        read: () => read.promise,
        cancel: async () => { probe.cancelled = true; if (probe.cleanupError) throw probe.cleanupError; },
        releaseLock: () => { probe.released = true; },
      }) };
    }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    addTrack(track) { this.tracks.push(track); }
  }
  class Publisher {
    constructor(options) { this.options = options; this.closed = false; publishers.push(this); }
    async setParticipants(ids) { this.ids = ids; }
    receive(signal) { this.received = signal; }
    close(reason, notify) {
      this.closed = true; this.notify = notify;
      return closeGate.promise;
    }
  }
  class Receiver {
    constructor(options) { this.options = options; receivers.push(this); }
    async start() {}
    async receive(value) { this.received = value; }
    async close() { this.closed = true; }
    playing() { this.presented = true; }
  }
  const client = {
    getConnectionId: () => connectionId, getStatus: () => status, getIceServers: () => ice,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async sendRequest(type, payload) {
      requests.push({ type, payload });
      if (type === shared.MessageType.BOT_BROWSER_PUBLISH) {
        await publishGate.promise;
        return publishReply?.({ ...screen, broadcastSource: payload.source, revision: 1 })
          ?? { ...screen, broadcastSource: payload.source, revision: 1 };
      }
      if (type === shared.MessageType.BOT_SCREEN_END) {
        if (cleanupError) throw cleanupError;
        return { ...payload, channelId: 'room', reason: 'ended', endedByUserId: 'host' };
      }
      return { subscriptionId: payload.subscriptionId };
    },
  };
  const context = {
    client, participants: { getInVoiceChannel: () => [{ user: { sessionId: 'host' } }, { user: { sessionId: 'viewer' } }] },
    sessionId, channelId: 'room', mode: 'p2p', isCurrent: () => current && status === 'CONNECTED',
    announceSources() { publications++; },
  };
  const sandbox = vm.createContext({
    console: { error: (...args) => logs.push(args) }, crypto, DOMException, AbortController, EventTarget,
    MediaStream: Stream, MediaStreamTrackProcessor: Processor, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, setTimeout, clearTimeout,
    document: { createElement() {
      const video = Object.assign(new EventTarget(), {
        callback: null, srcObject: null, cancelled: false,
        readyState: 0, videoWidth: 0, videoHeight: 0,
        requestVideoFrameCallback(callback) { this.callback = callback; return 1; },
        cancelVideoFrameCallback() { this.cancelled = true; },
        async play() {}, pause() {}, remove() {}, setAttribute() {},
        data() {
          this.readyState = 2; this.videoWidth = 1280; this.videoHeight = 720;
          this.dispatchEvent(new Event('loadeddata'));
        },
        frame() {
          this.readyState = 2; this.videoWidth = 1280; this.videoHeight = 720;
          this.callback?.();
        },
      });
      videos.push(video); return video;
    } },
  });
  const compile = (relative, imports) => {
    const filename = path.join(root, relative);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: filename,
    }).outputText;
    const module = { exports: {} };
    const run = vm.runInContext(`(function(exports,require,module){${code}\n})`, sandbox, { filename });
    run(module.exports, request => request === '@monky/shared' ? shared : imports(request), module);
    return module.exports;
  };
  const config = compile(path.join('core', 'webrtc', 'nativeScreen', 'NativeScreenCall.ts'), () => ({}));
  const { BrowserMiniappMedia } = compile(path.join('core', 'webrtc', 'BrowserMiniappMedia.ts'), request => {
    if (request === './BrowserScreenSubscription') return { BrowserScreenSubscription: Receiver };
    if (request === './nativeScreen/NativeScreenCall') return config;
    if (request.endsWith('browserScreenProfile')) return { browserScreenProfile: value => value };
    if (request.endsWith('webScreenPublisher')) return { WebScreenPublisher: Publisher };
    if (request === '../ClientLogService') return { clientLog: { logError: (...args) => logs.push(args) } };
    throw new Error(`Unexpected import: ${request}`);
  });
  const media = new BrowserMiniappMedia(() => context);
  const { BotBrowserViewer } = compile(path.join('views', 'BotBrowserViewer.ts'), request => {
    if (request === '../core/WebRtcManager') return { webRtcManager: { browserMiniappMedia: media } };
    if (request === '../i18n') return { t: key => key };
    throw new Error(`Unexpected viewer import: ${request}`);
  });
  const track = new Track(), stream = new Stream([track]), abort = new AbortController();
  const host = () => media.host(screen, stream, error => errors.push(error), abort.signal);
  t.after(async () => { publishGate.resolve(); closeGate.resolve(); current = false; await media.closeAll(); });
  return {
    media, screen, track, stream, abort, videos, probes, requests, publishers, receivers, logs, errors, listeners,
    host, publishGate, closeGate, Track, Stream, BotBrowserViewer,
    current: value => { current = value; }, reconnect: () => { connectionId = 'replacement'; },
    reply: value => { publishReply = value; }, rejectCleanup: error => { cleanupError = error; },
    emit: (event, payload) => { for (const listener of [...listeners]) listener(event, payload); },
    announcements: () => publications,
  };
}

test('browser denied publication logs the exact operation and preserves the refusal without leaking capture', async t => {
  const f = fixture(t);
  const denied = Object.assign(new Error('Permission denied'), { code: shared.ProtocolErrorCode.PERMISSION_DENIED });
  f.reply(() => { throw denied; });
  f.publishGate.resolve();
  const starting = f.host();
  f.probes[0].frame();
  await assert.rejects(starting, error => error === denied);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.media.localSources().length, 0);
  assert.ok(f.logs.some(([category, operation, error]) =>
    category === 'SCREEN_SHARE' && operation === 'Browser publication request failed' && error === denied));
});

test('browser pending first frame is cancelled immediately and cannot publish after abort', async t => {
  const f = fixture(t);
  const starting = f.host();
  assert.notEqual(f.probes[0].track, f.track);
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  f.abort.abort();
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.probes[0].track.readyState, 'ended');
  assert.equal(f.probes[0].cancelled, true);
  await rejected;
  assert.equal(f.probes[0].released, true);
  const late = f.probes[0].frame();
  await tick();
  assert.equal(late.closed, true, 'An already-retired probe still closes a late frame');
  assert.equal(f.media.localSources().length, 0);
  assert.equal(f.requests.some(request => request.type === shared.MessageType.BOT_BROWSER_PUBLISH), false);
  assert.equal(f.requests.filter(request => request.type === shared.MessageType.BOT_SCREEN_END).length, 1);
  assert.equal(f.listeners.size, 0);
});

test('browser first-frame timeout stops capture, cleans listeners and never publishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), starting = f.host();
  const rejected = assert.rejects(starting, /no video frame/);
  t.mock.timers.tick(15000);
  await rejected;
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.probes[0].track.readyState, 'ended');
  assert.equal(f.probes[0].cancelled && f.probes[0].released, true);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.requests.some(request => request.type === shared.MessageType.BOT_BROWSER_PUBLISH), false);
});

test('browser admits a real frame on a disposable clone and publishes the original without any video compositor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.publishGate.resolve();
  const starting = f.host(), probe = f.probes[0];
  await tick();
  assert.equal(f.requests.some(request => request.type === shared.MessageType.BOT_BROWSER_PUBLISH), false);
  const frame = probe.frame();
  await tick();
  t.mock.timers.tick(15000);
  const handle = await starting;
  assert.equal(f.requests.filter(request => request.type === shared.MessageType.BOT_BROWSER_PUBLISH).length, 1);
  assert.equal(frame.closed && probe.cancelled && probe.released, true);
  assert.equal(probe.track.readyState, 'ended');
  assert.equal(f.track.readyState, 'live');
  assert.equal(f.publishers[0].options.capture.video, f.track);
  assert.equal(f.videos.length, 0);
  handle.close();
  assert.equal(f.track.readyState, 'ended');
});

test('browser rejects empty frames, read failures and probe cleanup failures without publishing or leaking its clone', async t => {
  for (const failure of ['empty', 'read', 'cleanup']) {
    const f = fixture(t), starting = f.host(), probe = f.probes[0];
    const rejected = assert.rejects(starting, failure === 'empty' ? /without a video frame/ :
      failure === 'read' ? /read failed/ : /probe cleanup failed/);
    if (failure === 'read') probe.reject(new Error('read failed'));
    else {
      if (failure === 'cleanup') probe.cleanupError = new Error('cancel failed');
      const frame = probe.frame(failure === 'empty' ? 0 : 1280);
      await tick();
      assert.equal(frame.closed, true);
    }
    await rejected;
    assert.equal(probe.track.readyState, 'ended');
    assert.equal(probe.cancelled && probe.released, true);
    assert.equal(f.track.readyState, 'ended');
    assert.equal(f.publishers.length, 0);
  }
});

test('browser late publication ACK cannot revive capture and pending sources are not advertised', async t => {
  const f = fixture(t), starting = f.host();
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  f.probes[0].frame(); await tick();
  assert.equal(f.requests.filter(request => request.type === shared.MessageType.BOT_BROWSER_PUBLISH).length, 1);
  assert.equal(f.media.localSources().length, 0);
  f.abort.abort();
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.publishers[0].closed, true);
  f.publishGate.resolve();
  await rejected;
  f.closeGate.resolve(); await f.media.closeAll();
  assert.equal(f.media.localSources().length, 0);
  assert.equal(f.requests.filter(request => request.type === shared.MessageType.BOT_SCREEN_END).length, 1);
});

test('browser duplicate capture cannot disturb the pending original host', async t => {
  const f = fixture(t), original = f.host();
  const other = new f.Track();
  await assert.rejects(f.media.host(f.screen, new f.Stream([other]), () => {}), /already owns/);
  assert.equal(other.readyState, 'ended');
  assert.equal(f.track.readyState, 'live');
  f.probes[0].frame(); f.publishGate.resolve();
  const handle = await original;
  assert.equal(f.media.localSources().length, 1);
  handle.close();
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.publishers[0].closed, true);
  assert.ok(f.announcements() >= 2);
});

test('browser rejects another host session and unavailable or malformed call config without leaking capture', async t => {
  for (const options of [
    { sessionId: 'another-login-of-host' }, { current: false },
    { ice: [{ urls: Array.from({ length: 33 }, (_, index) => `stun:server-${index}.example`) }] },
  ]) {
    const f = fixture(t, options);
    await assert.rejects(f.host());
    assert.equal(f.track.readyState, 'ended');
    assert.equal(f.publishers.length, 0);
  }
});

test('browser ICE config preserves all URLs and credentials in schema-sized chunks', async t => {
  const urls = Array.from({ length: 7 }, (_, index) => `turn:server-${index}.example`);
  const f = fixture(t, { ice: [{ urls, username: 'qa', credential: 'qa-only' }] });
  const starting = f.host(); f.probes[0].frame(); await tick();
  const servers = f.publishers[0].options.call.iceServers;
  assert.deepEqual(servers.flatMap(server => server.urls), urls);
  assert.deepEqual(servers.map(server => server.urls.length), [4,3]);
  assert.ok(servers.every(server => server.username === 'qa' && server.credential === 'qa-only'));
  f.publishGate.resolve(); await starting;
});

test('browser server revocation closes pending publication without issuing a redundant END', async t => {
  const f = fixture(t), starting = f.host();
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  f.probes[0].frame(); await tick();
  f.media.retire(f.screen);
  f.abort.abort(); f.publishGate.resolve();
  await rejected;
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.publishers[0].notify, false);
  assert.equal(f.requests.some(request => request.type === shared.MessageType.BOT_SCREEN_END), false);
});

test('browser replacement connection retires capture without sending END to the new connection', async t => {
  const f = fixture(t), starting = f.host();
  f.probes[0].frame(); f.publishGate.resolve(); await starting;
  f.reconnect(); f.emit('network.status', 'CONNECTED');
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.media.localSources().length, 0);
  assert.equal(f.requests.some(request => request.type === shared.MessageType.BOT_SCREEN_END), false);
  assert.equal(f.publishers[0].notify, false);
});

test('browser viewer retires video on exact server removal and refuses undeclared audio', async t => {
  const f = fixture(t, { sessionId: 'viewer' });
  const screen = { ...f.screen, broadcastSource: {
    shareId: `browser-${f.screen.instanceId}`, instanceId: f.screen.instanceId, audio: false, codec: 'h264',
    video: { width: 1280, height: 720, fps: 30, maxBitrateKbps: 6000 },
  } };
  await f.media.watch(screen, () => {}, error => f.errors.push(error));
  const receiver = f.receivers[0], received = new f.Track();
  receiver.options.onTrack(received);
  f.emit(`message.${shared.MessageType.BOT_SCREEN_REMOVED}`, {
    id: screen.id, instanceId: randomUUID(), channelId: screen.channelId, reason: 'closed',
  });
  assert.equal(received.readyState, 'live');
  f.emit(`message.${shared.MessageType.BOT_SCREEN_REMOVED}`, {
    id: screen.id, instanceId: screen.instanceId, channelId: screen.channelId, reason: 'closed',
  });
  assert.equal(received.readyState, 'ended');
  assert.equal(receiver.closed, true);
  assert.equal(f.requests.some(request => request.type === shared.MessageType.BOT_SCREEN_END), false);
  await f.media.watch(screen, () => {}, error => f.errors.push(error));
  const audio = new f.Track(); audio.kind = 'audio';
  f.receivers[1].options.onTrack(audio);
  assert.equal(audio.readyState, 'ended');
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /undeclared audio/);
});

test('browser shutdown stops pixels synchronously but waits for owned media retirement', async t => {
  const f = fixture(t), starting = f.host();
  f.probes[0].frame(); f.publishGate.resolve(); await starting;
  let retired = false;
  const closing = f.media.closeAll().then(() => { retired = true; });
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.publishers[0].closed, true);
  await tick(); assert.equal(retired, false);
  f.closeGate.resolve(); await closing;
  assert.equal(retired, true);
});

test('browser publication ACK must identify this exact host, instance and video-only rendition', async t => {
  for (const change of [
    reply => ({ ...reply, id: 'another-browser' }),
    reply => ({ ...reply, instanceId: randomUUID() }),
    reply => ({ ...reply, hostSessionId: 'another-host' }),
    reply => ({ ...reply, broadcastSource: { ...reply.broadcastSource, audio: true } }),
  ]) {
    const f = fixture(t); f.reply(change);
    const starting = f.host(), rejected = assert.rejects(starting);
    f.probes[0].frame(); f.publishGate.resolve(); await rejected;
    assert.equal(f.track.readyState, 'ended');
    assert.equal(f.media.localSources().length, 0);
    assert.equal(f.publishers[0].closed, true);
    assert.equal(f.requests.filter(request => request.type === shared.MessageType.BOT_SCREEN_END).length, 1);
  }
});

test('browser failure never degrades to a personal browser and still reports cleanup refusal', async t => {
  const f = fixture(t), starting = f.host();
  f.probes[0].frame(); f.publishGate.resolve(); await starting;
  f.rejectCleanup(new Error('cleanup refused'));
  f.publishers[0].options.onError(new Error('capture failed'));
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.publishers[0].notify, true);
  assert.match(String(f.errors[0]), /capture failed/);
  f.closeGate.resolve(); await tick();
  assert.equal(f.logs.length, 1);
  assert.match(String(f.logs[0]), /cleanup refused/);
  assert.equal(f.media.localSources().length, 0);
});

test('browser source withdrawal closes viewer normally but connection failure remains explicit', async t => {
  const f = fixture(t, { sessionId: 'viewer' });
  const screen = { ...f.screen, broadcastSource: {
    shareId: `browser-${f.screen.instanceId}`, instanceId: f.screen.instanceId, audio: false, codec: 'h264',
    video: { width: 1280, height: 720, fps: 30, maxBitrateKbps: 6000 },
  } };
  let closed = 0;
  await f.media.watch(screen, () => {}, error => f.errors.push(error), undefined, () => { closed++; });
  f.receivers[0].options.onUnavailable('source-unavailable');
  assert.equal(closed, 1);
  assert.equal(f.errors.length, 0);
  assert.equal(f.receivers[0].closed, true);
  await f.media.watch(screen, () => {}, error => f.errors.push(error), undefined, () => { closed++; });
  f.receivers[1].options.onUnavailable('connection-failed');
  assert.equal(closed, 1);
  assert.match(String(f.errors[0]), /connection-failed/);
  assert.equal(f.receivers[1].closed, true);
});

test('viewer suppresses only playback failures belonging to a retired surface', async t => {
  for (const retired of [false, true]) {
    const f = fixture(t, { sessionId: 'viewer' });
    const screen = { ...f.screen, broadcastSource: {
      shareId: `browser-${f.screen.instanceId}`, instanceId: f.screen.instanceId, audio: false, codec: 'h264',
      video: { width: 1280, height: 720, fps: 30, maxBitrateKbps: 6000 },
    } };
    const surface = new f.BotBrowserViewer(screen, error => f.errors.push(error), () => surface.retire('ended'));
    const playback = Promise.withResolvers(), track = new f.Track();
    surface.element.play = () => playback.promise;
    f.receivers[0].options.onTrack(track);
    if (retired) surface.retire('ended');
    playback.reject(new Error('Playback failed'));
    await tick();
    assert.equal(f.errors.length, retired ? 0 : 1);
    if (!retired) assert.match(String(f.errors[0]), /Playback failed/);
    surface.retire('leave');
    assert.equal(surface.element.srcObject, null);
    assert.equal(track.readyState, 'ended');
  }
});
