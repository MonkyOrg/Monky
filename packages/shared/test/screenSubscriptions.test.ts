import assert from 'node:assert/strict';
import { rtcSignalSchema, sfuConsumeSchema, sfuConsumerClosedSchema,
  sfuConsumerSetPausedSchema, sfuMediaAppDataSchema, sfuCreateWebRtcTransportSchema,
  sfuCloseWebRtcTransportSchema, sfuProducerClosedSchema, sfuProducerSetPausedSchema,
  type SfuCreateWebRtcTransportPayload } from '../src/index.js';

const transport: SfuCreateWebRtcTransportPayload = { channelId: 'room', direction: 'send' };
assert.deepEqual(sfuCreateWebRtcTransportSchema.parse(transport), { ...transport, purpose: 'call' });
assert.deepEqual(sfuCreateWebRtcTransportSchema.parse({ ...transport, purpose: 'screen' }),
  { ...transport, purpose: 'screen' });
const screenSessionId = '9b55f70c-1356-4d3d-94df-99a572bb0408';
assert.equal(sfuCreateWebRtcTransportSchema.safeParse({ ...transport, purpose: 'screen', screenSessionId }).success, true);
assert.equal(sfuCreateWebRtcTransportSchema.safeParse({ ...transport, screenSessionId }).success, false);
assert.equal(sfuCreateWebRtcTransportSchema.safeParse({ ...transport, purpose: 'screen', screenSessionId: 'alias' }).success, false);
for (const payload of [null, { ...transport, purpose: null }, { ...transport, purpose: 'native' },
  { ...transport, purpose: 1 }, { ...transport, direction: 'sideways' },
  { ...transport, channelId: 'x'.repeat(129) }, { ...transport, extra: true }]) {
  assert.equal(sfuCreateWebRtcTransportSchema.safeParse(payload).success, false);
}

const closeTransport = { channelId: 'room', transportId: 'native-send', purpose: 'screen' };
const pauseProducer = { channelId: 'room', producerId: 'native-video', purpose: 'screen', paused: true };
assert.equal(sfuCloseWebRtcTransportSchema.safeParse(closeTransport).success, true);
assert.equal(sfuProducerSetPausedSchema.safeParse(pauseProducer).success, true);
assert.equal(sfuProducerClosedSchema.safeParse({ channelId: 'room', producerId: 'native-video' }).success, true);
for (const payload of [null, { ...closeTransport, purpose: 'call' }, { ...closeTransport, transportId: 1 },
  { ...closeTransport, transportId: 'x'.repeat(129) }, { ...closeTransport, extra: true }]) {
  assert.equal(sfuCloseWebRtcTransportSchema.safeParse(payload).success, false);
}
for (const payload of [null, { ...pauseProducer, purpose: 'call' }, { ...pauseProducer, paused: 'true' },
  { ...pauseProducer, producerId: '' }, { ...pauseProducer, extra: true }]) {
  assert.equal(sfuProducerSetPausedSchema.safeParse(payload).success, false);
}

// The Chromium screen path is gone (#830): a call peer only negotiates its own connection.
const offer = {
  fromSessionId: 'publisher', targetSessionId: 'viewer', signalType: 'offer', subscriptionId: 'peer-epoch',
  sdp: { type: 'offer', sdp: 'v=0' },
};
assert.equal(rtcSignalSchema.safeParse(offer).success, true);
assert.equal(rtcSignalSchema.safeParse({ ...offer, subscriptionId: undefined }).success, false);
for (const signalType of ['screen-watch', 'screen-video-meta', 'screen-audio-meta']) {
  assert.equal(rtcSignalSchema.safeParse({
    fromSessionId: 'publisher', targetSessionId: 'viewer', signalType, streamId: 'stream-one', subscriptionId: 'epoch',
    watcherSubscriptionId: 'viewer-epoch', subscriptionRevision: 1, watching: true,
  }).success, false, signalType);
}
assert.equal(rtcSignalSchema.safeParse({ ...offer, streamId: 'stream-one' }).success, false);
assert.equal(sfuConsumerClosedSchema.safeParse({ channelId: 'room', consumerId: 'consumer' }).success, true);
assert.equal(sfuConsumerSetPausedSchema.safeParse({ channelId: 'room', consumerId: 'consumer', paused: false }).success, true);
assert.equal(sfuConsumerSetPausedSchema.safeParse({ channelId: 'room', consumerId: 'consumer', paused: 'false' }).success, false);
const nativeScreen = {
  sourceInstanceId: 'f1c2d3e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f', pipelineId: screenSessionId,
  video: { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 },
};
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'screen_video', shareId: 'one', nativeScreen }).success, true);
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'screen_audio', shareId: 'one', nativeScreen }).success, true);
for (const mediaType of ['screen_video', 'screen_audio'])
  assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType, shareId: 'one' }).success, false, 'screens are always native');
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'screen_video', shareId: '<script>', nativeScreen }).success, false);
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'camera', shareId: 'one' }).success, false);
const consume = { channelId: 'room', transportId: 'recv', producerId: 'producer', rtpCapabilities: {} };
assert.equal(sfuConsumeSchema.safeParse(consume).success, true);
assert.equal(sfuConsumeSchema.safeParse({ ...consume, rtpCapabilities: { codecs: Array(129).fill({}) } }).success, false);
assert.equal(sfuConsumeSchema.safeParse({ ...consume, producerId: 'x'.repeat(129) }).success, false);
