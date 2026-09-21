'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, digest, regularFiles, verify } = require('./buildTools.cjs');
const { verifiedFile } = require('../runtime/runtimeFiles.cjs');
const { copyMonkyLicenses } = require('../../../../../scripts/legal.cjs');

function verifySourceInputs() {
  const bin = path.join(root, 'bin', 'win32-x64');
  const rtc = JSON.parse(fs.readFileSync(path.join(bin, 'rtc-build.json'), 'utf8'));
  const capture = JSON.parse(fs.readFileSync(path.join(bin, 'capture-build.json'), 'utf8'));
  assert.equal(capture.schemaVersion, 3, 'Rebuild capture for the source-bound hardware backend.');
  verify(path.join(root, 'scripts', 'captureSourceBindings.cjs'), capture.sourceBindingRecipe);
  for (const [directory, records] of [
    [path.join(root, 'src', 'rtc'), rtc.sourceFiles],
    [path.join(root, 'src', 'capture'), capture.sourceFiles],
  ]) {
    assert.ok(Array.isArray(records) && records.length > 0, 'Rebuild native screen sharing before packaging.');
    assert.deepEqual(records.map(file => file.path).sort(), regularFiles(directory),
      'Native source inventory changed since compilation. Run npm run prepare:native-screen.');
    for (const file of records) {
      assert.equal(digest(fs.readFileSync(path.join(directory, file.path))), file.sha256,
        `Native source changed since compilation: ${file.path}`);
    }
  }
  const obs = require('../src/vendor/obs/sources.json');
  for (const file of obs.files) verify(path.join(root, 'src', 'vendor', 'obs', file.path), file);
}

function verifyLegalFiles(directory) {
  const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'licenses', 'catalog.json'), 'utf8'));
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.license, 'GPL-3.0-or-later');
  assert.equal(catalog.webrtcRevision, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  assert.equal(catalog.obsRevision, '7272af1375b38bc3cf4e0f98a5d999e8b76e9309');
  assert.ok(Array.isArray(catalog.files) && catalog.files.length >= 40, 'Native third-party notices are incomplete.');
  for (const record of catalog.files) verifiedFile(directory, record);
  for (const name of ['LICENSE', 'LICENSE-MIT'])
    assert.deepEqual(fs.readFileSync(path.join(directory, name)), fs.readFileSync(path.join(root, name)));
  const notice = fs.readFileSync(path.join(directory, 'THIRD_PARTY_NOTICES'), 'utf8');
  assert.ok(notice.includes('Corresponding Source:') && notice.includes('Microsoft Visual C++'));
  assert.ok(fs.statSync(path.join(directory, 'README.md')).isFile());
  return catalog;
}

async function afterPack(context) {
  const platform = context.electronPlatformName;
  const contents = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
    : context.appOutDir;
  for (const name of ['LICENSE', 'LICENSE-MIT'])
    assert.deepEqual(fs.readFileSync(path.join(contents, name)),
      fs.readFileSync(path.resolve(root, '..', '..', '..', '..', name)), `Missing packaged Monky notice: ${name}`);
  const modules = path.join(contents, platform === 'darwin' ? 'Resources' : 'resources',
    'app', 'node_modules', '@monky');
  assert.ok(!fs.existsSync(path.join(modules, 'server', 'data')), 'Server user data must never be packaged.');
  const directory = path.join(modules, 'screen-share');
  assert.ok(fs.statSync(directory).isDirectory(), 'The packaged native screen module is missing.');
  for (const name of ['build', 'src', 'scripts', 'test'])
    assert.ok(!fs.existsSync(path.join(directory, name)), `Native build/source-only material leaked into the application: ${name}`);
  copyMonkyLicenses(directory);
  if (platform !== 'win32') return;
  assert.equal(context.arch, require('builder-util').Arch.x64, 'The native Windows screen runtime requires x64.');
  verifySourceInputs();
  verifyLegalFiles(root);
  fs.cpSync(path.join(root, 'licenses'), path.join(directory, 'licenses'), { recursive: true });
  for (const name of ['README.md', 'README.en.md', 'THIRD_PARTY_NOTICES'])
    fs.copyFileSync(path.join(root, name), path.join(directory, name));
  for (const relative of ['index.cjs', ...regularFiles(path.join(root, 'runtime')).map(file => path.join('runtime', file))])
    assert.deepEqual(fs.readFileSync(path.join(directory, relative)), fs.readFileSync(path.join(root, relative)),
      `Packaged native runtime differs from the verified source: ${relative}`);
  verifyLegalFiles(directory);
  require(path.join(directory, 'index.cjs')).loadRuntime();
  console.log('Packaged native screen runtime, app-local CRT, source fingerprints and third-party notices verified.');
}

module.exports = afterPack;
module.exports.verifySourceInputs = verifySourceInputs;
module.exports.verifyLegalFiles = verifyLegalFiles;
