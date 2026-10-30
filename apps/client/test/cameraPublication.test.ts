import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MessageType } from '@monky/shared';
import { appEvents } from '../src/renderer/core/EventBus';
import { clientLog } from '../src/renderer/core/ClientLogService';
import { bindCameraPublication, toggleCamera, turnCameraOff } from '../src/renderer/core/CameraPublication';
import { SessionManager, sessionManager } from '../src/renderer/core/SessionManager';
import { videoService, type CameraState } from '../src/renderer/core/VideoService';
import { webRtcManager } from '../src/renderer/core/WebRtcManager';
import { voiceStore } from '../src/renderer/stores/voiceStore';

function track(id: string): MediaStreamTrack {
  let state: MediaStreamTrackState = 'live';
  return {
    id, kind: 'video', enabled: true,
    get readyState() { return state; },
    stop() { state = 'ended'; },
  } as MediaStreamTrack;
}

class Stream extends EventTarget implements MediaStream {
  public active = true;
  public onaddtrack: MediaStream['onaddtrack'] = null;
  public onremovetrack: MediaStream['onremovetrack'] = null;
  private readonly tracks: MediaStreamTrack[];
  constructor(public readonly id: string) {
    super();
    this.tracks = [track(id)];
  }
  clone() { return new Stream(this.id); }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((entry): entry is MediaStreamVideoTrack => entry.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((entry): entry is MediaStreamAudioTrack => entry.kind === 'audio'); }
  getTrackById(id: string) { return this.tracks.find(entry => entry.id === id) ?? null; }
  addTrack() {}
  removeTrack() {}
}

/** A camera stream whose only track is its video. */
const stream = (id: string): MediaStream => new Stream(id);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * A call on its own server session, a capture that announces its stops like
 * VideoService does, and a transport that records what it was asked to publish.
 */
function fixture(t: TestContext) {
  appEvents.clear();
  voiceStore.reset();
  const sessions = new SessionManager();
  const call = sessions.create('camera-call.invalid', 10101, 'Self');
  t.mock.method(sessionManager, 'get', (key: string) => key === call.key ? call : undefined);
  const states: boolean[] = [];
  t.mock.method(call.client, 'send', (type: MessageType, payload: { isCameraOn?: boolean }) => {
    if (type === MessageType.VOICE_STATE_UPDATE && payload.isCameraOn !== undefined) states.push(payload.isCameraOn);
  });
  voiceStore.setChannel('room', call.key);

  let current: MediaStream | null = null;
  let announced = false;
  let nextStart: Promise<MediaStream> | null = null;
  t.mock.method(videoService, 'startCamera', async () => {
    const started = await (nextStart ?? Promise.resolve(stream(`camera-${Math.random()}`)));
    nextStart = null;
    current = started;
    announced = true;
    return started;
  });
  const stops = t.mock.method(videoService, 'stopCamera', () => {
    current = null;
    // VideoService only announces the stop of a camera it announced.
    if (announced) {
      announced = false;
      appEvents.emit('local.camera_stopped');
    }
  });
  t.mock.method(videoService, 'getCameraStream', () => current);
  t.mock.method(videoService, 'getCameraState', (): CameraState => ({
    status: current ? 'ready' : 'idle', stream: current, publishing: announced, error: null,
  }));

  const published: Array<MediaStreamTrack | null> = [];
  let publication: (track: MediaStreamTrack | null) => Promise<void> = async () => {};
  t.mock.method(webRtcManager, 'setLocalCameraTrack', (value: MediaStreamTrack | null) => {
    published.push(value);
    return publication(value);
  });
  const notices: unknown[] = [];
  appEvents.on('camera.error_notice', error => notices.push(error));
  t.mock.method(clientLog, 'error', () => {});
  const unbind = bindCameraPublication();
  t.after(() => {
    unbind();
    appEvents.clear();
    voiceStore.reset();
  });
  return {
    call, states, published, notices, stops,
    holdNextStart() {
      const gate = deferred<MediaStream>();
      nextStart = gate.promise;
      return gate;
    },
    publishWith(handler: (track: MediaStreamTrack | null) => Promise<void>) { publication = handler; },
    replaceSource(next: MediaStream) {
      const previousStream = current;
      assert.ok(previousStream, 'only a running camera is replaced');
      current = next;
      appEvents.emit('local.camera_replaced', { stream: next, previousStream });
    },
  };
}

test('turning the camera off publishes the stop once, though the capture announces it too (R-VOICE-9)', async t => {
  const f = fixture(t);
  await toggleCamera();
  assert.equal(voiceStore.isCameraOn, true);
  assert.equal(f.published.length, 1);
  assert.notEqual(f.published[0], null);

  await toggleCamera();
  assert.equal(voiceStore.isCameraOn, false);
  assert.equal(f.stops.mock.callCount(), 1);
  assert.deepEqual(f.published.slice(1), [null], 'one stop reaches the transport, not one per path');
  assert.deepEqual(f.states, [true, false], 'the call hears each state once');
});

test('a stop that starts anywhere else (settings, a failed effect) also unpublishes once', async t => {
  const f = fixture(t);
  await toggleCamera();
  videoService.stopCamera();
  await settle();
  assert.deepEqual(f.published.slice(1), [null]);
  assert.equal(voiceStore.isCameraOn, false);
  assert.deepEqual(f.states, [true, false]);
});

test('a second toggle cancels a start that is still capturing; the late camera is never published', async t => {
  const f = fixture(t);
  const capture = f.holdNextStart();
  const starting = toggleCamera();
  await settle();
  await toggleCamera();
  capture.resolve(stream('late'));
  await starting;
  assert.deepEqual(f.published, [null], 'only the cancellation reaches the transport');
  assert.equal(voiceStore.isCameraOn, false);
  assert.deepEqual(f.states, [], 'camera-on is never announced');
  await toggleCamera();
  assert.equal(voiceStore.isCameraOn, true, 'the next toggle starts the camera again');
});

test('a camera that finishes starting after the call moved on is dropped', async t => {
  const f = fixture(t);
  const capture = f.holdNextStart();
  const starting = toggleCamera();
  await settle();
  voiceStore.setChannel('other-room', f.call.key);
  capture.resolve(stream('previous-room'));
  await starting;
  assert.deepEqual(f.published, []);
  assert.equal(voiceStore.isCameraOn, false);
  assert.deepEqual(f.notices, [], 'a superseded start is not an error');
});

test('a failed publication rolls the camera back, stops the capture and is reported once', async t => {
  const f = fixture(t);
  const failure = new Error('fixture publication failure');
  f.publishWith(async value => { if (value) throw failure; });
  await toggleCamera();
  assert.equal(voiceStore.isCameraOn, false);
  assert.equal(f.stops.mock.callCount(), 1);
  assert.equal(f.published.length, 2);
  assert.equal(f.published[1], null, 'the failed track is unpublished once');
  assert.deepEqual(f.notices, [failure]);
  assert.deepEqual(f.states, []);
});

test('a replacement while a start is still publishing takes over, and a stale failure stops nothing', async t => {
  const f = fixture(t);
  const first = deferred<void>();
  f.publishWith(() => first.promise);
  const starting = toggleCamera();
  await settle();
  f.publishWith(async () => {});
  const replacement = stream('replacement');
  f.replaceSource(replacement);
  first.reject(new Error('fixture stale native failure'));
  await starting;
  await settle();
  assert.equal(f.published.at(-1), replacement.getVideoTracks()[0]);
  assert.equal(f.stops.mock.callCount(), 0, 'the newer source keeps running');
  assert.equal(voiceStore.isCameraOn, true);
  assert.deepEqual(f.notices, []);
  await turnCameraOff();
  assert.equal(f.published.at(-1), null);
  assert.deepEqual(f.states, [true, false]);
});
