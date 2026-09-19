import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MessageType } from '@monky/shared';
import { captureScreenShareCall, notifyScreenShareState, stopLocalScreenShares } from '../src/renderer/core/screenShareControls';
import { SessionManager, sessionManager } from '../src/renderer/core/SessionManager';
import { videoService } from '../src/renderer/core/VideoService';
import { webRtcManager } from '../src/renderer/core/WebRtcManager';
import { voiceStore } from '../src/renderer/stores/voiceStore';

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}

function fixture(context: TestContext) {
  voiceStore.reset();
  const sessions = new SessionManager();
  const call = sessions.create('call.invalid', 10101, 'Self');
  const visible = sessions.create('visible.invalid', 10102, 'Self');
  call.serverStore.currentUser = {
    id: 'self', sessionId: 'call-session', clientId: 'client', nickname: 'Self', status: 'ONLINE', joinedAt: 1,
  };
  const available = new Map([[call.key, call], [visible.key, visible]]);
  context.mock.method(sessionManager, 'get', (key: string) => available.get(key));
  context.mock.method(sessionManager, 'getActive', () => visible);
  const messages: Array<{ target: string; type: MessageType; payload: unknown }> = [];
  for (const session of [call, visible]) {
    context.mock.method(session.client, 'send', (type: MessageType, payload: unknown) => {
      messages.push({ target: session.key, type, payload });
    });
  }
  voiceStore.setChannel('room', call.key);
  const captures = new Set<string>();
  const stopped: Array<string | undefined> = [];
  const detached: string[] = [];
  let clears = 0;
  context.mock.method(videoService, 'getScreenShareIds', () => [...captures]);
  context.mock.method(videoService, 'stopScreenShare', (shareId?: string) => {
    stopped.push(shareId);
    if (shareId) captures.delete(shareId);
    else captures.clear();
  });
  context.mock.method(webRtcManager, 'removeLocalScreenTrack', async (shareId: string) => {
    detached.push(shareId);
  });
  context.mock.method(webRtcManager, 'clearLocalScreenTracks', () => { clears++; });
  const audio = {
    stops: 0,
    associations: [] as Array<string | null>,
    async stop() {
      this.stops++;
      this.associations.push(voiceStore.screenAudioShareId);
    },
  };
  const add = (shareId: string) => {
    captures.add(shareId);
    voiceStore.addScreenShare(shareId);
  };
  context.after(() => voiceStore.reset());
  return { call, visible, available, captures, stopped, detached, messages, audio, add, clears: () => clears };
}

test('stopping an audio-associated share keeps the other screen and notifies the call, not the visible server', async context => {
  const f = fixture(context);
  f.add('first');
  f.add('second');
  voiceStore.setScreenAudioShare('first');
  await stopLocalScreenShares(f.audio, { shareIds: ['first'] });
  assert.deepEqual(f.stopped, ['first']);
  assert.deepEqual(f.detached, ['first']);
  assert.deepEqual([...f.captures], ['second']);
  assert.deepEqual(voiceStore.screenShareIds, ['second']);
  assert.equal(voiceStore.isScreenSharing, true);
  assert.equal(voiceStore.screenAudioShareId, null);
  assert.equal(f.audio.stops, 1);
  assert.deepEqual(f.audio.associations, ['first'], 'stop pending audio before removeScreenShare forgets its owner');
  assert.deepEqual(f.messages, [{
    target: f.call.key, type: MessageType.VOICE_STATE_UPDATE,
    payload: { screenShareIds: ['second'], nativeScreenShares: [], isScreenSharing: true, isSharingScreenAudio: false },
  }]);
});

test('stopping a different share preserves the associated audio and stopping the final share ends it', async context => {
  const f = fixture(context);
  f.add('first');
  f.add('second');
  voiceStore.setScreenAudioShare('first');
  await stopLocalScreenShares(f.audio, { shareIds: ['second'] });
  assert.equal(f.audio.stops, 0);
  assert.equal(voiceStore.screenAudioShareId, 'first');
  await stopLocalScreenShares(f.audio, { shareIds: ['first'] });
  assert.equal(f.audio.stops, 1);
  assert.equal(voiceStore.isScreenSharing, false);
  assert.deepEqual(f.messages.at(-1)?.payload, { screenShareIds: [], nativeScreenShares: [], isScreenSharing: false, isSharingScreenAudio: false });
});

test('replacement stops only the old captures and audio, then publishes the replacement without an intermediate state', async context => {
  const f = fixture(context);
  f.add('old');
  voiceStore.setScreenAudioShare('old');
  f.captures.add('replacement');
  const call = captureScreenShareCall();
  await stopLocalScreenShares(f.audio, { shareIds: ['old'], notify: false });
  assert.deepEqual([...f.captures], ['replacement']);
  assert.deepEqual(f.stopped, ['old']);
  assert.equal(f.audio.stops, 1);
  assert.deepEqual(f.messages, []);
  voiceStore.addScreenShare('replacement');
  notifyScreenShareState(call);
  assert.deepEqual(f.messages, [{
    target: f.call.key, type: MessageType.VOICE_STATE_UPDATE,
    payload: { screenShareIds: ['replacement'], nativeScreenShares: [], isScreenSharing: true, isSharingScreenAudio: false },
  }]);
});

test('full stop cancels acquisition and pending audio even when no screen has reached the store', async context => {
  const f = fixture(context);
  await stopLocalScreenShares(f.audio);
  assert.deepEqual(f.stopped, [undefined], 'no-id stop invalidates VideoService acquisition epochs');
  assert.equal(f.audio.stops, 1, 'do not gate cancellation on getIsCapturing');
  assert.deepEqual(f.detached, []);
  assert.deepEqual(f.messages.at(-1)?.payload, { screenShareIds: [], nativeScreenShares: [], isScreenSharing: false, isSharingScreenAudio: false });
});

test('source-ended also detaches an acquired screen that is still awaiting publication', async context => {
  const f = fixture(context);
  f.captures.add('pending');
  await stopLocalScreenShares(f.audio, { shareIds: ['pending'] });
  assert.deepEqual(f.stopped, ['pending']);
  assert.deepEqual(f.detached, ['pending']);
  assert.equal(f.audio.stops, 1);
  assert.deepEqual(voiceStore.screenShareIds, []);
});

test('teardown clears synchronously without renegotiation or screen state updates and cannot reset a successor call', async context => {
  const f = fixture(context);
  const stoppingAudio = gate();
  context.mock.method(f.audio, 'stop', () => stoppingAudio.promise);
  f.add('old');
  voiceStore.setScreenAudioShare('old');
  const stopped = stopLocalScreenShares(f.audio, { teardown: true });
  assert.equal(f.clears(), 1);
  assert.deepEqual(f.stopped, [undefined]);
  assert.deepEqual(f.detached, []);
  assert.deepEqual(voiceStore.screenShareIds, []);
  assert.deepEqual(f.messages, []);
  voiceStore.setChannel('next-room', f.visible.key);
  f.add('new');
  voiceStore.setScreenAudioShare('new');
  stoppingAudio.release();
  await stopped;
  assert.deepEqual(voiceStore.screenShareIds, ['new']);
  assert.equal(voiceStore.screenAudioShareId, 'new');
  assert.deepEqual([...f.captures], ['new']);
  assert.deepEqual(f.messages, []);
});

test('a slow detach never sends an old screen update to a successor call', async context => {
  const f = fixture(context);
  const detaching = gate();
  context.mock.method(webRtcManager, 'removeLocalScreenTrack', () => detaching.promise);
  f.add('old');
  const stopped = stopLocalScreenShares(f.audio);
  assert.equal(voiceStore.isScreenSharing, false);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].target, f.call.key);
  voiceStore.setChannel('room', f.visible.key);
  f.add('new');
  detaching.release();
  await stopped;
  assert.deepEqual(voiceStore.screenShareIds, ['new']);
  assert.equal(f.messages.length, 1);
});

test('call snapshots reject changed rooms and removed sessions rather than falling back to visible proxies', context => {
  const f = fixture(context);
  const call = captureScreenShareCall();
  voiceStore.setChannel('other-room', f.call.key);
  notifyScreenShareState(call);
  assert.deepEqual(f.messages, []);
  voiceStore.setChannel('room', f.call.key);
  f.available.delete(f.call.key);
  assert.equal(call.isCurrent(), false);
  const missing = captureScreenShareCall();
  assert.equal(missing.client, null);
  assert.equal(missing.isCurrent(), false);
  notifyScreenShareState(missing);
  assert.deepEqual(f.messages, []);
});

test('stop awaits audio cleanup even when detachment fails', async context => {
  const f = fixture(context);
  const stoppingAudio = gate();
  const failure = new Error('detach failed');
  context.mock.method(f.audio, 'stop', () => stoppingAudio.promise);
  context.mock.method(webRtcManager, 'removeLocalScreenTrack', async () => { throw failure; });
  f.add('screen');
  let settled = false;
  const stopped = stopLocalScreenShares(f.audio);
  void stopped.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  stoppingAudio.release();
  await assert.rejects(stopped, error => error === failure);
  assert.deepEqual(voiceStore.screenShareIds, []);
});

test('native discovery includes only published source descriptors and never needs a browser video track', context => {
  const f = fixture(context);
  const source = { shareId: 'native', instanceId: crypto.randomUUID(), audio: true,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  context.mock.method(videoService, 'getNativeScreenCaptures', () => [{
    source, desktopSourceId: 'window:12345:0', thumbnail: '', audioBitrateKbps: 128,
  }]);
  const call = captureScreenShareCall();
  notifyScreenShareState(call);
  assert.deepEqual(f.messages.at(-1)?.payload, {
    screenShareIds: [], nativeScreenShares: [], isScreenSharing: false, isSharingScreenAudio: false,
  });
  f.add('native');
  notifyScreenShareState(call);
  assert.deepEqual(f.messages.at(-1)?.payload, {
    screenShareIds: ['native'], nativeScreenShares: [source], isScreenSharing: true, isSharingScreenAudio: true,
  });
});

test('stopping a native share awaits its media owner after removing the local placeholder', async context => {
  const f = fixture(context);
  const retired = gate(), calls: string[] = [];
  const source = { shareId: 'native', instanceId: crypto.randomUUID(), audio: false,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  context.mock.method(videoService, 'getNativeScreenCapture', (shareId: string) => shareId === 'native'
    ? { source, desktopSourceId: 'window:12345:0', thumbnail: '', audioBitrateKbps: 64 } : null);
  context.mock.method(webRtcManager, 'removeNativeScreenSource', async (shareId: string) => {
    calls.push(shareId);
    assert.equal(voiceStore.screenShareIds.includes(shareId), false);
    await retired.promise;
  });
  f.add('native');
  const stopping = stopLocalScreenShares(f.audio);
  let done = false;
  void stopping.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  assert.deepEqual(calls, ['native']);
  retired.release();
  await stopping;
});
