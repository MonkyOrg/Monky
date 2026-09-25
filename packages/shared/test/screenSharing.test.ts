import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getScreenShareProfile, getScreenShareQualities, getScreenH264ProfileLevelId, nativeScreenP2pControlSchema,
  nativeScreenSignalSchema, nativeScreenSourcesSchema, nativeScreenVideoProfileSchema,
  nativeScreenCommandSchema, nativeScreenPreviewPacketSchema,
  getScreenAv1MinimumLevelIndex,
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

test('4K120 and 80 Mbps are explicit ceilings with honest per-rendition H264 levels', () => {
  const maximum = { width: 3840, height: 2160, fps: 120, maxBitrateKbps: 80000 };
  assert.deepEqual(nativeScreenVideoProfileSchema.parse(maximum), maximum);
  assert.equal(getScreenH264ProfileLevelId(video), '4d0033');
  assert.equal(getScreenH264ProfileLevelId({ ...maximum, fps: 30 }), '4d0033');
  assert.equal(getScreenH264ProfileLevelId({ ...maximum, fps: 60 }), '4d0034');
  assert.equal(getScreenH264ProfileLevelId(maximum), '4d003c');
  assert.equal(getScreenH264ProfileLevelId(getScreenShareProfile(maximum, '1080p60')), '4d0033');
  assert.deepEqual(getScreenShareProfile(maximum, 'source'), maximum);
  for (const invalid of [{ width: 3844 }, { height: 2162 }, { fps: 121 }, { maxBitrateKbps: 80050 }])
    assert.equal(nativeScreenVideoProfileSchema.safeParse({ ...maximum, ...invalid }).success, false);
});

test('AV1 Main-tier level bounds account for dimensions, display rate and bitrate independently of H264', () => {
  const cases = [
    [852, 480, 30, 1500, 4],
    [1280, 720, 30, 6000, 5],
    [1280, 720, 60, 6000, 8],
    [1920, 1080, 30, 12000, 8],
    [1920, 1080, 60, 20000, 9],
    [1920, 1080, 120, 20000, 12],
    [3840, 2160, 30, 30000, 12],
    [3840, 2160, 60, 40000, 13],
    [3840, 2160, 120, 60000, 14],
    [3840, 2160, 120, 80000, 17],
    [852, 480, 30, 20000, 9],
  ];
  for (const [width, height, fps, maxBitrateKbps, level] of cases)
    assert.equal(getScreenAv1MinimumLevelIndex({ width, height, fps, maxBitrateKbps }), level);
});

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
  for (const codec of ['h264', 'av1']) {
    assert.equal(nativeScreenSourcesSchema.parse([{ ...source, codec }])[0].codec, codec);
  }
  assert.equal(nativeScreenSourcesSchema.safeParse([{ ...source, codec: 'vp9' }]).success, false);
  for (const sources of [
    [source, source], [source, { ...source, shareId: 'other' }],
    [{ ...source, windowHandle: 1 }], [{ ...source, audio: 'true' }],
    [{ ...source, instanceId: 'old-call' }],
  ]) assert.equal(nativeScreenSourcesSchema.safeParse(sources).success, false);
});

test('AV1 widths align before encoding and announcements while H264 retains four-pixel alignment', () => {
  const narrow = { width: 852, height: 480, fps: 30, maxBitrateKbps: 1500 };
  assert.deepEqual(getScreenShareProfile(narrow, 'source'), narrow);
  assert.deepEqual(getScreenShareProfile(narrow, 'source', 'h264'), narrow);
  assert.deepEqual(getScreenShareProfile(narrow, 'source', 'av1'), { ...narrow, width: 848 });
  assert.deepEqual(getScreenShareProfile(video, '480p30', 'av1'), { ...narrow, width: 848 });
  assert.deepEqual(getScreenShareQualities(video, 'av1').map(({ profile }) => profile.width), [1920, 1920, 1280, 848]);
  assert.deepEqual(getScreenShareQualities(narrow, 'av1'), [{ quality: 'source', profile: { ...narrow, width: 848 } }]);
  for (const width of [4, 8, 12, 16, 20, 852, 856, 1916, 1920, 3840]) {
    const profile = getScreenShareProfile({ ...video, width }, 'source', 'av1');
    assert.equal(profile.width, Math.max(8, Math.floor(width / 8) * 8));
    assert.deepEqual(getScreenShareProfile(profile, 'source', 'av1'), profile);
    assert.ok(Object.isFrozen(profile));
  }
});

test('encoder IPC accepts bounded explicit choices, never arbitrary encoder IDs or capture during a probe', () => {
  const probe = { action: 'probe-encoding', probeId: instanceId, video, encodingMode: 'hardware', codec: 'auto' };
  for (const encodingMode of ['hardware', 'software'])
    for (const codec of ['auto', 'h264', 'av1'])
      assert.equal(nativeScreenCommandSchema.safeParse({ ...probe, encodingMode, codec }).success, true);
  for (const change of [{ encodingMode: 'browser' }, { codec: 'vp9' }, { encoder: 'custom-path' },
    { desktopSourceId: 'window:123:0' }, { video: { ...video, width: 999999 } }, { probeId: 'anything' }])
    assert.equal(nativeScreenCommandSchema.safeParse({ ...probe, ...change }).success, false);
  const source = { action: 'source-add', callId: instanceId, shareId: 'screen', desktopSourceId: 'window:123:0',
    video, audio: false, audioBitrateKbps: 128, encodingMode: 'software', codec: 'av1' };
  assert.equal(nativeScreenCommandSchema.safeParse(source).success, true);
  for (const preserveAspectRatio of [undefined, true, false]) {
    const command = nativeScreenCommandSchema.parse({ ...source, preserveAspectRatio });
    assert.equal(command.action, 'source-add');
    if (command.action === 'source-add') assert.equal(command.preserveAspectRatio, preserveAspectRatio ?? true);
  }
  for (const preserveAspectRatio of [null, 0, 'false', {}])
    assert.equal(nativeScreenCommandSchema.safeParse({ ...source, preserveAspectRatio }).success, false);
  assert.equal(nativeScreenCommandSchema.safeParse({ ...source, encoder: 'obs_x264' }).success, false);
  assert.equal(nativeScreenCommandSchema.safeParse({ action: 'cancel-encoding-probe', probeId: instanceId }).success, true);
  for (const encodingMode of ['hardware', 'software'])
    for (const codec of ['h264', 'av1']) {
      assert.equal(nativeScreenCommandSchema.safeParse({ ...probe, encodingStrategy: 'manual', encodingMode, codec }).success, true);
      assert.equal(nativeScreenCommandSchema.safeParse({ ...source, encodingStrategy: 'manual', encodingMode, codec }).success, true);
    }
  for (const command of [probe, source]) {
    assert.equal(nativeScreenCommandSchema.safeParse({ ...command, encodingStrategy: 'manual', codec: 'auto' }).success, false);
    assert.equal(nativeScreenCommandSchema.safeParse({ ...command, encodingStrategy: 'manual', codec: undefined }).success, false);
    assert.equal(nativeScreenCommandSchema.safeParse({ ...command, encodingStrategy: 'manual', encodingMode: undefined }).success, false);
    assert.equal(nativeScreenCommandSchema.safeParse({ ...command, encodingStrategy: 'invalid' }).success, false);
  }
});

test('preview packet codec remains independent of geometry and missing codec retains legacy H264 metadata', () => {
  const packet = { type: 'packet', sequence: 1, pipelineId: instanceId, video,
    timestampUs: 1, keyframe: true, data: new Uint8Array([1]) };
  assert.equal(nativeScreenPreviewPacketSchema.parse(packet).codec, undefined);
  assert.equal(nativeScreenPreviewPacketSchema.parse({ ...packet, codec: 'av1' }).codec, 'av1');
  assert.equal(nativeScreenPreviewPacketSchema.safeParse({ ...packet, codec: 'vp8' }).success, false);
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
