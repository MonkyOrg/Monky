import {
  MessageType, ProtocolErrorCode, botStorageContentTypeSchema, botStorageDeletedSchema, botStorageGetResultSchema,
  botStorageKeySchema, botStorageListResultSchema, botStorageListSchema, botStorageObjectInfoSchema, botStoragePutSchema,
  botStorageUsageSchema,
  type BotStorageList, type BotStorageListResult, type BotStorageObjectInfo, type BotStorageUsage,
} from '@monky/shared';
import { BotRequestError } from './requestError';

export interface BotStoredObject extends BotStorageObjectInfo {
  data: Uint8Array;
}

export interface BotStoragePutOptions {
  contentType?: string;
  /**
   * For saves nobody asked for, such as an autosave: a full storage resolves `null`
   * instead of rejecting, so the activity goes on. People see the warning in Monky.
   */
  autosave?: boolean;
}

/** Objects this bot keeps on one Monky server, private to the bot (`server_storage`). */
export interface BotStorage {
  get(key: string): Promise<BotStoredObject | null>;
  put(key: string, data: Uint8Array | ArrayBuffer | string, options?: BotStoragePutOptions): Promise<BotStorageObjectInfo | null>;
  delete(key: string): Promise<boolean>;
  list(options?: BotStorageList): Promise<BotStorageListResult>;
  usage(): Promise<BotStorageUsage>;
}

export interface BotStorageAdapter {
  /** Rejects when the connection cannot use storage, before anything is sent. */
  request(type: MessageType, payload: unknown, timeoutMs: number): Promise<unknown>;
}

/** Large objects travel in one message; give slow links time to carry them. */
const TRANSFER_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 15_000;

function bytes(data: Uint8Array | ArrayBuffer | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Storage data must be a Uint8Array, an ArrayBuffer or a string.');
}

export function createBotStorage(adapter: BotStorageAdapter): BotStorage {
  return Object.freeze({
    async get(key: string): Promise<BotStoredObject | null> {
      const parsedKey = botStorageKeySchema.parse(key);
      const result = botStorageGetResultSchema.parse(
        await adapter.request(MessageType.BOT_STORAGE_GET, { key: parsedKey }, TRANSFER_TIMEOUT_MS),
      );
      if (result.key !== parsedKey) throw new Error('The storage response addresses another key.');
      if (!result.object) return null;
      const { data, ...info } = result.object;
      return { ...info, data: Buffer.from(data, 'base64') };
    },
    async put(key: string, data: Uint8Array | ArrayBuffer | string, options: BotStoragePutOptions = {}): Promise<BotStorageObjectInfo | null> {
      const payload = botStoragePutSchema.parse({
        key, data: bytes(data).toString('base64'),
        ...(options.contentType === undefined ? {} : { contentType: botStorageContentTypeSchema.parse(options.contentType) }),
      });
      try {
        const saved = botStorageObjectInfoSchema.parse(await adapter.request(MessageType.BOT_STORAGE_PUT, payload, TRANSFER_TIMEOUT_MS));
        if (saved.key !== payload.key) throw new Error('The storage response addresses another key.');
        return saved;
      } catch (error) {
        if (options.autosave && error instanceof BotRequestError && error.code === ProtocolErrorCode.STORAGE_FULL) return null;
        throw error;
      }
    },
    async delete(key: string): Promise<boolean> {
      const parsedKey = botStorageKeySchema.parse(key);
      const result = botStorageDeletedSchema.parse(await adapter.request(MessageType.BOT_STORAGE_DELETE, { key: parsedKey }, QUERY_TIMEOUT_MS));
      if (result.key !== parsedKey) throw new Error('The storage response addresses another key.');
      return result.deleted;
    },
    async list(options: BotStorageList = {}): Promise<BotStorageListResult> {
      const request = botStorageListSchema.parse(options);
      const result = botStorageListResultSchema.parse(await adapter.request(MessageType.BOT_STORAGE_LIST, request, QUERY_TIMEOUT_MS));
      const prefix = request.prefix;
      if (prefix && result.objects.some((object) => !object.key.startsWith(prefix))) {
        throw new Error('The storage listing returned keys outside the prefix.');
      }
      return result;
    },
    async usage(): Promise<BotStorageUsage> {
      return botStorageUsageSchema.parse(await adapter.request(MessageType.BOT_STORAGE_USAGE, {}, QUERY_TIMEOUT_MS));
    },
  });
}
