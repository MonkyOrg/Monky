import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectBuild, validateBuild, selectBuild, downloadBuild, restoreBuild, safePath, roots, hashFile } from './ci-build-artifact.js';
import { rebindSources } from '../apps/client/native/screen-share/scripts/packSources.cjs';
import { checkNativeSourceRelease } from './check-native-source-release.js';

const repository = 'MonkyOrg/Monky';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const context = { platform: 'linux', arch: 'x64', nodeMajor: '22', image: 'ubuntu24',
  repository, runId: 42, runAttempt: 1 };
const commit = 'a'.repeat(40), head = 'b'.repeat(40);
const run = { id: 42, run_attempt: 1, event: 'pull_request', path: '.github/workflows/ci.yml',
  status: 'completed', conclusion: 'success', repository: { full_name: repository }, head_sha: head };
const python = process.env.PYTHON ?? 'python';
const executePython = (...args) => execFileSync(python, ['-I', ...args], { encoding: 'utf8' });

async function fixture(t, variant = 'cli') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-ci-artifact-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo'), staged = path.join(directory, 'staged');
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.copyFile(path.join(scripts, 'ci-build-archive.py'), path.join(root, 'scripts', 'ci-build-archive.py'));
  await fs.writeFile(path.join(root, '.gitignore'), Object.values(roots).flat().join('\n') + '\n');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('-c', 'init.templateDir=', 'init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Fixture source');
  for (const relative of roots[variant]) {
    const filename = /\.(json|tar\.xz)$/.test(relative) ? path.join(root, relative) : path.join(root, relative, 'index.js');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `module.exports = ${JSON.stringify(relative)};\n`);
  }
  const environment = { ...context, platform: { cli: 'linux', win: 'win32', mac: 'darwin' }[variant] };
  const manifest = await collectBuild(root, staged, variant, environment);
  return { directory, root, staged, manifest, git, environment };
}

function apiFixture({ selectedRun = run, artifacts, pr = true } = {}) {
  return async endpoint => {
    if (endpoint.startsWith('commits/')) return pr ? [{
      merged_at: '2026-09-28T00:00:00Z', merge_commit_sha: commit,
      base: { ref: 'main', repo: { full_name: repository } }, head: { sha: head },
    }] : [];
    if (endpoint.startsWith('actions/workflows/')) return { workflow_runs: selectedRun ? [selectedRun] : [] };
    if (endpoint === 'actions/runs/42/artifacts?per_page=100') return { artifacts: artifacts ?? Object.keys(roots).map((variant, index) => ({
      id: 100 + index, name: `ci-build-${variant}-1`, expired: false, digest: `sha256:${'c'.repeat(64)}`,
    })) };
    throw new Error(`Unexpected API endpoint ${endpoint}`);
  };
}

test('CI build export and validation accept squash commits only when the full source tree is identical', async t => {
  const f = await fixture(t);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'Squashed equivalent source');
  assert.notEqual(f.git('rev-parse', 'HEAD'), f.manifest.sourceCommit);
  assert.equal((await validateBuild(f.staged, f.root, 'cli', context)).sourceTree, f.manifest.sourceTree);
  await fs.writeFile(path.join(f.root, 'other.txt'), 'Another PR\n');
  f.git('add', 'other.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Different integrated tree');
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /integrated source tree/);
});

test('desktop artifacts include all client outputs and Windows native binaries, notices and matching sources', async t => {
  for (const variant of ['win', 'mac']) {
    const f = await fixture(t, variant);
    await validateBuild(f.staged, f.root, variant, f.environment);
    const paths = f.manifest.files.map(entry => entry.path);
    assert.ok(paths.some(name => name.startsWith('apps/client/dist/')));
    assert.ok(paths.some(name => name.startsWith('apps/client/dist-electron/')));
    assert.ok(paths.every(name => !name.includes('node_modules') && !name.includes('/data/')));
    if (variant === 'win') {
      assert.ok(paths.some(name => name.startsWith('apps/client/native/screen-share/bin/win32-x64/')));
      assert.ok(paths.some(name => name.startsWith('apps/client/native/screen-share/licenses/')));
      assert.ok(paths.includes('release/monky-native-sources-0.0.0-ci.tar.xz'));
      assert.ok(paths.includes('release/monky-native-sources-0.0.0-ci.json'));
      const filename = path.join(f.staged, 'build-manifest.json');
      await fs.writeFile(filename, JSON.stringify({ ...f.manifest,
        files: f.manifest.files.filter(entry => !entry.path.startsWith('apps/client/native/screen-share/licenses/')) }));
      await assert.rejects(validateBuild(f.staged, f.root, variant, f.environment), /Missing build output/);
    }
  }
});

test('build restoration rejects changed lockfiles, foreign runs, platforms, architectures and tool environments', async t => {
  const f = await fixture(t);
  for (const [key, value] of [['runId', 7], ['runAttempt', 2], ['repository', 'other/repo'], ['platform', 'win32'],
    ['arch', 'arm64'], ['nodeMajor', '24'], ['image', 'ubuntu26']]) {
    await assert.rejects(validateBuild(f.staged, f.root, 'cli', { ...context, [key]: value }), /does not match/);
  }
  await fs.writeFile(path.join(f.root, 'package-lock.json'), '{}');
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /Dependency lock changed/);
  await assert.rejects(collectBuild(f.root, path.join(f.directory, 'dirty'), 'cli', context), /clean source checkout/);
});

test('every file is inventoried and hashed before any release outputs can be restored', async t => {
  const f = await fixture(t);
  const file = path.join(f.staged, roots.cli[0], 'index.js');
  const original = await fs.readFile(file);
  await fs.writeFile(file, Buffer.alloc(original.length, 1));
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /checksum mismatch/);
  await fs.writeFile(file, original);
  await fs.writeFile(path.join(f.staged, 'unexpected.js'), 'not allowed');
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /unexpected files/);
  await fs.unlink(path.join(f.staged, 'unexpected.js'));
  await fs.unlink(file);
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /missing or unexpected/);
});

test('manifests cannot introduce arbitrary files, aliases or ambiguous Windows paths', async t => {
  const f = await fixture(t);
  for (const name of ['/outside', '../outside', 'a/../b', 'a\\b', 'C:/outside', 'file:stream',
    'CON', 'a/NUL.txt', 'a.', 'a ', 'a//b', 'a/./b', 'a\nb']) assert.throws(() => safePath(name));
  const file = path.join(f.staged, 'build-manifest.json');
  await fs.writeFile(file, JSON.stringify({ ...f.manifest,
    files: [...f.manifest.files, { path: '.github/workflows/release.yml', bytes: 0, sha256: 'a'.repeat(64) }] }));
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /outside reusable/);
  await fs.writeFile(file, JSON.stringify({ ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] }));
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /Duplicate artifact path/);
  await fs.writeFile(file, JSON.stringify(f.manifest));
  await fs.symlink(f.root, path.join(f.staged, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateBuild(f.staged, f.root, 'cli', context), /aliases are forbidden/);
});

test('selection uses the actual merged PR and all artifacts of the successful workflow attempt', async () => {
  const selected = await selectBuild(apiFixture(), repository, commit);
  assert.deepEqual(selected, { reuse: true, runId: 42, runAttempt: 1, artifacts: { cli: 100, mac: 101, win: 102 } });
  for (const selectedRun of [null, { ...run, conclusion: 'failure' }, { ...run, status: 'in_progress' },
    { ...run, event: 'push' }, { ...run, path: '.github/workflows/other.yml' },
    { ...run, head_sha: 'c'.repeat(40) }, { ...run, repository: { full_name: 'other/repo' } }]) {
    await assert.rejects(selectBuild(apiFixture({ selectedRun }), repository, commit), /no successful CI/);
  }
  await assert.rejects(selectBuild(apiFixture({ pr: false }), repository, commit), /merged main PR/);
});

test('only absent/expired legacy artifacts or legacy promotions select an explicit rebuild', async () => {
  for (const artifacts of [[], [{ id: 100, name: 'ci-build-cli-1', expired: true }],
    [{ id: 100, name: 'ci-build-cli-2', expired: false }]]) {
    const selected = await selectBuild(apiFixture({ artifacts }), repository, commit);
    assert.equal(selected.reuse, false);
    assert.match(selected.reason, /absent or expired/);
  }
  assert.equal((await selectBuild(apiFixture({ pr: false }), repository, commit, true)).reuse, false);
  assert.equal((await selectBuild(apiFixture({ selectedRun: null }), repository, commit, true)).reuse, false);
  await assert.rejects(selectBuild(apiFixture({ artifacts: [{ id: 100, name: 'ci-build-cli-1', expired: false, digest: '' }] }),
    repository, commit), /immutable artifact digest/);
  await assert.rejects(selectBuild(async () => { throw new Error('HTTP 403'); }, repository, commit), /HTTP 403/);
});

test('GitHub archive download rejects cross-run, rerun, failed CI and corrupted immutable bytes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('test zip bytes'), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const artifact = { name: 'ci-build-cli-1', expired: false, digest, workflow_run: { id: 42, head_sha: head } };
  const api = (selectedRun, selectedArtifact, body = bytes) => async endpoint => {
    if (endpoint === 'actions/runs/42') return selectedRun;
    if (endpoint === 'actions/artifacts/100') return selectedArtifact;
    if (endpoint === 'actions/artifacts/100/zip') return new Response(body);
    throw new Error(endpoint);
  };
  for (const [selectedRun, selectedArtifact, body, error] of [
    [{ ...run, conclusion: 'failure' }, artifact, bytes, /CI must still/],
    [run, { ...artifact, workflow_run: { id: 9, head_sha: head } }, bytes, /9 !== 42/],
    [{ ...run, run_attempt: 2 }, artifact, bytes, /ci-build-cli/],
    [run, { ...artifact, expired: true }, bytes, /expired/],
    [run, artifact, Buffer.from('changed'), /digest mismatch/],
  ]) {
    const destination = path.join(f.directory, `archive-${Math.random()}.zip`);
    await assert.rejects(downloadBuild(api(selectedRun, selectedArtifact, body), 100, 42, 'cli', destination), error);
  }
  await downloadBuild(api(run, artifact), 100, 42, 'cli', path.join(f.directory, 'good.zip'));
});

test('a real immutable ZIP is verified, safely extracted and restores all compiled outputs without compiling', async t => {
  const f = await fixture(t);
  const zip = path.join(f.directory, 'build.zip');
  executePython('-c', 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for p in root.rglob("*"):\n  if p.is_file(): z.write(p,p.relative_to(root).as_posix())',
    f.staged, zip);
  const bytes = await fs.readFile(zip), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  for (const relative of roots.cli) await fs.rm(path.join(f.root, relative), { recursive: true });
  const selectedRun = { ...run, head_sha: f.manifest.sourceCommit };
  const api = async endpoint => {
    if (endpoint === 'actions/runs/42') return selectedRun;
    if (endpoint === 'actions/artifacts/100') return { name: 'ci-build-cli-1', expired: false, digest,
      workflow_run: { id: 42, head_sha: selectedRun.head_sha } };
    if (endpoint.endsWith('/zip')) return new Response(bytes);
    if (endpoint.startsWith('git/commits/')) return {
      sha: selectedRun.head_sha, tree: { sha: f.manifest.sourceTree }, parents: [],
    };
    throw new Error(endpoint);
  };
  await restoreBuild(f.root, 'cli', 42, 100, { api, context, tempParent: f.directory });
  for (const relative of roots.cli) assert.equal(await fs.readFile(path.join(f.root, relative, 'index.js'), 'utf8'),
    `module.exports = ${JSON.stringify(relative)};\n`);
  await assert.rejects(restoreBuild(f.root, 'cli', 42, 100, { api, context, tempParent: f.directory }), /overlay existing/);
});

test('ZIP extraction refuses traversal, aliases, reserved devices and duplicate paths before extraction', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-ci-zip-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(scripts, 'ci-build-archive.py');
  for (const [index, names] of [
    ['../escaped'], ['/absolute'], ['a\\outside'], ['CON'], ['a/../b'], ['a', 'A'], ['link'],
  ].entries()) {
    const zip = path.join(directory, `${index}.zip`), output = path.join(directory, `out-${index}`);
    executePython('-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name in json.loads(sys.argv[2]):\n  info=zipfile.ZipInfo(name)\n  info.filename=name\n  if name=="link": info.external_attr=(0o120777<<16)\n  z.writestr(info,"payload")',
      zip, JSON.stringify(names));
    const result = spawnSync(python, ['-I', script, zip, output], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, JSON.stringify(names));
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  }
});

async function sourceFixture(t) {
  const f = await fixture(t);
  const output = path.join(f.root, 'release');
  await fs.mkdir(output);
  const input = path.join(output, 'monky-native-sources-0.0.0-ci');
  const metadata = { schemaVersion: 1, version: '0.0.0-ci', sourceCommit: f.manifest.sourceCommit,
    sourceTree: f.manifest.sourceTree, publicationReady: true, monkySource: `https://github.com/${repository}/tree/${f.manifest.sourceCommit}`,
    webrtcRevision: '36ea4535a500ac137dbf1f577ce40dc1aaa774ef', obsRevision: '7272af1375b38bc3cf4e0f98a5d999e8b76e9309',
    sourceFiles: 1001, repositories: Array.from({ length: 40 }, () => ({})), libraries: Array.from({ length: 24 }, () => ({})) };
  const snapshot = path.join(f.directory, 'source.json');
  await fs.writeFile(snapshot, JSON.stringify(metadata));
  executePython('-c', 'import io,os,sys,tarfile\nwith tarfile.open(sys.argv[1],"w:xz") as tar:\n for name,data in [("webrtc/source.cpp",os.urandom(1000100)),("SOURCE-MANIFEST.json",open(sys.argv[2],"rb").read())]:\n  entry=tarfile.TarInfo(name);entry.size=len(data);tar.addfile(entry,io.BytesIO(data))',
    `${input}.tar.xz`, snapshot);
  metadata.archive = { name: path.basename(`${input}.tar.xz`),
    bytes: (await fs.stat(`${input}.tar.xz`)).size, sha256: await hashFile(`${input}.tar.xz`) };
  await fs.writeFile(`${input}.json`, JSON.stringify(metadata));
  return { ...f, output, input, metadata };
}

test('native source reuse rewrites embedded provenance for squash/version while preserving every source byte', async t => {
  const f = await sourceFixture(t);
  const sourceHash = executePython('-c', 'import hashlib,sys,tarfile\nwith tarfile.open(sys.argv[1]) as tar: print(hashlib.sha256(tar.extractfile("webrtc/source.cpp").read()).hexdigest())',
    `${f.input}.tar.xz`).trim();
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'Integrated source');
  const version = '9.0.0-beta';
  const result = await rebindSources({ output: f.output, version }, f.root);
  const metadata = await checkNativeSourceRelease(f.output, version, f.git('rev-parse', 'HEAD'));
  assert.equal(metadata.builtFromCommit, f.metadata.sourceCommit);
  const contents = JSON.parse(executePython('-c',
    'import hashlib,json,sys,tarfile\nwith tarfile.open(sys.argv[1]) as tar: print(json.dumps({"source":hashlib.sha256(tar.extractfile("webrtc/source.cpp").read()).hexdigest(),"manifest":json.load(tar.extractfile("SOURCE-MANIFEST.json"))}))',
    result.archive));
  const { archive, ...snapshot } = metadata;
  assert.equal(contents.source, sourceHash);
  assert.deepEqual(contents.manifest, snapshot);
  await assert.rejects(fs.stat(`${f.input}.tar.xz`), { code: 'ENOENT' });
});

test('native source reuse rejects changed trees, archive corruption and mismatched embedded metadata', async t => {
  const f = await sourceFixture(t);
  const config = { output: f.output, version: '9.0.0-beta' };
  await fs.writeFile(`${f.input}.json`, JSON.stringify({ ...f.metadata, sourceTree: 'c'.repeat(40) }));
  await assert.rejects(rebindSources(config, f.root), /different source tree/);
  await fs.writeFile(`${f.input}.json`, JSON.stringify({ ...f.metadata, archive: { ...f.metadata.archive, sha256: '0'.repeat(64) } }));
  await assert.rejects(rebindSources(config, f.root), /checksum mismatch/);
  await fs.writeFile(`${f.input}.json`, JSON.stringify({ ...f.metadata, monkySource: 'mismatched-source' }));
  await assert.rejects(rebindSources(config, f.root), /exited/);
  await assert.rejects(fs.stat(path.join(f.output, 'monky-native-sources-9.0.0-beta.tar.xz')), { code: 'ENOENT' });
});
