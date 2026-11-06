import { sha256 } from '@noble/hashes/sha2.js';
import {
  BOT_STORAGE_LIMITS, BotDeviceStorageEngine, BotDeviceStorageError, BotScreenStorageRateLimit, answerBotScreenStorageRequest,
  bindBotScreenStorage, botScreenStorageState,
  type BotDeviceStorageBackend, type BotDeviceStorageFile, type BotDeviceStorageGrant, type BotDeviceStorageScope,
  type BotScreenStorageBinding,
} from '@monky/shared';
import type { BotStorageApi } from '../api';
import {
  deleteRecord, deleteRecordsWithPrefix, listRecordKeysWithPrefix, readRecord, writeRecord,
} from './webStorage';

/**
 * Bot storage "on this computer" for the web version (#861): the same rules as the
 * desktop, over IndexedDB of the app's origin. Miniapps run on another origin and
 * only reach it through `documentState`/`documentRequest`, like on the desktop.
 *
 * Records: `bot-storage/<scope>/index` and `bot-storage/<scope>/objects/<file>`.
 * Each record is written by one IndexedDB request, so a reader sees the old value or the new one.
 */
const PREFIX = 'bot-storage/';

const scopePrefix = (scopeId: string): string => `${PREFIX}${scopeId}/`;
const indexKey = (scopeId: string): string => `${scopePrefix(scopeId)}index`;
const objectsPrefix = (scopeId: string): string => `${scopePrefix(scopeId)}objects/`;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const indexedDbBackend: BotDeviceStorageBackend = {
  scopeId: (identity) => hex(sha256(new TextEncoder().encode(identity))),
  randomId: () => crypto.randomUUID(),
  initialize: () => Promise.resolve(),
  async scopes() {
    const names = new Set<string>();
    for (const key of await listRecordKeysWithPrefix(PREFIX)) names.add(key.slice(PREFIX.length).split('/')[0]);
    return [...names];
  },
  async hasScope(scopeId) {
    return (await listRecordKeysWithPrefix(scopePrefix(scopeId))).length > 0;
  },
  async readIndex(scopeId) {
    const index: unknown = await readRecord(indexKey(scopeId));
    if (index !== undefined) return index;
    // The index is written last: without one, the first save stopped midway and nothing here was ever stored.
    await deleteRecordsWithPrefix(scopePrefix(scopeId));
    return null;
  },
  async writeIndex(scopeId: string, index: BotDeviceStorageFile) {
    await writeRecord(indexKey(scopeId), index);
  },
  async removeUnreferenced(scopeId, referenced) {
    const prefix = objectsPrefix(scopeId);
    for (const key of await listRecordKeysWithPrefix(prefix)) {
      if (!referenced.has(key.slice(prefix.length))) await indexedDbBackend.removeObject(scopeId, key.slice(prefix.length));
    }
  },
  async writeObject(scopeId, file, bytes) {
    // A copy of exactly these bytes: a view would store its whole underlying buffer.
    await writeRecord(`${objectsPrefix(scopeId)}${file}`, bytes.slice());
  },
  async readObject(scopeId, file) {
    const bytes: unknown = await readRecord(`${objectsPrefix(scopeId)}${file}`);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > BOT_STORAGE_LIMITS.objectBytes) {
      throw new BotDeviceStorageError('failed');
    }
    return bytes;
  },
  async removeObject(scopeId, file) {
    try {
      await deleteRecord(`${objectsPrefix(scopeId)}${file}`);
    } catch (error) {
      console.warn('[Bot storage] Could not remove a record that is no longer used.', error);
    }
  },
  async removeScope(scopeId) {
    await deleteRecordsWithPrefix(scopePrefix(scopeId));
  },
};

const listeners = new Set<(scopeId: string) => void>();
const bindings = new Map<string, BotScreenStorageBinding>();
const rates = new BotScreenStorageRateLimit();
let engine: BotDeviceStorageEngine | null = null;

function storage(): BotDeviceStorageEngine {
  engine ??= new BotDeviceStorageEngine(indexedDbBackend, (scopeId) => {
    for (const listener of [...listeners]) listener(scopeId);
  });
  return engine;
}

/** Applies the choice made when opening a miniapp document; it lasts until the document is removed. */
export async function bindWebBotScreenStorage(
  url: string, choice: { scope: BotDeviceStorageScope; grant: BotDeviceStorageGrant },
): Promise<void> {
  bindings.set(url, await bindBotScreenStorage(storage(), choice));
}

/** Removing the document (leaving the miniapp) ends whatever it was allowed to store. */
export function releaseWebBotScreenStorage(url: string): void {
  bindings.delete(url);
}

export const webBotStorage: BotStorageApi = {
  documentState: (url) => botScreenStorageState(storage(), bindings.get(url) ?? null),
  documentRequest: (url, request) =>
    answerBotScreenStorageRequest(storage(), bindings.get(url) ?? null, request, () => rates.allow(url)),
  list: () => storage().list(),
  get: (scope) => storage().entry(scope),
  setDecision: (scope, decision) => storage().setDecision(scope, decision),
  setQuota: (scope, maxBytes) => storage().setQuota(scope, maxBytes),
  clear: (scopeId) => storage().clear(scopeId),
  forget: (scopeId) => storage().forget(scopeId),
  onChanged: (callback) => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  },
};

/** Leaving the account removes what every bot kept in this browser, after the operations in progress end. */
export async function wipeWebBotStorage(): Promise<void> {
  const current = engine;
  engine = null;
  bindings.clear();
  rates.clear();
  await current?.dispose();
  await deleteRecordsWithPrefix(PREFIX);
}
