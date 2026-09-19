import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_SCREEN_AUDIO_IPC,
  isNativeScreenAudioOutputConfig,
  isNativeScreenAudioPortInfo,
  isNativeScreenAudioPortMessage,
  isNativeScreenAudioPortScope,
} from '../src/nativeAudioIpc.js';

const scope = { portId: 'private-output-port', epoch: 1 };
const config = { epoch: 1, sinkId: 'selected-chromium-id', sampleRate: 48000, channels: 2 };
const info = { version: 1, sessionId: 'rtc-call-session', portId: scope.portId, output: config };
const request = (method: string, data: unknown) => ({ ...scope, type: 'request', id: 1, method, data });
const response = (method: string, data: unknown) => ({ ...scope, type: 'response', id: 1, method, ok: true, data });
const event = (name: string, data: unknown) => ({ ...scope, type: 'event', event: name, data });
const error = { code: 'ERR_AUDIO_EXAMPLE', message: 'An explicit audio failure.' };
const packet = () => ({
  epoch: 1, sequence: 0, firstPlayoutFrame: 0, frames: 480,
  sampleRate: 48000, channels: 2, samples: new Float32Array(960),
});
const feedback = () => ({
  epoch: 1, available: true, clockEpoch: 1, calibrationId: 2, atPerformanceTimeUs: 45000,
  estimatedPlayoutFrame: -128.5, confirmedPcmEnd: 0, feedbackAgeUs: 500, outputClockAgeUs: 1200,
});

test('native audio IPC has one typed private transfer channel and an exact output descriptor', () => {
  assert.equal(NATIVE_SCREEN_AUDIO_IPC.outputPort, 'native-screen:audio-output-port');
  assert.equal(isNativeScreenAudioPortScope(scope), true);
  assert.equal(isNativeScreenAudioPortInfo(structuredClone(info)), true);
  assert.equal(isNativeScreenAudioOutputConfig({ ...config, sinkId: '' }), true);
  for (const value of [null, [], {}, { ...info, version: 2 }, { ...info, sessionId: '' },
    { ...info, portId: '\0' }, { ...info, ports: [] }, { ...info, output: { ...config, epoch: 0 } }]) {
    assert.equal(isNativeScreenAudioPortInfo(value), false);
  }
});

test('native output preserves the selected Chromium device and rejects implicit format conversion', () => {
  for (const value of [
    { ...config, sampleRate: 44100 }, { ...config, channels: 1 }, { ...config, epoch: 1.5 },
    { ...config, epoch: Number.MAX_SAFE_INTEGER + 1 }, { ...config, sinkId: 'a'.repeat(513) },
    { ...config, sinkId: 'device\0other' }, { ...config, fallback: 'default' },
  ]) assert.equal(isNativeScreenAudioOutputConfig(value), false);
  assert.equal(isNativeScreenAudioOutputConfig(config), true);
});

test('audio port envelopes reject foreign identities, epochs and unrecognized fields', () => {
  const message = request('configure', config);
  assert.equal(isNativeScreenAudioPortMessage(message, scope, 'renderer'), true);
  for (const value of [null, [], { ...message, portId: 'other' }, { ...message, epoch: 2 },
    { ...message, id: 0 }, { ...message, id: '1' }, { ...message, nativeHandle: 12 },
    { ...message, data: { ...config, epoch: 2 } }]) {
    assert.equal(isNativeScreenAudioPortMessage(value, scope, 'renderer'), false);
  }
});

test('only Renderer configures native output, while only Main requests Renderer retirement', () => {
  assert.equal(isNativeScreenAudioPortMessage(request('configure', config), scope, 'main'), false);
  assert.equal(isNativeScreenAudioPortMessage(request('stop', { epoch: 1 }), scope, 'main'), true);
  assert.equal(isNativeScreenAudioPortMessage(request('stop', { epoch: 1 }), scope, 'renderer'), false);
  assert.equal(isNativeScreenAudioPortMessage(request('engine.close', {}), scope, 'renderer'), false);
  assert.equal(isNativeScreenAudioPortMessage(response('configure', { epoch: 1, sampleRate: 48000, channels: 2 }), scope, 'main'), true);
  assert.equal(isNativeScreenAudioPortMessage(response('configure', config), scope, 'main'), false);
});

test('clock probes carry native observations but calibration requests carry only the real Renderer bracket', () => {
  assert.equal(isNativeScreenAudioPortMessage(request('probe', { epoch: 1, probeId: 3 }), scope, 'renderer'), true);
  assert.equal(isNativeScreenAudioPortMessage(response('probe', {
    epoch: 1, probeId: 3, rtcBeforeUs: 54000, rtcAfterUs: 54010,
  }), scope, 'main'), true);
  const bracket = { epoch: 1, probeId: 3, rendererBeforeUs: 1000, rendererAfterUs: 1100 };
  assert.equal(isNativeScreenAudioPortMessage(request('calibrate', bracket), scope, 'renderer'), true);
  for (const data of [{ ...bracket, rtcBeforeUs: 54000 }, { ...bracket, rendererBeforeUs: -1 },
    { ...bracket, rendererAfterUs: 999 }, { ...bracket, rendererAfterUs: 9001 }, { ...bracket, probeId: 0 }]) {
    assert.equal(isNativeScreenAudioPortMessage(request('calibrate', data), scope, 'renderer'), false);
  }
});

test('calibration bounds reject fabricated, reversed and excessively uncertain native clocks', () => {
  const calibration = { epoch: 1, calibrationId: 4, offsetUs: -0.5, uncertaintyUs: 20 };
  assert.equal(isNativeScreenAudioPortMessage(response('calibrate', calibration), scope, 'main'), true);
  for (const data of [{ ...calibration, calibrationId: 0 }, { ...calibration, offsetUs: NaN },
    { ...calibration, uncertaintyUs: 20001 }, { ...calibration, uncertaintyUs: -1 }]) {
    assert.equal(isNativeScreenAudioPortMessage(response('calibrate', data), scope, 'main'), false);
  }
  for (const data of [
    { epoch: 1, probeId: 3, rtcBeforeUs: 100, rtcAfterUs: 99 },
    { epoch: 1, probeId: 3, rtcBeforeUs: 100, rtcAfterUs: 20101 },
  ]) assert.equal(isNativeScreenAudioPortMessage(response('probe', data), scope, 'main'), false);
});

test('unavailable feedback never acquires synthetic zero delay or calibration fields', () => {
  assert.equal(isNativeScreenAudioPortMessage(event('feedback', { epoch: 1, available: false }), scope, 'renderer'), true);
  assert.equal(isNativeScreenAudioPortMessage(event('feedback', {
    epoch: 1, available: false, estimatedPlayoutFrame: 0,
  }), scope, 'renderer'), false);
  assert.equal(isNativeScreenAudioPortMessage(event('feedback', feedback()), scope, 'main'), false);
});

test('physical feedback preserves a legitimate negative initial position and bounds confirmed PCM', () => {
  assert.equal(isNativeScreenAudioPortMessage(event('feedback', feedback()), scope, 'renderer'), true);
  for (const data of [
    { ...feedback(), estimatedPlayoutFrame: 1 }, { ...feedback(), estimatedPlayoutFrame: Infinity },
    { ...feedback(), confirmedPcmEnd: -1 }, { ...feedback(), calibrationId: 0 },
    { ...feedback(), feedbackAgeUs: 200001 }, { ...feedback(), outputClockAgeUs: -1 },
    { ...feedback(), atPerformanceTimeUs: 1.5 }, { ...feedback(), clockEpoch: 0 },
  ]) assert.equal(isNativeScreenAudioPortMessage(event('feedback', data), scope, 'renderer'), false);
});

test('only Renderer grants packet-sized credits and announces its actual output readiness', () => {
  for (const frames of [480, 960]) assert.equal(isNativeScreenAudioPortMessage(
    event('credits', { epoch: 1, grantSequence: 1, frames }), scope, 'renderer'), true);
  for (const frames of [0, 128, 481, 1440, 1920]) assert.equal(isNativeScreenAudioPortMessage(
    event('credits', { epoch: 1, grantSequence: 1, frames }), scope, 'renderer'), false);
  assert.equal(isNativeScreenAudioPortMessage(event('credits', {
    epoch: 1, grantSequence: 0, frames: 480,
  }), scope, 'renderer'), false);
  assert.equal(isNativeScreenAudioPortMessage(event('ready', config), scope, 'renderer'), true);
  assert.equal(isNativeScreenAudioPortMessage(event('ready', config), scope, 'main'), false);
});

test('only Main sends exact copied stereo PCM packets without pooled or shared backing memory', () => {
  assert.equal(isNativeScreenAudioPortMessage(event('pcm', structuredClone(packet())), scope, 'main'), true);
  assert.equal(isNativeScreenAudioPortMessage(event('pcm', packet()), scope, 'renderer'), false);
  for (const samples of [
    new Float64Array(960), new Float32Array(959), new Float32Array(new SharedArrayBuffer(3840)),
    new Float32Array(961).subarray(0, 960), new Float32Array(961).subarray(1),
    new Float32Array(960).fill(NaN),
  ]) assert.equal(isNativeScreenAudioPortMessage(event('pcm', { ...packet(), samples }), scope, 'main'), false);
});

test('PCM packet positions cannot be fractional, wrap around or silently change format', () => {
  for (const data of [
    { ...packet(), sequence: -1 }, { ...packet(), sequence: Number.MAX_SAFE_INTEGER },
    { ...packet(), firstPlayoutFrame: 0.5 }, { ...packet(), firstPlayoutFrame: Number.MAX_SAFE_INTEGER },
    { ...packet(), frames: 960 }, { ...packet(), sampleRate: 44100 }, { ...packet(), channels: 1 },
  ]) assert.equal(isNativeScreenAudioPortMessage(event('pcm', data), scope, 'main'), false);
});

test('error replies cannot coerce method objects or smuggle operations across the port', () => {
  const failure = { ...scope, type: 'response', id: 1, method: 'probe', ok: false, error };
  assert.equal(isNativeScreenAudioPortMessage(failure, scope, 'main'), true);
  assert.equal(isNativeScreenAudioPortMessage(failure, scope, 'renderer'), false);
  for (const method of [new String('probe'), { toString: () => 'probe' }, 'engine.close', null]) {
    assert.equal(isNativeScreenAudioPortMessage({ ...failure, method }, scope, 'main'), false);
  }
  for (const data of [{ ...error, nativeObject: {} }, { ...error, message: '' }, { ...error, code: null }]) {
    assert.equal(isNativeScreenAudioPortMessage({ ...failure, error: data }, scope, 'main'), false);
  }
});

test('retirement responses require explicit closure of the same Renderer epoch', () => {
  assert.equal(isNativeScreenAudioPortMessage(response('stop', { epoch: 1, stopped: true }), scope, 'renderer'), true);
  for (const data of [{}, { epoch: 2, stopped: true }, { epoch: 1, stopped: false }, { epoch: 1, closed: true }]) {
    assert.equal(isNativeScreenAudioPortMessage(response('stop', data), scope, 'renderer'), false);
  }
  assert.equal(isNativeScreenAudioPortMessage(response('stop', { epoch: 1, stopped: true }), scope, 'main'), false);
  assert.equal(isNativeScreenAudioPortMessage(event('error', error), scope, 'main'), true);
  assert.equal(isNativeScreenAudioPortMessage(event('error', error), scope, 'renderer'), true);
});

test('local disposal receipts require the same closed Renderer epoch and cannot be sent by Main', () => {
  assert.equal(isNativeScreenAudioPortMessage(event('disposed', { epoch: 1, stopped: true }), scope, 'renderer'), true);
  assert.equal(isNativeScreenAudioPortMessage(event('disposed', { epoch: 1, stopped: true }), scope, 'main'), false);
  for (const data of [{}, { epoch: 2, stopped: true }, { epoch: 1, stopped: false },
    { epoch: 1, stopped: true, portClosed: true }]) {
    assert.equal(isNativeScreenAudioPortMessage(event('disposed', data), scope, 'renderer'), false);
  }
});
