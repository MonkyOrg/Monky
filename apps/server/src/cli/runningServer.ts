import { findLiveServerLock } from '../infrastructure/lifecycle/serverLock';
import { findLegacyProcessFor, findPm2Process, getPm2ProcessName, Pm2Process } from './pm2';
import { t } from './i18n/index';

/**
 * A server that owns a data directory right now: managed by PM2, or revealed
 * only by its `server.lock` (hosted by the desktop app or started by hand).
 */
export type RunningServer =
  | { via: 'pm2'; process: string; pid: number | null }
  | { via: 'lock'; pid: number; lockPath: string };

/** Statuses in which PM2 runs the process or is about to (re)spawn it. */
const PM2_ACTIVE_STATUSES = new Set(['online', 'launching', 'waiting restart', 'stopping']);

export function isPm2ProcessActive(entry: Pm2Process | null): boolean {
  const status = entry?.pm2_env?.status;
  if (!entry || !status || !PM2_ACTIVE_STATUSES.has(status)) return false;
  // An "online" entry without a pid never spawned (#522): nothing holds the database.
  return status !== 'online' || Boolean(entry.pid);
}

/** The PM2 process actually running this server, the pre-registry name included. */
export function findOnlinePm2Process(dataDir: string): Pm2Process | null {
  const entry = findPm2Process(getPm2ProcessName(dataDir)) ?? findLegacyProcessFor(dataDir);
  return entry?.pm2_env?.status === 'online' && entry.pid ? entry : null;
}

export function findRunningServer(dataDir: string): RunningServer | null {
  const entry = findPm2Process(getPm2ProcessName(dataDir)) ?? findLegacyProcessFor(dataDir);
  if (entry && isPm2ProcessActive(entry)) {
    return { via: 'pm2', process: entry.name ?? getPm2ProcessName(dataDir), pid: entry.pid || null };
  }
  const lock = findLiveServerLock(dataDir);
  return lock ? { via: 'lock', pid: lock.pid, lockPath: lock.path } : null;
}

export function describeRunningServer(server: RunningServer): string {
  if (server.via === 'pm2') {
    const process = server.pid ? `${server.process}, PID ${server.pid}` : server.process;
    return t('guard.serverRunningPm2', { process });
  }
  return `${t('guard.serverRunningOther', { pid: server.pid })}\n${t('guard.staleLockHint', { path: server.lockPath })}`;
}

/**
 * Refuses a database write while a server holds the directory: it keeps the
 * database in memory and would overwrite the change on its next save.
 */
export function assertServerStopped(dataDir: string): void {
  const running = findRunningServer(dataDir);
  if (running) throw new Error(describeRunningServer(running));
}
