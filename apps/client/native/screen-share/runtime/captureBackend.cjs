'use strict';

const assert = require('node:assert/strict');
const windows = require('./captureBridge.cjs');
const protocol = require('./captureProtocol.cjs');
const apple = require('./mac/captureBridge.cjs');
const { validateMacTarget } = require('./mac/target.cjs');

function validateCaptureTarget(target) {
  return target?.platform === 'darwin' ? validateMacTarget(target) : protocol.validateSource(target);
}
function cloneCaptureTarget(target) {
  validateCaptureTarget(target);
  const value = structuredClone(target);
  if (value.bounds) Object.freeze(value.bounds);
  return Object.freeze(value);
}
function captureEncoderProfile(encoder, target) {
  if (target?.platform === 'darwin') return apple.encoderProfile(encoder);
  protocol.validateEncoder(encoder);
  return encoder === 'auto' ? { codec: 'h264', mode: 'hardware' } : protocol.ENCODERS[encoder];
}
function createCaptureBridge(options, dependencies) {
  if (options.host?.kind === 'verified-screencapturekit-host') return new apple.MacCaptureBridge(options, dependencies);
  assert.equal(options.host?.kind, 'verified-native-screen-capture-host');
  return new windows.CaptureBridge(options, dependencies);
}
function probeCaptureCapabilities(options, signal, dependencies) {
  return options.host?.kind === 'verified-screencapturekit-host'
    ? apple.probeCaptureCapabilities(options, signal, dependencies)
    : windows.probeCaptureCapabilities(options, signal, dependencies);
}

module.exports = { createCaptureBridge, probeCaptureCapabilities, validateCaptureTarget,
  cloneCaptureTarget, captureEncoderProfile };
