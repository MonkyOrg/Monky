import fs from 'fs';
import path from 'path';
import { ANSI, color } from './constants';
import { t } from './i18n/index';
import { commandSucceeds, runSync } from './process';
import { canonicalDataDir, LEGACY_PM2_PROCESS_NAME, serverIdFor } from './registry';
import { resolveInterpreter } from './health';
import { LIMITS } from '@monky/shared';

export const PM2_PROCESS_PREFIX = 'monky-server';
export const UPDATER_PROCESS_PREFIX = 'monky-updater';
export const LEGACY_UPDATER_PROCESS_NAME = 'monky-updater';
export const AUTO_UPDATE_CRON = '0 4 * * *'; // daily at 4am

export { LEGACY_PM2_PROCESS_NAME };

/**
 * PM2 process name for a server, derived from its data directory.
 *
 * A fixed name allowed a single server per machine: starting a second one from
 * another directory silently reported "already running", and stopping any of
 * them stopped whichever happened to be registered.
 */
export function getPm2ProcessName(dataDir: string): string {
  return `${PM2_PROCESS_PREFIX}-${serverIdFor(dataDir)}`;
}

export function getUpdaterProcessName(dataDir: string): string {
  return `${UPDATER_PROCESS_PREFIX}-${serverIdFor(dataDir)}`;
}

export function isPm2Available(): boolean {
  return commandSucceeds('pm2', ['--version']);
}

export interface Pm2Process {
  name?: string;
  pid?: number;
  monit?: { memory?: number; cpu?: number };
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
    pm_cwd?: string;
    pm_exec_path?: string;
    args?: string[] | string;
    /** Node version PM2 actually spawned the process with (#522). */
    node_version?: string;
    /** Interpreter PM2 has registered for the process (#522). */
    exec_interpreter?: string;
  };
}

export function listPm2Processes(): Pm2Process[] {
  if (!isPm2Available()) return [];
  try {
    const listResult = runSync('pm2', ['jlist'], { encoding: 'utf8' });
    if (listResult.status !== 0) return [];
    const parsed = JSON.parse(listResult.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function findPm2Process(processName: string): Pm2Process | null {
  return listPm2Processes().find((entry) => entry.name === processName) ?? null;
}

export function isMonkyServerRunning(processName: string): boolean {
  return findPm2Process(processName)?.pm2_env?.status === 'online';
}

/**
 * Drops a process from PM2's list so the next start builds it from scratch.
 *
 * Log files under `~/.pm2/logs` survive this: only the process entry goes.
 */
export function deletePm2Process(processName: string): void {
  const result = runSync('pm2', ['delete', processName], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(t('pm2.deleteFailed', {
      name: processName,
      reason: result.error?.message || result.stderr?.trim() || result.stdout?.trim() || String(result.signal ?? result.status),
    }));
  }
}

/**
 * Whether PM2 knows about the server at all, regardless of its status.
 *
 * Reading logs is still useful for a stopped or crashed process, so this is a
 * weaker check than {@link isMonkyServerRunning}.
 */
export function isMonkyServerRegistered(processName: string): boolean {
  return findPm2Process(processName) !== null;
}

export function readProcessDataDir(entry: Pm2Process): string | null {
  const rawArgs = entry.pm2_env?.args;
  const args = Array.isArray(rawArgs) ? rawArgs : typeof rawArgs === 'string' ? rawArgs.split(/\s+/) : [];
  const dataIndex = args.indexOf('--data');
  if (dataIndex >= 0 && args[dataIndex + 1]) {
    return canonicalDataDir(args[dataIndex + 1].replace(/^"|"$/g, ''));
  }
  return entry.pm2_env?.pm_cwd ? canonicalDataDir(entry.pm2_env.pm_cwd) : null;
}

/**
 * Data directories of every Monky process PM2 knows about, including the
 * pre-registry process name so older installations are not lost on upgrade.
 */
export function discoverPm2DataDirs(): string[] {
  const found: string[] = [];
  for (const entry of listPm2Processes()) {
    const name = entry.name ?? '';
    if (name !== LEGACY_PM2_PROCESS_NAME && !name.startsWith(`${PM2_PROCESS_PREFIX}-`)) continue;
    const dataDir = readProcessDataDir(entry);
    if (dataDir) found.push(dataDir);
  }
  return found;
}

/**
 * The pre-registry process, when it points at the given data directory.
 *
 * Upgrading must not leave an orphan `monky-server` running alongside the new
 * per-directory process on the same port.
 */
export function findLegacyProcessFor(dataDir: string): Pm2Process | null {
  const legacy = findPm2Process(LEGACY_PM2_PROCESS_NAME);
  if (!legacy) return null;
  const legacyDataDir = readProcessDataDir(legacy);
  return legacyDataDir === canonicalDataDir(dataDir) ? legacy : null;
}

export function ensurePm2(): void {
  if (!isPm2Available()) {
    console.log(color(t('pm2.notFound'), ANSI.yellow));
    const result = runSync('npm', ['install', '-g', 'pm2'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error(t('pm2.installFailed'));
    }
  }
}

/**
 * Reports PM2 as missing without installing it.
 *
 * Only `monky start` needs PM2 badly enough to install it; reading status or
 * stopping a server should never install software as a side effect.
 */
export function requirePm2(action: string): boolean {
  if (isPm2Available()) return true;
  console.log(color(t('pm2.notInstalled', { action }), ANSI.yellow));
  console.log(color(t('pm2.installHint'), ANSI.dim));
  return false;
}

export function getEcosystemPath(dataDir: string): string {
  return path.join(dataDir, 'ecosystem.config.cjs');
}

export function getServerEntryPath(): string {
  return path.resolve(__dirname, '..', 'index.js');
}

/** Absolute path of the compiled CLI entry point, for generated scripts. */
export function getCliEntryPath(): string {
  return path.resolve(__dirname, '..', 'cli.js');
}

export interface EcosystemOptions {
  dataDir: string;
  port: number;
  serverName: string;
}

/**
 * Escapes a value for embedding in a single-quoted JavaScript string literal.
 *
 * Paths reach the generated ecosystem verbatim, and on Windows they carry
 * backslashes that would otherwise be read as escape sequences.
 */
function forSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function generateEcosystem(options: EcosystemOptions): string {
  const entryPath = forSingleQuotes(getServerEntryPath());
  const resolvedDataDir = forSingleQuotes(canonicalDataDir(options.dataDir));
  // Server names are free text, so this has to survive both the double quotes
  // that delimit it inside `args` and the single quotes around `args` itself.
  const serverName = forSingleQuotes(options.serverName.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
  // Pinning the interpreter to the Node running this CLI, instead of letting
  // PM2 resolve `node` from the daemon's environment. The daemon is a
  // long-lived process that keeps the Node it was started with: upgrading Node
  // and removing the old build left it unable to spawn anything at all, which
  // PM2 still reported as `online` with no pid, so the port was closed while
  // `monky status` claimed the server was up (#522). It also kept the server on
  // an old Node even when the spawn worked — fatal now that mediasoup requires
  // Node 22+. The file is rewritten on every start/restart, so this re-pins
  // itself whenever the operator switches versions.
  const interpreter = resolveInterpreter();
  const interpreterLine = interpreter ? `\n    interpreter: '${forSingleQuotes(interpreter)}',` : '';
  return `module.exports = {
  apps: [{
    name: '${getPm2ProcessName(options.dataDir)}',
    script: '${entryPath}',${interpreterLine}
    args: '--data "${resolvedDataDir}" --port ${options.port} --name "${serverName}"',
    cwd: '${resolvedDataDir}',
    autorestart: true,
    shutdown_with_message: true,
    kill_timeout: ${LIMITS.SHUTDOWN_GRACE_MS + 3500},
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
`;
}

/**
 * Writes the ecosystem file, replacing the pre-ESM `.js` variant.
 *
 * `monky start`, `monky restart` and `monky config set port` all need the file
 * refreshed before handing control to PM2, so they share this single writer.
 */
export function writeEcosystem(options: EcosystemOptions): string {
  const ecosystemPath = getEcosystemPath(options.dataDir);
  fs.writeFileSync(ecosystemPath, generateEcosystem(options), 'utf8');

  const legacyEcosystemPath = path.join(options.dataDir, 'ecosystem.config.js');
  if (fs.existsSync(legacyEcosystemPath)) {
    try {
      fs.unlinkSync(legacyEcosystemPath);
    } catch {}
  }

  return ecosystemPath;
}
