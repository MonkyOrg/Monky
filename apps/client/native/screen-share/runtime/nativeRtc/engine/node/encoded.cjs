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

function load(filename, { capabilities, handlesFile } = {}) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename) && path.extname(filename) === '.node');
  validateCapabilities(capabilities);
  assert.ok(typeof handlesFile === 'string' && path.isAbsolute(handlesFile));
  const { ProcessEngine } = require('./process.cjs');
  const declared = structuredClone(capabilities);
  return Object.freeze({
    // Build-verified compiled support, not a device probe. Each child validates
    // the actual DLL against this declaration before engine.ready can resolve.
    capabilities: () => structuredClone(declared),
    createEngine(options, onEvent) {
      return new ProcessEngine({ filename, capabilities: declared, handlesFile, options, onEvent });
    },
  });
}

module.exports = { load, validateCapabilities };
