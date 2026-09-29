'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { root, execute, write } = require('./buildTools.cjs');
const { workspace } = require('./prepareMacRtc.cjs');
const { options, sourceEntries, fileHash, rebindSources } = require('./packSources.cjs');
const { verifyMacSourceInputs, verifyLegalFiles } = require('./checkPackage.cjs');
const pins = require('./native-rtc/pins.json');

async function packMacSources(config) {
  assert.equal(process.platform, 'darwin');
  const architectures = ['arm64', 'x64'].filter(arch => fs.existsSync(path.join(root, 'bin', `darwin-${arch}`)));
  assert.ok(architectures.length);
  for (const arch of architectures) verifyMacSourceInputs(arch);
  verifyLegalFiles(root, 'darwin');
  const omitted = ['webrtc/src/third_party/llvm-build', 'webrtc/src/third_party/ninja',
    'webrtc/src/buildtools/mac', 'webrtc/.gclient_entries', 'webrtc/.gclient_previous_sync_commits'];
  const entries = sourceEntries(workspace, ['webrtc'], omitted,
    { gitDirectory: 'webrtc/src/.git', allowInternalSymlinks: true });
  assert.ok(entries.includes('webrtc/src/.git/HEAD'));
  fs.mkdirSync(config.output, { recursive: true });
  const basename = `monky-native-macos-sources-${config.version}`;
  const archive = path.join(config.output, `${basename}.tar.xz`);
  const manifest = path.join(config.output, `${basename}.json`);
  assert.ok(!fs.existsSync(archive) && !fs.existsSync(manifest), 'macOS source package already exists.');
  const temporary = fs.mkdtempSync(path.join(root, 'build', 'mac-source-package-'));
  const partial = archive + '.' + randomUUID() + '.partial';
  try {
    const repository = path.resolve(root, '..', '..', '..', '..');
    const sourceCommit = execute('git', ['-C', repository, 'rev-parse', 'HEAD'], { capture: true });
    const sourceTree = execute('git', ['-C', repository, 'rev-parse', 'HEAD^{tree}'], { capture: true });
    const publicationReady = execute('git', ['-C', repository, 'status', '--porcelain',
      '--untracked-files=normal'], { capture: true }) === '';
    const snapshot = { schemaVersion: 1, platform: 'darwin', version: config.version, sourceCommit, sourceTree,
      publicationReady, architectures, webrtcRevision: pins.repositories.webrtc.commit,
      repositories: pins.repositories, omittedBuildTools: omitted,
      sourceFiles: entries.filter(entry => !entry.endsWith('/')).length,
    };
    write(path.join(temporary, 'SOURCE-MANIFEST.json'), JSON.stringify(snapshot, null, 2) + '\n');
    for (const language of ['', '.en'])
      fs.copyFileSync(path.join(root, `README${language}.md`), path.join(temporary, `SOURCE-README${language}.md`));
    fs.cpSync(path.join(root, 'src', 'rtc', 'inputs'), path.join(temporary, 'SOURCE-PATCHES', 'inputs'),
      { recursive: true });
    fs.copyFileSync(path.join(root, 'src', 'rtc', 'level6-upstream.json'),
      path.join(temporary, 'SOURCE-PATCHES', 'level6-upstream.json'));
    write(path.join(temporary, 'members.txt'), entries.join('\n') + '\n');
    execute(path.join(workspace, 'python-3.11', 'bin', 'python3'), ['-I',
      path.join(__dirname, 'sourceArchive.py'), `--root=${workspace}`,
      `--list=${path.join(temporary, 'members.txt')}`, `--metadata=${temporary}`,
      `--output=${partial}`, '--allow-internal-symlinks']);
    const bytes = fs.statSync(partial).size;
    assert.ok(bytes > 1_000_000 && bytes < 2_000_000_000, 'macOS source archive has an invalid size.');
    const sha256 = await fileHash(partial);
    fs.renameSync(partial, archive);
    write(manifest, JSON.stringify({ ...snapshot, archive: { name: path.basename(archive), bytes, sha256 } }, null, 2) + '\n');
    console.log(JSON.stringify({ macSourcesPackaged: true, publicationReady, archive, bytes, sha256 }));
    return { archive, manifest };
  } finally {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { packMacSources };
if (require.main === module) {
  const args = process.argv.slice(2), fromCi = args[0] === '--from-ci';
  const config = options(fromCi ? args.slice(1) : args);
  (fromCi ? rebindSources(config, undefined, 'darwin') : packMacSources(config))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
