'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write } = require('./buildTools.cjs');
const { cache } = require('./fetchObs.cjs');
const { verifySourceInputs, verifyLegalFiles } = require('./checkPackage.cjs');

const repository = path.resolve(root, '..', '..', '..', '..');
const sdkGit = 'rtc/webrtc/src/.git';
const keptArtifacts = new Set([
  'webrtc/src/buildtools/win',
  'webrtc/src/third_party/llvm-build/Release+Asserts',
  'webrtc/src/third_party/ninja',
]);

function archiveEntryAllowed(relative, omitted = [], gitDirectory = sdkGit) {
  const normalized = relative.replaceAll('\\', '/');
  assert.ok(normalized && !normalized.startsWith('/') && !normalized.includes(':') &&
    !/[\0\r\n]/u.test(normalized) && !normalized.split('/').includes('..'), 'Unsafe source archive path.');
  if (omitted.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'))) return false;
  const components = normalized.split('/');
  if (components.includes('.git')) {
    if (!normalized.startsWith(gitDirectory + '/') && normalized !== gitDirectory) return false;
    const suffix = normalized.slice(gitDirectory.length + 1);
    if (/^(?:hooks|logs)(?:\/|$)/u.test(suffix) || /^(?:FETCH_HEAD|ORIG_HEAD)$/u.test(suffix)) return false;
  }
  if (components.some(part => ['out', '.cipd', '__pycache__', 'node_modules'].includes(part))) return false;
  return true;
}

function sourceEntries(directory, members, omitted, { gitDirectory = sdkGit, allowInternalSymlinks = false } = {}) {
  const entries = [];
  function visit(relative) {
    if (!archiveEntryAllowed(relative, omitted, gitDirectory)) return;
    const filename = path.join(directory, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) {
      assert.ok(allowInternalSymlinks && !path.isAbsolute(fs.readlinkSync(filename)),
        `Unexpected source alias: ${relative}`);
      const destination = path.resolve(path.dirname(filename), fs.readlinkSync(filename));
      const target = path.relative(fs.realpathSync(directory),
        fs.existsSync(destination) ? fs.realpathSync(destination) : destination).replaceAll('\\', '/');
      assert.ok(archiveEntryAllowed(target, omitted, gitDirectory), `Source alias escapes its inventory: ${relative}`);
      entries.push(relative.replaceAll('\\', '/'));
      return;
    }
    if (stat.isDirectory()) {
      entries.push(relative.replaceAll('\\', '/') + '/');
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(relative, name));
    } else {
      assert.ok(stat.isFile());
      entries.push(relative.replaceAll('\\', '/'));
    }
  }
  for (const member of members) visit(member);
  return [...new Set(entries)].sort();
}

async function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function options(argv) {
  const result = {
    version: process.env.MONKY_VERSION ?? require('../../../package.json').version,
    output: path.join(repository, 'release'),
  };
  const seen = new Set();
  for (const argument of argv) {
    const at = argument.indexOf('='), key = argument.slice(0, at), value = argument.slice(at + 1);
    assert.ok(at > 0 && value && !seen.has(key), 'Use unique --version= and --out= options.');
    seen.add(key);
    if (key === '--version') result.version = value;
    else if (key === '--out') result.output = path.resolve(value);
    else if (key === '--architectures') {
      const architectures = value.split(',');
      assert.ok(architectures.every(arch => ['arm64', 'x64'].includes(arch)) &&
        new Set(architectures).size === architectures.length, 'Use --architectures= with distinct arm64/x64 values.');
      result.architectures = ['arm64', 'x64'].filter(arch => architectures.includes(arch));
    } else throw new Error(`Unknown source package option: ${key}`);
  }
  assert.match(result.version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu, 'Invalid source package version.');
  return result;
}

async function packSources(config) {
  assert.equal(config.architectures, undefined, '--architectures only applies to macOS corresponding sources.');
  verifySourceInputs();
  const legal = verifyLegalFiles(root);
  const rtc = JSON.parse(fs.readFileSync(path.join(cache, 'rtc', '.native-rtc-state.json'), 'utf8'));
  const obs = JSON.parse(fs.readFileSync(path.join(cache, 'obs-sources.json'), 'utf8'));
  assert.equal(rtc.completed, true);
  assert.equal(obs.schemaVersion, 1);
  const omitted = rtc.artifacts.filter(record => !keptArtifacts.has(record.directory.replaceAll('\\', '/')))
    .map(record => 'rtc/' + record.directory.replaceAll('\\', '/'));
  const members = [
    'rtc/webrtc', 'rtc/libmediasoupclient', 'rtc/libsdptransform', 'obs-studio', 'obs-deps', 'obs-sources.json',
    ...obs.sources.map(record => record.directory ?? record.archive),
  ];
  const entries = sourceEntries(cache, members, omitted);
  assert.ok(entries.includes('rtc/webrtc/src/.git/HEAD') && entries.includes('obs-studio/COPYING'));
  for (const source of obs.sources)
    if (source.archive) assert.ok(entries.includes(source.archive.replaceAll('\\', '/')));
  fs.mkdirSync(config.output, { recursive: true });
  const basename = `monky-native-sources-${config.version}`;
  const archive = path.join(config.output, `${basename}.tar.xz`);
  const manifest = path.join(config.output, `${basename}.json`);
  assert.ok(!fs.existsSync(archive) && !fs.existsSync(manifest), 'Source package already exists; refusing to overwrite it.');
  const temporary = fs.mkdtempSync(path.join(root, 'build', 'source-package-'));
  const partial = archive + '.' + crypto.randomUUID() + '.partial';
  try {
    const sourceCommit = execute('git', ['--no-pager', '-C', repository, 'rev-parse', 'HEAD'], { capture: true });
    const sourceTree = execute('git', ['--no-pager', '-C', repository, 'rev-parse', 'HEAD^{tree}'], { capture: true });
    const publicationReady = execute('git', ['--no-pager', '-C', repository, 'status', '--porcelain',
      '--untracked-files=normal'], { capture: true }) === '';
    const snapshot = {
      schemaVersion: 1, version: config.version, sourceCommit, sourceTree, publicationReady,
      monkySource: `https://github.com/MonkyOrg/Monky/tree/${sourceCommit}`,
      webrtcRevision: legal.webrtcRevision, obsRevision: legal.obsRevision, recipesRevision: obs.recipesRevision,
      repositories: rtc.repositories.map(({ directory, url, commit }) => ({ directory, url, commit })),
      libraries: obs.sources, omittedBuildTools: omitted,
      sourceFiles: entries.filter(entry => !entry.endsWith('/')).length,
      sourceDirectories: entries.filter(entry => entry.endsWith('/')).length,
    };
    write(path.join(temporary, 'SOURCE-MANIFEST.json'), JSON.stringify(snapshot, null, 2) + '\n');
    fs.copyFileSync(path.join(root, 'README.md'), path.join(temporary, 'SOURCE-README.md'));
    fs.copyFileSync(path.join(root, 'README.en.md'), path.join(temporary, 'SOURCE-README.en.md'));
    fs.cpSync(path.join(root, 'src', 'rtc', 'inputs', 'sdk'),
      path.join(temporary, 'SOURCE-PATCHES', 'webrtc'), { recursive: true });
    fs.copyFileSync(path.join(root, 'src', 'rtc', 'level6-upstream.json'),
      path.join(temporary, 'SOURCE-PATCHES', 'level6-upstream.json'));
    fs.copyFileSync(path.join(repository, 'patches', 'h264-profile-level-id+2.3.3.patch'),
      path.join(temporary, 'SOURCE-PATCHES', 'h264-profile-level-id+2.3.3.patch'));
    const list = path.join(temporary, 'members.txt');
    write(list, entries.join('\n') + '\n');
    console.log(`Archiving ${snapshot.sourceFiles} native source files and ${snapshot.sourceDirectories} directories; generated builds, caches and unused tools are excluded.`);
    const python = process.env.PYTHON ?? path.join(cache, 'python', 'Scripts', 'python.exe');
    assert.ok(path.isAbsolute(python) && fs.existsSync(python), 'Source packaging requires the prepared Python interpreter.');
    execute(python, ['-I', path.join(__dirname, 'sourceArchive.py'), `--root=${cache}`,
      `--list=${list}`, `--metadata=${temporary}`, `--output=${partial}`]);
    const bytes = fs.statSync(partial).size;
    assert.ok(bytes > 1_000_000 && bytes < 2_000_000_000, 'Source archive is empty or exceeds the release asset size limit.');
    const sha256 = await fileHash(partial);
    fs.renameSync(partial, archive);
    write(manifest, JSON.stringify({ ...snapshot, archive: { name: path.basename(archive), bytes, sha256 } }, null, 2) + '\n');
    console.log(JSON.stringify({ nativeSourcesPackaged: true, publicationReady, archive, bytes, sha256 }));
    return { archive, manifest };
  } finally {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function rebindSources(config, sourceRoot = repository, platform = 'win32') {
  assert.ok(['win32', 'darwin'].includes(platform));
  const basename = `monky-native-${platform === 'darwin' ? 'macos-' : ''}sources`;
  const input = path.join(sourceRoot, 'release', `${basename}-0.0.0-ci`);
  const previous = JSON.parse(fs.readFileSync(`${input}.json`, 'utf8'));
  const sourceCommit = execute('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { capture: true });
  const sourceTree = execute('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'], { capture: true });
  assert.equal(previous.schemaVersion, 1);
  assert.equal(previous.version, '0.0.0-ci');
  if (platform === 'darwin') {
    assert.equal(previous.platform, 'darwin');
    assert.deepEqual(previous.architectures, ['arm64', 'x64']);
  }
  assert.equal(previous.publicationReady, true, 'CI sources were not publication-ready.');
  assert.match(previous.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(previous.sourceTree, sourceTree, 'Cannot rebind sources from a different source tree.');
  assert.equal(execute('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=normal'], { capture: true }), '',
    'Source rebinding requires the clean merged checkout.');
  assert.equal(await fileHash(`${input}.tar.xz`), previous.archive.sha256, 'CI source archive checksum mismatch.');
  const { archive: oldArchive, ...snapshot } = previous;
  const metadata = { ...snapshot, schemaVersion: 2, version: config.version, sourceCommit, sourceTree,
    builtFromCommit: previous.sourceCommit, monkySource: `https://github.com/MonkyOrg/Monky/tree/${sourceCommit}`,
    archiveManifest: snapshot };
  const archive = path.join(config.output, `${basename}-${config.version}.tar.xz`);
  const manifest = path.join(config.output, `${basename}-${config.version}.json`);
  assert.ok(!fs.existsSync(archive) && !fs.existsSync(manifest), 'Source package already exists.');
  fs.mkdirSync(config.output, { recursive: true });
  const partial = archive + '.' + crypto.randomUUID() + '.partial';
  try {
    execute(process.env.PYTHON ?? 'python', [path.join(__dirname, 'sourceArchive.py'), 'verify',
      `${input}.tar.xz`, `${input}.json`]);
    // The full source tree is identical; only the external release binding changes.
    fs.copyFileSync(`${input}.tar.xz`, partial, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    const bytes = fs.statSync(partial).size;
    assert.ok(bytes > 1_000_000 && bytes < 2_000_000_000, 'Invalid rebound source archive size.');
    assert.equal(bytes, oldArchive.bytes, 'CI source archive size mismatch.');
    const sha256 = await fileHash(partial);
    assert.equal(sha256, oldArchive.sha256, 'Reused source archive checksum mismatch.');
    fs.renameSync(partial, archive);
    write(manifest, JSON.stringify({ ...metadata, archive: { name: path.basename(archive), bytes, sha256 } }, null, 2) + '\n');
    fs.unlinkSync(`${input}.tar.xz`);
    fs.unlinkSync(`${input}.json`);
    console.log(`Reused verified CI corresponding sources for ${config.version}, commit ${sourceCommit}; no recompilation or recompression.`);
    return { archive, manifest };
  } finally {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
  }
}

module.exports = { archiveEntryAllowed, sourceEntries, options, packSources, rebindSources, fileHash };
if (require.main === module) {
  const args = process.argv.slice(2);
  const fromCi = args[0] === '--from-ci';
  (fromCi ? rebindSources : packSources)(options(fromCi ? args.slice(1) : args))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
