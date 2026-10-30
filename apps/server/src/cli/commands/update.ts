import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync, type SpawnSyncReturns } from 'child_process';
import {
  compareReleaseVersions, fetchReleaseCompatibility, isReleaseVersion, pickNewestRelease, PROTOCOL_VERSION,
  releaseRequiresProtocolUpdate, type ReleaseCompatibilityResult,
} from '@monky/shared';
import { ANSI, color } from '../constants';
import { GlobalArgs } from '../context';
import { getCliLanguage, t } from '../i18n/index';
import { isPm2Available } from '../pm2';
import { confirm } from '../prompts';
import { runSync } from '../process';
import { createCliDownloadProgress, downloadCliArtifact, validateCliArtifact, type CliReleaseArtifact } from '../releaseDownload';
import {
  acquireUpdateLock,
  backupDatabase,
  findRunningTargets,
  readInstallRecord,
  recordInstall,
  restoreDatabaseIfMigrated,
  type RunningTarget,
  updateTiming,
  waitForServer,
} from '../updateSafety';

// Release bodies carry the full changelog, so 100 entries already exceed the
// 4 MiB response limit in fetchLatestVersion; the newest release is always in
// the first few entries.
export const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/MonkyOrg/Monky/releases?per_page=30';
export const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/MonkyOrg/Monky/releases/latest';
export const GITHUB_RELEASE_BY_TAG_URL = 'https://api.github.com/repos/MonkyOrg/Monky/releases/tags/';

export function getRepoRoot(): string | null {
  // apps/server/dist/cli/commands/update.js -> 4 levels up is repo root
  const candidate = path.resolve(__dirname, '..', '..', '..', '..');
  if (fs.existsSync(path.join(candidate, 'package.json')) && fs.existsSync(path.join(candidate, '.git'))) {
    return candidate;
  }
  // Try 3 levels up if executed directly from src or dist
  const candidate3 = path.resolve(__dirname, '..', '..', '..');
  if (fs.existsSync(path.join(candidate3, 'package.json')) && fs.existsSync(path.join(candidate3, '.git'))) {
    return candidate3;
  }
  // Fallback: try to find via git
  try {
    const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', cwd: __dirname, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (root && fs.existsSync(path.join(root, 'package.json'))) {
      return root;
    }
  } catch {
    // Not in a git repo (e.g. standalone global tarball install)
  }
  return null;
}

/**
 * Version stamped into the published CLI package.
 *
 * `pack-cli.js` writes the release version into the tarball's package.json, so
 * this is authoritative for the recommended install. The placeholder versions
 * checked out in the repository are ignored on purpose.
 */
function readPackagedVersion(): string | null {
  const candidatePkgs = [
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(__dirname, '..', '..', '..', 'package.json'),
  ];
  for (const pkgFile of candidatePkgs) {
    if (!fs.existsSync(pkgFile)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.version && pkg.version !== '1.0.0' && pkg.version !== '0.0.0') {
        return pkg.version;
      }
    } catch {}
  }
  return null;
}

/**
 * Version of the checked-out repository, taken from the nearest tag.
 *
 * The repository never bumps `package.json` — releases exist only as tags — so
 * reading it here always returned `1.0.0` and made every check report an
 * update as available.
 */
function readGitVersion(repoRoot: string): string | null {
  try {
    const described = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf8',
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return described ? described.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

export function getLocalVersion(): string {
  const packaged = readPackagedVersion();
  if (packaged) return packaged;

  const repoRoot = getRepoRoot();
  if (repoRoot) {
    const fromGit = readGitVersion(repoRoot);
    if (fromGit) return fromGit;
  }

  return '0.0.0';
}

export interface PublishedRelease {
  version: string;
  url: string;
  tgzUrl?: string;
  artifact?: CliReleaseArtifact;
  isPrerelease: boolean;
}

export async function fetchLatestVersion(includeBeta = false): Promise<PublishedRelease | null> {
  return fetchRelease(includeBeta ? GITHUB_RELEASES_URL : GITHUB_LATEST_RELEASE_URL);
}

/** The release of one exact version, used to reinstall it when an update fails. */
export async function fetchReleaseByVersion(version: string): Promise<PublishedRelease | null> {
  const release = await fetchRelease(`${GITHUB_RELEASE_BY_TAG_URL}v${encodeURIComponent(version)}`);
  return release?.version === version ? release : null;
}

async function fetchRelease(endpoint: string): Promise<PublishedRelease | null> {
  try {
    const https = await import('https');
    return new Promise((resolve) => {
      const req = https.get(
        endpoint,
        {
          headers: { 'User-Agent': 'monky-cli', Accept: 'application/vnd.github.v3+json' },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          let data = '';
          res.on('data', (chunk: string) => {
            data += chunk;
            if (Buffer.byteLength(data, 'utf8') > 4 * 1024 * 1024) {
              req.destroy(new Error('Release listing exceeds its size limit.'));
            }
          });
          res.on('aborted', () => resolve(null));
          res.on('error', () => resolve(null));
          res.on('end', () => {
            try {
              const parsed: unknown = JSON.parse(data);
              const release = Array.isArray(parsed)
                ? pickNewestRelease(parsed.flatMap((value) => {
                  const item = parseGitHubRelease(value);
                  return item ? [item] : [];
                }))
                : parseGitHubRelease(parsed);
              if (!release) {
                resolve(null);
                return;
              }
              const version = (release.tag_name || '').replace(/^v/, '');
              const tgzAsset = release.assets?.find((asset) => asset.name === `monky-cli-${version}.tgz`);
              const tgzUrl =
                tgzAsset?.browser_download_url ||
                `https://github.com/MonkyOrg/Monky/releases/download/v${version}/monky-cli-${version}.tgz`;

              resolve({
                version,
                url: release.html_url || '',
                tgzUrl,
                artifact: tgzAsset && typeof tgzAsset.size === 'number' ? {
                  version, name: tgzAsset.name ?? '', url: tgzUrl, size: tgzAsset.size, digest: tgzAsset.digest,
                } : undefined,
                isPrerelease: !!release.prerelease,
              });
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => {
        req.destroy();
        resolve(null);
      });
    });
  } catch {
    return null;
  }
}

export interface GitHubReleaseSummary {
  tag_name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string | null }[];
}

function parseGitHubRelease(value: unknown): GitHubReleaseSummary | null {
  if (!value || typeof value !== 'object' || !('tag_name' in value) ||
      typeof value.tag_name !== 'string' || !isReleaseVersion(value.tag_name.replace(/^v/, ''))) return null;
  const assets: NonNullable<GitHubReleaseSummary['assets']> = [];
  if ('assets' in value && Array.isArray(value.assets)) {
    for (const rawAsset of value.assets) {
      const asset: unknown = rawAsset;
      if (!asset || typeof asset !== 'object') continue;
      assets.push({
        name: 'name' in asset && typeof asset.name === 'string' ? asset.name : undefined,
        browser_download_url: 'browser_download_url' in asset && typeof asset.browser_download_url === 'string'
          ? asset.browser_download_url : undefined,
        size: 'size' in asset && typeof asset.size === 'number' ? asset.size : undefined,
        digest: 'digest' in asset && typeof asset.digest === 'string' ? asset.digest : undefined,
      });
    }
  }
  return {
    tag_name: value.tag_name,
    html_url: 'html_url' in value && typeof value.html_url === 'string' ? value.html_url : undefined,
    prerelease: 'prerelease' in value && value.prerelease === true,
    draft: 'draft' in value && value.draft === true,
    assets,
  };
}

export async function checkForUpdate(
  includeBeta = false
): Promise<{
  hasUpdate: boolean; local: string; remote: string; url: string; tgzUrl?: string;
  artifact?: CliReleaseArtifact; isPrerelease: boolean; compatibility: ReleaseCompatibilityResult;
}> {
  const local = getLocalVersion();
  console.log(color(t('update.localVersion', { version: local }), ANSI.dim));
  console.log(color(includeBeta ? t('update.checkingBeta') : t('update.checkingStable'), ANSI.dim));

  const latest = await fetchLatestVersion(includeBeta);
  if (!latest) {
    throw new Error(t('update.checkFailed'));
  }

  const hasUpdate = compareReleaseVersions(latest.version, local) > 0;
  if (hasUpdate) {
    const tagDesc = latest.isPrerelease ? ' (Beta)' : '';
    console.log(color(t('update.newVersion', { version: latest.version + tagDesc }), ANSI.green));
    if (latest.url) {
      console.log(`Release: ${latest.url}`);
    }
  } else {
    console.log(color(t('update.upToDate'), ANSI.green));
  }
  const compatibility = await fetchReleaseCompatibility(latest.version);
  if (compatibility.status === 'available' && releaseRequiresProtocolUpdate(compatibility.manifest, 'bot')) {
    console.log(color(t('update.compatibilityChanged', {
      protocol: compatibility.manifest.protocolVersion, sdk: compatibility.manifest.botSdkVersion,
    }), ANSI.yellow));
  } else if (compatibility.status === 'unavailable') {
    console.log(color(t('update.compatibilityUnknown'), ANSI.yellow));
  }

  return {
    hasUpdate,
    local,
    remote: latest.version,
    url: latest.url,
    tgzUrl: latest.tgzUrl,
    artifact: latest.artifact,
    isPrerelease: latest.isPrerelease,
    compatibility,
  };
}

/**
 * The only dependency in the CLI tree that ships an install script.
 *
 * mediasoup builds its worker binary in `postinstall`; without it the SFU
 * cannot start and voice silently degrades to P2P.
 */
export const SCRIPTED_DEPENDENCY = 'mediasoup';

/**
 * Whether this npm understands `--allow-scripts`.
 *
 * npm 11.16 started warning that dependency install scripts will be blocked
 * and npm 12 blocks them outright. Older versions treat the flag as unknown
 * config, so it is only passed where it actually means something.
 */
export function npmSupportsAllowScripts(npmVersion: string): boolean {
  const [major = 0, minor = 0] = String(npmVersion)
    .trim()
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  if (major >= 12) return true;
  return major === 11 && minor >= 16;
}

function detectNpmVersion(): string | null {
  try {
    const result = runSync('npm', ['-v'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Arguments for the global install, allowing mediasoup's script when needed.
 *
 * A dependency cannot authorise its own scripts — only the invoking install
 * can — so every entry point that installs the CLI has to opt in explicitly.
 */
export function buildInstallArgs(tgzUrl: string, npmVersion: string | null): string[] {
  const args = ['install', '-g'];
  if (npmVersion && npmSupportsAllowScripts(npmVersion)) {
    args.push(`--allow-scripts=${SCRIPTED_DEPENDENCY}`);
  }
  args.push(tgzUrl);
  return args;
}

export function resolveInstalledCli(version: string, cwd?: string): string {
  const root = runSync('npm', ['root', '-g'], { encoding: 'utf8', cwd });
  if (root.error || root.status !== 0 || !root.stdout || !path.isAbsolute(root.stdout.trim())) {
    throw new Error(t('update.invalidInstalledCli', { version }));
  }
  const packageDir = path.join(root.stdout.trim(), '@monky', 'server');
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (!pkg || typeof pkg !== 'object' || !('name' in pkg) || pkg.name !== '@monky/server' ||
      !('version' in pkg) || pkg.version !== version || !('bin' in pkg) || !pkg.bin ||
      typeof pkg.bin !== 'object' || !('monky' in pkg.bin) || typeof pkg.bin.monky !== 'string') {
    throw new Error(t('update.invalidInstalledCli', { version }));
  }
  const packageRoot = fs.realpathSync(packageDir);
  const entry = fs.realpathSync(path.resolve(packageDir, pkg.bin.monky));
  const relative = path.relative(packageRoot, entry);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) ||
      !fs.statSync(entry).isFile()) throw new Error(t('update.invalidInstalledCli', { version }));
  return entry;
}

/** Downloads, verifies and installs one release, returning its CLI entry point. */
async function installRelease(version: string, artifact?: CliReleaseArtifact): Promise<string> {
  if (!artifact || artifact.version !== version) throw new Error(t('update.invalidArtifact'));
  validateCliArtifact(artifact);
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'monky-update-'));
  const progress = createCliDownloadProgress();
  try {
    console.log(color(t('update.downloadStage'), ANSI.cyan));
    await downloadCliArtifact(artifact, path.join(directory, 'package.tgz'), {
      onProgress: progress.update,
      onVerifying: () => {
        progress.finish();
        console.log(color(t('update.verifyingStage'), ANSI.dim));
      },
    });
    console.log(color(t('update.installStage'), ANSI.cyan));
    const installArgs = buildInstallArgs('./package.tgz', detectNpmVersion());
    const installResult = runSync('npm', installArgs, { stdio: 'inherit', cwd: directory });
    if (installResult.error || installResult.status !== 0) throw new Error(t('update.installFailed'));
    return resolveInstalledCli(version, directory);
  } finally {
    progress.finish();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

export async function performUpdate(
  options: { targetVersion: string; artifact?: CliReleaseArtifact },
): Promise<{ cliEntry: string }> {
  console.log(color(t('update.updating'), ANSI.bold));
  console.log();
  const cliEntry = await installRelease(options.targetVersion, options.artifact);
  console.log(color(t('update.success'), ANSI.green));
  return { cliEntry };
}

/**
 * Runs the freshly installed CLI once. It loads the whole server, so a
 * package that cannot run on this host (Node too old, missing module) fails
 * here, before any server is restarted onto it.
 */
export function verifyInstalledCli(cliEntry: string, version: string): boolean {
  const result = spawnSync(process.execPath, [cliEntry, '--version'], {
    encoding: 'utf8', timeout: 60_000, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    // An explicit language keeps an unreadable saved preference from failing the check.
    env: { ...process.env, MONKY_LANG: getCliLanguage() },
  });
  const lines = String(result.stdout ?? '').trim().split(/\r?\n/);
  return !result.error && result.status === 0 && lines[lines.length - 1]?.trim() === `monky ${version}`;
}

/**
 * Reinstalls a release after a failed update. The install record is left
 * pointing at the failed version on purpose: servers that kept running the
 * reinstalled code must not later be taken for outdated and restarted.
 */
async function reinstallVersion(version: string): Promise<string> {
  const release = await fetchReleaseByVersion(version);
  if (!release?.artifact) throw new Error(t('update.previousReleaseUnavailable', { version }));
  console.log(color(t('update.reinstalling', { version }), ANSI.bold));
  return installRelease(version, release.artifact);
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
  return result.error?.message ?? result.signal ?? String(result.status);
}

async function rollBackInstall(previous: string, next: string): Promise<never> {
  console.log(color(t('update.smokeTestFailed', { version: next }), ANSI.red));
  try {
    await reinstallVersion(previous);
  } catch (error) {
    throw new Error(t('update.rollbackFailed', { reason: describeFailure(error), backup: '-' }));
  }
  throw new Error(t('update.installRolledBack', { version: next, previous }));
}

/**
 * Brings the previous version back after the first server failed to start on
 * the new one: reinstalls it, restores the database when the failed version
 * migrated it, and starts the server again. Always ends the update in error.
 */
async function rollBack(
  target: RunningTarget,
  backup: string | null,
  versions: { previous: string; next: string },
): Promise<never> {
  console.log(color(t('update.rollingBack', { name: target.name, version: versions.next, previous: versions.previous }), ANSI.yellow));
  // Stops a crash loop from touching the database while it is restored.
  runSync('pm2', ['stop', target.processName], { stdio: 'ignore' });
  let cliEntry: string;
  let restored: boolean;
  try {
    cliEntry = await reinstallVersion(versions.previous);
    restored = backup !== null && await restoreDatabaseIfMigrated(target.dataDir, backup);
  } catch (error) {
    throw new Error(t('update.rollbackFailed', { reason: describeFailure(error), backup: backup ?? '-' }));
  }
  if (restored && backup) console.log(color(t('update.databaseRestored', { backup }), ANSI.dim));
  const start = spawnSync(process.execPath, [cliEntry, '--data', target.dataDir, 'start'], { stdio: 'inherit', shell: false });
  const outcome = !start.error && start.status === 0 ? await waitForServer(target, updateTiming.startupMs) : 'down';
  throw new Error(outcome === 'down'
    ? t('update.rollbackStartFailed', { name: target.name, version: versions.previous, backup: backup ?? '-' })
    : t('update.rolledBack', { version: versions.next, previous: versions.previous }));
}

/**
 * Restarts each server through the installed CLI and confirms it answers.
 * When no server has come up on the new version yet, a failure rolls the
 * update back; once one has, the version itself runs here, so a later
 * failure only stops the remaining restarts.
 */
async function restartTargets(
  targets: RunningTarget[],
  cliEntry: string,
  versions: { previous: string | null; next: string },
  ranElsewhere = false,
): Promise<void> {
  let ranHere = ranElsewhere;
  for (const target of targets) {
    const backup = backupDatabase(target.dataDir, versions.previous ?? 'unknown');
    const restart = spawnSync(process.execPath, [cliEntry, '--data', target.dataDir, 'restart', '--after-update'], {
      stdio: 'inherit', shell: false,
    });
    const restarted = !restart.error && restart.status === 0;
    const outcome = await waitForServer(target, restarted ? updateTiming.startupMs : updateTiming.failedRestartGraceMs);
    if (outcome === 'up') {
      ranHere = true;
      continue;
    }
    if (outcome === 'unchanged') {
      if (!restarted) throw new Error(t('update.restartFailed', { reason: describeSpawnFailure(restart) }));
      console.log(color(t('update.serverNotRestarted', { name: target.name }), ANSI.dim));
      continue;
    }
    if (!ranHere && versions.previous) await rollBack(target, backup, { previous: versions.previous, next: versions.next });
    throw new Error(t('update.serverDidNotStart', { name: target.name, backup: backup ?? '-' }));
  }
}

/**
 * Servers still running code older than the last install: a declined
 * restart, or a run that waited for another update and found it done. They
 * get the same backup and rollback as a restart right after the install,
 * unless another server of this machine already runs the installed version:
 * rolling the shared package back would then leave that one on newer code
 * than its next start, over a database it already migrated.
 */
async function restartOutdatedServers(globalArgs: GlobalArgs, version: string, assumeYes: boolean): Promise<void> {
  const record = readInstallRecord();
  if (!record || record.version !== version) return;
  const outdated = findRunningTargets(globalArgs)
    .filter((target) => target.startedAt !== null && target.startedAt < record.installedAt);
  if (outdated.length === 0) return;
  const names = outdated.map((target) => target.name).join(', ');
  if (!assumeYes) {
    console.log(color(t('update.outdatedServers', { names }), ANSI.yellow));
    return;
  }
  const ranElsewhere = findRunningTargets({ ...globalArgs, dataDirSpecified: false })
    .some((target) => target.startedAt !== null && target.startedAt >= record.installedAt);
  console.log(color(t('update.restartingOutdated', { names }), ANSI.dim));
  await restartTargets(outdated, resolveInstalledCli(version), { previous: record.previous, next: version }, ranElsewhere);
}

async function runUpdate(globalArgs: GlobalArgs, includeBeta: boolean, assumeYes: boolean): Promise<void> {
  const { local, remote, artifact, isPrerelease } = await checkForUpdate(includeBeta);
  const order = compareReleaseVersions(remote, local);
  if (order <= 0) {
    // Only the installed version can be reinstalled: an older release over a
    // database the newer one already migrated is a downgrade.
    if (order < 0) console.log(color(t('update.noDowngrade', { local, remote }), ANSI.yellow));
    const reinstall = order === 0 && !assumeYes && await confirm(t('update.forceReinstall'), false);
    if (!reinstall) {
      await restartOutdatedServers(globalArgs, local, assumeYes);
      return;
    }
  }

  const channelLabel = isPrerelease || includeBeta ? ' (Beta)' : '';
  if (!assumeYes) {
    const accepted = await confirm(t('update.confirmUpdate', { version: remote + channelLabel }), true);
    if (!accepted) {
      console.log(color(t('update.cancelled'), ANSI.yellow));
      return;
    }
  }

  const targets = findRunningTargets(globalArgs);
  const installed = await performUpdate({ targetVersion: remote, artifact });
  if (!verifyInstalledCli(installed.cliEntry, remote)) await rollBackInstall(local, remote);
  recordInstall(remote, local);

  if (targets.length === 0) {
    if (isPm2Available()) console.log(color(t('update.noRunningServers'), ANSI.dim));
    return;
  }
  const shouldRestart = assumeYes || await confirm(
    targets.length === 1 ? t('update.confirmRestart') : t('update.confirmRestartMany', { count: targets.length }),
    true
  );
  if (!shouldRestart) {
    console.log(color(t('update.restartLater'), ANSI.dim));
    return;
  }
  await restartTargets(targets, installed.cliEntry, { previous: local, next: remote });
}

export async function updateCommand(globalArgs: GlobalArgs, args: string[]): Promise<void> {
  const checkOnly = args.includes('--check');
  const includeBeta = args.includes('--beta') || args.includes('-b');
  const assumeYes = args.includes('--yes') || args.includes('-y');

  if (checkOnly) {
    await checkForUpdate(includeBeta);
    return;
  }

  const releaseLock = await acquireUpdateLock();
  try {
    await runUpdate(globalArgs, includeBeta, assumeYes);
  } finally {
    releaseLock();
  }
}