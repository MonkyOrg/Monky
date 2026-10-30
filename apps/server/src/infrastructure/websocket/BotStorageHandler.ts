import { serverMessage,
  BOT_STORAGE_LIMITS, MessageType, ProtocolErrorCode, botStorageClearSchema, botStorageInfoGetSchema, botStorageKeyRequestSchema,
  botStorageLimitUpdateSchema, botStorageUsageRequestSchema,
  type BotPermissions, type BotStorageCapability, type BotStorageInfo, type ServerMessage, type ServerAuditChange, type ServerMessageArgs,
} from '@monky/shared';
import type { BotInteractionSession } from './BotInteractionHandler';
import { BotStorageError, type BotStorageService } from '../../application/services/BotStorageService';
import { toProtocolError } from './protocolErrors';

export interface BotStorageTransport<S extends BotInteractionSession> {
  /** For a bot this also requires its current `server_storage` grant. */
  isCurrent(session: S): boolean;
  send(session: S, message: ServerMessage): void;
  permissions(botId: string): BotPermissions | undefined;
  /** Sends its own error when refused; the returned check must still pass before acting. */
  authorizeManagement(session: S, requestId?: string): Promise<(() => boolean) | undefined>;
  /** Whether this person may see the bot's server storage (MANAGE_BOTS); answers no error. */
  canManage(session: S): Promise<boolean>;
  audit(session: S, botId: string, changes: ServerAuditChange[]): Promise<void>;
}

interface RateWindow { start: number; count: number }

const BOT_OPERATIONS = new Set<MessageType>([
  MessageType.BOT_STORAGE_PUT, MessageType.BOT_STORAGE_GET, MessageType.BOT_STORAGE_DELETE,
  MessageType.BOT_STORAGE_LIST, MessageType.BOT_STORAGE_USAGE,
]);

/**
 * Bots manage their own objects. People who manage bots see the server usage, set the limit and clear it;
 * everyone else only learns whether the bot may ask to store data on their own computer.
 */
export class BotStorageHandler<S extends BotInteractionSession> {
  private readonly rate = new WeakMap<S, RateWindow>();
  private closed = false;

  constructor(private readonly storage: BotStorageService, private readonly transport: BotStorageTransport<S>) {}

  async handle(session: S, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    if (this.closed || !session.user || !this.transport.isCurrent(session)) return;
    try {
      if (!session.protocol?.features.includes('bot-storage')) {
        throw new BotStorageError(ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Update to use bot storage.');
      }
      if (!this.allow(session)) {
        throw new BotStorageError(ProtocolErrorCode.RATE_LIMITED, 'Too many storage operations. Try again in a moment.');
      }
      if ((session.isBot === true) !== BOT_OPERATIONS.has(type)) {
        throw new BotStorageError(ProtocolErrorCode.PERMISSION_DENIED, 'This storage operation is not available to this connection.');
      }
      if (session.isBot) await this.handleBot(session, type, payload, requestId);
      else await this.handleMember(session, type, payload, requestId);
    } catch (error) {
      this.fail(session, error, requestId);
    }
  }

  close(): void {
    this.closed = true;
  }

  private requireBot(botId: string): BotPermissions {
    const permissions = this.transport.permissions(botId);
    if (!permissions) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
    return permissions;
  }

  private info(botId: string, manager: boolean): BotStorageInfo {
    const permissions = this.requireBot(botId);
    const state = (capability: BotStorageCapability) => {
      const requested = permissions.requested?.includes(capability) === true;
      return { requested, granted: requested && permissions.granted.includes(capability) };
    };
    return {
      botId, server: manager ? { ...state('server_storage'), usage: this.storage.usage(botId) } : null, device: state('device_storage'),
    };
  }

  private async handleBot(session: S, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    const botId = session.botId;
    if (!botId) throw new BotStorageError(ProtocolErrorCode.UNAUTHORIZED, 'Unknown bot.');
    const reply = (...message: ServerMessageArgs): void => {
      // A grant revoked while the bytes were moving still ends the operation without an answer.
      if (!this.closed && this.transport.isCurrent(session)) this.transport.send(session, serverMessage(...message, requestId));
    };
    switch (type) {
      case MessageType.BOT_STORAGE_PUT:
        reply(MessageType.BOT_STORAGE_SAVED, await this.storage.put(botId, payload));
        return;
      case MessageType.BOT_STORAGE_GET: {
        const { key } = this.parseKey(payload);
        reply(MessageType.BOT_STORAGE_GET_RESULT, { key, object: await this.storage.get(botId, key) });
        return;
      }
      case MessageType.BOT_STORAGE_DELETE: {
        const { key } = this.parseKey(payload);
        reply(MessageType.BOT_STORAGE_DELETED, { key, deleted: await this.storage.delete(botId, key) });
        return;
      }
      case MessageType.BOT_STORAGE_LIST:
        reply(MessageType.BOT_STORAGE_LIST_RESULT, this.storage.list(botId, payload));
        return;
      case MessageType.BOT_STORAGE_USAGE:
        if (!botStorageUsageRequestSchema.safeParse(payload).success) {
          throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage usage request.');
        }
        reply(MessageType.BOT_STORAGE_USAGE_RESULT, this.storage.usage(botId));
        return;
      default:
        throw new BotStorageError(ProtocolErrorCode.PERMISSION_DENIED, 'Unsupported storage operation.');
    }
  }

  private async handleMember(session: S, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    const reply = (result: BotStorageInfo): void => {
      if (!this.closed && this.transport.isCurrent(session)) {
        this.transport.send(session, { type: MessageType.BOT_STORAGE_INFO, requestId, payload: result });
      }
    };
    if (type === MessageType.BOT_STORAGE_INFO_GET) {
      const parsed = botStorageInfoGetSchema.safeParse(payload);
      if (!parsed.success) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage request.');
      reply(this.info(parsed.data.botId, await this.transport.canManage(session)));
      return;
    }
    const limit = type === MessageType.BOT_STORAGE_LIMIT_UPDATE ? botStorageLimitUpdateSchema.safeParse(payload) : null;
    const clear = type === MessageType.BOT_STORAGE_CLEAR ? botStorageClearSchema.safeParse(payload) : null;
    const botId = limit?.success ? limit.data.botId : clear?.success ? clear.data.botId : null;
    if (botId === null) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage request.');
    const authorized = await this.transport.authorizeManagement(session, requestId);
    if (!authorized || !authorized()) return;
    this.requireBot(botId);
    const before = this.storage.usage(botId);
    let changes: ServerAuditChange[];
    if (limit?.success) {
      const after = await this.storage.setQuota(botId, limit.data.maxBytes);
      changes = before.maxBytes === after.maxBytes ? [] : [{ field: 'storageLimit', before: before.maxBytes, after: after.maxBytes }];
    } else {
      await this.storage.clear(botId);
      changes = before.objectCount ? [{ field: 'storageCleared', before: before.usedBytes, after: 0 }] : [];
    }
    if (changes.length) await this.transport.audit(session, botId, changes);
    if (authorized()) reply(this.info(botId, true));
  }

  private parseKey(payload: unknown): { key: string } {
    const parsed = botStorageKeyRequestSchema.safeParse(payload);
    if (!parsed.success) throw new BotStorageError(ProtocolErrorCode.BAD_REQUEST, 'Invalid storage key.');
    return parsed.data;
  }

  private allow(session: S): boolean {
    const now = Date.now();
    const window = this.rate.get(session);
    if (!window || now - window.start >= 1000) {
      this.rate.set(session, { start: now, count: 1 });
      return true;
    }
    return ++window.count <= BOT_STORAGE_LIMITS.operationsPerSecond;
  }

  private fail(session: S, error: unknown, requestId?: string): void {
    if (this.closed || !this.transport.isCurrent(session)) return;
    const payload = toProtocolError(error, { message: 'Bot storage operation failed.', category: 'BOT' });
    this.transport.send(session, { type: MessageType.SERVER_ERROR, requestId, payload });
  }
}
