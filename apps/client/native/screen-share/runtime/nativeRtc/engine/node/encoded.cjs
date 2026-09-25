'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

function validateCapabilities(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Missing native encoded capabilities.');
  for (const [name, expected] of Object.entries({
    abiVersion: 2, contractRevision: 8, externallyEncodedH264: true, externallyEncodedAV1: true, encodedInputCopied: true,
    encodedFeedback: true, encodedProfileLevelId: '4d003c', encodedBitrateCeilingBps: 80000000,
    pairedCaptureClock: true, p2pReceiverRouting: true, inputLeaseCorrelation: true,
    decodedOutput: 'NV12_SHARED_NT_LEASE', runtimeQualified: false, hardwareExecutionObserved: null,
  })) assert.equal(Object.getOwnPropertyDescriptor(value, name)?.value, expected, `Native encoded capability mismatch: ${name}`);
  return value;
}

function load(filename) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename) && path.extname(filename) === '.node');
  const addon = require(filename);
  assert.equal(typeof addon.capabilities, 'function');
  assert.equal(typeof addon.createEngine, 'function');
  return Object.freeze({
    capabilities: () => validateCapabilities(addon.capabilities()),
    createEngine(options, onEvent) {
      validateCapabilities(addon.capabilities());
      return addon.createEngine(options, onEvent);
    },
  });
}

module.exports = { load, validateCapabilities };
