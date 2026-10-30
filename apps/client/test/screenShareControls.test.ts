import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MessageType, SCREEN_SHARE_LIMITS } from '@monky/shared';
import {
  captureScreenShareCall, notifyScreenShareState, screenShareLimit, stopLocalScreenShares,
} from '../src/renderer/core/screenShareControls';
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
  context.mock.method(videoService, 'getScreenShareIds', () => [...captures]);
  context.mock.method(videoService, 'stopScreenShare', (shareId?: string) => {
    stopped.push(shareId);
    if (shareId) captures.delete(shareId);
    else captures.clear();
  });
  const add = (shareId: string) => {
    captures.add(shareId);
    voiceStore.addScreenShare(shareId);
  };
  const native = (...shareIds: string[]) => {
    context.mock.method(videoService, 'getNativeScreenCapture', (shareId: string) => shareIds.includes(shareId) ? {
      source: { shareId, instanceId: crypto.randomUUID(), audio: false,
        video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } },
      desktopSourceId: 'window:12345:0', audioBitrateKbps: 64,
    } : null);
  };
  context.after(() => voiceStore.reset());
  return { call, visible, available, captures, stopped, messages, add, native };
}

test('stopping an audio-associated share keeps the other screen and notifies the call, not the visible server', async context => {
  const f = fixture(context);
  f.add('first');
  f.add('second');
  voiceStore.addScreenAudioShare('first');
  await stopLocalScreenShares({ shareIds: ['first'] });
  assert.deepEqual(f.stopped, ['first']);
  assert.deepEqual([...f.captures], ['second']);
  assert.deepEqual(voiceStore.screenShareIds, ['second']);
  assert.equal(voiceStore.isScreenSharing, true);
  assert.deepEqual(voiceStore.screenAudioShareIds, []);
  assert.deepEqual(f.messages, [{
    target: f.call.key, type: MessageType.VOICE_STATE_UPDATE,
    payload: { screenShareIds: ['second'], nativeScreenShares: [], isScreenSharing: true, isSharingScreenAudio: false },
  }]);
});

test('stopping a different share preserves the associated audio and stopping the final share ends it', async context => {
  const f = fixture(context);
  f.add('first');
  f.add('second');
  voiceStore.addScreenAudioShare('first');
  await stopLocalScreenShares({ shareIds: ['second'] });
  assert.deepEqual(voiceStore.screenAudioShareIds, ['first']);
  await stopLocalScreenShares({ shareIds: ['first'] });
  assert.deepEqual(voiceStore.screenAudioShareIds, []);
  assert.equal(voiceStore.isScreenSharing, false);
  assert.deepEqual(f.messages.at(-1)?.payload, { screenShareIds: [], nativeScreenShares: [], isScreenSharing: false, isSharingScreenAudio: false });
});

test('with several applications sharing their sound, stopping one keeps the others audible', async context => {
  const f = fixture(context);
  for (const shareId of ['first', 'second', 'silent']) f.add(shareId);
  voiceStore.addScreenAudioShare('first');
  voiceStore.addScreenAudioShare('second');
  await stopLocalScreenShares({ shareIds: ['first'] });
  assert.deepEqual(voiceStore.screenAudioShareIds, ['second']);
  assert.equal(voiceStore.hasScreenAudio, true);
  await stopLocalScreenShares({ shareIds: ['silent'] });
  assert.deepEqual(voiceStore.screenAudioShareIds, ['second'], 'A silent share takes no sound with it');
  await stopLocalScreenShares({ shareIds: ['second'] });
  assert.deepEqual(voiceStore.screenAudioShareIds, []);
  assert.equal(voiceStore.hasScreenAudio, false);
});

test('replacement stops only the old captures and audio, then publishes the replacement without an intermediate state', async context => {
  const f = fixture(context);
  f.add('old');
  voiceStore.addScreenAudioShare('old');
  f.captures.add('replacement');
  const call = captureScreenShareCall();
  await stopLocalScreenShares({ shareIds: ['old'], notify: false });
  assert.deepEqual([...f.captures], ['replacement']);
  assert.deepEqual(f.stopped, ['old']);
  assert.deepEqual(voiceStore.screenAudioShareIds, []);
  assert.deepEqual(f.messages, []);
  voiceStore.addScreenShare('replacement');
  notifyScreenShareState(call);
  assert.deepEqual(f.messages, [{
    target: f.call.key, type: MessageType.VOICE_STATE_UPDATE,
    payload: { screenShareIds: ['replacement'], nativeScreenShares: [], isScreenSharing: true, isSharingScreenAudio: false },
  }]);
});

test('full stop retires every capture and audio association even when no screen has reached the store', async context => {
  const f = fixture(context);
  f.captures.add('pending');
  voiceStore.addScreenAudioShare('pending');
  await stopLocalScreenShares();
  assert.deepEqual(f.stopped, [undefined], 'no-id stop retires every VideoService capture');
  assert.deepEqual(voiceStore.screenAudioShareIds, []);
  assert.deepEqual(f.messages.at(-1)?.payload, { screenShareIds: [], nativeScreenShares: [], isScreenSharing: false, isSharingScreenAudio: false });
});

test('source-ended also stops an acquired screen that is still awaiting publication', async context => {
  const f = fixture(context);
  f.captures.add('pending');
  voiceStore.addScreenAudioShare('pending');
  await stopLocalScreenShares({ shareIds: ['pending'] });
  assert.deepEqual(f.stopped, ['pending']);
  assert.deepEqual(voiceStore.screenShareIds, []);
  assert.deepEqual(voiceStore.screenAudioShareIds, [], 'its audio association goes with it');
});

test('teardown clears synchronously without screen state updates and cannot reset a successor call', async context => {
  const f = fixture(context);
  const retiring = gate();
  f.native('old');
  context.mock.method(webRtcManager, 'removeNativeScreenSource', () => retiring.promise);
  f.add('old');
  voiceStore.addScreenAudioShare('old');
  const stopped = stopLocalScreenShares({ teardown: true });
  assert.deepEqual(f.stopped, [undefined]);
  assert.deepEqual(voiceStore.screenShareIds, []);
  assert.deepEqual(f.messages, []);
  voiceStore.setChannel('next-room', f.visible.key);
  f.add('new');
  voiceStore.addScreenAudioShare('new');
  retiring.release();
  await stopped;
  assert.deepEqual(voiceStore.screenShareIds, ['new']);
  assert.deepEqual(voiceStore.screenAudioShareIds, ['new']);
  assert.deepEqual([...f.captures], ['new']);
  assert.deepEqual(f.messages, []);
});

test('the call server, not the visible one, decides how many screens may be published', context => {
  const f = fixture(context);
  const self = f.call.serverStore.currentUser!;
  const details = (features: string[]) => ({
    id: 'server', name: 'Server', createdAt: 1, maxUsers: 10, channels: [], voiceStates: {}, members: [self],
    protocol: { version: 38, minimumVersion: 35, features },
  });
  f.visible.serverStore.setServerDetails(details(['screen-shares-8']), self);
  assert.equal(screenShareLimit(captureScreenShareCall()), SCREEN_SHARE_LIMITS.legacy);
  f.call.serverStore.setServerDetails(details(['screen-viewers']), self);
  assert.equal(screenShareLimit(captureScreenShareCall()), SCREEN_SHARE_LIMITS.legacy, 'an older server keeps two screens');
  f.call.serverStore.setServerDetails(details(['screen-shares-8']), self);
  const limit = screenShareLimit(captureScreenShareCall());
  assert.equal(limit, SCREEN_SHARE_LIMITS.maximum);
  for (let index = 0; index < limit; index++) {
    assert.equal(voiceStore.canAddScreenShare(limit), true);
    f.add(`screen-${index}`);
  }
  assert.equal(voiceStore.canAddScreenShare(limit), false);
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

test('stop awaits every native retirement even when another one fails', async context => {
  const f = fixture(context);
  const retiring = gate();
  const failure = new Error('retirement failed');
  f.native('failing', 'slow');
  context.mock.method(webRtcManager, 'removeNativeScreenSource', async (shareId: string) => {
    if (shareId === 'failing') throw failure;
    await retiring.promise;
  });
  f.add('failing');
  f.add('slow');
  let settled = false;
  const stopped = stopLocalScreenShares();
  void stopped.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  retiring.release();
  await assert.rejects(stopped, error => error === failure);
  assert.deepEqual(voiceStore.screenShareIds, []);
});

test('native discovery includes only published source descriptors and never needs a browser video track', context => {
  const f = fixture(context);
  const source = { shareId: 'native', instanceId: crypto.randomUUID(), audio: true,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  context.mock.method(videoService, 'getNativeScreenCaptures', () => [{
    source, desktopSourceId: 'window:12345:0', audioBitrateKbps: 128,
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
    ? { source, desktopSourceId: 'window:12345:0', audioBitrateKbps: 64 } : null);
  context.mock.method(webRtcManager, 'removeNativeScreenSource', async (shareId: string) => {
    calls.push(shareId);
    assert.equal(voiceStore.screenShareIds.includes(shareId), false);
    assert.equal(f.messages.length, 0, 'Native cleanup still needs the announced source and subscription leases.');
    await retired.promise;
  });
  f.add('native');
  const stopping = stopLocalScreenShares();
  let done = false;
  void stopping.then(() => { done = true; }, () => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  assert.deepEqual(calls, ['native']);
  retired.release();
  await stopping;
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0].payload, {
    screenShareIds: [], nativeScreenShares: [], isScreenSharing: false, isSharingScreenAudio: false,
  });
});

test('a late native retirement cannot withdraw the sources of a successor call', async context => {
  const f = fixture(context), retired = gate();
  const source = { shareId: 'native', instanceId: crypto.randomUUID(), audio: true,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  context.mock.method(videoService, 'getNativeScreenCapture', (shareId: string) => shareId === source.shareId
    ? { source, desktopSourceId: 'window:12345:0', audioBitrateKbps: 64 } : null);
  context.mock.method(webRtcManager, 'removeNativeScreenSource', () => retired.promise);
  f.add(source.shareId);
  const stopping = stopLocalScreenShares();
  assert.deepEqual(f.messages, []);
  voiceStore.setChannel('next-room', f.visible.key);
  f.add('replacement');
  retired.release();
  await stopping;
  assert.deepEqual(f.messages, []);
  assert.deepEqual(voiceStore.screenShareIds, ['replacement']);
});

test('failed native retirement stays visible and withdraws the old roster only after cleanup settles', async context => {
  const f = fixture(context), retired = gate();
  const failure = new Error('Native resource did not acknowledge retirement.');
  const source = { shareId: 'native', instanceId: crypto.randomUUID(), audio: true,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  context.mock.method(videoService, 'getNativeScreenCapture', (shareId: string) => shareId === source.shareId
    ? { source, desktopSourceId: 'window:12345:0', audioBitrateKbps: 64 } : null);
  context.mock.method(webRtcManager, 'removeNativeScreenSource', async () => {
    assert.deepEqual(f.messages, []);
    await retired.promise;
    throw failure;
  });
  f.add(source.shareId);
  const stopping = stopLocalScreenShares();
  const rejected = assert.rejects(stopping, error => error === failure);
  assert.deepEqual(f.messages, []);
  retired.release();
  await rejected;
  assert.equal(f.messages.length, 1);
  assert.deepEqual(voiceStore.screenShareIds, []);
});
