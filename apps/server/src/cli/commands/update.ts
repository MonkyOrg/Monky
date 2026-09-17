import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fetchReleaseCompatibility, isReleaseVersion, PROTOCOL_VERSION, type ReleaseCompatibilityResult } from '@monky/shared';
import { ANSI, color } from '../constants';
import { GlobalArgs } from '../context';
import { resolveInterpreter } from '../health';
import { t } from '../i18n/index';
import {
  AUTO_UPDATE_CRON,
  ensurePm2,
  findPm2Process,
  getCliEntryPath,
  getUpdaterProcessName,
  isPm2Available,
  LEGACY_UPDATER_PROCESS_NAME,
} from '../pm2';
import { confirm } from '../prompts';
import { runSync } from '../process';
import { createCliDownloadProgress, downloadCliArtifact, validateCliArtifact, type CliReleaseArtifact } from '../releaseDownload';

export const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/MonkyOrg/Monky/releases?per_page=100';
export const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/MonkyOrg/Monky/releases/latest';

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

export async function fetchLatestVersion(
  includeBeta = false
): Promise<{ version: string; url: string; tgzUrl?: string; artifact?: CliReleaseArtifact; isPrerelease: boolean } | null> {
  const endpoint = includeBeta ? GITHUB_RELEASES_URL : GITHUB_LATEST_RELEASE_URL;

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

export function parseSemver(v: string): {
  major: number;
  minor: number;
  patch: number;
  isBeta: boolean;
  betaNumber: number;
} {
  const clean = String(v || '').replace(/^v/, '').trim();
  const [main, prerelease] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = main.split('.').map((n) => Number.parseInt(n, 10) || 0);
  let betaNumber = 0;
  if (prerelease) {
    const match = /beta\.?(\d+)/i.exec(prerelease);
    betaNumber = match ? Number.parseInt(match[1], 10) : 0;
  }
  return { major, minor, patch, isBeta: prerelease != null, betaNumber };
}

export function compareVersions(local: string, remote: string): number {
  const a = parseSemver(local);
  const b = parseSemver(remote);

  if (a.major !== b.major) return b.major - a.major;
  if (a.minor !== b.minor) return b.minor - a.minor;
  if (a.patch !== b.patch) return b.patch - a.patch;

  // Same base major.minor.patch:
  // If one is beta and the other is stable, the stable release is strictly newer
  if (a.isBeta && !b.isBeta) return 1;
  if (!a.isBeta && b.isBeta) return -1;
  if (a.isBeta && b.isBeta) {
    return b.betaNumber - a.betaNumber;
  }
  return 0;
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

/**
 * Picks the newest release from the GitHub listing.
 *
 * The `/releases` endpoint does not return the list in chronological order — it
 * orders by tag name, so `v2.4.0-beta.9` came back ahead of `v2.4.0-beta.15`.
 * Reading `parsed[0]` therefore offered an old build as if it were the latest,
 * while the desktop client, which compares every entry, resolved correctly. The
 * two now use the same strategy: compare, never trust the order.
 *
 * Drafts are skipped because they are visible to maintainers only and have no
 * downloadable assets.
 */
export function pickNewestRelease<T extends GitHubReleaseSummary>(releases: T[]): T | null {
  let newest: T | null = null;
  for (const release of releases || []) {
    if (!release || release.draft || !release.tag_name) continue;
    if (!newest || compareVersions(newest.tag_name as string, release.tag_name) > 0) {
      newest = release;
    }
  }
  return newest;
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

  const hasUpdate = compareVersions(local, latest.version) > 0;
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
  if (compatibility.status === 'available' && compatibility.manifest.protocolVersion !== PROTOCOL_VERSION) {
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

export async function performUpdate(
  options: { targetVersion: string; artifact?: CliReleaseArtifact },
): Promise<{ cliEntry: string }> {
  console.log(color(t('update.updating'), ANSI.bold));
  console.log();

  const { artifact } = options;
  if (!artifact || artifact.version !== options.targetVersion) throw new Error(t('update.invalidArtifact'));
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
    // A fixed relative filename never interpolates a home/temp path into cmd.exe.
    const installArgs = buildInstallArgs('./package.tgz', detectNpmVersion());
    const installResult = runSync('npm', installArgs, { stdio: 'inherit', cwd: directory });
    if (installResult.error || installResult.status !== 0) throw new Error(t('update.installFailed'));
    const cliEntry = resolveInstalledCli(options.targetVersion, directory);
    console.log(color(t('update.success'), ANSI.green));
    return { cliEntry };
  } finally {
    progress.finish();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

export async function updateCommand(globalArgs: GlobalArgs, args: string[]): Promise<void> {
  const checkOnly = args.includes('--check');
  const includeBeta = args.includes('--beta') || args.includes('-b');
  const assumeYes = args.includes('--yes') || args.includes('-y');

  const { hasUpdate, remote, artifact, isPrerelease } = await checkForUpdate(includeBeta);

  if (checkOnly) {
    return;
  }

  if (!hasUpdate) {
    if (assumeYes) {
      return;
    }
    const force = await confirm(t('update.forceReinstall'), false);
    if (!force) return;
  }

  const channelLabel = isPrerelease || includeBeta ? ' (Beta)' : '';
  if (!assumeYes) {
    const accepted = await confirm(t('update.confirmUpdate', { version: remote + channelLabel }), true);
    if (!accepted) {
      console.log(color(t('update.cancelled'), ANSI.yellow));
      return;
    }
  }

  const installed = await performUpdate({
    targetVersion: remote,
    artifact,
  });

  if (!isPm2Available()) return;

  const shouldRestart = assumeYes || await confirm(t('update.confirmRestart'), true);
  if (shouldRestart) {
    const args = [installed.cliEntry];
    if (globalArgs.dataDirSpecified) args.push('--data', globalArgs.dataDir);
    args.push('restart', '--after-update');
    const restart = spawnSync(process.execPath, args, { stdio: 'inherit', shell: false });
    if (restart.error || restart.status !== 0) {
      throw new Error(t('update.restartFailed', {
        reason: restart.error?.message ?? restart.signal ?? String(restart.status),
      }));
    }
  }
}

export function getUpdaterScriptPath(dataDir: string): string {
  return path.join(dataDir, 'auto-update.cjs');
}

function getLegacyUpdaterScriptPath(dataDir: string): string {
  return path.join(dataDir, 'auto-update.sh');
}

export interface AutoUpdateSchedule {
  type: 'daily' | 'interval';
  value: string | number;
}

/**
 * Auto-updater run by PM2 as a daemon on a schedule.
 *
 * It runs as a long-lived Node.js process managed by PM2, calculating the next check time
 * and calling the CLI entry point with `update --yes`.
 */
export function generateUpdaterScript(options: {
  dataDir: string;
  cliEntry: string;
  beta: boolean;
  schedule?: AutoUpdateSchedule;
}): string {
  const args = [options.cliEntry, '--data', options.dataDir, 'update', '--yes'];
  if (options.beta) args.push('--beta');
  const scheduleType = options.schedule?.type || 'daily';
  const scheduleValue = options.schedule?.value ?? '04:00';

  return `// Monky auto-updater daemon — generated by "monky config set autoUpdate".
// Do not edit: this file is rewritten whenever auto-update is reconfigured.
const { spawnSync } = require('child_process');

const args = ${JSON.stringify(args, null, 2)};
const scheduleType = ${JSON.stringify(scheduleType)};
const scheduleValue = ${JSON.stringify(scheduleValue)};

function getMsUntilNextRun() {
  if (scheduleType === 'interval') {
    const hours = typeof scheduleValue === 'number' ? scheduleValue : parseInt(scheduleValue, 10) || 2;
    return Math.max(1, hours) * 60 * 60 * 1000;
  }
  const parts = String(scheduleValue || '04:00').split(':').map(Number);
  const targetH = isNaN(parts[0]) ? 4 : parts[0];
  const targetM = isNaN(parts[1]) ? 0 : parts[1];
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetH, targetM, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function runUpdateCheck() {
  console.log('[' + new Date().toISOString() + '] [monky-updater] Checking scheduled updates...');
  try {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    console.log('[monky-updater] Check finished with code:', result.status);
  } catch (err) {
    console.error('[monky-updater] Error while running update check:', err);
  }
  scheduleNext();
}

function scheduleNext() {
  const delayMs = getMsUntilNextRun();
  const nextDate = new Date(Date.now() + delayMs);
  console.log('[' + new Date().toISOString() + '] [monky-updater] Next check scheduled for:', nextDate.toLocaleString());
  setTimeout(runUpdateCheck, delayMs);
}

console.log('[monky-updater] Automatic update daemon started (mode: ' + scheduleType + ', value: ' + scheduleValue + ').');
scheduleNext();
`;
}

/**
 * Whether PM2 has an updater registered for this server.
 */
export function isAutoUpdateEnabled(dataDir: string): boolean {
  if (!isPm2Available()) return false;
  return (
    findPm2Process(getUpdaterProcessName(dataDir)) !== null ||
    findPm2Process(LEGACY_UPDATER_PROCESS_NAME) !== null
  );
}

export async function enableAutoUpdate(dataDir: string, schedule?: AutoUpdateSchedule): Promise<void> {
  ensurePm2();

  const scriptPath = getUpdaterScriptPath(dataDir);
  const beta = parseSemver(getLocalVersion()).isBeta;
  await fs.promises.writeFile(
    scriptPath,
    generateUpdaterScript({ dataDir, cliEntry: getCliEntryPath(), beta, schedule }),
    'utf8'
  );

  const legacyScript = getLegacyUpdaterScriptPath(dataDir);
  if (fs.existsSync(legacyScript)) {
    try {
      await fs.promises.unlink(legacyScript);
    } catch {}
  }

  const processName = getUpdaterProcessName(dataDir);
  for (const name of [processName, LEGACY_UPDATER_PROCESS_NAME]) {
    runSync('pm2', ['delete', name], { stdio: 'ignore' });
  }

  const interpreter = resolveInterpreter();
  const result = runSync(
    'pm2',
    [
      'start',
      scriptPath,
      '--name',
      processName,
      // Same reason as the server's ecosystem file: a bare `node` is resolved
      // from the PM2 daemon's environment, which keeps the Node it was started
      // with. After a Node upgrade that path can be gone, and PM2 then fails to
      // spawn while still reporting the process as online (#522).
      ...(interpreter ? ['--interpreter', interpreter] : []),
    ],
    { stdio: 'inherit' }
  );

  if (result.status !== 0) {
    throw new Error(t('update.autoUpdateFailed'));
  }

  runSync('pm2', ['save'], { stdio: 'ignore' });

  const schedType = schedule?.type || 'daily';
  const schedVal = schedule?.value ?? '04:00';
  const scheduleLabel = schedType === 'interval'
    ? t('update.scheduleEvery', { value: schedVal })
    : t('update.scheduleDaily', { value: schedVal });

  console.log(color(t('update.autoUpdateEnabled'), ANSI.green));
  console.log(t('update.schedule', { schedule: scheduleLabel }));
  console.log(beta ? t('update.channelBeta') : t('update.channelStable'));
  console.log(t('update.script', { path: scriptPath }));
  console.log(color(t('update.disableHint'), ANSI.dim));
}

export async function disableAutoUpdate(dataDir: string): Promise<void> {
  if (!isPm2Available()) {
    console.log(color(t('update.pm2NotFound'), ANSI.yellow));
    return;
  }

  for (const name of [getUpdaterProcessName(dataDir), LEGACY_UPDATER_PROCESS_NAME]) {
    runSync('pm2', ['delete', name], { stdio: 'ignore' });
  }
  runSync('pm2', ['save'], { stdio: 'ignore' });
  console.log(color(t('update.autoUpdateDisabled'), ANSI.green));
}
