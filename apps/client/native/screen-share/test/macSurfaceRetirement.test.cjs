'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const binary = path.resolve(__dirname, '..', 'bin', `darwin-${process.arch}`, 'monky_native_surfaces.node');

test('macOS IOSurface bootstrap registrations retire when their owned receive right is destroyed', {
  skip: process.platform !== 'darwin' || !fs.existsSync(binary) ? 'Requires the compiled macOS runtime.' : false,
  timeout: 15000,
}, async t => {
  const surfaces = require(binary);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  await once(child, 'spawn');
  for (let index = 0; index < 8; index++) {
    const receiver = surfaces.createReceiver(child.pid);
    try { surfaces.openSender(receiver.name).close(); }
    finally { receiver.close(); }
    receiver.close();
    const deadline = performance.now() + 1000;
    let retired = false;
    do {
      try { surfaces.openSender(receiver.name).close(); }
      catch (error) { assert.equal(error.code, 'ERR_RTC_IOSURFACE'); retired = true; }
      if (!retired) await delay(10);
    } while (!retired && performance.now() < deadline);
    assert.equal(retired, true, 'A closed IOSurface receiver left its bootstrap service discoverable.');
  }
});
