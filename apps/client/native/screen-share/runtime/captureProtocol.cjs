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
const ENCODERS = Object.freeze({
  h264_texture_amf: Object.freeze({ codec: 'h264', mode: 'hardware', rateControl: 'VBR_LAT', vendorId: 0x1002, probe: 'obs-amf-test' }),
  obs_nvenc_h264_tex: Object.freeze({ codec: 'h264', mode: 'hardware', rateControl: 'CBR', vendorId: 0x10de, probe: 'nvenc-d3d11-session' }),
  obs_x264: Object.freeze({ codec: 'h264', mode: 'software', rateControl: 'CBR', probe: 'software-encoder' }),
  av1_texture_amf: Object.freeze({ codec: 'av1', mode: 'hardware', rateControl: 'CBR', vendorId: 0x1002, probe: 'obs-amf-test' }),
  obs_nvenc_av1_tex: Object.freeze({ codec: 'av1', mode: 'hardware', rateControl: 'CBR', vendorId: 0x10de, probe: 'nvenc-d3d11-session' }),
  monky_aom_av1: Object.freeze({ codec: 'av1', mode: 'software', rateControl: 'CBR', probe: 'software-encoder' }),
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
  if (source?.kind === 'monitor') {
    exact(source, ['kind', 'deviceId', 'deviceName', 'bounds'], 'selected monitor');
    assert.match(source.deviceId, /^\\\\\?\\DISPLAY#[\x20-\x7e]+$/u);
    assert.ok(Buffer.byteLength(source.deviceId) < 128);
    assert.match(source.deviceName, /^\\\\\.\\DISPLAY[1-9]\d*$/u);
    assert.ok(source.deviceName.length < 32);
    exact(source.bounds, ['x', 'y', 'width', 'height'], 'physical monitor bounds');
    integer(source.bounds.x, -0x80000000, 0x7fffffff);
    integer(source.bounds.y, -0x80000000, 0x7fffffff);
    integer(source.bounds.width, 1, 32768); integer(source.bounds.height, 1, 32768);
    integer(source.bounds.x + source.bounds.width, -0x80000000, 0x7fffffff);
    integer(source.bounds.y + source.bounds.height, -0x80000000, 0x7fffffff);
    return source;
  }
  if (source?.kind !== undefined) {
    assert.ok(source.kind === 'window' || source.kind === 'game', 'Unknown native capture kind.');
    exact(source, ['kind', 'hwnd', 'expectedProcessId', 'expectedProcessCreationTime100ns'], 'selected capture source');
    assert.ok(decimal(source.expectedProcessCreationTime100ns) > 0n);
  } else exact(source, ['hwnd', 'expectedProcessId'], 'legacy selected window');
  integer(source.hwnd, 1);
  integer(source.expectedProcessId, 1, 0xffffffff);
  return source;
}

function cloneSource(source) {
  validateSource(source);
  const copy = structuredClone(source);
  if (copy.bounds) Object.freeze(copy.bounds);
  return Object.freeze(copy);
}

function validateEncoder(encoder) {
  assert.ok(typeof encoder === 'string' && (encoder === 'auto' || Object.hasOwn(ENCODERS, encoder)),
    'Unsupported screen encoder.');
  return encoder;
}

function argumentsForTarget(source) {
  validateSource(source);
  if (source.kind === 'monitor') return [
    '--kind=monitor', `--monitor-id=${source.deviceId}`, `--monitor-name=${source.deviceName}`,
    `--monitor-x=${source.bounds.x}`, `--monitor-y=${source.bounds.y}`,
    `--monitor-width=${source.bounds.width}`, `--monitor-height=${source.bounds.height}`,
  ];
  return [`--hwnd=${source.hwnd}`, `--pid=${source.expectedProcessId}`,
    ...(source.kind ? [`--kind=${source.kind}`, `--process-created=${source.expectedProcessCreationTime100ns}`] : [])];
}

function validateVideo(video) {
  exact(video, ['width', 'height', 'fps', 'bitrateKbps',
    ...(Object.hasOwn(video ?? {}, 'scaleMode') ? ['scaleMode'] : [])], 'capture video configuration');
  if (Object.hasOwn(video, 'scaleMode')) assert.ok(['stretch', 'fit'].includes(video.scaleMode), 'Invalid capture scaling mode.');
  integer(video.width, 4, 3840); integer(video.height, 2, 2160);
  integer(video.fps, 1, video.width === 3840 || video.height === 2160 ? 120 : 240);
  integer(video.bitrateKbps, 50, 80000);
  assert.ok(video.width % 4 === 0 && video.height % 2 === 0 && video.bitrateKbps % 50 === 0);
  return video;
}

function normalizedVideo(video) {
  validateVideo(video);
  return { ...video, scaleMode: video.scaleMode ?? 'stretch' };
}

function configuration(video, encoder = 'h264_texture_amf', kind = 'window') {
  validateVideo(video);
  assert.ok(typeof encoder === 'string' && Object.hasOwn(ENCODERS, encoder));
  assert.ok(['window', 'monitor', 'game'].includes(kind));
  return { ...CONFIGURATION, codec: ENCODERS[encoder].codec, scaleMode: video.scaleMode ?? 'stretch', encoderId: encoder, rateControl: ENCODERS[encoder].rateControl,
    method: kind === 'game' ? 'game-hook' : 'wgc', width: video.width, height: video.height,
    fpsNumerator: video.fps, initialBitrateKbps: video.bitrateKbps };
}

function validateCapability(value, encoder) {
  exact(value, ['encoderId', 'codec', 'adapterIndex', 'adapterLuid', 'vendorId', 'deviceId',
    'probe', 'probeVerified', 'textureInput', 'dynamicBitrate'], 'verified hardware capability');
  assert.equal(value.encoderId, encoder);
  assert.equal(value.codec, ENCODERS[encoder].codec);
  assert.equal(value.adapterIndex, 0, 'Pinned Windows texture encoders require the exact adapter 0.');
  integer(value.deviceId, 0, 0xffffffff);
  decimal(value.adapterLuid);
  integer(value.vendorId, 0, 0xffffffff);
  if (ENCODERS[encoder].mode === 'hardware') assert.equal(value.vendorId, ENCODERS[encoder].vendorId);
  assert.equal(value.probe, ENCODERS[encoder].probe);
  assert.equal(value.probeVerified, true); assert.equal(value.textureInput, ENCODERS[encoder].mode === 'hardware');
  assert.equal(value.dynamicBitrate, true);
  return value;
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

function validateAdmissionFailure(message, expected) {
  exact(message, ['schemaVersion', 'kind', 'type', 'runId', 'sequence', 'helperProcessId', 'qpc', 'qpcFrequency',
    'target', 'video', 'encoder', 'captureStarted', 'observation', 'error', 'retirement'], 'capture admission failure');
  assert.equal(message.schemaVersion, 1);
  assert.equal(message.kind, 'capture-admission-error');
  assert.equal(message.type, 'error');
  assert.match(message.runId, /^[a-f0-9]{32}$/);
  integer(message.sequence);
  integer(message.helperProcessId, 1, 0xffffffff);
  assert.ok(decimal(message.qpc) > 0n && decimal(message.qpcFrequency) > 0n);
  validateSource(message.target);
  validateVideo(message.video);
  validateEncoder(message.encoder);
  assert.equal(message.captureStarted, false);
  assert.deepEqual(message.observation, { outputPackets: 0 });
  validateFailure(message.error);
  exact(message.retirement, RETIREMENT_FIELDS, 'capture admission retirement');
  for (const field of RETIREMENT_FIELDS) assert.equal(typeof message.retirement[field], 'boolean');
  if (expected) {
    assert.equal(message.runId, expected.runId);
    assert.equal(message.helperProcessId, expected.helperProcessId);
    assert.deepEqual(message.target, expected.source);
    assert.deepEqual(normalizedVideo(message.video), normalizedVideo(expected.video));
    assert.equal(message.encoder, expected.encoder ?? 'auto');
  }
  return message;
}

function validateMessage(message, expected) {
  if (message?.kind === 'capture-admission-error') return validateAdmissionFailure(message, expected);
  assert.ok(['prepared', 'ready', 'stats', 'stopped', 'error'].includes(message?.type), 'Unknown capture message.');
  const extra = message.type === 'stopped' ? ['retirement'] : message.type === 'error' ? ['error', 'retirement'] : [];
  const extended = message.schemaVersion === 2;
  exact(message, [...commonKeys, ...extra, ...(extended ? ['target', 'capability'] : [])], 'capture message');
  assert.ok(extended || message.schemaVersion === 1);
  const kind = extended ? message.target?.kind : 'window';
  assert.ok(['window', 'monitor', 'game'].includes(kind));
  if (extended) validateSource(message.target);
  assert.match(message.runId, /^[a-f0-9]{32}$/);
  integer(message.sequence);
  integer(message.helperProcessId, 1, 0xffffffff);
  if (kind === 'monitor') {
    assert.equal(message.hwnd, 0); assert.equal(message.processId, 0);
    assert.equal(message.processCreationTime100ns, '0');
  } else {
    integer(message.hwnd, 1);
    integer(message.processId, 1, 0xffffffff);
    assert.ok(decimal(message.processCreationTime100ns) > 0n);
    if (extended) {
      assert.equal(message.target.hwnd, message.hwnd);
      assert.equal(message.target.expectedProcessId, message.processId);
      assert.equal(message.target.expectedProcessCreationTime100ns, message.processCreationTime100ns);
    }
  }
  const qpc = decimal(message.qpc);
  assert.ok(qpc > 0n && decimal(message.qpcFrequency) > 0n);
  if (expected) {
    validateSource(expected.source);
    assert.equal(message.runId, expected.runId);
    assert.equal(message.helperProcessId, expected.helperProcessId);
    assert.equal(kind, expected.source.kind ?? 'window');
    if (kind === 'monitor') assert.deepEqual(message.target, expected.source);
    else {
      assert.equal(message.hwnd, expected.source.hwnd);
      assert.equal(message.processId, expected.source.expectedProcessId);
      if (expected.source.kind) {
        assert.equal(extended, true);
        assert.deepEqual(message.target, expected.source);
      }
    }
    const encoder = validateEncoder(expected.encoder ?? 'auto');
    if (encoder !== 'auto') assert.equal(message.configuration.encoderId, encoder);
    assert.deepEqual(message.configuration, configuration(expected.video, message.configuration.encoderId, kind));
  }
  const selected = message.configuration;
  assert.deepEqual(selected, configuration({
    width: selected?.width, height: selected?.height, fps: selected?.fpsNumerator, bitrateKbps: selected?.initialBitrateKbps,
    scaleMode: selected?.scaleMode,
  }, selected?.encoderId, kind));
  if (!extended) assert.equal(selected.encoderId, CONFIGURATION.encoderId, 'Legacy protocol cannot claim NVENC support.');
  if (extended) {
    if (message.capability === null) assert.ok(message.type === 'error' || message.type === 'stopped');
    else validateCapability(message.capability, selected.encoderId);
  }
  if (kind === 'monitor') {
    assert.equal(message.sourceKey, null);
    assert.equal(message.hookedKey, null);
  } else {
    windowKey(message.sourceKey);
    if (message.hookedKey !== null) windowKey(message.hookedKey);
  }
  const observation = message.observation;
  exact(observation, observationKeys, 'capture observation');
  assert.equal(observation.state, { prepared: 'prepared', ready: 'running', stats: 'running',
    stopped: 'stopped', error: 'failed' }[message.type]);
  assert.equal(typeof observation.sourceAttached, 'boolean');
  for (const name of ['sourceWidth', 'sourceHeight'])
    if (observation[name] !== null) integer(observation[name], 1, 32768);
  assert.equal(observation.sourceWidth === null, observation.sourceHeight === null);
  if (kind === 'monitor' && observation.sourceWidth !== null) {
    assert.equal(observation.sourceWidth, message.target.bounds.width);
    assert.equal(observation.sourceHeight, message.target.bounds.height);
  }
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
    if (message.type === 'ready') assert.equal(observation.sourceAttached, true);
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
  assert.ok(previous.kind !== 'capture-admission-error' && next.kind !== 'capture-admission-error',
    'A source admission failure must be the first and terminal control response.');
  for (const name of ['runId', 'helperProcessId', 'hwnd', 'processId', 'processCreationTime100ns', 'qpcFrequency'])
    assert.equal(next[name], previous[name], `Native identity changed: ${name}`);
  assert.deepEqual(next.configuration, previous.configuration);
  assert.deepEqual(next.sourceKey, previous.sourceKey);
  assert.equal(next.schemaVersion, previous.schemaVersion);
  if (previous.schemaVersion === 2) {
    assert.deepEqual(next.target, previous.target);
    assert.deepEqual(next.capability, previous.capability);
  }
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

function validateEncoderProbeMessage(message, expected) {
  assert.ok(['prepared', 'stopped', 'error'].includes(message?.type), 'Unknown encoder probe message.');
  const extra = message.type === 'stopped' ? ['retirement'] : message.type === 'error' ? ['error', 'retirement'] : [];
  exact(message, ['schemaVersion', 'kind', 'type', 'runId', 'sequence', 'helperProcessId', 'qpc', 'qpcFrequency',
    'video', 'captureKinds', 'capability', 'encoderInitialized', 'sourceCaptured', 'outputPackets', ...extra],
  'source-free encoder probe');
  assert.equal(message.schemaVersion, 1); assert.equal(message.kind, 'encoder-probe');
  assert.match(message.runId, /^[a-f0-9]{32}$/u);
  integer(message.sequence, 0, 1); integer(message.helperProcessId, 1, 0xffffffff);
  assert.ok(decimal(message.qpc) > 0n && decimal(message.qpcFrequency) > 0n);
  validateVideo(message.video);
  assert.equal(message.sourceCaptured, false); assert.equal(message.outputPackets, 0);
  assert.equal(typeof message.encoderInitialized, 'boolean');
  assert.ok(Array.isArray(message.captureKinds));
  if (message.captureKinds.length) assert.deepEqual(message.captureKinds, ['window', 'monitor', 'game']);
  if (message.capability !== null) validateCapability(message.capability, message.capability.encoderId);
  if (message.encoderInitialized) {
    assert.ok(message.capability);
    assert.deepEqual(message.captureKinds, ['window', 'monitor', 'game']);
  }
  if (expected) {
    assert.equal(expected.source, null, 'Encoder probing cannot select a source.');
    assert.equal(message.runId, expected.runId);
    assert.equal(message.helperProcessId, expected.helperProcessId);
    assert.deepEqual(normalizedVideo(message.video), normalizedVideo(expected.video));
    const encoder = validateEncoder(expected.encoder ?? 'auto');
    if (encoder !== 'auto' && message.capability) assert.equal(message.capability.encoderId, encoder);
  }
  if (message.type === 'prepared') {
    assert.equal(message.sequence, 0);
    assert.equal(message.encoderInitialized, true, 'Registration/vendor evidence is not encoder initialization.');
  } else {
    exact(message.retirement, RETIREMENT_FIELDS, 'encoder probe retirement');
    for (const field of RETIREMENT_FIELDS) {
      assert.equal(typeof message.retirement[field], 'boolean');
      if (message.type === 'stopped') assert.equal(message.retirement[field], true);
    }
    if (message.type === 'stopped') assert.equal(message.sequence, 1);
    else validateFailure(message.error);
  }
  return message;
}

function validateEncoderProbeProgress(previous, next) {
  assert.equal(previous.type, 'prepared', 'An encoder probe cannot emit after retirement/failure.');
  assert.ok(next.type === 'stopped' || next.type === 'error', 'An encoder probe cannot capture or prepare twice.');
  for (const name of ['schemaVersion', 'kind', 'runId', 'helperProcessId', 'qpcFrequency',
    'video', 'captureKinds', 'capability', 'encoderInitialized', 'sourceCaptured', 'outputPackets'])
    assert.deepEqual(next[name], previous[name], `Encoder probe evidence changed: ${name}`);
  assert.ok(decimal(next.qpc) >= decimal(previous.qpc), 'Encoder probe QPC regressed.');
  return next;
}

module.exports = {
  CONFIGURATION, ENCODERS, MAX_LINE_BYTES, MAX_PACKET_BYTES, RETIREMENT_FIELDS,
  cloneSource, validateEncoder, validateCapability, argumentsForTarget,
  exact, integer, decimal, configuration, validateMessage, validateProgress, validateSource, validateVideo, normalizedVideo, validateFailure, command,
  validateEncoderProbeMessage, validateEncoderProbeProgress,
};
