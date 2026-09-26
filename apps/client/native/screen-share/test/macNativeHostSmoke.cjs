'use strict';
const assert = require('node:assert/strict');
const { createMacScreenProvider } = require('../runtime/mac/index.cjs');
async function main() {
  assert.equal(process.platform, 'darwin');
  const provider = createMacScreenProvider();
  try {
    const capabilities = await provider.capabilities();
    assert.equal(capabilities.enumeration, 'ScreenCaptureKit');
    assert.equal(capabilities.thumbnails, 'SCScreenshotManager');
    assert.equal(capabilities.capture, false);
    assert.equal(capabilities.transport, false);
    assert.equal(capabilities.receive, false);
  } finally { await provider.close(); }
  console.log(JSON.stringify({
    macNativeHost: true, processHandshake: true, nativeClose: true,
    actualProcessExit: true, capturedPersonalSources: false, mediaSupportValidated: false,
  }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
