import assert from 'node:assert/strict';
import './screenPrivacy.test.js';
import { rtcSignalSchema, screenWatchSignalSchema, sfuConsumeSchema, sfuConsumerClosedSchema,
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

const watch = {
  fromSessionId: 'viewer', targetSessionId: 'publisher', signalType: 'screen-watch',
  streamId: 'stream-one', subscriptionId: 'peer-epoch', subscriptionRevision: 1, watching: true,
  watcherSubscriptionId: 'viewer-epoch',
};
assert.equal(screenWatchSignalSchema.safeParse(watch).success, true);
for (const payload of [null, { ...watch, watching: 1 }, { ...watch, subscriptionId: '' },
  { ...watch, streamId: 'x'.repeat(65) }, { ...watch, subscriptionRevision: Infinity },
  { ...watch, subscriptionRevision: 0 }, { ...watch, subscriptionRevision: 1.5 },
  { ...watch, targetSessionId: 'x'.repeat(129) }, { ...watch, extra: true }]) {
  assert.equal(screenWatchSignalSchema.safeParse(payload).success, false);
}
assert.equal(rtcSignalSchema.safeParse({ ...watch, watching: false }).success, true);
assert.equal(rtcSignalSchema.safeParse({
  fromSessionId: 'publisher', targetSessionId: 'viewer', signalType: 'screen-video-meta',
  streamId: 'stream-one', subscriptionId: 'epoch',
}).success, true);
assert.equal(rtcSignalSchema.safeParse({
  fromSessionId: 'publisher', targetSessionId: 'viewer', signalType: 'screen-video-meta', streamId: 'stream-one',
}).success, false);
assert.equal(sfuConsumerClosedSchema.safeParse({ channelId: 'room', consumerId: 'consumer' }).success, true);
assert.equal(sfuConsumerSetPausedSchema.safeParse({ channelId: 'room', consumerId: 'consumer', paused: false }).success, true);
assert.equal(sfuConsumerSetPausedSchema.safeParse({ channelId: 'room', consumerId: 'consumer', paused: 'false' }).success, false);
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'screen_video', shareId: 'one' }).success, true);
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'screen_audio', shareId: 'default' }).success, true);
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'screen_video', shareId: '<script>' }).success, false);
assert.equal(sfuMediaAppDataSchema.safeParse({ mediaType: 'camera', shareId: 'one' }).success, false);
const consume = { channelId: 'room', transportId: 'recv', producerId: 'producer', rtpCapabilities: {} };
assert.equal(sfuConsumeSchema.safeParse(consume).success, true);
assert.equal(sfuConsumeSchema.safeParse({ ...consume, rtpCapabilities: { codecs: Array(129).fill({}) } }).success, false);
assert.equal(sfuConsumeSchema.safeParse({ ...consume, producerId: 'x'.repeat(129) }).success, false);
