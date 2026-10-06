import { Permission, ProtocolErrorCode, forumListSchema, forumCreatePostSchema, forumUpdatePostSchema, forumDeletePostSchema,
  type ChannelSummary, type ForumListResult, type ForumPostSaved } from '@monky/shared';
import type { ChannelService } from './ChannelService';
import type { PermissionService } from './PermissionService';
import type { ChatService } from './ChatService';
import type { SqliteForumRepository } from '../../infrastructure/database/SqliteForumRepository';

export class ForumError extends Error {
  constructor(message: string, readonly code = ProtocolErrorCode.FORUM_INVALID) { super(message); }
}

export class ForumService {
  constructor(
    private readonly repository: SqliteForumRepository,
    private readonly channels: ChannelService,
    private readonly permissions: PermissionService,
    private readonly chat: ChatService,
    private readonly prepareChannelDeletion?: (channelId: string) => (() => void),
  ) {}

  async canRead(userId: string, channelId: string): Promise<boolean> {
    return this.channels.canUserAccessChannel(userId, channelId, Permission.READ_MESSAGES);
  }

  async requireAccess(userId: string, channelId: string, write = false): Promise<ChannelSummary> {
    const channel = await this.channels.getChannelSummary(channelId);
    if (!channel || !await this.canRead(userId, channelId) ||
        (write && !await this.channels.canUserAccessChannel(userId, channelId, Permission.SEND_MESSAGES))) {
      throw new ForumError('Forum unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    return channel;
  }

  async list(userId: string, payload: unknown, current: () => boolean): Promise<ForumListResult> {
    const parsed = forumListSchema.safeParse(payload);
    if (!parsed.success) throw new ForumError('Invalid forum query.');
    const channel = await this.requireAccess(userId, parsed.data.channelId);
    if (channel.type !== 'FORUM') throw new ForumError('Not a forum.');
    if (!current()) throw new ForumError('Access changed.', ProtocolErrorCode.PERMISSION_DENIED);
    const rows = this.repository.list(channel.id, parsed.data.query ?? '', parsed.data.sort, parsed.data.offset);
    return { channelId: channel.id, posts: rows.slice(0, 25), hasMore: rows.length > 25, nextOffset: parsed.data.offset + Math.min(rows.length, 25) };
  }

  async create(userId: string, payload: unknown, current: () => boolean): Promise<ForumPostSaved> {
    const parsed = forumCreatePostSchema.safeParse(payload);
    if (!parsed.success) throw new ForumError('Invalid forum post.');
    const { id, channelId, title, content, attachmentIds = [] } = parsed.data;
    const forum = await this.requireAccess(userId, channelId, true);
    if (forum.type !== 'FORUM') throw new ForumError('Not a forum.');
    if (attachmentIds.length && !await this.channels.canUserAccessChannel(userId, channelId, Permission.ATTACH_FILES)) {
      throw new ForumError('Attachment permission required.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    if (!current()) throw new ForumError('Access changed.', ProtocolErrorCode.PERMISSION_DENIED);
    const existing = this.repository.get(id);
    if (existing) {
      if (existing.forumId !== channelId || existing.authorId !== userId || !existing.firstMessageId) {
        throw new ForumError('Post identifier unavailable.');
      }
      return { post: existing };
    }
    this.repository.create(id, forum, userId, title, Date.now());
    try {
      if (!this.repository.moveAttachments(attachmentIds, userId, channelId, id)) throw new ForumError('Attachment unavailable.');
      const result = await this.chat.sendMessage(userId, id, content, attachmentIds, undefined, undefined, undefined, current);
      if (!result.success || !result.message) throw new ForumError(result.errorMessage ?? 'Could not create post.', result.errorCode);
      const post = this.repository.get(id);
      if (!post) throw new ForumError('Post unavailable.');
      return { post, message: result.message };
    } catch (error) {
      this.repository.restoreAttachments(userId, id, channelId);
      this.repository.delete(id);
      throw error;
    }
  }

  async update(userId: string, payload: unknown, current: () => boolean): Promise<ForumPostSaved> {
    const parsed = forumUpdatePostSchema.safeParse(payload);
    if (!parsed.success) throw new ForumError('Invalid forum update.');
    await this.requireAccess(userId, parsed.data.channelId);
    const post = this.repository.get(parsed.data.channelId);
    if (!post) throw new ForumError('Post unavailable.');
    const manager = await this.permissions.checkPermission(userId, Permission.MANAGE_CHANNELS);
    const author = post.authorId === userId;
    const editsTitle = parsed.data.title !== undefined;
    const moderates = parsed.data.pinned !== undefined || parsed.data.locked !== undefined;
    const changesClosed = parsed.data.closed !== undefined;
    if ((editsTitle && !author && !manager) || (moderates && !manager) || (changesClosed && !author)) {
      throw new ForumError('Permission denied.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    if (!current()) throw new ForumError('Access changed.', ProtocolErrorCode.PERMISSION_DENIED);
    this.repository.update(parsed.data);
    const updated = this.repository.get(post.channelId);
    if (!updated) throw new ForumError('Post unavailable.');
    return { post: updated };
  }

  async delete(userId: string, payload: unknown, current: () => boolean): Promise<ForumPostSaved> {
    const parsed = forumDeletePostSchema.safeParse(payload);
    if (!parsed.success) throw new ForumError('Invalid forum deletion.');
    await this.requireAccess(userId, parsed.data.channelId);
    const post = this.repository.get(parsed.data.channelId);
    if (!post) throw new ForumError('Post unavailable.');
    const manager = await this.permissions.checkPermission(userId, Permission.MANAGE_CHANNELS);
    if (!manager && post.authorId !== userId) {
      throw new ForumError('Permission denied.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    if (!current()) throw new ForumError('Access changed.', ProtocolErrorCode.PERMISSION_DENIED);
    const cleanup = this.prepareChannelDeletion?.(post.channelId);
    const deleted = await this.channels.deleteChannel(post.channelId);
    if (!deleted.success) {
      throw new ForumError(deleted.errorMessage ?? 'Post unavailable.', deleted.errorCode ?? ProtocolErrorCode.FORUM_INVALID);
    }
    cleanup?.();
    return { post, deleted: true };
  }
}
