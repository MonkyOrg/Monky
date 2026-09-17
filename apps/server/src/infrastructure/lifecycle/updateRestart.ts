import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerShutdownReason } from '@monky/shared';
import { Logger } from '../logger/Logger';

const INTENT_FILE = 'update-restart-intent.json';
const INTENT_TTL_MS = 60_000;

interface RestartIntent {
  pid: number;
  expiresAt: number;
  id: string;
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function readIntent(file: string): RestartIntent | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) {
    throw new Error('Invalid update restart intent file.');
  }
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' ||
      !('pid' in value) || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !('expiresAt' in value) || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) ||
      !('id' in value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) ||
      Object.keys(value).length !== 3) throw new Error('Invalid update restart intent.');
  return { pid: value.pid, expiresAt: value.expiresAt, id: value.id };
}

/** PM2 sends the same shutdown signal for stop and update; bind the intent to this process only. */
export function prepareUpdateRestart(dataDir: string, pid: number): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('A running server PID is required for an update restart.');
  const file = path.join(dataDir, INTENT_FILE);
  const previous = readIntent(file);
  if (previous) {
    if (previous.expiresAt > Date.now()) throw new Error('An update restart is already pending for this server.');
    fs.unlinkSync(file);
    Logger.warn('INFO', 'Removed an expired update restart intent.');
  }
  const intent: RestartIntent = { pid, expiresAt: Date.now() + INTENT_TTL_MS, id: randomUUID() };
  fs.writeFileSync(file, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  return () => {
    const current = readIntent(file);
    if (current?.id === intent.id) fs.unlinkSync(file);
  };
}

export function consumeUpdateRestart(dataDir: string, pid = process.pid): ServerShutdownReason {
  const file = path.join(dataDir, INTENT_FILE);
  const intent = readIntent(file);
  if (!intent) return 'stopped';
  if (intent.pid !== pid || intent.expiresAt <= Date.now()) {
    Logger.warn('INFO', 'Ignored an update restart intent for a different or expired process.');
    return 'stopped';
  }
  fs.unlinkSync(file);
  return 'update';
}
