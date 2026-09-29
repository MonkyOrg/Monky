'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

function validateCapabilities(value, platform = process.platform) {
  assert.ok(['win32', 'darwin'].includes(platform), 'Unsupported native RTC platform.');
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Missing native encoded capabilities.');
  for (const [name, expected] of Object.entries({
    abiVersion: 2, contractRevision: 8, externallyEncodedH264: true, externallyEncodedAV1: true, encodedInputCopied: true,
    encodedFeedback: true, encodedProfileLevelId: '4d003c', encodedBitrateCeilingBps: 80000000,
    pairedCaptureClock: true, p2pReceiverRouting: true, inputLeaseCorrelation: true,
    decodedOutput: platform === 'darwin' ? 'NV12_IOSURFACE_LEASE' : 'NV12_SHARED_NT_LEASE',
    runtimeQualified: false, hardwareExecutionObserved: null,
  })) assert.equal(Object.getOwnPropertyDescriptor(value, name)?.value, expected, `Native encoded capability mismatch: ${name}`);
  if (platform === 'darwin') {
    assert.equal(value.inputFormat, null, 'macOS publishing accepts encoded video, not Windows GPU handles.');
    assert.equal(value.inputTimebase, 'mach-host-us');
  }
  return value;
}

function load(filename, { capabilities, handlesFile } = {}) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64'
    || process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch));
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
