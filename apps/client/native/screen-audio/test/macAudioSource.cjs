'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');

function createMacAudioSource(directory) {
  const bundle = path.join(directory, 'MonkyAudioSource.app', 'Contents');
  const executable = path.join(bundle, 'MacOS', 'MonkyAudioSource');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.monky.test.audio-${randomUUID()}</string>
<key>CFBundleExecutable</key><string>MonkyAudioSource</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`);
  const build = spawnSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-mmacosx-version-min=13.0',
    path.join(__dirname, 'macAudioSource.mm'), '-framework', 'AppKit', '-framework', 'AVFoundation',
    '-o', executable], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (line.startsWith('MONKY_SOURCE ')) child.emit('message', JSON.parse(line.slice(13)));
    else console.log(line);
  });
  child.stderr.pipe(process.stderr);
  // Adapt the owned native fixture's line protocol to the existing A/V source control interface.
  child.connected = true;
  child.send = value => {
    assert.match(value.id, /^[0-9a-f-]{36}$/);
    assert.ok(['tone-start', 'tone-stop', 'close-source'].includes(value.command));
    child.stdin.write(`${value.id} ${value.command}\n`);
  };
  child.disconnect = () => { child.connected = false; child.stdin.end('close\n'); };
  child.once('exit', () => { child.connected = false; lines.close(); });
  return child;
}

module.exports = { createMacAudioSource };
