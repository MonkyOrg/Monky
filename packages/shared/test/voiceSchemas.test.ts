import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adminKickVoiceSchema, rtcDiagnosticsReportSchema, sfuConnectWebRtcTransportSchema, sfuProduceSchema,
  voiceJoinSchema, voiceStateUpdateSchema, type RtcDiagnosticsReportPayload,
} from '../src/index.js';

test('voice payloads drop unknown keys instead of refusing newer clients, and refuse wrong types', () => {
  assert.deepEqual(voiceJoinSchema.parse({ channelId: 'room', isMuted: true, future: 1 }), { channelId: 'room', isMuted: true });
  assert.equal(voiceJoinSchema.safeParse({ channelId: 'room', isMuted: 'yes' }).success, false);
  const update = { isMuted: false, isCameraOn: true, screenShareIds: ['share-1'], nativeScreenShares: [] };
  assert.deepEqual(voiceStateUpdateSchema.parse({ ...update, junk: 'x', connectionHealth: 'failed' }), update);
  for (const invalid of [{ isSpeaking: 1 }, { screenShareIds: 'share-1' }, { screenShareIds: Array(65).fill('a') },
    { screenShareIds: ['x'.repeat(65)] }, null]) {
    assert.equal(voiceStateUpdateSchema.safeParse(invalid).success, false, JSON.stringify(invalid)?.slice(0, 60));
  }
  assert.deepEqual(adminKickVoiceSchema.parse({ targetSessionId: 'user:device', extra: 'x' }), { targetSessionId: 'user:device' });
});

test('an RTC diagnostic report is accepted as the desktop sends it and refused when it could forge a log line', () => {
  const report: RtcDiagnosticsReportPayload = {
    targetSessionId: '2d7f6c1e-08a4-4c1c-9b8e-3f2a1d4e5b6c:device-1',
    reason: 'ice_restart=3, hard_reconnect=2', iceGatheringState: 'complete', signalingState: 'have-local-offer',
    iceRestartAttempts: 3, hardReconnectAttempts: 2,
    localCandidate: { type: 'host', address: '4a1b2c3d-1111-2222-3333-444455556666.local', port: 54321, protocol: 'udp' },
    remoteCandidate: null,
  };
  assert.equal(rtcDiagnosticsReportSchema.safeParse(report).success, true);
  assert.equal(rtcDiagnosticsReportSchema.safeParse({ ...report, localCandidate: { type: 'unknown' } }).success, true);
  for (const invalid of [
    { ...report, reason: 'a\nb' }, { ...report, signalingState: 'x'.repeat(33) }, { ...report, iceRestartAttempts: -1 },
    { ...report, remoteCandidate: { type: 'relay', port: 65536 } }, { ...report, targetSessionId: '' },
  ]) assert.equal(rtcDiagnosticsReportSchema.safeParse(invalid).success, false);
});

test('SFU connect and produce payloads keep what mediasoup reads and bound the rest', () => {
  const dtlsParameters = { role: 'client', fingerprints: [{ algorithm: 'sha-256', value: 'AB:CD' }] };
  assert.deepEqual(sfuConnectWebRtcTransportSchema.parse({ channelId: 'room', transportId: 't', dtlsParameters }),
    { channelId: 'room', transportId: 't', dtlsParameters });
  assert.equal(sfuConnectWebRtcTransportSchema.safeParse({ channelId: 'room', transportId: 't', dtlsParameters: {} }).success, false);
  const rtpParameters = {
    mid: '0', msid: 'stream track',
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 },
      rtcpFeedback: [{ type: 'transport-cc', parameter: '' }] }],
    headerExtensions: [{ uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', id: 1, encrypt: false, parameters: {} }],
    encodings: [{ ssrc: 1, dtx: true, maxFramerate: 30, priority: 'high' }],
    rtcp: { cname: 'c', reducedSize: true, mux: true },
  };
  const produce = { channelId: 'room', transportId: 't', kind: 'audio', rtpParameters, appData: { mediaType: 'mic' } };
  assert.deepEqual(sfuProduceSchema.parse(produce), produce, 'keys mediasoup may read later are kept');
  for (const invalid of [
    { ...rtpParameters, codecs: Array(33).fill(rtpParameters.codecs[0]) },
    { ...rtpParameters, headerExtensions: [{ uri: 'urn:example:unknown', id: 2 }] },
    { ...rtpParameters, encodings: [{ ssrc: -1 }] },
    { mid: '0' },
  ]) assert.equal(sfuProduceSchema.safeParse({ ...produce, rtpParameters: invalid }).success, false);
});
