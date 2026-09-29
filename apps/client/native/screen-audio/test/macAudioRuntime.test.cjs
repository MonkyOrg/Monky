'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

test('compiled macOS packet capture rejects a Node-only host and drains its native worker', {
  skip: process.platform !== 'darwin',
  timeout: 10000,
}, async () => {
  const audio = require('..');
  assert.equal(audio.isPacketCaptureSupported(), true, 'Build the production audio addon before this test.');
  const errors = [];
  const capture = audio.createPacketCapture({ excludePid: process.pid }, event => {
    if (event.type === 'error') errors.push(event.error);
  });
  try {
    await assert.rejects(capture.ready, { code: 'ERR_AUDIO_RUNTIME' });
    const closed = await capture.closed;
    assert.equal(closed.state, 'failed');
    assert.equal(closed.error.code, 'ERR_AUDIO_RUNTIME');
    assert.ok(errors.some(error => error.code === 'ERR_AUDIO_RUNTIME'));
  } finally { await capture.stop(); }
});
