'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { archiveEntryAllowed, sourceEntries, options } = require('../scripts/packSources.cjs');

test('corresponding source keeps SDK identity and required tools, not build products or Git user records', () => {
  for (const name of [
    'rtc/webrtc/src/.git/HEAD', 'rtc/webrtc/src/.git/objects/pack/source.pack',
    'rtc/webrtc/src/api/video/frame.h', 'rtc/webrtc/src/buildtools/win/gn.exe',
    'rtc/webrtc/src/third_party/ninja/ninja.exe', 'obs-studio/COPYING',
    'rtc/webrtc/src/third_party/depot_tools/gclient.py',
    'rtc/webrtc/src/third_party/depot_tools/breakpad.py',
    'obs-sources/FFmpeg/libavcodec/h264dec.c', 'downloads/abc.zip',
  ]) assert.equal(archiveEntryAllowed(name), true, name);
  for (const name of [
    'rtc/webrtc/src/out/native/file.obj', 'rtc/webrtc/src/.git/logs/HEAD',
    'rtc/webrtc/src/.git/hooks/post-checkout', 'obs-sources/FFmpeg/.git/HEAD',
    'rtc/webrtc/src/third_party/boringssl/src/.git/HEAD', 'rtc/webrtc/src/.cipd/metadata',
    'rtc/webrtc/src/third_party/depot_tools/.git/HEAD',
  ]) assert.equal(archiveEntryAllowed(name), false, name);
  assert.equal(archiveEntryAllowed('rtc/webrtc/src/tools/luci-go/cas.exe', ['rtc/webrtc/src/tools/luci-go']), false);
  for (const name of ['../outside', '/absolute', 'source:stream', 'source\noutside'])
    assert.throws(() => archiveEntryAllowed(name), /Unsafe source archive/);
});

test('source archive names use an unprefixed semantic version and reject path injection', () => {
  assert.equal(options(['--version=9.0.0-beta']).version, '9.0.0-beta');
  for (const version of ['v9.0.0', '../9.0.0', '9.0.0/beta', '9.0.0\nother'])
    assert.throws(() => options([`--version=${version}`]));
});

const python = process.env.PYTHON ?? path.resolve(__dirname, '..', '..', '..', '..', '..', '.native-screen', 'python', 'Scripts', 'python.exe');
test('the source archiver preserves a real file inventory without local-account metadata',
  { skip: !path.isAbsolute(python) || !fs.existsSync(python) }, t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'monky-source-archive-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'input'));
    fs.mkdirSync(path.join(directory, 'metadata'));
    fs.writeFileSync(path.join(directory, 'input', 'source file.cpp'), 'int main() { return 0; }\n');
    const unicodeName = 'source-\u65e5\u672c.cpp';
    fs.writeFileSync(path.join(directory, 'input', unicodeName), 'int unicode_source = 1;\n');
    const sdk = path.join(directory, 'input', 'rtc', 'webrtc', 'src');
    const initialized = spawnSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', sdk], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const entries = sourceEntries(path.join(directory, 'input'), ['source file.cpp', unicodeName, 'rtc/webrtc'], []);
    assert.ok(entries.includes('rtc/webrtc/src/.git/refs/'));
    fs.writeFileSync(path.join(directory, 'members.txt'), entries.join('\n') + '\n');
    for (const filename of ['SOURCE-MANIFEST.json', 'SOURCE-README.md', 'SOURCE-README.en.md'])
      fs.writeFileSync(path.join(directory, 'metadata', filename), filename);
    const result = spawnSync(python, [
      '-I', path.resolve(__dirname, '..', 'scripts', 'sourceArchive.py'),
      `--root=${path.join(directory, 'input')}`, `--list=${path.join(directory, 'members.txt')}`,
      `--metadata=${path.join(directory, 'metadata')}`, `--output=${path.join(directory, 'source.tar.xz')}`,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).sourceArchiveVerified, true);
    assert.equal(fs.statSync(path.join(directory, 'source.tar.xz')).size > 0, true);
    const extracted = path.join(directory, 'extracted');
    const extraction = spawnSync(python, ['-I', '-c',
      "import sys, tarfile; tarfile.open(sys.argv[1], 'r|xz').extractall(sys.argv[2], filter='data')",
      path.join(directory, 'source.tar.xz'), extracted,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(extraction.error, undefined);
    assert.equal(extraction.status, 0, extraction.stdout + extraction.stderr);
    for (const name of ['source file.cpp', unicodeName])
      assert.deepEqual(fs.readFileSync(path.join(extracted, name)), fs.readFileSync(path.join(directory, 'input', name)));
    const extractedSdk = path.join(extracted, 'rtc', 'webrtc', 'src');
    const checkout = spawnSync('git', ['-C', extractedSdk, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    assert.equal(checkout.status, 0, checkout.stderr);
    assert.equal(fs.realpathSync.native(checkout.stdout.trim()), fs.realpathSync.native(extractedSdk));
  });
