import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const sourcePackage = 'release/monky-native-sources-0.0.0-ci';
const commonRoots = ['packages/shared/dist', 'packages/bot-sdk/dist', 'apps/server/dist'];
export const roots = {
  cli: commonRoots,
  mac: [...commonRoots, 'apps/client/dist', 'apps/client/dist-electron'],
  win: [...commonRoots, 'apps/client/dist', 'apps/client/dist-electron',
    'apps/client/native/screen-share/bin/win32-x64', 'apps/client/native/screen-share/licenses',
    `${sourcePackage}.json`, `${sourcePackage}.tar.xz`],
};
const platforms = { cli: 'linux', mac: 'darwin', win: 'win32' };
const sha = value => /^[a-f0-9]{40}$/.test(value);
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function safePath(relative) {
  assert.equal(typeof relative, 'string');
  assert.ok(relative.length > 0 && !/[\\:\x00-\x1f]/.test(relative), `Unsafe artifact path: ${JSON.stringify(relative)}`);
  assert.ok(relative.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
  `Unsafe artifact path: ${JSON.stringify(relative)}`);
  return relative;
}

async function inventory(root, relative = '') {
  const filename = path.join(root, ...relative.split('/'));
  const stat = await fs.lstat(filename);
  assert.ok(!stat.isSymbolicLink(), `Artifact aliases are forbidden: ${relative}`);
  if (stat.isFile()) return [safePath(relative)];
  assert.ok(stat.isDirectory(), `Unexpected artifact entry: ${relative}`);
  const result = [];
  for (const name of (await fs.readdir(filename)).sort()) {
    result.push(...await inventory(root, relative ? `${relative}/${name}` : name));
  }
  return result;
}

export function buildEnvironment(env = process.env) {
  return { platform: process.platform, arch: process.arch, nodeMajor: process.versions.node.split('.')[0],
    image: env.ImageOS ?? '', repository: env.GITHUB_REPOSITORY, runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

export async function collectBuild(root, destination, variant, context = buildEnvironment()) {
  assert.ok(Object.hasOwn(roots, variant), 'Unknown build variant.');
  assert.equal(context.platform, platforms[variant]);
  assert.ok(context.repository && positiveId(context.runId) && positiveId(context.runAttempt), 'Missing CI identity.');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=normal'), '', 'Build export requires a clean source checkout.');
  const files = [];
  for (const directory of roots[variant]) {
    const entries = await inventory(root, directory);
    assert.ok(entries.length, `Empty build output: ${directory}`);
    for (const relative of entries) {
      const from = path.join(root, ...relative.split('/'));
      const to = path.join(destination, ...relative.split('/'));
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
      files.push({ path: relative, bytes: (await fs.stat(to)).size, sha256: await hashFile(to) });
    }
  }
  const manifest = { schemaVersion: 1, variant, ...context,
    sourceCommit: git(root, 'rev-parse', 'HEAD'), sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
    lockHash: await hashFile(path.join(root, 'package-lock.json')), files };
  await fs.writeFile(path.join(destination, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function validateBuild(directory, root, variant, expected) {
  assert.ok(Object.hasOwn(roots, variant), 'Unknown build variant.');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'build-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported build artifact schema.');
  assert.equal(manifest.variant, variant);
  for (const key of ['repository', 'runId', 'runAttempt', 'platform', 'arch', 'nodeMajor', 'image']) {
    assert.equal(manifest[key], expected[key], `Build ${key} does not match the approved CI/environment.`);
  }
  assert.ok(sha(manifest.sourceCommit) && sha(manifest.sourceTree), 'Invalid build source identity.');
  assert.equal(manifest.sourceTree, git(root, 'rev-parse', 'HEAD^{tree}'), 'CI did not test the integrated source tree.');
  assert.equal(manifest.lockHash, await hashFile(path.join(root, 'package-lock.json')), 'Dependency lock changed.');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length < 100000);
  const seen = new Set();
  for (const entry of manifest.files) {
    const relative = safePath(entry.path);
    assert.ok(roots[variant].some(prefix => relative === prefix || relative.startsWith(`${prefix}/`)),
      `File outside reusable build outputs: ${relative}`);
    assert.ok(!seen.has(relative.toLowerCase()), 'Duplicate artifact path.');
    seen.add(relative.toLowerCase());
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256));
  }
  for (const prefix of roots[variant]) {
    assert.ok(manifest.files.some(entry => entry.path === prefix || entry.path.startsWith(`${prefix}/`)),
      `Missing build output: ${prefix}`);
  }
  const actual = await inventory(directory);
  assert.deepEqual(actual.sort(), ['build-manifest.json', ...manifest.files.map(entry => entry.path)].sort(),
    'Build archive contains missing or unexpected files.');
  for (const entry of manifest.files) {
    const filename = path.join(directory, ...entry.path.split('/'));
    assert.equal((await fs.stat(filename)).size, entry.bytes, `Build size mismatch: ${entry.path}`);
    assert.equal(await hashFile(filename), entry.sha256, `Build checksum mismatch: ${entry.path}`);
  }
  return manifest;
}

export function githubApi(token = process.env.GH_TOKEN, repository = process.env.GITHUB_REPOSITORY) {
  assert.ok(token && /^[\w.-]+\/[\w.-]+$/.test(repository), 'Missing GitHub credentials/repository.');
  return async (endpoint, raw = false) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'manual', signal: AbortSignal.timeout(60000),
    });
    if (raw && response.status === 302) return response;
    assert.ok(response.ok, `GitHub ${endpoint} returned HTTP ${response.status}.`);
    return raw ? response : response.json();
  };
}

export async function selectBuild(api, repository, commit, promotion = false) {
  assert.ok(sha(commit), 'Invalid release commit.');
  const prs = await api(`commits/${commit}/pulls?per_page=100`);
  const pr = prs.find(item => item.merged_at && item.merge_commit_sha === commit
    && item.base.ref === 'main' && item.base.repo.full_name === repository);
  if (!pr) {
    assert.ok(promotion, 'A new release must originate from a merged main PR.');
    return { reuse: false, reason: 'Legacy promotion has no associated merged PR.' };
  }
  const runs = await api(`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`);
  const run = runs.workflow_runs.find(item => item.event === 'pull_request'
    && item.path === '.github/workflows/ci.yml' && item.head_sha === pr.head.sha
    && item.repository.full_name === repository && item.status === 'completed' && item.conclusion === 'success');
  if (!run) {
    assert.ok(promotion, 'The merged PR has no successful CI run; refusing to publish.');
    return { reuse: false, reason: 'Legacy promotion has no available successful CI run.' };
  }
  const listing = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
  const artifacts = {};
  for (const variant of Object.keys(roots)) {
    const artifact = listing.artifacts.find(item => item.name === `ci-build-${variant}-${run.run_attempt}` && !item.expired);
    if (!artifact) return { reuse: false, reason: 'Approved CI artifacts are absent or expired; rebuilding this legacy/recovery release.' };
    assert.ok(positiveId(artifact.id) && /^sha256:[a-f0-9]{64}$/.test(artifact.digest), 'Missing immutable artifact digest.');
    artifacts[variant] = artifact.id;
  }
  return { reuse: true, runId: run.id, runAttempt: run.run_attempt, artifacts };
}

export async function downloadBuild(api, artifactId, runId, variant, destination) {
  assert.ok(positiveId(artifactId) && positiveId(runId) && Object.hasOwn(roots, variant));
  const run = await api(`actions/runs/${runId}`);
  assert.equal(run.event, 'pull_request');
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success', 'CI must still be successful when restoring its outputs.');
  const artifact = await api(`actions/artifacts/${artifactId}`);
  assert.equal(artifact.workflow_run.id, Number(runId));
  assert.equal(artifact.workflow_run.head_sha, run.head_sha);
  assert.equal(artifact.name, `ci-build-${variant}-${run.run_attempt}`);
  assert.equal(artifact.expired, false, 'The selected build expired before download.');
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
  let response = await api(`actions/artifacts/${artifactId}/zip`, true);
  if (response.status === 302) {
    const url = new URL(response.headers.get('location'));
    assert.ok(url.protocol === 'https:' && !url.username && !url.password, 'Unsafe artifact download URL.');
    // Storage redirects never receive the GitHub authorization header.
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(600000) });
  }
  assert.ok(response.ok && response.body, 'Artifact download failed.');
  await pipeline(response.body, createWriteStream(destination, { flags: 'wx' }));
  assert.equal(`sha256:${await hashFile(destination)}`, artifact.digest, 'GitHub artifact digest mismatch.');
  return run;
}

export async function restoreBuild(root, variant, runId, artifactId, {
  api = githubApi(), context = buildEnvironment(), tempParent = process.env.RUNNER_TEMP,
} = {}) {
  const temp = await fs.mkdtemp(path.join(tempParent, 'monky-ci-build-'));
  try {
    const archive = path.join(temp, 'build.zip');
    const extracted = path.join(temp, 'extracted');
    const run = await downloadBuild(api, artifactId, runId, variant, archive);
    assert.equal(run.repository.full_name, context.repository, 'CI belongs to another repository.');
    execFileSync('python', [path.join(root, 'scripts', 'ci-build-archive.py'), archive, extracted], { stdio: 'inherit' });
    const manifest = await validateBuild(extracted, root, variant, {
      ...context, runId: Number(runId), runAttempt: run.run_attempt,
    });
    const source = await api(`git/commits/${manifest.sourceCommit}`);
    assert.equal(source.tree.sha, manifest.sourceTree, 'Artifact source identity disagrees with GitHub.');
    assert.ok(source.sha === run.head_sha || source.parents.some(parent => parent.sha === run.head_sha),
      'Artifact was not built from the approved PR head.');
    // Validate the whole archive before writing any output into the release checkout.
    for (const prefix of roots[variant]) {
      const target = path.join(root, ...prefix.split('/'));
      let current = root;
      for (const part of prefix.split('/')) {
        current = path.join(current, part);
        const stat = await fs.lstat(current).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        assert.ok(!stat?.isSymbolicLink(), 'Refusing to restore through an output alias.');
        assert.ok(current !== target || !stat, 'Refusing to overlay existing build outputs.');
      }
    }
    for (const prefix of roots[variant]) {
      const target = path.join(root, ...prefix.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(path.join(extracted, ...prefix.split('/')), target, { recursive: true, errorOnExist: true, force: false });
    }
    console.log(`Reused ${variant} build from CI ${runId}, source tree ${manifest.sourceTree}.`);
    return manifest;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'collect') {
    assert.equal(args.length, 2, 'Usage: collect <cli|win|mac> <destination>');
    await collectBuild(root, path.resolve(args[1]), args[0]);
  } else if (command === 'select') {
    assert.ok(args.length === 1 || (args.length === 2 && args[1] === '--promotion'));
    const selected = await selectBuild(githubApi(), process.env.GITHUB_REPOSITORY, args[0], args[1] === '--promotion');
    await fs.appendFile(process.env.GITHUB_OUTPUT, `reuse=${selected.reuse}\nrun_id=${selected.runId ?? ''}\nartifacts=${JSON.stringify(selected.artifacts ?? {})}\n`);
    if (!selected.reuse) console.warn(`::warning::${selected.reason}`);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      selected.reuse ? `Reusing approved CI build [${selected.runId}](https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${selected.runId}).\n`
        : `**CI build reuse unavailable:** ${selected.reason}\n`);
  } else if (command === 'restore') {
    assert.equal(args.length, 3, 'Usage: restore <cli|win|mac> <run-id> <artifact-id>');
    await restoreBuild(root, args[0], args[1], args[2]);
  } else throw new Error('Choose collect, select or restore.');
}
