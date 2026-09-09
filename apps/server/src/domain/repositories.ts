import { AttachmentRecord, BotRecord, ChannelRecord, MentionRecord, MessageRecord, RoleRecord, ServerRecord, UserRecord, UserRoleRecord, VoiceRestrictions } from './entities';
import type { BotSelector } from '@monky/shared';

export interface IBotSelectorRepository {
  findById(id: string): BotSelector | undefined;
  list(botId?: string, channelId?: string): BotSelector[];
  listExpired(now: number): BotSelector[];
  countOpen(botId: string): number;
  create(selector: BotSelector): void;
  save(selector: BotSelector): void;
  /** Vote and closing-condition updates must commit together without yielding. */
  transaction<T>(operation: () => T): T;
}

export interface IServerRepository {
  getServer(): Promise<ServerRecord | null>;
  createServer(server: ServerRecord): Promise<void>;
  updateServer(server: Partial<ServerRecord>): Promise<void>;
}

export interface IUserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByClientId(clientId: string): Promise<UserRecord | null>;
  findByPublicKey(publicKey: string): Promise<UserRecord | null>;
  findByNickname(nickname: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;
  update(id: string, updates: Partial<UserRecord>): Promise<void>;
  delete(id: string): Promise<void>;
  findByIds(ids: string[]): Promise<UserRecord[]>;
  listAll(): Promise<UserRecord[]>;
  /** Registered members, which is what the membership cap counts (#403). */
  count(): Promise<number>;
}

export interface IVoiceRestrictionRepository {
  // Synchronous reads/writes keep admission and moderation atomic with the live voice roster.
  getForUser(userId: string): VoiceRestrictions;
  save(userId: string, restrictions: VoiceRestrictions): void;
}

export interface IChannelRepository {
  findById(id: string): Promise<ChannelRecord | null>;
  listByServerId(serverId: string): Promise<ChannelRecord[]>;
  create(channel: ChannelRecord): Promise<void>;
  /** Applies a partial edit; `allowedRoleIds`, when given, replaces the set (#384). */
  update(id: string, updates: Partial<Omit<ChannelRecord, 'id' | 'serverId'>>): Promise<void>;
  delete(id: string): Promise<void>;
  updatePosition(id: string, position: number): Promise<void>;
}

export interface IMessageRepository {
  createBotMessage(message: MessageRecord): Promise<MessageRecord | null>;
  setReaction(messageId: string, userId: string, emoji: string, add: boolean): Promise<'changed' | 'unchanged' | 'limit' | 'invalid'>;
  listReactions(messageIds: string[]): Promise<import('./entities').MessageReactionRecord[]>;
  create(message: MessageRecord): Promise<void>;
  findById(messageId: string): Promise<MessageRecord | null>;
  listByChannel(channelId: string, limit: number, beforeTimestamp?: number): Promise<MessageRecord[]>;
  /** Rewrites the content of a message and stamps it as edited (#504). */
  updateContent(messageId: string, content: string, editedAt: number): Promise<void>;
  /** Blanks a message's content and stamps it as deleted, keeping the row (#504). */
  markDeleted(messageId: string, deletedAt: number): Promise<void>;
  deleteByChannel(channelId: string): Promise<void>;
  countAll(): Promise<number>;
}

export interface IMentionRepository {
  add(mention: MentionRecord): Promise<void>;
  /** Distinct channel ids where the user currently has unread mentions. */
  listChannelIdsForUser(userId: string): Promise<string[]>;
  /** Clears all unread mentions for a user in a specific channel (channel opened). */
  clearForUserChannel(userId: string, channelId: string): Promise<void>;
}

export interface IAttachmentRepository {
  create(att: AttachmentRecord): Promise<void>;
  findByIds(ids: string[]): Promise<AttachmentRecord[]>;
  listByMessageIds(messageIds: string[]): Promise<AttachmentRecord[]>;
  /** Links pending uploads to a message once it is sent (#11). */
  linkToMessage(ids: string[], messageId: string): Promise<void>;
  /** Sum of size_bytes across non-evicted rows — the current storage usage. */
  sumActiveBytes(): Promise<number>;
  /** Oldest non-evicted attachments first, for FIFO eviction. */
  listOldestActive(limit: number): Promise<AttachmentRecord[]>;
  /** Marks a row evicted: clears filename and sets evicted=1 (keeps the row). */
  markEvicted(id: string): Promise<void>;
  /** Pending uploads (never linked to a message) older than a cutoff. */
  listPendingBefore(timestamp: number): Promise<AttachmentRecord[]>;
  /** Hard-deletes a row (used for pending uploads that were never linked). */
  deleteById(id: string): Promise<void>;
  /** All on-disk filenames still referenced by non-evicted rows (reconciliation). */
  listActiveFilenames(): Promise<string[]>;
}

export interface IRoleRepository {
  findById(id: string): Promise<RoleRecord | null>;
  findByName(name: string): Promise<RoleRecord | null>;
  listAll(): Promise<RoleRecord[]>;
  listRolesForUser(userId: string): Promise<RoleRecord[]>;
  listUserRoles(): Promise<UserRoleRecord[]>;
  getDefaultRoles(): Promise<RoleRecord[]>;
  create(role: RoleRecord): Promise<void>;
  update(roleId: string, updates: Partial<RoleRecord>): Promise<void>;
  delete(roleId: string): Promise<void>;
  assignRole(userId: string, roleId: string): Promise<void>;
  unassignRole(userId: string, roleId: string): Promise<void>;
  hasRole(userId: string, roleId: string): Promise<boolean>;
}

export interface IBotRepository {
  create(bot: BotRecord): Promise<void>;
  findById(id: string): Promise<BotRecord | null>;
  findByTokenHash(tokenHash: string): Promise<BotRecord | null>;
  listAll(): Promise<BotRecord[]>;
  /** Update selected fields (e.g. binding the public key on TOFU). */
  update(id: string, updates: Partial<BotRecord>): Promise<void>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}
