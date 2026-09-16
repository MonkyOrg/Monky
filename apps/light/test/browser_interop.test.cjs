const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildDirectory } = require('./native_test_paths.cjs');

for (const mode of ['p2p', 'sfu']) {
  test(`native ${mode} audio interoperates with the current client's Chromium`, { timeout: 75_000 }, async () => {
    const profile = fs.mkdtempSync(path.join(buildDirectory, 'chromium-fixture-'));
    const env = { ...process.env, MONKY_LIGHT_BROWSER_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'browser_peer_smoke.cjs'), mode], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-128 * 1024); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-128 * 1024); });
    const timeout = setTimeout(() => child.kill(), 65_000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(result, { code: 0, signal: null }, output);
      assert.ok(output.includes(`Native/Chromium ${mode} bidirectional decoded audio succeeded`), output);
    } finally {
      clearTimeout(timeout);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
