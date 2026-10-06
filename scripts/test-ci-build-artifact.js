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
const nativeLegalFiles = ['LICENSE', 'THIRD_PARTY_NOTICES']
  .map(name => `apps/client/native/screen-share/${name}`);

async function fixture(t, variant = 'cli', runAttempt = 1) {
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
    const filename = /\.(json|tar\.xz)$/.test(relative) || nativeLegalFiles.includes(relative)
      ? path.join(root, relative) : path.join(root, relative, 'index.js');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `module.exports = ${JSON.stringify(relative)};\n`);
  }
  const environment = { ...context, runAttempt, platform: { cli: 'linux', win: 'win32', mac: 'darwin' }[variant] };
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

test('desktop artifacts include all client outputs and their native binaries, notices and matching sources', async t => {
  for (const variant of ['win', 'mac']) {
    const f = await fixture(t, variant);
    await validateBuild(f.staged, f.root, variant, f.environment);
    const paths = f.manifest.files.map(entry => entry.path);
    assert.ok(paths.some(name => name.startsWith('apps/client/dist/')));
    assert.ok(paths.some(name => name.startsWith('apps/client/dist-electron/')));
    assert.ok(paths.every(name => !name.includes('node_modules') && !name.includes('/data/')));
    for (const arch of variant === 'mac' ? ['darwin-arm64', 'darwin-x64'] : ['win32-x64'])
      assert.ok(paths.some(name => name.startsWith(`apps/client/native/screen-share/bin/${arch}/`)));
    assert.ok(paths.some(name => name.startsWith('apps/client/native/screen-share/licenses/')));
    for (const relative of nativeLegalFiles) assert.ok(paths.includes(relative), `Missing native legal file: ${relative}`);
    const source = `release/monky-native-${variant === 'mac' ? 'macos-' : ''}sources-0.0.0-ci`;
    assert.ok(paths.includes(`${source}.tar.xz`));
    assert.ok(paths.includes(`${source}.json`));
    const filename = path.join(f.staged, 'build-manifest.json');
    await fs.writeFile(filename, JSON.stringify({ ...f.manifest,
      files: f.manifest.files.filter(entry => !entry.path.startsWith('apps/client/native/screen-share/licenses/')) }));
    await assert.rejects(validateBuild(f.staged, f.root, variant, f.environment), /Missing build output/);
  }
});

test('Windows export and validation require every generated root notice, not only the third-party license directory', async t => {
  const f = await fixture(t, 'win');
  const manifestFile = path.join(f.staged, 'build-manifest.json');
  for (const relative of nativeLegalFiles) {
    const filename = path.join(f.root, relative), bytes = await fs.readFile(filename);
    await fs.unlink(filename);
    await assert.rejects(collectBuild(f.root, path.join(f.directory, `missing-${path.basename(relative)}`),
      'win', f.environment), { code: 'ENOENT' });
    await fs.writeFile(filename, bytes);
    await fs.writeFile(manifestFile, JSON.stringify({ ...f.manifest,
      files: f.manifest.files.filter(entry => entry.path !== relative) }));
    await assert.rejects(validateBuild(f.staged, f.root, 'win', f.environment), /Missing build output/);
  }
  await fs.writeFile(manifestFile, JSON.stringify(f.manifest));
  const file = path.join(f.staged, nativeLegalFiles[0]), bytes = await fs.readFile(file);
  await fs.writeFile(file, Buffer.alloc(bytes.length, 1));
  await assert.rejects(validateBuild(f.staged, f.root, 'win', f.environment), /checksum mismatch/);
});

test('Vite emits portable extensionless license assets that survive desktop artifact export and ZIP extraction', async t => {
  const { build, loadConfigFromFile } = await import('vite');
  const f = await fixture(t, 'mac');
  const renderer = path.join(f.directory, 'renderer');
  await fs.mkdir(renderer);
  for (const name of ['LICENSE', 'RVM-LICENSE', 'model.json']) {
    await fs.writeFile(path.join(renderer, name), JSON.stringify({ name }));
  }
  await fs.writeFile(path.join(renderer, 'entry.js'),
    "import license from './LICENSE?url'; import rvm from './RVM-LICENSE?url'; import model from './model.json?url'; console.log(license, rvm, model);");
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' },
    path.join(scripts, '..', 'apps', 'client', 'vite.config.ts'));
  assert.ok(loaded);
  const result = await build({
    ...loaded.config, configFile: false, root: renderer, logLevel: 'silent',
    build: { ...loaded.config.build, outDir: path.join(f.root, 'apps', 'client', 'dist'), assetsInlineLimit: 0,
      rollupOptions: { ...loaded.config.build.rollupOptions, input: path.join(renderer, 'entry.js') } },
  });
  assert.ok(!Array.isArray(result) && 'output' in result);
  const names = result.output.map(entry => entry.fileName);
  for (const name of names) safePath(name);
  assert.ok(names.some(name => /^assets\/LICENSE-[\w-]+$/.test(name)));
  assert.ok(names.some(name => /^assets\/RVM-LICENSE-[\w-]+$/.test(name)));
  assert.ok(names.some(name => /^assets\/model-[\w-]+\.json$/.test(name)));
  const bundle = result.output.find(entry => entry.type === 'chunk' && entry.isEntry);
  assert.ok(bundle);
  for (const asset of result.output.filter(entry => entry.type === 'asset')) {
    const relative = path.posix.relative(path.posix.dirname(bundle.fileName), asset.fileName);
    assert.ok(bundle.code.includes(relative), `Missing bundled asset reference: ${asset.fileName}`);
  }
  const staged = path.join(f.directory, 'portable-desktop');
  await collectBuild(f.root, staged, 'mac', f.environment);
  const zip = path.join(f.directory, 'desktop.zip'), extracted = path.join(f.directory, 'extracted');
  executePython('-c', 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for p in root.rglob("*"):\n  if p.is_file(): z.write(p,p.relative_to(root).as_posix())',
    staged, zip);
  executePython(path.join(scripts, 'ci-build-archive.py'), zip, extracted);
  await validateBuild(extracted, f.root, 'mac', f.environment);
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

test('desktop artifacts record the exact native cache key CI tested so the release can seed main caches', async t => {
  const key = `native-win-v1-${'a'.repeat(16)}-${'b'.repeat(64)}`;
  const f = await fixture(t, 'win');
  assert.equal(f.manifest.nativeCacheKey, undefined, 'Builds without a native cache keep the original manifest.');
  const staged = path.join(f.directory, 'keyed');
  const manifest = await collectBuild(f.root, staged, 'win', { ...f.environment, nativeCacheKey: key });
  assert.equal(manifest.nativeCacheKey, key);
  assert.equal((await validateBuild(staged, f.root, 'win', f.environment)).nativeCacheKey, key);
  for (const [variant, environment, invalid] of [
    ['win', f.environment, `native-mac-v1-${'a'.repeat(16)}-${'b'.repeat(64)}`],
    ['win', f.environment, 'native-win-v1-short'],
    ['win', f.environment, `${key}\nrestore-keys: native-`],
    ['cli', context, key],
  ]) {
    await assert.rejects(collectBuild(f.root, path.join(f.directory, `rejected-${variant}`), variant,
      { ...environment, nativeCacheKey: invalid }), /Invalid native cache key/);
  }
  await fs.writeFile(path.join(staged, 'build-manifest.json'), JSON.stringify({ ...manifest, nativeCacheKey: 'native-win-v1-x' }));
  await assert.rejects(validateBuild(staged, f.root, 'win', f.environment), /Invalid native cache key/);
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

test('selection reuses the highest available attempt per variant after a partial re-run', async () => {
  const digest = `sha256:${'c'.repeat(64)}`;
  const selected = await selectBuild(apiFixture({
    selectedRun: { ...run, run_attempt: 2 },
    artifacts: [
      { id: 200, name: 'ci-build-cli-1', expired: false, digest },
      { id: 201, name: 'ci-build-win-1', expired: false, digest },
      { id: 202, name: 'ci-build-mac-1', expired: false, digest },
      { id: 203, name: 'ci-build-mac-2', expired: false, digest },
    ],
  }), repository, commit);
  assert.deepEqual(selected, { reuse: true, runId: 42, runAttempt: 2, artifacts: { cli: 200, mac: 203, win: 201 } });
});

test('selection ignores invalid, future and expired attempts instead of trusting their names', async () => {
  const digest = `sha256:${'c'.repeat(64)}`;
  for (const suffix of ['0', '01', '-1', '3', '1junk', '9007199254740992']) {
    const selected = await selectBuild(apiFixture({
      selectedRun: { ...run, run_attempt: 2 },
      artifacts: [
        { id: 100, name: `ci-build-cli-${suffix}`, expired: false, digest },
        { id: 101, name: 'ci-build-mac-2', expired: false, digest },
        { id: 102, name: 'ci-build-win-2', expired: false, digest },
        { id: 103, name: 'ci-build-cli-2', expired: true, digest },
      ],
    }), repository, commit);
    assert.equal(selected.reuse, false, suffix);
    assert.match(selected.reason, /absent or expired/);
  }
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

test('GitHub archive download rejects cross-run, invalid attempts, failed CI and corrupted immutable bytes', async t => {
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
    [run, { ...artifact, workflow_run: { id: 42, head_sha: commit } }, bytes, /strictly equal/],
    ...['ci-build-cli-0', 'ci-build-cli-01', 'ci-build-cli-2', 'ci-build-cli-1junk',
      'ci-build-cli-9007199254740992', 'ci-build-win-1'].map(name =>
      [run, { ...artifact, name }, bytes, /artifact name or attempt/]),
    [run, { ...artifact, expired: true }, bytes, /expired/],
    [run, artifact, Buffer.from('changed'), /digest mismatch/],
  ]) {
    const destination = path.join(f.directory, `archive-${Math.random()}.zip`);
    await assert.rejects(downloadBuild(api(selectedRun, selectedArtifact, body), 100, 42, 'cli', destination), error);
  }
  for (const runAttempt of [1, 2]) {
    const selectedRun = { ...run, run_attempt: runAttempt };
    const downloaded = await downloadBuild(api(selectedRun, artifact), 100, 42, 'cli',
      path.join(f.directory, `good-${runAttempt}.zip`));
    assert.deepEqual(downloaded, { run: selectedRun, runAttempt: 1 });
  }
});

for (const variant of ['cli', 'mac', 'win']) for (const artifactAttempt of [1, 2]) test(
  `${variant}: selection restores attempt ${artifactAttempt} from successful run attempt 2 without compiling`, async t => {
  const f = await fixture(t, variant, artifactAttempt);
  const expected = new Map(await Promise.all(f.manifest.files.map(async entry =>
    [entry.path, await fs.readFile(path.join(f.root, entry.path))])));
  const zip = path.join(f.directory, 'build.zip');
  // The release must restore the macOS capture host with its execute bit, as CI archived it.
  const executable = variant === 'mac' ? 'apps/client/native/screen-share/bin/darwin-arm64/index.js' : null;
  if (executable) await fs.chmod(path.join(f.staged, executable), 0o755);
  executePython('-c', 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for p in root.rglob("*"):\n  if p.is_file(): z.write(p,p.relative_to(root).as_posix())',
    f.staged, zip);
  const bytes = await fs.readFile(zip), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  for (const relative of roots[variant]) {
    await fs.rm(path.join(f.root, relative), { recursive: true });
    await assert.rejects(fs.stat(path.join(f.root, relative)), { code: 'ENOENT' });
  }
  const selectedRun = { ...run, run_attempt: 2, head_sha: f.manifest.sourceCommit };
  const artifacts = Object.keys(roots).map((name, index) => ({
    id: 100 + index, name: `ci-build-${name}-${name === variant ? artifactAttempt : 2}`, expired: false, digest,
    workflow_run: { id: 42, head_sha: selectedRun.head_sha },
  }));
  const artifact = artifacts[Object.keys(roots).indexOf(variant)];
  const api = async endpoint => {
    if (endpoint.startsWith('commits/')) return [{
      merged_at: '2026-09-28T00:00:00Z', merge_commit_sha: commit,
      base: { ref: 'main', repo: { full_name: repository } }, head: { sha: selectedRun.head_sha },
    }];
    if (endpoint.startsWith('actions/workflows/')) return { workflow_runs: [selectedRun] };
    if (endpoint === 'actions/runs/42/artifacts?per_page=100') return { artifacts };
    if (endpoint === 'actions/runs/42') return selectedRun;
    if (endpoint === `actions/artifacts/${artifact.id}`) return artifact;
    if (endpoint.endsWith('/zip')) return new Response(bytes);
    if (endpoint.startsWith('git/commits/')) return {
      sha: selectedRun.head_sha, tree: { sha: f.manifest.sourceTree }, parents: [],
    };
    throw new Error(endpoint);
  };
  const selected = await selectBuild(api, repository, commit);
  assert.equal(selected.reuse, true);
  assert.equal(selected.artifacts[variant], artifact.id);
  const restore = () => restoreBuild(f.root, variant, selected.runId, selected.artifacts[variant],
    { api, context: f.environment, tempParent: f.directory });
  artifact.name = `ci-build-${variant}-${artifactAttempt === 1 ? 2 : 1}`;
  await assert.rejects(restore(), /Build runAttempt does not match/);
  for (const relative of roots[variant]) {
    await assert.rejects(fs.stat(path.join(f.root, relative)), { code: 'ENOENT' });
  }
  artifact.name = `ci-build-${variant}-${artifactAttempt}`;
  const restored = await restore();
  assert.equal(restored.runAttempt, artifactAttempt);
  for (const [relative, bytes] of expected) assert.deepEqual(await fs.readFile(path.join(f.root, relative)), bytes, relative);
  if (executable && process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(f.root, executable))).mode & 0o777, 0o755,
      'A restored macOS runtime must stay executable before it can seed the shared native cache.');
  }
  if (variant === 'win' || variant === 'mac') {
    for (const relative of nativeLegalFiles) {
      assert.ok(expected.has(relative));
      assert.ok((await fs.stat(path.join(f.root, relative))).isFile(), relative);
    }
  }
  await assert.rejects(restore(), /overlay existing/);
});

test('ZIP extraction restores archived Unix modes without granting group write or setuid', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-ci-zip-modes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const zip = path.join(directory, 'modes.zip'), output = path.join(directory, 'out');
  // GitHub artifact ZIPs are written by a Unix host (create_system 3) and keep st_mode in external_attr.
  const entries = { 'bin/monky-screen-mac': 0o100755, 'bin/lib.dylib': 0o100644, 'bin/open': 0o100777,
    'bin/setuid': 0o104755, 'bin/owner-read-only': 0o100400, 'bin/dos': null };
  executePython('-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name,mode in json.loads(sys.argv[2]).items():\n  info=zipfile.ZipInfo(name)\n  if mode is None: info.create_system=0; info.external_attr=0o100755<<16\n  else: info.create_system=3; info.external_attr=mode<<16\n  z.writestr(info,"payload")',
    zip, JSON.stringify(entries));
  const recorded = JSON.parse(executePython('-c', 'import importlib.util,json,os,sys\nspec=importlib.util.spec_from_file_location("archive",sys.argv[1])\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\ncalls={}\nreal=os.chmod\ndef chmod(name,mode):\n calls[os.path.relpath(name,sys.argv[3]).replace(os.sep,"/")]=oct(mode)\n real(name,mode)\nmodule.os.chmod=chmod\nmodule.extract_build(sys.argv[2],sys.argv[3])\nprint(json.dumps(calls))',
    path.join(scripts, 'ci-build-archive.py'), zip, output));
  assert.deepEqual(recorded, { 'bin/monky-screen-mac': '0o755', 'bin/lib.dylib': '0o644', 'bin/open': '0o755',
    'bin/setuid': '0o755', 'bin/owner-read-only': '0o600' }, 'Only Unix-hosted entries change mode, capped at 0755.');
  if (process.platform !== 'win32') {
    for (const [name, mode] of Object.entries(recorded))
      assert.equal((await fs.stat(path.join(output, name))).mode & 0o7777, Number(mode), name);
  }
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

async function sourceFixture(t, platform = 'win32') {
  const f = await fixture(t);
  const output = path.join(f.root, 'release');
  await fs.mkdir(output);
  const input = path.join(output, `monky-native-${platform === 'darwin' ? 'macos-' : ''}sources-0.0.0-ci`);
  const metadata = { schemaVersion: 1, version: '0.0.0-ci', sourceCommit: f.manifest.sourceCommit,
    sourceTree: f.manifest.sourceTree, publicationReady: true, monkySource: `https://github.com/${repository}/tree/${f.manifest.sourceCommit}`,
    webrtcRevision: '36ea4535a500ac137dbf1f577ce40dc1aaa774ef', obsRevision: '7272af1375b38bc3cf4e0f98a5d999e8b76e9309',
    sourceFiles: 1001, repositories: Array.from({ length: 40 }, () => ({})), libraries: Array.from({ length: 24 }, () => ({})) };
  if (platform === 'darwin') {
    const pins = JSON.parse(await fs.readFile(path.join(scripts, '..', 'apps', 'client', 'native',
      'screen-share', 'scripts', 'native-rtc', 'pins.json'), 'utf8'));
    Object.assign(metadata, { platform, architectures: ['arm64', 'x64'], repositories: pins.repositories });
    delete metadata.obsRevision;
    delete metadata.libraries;
  }
  const snapshot = path.join(f.directory, 'source.json');
  await fs.writeFile(snapshot, JSON.stringify(metadata));
  executePython('-c', 'import io,os,sys,tarfile\nwith tarfile.open(sys.argv[1],"w:xz") as tar:\n for name,data in [("webrtc/source.cpp",os.urandom(1000100)),("SOURCE-MANIFEST.json",open(sys.argv[2],"rb").read())]:\n  entry=tarfile.TarInfo(name);entry.size=len(data);tar.addfile(entry,io.BytesIO(data))\n if sys.argv[3]=="darwin":\n  link=tarfile.TarInfo("webrtc/alias.cpp");link.type=tarfile.SYMTYPE;link.linkname="source.cpp";tar.addfile(link)',
    `${input}.tar.xz`, snapshot, platform);
  metadata.archive = { name: path.basename(`${input}.tar.xz`),
    bytes: (await fs.stat(`${input}.tar.xz`)).size, sha256: await hashFile(`${input}.tar.xz`) };
  await fs.writeFile(`${input}.json`, JSON.stringify(metadata));
  return { ...f, output, input, metadata };
}

test('native source reuse binds squash/version externally and preserves every compressed byte without Python compression', async t => {
  const f = await sourceFixture(t);
  assert.equal((await checkNativeSourceRelease(f.output, '0.0.0-ci', f.metadata.sourceCommit)).schemaVersion, 1);
  const sourceHash = executePython('-c', 'import hashlib,sys,tarfile\nwith tarfile.open(sys.argv[1]) as tar: print(hashlib.sha256(tar.extractfile("webrtc/source.cpp").read()).hexdigest())',
    `${f.input}.tar.xz`).trim();
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'Integrated source');
  const version = '9.0.0-beta';
  const result = await rebindSources({ output: f.output, version }, f.root);
  const metadata = await checkNativeSourceRelease(f.output, version, f.git('rev-parse', 'HEAD'));
  assert.equal(metadata.builtFromCommit, f.metadata.sourceCommit);
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.archive.bytes, f.metadata.archive.bytes);
  assert.equal(metadata.archive.sha256, f.metadata.archive.sha256);
  assert.equal(await hashFile(result.archive), f.metadata.archive.sha256);
  const contents = JSON.parse(executePython('-c',
    'import hashlib,json,sys,tarfile\nwith tarfile.open(sys.argv[1]) as tar: print(json.dumps({"source":hashlib.sha256(tar.extractfile("webrtc/source.cpp").read()).hexdigest(),"manifest":json.load(tar.extractfile("SOURCE-MANIFEST.json"))}))',
    result.archive));
  const { archive, ...snapshot } = f.metadata;
  assert.equal(contents.source, sourceHash);
  assert.deepEqual(contents.manifest, snapshot);
  assert.deepEqual(metadata.archiveManifest, snapshot);
  for (const change of [
    { builtFromCommit: 'c'.repeat(40) }, { sourceTree: 'd'.repeat(40) },
    { archiveManifest: { ...snapshot, version } }, { archiveManifest: { ...snapshot, publicationReady: false } },
  ]) {
    await fs.writeFile(result.manifest, JSON.stringify({ ...metadata, ...change }));
    await assert.rejects(checkNativeSourceRelease(f.output, version, f.git('rev-parse', 'HEAD')), /provenance/);
  }
  await fs.writeFile(result.manifest, JSON.stringify(metadata));
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

test('macOS source reuse retains SDK links and both architectures while rebinding the approved source tree', async t => {
  const f = await sourceFixture(t, 'darwin');
  assert.equal((await checkNativeSourceRelease(f.output, '0.0.0-ci', f.metadata.sourceCommit, 'darwin')).schemaVersion, 1);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'Integrated macOS source');
  const version = '9.0.0-beta';
  const result = await rebindSources({ output: f.output, version }, f.root, 'darwin');
  const metadata = await checkNativeSourceRelease(f.output, version, f.git('rev-parse', 'HEAD'), 'darwin');
  assert.equal(metadata.builtFromCommit, f.metadata.sourceCommit);
  assert.equal(await hashFile(result.archive), f.metadata.archive.sha256);
  const contents = JSON.parse(executePython('-c',
    'import json,sys,tarfile\nwith tarfile.open(sys.argv[1]) as tar:\n link=tar.getmember("webrtc/alias.cpp")\n print(json.dumps({"link":link.linkname,"isLink":link.issym(),"manifest":json.load(tar.extractfile("SOURCE-MANIFEST.json"))}))',
    result.archive));
  assert.equal(contents.isLink, true);
  assert.equal(contents.link, 'source.cpp');
  const { archive, ...snapshot } = f.metadata;
  assert.deepEqual(contents.manifest, snapshot);
  assert.deepEqual(metadata.archiveManifest, snapshot);
});
