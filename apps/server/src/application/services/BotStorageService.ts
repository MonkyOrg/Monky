import {
  BOT_STORAGE_LIMITS, ProtocolErrorCode, base64ByteLength, botStorageKeySchema, botStorageLevel, botStorageListSchema,
  botStoragePutSchema, botStorageQuotaSchema,
  type BotStorageLevel, type BotStorageListResult, type BotStorageObject, type BotStorageObjectInfo, type BotStorageUsage,
} from '@monky/shared';
import type { BotStorageObjectRecord, IBotStorageRepository } from '../../domain/repositories';
import type { BotStorageFileStore } from '../../infrastructure/security/BotStorageFileStore';
import { Logger } from '../../infrastructure/logger/Logger';
import { ServiceError } from '../errors';

export class BotStorageError extends ServiceError {}

function info(record: BotStorageObjectRecord): BotStorageObjectInfo {
  return { key: record.key, sizeBytes: record.sizeBytes, contentType: record.contentType, updatedAt: record.updatedAt };
}

/**
 * Objects a bot keeps on this server (`server_storage`). Writes are serialized per bot so
 * the quota check and the saved row always see the same usage. A full storage refuses
 * the write; nothing is evicted, unlike chat attachments, because these are save data.
 */
export class BotStorageService {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Bots whose last write did not fit: they show as full until space is freed or added. */
  private readonly refused = new Set<string>();
  private readonly levels = new Map<string, BotStorageLevel>();
  private levelChanged: (botId: string, usage: BotStorageUsage) => void = () => undefined;
  private closed = false;

  constructor(private readonly repository: IBotStorageRepository, private readonly files: BotStorageFileStore) {}

  /** Called when a bot's storage becomes nearly full, full, or leaves those levels. */
  setLevelListener(listener: (botId: string, usage: BotStorageUsage) => void): void {
    this.levelChanged = listener;
  }

  usage(botId: string): BotStorageUsage {
    const { usedBytes, objectCount } = this.repository.usage(botId);
    const maxBytes = this.repository.quota(botId) ?? BOT_STORAGE_LIMITS.serverDefaultBytes;
    return {
      usedBytes, maxBytes, objectCount, maxObjects: BOT_STORAGE_LIMITS.serverObjects,
      level: botStorageLevel(usedBytes, maxBytes, this.refused.has(botId)),
    };
  }

  put(botId: string, input: unknown): Promise<BotStorageObjectInfo> {
    const parsed = botStoragePutSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage object.'));
    const { key, data, contentType } = parsed.data;
    return this.serial(botId, async () => {
      const bytes = Buffer.from(data, 'base64');
      if (bytes.byteLength !== base64ByteLength(data)) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage data.');
      const previous = this.repository.find(botId, key);
      const usage = this.usage(botId);
      const usedBytes = usage.usedBytes - (previous?.sizeBytes ?? 0) + bytes.byteLength;
      if (usedBytes > usage.maxBytes || usage.objectCount + (previous ? 0 : 1) > BOT_STORAGE_LIMITS.serverObjects) {
        this.refused.add(botId);
        this.publish(botId);
        throw new BotStorageError(ProtocolErrorCode.STORAGE_FULL, 'The bot storage on this server is full.');
      }
      const filename = await this.files.write(botId, bytes);
      const record: BotStorageObjectRecord = {
        botId, key, filename, sizeBytes: bytes.byteLength, contentType: contentType ?? null, updatedAt: Date.now(),
      };
      try {
        this.repository.transaction(() => {
          if (!this.repository.botExists(botId)) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
          this.repository.save(record);
        });
      } catch (error) {
        this.files.discard(botId, filename);
        throw error;
      }
      if (previous) this.files.discard(botId, previous.filename);
      this.refused.delete(botId);
      this.publish(botId);
      return info(record);
    });
  }

  get(botId: string, keyInput: unknown): Promise<BotStorageObject | null> {
    const key = this.key(keyInput);
    if (key === null) return Promise.reject(new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage key.'));
    return this.serial(botId, async () => {
      const record = this.repository.find(botId, key);
      if (!record) return null;
      const bytes = await this.files.read(botId, record.filename);
      if (!bytes || bytes.byteLength !== record.sizeBytes) {
        // A file lost outside Monky cannot be recovered; drop the row instead of failing every read.
        Logger.warn('BOT', `Bot storage object "${key}" of ${botId} lost its file and was removed.`);
        this.repository.delete(botId, key);
        if (bytes) this.files.discard(botId, record.filename);
        this.publish(botId);
        return null;
      }
      return { ...info(record), data: bytes.toString('base64') };
    });
  }

  delete(botId: string, keyInput: unknown): Promise<boolean> {
    const key = this.key(keyInput);
    if (key === null) return Promise.reject(new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage key.'));
    return this.serial(botId, async () => {
      const record = this.repository.find(botId, key);
      if (!record) return false;
      this.repository.delete(botId, key);
      this.files.discard(botId, record.filename);
      this.refused.delete(botId);
      this.publish(botId);
      return true;
    });
  }

  list(botId: string, input: unknown): BotStorageListResult {
    const parsed = botStorageListSchema.safeParse(input);
    if (!parsed.success) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage listing.');
    const limit = parsed.data.limit ?? BOT_STORAGE_LIMITS.listPageSize;
    // One extra row tells whether another page exists.
    const records = this.repository.list(botId, parsed.data.prefix ?? '', parsed.data.after, limit + 1);
    const page = records.slice(0, limit);
    return { objects: page.map(info), next: records.length > limit ? page[page.length - 1]!.key : null };
  }

  setQuota(botId: string, maxBytes: number): Promise<BotStorageUsage> {
    const quota = botStorageQuotaSchema.safeParse(maxBytes);
    if (!quota.success) return Promise.reject(new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage limit.'));
    return this.serial(botId, async () => {
      this.repository.transaction(() => {
        if (!this.repository.botExists(botId)) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
        this.repository.setQuota(botId, quota.data);
      });
      this.refused.delete(botId);
      this.publish(botId);
      return this.usage(botId);
    });
  }

  clear(botId: string): Promise<BotStorageUsage> {
    return this.serial(botId, async () => {
      const removed = this.repository.transaction(() => this.repository.deleteAll(botId));
      for (const record of removed) this.files.discard(botId, record.filename);
      this.refused.delete(botId);
      this.publish(botId);
      return this.usage(botId);
    });
  }

  /** The bot row is gone (and its objects with it); only its files and memory remain. */
  removeBot(botId: string): void {
    this.files.discardBot(botId);
    this.refused.delete(botId);
    this.levels.delete(botId);
  }

  async reconcile(): Promise<void> {
    const removed = await this.files.reconcile(this.repository.references());
    if (removed) Logger.info('BOT', `Bot storage reconciliation removed ${removed} unreferenced file(s).`);
  }

  dispose(): void {
    this.closed = true;
    this.files.dispose();
  }

  private key(input: unknown): string | null {
    const parsed = botStorageKeySchema.safeParse(input);
    return parsed.success ? parsed.data : null;
  }

  private publish(botId: string): void {
    const usage = this.usage(botId);
    const previous = this.levels.get(botId) ?? 'ok';
    this.levels.set(botId, usage.level);
    if (previous !== usage.level) this.levelChanged(botId, usage);
  }

  private serial<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BotStorageError(ProtocolErrorCode.INTERNAL_ERROR, 'Bot storage is closed.'));
    const previous = this.queues.get(botId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(botId, tail);
    void tail.then(() => { if (this.queues.get(botId) === tail) this.queues.delete(botId); });
    return result;
  }
}
