import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getScreenShareProfile, getScreenShareQualities, nativeScreenP2pControlSchema,
  nativeScreenSignalSchema, nativeScreenSourcesSchema, nativeScreenVideoProfileSchema,
} from '../src/index.js';

const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
const instanceId = '58f8a74e-8207-4825-8f91-f8501f22935e';
const subscriptionId = '18cb9774-bc37-47a8-8eeb-5ee5f9a5ec30';
const envelope = {
  protocol: 'monky-native-screen-p2p', version: 1, callId: instanceId, channelId: 'room',
  connectionId: subscriptionId, generation: 1,
};
const signal = {
  fromSessionId: 'viewer', targetSessionId: 'publisher', publisherSessionId: 'publisher',
  channelId: 'room', shareId: 'screen-one', sourceInstanceId: instanceId, subscriptionId,
};
const publication = {
  ...envelope, type: 'publication', shareId: 'screen-one', publicationId: 1, publicationVersion: 1,
  metadataVersion: 1, trackId: 'track', mid: null, streamIds: ['screen-one'],
};

test('quality changes actual encoder dimensions, cadence and bitrate, never upscales a source', () => {
  assert.deepEqual(getScreenShareProfile(video, 'source'), video);
  assert.deepEqual(getScreenShareQualities(video).map(value => value.profile), [
    video,
    { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 },
    { width: 1280, height: 720, fps: 60, maxBitrateKbps: 6000 },
    { width: 852, height: 480, fps: 30, maxBitrateKbps: 1500 },
  ]);
  const small = { width: 640, height: 360, fps: 15, maxBitrateKbps: 500 };
  assert.deepEqual(getScreenShareQualities(small), [{ quality: 'source', profile: small }]);
  assert.ok(Object.isFrozen(getScreenShareProfile(video, '720p60')));
  assert.throws(() => getScreenShareProfile({ ...video, width: 854 }, 'source'));
  assert.equal(nativeScreenVideoProfileSchema.safeParse({ ...video, fps: 121 }).success, false);
  assert.equal(nativeScreenVideoProfileSchema.safeParse({ ...video, maxBitrateKbps: 149 }).success, false);
});

test('source descriptors are bounded and cannot alias two source instances', () => {
  const source = { shareId: 'screen-one', instanceId, video, audio: false };
  assert.deepEqual(nativeScreenSourcesSchema.parse([source]), [source]);
  for (const sources of [
    [source, source], [source, { ...source, shareId: 'other' }],
    [{ ...source, windowHandle: 1 }], [{ ...source, audio: 'true' }],
    [{ ...source, instanceId: 'old-call' }],
  ]) assert.equal(nativeScreenSourcesSchema.safeParse(sources).success, false);
});

test('native P2P validates both video-only and explicit A/V control, including UTF-8 limits', () => {
  assert.equal(nativeScreenP2pControlSchema.safeParse(publication).success, true);
  assert.equal(nativeScreenP2pControlSchema.safeParse({
    ...publication, version: 2, kind: 'audio', syncGroup: instanceId,
  }).success, true);
  for (const value of [
    { ...publication, kind: 'audio' }, { ...publication, version: 2 },
    { ...publication, publicationId: 1.5 }, { ...publication, streamIds: Array(9).fill('stream') },
    { ...publication, trackId: '\0' }, { ...publication, trackId: '\u00e9'.repeat(129) },
    { ...envelope, type: 'offer', turn: 1, sdp: '' },
    { ...envelope, type: 'ice', turn: 1, candidate: '', sdpMid: null, sdpMLineIndex: null },
  ]) assert.equal(nativeScreenP2pControlSchema.safeParse(value).success, false);
  assert.equal(nativeScreenP2pControlSchema.safeParse({
    ...envelope, type: 'ice', turn: 1, candidate: '', sdpMid: '0', sdpMLineIndex: null,
  }).success, true);
});

test('audio Watch requires the current video subscription rather than a bare audio publication', () => {
  const watch = {
    ...envelope, version: 2, type: 'watch', kind: 'audio', shareId: 'screen-one',
    publicationId: 1, publicationVersion: 1, metadataVersion: 1, subscriptionId: 1, revision: 1, watching: true,
  };
  assert.equal(nativeScreenP2pControlSchema.safeParse(watch).success, false);
  assert.equal(nativeScreenP2pControlSchema.safeParse({
    ...watch, video: { publicationId: 2, publicationVersion: 1, metadataVersion: 1, subscriptionId: 2, revision: 1 },
  }).success, true);
});

test('carrier actions are scoped to the publisher, source instance and subscription', () => {
  const watch = { ...signal, action: 'watch', quality: 'source', backend: 'native' };
  assert.equal(nativeScreenSignalSchema.safeParse(watch).success, true);
  assert.equal(nativeScreenSignalSchema.safeParse({ ...signal, action: 'stop' }).success, true);
  const control = { ...signal, action: 'control', control: publication };
  assert.equal(nativeScreenSignalSchema.safeParse(control).success, true);
  for (const value of [
    { ...watch, publisherSessionId: 'viewer' }, { ...watch, fromSessionId: 'publisher' },
    { ...watch, quality: 'automatic' }, { ...watch, backend: 'fallback' },
    { ...signal, action: 'closed', reason: 'source-unavailable' },
    { ...control, control: { ...publication, callId: 'previous-source' } },
    { ...control, control: { ...publication, connectionId: 'previous-watch' } },
    { ...control, control: { ...publication, shareId: 'different-source' } },
    { ...control, control: { ...publication, channelId: 'different-room' } },
  ]) assert.equal(nativeScreenSignalSchema.safeParse(value).success, false);
  assert.equal(nativeScreenSignalSchema.safeParse({
    ...signal, fromSessionId: 'publisher', targetSessionId: 'viewer',
    action: 'accepted', backend: 'native', quality: 'source', generation: 1,
  }).success, true);
});

test('capture status is publisher-owned, bounded and explicitly distinguishes preparation from frames', () => {
  const status = { ...signal, fromSessionId: 'publisher', targetSessionId: 'viewer',
    action: 'capture-mode', generation: 1, capture: { mode: 'normal', ready: true } };
  assert.equal(nativeScreenSignalSchema.safeParse(status).success, true);
  assert.equal(nativeScreenSignalSchema.safeParse({ ...status, capture: { mode: 'game', ready: false } }).success, true);
  for (const value of [
    { ...status, fromSessionId: 'viewer', targetSessionId: 'publisher' },
    { ...status, generation: 0 }, { ...status, generation: 1.5 },
    { ...status, capture: { mode: 'wgc', ready: true } },
    { ...status, capture: { mode: 'normal' } },
    { ...status, capture: { mode: 'normal', ready: 'true' } },
    { ...status, capture: { mode: 'normal', ready: true, hwnd: 123 } },
  ]) assert.equal(nativeScreenSignalSchema.safeParse(value).success, false);
});
