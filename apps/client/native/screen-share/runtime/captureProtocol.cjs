'use strict';

const assert = require('node:assert/strict');
const MAX_LINE_BYTES = 16384;
const MAX_PACKET_BYTES = 4194304;
const RETIREMENT_FIELDS = Object.freeze(['outputStopped', 'callbacksQuiesced', 'sourceReleased', 'encoderReleased', 'obsShutdownReturned']);
const CONFIGURATION = Object.freeze({
  obsVersion: '32.1.1', fpsDenominator: 1, method: 'wgc', scaleMode: 'stretch',
  rateControl: 'VBR_LAT', codec: 'h264', encoderId: 'h264_texture_amf', profile: 'main',
  bFrames: 0, keyframeIntervalSeconds: 1,
});
const commonKeys = ['schemaVersion', 'type', 'runId', 'sequence', 'helperProcessId', 'hwnd', 'processId',
  'processCreationTime100ns', 'qpc', 'qpcFrequency', 'configuration', 'observation', 'sourceKey', 'hookedKey'];
const observationKeys = ['state', 'sourceAttached', 'sourceWidth', 'sourceHeight', 'outputPackets',
  'outputBytes', 'keyframes', 'bufferedBytes', 'firstPts', 'lastPts', 'lastDts', 'timebaseNumerator',
  'timebaseDenominator', 'firstPacketQpc', 'obsTotalFrames', 'obsLaggedFrames', 'sourceFrames',
  'sourceFrameTimestamp', 'sourceContinuity'];

function exact(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}.`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `Unexpected ${label} fields.`);
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum && value <= maximum, 'Integer outside the capture contract.');
}

function validateSource(source) {
  exact(source, ['hwnd', 'expectedProcessId'], 'selected capture source');
  integer(source.hwnd, 1);
  integer(source.expectedProcessId, 1, 0xffffffff);
  return source;
}

function validateVideo(video) {
  exact(video, ['width', 'height', 'fps', 'bitrateKbps'], 'capture video configuration');
  integer(video.width, 4, 1920); integer(video.height, 2, 1080); integer(video.fps, 1, 120);
  integer(video.bitrateKbps, 50, 20000);
  assert.ok(video.width % 4 === 0 && video.height % 2 === 0 && video.bitrateKbps % 50 === 0);
  return video;
}

function configuration(video) {
  validateVideo(video);
  return { ...CONFIGURATION, width: video.width, height: video.height,
    fpsNumerator: video.fps, initialBitrateKbps: video.bitrateKbps };
}

function command(sequence, verb) {
  integer(sequence, 1);
  assert.ok(['start', 'stats', 'stop'].includes(verb), 'Unknown capture command.');
  return `${sequence} ${verb}\n`;
}

function decimal(value, signed = false) {
  assert.equal(typeof value, 'string');
  assert.ok(value.length <= 21 && (signed ? /^(?:0|-?[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value),
    'An exact decimal clock is required.');
  const parsed = BigInt(value);
  assert.ok(parsed <= (signed ? 9223372036854775807n : 18446744073709551615n)
    && parsed >= (signed ? -9223372036854775808n : 0n), 'Clock exceeds the native integer domain.');
  return parsed;
}

function windowKey(value) {
  exact(value, ['title', 'className', 'executable'], 'OBS window key');
  for (const name of ['title', 'className', 'executable']) {
    assert.equal(typeof value[name], 'string');
    assert.ok(value[name].length > 0 && Buffer.byteLength(value[name]) <= 4096 && !value[name].includes('\0'));
  }
}

function validateFailure(value) {
  exact(value, ['code', 'message'], 'capture error');
  assert.match(value.code, /^ERR_[A-Z0-9_]+$/);
  assert.ok(typeof value.message === 'string' && value.message.length > 0 && Buffer.byteLength(value.message) <= 4096);
  return value;
}

function validateMessage(message, expected) {
  assert.ok(['prepared', 'ready', 'stats', 'stopped', 'error'].includes(message?.type), 'Unknown capture message.');
  const extra = message.type === 'stopped' ? ['retirement'] : message.type === 'error' ? ['error', 'retirement'] : [];
  exact(message, [...commonKeys, ...extra], 'capture message');
  assert.equal(message.schemaVersion, 1);
  assert.match(message.runId, /^[a-f0-9]{32}$/);
  integer(message.sequence);
  integer(message.helperProcessId, 1, 0xffffffff);
  integer(message.hwnd, 1);
  integer(message.processId, 1, 0xffffffff);
  assert.ok(decimal(message.processCreationTime100ns) > 0n);
  const qpc = decimal(message.qpc);
  assert.ok(qpc > 0n && decimal(message.qpcFrequency) > 0n);
  if (expected) {
    validateSource(expected.source);
    assert.equal(message.runId, expected.runId);
    assert.equal(message.helperProcessId, expected.helperProcessId);
    assert.equal(message.hwnd, expected.source.hwnd);
    assert.equal(message.processId, expected.source.expectedProcessId);
    assert.deepEqual(message.configuration, configuration(expected.video));
  }
  const selected = message.configuration;
  assert.deepEqual(selected, configuration({
    width: selected?.width, height: selected?.height, fps: selected?.fpsNumerator, bitrateKbps: selected?.initialBitrateKbps,
  }));
  windowKey(message.sourceKey);
  if (message.hookedKey !== null) windowKey(message.hookedKey);
  const observation = message.observation;
  exact(observation, observationKeys, 'capture observation');
  assert.equal(observation.state, { prepared: 'prepared', ready: 'running', stats: 'running',
    stopped: 'stopped', error: 'failed' }[message.type]);
  assert.equal(typeof observation.sourceAttached, 'boolean');
  for (const name of ['sourceWidth', 'sourceHeight'])
    if (observation[name] !== null) integer(observation[name], 1, 32768);
  assert.equal(observation.sourceWidth === null, observation.sourceHeight === null);
  for (const name of ['sourceFrames', 'sourceFrameTimestamp', 'sourceContinuity'])
    assert.equal(observation[name], null, 'Stock output ticks are not distinct captured frames.');
  integer(observation.outputPackets);
  integer(observation.outputBytes);
  integer(observation.keyframes, 0, observation.outputPackets);
  assert.equal(observation.bufferedBytes, 0, 'Captured video must not be retained for recording.');
  integer(observation.obsTotalFrames, 0, 0xffffffff);
  integer(observation.obsLaggedFrames, 0, observation.obsTotalFrames);
  const packetFields = ['firstPts', 'lastPts', 'lastDts', 'timebaseNumerator', 'timebaseDenominator', 'firstPacketQpc'];
  if (observation.outputPackets === 0) {
    for (const name of packetFields) assert.equal(observation[name], null);
    assert.equal(observation.outputBytes, 0);
    assert.equal(observation.keyframes, 0);
  } else {
    integer(observation.outputBytes, 1);
    assert.ok(decimal(observation.lastPts, true) >= decimal(observation.firstPts, true));
    decimal(observation.lastDts, true);
    assert.equal(observation.timebaseNumerator, 1);
    assert.equal(observation.timebaseDenominator, selected.fpsNumerator);
    assert.ok(decimal(observation.firstPacketQpc) <= qpc);
  }
  if (message.type === 'prepared') {
    assert.equal(message.sequence, 0);
    assert.equal(observation.outputPackets, 0);
    assert.equal(observation.sourceAttached, false);
    assert.equal(message.hookedKey, null);
  } else if (message.type === 'ready' || message.type === 'stats') {
    integer(message.sequence, 1);
    assert.equal(observation.sourceAttached, true);
    assert.deepEqual(message.hookedKey, message.sourceKey, 'The backend attached to another OBS window key.');
    integer(observation.sourceWidth, 1, 32768);
    integer(observation.outputPackets, 1);
    integer(observation.keyframes, 1, observation.outputPackets);
  } else if (message.type === 'stopped') {
    integer(message.sequence, 1);
    assert.equal(observation.sourceAttached, false);
    assert.deepEqual(message.retirement, {
      outputStopped: true, callbacksQuiesced: true, sourceReleased: true,
      encoderReleased: true, obsShutdownReturned: true,
    });
  } else {
    validateFailure(message.error);
    exact(message.retirement, RETIREMENT_FIELDS, 'capture failure retirement');
    for (const field of RETIREMENT_FIELDS) assert.equal(typeof message.retirement[field], 'boolean');
    if (message.retirement.sourceReleased) assert.equal(observation.sourceAttached, false);
  }
  return message;
}

function validateProgress(previous, next) {
  for (const name of ['runId', 'helperProcessId', 'hwnd', 'processId', 'processCreationTime100ns', 'qpcFrequency'])
    assert.equal(next[name], previous[name], `Native identity changed: ${name}`);
  assert.deepEqual(next.configuration, previous.configuration);
  assert.deepEqual(next.sourceKey, previous.sourceKey);
  assert.ok(decimal(next.qpc) >= decimal(previous.qpc), 'Native QPC regressed.');
  const before = previous.observation, after = next.observation;
  for (const name of ['outputPackets', 'outputBytes', 'keyframes', 'obsTotalFrames', 'obsLaggedFrames'])
    assert.ok(after[name] >= before[name], `Native counter regressed: ${name}`);
  if (before.firstPacketQpc !== null) {
    for (const name of ['firstPts', 'firstPacketQpc', 'timebaseNumerator', 'timebaseDenominator'])
      assert.equal(after[name], before[name], `Packet timeline changed: ${name}`);
    assert.ok(decimal(after.lastPts, true) >= decimal(before.lastPts, true));
    assert.ok(decimal(after.lastDts, true) >= decimal(before.lastDts, true));
  } else if (after.firstPacketQpc !== null) {
    assert.ok(decimal(after.firstPacketQpc) >= decimal(previous.qpc),
      'The first encoded packet predates the prepared host.');
  }
  assert.notEqual(previous.type, 'stopped', 'A retired host cannot emit more messages.');
  return next;
}

module.exports = {
  CONFIGURATION, MAX_LINE_BYTES, MAX_PACKET_BYTES, RETIREMENT_FIELDS,
  exact, integer, decimal, configuration, validateMessage, validateProgress, validateSource, validateVideo, validateFailure, command,
};
