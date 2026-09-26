'use strict';
const assert = require('node:assert/strict');
const { createMacScreenProvider, loadMacCaptureRuntime } = require('../runtime/mac/index.cjs');
const { MacNativeHost } = require('../runtime/mac/host.cjs');
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
  const host = new MacNativeHost(loadMacCaptureRuntime().executable);
  try {
    const result = await host.request('media.probe', { video: {
      width: 320, height: 180, fps: 30, bitrateKbps: 1000, mode: 'software', scaleMode: 'fit',
    } });
    assert.equal(result.value.sessionUsesHardware, false);
    assert.equal(result.value.hardwareExecutionObserved, null);
    assert.equal(result.value.captureStarted, false);
    assert.equal(result.value.nativeClosed, true);
    await assert.rejects(host.request('media.stop'), { code: 'ERR_MAC_CAPTURE_STATE' });
    assert.equal((await host.request('capabilities')).value.platform, 'darwin');
  } finally { await host.close(); }
  console.log(JSON.stringify({
    macNativeHost: true, processHandshake: true, nativeClose: true,
    actualProcessExit: true, capturedPersonalSources: false, mediaSupportValidated: false,
    actualEncoderProbe: true,
  }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
