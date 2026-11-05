import { CLIENT_LOG_DEFAULTS, type ClientLogConfig, type ClientLogEntry } from '@monky/shared';
import { saveText } from './webFiles';
import { deleteRecordsWithPrefix, readRecord, readRecordsWithPrefix, writeRecord, writeRecords } from './webStorage';

/**
 * The client log of the web version (#444, #858): the same JSON lines the
 * desktop writes to files, kept in IndexedDB in small chunks per session,
 * oldest dropped first past the size limit, and exported as one text file.
 */
const PREFIX = 'logs/';
const CONFIG_RECORD = 'log-config';
const FLUSH_DELAY_MS = 2_000;
/** A tab keeps far less than the desktop's 50 MB. */
const MAX_WEB_LOG_BYTES = 5 * 1024 * 1024;

// Created on first use: nothing runs at import, so the desktop bundle drops this module.
let session: string | null = null;
let flushesOnHide = false;
let chunkIndex = 0;
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let config: ClientLogConfig | null = null;

function limit(current: ClientLogConfig): number {
  return Math.min(current.maxSizeBytes, MAX_WEB_LOG_BYTES);
}

function isConfig(value: unknown): value is ClientLogConfig {
  return typeof value === 'object' && value !== null
    && typeof Reflect.get(value, 'enabled') === 'boolean' && typeof Reflect.get(value, 'maxSizeBytes') === 'number';
}

export async function getWebLogConfig(): Promise<ClientLogConfig> {
  if (!config) {
    const stored = await readRecord(CONFIG_RECORD).catch(() => undefined);
    config = isConfig(stored) ? stored : { ...CLIENT_LOG_DEFAULTS };
  }
  return { ...config };
}

export async function setWebLogConfig(update: Partial<ClientLogConfig>): Promise<void> {
  const next = await getWebLogConfig();
  if (typeof update.enabled === 'boolean') next.enabled = update.enabled;
  if (typeof update.maxSizeBytes === 'number' && update.maxSizeBytes > 0) next.maxSizeBytes = update.maxSizeBytes;
  config = next;
  await writeRecord(CONFIG_RECORD, next);
  if (!next.enabled) pending = [];
}

/** Records one entry; lines are saved together a moment later. */
export function writeWebLog(entry: ClientLogEntry): Promise<void> {
  if (config && !config.enabled) return Promise.resolve();
  pending.push(`${JSON.stringify({ ...entry, timestamp: entry.timestamp || new Date().toISOString() })}\n`);
  if (!flushesOnHide) {
    // A tab may be closed at any moment: the lines not saved yet go then.
    flushesOnHide = true;
    window.addEventListener('pagehide', () => { void flushWebLog(); });
  }
  flushTimer ??= setTimeout(() => { void flushWebLog(); }, FLUSH_DELAY_MS);
  return Promise.resolve();
}

async function chunks(): Promise<Array<[string, string]>> {
  const records = await readRecordsWithPrefix(PREFIX);
  return [...records].flatMap(([key, value]): Array<[string, string]> => typeof value === 'string' ? [[key, value]] : [])
    .sort(([a], [b]) => a.localeCompare(b));
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

async function flushWebLog(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const current = await getWebLogConfig();
  if (!current.enabled || pending.length === 0) {
    pending = [];
    return;
  }
  const text = pending.join('');
  pending = [];
  chunkIndex += 1;
  try {
    const existing = await chunks();
    let total = existing.reduce((sum, [, chunk]) => sum + bytes(chunk), bytes(text));
    const drop: string[] = [];
    for (const [key, chunk] of existing) {
      if (total <= limit(current)) break;
      drop.push(key);
      total -= bytes(chunk);
    }
    session ??= `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    await writeRecords(new Map([[`${PREFIX}${session}/${String(chunkIndex).padStart(6, '0')}`, text]]), drop);
  } catch (error: unknown) {
    console.warn('[ClientLog] Could not keep the log in this browser.', error);
  }
}

export async function getWebLogSize(): Promise<number> {
  await flushWebLog();
  return (await chunks()).reduce((sum, [, chunk]) => sum + bytes(chunk), 0);
}

export async function clearWebLogs(): Promise<void> {
  pending = [];
  await deleteRecordsWithPrefix(PREFIX);
}

/** Every session's lines in one text file, as the desktop exports them. */
export async function exportWebLogs(): Promise<{ success: boolean; error?: string }> {
  await flushWebLog();
  const all = await chunks();
  if (all.length === 0) return { success: false, error: 'no-logs' };
  const sessions = new Map<string, string[]>();
  for (const [key, chunk] of all) {
    const name = key.slice(PREFIX.length).split('/')[0];
    sessions.set(name, [...(sessions.get(name) ?? []), chunk]);
  }
  const text = [...sessions].map(([name, parts]) => `\n--- session-${name} ---\n${parts.join('')}`).join('');
  saveText(text, `monky-logs-${new Date().toISOString().slice(0, 10)}.txt`);
  return { success: true };
}
