import fs from 'fs';
import path from 'path';
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
import { getServerVersion } from '../../infrastructure/version/ServerVersion';
import { restartServerCommand } from './serverLifecycle';

export const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/MonkyOrg/Monky/releases?per_page=100';
export const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/MonkyOrg/Monky/releases/latest';

/**
 * Version this CLI is running, for the update check.
 *
 * Delegates to the server's own resolver so `monky --version`, the update
 * comparison and the version shown in the client's server settings can never
 * disagree (#559). `0.0.0` stands in for "unknown" here — unlike the settings
 * screen, which omits the field, the comparison needs a number and treating an
 * untagged checkout as the oldest possible version offers the update.
 */
export function getLocalVersion(): string {
  return getServerVersion() ?? '0.0.0';
}

export async function fetchLatestVersion(
  includeBeta = false
): Promise<{ version: string; url: string; tgzUrl?: string; isPrerelease: boolean } | null> {
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
            resolve(null);
            return;
          }
          let data = '';
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const release = Array.isArray(parsed) ? pickNewestRelease(parsed) : parsed;
              if (!release) {
                resolve(null);
                return;
              }
              const version = (release.tag_name || '').replace(/^v/, '');
              const tgzAsset = (release.assets || []).find((a: any) =>
                a.name?.endsWith('.tgz') && a.name?.includes('monky-cli')
              );
              const tgzUrl =
                tgzAsset?.browser_download_url ||
                `https://github.com/MonkyOrg/Monky/releases/download/v${version}/monky-cli-${version}.tgz`;

              resolve({
                version,
                url: release.html_url || '',
                tgzUrl,
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
  assets?: { name?: string; browser_download_url?: string }[];
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
): Promise<{ hasUpdate: boolean; local: string; remote: string; url: string; tgzUrl?: string; isPrerelease: boolean }> {
  const local = getLocalVersion();
  console.log(color(t('update.localVersion', { version: local }), ANSI.dim));
  console.log(color(includeBeta ? t('update.checkingBeta') : t('update.checkingStable'), ANSI.dim));

  const latest = await fetchLatestVersion(includeBeta);
  if (!latest) {
    console.log(color(t('update.checkFailed'), ANSI.yellow));
    return { hasUpdate: false, local, remote: local, url: '', isPrerelease: false };
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

  return {
    hasUpdate,
    local,
    remote: latest.version,
    url: latest.url,
    tgzUrl: latest.tgzUrl,
    isPrerelease: latest.isPrerelease,
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

export async function performUpdate(
  options: { beta?: boolean; targetVersion?: string; tgzUrl?: string } = {}
): Promise<boolean> {
  console.log(color(t('update.updating'), ANSI.bold));
  console.log();

  const tgzUrl =
    options.tgzUrl ||
    (options.targetVersion
      ? `https://github.com/MonkyOrg/Monky/releases/download/v${options.targetVersion}/monky-cli-${options.targetVersion}.tgz`
      : null);

  if (!tgzUrl) {
    console.log(color(t('update.noTgzUrl'), ANSI.red));
    return false;
  }

  console.log(color(t('update.installing', { url: tgzUrl }), ANSI.cyan));
  const installArgs = buildInstallArgs(tgzUrl, detectNpmVersion());
  const installResult = runSync('npm', installArgs, { stdio: 'inherit' });
  if (installResult.status !== 0) {
    console.log(color(t('update.installFailed'), ANSI.red));
    return false;
  }

  console.log();
  console.log(color(t('update.success'), ANSI.green));
  return true;
}

export async function updateCommand(globalArgs: GlobalArgs, args: string[]): Promise<void> {
  const checkOnly = args.includes('--check');
  const includeBeta = args.includes('--beta') || args.includes('-b');
  const assumeYes = args.includes('--yes') || args.includes('-y');

  const { hasUpdate, remote, tgzUrl, isPrerelease } = await checkForUpdate(includeBeta);

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

  const success = await performUpdate({
    beta: includeBeta || isPrerelease,
    targetVersion: remote,
    tgzUrl,
  });
  if (!success) return;

  if (!isPm2Available()) return;

  // Restarting goes through the lifecycle command so the ecosystem file is
  // rewritten and the right server is picked when the machine hosts several.
  if (assumeYes) {
    await restartServerCommand(globalArgs, [], { asUpdate: true });
    return;
  }

  const shouldRestart = await confirm(t('update.confirmRestart'), true);
  if (shouldRestart) {
    await restartServerCommand(globalArgs, [], { asUpdate: true });
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
