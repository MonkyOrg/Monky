import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { videoService } from '../src/renderer/core/VideoService';
import { cameraEffectsStore } from '../src/renderer/stores/cameraEffectsStore';
import { DEFAULT_CAMERA_EFFECT_SETTINGS } from '../src/renderer/utils/cameraEffects';
import { FakeStream, FakeTrack } from './fakeMedia';

function replaceGlobal(t: TestContext, target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

/** A phone with a front and a rear camera; `facing` is what each opened camera reports. */
function phone(t: TestContext, cameras: number, facingOf: (request: MediaTrackConstraints) => string | undefined) {
  const requests: MediaTrackConstraints[] = [];
  const opened: FakeTrack[] = [];
  replaceGlobal(t, globalThis, 'MediaStream', FakeStream);
  replaceGlobal(t, globalThis.navigator, 'mediaDevices', {
    async getUserMedia(constraints: MediaStreamConstraints) {
      const video = typeof constraints.video === 'object' ? constraints.video : {};
      requests.push(video);
      const track = new FakeTrack(`camera-${requests.length}`, facingOf(video));
      opened.push(track);
      return new FakeStream([track]);
    },
    async enumerateDevices() {
      return Array.from({ length: cameras }, (_, index) => ({ kind: 'videoinput', deviceId: `cam-${index}` }));
    },
  });
  t.mock.method(cameraEffectsStore, 'load', async () => ({ settings: { ...DEFAULT_CAMERA_EFFECT_SETTINGS, mode: 'off' }, image: null }));
  t.after(() => videoService.stopCamera());
  return { requests, opened };
}

const requestedFacing = (request: MediaTrackConstraints): string | undefined => {
  const facing = request.facingMode;
  return facing && typeof facing === 'object' && !Array.isArray(facing) && typeof facing.ideal === 'string' ? facing.ideal : undefined;
};

test('a phone camera swaps to the rear one and back, releasing the camera it leaves', async (t) => {
  const { requests, opened } = phone(t, 2, request => requestedFacing(request) ?? 'user');
  await videoService.startCamera();
  assert.equal(videoService.getCameraState().canSwitchFacing, true);

  await videoService.switchCameraFacing();
  assert.deepEqual(requests[1]?.facingMode, { ideal: 'environment' });
  assert.equal(requests[1]?.deviceId, undefined);
  assert.equal(opened[0]?.readyState, 'ended', 'the front camera stops before the rear one opens');
  assert.equal(videoService.getCameraState().status, 'ready');

  await videoService.switchCameraFacing();
  assert.deepEqual(requests[2]?.facingMode, { ideal: 'user' });
});

test('a camera that does not say where it faces cannot be swapped', async (t) => {
  const { requests } = phone(t, 2, () => undefined);
  await videoService.startCamera();
  assert.equal(videoService.getCameraState().canSwitchFacing, false);
  await videoService.switchCameraFacing();
  assert.equal(requests.length, 1);
});

test('a device with a single camera has nothing to swap to', async (t) => {
  phone(t, 1, () => 'user');
  await videoService.startCamera();
  assert.equal(videoService.getCameraState().canSwitchFacing, false);
});
