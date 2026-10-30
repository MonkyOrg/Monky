import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '../logger/Logger';

/**
 * Marks a data directory as owned by a running server.
 *
 * The server keeps the whole database in memory and rewrites `server.db` from
 * that copy, so anything else that writes the file while it runs is silently
 * undone. The CLI reads this marker (besides PM2) to refuse such writes, which
 * also covers servers hosted by the desktop app or started by hand.
 */
export const SERVER_LOCK_FILE = 'server.lock';

const MAX_LOCK_BYTES = 4096;

export interface ProcessLockRecord {
  pid: number;
  hostname: string | null;
  bootId: string | null;
  id: string | null;
}

export interface LiveServerLock {
  pid: number;
  path: string;
}

export interface ServerLock {
  release(): void;
}

export function serverLockPath(dataDir: string): string {
  return path.join(dataDir, SERVER_LOCK_FILE);
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

/** Signal 0 only probes the process; EPERM means it exists under another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/** Linux boot id: a lock written before a reboot cannot belong to a reused PID. */
function readBootId(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function optionalString(record: object, key: string): string | null {
  const value: unknown = key in record ? Reflect.get(record, key) : undefined;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Reads a PID lock file. A missing file is `null`; content that is not a lock
 * this code wrote (every write is atomic) is also `null`, because a corrupt
 * marker must not block the operator forever.
 */
export function readProcessLock(file: string): ProcessLockRecord | null {
  let text: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || !('pid' in value) ||
      typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  return {
    pid: value.pid,
    hostname: optionalString(value, 'hostname'),
    bootId: optionalString(value, 'bootId'),
    id: optionalString(value, 'id'),
  };
}

/**
 * Whether the process that wrote a lock is still running. A lock copied from
 * another machine or left behind before a reboot names a PID that means
 * nothing here, so it is treated as stale.
 */
export function isProcessLockLive(record: ProcessLockRecord): boolean {
  if (record.hostname !== null && record.hostname !== os.hostname()) return false;
  const bootId = readBootId();
  if (record.bootId !== null && bootId !== null && record.bootId !== bootId) return false;
  return isProcessAlive(record.pid);
}

export function describeCurrentProcess(id: string = randomUUID()): ProcessLockRecord & { startedAt: number } {
  return { pid: process.pid, hostname: os.hostname(), bootId: readBootId(), id, startedAt: Date.now() };
}

/** Replaces the file in one step, so readers never see a half-written lock. */
function writeAtomically(file: string, contents: string): void {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pending, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(pending, file);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
}

/** The live server holding a data directory, if any. */
export function findLiveServerLock(dataDir: string): LiveServerLock | null {
  const file = serverLockPath(dataDir);
  const record = readProcessLock(file);
  return record && isProcessLockLive(record) ? { pid: record.pid, path: file } : null;
}

/**
 * Claims the data directory for this server until `release()`.
 *
 * Advisory only: a server always takes the lock over and never refuses to
 * start because of it, since a reused PID would otherwise keep a crashed
 * server down. A failed write only costs the CLI this extra signal.
 */
export function acquireServerLock(dataDir: string): ServerLock {
  const file = serverLockPath(dataDir);
  try {
    const previous = readProcessLock(file);
    if (previous && previous.pid !== process.pid && isProcessLockLive(previous)) {
      Logger.warn('DATABASE', `Another process (PID ${previous.pid}) is also using this data directory; taking over its server lock.`);
    }
  } catch (error) {
    Logger.warn('DATABASE', 'Could not read the previous server lock.', error);
  }

  const owner = describeCurrentProcess();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeAtomically(file, JSON.stringify(owner));
  } catch (error) {
    Logger.warn('DATABASE', 'Could not create the server lock; the CLI will rely on PM2 to detect this server.', error);
    return { release() {} };
  }

  let released = false;
  return {
    release() {
      if (released) return;
      try {
        if (readProcessLock(file)?.id === owner.id) fs.rmSync(file, { force: true });
        released = true;
      } catch (error) {
        Logger.warn('DATABASE', 'Could not remove the server lock.', error);
      }
    },
  };
}
