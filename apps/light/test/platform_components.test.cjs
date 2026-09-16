const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { buildDirectory, nativeExecutable } = require('./native_test_paths.cjs');

function run(component, args) {
  const result = spawnSync(nativeExecutable(component), args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 128 * 1024,
  });
  if (result.error) {
    throw new Error(`${component}: ${result.stderr || result.stdout}`, { cause: result.error });
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('native SDK links and initializes crypto/audio processing without physical devices', () => {
  run('monky-light-sdk-check', []);
});

test('native identity persistence owns only disposable profiles', () => {
  run('monky-light-platform-test', [buildDirectory]);
});

test('native profile identity preserves device IDs and refuses inconsistent state', () => {
  run('monky-light-profile-test', [buildDirectory]);
});

test('native application loop waits for events and enforces deadlines and queue bounds', () => {
  run('monky-light-loop-test', []);
});

test('synthetic native audio measures PCM and drains callbacks without touching hardware', () => {
  run('monky-light-audio-fixture-test', []);
});

test('native protocol session validates admission, policies, deadlines and RPC generations', () => {
  run('monky-light-session-test', []);
});

test('native media lifecycle rejects invalid devices and cancels owned work', () => {
  run('monky-light-media-lifecycle-test', []);
});

test('native P2P engines exchange decoded synthetic PCM and stop devices under mute/deafen', () => {
  run('monky-light-media-loopback-test', []);
});

test('macOS transport fixtures share the production bundle network policy, not its identity',
  { skip: process.platform !== 'darwin' }, () => {
    for (const [target, identifier] of [
      ['monky-light', 'org.monky.light'],
      ['monky-light-websocket-fixture', 'org.monky.light.websocket-fixture'],
    ]) {
      const info = path.join(path.dirname(path.dirname(nativeExecutable(target))), 'Info.plist');
      const options = { encoding: 'utf8', timeout: 5000 };
      execFileSync('plutil', ['-lint', info], options);
      const value = key => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', info], options).trim();
      assert.equal(value('CFBundleExecutable'), target);
      assert.equal(value('CFBundleIdentifier'), identifier);
      assert.equal(value('NSAppTransportSecurity.NSAllowsArbitraryLoads'), 'true');
      assert.ok(value('NSMicrophoneUsageDescription').length > 0);
    }
  });
