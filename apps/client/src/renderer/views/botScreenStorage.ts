import {
  BOT_STORAGE_LIMITS, botDeviceStorageRequestSchema,
  type BotDeviceStorageRequest, type BotDeviceStorageResponse, type BotDeviceStorageStatus, type BotScreenStorage,
  type BotScreenStorageEntry, type BotScreenStorageUsage,
} from '@monky/shared';

/** What the document receives about its storage; never the scope, the bot or the usage. */
export interface MiniappStorageStatusMessage {
  type: 'storage-status';
  status: BotDeviceStorageStatus;
}

export interface MiniappStorageBridge {
  api: BotScreenStorage;
  attach(port: MessagePort): void;
  /** Handles storage messages from Monky; returns false for anything else. */
  receive(data: unknown): boolean;
}

/**
 * `window.monkyScreen.storage`, installed before the bot's own scripts. The source is
 * serialized into the isolated miniapp document, so it must stay self-contained: no
 * imports or module-level references (types are fine). Requests carry no server, bot
 * or account: Monky binds them to the document it created for this view.
 */
export function installMiniappStorage(objectBytes: number): MiniappStorageBridge {
  type Value = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: ArrayBuffer };
  interface Pending { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void }
  let status: BotDeviceStorageStatus = 'unavailable';
  let port: MessagePort | null = null;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(status: BotDeviceStorageStatus) => void>();
  const failure = (reason: string): Error => {
    const error = new Error(`Monky storage request failed: ${reason}.`);
    error.name = 'MonkyStorageError';
    Object.defineProperty(error, 'reason', { value: reason, enumerable: true });
    return error;
  };
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const encode = async (value: unknown): Promise<Value> => {
    let encoded: Value;
    if (typeof value === 'string') encoded = { kind: 'text', text: value };
    // Copies, so transferring to Monky never detaches the app's own buffer.
    else if (value instanceof ArrayBuffer) encoded = { kind: 'bytes', bytes: value.slice(0) };
    else if (ArrayBuffer.isView(value)) encoded = { kind: 'bytes', bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer };
    else if (value instanceof Blob) encoded = { kind: 'bytes', bytes: await value.arrayBuffer() };
    else throw new TypeError('Storage values must be text, an ArrayBuffer, a typed array or a Blob.');
    const size = encoded.kind === 'text' ? new TextEncoder().encode(encoded.text).byteLength : encoded.bytes.byteLength;
    if (size > objectBytes) throw failure('too_large');
    return encoded;
  };
  const request = (message: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    if (!port || status === 'unavailable') { reject(failure('unavailable')); return; }
    if (status === 'denied') { reject(failure('denied')); return; }
    if (pending.size >= 16) { reject(failure('busy')); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    const value = message.value;
    const transfer = record(value) && value.bytes instanceof ArrayBuffer ? [value.bytes] : [];
    try {
      port.postMessage({ ...message, type: 'storage', id }, transfer);
    } catch {
      pending.delete(id);
      reject(failure('invalid'));
    }
  });
  const api: BotScreenStorage = Object.freeze({
    get status(): BotDeviceStorageStatus { return status; },
    onStatus(callback: (status: BotDeviceStorageStatus) => void): () => void {
      if (typeof callback !== 'function') throw new TypeError('Expected a status callback.');
      listeners.add(callback);
      callback(status);
      return () => { listeners.delete(callback); };
    },
    async get(key: string): Promise<string | ArrayBuffer | null> {
      const { value } = await request({ op: 'get', key });
      if (!record(value)) return null;
      return value.kind === 'text' ? String(value.text) : value.bytes instanceof ArrayBuffer ? value.bytes : null;
    },
    async set(key: string, value: unknown, options?: { autosave?: boolean }): Promise<boolean> {
      // An autosave that cannot happen resolves false and never interrupts the app.
      const autosave = record(options) && options.autosave === true;
      if (autosave && status !== 'granted') return false;
      try {
        await request({ op: 'set', key, value: await encode(value), autosave });
        return true;
      } catch (error) {
        if (autosave) return false;
        throw error;
      }
    },
    async delete(key: string): Promise<boolean> {
      return (await request({ op: 'remove', key })).removed === true;
    },
    async list(options?: { prefix?: string }): Promise<BotScreenStorageEntry[]> {
      const { keys } = await request({ op: 'list', ...(record(options) && typeof options.prefix === 'string' ? { prefix: options.prefix } : {}) });
      return (Array.isArray(keys) ? keys : []).filter(record)
        .map((entry) => Object.freeze({ key: String(entry.key), size: Number(entry.sizeBytes), updatedAt: Number(entry.updatedAt) }));
    },
    async usage(): Promise<BotScreenStorageUsage | null> {
      const { usage } = await request({ op: 'usage' });
      if (!record(usage) || typeof usage.usedBytes !== 'number' || typeof usage.maxBytes !== 'number') return null;
      const level = usage.level;
      return level === 'ok' || level === 'near_full' || level === 'full'
        ? { usedBytes: usage.usedBytes, maxBytes: usage.maxBytes, level } : null;
    },
  });
  return {
    api,
    attach(next: MessagePort): void { port = next; },
    receive(data: unknown): boolean {
      if (!record(data)) return false;
      if (data.type === 'storage-status') {
        if (data.status !== 'unavailable' && data.status !== 'granted' && data.status !== 'denied') return true;
        const changed = status !== data.status;
        status = data.status;
        if (changed) {
          for (const callback of listeners) {
            try { callback(status); } catch (error: unknown) { console.error(error); }
          }
        }
        return true;
      }
      if (data.type !== 'storage-result') return false;
      const entry = typeof data.id === 'number' ? pending.get(data.id) : undefined;
      if (!entry || typeof data.id !== 'number') return true;
      pending.delete(data.id);
      if (data.ok === true) entry.resolve(data);
      else entry.reject(failure(typeof data.reason === 'string' ? data.reason : 'failed'));
      return true;
    },
  };
}

/** Validates a storage request from the miniapp document before it reaches the main process. */
export function readMiniappStorageRequest(data: unknown): { id: number; request: BotDeviceStorageRequest } | null {
  if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'storage' || !('id' in data) ||
      typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0) return null;
  const { type: _type, id, ...message } = data;
  const value = 'value' in message && typeof message.value === 'object' && message.value !== null &&
    'bytes' in message.value && message.value.bytes instanceof ArrayBuffer
    ? { ...message.value, bytes: new Uint8Array(message.value.bytes) } : 'value' in message ? message.value : undefined;
  const parsed = botDeviceStorageRequestSchema.safeParse(value === undefined ? message : { ...message, value });
  return parsed.success ? { id, request: parsed.data } : null;
}

/** The answer posted back to the document; bytes are transferred, never shared. */
export function miniappStorageResult(id: number, response: BotDeviceStorageResponse): { message: object; transfer: Transferable[] } {
  const usage = response.usage ? { usedBytes: response.usage.usedBytes, maxBytes: response.usage.maxBytes, level: response.usage.level } : null;
  if (!response.ok) return { message: { type: 'storage-result', id, ok: false, reason: response.reason, usage }, transfer: [] };
  switch (response.op) {
    case 'get': {
      if (!response.value) return { message: { type: 'storage-result', id, ok: true, value: null, usage }, transfer: [] };
      if (response.value.kind === 'text') {
        return { message: { type: 'storage-result', id, ok: true, value: { kind: 'text', text: response.value.text }, usage }, transfer: [] };
      }
      const bytes = response.value.bytes.slice().buffer;
      return { message: { type: 'storage-result', id, ok: true, value: { kind: 'bytes', bytes }, usage }, transfer: [bytes] };
    }
    case 'remove':
      return { message: { type: 'storage-result', id, ok: true, removed: response.removed, usage }, transfer: [] };
    case 'list':
      return { message: { type: 'storage-result', id, ok: true, keys: response.keys, usage }, transfer: [] };
    default:
      return { message: { type: 'storage-result', id, ok: true, usage }, transfer: [] };
  }
}

export const MINIAPP_STORAGE_OBJECT_BYTES = BOT_STORAGE_LIMITS.objectBytes;

export function storageStatusMessage(status: BotDeviceStorageStatus): MiniappStorageStatusMessage {
  return { type: 'storage-status', status };
}
