'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { root, execute } = require('./buildTools.cjs');
const { verifySourceInputs, verifyMacSourceInputs, verifyMacRuntime, verifyLegalFiles } = require('./checkPackage.cjs');

// Cached or downloaded binaries skip compilation, so repeat the build's own acceptance checks
// against this checkout before tests, packaging or the cache can use them.
function verifyMacOutputs({ architectures = ['arm64', 'x64'], legal = false } = {}) {
  assert.equal(process.platform, 'darwin');
  const results = [];
  for (const arch of architectures) {
    const directory = path.join(root, 'bin', `darwin-${arch}`);
    verifyMacSourceInputs(arch);
    verifyMacRuntime(directory, arch);
    const tests = JSON.parse(execute(path.join(directory, 'monky-screen-mac'), ['--self-test'], { capture: true }));
    assert.equal(tests.deviceFree, true, `The ${arch} capture executable must pass its device-free self-test.`);
    if (arch === process.arch) {
      const { capabilities } = require(path.join(directory, 'rtc-build.json'));
      const loaded = JSON.parse(execute(process.execPath, ['-e',
        'console.log(JSON.stringify(require(process.argv[1]).capabilities()))',
        path.join(directory, 'monky_screen_rtc.node')], { capture: true }));
      assert.deepEqual(loaded, capabilities, `The ${arch} addon must report its recorded capabilities.`);
    }
    results.push({ arch, selfTest: true, addonLoaded: arch === process.arch });
  }
  if (legal) verifyLegalFiles(root, 'darwin');
  return results;
}

function verifyWindowsOutputs() {
  assert.equal(process.platform, 'win32');
  verifySourceInputs();
  verifyLegalFiles(root);
  const native = require(path.join(root, 'index.cjs'));
  const runtime = native.loadRuntime();
  native.loadThumbnailRuntime();
  return [{ arch: 'x64', obsVersion: runtime.obs.version, contractRevision: runtime.rtc.capabilities().contractRevision }];
}

function options(argv) {
  const [platform, ...rest] = argv;
  assert.ok(['mac', 'win'].includes(platform), 'Usage: verifyOutputs.cjs <mac|win> [--arch=arm64,x64] [--legal]');
  const result = { platform };
  for (const argument of rest) {
    assert.equal(platform, 'mac', 'Windows output verification has no options.');
    if (argument === '--legal' && !result.legal) result.legal = true;
    else if (/^--arch=(arm64|x64)(,(arm64|x64))?$/u.test(argument) && !result.architectures) {
      const selected = argument.slice(7).split(',');
      assert.equal(new Set(selected).size, selected.length, 'Repeated macOS architecture.');
      result.architectures = ['arm64', 'x64'].filter(arch => selected.includes(arch));
    } else throw new Error(`Unknown or repeated output verification option: ${argument}`);
  }
  return result;
}

module.exports = { verifyMacOutputs, verifyWindowsOutputs, options };
if (require.main === module) {
  try {
    const config = options(process.argv.slice(2));
    const verified = config.platform === 'mac' ? verifyMacOutputs(config) : verifyWindowsOutputs();
    console.log(JSON.stringify({ nativeOutputsVerified: true, platform: config.platform, verified }));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
