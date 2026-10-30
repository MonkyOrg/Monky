import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseConnection } from '../infrastructure/database/DatabaseConnection';
import {
  describeCurrentProcess,
  isProcessLockLive,
  readProcessLock,
} from '../infrastructure/lifecycle/serverLock';
import { ANSI, color, SERVER_DB_NAME } from './constants';
import { appliedMigrations, type GlobalArgs } from './context';
import { t } from './i18n/index';
import { readLocalServerPreview, resolveServerPort } from './onlineUsers';
import { getPm2ProcessName, isPm2Available, listPm2Processes } from './pm2';
import { canonicalDataDir, findServerByDataDir, getRegistryDir, type RegisteredServer } from './registry';
import { findOnlinePm2Process } from './runningServer';
import { knownServers } from './target';

/**
 * Timing of the checks after an update. A server restarted onto a new version
 * may take a while to answer, since migrations on a large database run before
 * the HTTP listener opens. Tests shorten these values.
 */
export const updateTiming = {
  startupMs: 60_000,
  /** Grace for a server whose restart command already reported failure. */
  failedRestartGraceMs: 5_000,
  pollMs: 1_000,
};

/** A server whose PM2 process was running when an update began. */
export interface RunningTarget {
  dataDir: string;
  name: string;
  port: number;
  processName: string;
  pid: number;
  /** When PM2 last (re)started it, to tell whether it runs the installed code. */
  startedAt: number | null;
}

/**
 * Servers an update must reload: the `--data` one, or every server of this
 * machine, since they all run the same global package. Stopped servers are
 * left alone.
 */
export function findRunningTargets(globalArgs: GlobalArgs): RunningTarget[] {
  if (!isPm2Available()) return [];
  const servers: RegisteredServer[] = globalArgs.dataDirSpecified
    ? [findServerByDataDir(globalArgs.dataDir) ?? { id: '', dataDir: canonicalDataDir(globalArgs.dataDir), createdAt: 0 }]
    : knownServers();
  const processes = listPm2Processes();
  return servers.flatMap((server) => {
    const entry = findOnlinePm2Process(server.dataDir, processes);
    if (!entry?.pid) return [];
    return [{
      dataDir: server.dataDir,
      name: server.name || server.dataDir,
      port: resolveServerPort(server),
      processName: entry.name ?? getPm2ProcessName(server.dataDir),
      pid: entry.pid,
      startedAt: typeof entry.pm2_env?.pm_uptime === 'number' ? entry.pm2_env.pm_uptime : null,
    }];
  });
}

/** `unchanged`: the same process still answers, so no restart happened. */
export type ServerStartOutcome = 'up' | 'unchanged' | 'down';

/**
 * Where the server answers now. A restart re-registers the port it used, and a
 * one-off `--port` from an earlier start does not survive it, so the port
 * seen before the restart can be the wrong one to probe.
 */
function currentPort(target: RunningTarget): number {
  const server = findServerByDataDir(target.dataDir);
  return server ? resolveServerPort(server) : target.port;
}

export async function waitForServer(target: RunningTarget, timeoutMs: number): Promise<ServerStartOutcome> {
  const deadline = Date.now() + timeoutMs;
  const port = currentPort(target);
  while (true) {
    const entry = findOnlinePm2Process(target.dataDir);
    if (entry?.pid && await readLocalServerPreview(port)) {
      return entry.pid === target.pid ? 'unchanged' : 'up';
    }
    if (Date.now() >= deadline) return 'down';
    await new Promise<void>((resolve) => setTimeout(resolve, updateTiming.pollMs));
  }
}

const BACKUP_DIRECTORY = 'backups';
const KEPT_BACKUPS = 3;
const BACKUP_NAME = /^server-.+-before-update-.+\.db$/;

/**
 * Copies `server.db` before a restart onto a new version, keeping the last
 * few copies. The running server replaces the file atomically, so the copy is
 * always a complete snapshot (at most one save interval old).
 */
export function backupDatabase(dataDir: string, fromVersion: string): string | null {
  const source = path.join(dataDir, SERVER_DB_NAME);
  if (!fs.existsSync(source)) return null;
  const directory = path.join(dataDir, BACKUP_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(directory, `server-${stamp}-before-update-${fromVersion.replace(/[^0-9A-Za-z.-]/g, '_')}.db`);
  const pending = `${destination}.${randomUUID()}.partial`;
  try {
    fs.copyFileSync(source, pending);
    fs.renameSync(pending, destination);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
  const backups = fs.readdirSync(directory).filter((name) => BACKUP_NAME.test(name)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEPT_BACKUPS))) {
    fs.rmSync(path.join(directory, old), { force: true });
  }
  return destination;
}

async function readAppliedMigrations(file: string): Promise<Set<string> | null> {
  try {
    const connection = await DatabaseConnection.create(file, { readOnly: true });
    try {
      return appliedMigrations(connection.getDb());
    } finally {
      connection.close();
    }
  } catch {
    return null;
  }
}

/**
 * Puts the backup back when the failed version changed the schema, which the
 * previous version may not understand. Otherwise the current file is kept: it
 * holds the last save of the previous process, newer than the backup.
 */
export async function restoreDatabaseIfMigrated(dataDir: string, backup: string): Promise<boolean> {
  const database = path.join(dataDir, SERVER_DB_NAME);
  const current = await readAppliedMigrations(database);
  const previous = await readAppliedMigrations(backup);
  if (current && previous && [...current].every((version) => previous.has(version))) return false;
  const pending = `${database}.${randomUUID()}.restore`;
  try {
    fs.copyFileSync(backup, pending);
    fs.renameSync(pending, database);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
  return true;
}

const UPDATE_LOCK_FILE = 'update.lock';
const UPDATE_LOCK_WAIT_MS = 30 * 60_000;
const UPDATE_LOCK_MAX_AGE_MS = 2 * 60 * 60_000;
const UPDATE_LOCK_WRITE_GRACE_MS = 5_000;

function lockAge(file: string): number | null {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Serializes updates on this machine. Two runs installing the same global
 * package at once (the per-server updaters of older versions all fired at
 * 4am) could leave it half-installed; the later run now waits and then finds
 * the update already done.
 */
export async function acquireUpdateLock(waitMs = UPDATE_LOCK_WAIT_MS): Promise<() => void> {
  const file = path.join(getRegistryDir(), UPDATE_LOCK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = describeCurrentProcess();
  const deadline = Date.now() + waitMs;
  let announced = false;
  while (true) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return () => {
        try {
          if (readProcessLock(file)?.id === owner.id) fs.rmSync(file, { force: true });
        } catch {
          // A lock left behind is ignored once this process has exited.
        }
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const holder = readProcessLock(file);
    const age = lockAge(file);
    const stale = age === null || age > UPDATE_LOCK_MAX_AGE_MS ||
      (holder ? !isProcessLockLive(holder) : age > UPDATE_LOCK_WRITE_GRACE_MS);
    if (stale) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(t('update.lockTimeout', { pid: holder?.pid ?? '?' }));
    if (!announced) {
      console.log(color(t('update.waitingForOtherUpdate', { pid: holder?.pid ?? '?' }), ANSI.dim));
      announced = true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, updateTiming.pollMs));
  }
}

const INSTALL_RECORD_FILE = 'cli-install.json';

export interface InstallRecord {
  version: string;
  installedAt: number;
  /** Version that was installed before, to roll back to when the new one fails. */
  previous: string | null;
}

/** When `monky update` last installed the package, to find servers still running older code. */
export function recordInstall(version: string, previous: string | null, installedAt = Date.now()): void {
  const file = path.join(getRegistryDir(), INSTALL_RECORD_FILE);
  const pending = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(pending, JSON.stringify({ version, installedAt, previous }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(pending, file);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
}

export function readInstallRecord(): InstallRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.join(getRegistryDir(), INSTALL_RECORD_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || !('version' in value) || typeof value.version !== 'string' ||
      !('installedAt' in value) || typeof value.installedAt !== 'number' || !Number.isFinite(value.installedAt)) {
    return null;
  }
  const previous = 'previous' in value && typeof value.previous === 'string' ? value.previous : null;
  return { version: value.version, installedAt: value.installedAt, previous };
}
