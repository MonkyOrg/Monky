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

function archiveEntryAllowed(relative, omitted = []) {
  const normalized = relative.replaceAll('\\', '/');
  assert.ok(normalized && !normalized.startsWith('/') && !normalized.includes(':') &&
    !/[\0\r\n]/u.test(normalized) && !normalized.split('/').includes('..'), 'Unsafe source archive path.');
  if (omitted.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'))) return false;
  const components = normalized.split('/');
  if (components.includes('.git')) {
    if (!normalized.startsWith(sdkGit + '/') && normalized !== sdkGit) return false;
    const suffix = normalized.slice(sdkGit.length + 1);
    if (/^(?:hooks|logs)(?:\/|$)/u.test(suffix) || /^(?:FETCH_HEAD|ORIG_HEAD)$/u.test(suffix)) return false;
  }
  if (components.some(part => ['out', '.cipd', '__pycache__', 'node_modules'].includes(part))) return false;
  return true;
}

function sourceEntries(directory, members, omitted) {
  const entries = [];
  function visit(relative) {
    if (!archiveEntryAllowed(relative, omitted)) return;
    const filename = path.join(directory, relative);
    const stat = fs.lstatSync(filename);
    assert.ok(!stat.isSymbolicLink(), `Unexpected source alias: ${relative}`);
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
    else throw new Error(`Unknown source package option: ${key}`);
  }
  assert.match(result.version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu, 'Invalid source package version.');
  return result;
}

async function packSources(config) {
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
    const publicationReady = execute('git', ['--no-pager', '-C', repository, 'status', '--porcelain',
      '--untracked-files=normal'], { capture: true }) === '';
    const snapshot = {
      schemaVersion: 1, version: config.version, sourceCommit, publicationReady,
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

module.exports = { archiveEntryAllowed, sourceEntries, options, packSources, fileHash };
if (require.main === module) packSources(options(process.argv.slice(2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
