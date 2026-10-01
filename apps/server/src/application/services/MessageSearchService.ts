import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MESSAGE_SEARCH_PAGE_SIZE, Permission, ProtocolErrorCode, messageSearchSchema,
  type MessageSearchFilters, type MessageSearchResultPayload } from '@monky/shared';
import type { IMessageRepository } from '../../domain/repositories';
import type { MessageRecord } from '../../domain/entities';
import type { SqliteMessageSearchRepository, SearchPosition } from '../../infrastructure/database/SqliteMessageSearchRepository';
import type { ChannelService } from './ChannelService';
import type { PermissionService } from './PermissionService';
import type { ChatService } from './ChatService';

export class MessageSearchError extends Error {
  constructor(public readonly code: ProtocolErrorCode, message: string) { super(message); }
}

export class MessageSearchService {
  private readonly cursorKey = randomBytes(32);

  constructor(
    private readonly searchRepo: SqliteMessageSearchRepository,
    private readonly messageRepo: IMessageRepository,
    private readonly channels: Pick<ChannelService, 'listChannels' | 'canUserAccessChannel'>,
    private readonly permissions: Pick<PermissionService, 'checkPermission' | 'getRoleAccessVersion'>,
    private readonly chat: Pick<ChatService, 'hydrateMessages'>,
    /** Must advance on channel visibility, membership and role changes, before async writes. */
    private readonly accessVersion: () => number | null,
  ) {}

  public version(): string | null {
    const role = this.permissions.getRoleAccessVersion();
    const access = this.accessVersion();
    return role === null || access === null ? null : `${access}:${role}`;
  }

  public contentVersion(): number { return this.searchRepo.getRevision(); }

  public async search(userId: string, input: unknown, current = () => true): Promise<MessageSearchResultPayload> {
    const parsed = messageSearchSchema.safeParse(input);
    if (!parsed.success) throw new MessageSearchError(ProtocolErrorCode.MESSAGE_SEARCH_INVALID, 'Invalid message search.');
    const filters = parsed.data;
    const version = this.version();
    const assertCurrent = () => {
      if (version === null || version !== this.version() || !current()) {
        throw new MessageSearchError(ProtocolErrorCode.PERMISSION_DENIED, 'Message search access changed.');
      }
    };
    assertCurrent();
    if (!(await this.permissions.checkPermission(userId, Permission.READ_MESSAGES))) {
      throw new MessageSearchError(ProtocolErrorCode.PERMISSION_DENIED, 'Message search is not permitted.');
    }
    const candidates = (await this.channels.listChannels()).filter(channel =>
      (channel.type === 'TEXT' || channel.type === 'VOICE') &&
      (!filters.channelIds.length || filters.channelIds.includes(channel.id)));
    const accessible = await Promise.all(candidates.map(async channel =>
      await this.channels.canUserAccessChannel(userId, channel.id) ? channel.id : null));
    const channelIds = accessible.filter((id): id is string => id !== null).sort();
    assertCurrent();
    const binding = this.binding(userId, filters, channelIds);
    const position = filters.cursor ? this.decodeCursor(filters.cursor, binding) : undefined;
    const revision = this.searchRepo.getRevision();
    const canManageServer = await this.permissions.checkPermission(userId, Permission.MANAGE_SERVER);
    assertCurrent();
    const rows = this.searchRepo.search(
      filters, channelIds, userId, canManageServer, MESSAGE_SEARCH_PAGE_SIZE + 1, position,
    );
    const total = this.searchRepo.count(filters, channelIds, userId, canManageServer);
    const page = rows.slice(0, MESSAGE_SEARCH_PAGE_SIZE);
    const records = await Promise.all(page.map(row => this.messageRepo.findById(row.id)));
    const messages = await this.chat.hydrateMessages(
      records.filter((record): record is MessageRecord => record !== null && !record.deletedAt),
      userId,
    );
    if (!(await this.permissions.checkPermission(userId, Permission.READ_MESSAGES))) {
      throw new MessageSearchError(ProtocolErrorCode.PERMISSION_DENIED, 'Message search is not permitted.');
    }
    const stillAccessible = await Promise.all(channelIds.map(id => this.channels.canUserAccessChannel(userId, id)));
    assertCurrent();
    if (stillAccessible.some(allowed => !allowed) || revision !== this.searchRepo.getRevision()) {
      throw new MessageSearchError(ProtocolErrorCode.PERMISSION_DENIED, 'Message search changed; search again.');
    }
    const last = page.at(-1);
    return {
      messages, total,
      ...(rows.length > MESSAGE_SEARCH_PAGE_SIZE && last ? { nextCursor: this.encodeCursor(last, binding) } : {}),
    };
  }

  private binding(userId: string, filters: MessageSearchFilters, channels: string[]): string {
    const { cursor: _cursor, ...query } = filters;
    return createHash('sha256').update(JSON.stringify([userId, query, channels])).digest('hex');
  }

  private encodeCursor(position: SearchPosition, binding: string): string {
    const payload = Buffer.from(JSON.stringify([position.createdAt, position.id, binding])).toString('base64url');
    return `${payload}.${createHmac('sha256', this.cursorKey).update(payload).digest('base64url')}`;
  }

  private decodeCursor(cursor: string, binding: string): SearchPosition {
    const invalid = () => new MessageSearchError(ProtocolErrorCode.MESSAGE_SEARCH_INVALID, 'Invalid message search cursor; search again.');
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra !== undefined) throw invalid();
    const expected = createHmac('sha256', this.cursorKey).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
    let value: unknown;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw invalid(); }
    if (!Array.isArray(value) || value.length !== 3 || !Number.isSafeInteger(value[0])
      || typeof value[1] !== 'string' || value[2] !== binding) throw invalid();
    return { createdAt: value[0] as number, id: value[1] };
  }
}
