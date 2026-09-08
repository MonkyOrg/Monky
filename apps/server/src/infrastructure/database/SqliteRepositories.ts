import { IDatabaseDriver } from './SqliteWrapper';
import { ChannelType, LIMITS, REACTION_LIMITS, botCommandContextSchema } from '@monky/shared';
import { AttachmentRecord, BotRecord, ChannelRecord, MentionRecord, MessageRecord, RoleRecord, ServerRecord, UserRecord, UserRoleRecord } from '../../domain/entities';
import { IAttachmentRepository, IBotRepository, IChannelRepository, IMentionRepository, IMessageRepository, IRoleRepository, IServerRepository, IUserRepository } from '../../domain/repositories';

/**
 * Note: all repository methods are declared `async` even though the underlying
 * sql.js driver is fully synchronous. This is a deliberate design choice: the
 * repository interfaces (domain/repositories.ts) return Promises so the storage
 * backend can later be swapped for a genuinely asynchronous driver (e.g.
 * better-sqlite3 on a worker thread, or PostgreSQL) without changing any caller.
 * The micro-task overhead is negligible for this application's scale.
 */

export class SqliteServerRepository implements IServerRepository {
  constructor(private db: IDatabaseDriver) {}

  async getServer(): Promise<ServerRecord | null> {
    const row = this.db.prepare('SELECT id, name, password_hash as passwordHash, created_at as createdAt, max_users as maxUsers, owner_user_id as ownerUserId, allow_soundboard as allowSoundboard, allow_everyone_mention as allowEveryoneMention, allow_message_edit as allowMessageEdit, show_role_badges_to_everyone as showRoleBadgesToEveryone, voice_mode as voiceMode, icon_path as iconPath, max_attachment_file_bytes as maxAttachmentFileBytes, max_attachment_storage_bytes as maxAttachmentStorageBytes, turn_enabled as turnEnabled, turn_secret as turnSecret, max_bots as maxBots FROM server_meta LIMIT 1').get() as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      passwordHash: row.passwordHash,
      createdAt: row.createdAt,
      maxUsers: row.maxUsers,
      ownerUserId: row.ownerUserId ?? null,
      allowSoundboard: row.allowSoundboard !== undefined ? Boolean(row.allowSoundboard) : true,
      allowEveryoneMention: row.allowEveryoneMention !== undefined ? Boolean(row.allowEveryoneMention) : true,
      allowMessageEdit: row.allowMessageEdit !== undefined ? Boolean(row.allowMessageEdit) : true,
      showRoleBadgesToEveryone: row.showRoleBadgesToEveryone !== undefined ? Boolean(row.showRoleBadgesToEveryone) : true,
      voiceMode: (row.voiceMode as any) || 'p2p',
      iconPath: row.iconPath || null,
      maxAttachmentFileBytes: row.maxAttachmentFileBytes ?? null,
      maxAttachmentStorageBytes: row.maxAttachmentStorageBytes ?? null,
      turnEnabled: Boolean(row.turnEnabled),
      turnSecret: row.turnSecret ?? null,
      maxBots: row.maxBots ?? LIMITS.MAX_BOTS_DEFAULT,
    };
  }

  async createServer(server: ServerRecord): Promise<void> {
    this.db.prepare(
      'INSERT INTO server_meta (id, name, password_hash, created_at, max_users, owner_user_id, allow_soundboard, allow_everyone_mention, show_role_badges_to_everyone, voice_mode, icon_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      server.id,
      server.name,
      server.passwordHash,
      server.createdAt,
      server.maxUsers,
      server.ownerUserId ?? null,
      server.allowSoundboard !== false ? 1 : 0,
      server.allowEveryoneMention !== false ? 1 : 0,
      server.showRoleBadgesToEveryone !== false ? 1 : 0,
      server.voiceMode || 'p2p',
      server.iconPath || null
    );
  }

  async updateServer(server: Partial<ServerRecord>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (server.name !== undefined) {
      fields.push('name = ?');
      values.push(server.name);
    }
    if (server.passwordHash !== undefined) {
      fields.push('password_hash = ?');
      values.push(server.passwordHash);
    }
    if (server.maxUsers !== undefined) {
      fields.push('max_users = ?');
      values.push(server.maxUsers);
    }
    if (server.ownerUserId !== undefined) {
      fields.push('owner_user_id = ?');
      values.push(server.ownerUserId);
    }
    if (server.allowSoundboard !== undefined) {
      fields.push('allow_soundboard = ?');
      values.push(server.allowSoundboard ? 1 : 0);
    }
    if (server.allowEveryoneMention !== undefined) {
      fields.push('allow_everyone_mention = ?');
      values.push(server.allowEveryoneMention ? 1 : 0);
    }
    if (server.allowMessageEdit !== undefined) {
      fields.push('allow_message_edit = ?');
      values.push(server.allowMessageEdit ? 1 : 0);
    }
    if (server.showRoleBadgesToEveryone !== undefined) {
      fields.push('show_role_badges_to_everyone = ?');
      values.push(server.showRoleBadgesToEveryone ? 1 : 0);
    }
    if (server.voiceMode !== undefined) {
      fields.push('voice_mode = ?');
      values.push(server.voiceMode);
    }
    if (server.iconPath !== undefined) {
      fields.push('icon_path = ?');
      values.push(server.iconPath);
    }
    if (server.maxAttachmentFileBytes !== undefined) {
      fields.push('max_attachment_file_bytes = ?');
      values.push(server.maxAttachmentFileBytes);
    }
    if (server.maxAttachmentStorageBytes !== undefined) {
      fields.push('max_attachment_storage_bytes = ?');
      values.push(server.maxAttachmentStorageBytes);
    }
    if (server.turnEnabled !== undefined) {
      fields.push('turn_enabled = ?');
      values.push(server.turnEnabled ? 1 : 0);
    }
    if (server.turnSecret !== undefined) {
      fields.push('turn_secret = ?');
      values.push(server.turnSecret);
    }

    if (fields.length === 0) return;

    this.db.prepare(
      `UPDATE server_meta SET ${fields.join(', ')} WHERE id = (SELECT id FROM server_meta LIMIT 1)`
    ).run(...values);
  }
}

export class SqliteUserRepository implements IUserRepository {
  constructor(private db: IDatabaseDriver) {}

  async findById(id: string): Promise<UserRecord | null> {
    const row = this.db.prepare(
      'SELECT id, client_id as clientId, public_key as publicKey, nickname, avatar_path as avatarPath, created_at as createdAt, last_seen_at as lastSeenAt FROM users WHERE id = ?'
    ).get(id) as UserRecord | undefined;
    return row || null;
  }

  async findByClientId(clientId: string): Promise<UserRecord | null> {
    const row = this.db.prepare(
      'SELECT id, client_id as clientId, public_key as publicKey, nickname, avatar_path as avatarPath, created_at as createdAt, last_seen_at as lastSeenAt FROM users WHERE client_id = ?'
    ).get(clientId) as UserRecord | undefined;
    return row || null;
  }

  async findByPublicKey(publicKey: string): Promise<UserRecord | null> {
    const row = this.db.prepare(
      'SELECT id, client_id as clientId, public_key as publicKey, nickname, avatar_path as avatarPath, created_at as createdAt, last_seen_at as lastSeenAt FROM users WHERE public_key = ?'
    ).get(publicKey) as UserRecord | undefined;
    return row || null;
  }

  async findByNickname(nickname: string): Promise<UserRecord | null> {
    const row = this.db.prepare(
      'SELECT id, client_id as clientId, public_key as publicKey, nickname, avatar_path as avatarPath, created_at as createdAt, last_seen_at as lastSeenAt FROM users WHERE nickname = ? COLLATE NOCASE'
    ).get(nickname) as UserRecord | undefined;
    return row || null;
  }

  async create(user: UserRecord): Promise<void> {
    this.db.prepare(
      'INSERT INTO users (id, client_id, public_key, nickname, avatar_path, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(user.id, user.clientId, user.publicKey, user.nickname, user.avatarPath, user.createdAt, user.lastSeenAt);
  }

  async update(id: string, updates: Partial<UserRecord>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.nickname !== undefined) {
      fields.push('nickname = ?');
      values.push(updates.nickname);
    }
    if (updates.publicKey !== undefined) {
      fields.push('public_key = ?');
      values.push(updates.publicKey);
    }
    if (updates.avatarPath !== undefined) {
      fields.push('avatar_path = ?');
      values.push(updates.avatarPath);
    }
    if (updates.lastSeenAt !== undefined) {
      fields.push('last_seen_at = ?');
      values.push(updates.lastSeenAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async delete(id: string): Promise<void> {
    // Related rows are removed explicitly rather than relying on the cascade, so
    // the deletion holds even on a database opened without `foreign_keys = ON`.
    // Chat messages are intentionally preserved (they gracefully render as an
    // unknown author) to keep channel history intact.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM mentions WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  }

  async listAll(): Promise<UserRecord[]> {
    return this.db.prepare(
      'SELECT id, client_id as clientId, public_key as publicKey, nickname, avatar_path as avatarPath, created_at as createdAt, last_seen_at as lastSeenAt FROM users'
    ).all() as UserRecord[];
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as total FROM users').get() as { total: number } | undefined;
    return row?.total ?? 0;
  }

  async findByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT id, client_id as clientId, public_key as publicKey, nickname, avatar_path as avatarPath, created_at as createdAt, last_seen_at as lastSeenAt FROM users WHERE id IN (${placeholders})`
    ).all(...ids) as UserRecord[];
  }
}

interface SqliteChannelRow {
  botCommandsEnabled: number;
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  position: number;
  createdAt: number;
  maxParticipants: number;
  isPrivate: number;
}

export class SqliteChannelRepository implements IChannelRepository {
  constructor(private db: IDatabaseDriver) {}

  private static readonly SELECT_COLUMNS =
    'id, server_id as serverId, name, type, position, created_at as createdAt, max_participants as maxParticipants, is_private as isPrivate, bot_commands_enabled as botCommandsEnabled';

  /** Allowed roles for a set of channels, in one query, to avoid N+1 (#384). */
  private loadAllowedRoles(channelIds: string[]): Map<string, string[]> {
    const byChannel = new Map<string, string[]>();
    if (channelIds.length === 0) return byChannel;

    const placeholders = channelIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT channel_id as channelId, role_id as roleId FROM channel_allowed_roles WHERE channel_id IN (${placeholders})`
    ).all(...channelIds) as { channelId: string; roleId: string }[];

    for (const row of rows) {
      const existing = byChannel.get(row.channelId);
      if (existing) existing.push(row.roleId);
      else byChannel.set(row.channelId, [row.roleId]);
    }
    return byChannel;
  }

  private toRecord(row: SqliteChannelRow, allowedRoleIds: string[]): ChannelRecord {
    return {
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      type: row.type,
      position: row.position,
      createdAt: row.createdAt,
      maxParticipants: row.maxParticipants,
      isPrivate: row.isPrivate === 1,
      botCommandsEnabled: row.botCommandsEnabled === 1,
      allowedRoleIds,
    };
  }

  async findById(id: string): Promise<ChannelRecord | null> {
    const row = this.db.prepare(
      `SELECT ${SqliteChannelRepository.SELECT_COLUMNS} FROM channels WHERE id = ?`
    ).get(id) as SqliteChannelRow | undefined;
    if (!row) return null;

    return this.toRecord(row, this.loadAllowedRoles([row.id]).get(row.id) ?? []);
  }

  async listByServerId(serverId: string): Promise<ChannelRecord[]> {
    const rows = this.db.prepare(
      `SELECT ${SqliteChannelRepository.SELECT_COLUMNS} FROM channels WHERE server_id = ? ORDER BY position ASC, created_at ASC`
    ).all(serverId) as SqliteChannelRow[];

    const allowedRoles = this.loadAllowedRoles(rows.map((row) => row.id));
    return rows.map((row) => this.toRecord(row, allowedRoles.get(row.id) ?? []));
  }

  async create(channel: ChannelRecord): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare(
        'INSERT INTO channels (id, server_id, name, type, position, created_at, max_participants, is_private, bot_commands_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        channel.id,
        channel.serverId,
        channel.name,
        channel.type,
        channel.position,
        channel.createdAt,
        channel.maxParticipants,
        channel.isPrivate ? 1 : 0,
        channel.botCommandsEnabled ? 1 : 0
      );
      this.replaceAllowedRoles(channel.id, channel.allowedRoleIds);
    })();
  }

  async update(id: string, updates: Partial<Omit<ChannelRecord, 'id' | 'serverId'>>): Promise<void> {
    this.db.transaction(() => {
      const assignments: string[] = [];
      const values: unknown[] = [];

      if (updates.name !== undefined) {
        assignments.push('name = ?');
        values.push(updates.name);
      }
      if (updates.position !== undefined) {
        assignments.push('position = ?');
        values.push(updates.position);
      }
      if (updates.maxParticipants !== undefined) {
        assignments.push('max_participants = ?');
        values.push(updates.maxParticipants);
      }
      if (updates.isPrivate !== undefined) {
        assignments.push('is_private = ?');
        values.push(updates.isPrivate ? 1 : 0);
      }
      if (updates.botCommandsEnabled !== undefined) {
        assignments.push('bot_commands_enabled = ?');
        values.push(updates.botCommandsEnabled ? 1 : 0);
      }

      if (assignments.length > 0) {
        this.db.prepare(`UPDATE channels SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
      }
      if (updates.allowedRoleIds !== undefined) {
        this.replaceAllowedRoles(id, updates.allowedRoleIds);
      }
    })();
  }

  /**
   * Replaces the allowed-role set. Callers must pass ids that exist: the
   * foreign key is enforced by sql.js and an unknown role would throw.
   */
  private replaceAllowedRoles(channelId: string, roleIds: string[]): void {
    this.db.prepare('DELETE FROM channel_allowed_roles WHERE channel_id = ?').run(channelId);
    for (const roleId of roleIds) {
      this.db.prepare(
        'INSERT OR IGNORE INTO channel_allowed_roles (channel_id, role_id) VALUES (?, ?)'
      ).run(channelId, roleId);
    }
  }

  async delete(id: string): Promise<void> {
    // channel_allowed_roles rows go with it through ON DELETE CASCADE.
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  }

  async updatePosition(id: string, position: number): Promise<void> {
    this.db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(position, id);
  }
}

interface SqliteMessageRow {
  authorBotId: string | null;
  authorBotName: string | null;
  authorBotAvatarPath: string | null;
  botCommandJson: string | null;
  id: string;
  channelId: string;
  userId: string;
  content: string;
  createdAt: number;
  isSystem: number;
  editedAt: number | null;
  deletedAt: number | null;
}

/** Columns every message read shares, so the three queries cannot drift (#504). */
const MESSAGE_COLUMNS =
  'id, channel_id as channelId, user_id as userId, content, created_at as createdAt, is_system as isSystem, edited_at as editedAt, deleted_at as deletedAt, author_bot_id as authorBotId, author_bot_name as authorBotName, author_bot_avatar_path as authorBotAvatarPath, bot_command_json as botCommandJson';

function toMessageRecord(r: SqliteMessageRow): MessageRecord {
  if (r.authorBotId && !r.authorBotName) throw new Error('Stored bot message is missing its author name.');
  return {
    id: r.id,
    channelId: r.channelId,
    userId: r.authorBotId ?? r.userId,
    botAuthor: r.authorBotId && r.authorBotName
      ? { id: r.authorBotId, name: r.authorBotName, avatarPath: r.authorBotAvatarPath, ownerUserId: r.userId }
      : undefined,
    botCommand: r.botCommandJson ? botCommandContextSchema.parse(JSON.parse(r.botCommandJson)) : undefined,
    content: r.content,
    createdAt: r.createdAt,
    isSystem: Boolean(r.isSystem),
    editedAt: r.editedAt ?? null,
    deletedAt: r.deletedAt ?? null,
  };
}

export class SqliteMessageRepository implements IMessageRepository {
  constructor(private db: IDatabaseDriver) {}

  async setReaction(messageId: string, userId: string, emoji: string, add: boolean): Promise<'changed' | 'unchanged' | 'limit' | 'invalid'> {
    return this.db.transaction(() => {
      // Check again inside the transaction: a message may have been deleted
      // while the service was resolving channel permissions.
      const message = this.db.prepare(`SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE m.id = ? AND m.deleted_at IS NULL AND m.is_system = 0 AND c.type = 'TEXT'`).get(messageId);
      if (!message) return 'invalid';
      const actor = this.db.prepare('SELECT id FROM users WHERE id = ? UNION ALL SELECT id FROM bots WHERE id = ?').get(userId, userId);
      if (!actor) return 'invalid';
      const existing = this.db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
        .get(messageId, userId, emoji);
      if (Boolean(existing) === add) return 'unchanged';
      if (!add) {
        this.db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
        return 'changed';
      }
      const counts = this.db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT emoji) AS distinctEmoji,
        SUM(CASE WHEN emoji = ? THEN 1 ELSE 0 END) AS matching
        FROM message_reactions WHERE message_id = ?`).get(emoji, messageId) as { total: number; distinctEmoji: number; matching: number | null };
      if (counts.total >= REACTION_LIMITS.MAX_PER_MESSAGE ||
          (!counts.matching && counts.distinctEmoji >= REACTION_LIMITS.MAX_DISTINCT_EMOJI)) return 'limit';
      this.db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, userId, emoji);
      return 'changed';
    })();
  }

  async listReactions(messageIds: string[]): Promise<import('../../domain/entities').MessageReactionRecord[]> {
    if (messageIds.length === 0) return [];
    return this.db.prepare(`SELECT r.message_id AS messageId, r.user_id AS userId, COALESCE(u.nickname, b.name) AS userNickname, r.emoji
      FROM message_reactions r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN bots b ON b.id = r.user_id
      WHERE r.message_id IN (${messageIds.map(() => '?').join(',')})
      ORDER BY r.emoji, u.nickname, r.user_id`).all(...messageIds) as import('../../domain/entities').MessageReactionRecord[];
  }

  async countAll(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM messages').get() as
      | { count?: number }
      | undefined;
    return Number(row?.count ?? 0);
  }

  async create(message: MessageRecord): Promise<void> {
    this.insertMessage(message);
  }

  async createBotMessage(message: MessageRecord): Promise<MessageRecord | null> {
    const author = message.botAuthor;
    if (!author) throw new Error('Bot messages require an author snapshot.');
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM bots WHERE id = ? AND created_by_user_id = ?').get(author.id, author.ownerUserId)) return null;
      this.insertMessage(message, true);
      const row = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(message.id) as SqliteMessageRow | undefined;
      if (!row) throw new Error('Bot message was not persisted.');
      return toMessageRecord(row);
    })();
  }

  private insertMessage(message: MessageRecord, idempotent = false): void {
    this.db.prepare(
      'INSERT INTO messages (id, channel_id, user_id, content, created_at, is_system, author_bot_id, author_bot_name, author_bot_avatar_path, bot_command_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      (idempotent ? ' ON CONFLICT(id) DO NOTHING' : '')
    ).run(message.id, message.channelId, message.botAuthor?.ownerUserId ?? message.userId, message.content, message.createdAt, message.isSystem ? 1 : 0,
      message.botAuthor?.id ?? null, message.botAuthor?.name ?? null, message.botAuthor?.avatarPath ?? null,
      message.botCommand ? JSON.stringify(message.botCommand) : null);
  }

  async findById(messageId: string): Promise<MessageRecord | null> {
    const row = this.db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`
    ).get(messageId) as SqliteMessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async listByChannel(channelId: string, limit: number, beforeTimestamp?: number): Promise<MessageRecord[]> {
    if (beforeTimestamp) {
      const rows = this.db.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`
      ).all(channelId, beforeTimestamp, limit) as SqliteMessageRow[];

      return rows.reverse().map(toMessageRecord);
    }

    const rows = this.db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(channelId, limit) as SqliteMessageRow[];

    return rows.reverse().map(toMessageRecord);
  }

  async updateContent(messageId: string, content: string, editedAt: number): Promise<void> {
    this.db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, editedAt, messageId);
  }

  async markDeleted(messageId: string, deletedAt: number): Promise<void> {
    // The content goes with the deletion: keeping it would leave the text one
    // query away from anyone with access to the database file (#504).
    this.db.prepare("UPDATE messages SET content = '', deleted_at = ? WHERE id = ?").run(deletedAt, messageId);
  }

  async deleteByChannel(channelId: string): Promise<void> {
    this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
  }
}

interface SqliteMentionChannelRow {
  channelId: string;
}

export class SqliteMentionRepository implements IMentionRepository {
  constructor(private db: IDatabaseDriver) {}

  async add(mention: MentionRecord): Promise<void> {
    this.db.prepare(
      'INSERT INTO mentions (id, user_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(mention.id, mention.userId, mention.channelId, mention.messageId, mention.createdAt);
  }

  async listChannelIdsForUser(userId: string): Promise<string[]> {
    const rows = this.db.prepare(
      'SELECT DISTINCT channel_id as channelId FROM mentions WHERE user_id = ?'
    ).all(userId) as SqliteMentionChannelRow[];

    return rows.map((r) => r.channelId);
  }

  async clearForUserChannel(userId: string, channelId: string): Promise<void> {
    this.db.prepare('DELETE FROM mentions WHERE user_id = ? AND channel_id = ?').run(userId, channelId);
  }
}

interface SqliteAttachmentRow {
  id: string;
  messageId: string | null;
  channelId: string;
  userId: string;
  kind: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  evicted: number;
  createdAt: number;
}

export class SqliteAttachmentRepository implements IAttachmentRepository {
  constructor(private db: IDatabaseDriver) {}

  private static readonly SELECT =
    'SELECT id, message_id as messageId, channel_id as channelId, user_id as userId, kind, filename, original_name as originalName, mime_type as mimeType, size_bytes as sizeBytes, width, height, duration_ms as durationMs, evicted, created_at as createdAt FROM message_attachments';

  private map(r: SqliteAttachmentRow): AttachmentRecord {
    return {
      id: r.id,
      messageId: r.messageId,
      channelId: r.channelId,
      userId: r.userId,
      kind: r.kind as AttachmentRecord['kind'],
      filename: r.filename,
      originalName: r.originalName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      width: r.width,
      height: r.height,
      durationMs: r.durationMs,
      evicted: Boolean(r.evicted),
      createdAt: r.createdAt,
    };
  }

  async create(att: AttachmentRecord): Promise<void> {
    this.db.prepare(
      'INSERT INTO message_attachments (id, message_id, channel_id, user_id, kind, filename, original_name, mime_type, size_bytes, width, height, duration_ms, evicted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      att.id,
      att.messageId,
      att.channelId,
      att.userId,
      att.kind,
      att.filename,
      att.originalName,
      att.mimeType,
      att.sizeBytes,
      att.width ?? null,
      att.height ?? null,
      att.durationMs ?? null,
      att.evicted ? 1 : 0,
      att.createdAt
    );
  }

  async findByIds(ids: string[]): Promise<AttachmentRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`${SqliteAttachmentRepository.SELECT} WHERE id IN (${placeholders})`)
      .all(...ids) as SqliteAttachmentRow[];
    return rows.map((r) => this.map(r));
  }

  async listByMessageIds(messageIds: string[]): Promise<AttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`${SqliteAttachmentRepository.SELECT} WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...messageIds) as SqliteAttachmentRow[];
    return rows.map((r) => this.map(r));
  }

  async linkToMessage(ids: string[], messageId: string): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE message_attachments SET message_id = ? WHERE id IN (${placeholders})`)
      .run(messageId, ...ids);
  }

  async sumActiveBytes(): Promise<number> {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM message_attachments WHERE evicted = 0')
      .get() as { total: number };
    return row?.total ?? 0;
  }

  async listOldestActive(limit: number): Promise<AttachmentRecord[]> {
    const rows = this.db
      .prepare(`${SqliteAttachmentRepository.SELECT} WHERE evicted = 0 ORDER BY created_at ASC LIMIT ?`)
      .all(limit) as SqliteAttachmentRow[];
    return rows.map((r) => this.map(r));
  }

  async markEvicted(id: string): Promise<void> {
    this.db.prepare("UPDATE message_attachments SET evicted = 1, filename = '' WHERE id = ?").run(id);
  }

  async listPendingBefore(timestamp: number): Promise<AttachmentRecord[]> {
    const rows = this.db
      .prepare(`${SqliteAttachmentRepository.SELECT} WHERE message_id IS NULL AND created_at < ?`)
      .all(timestamp) as SqliteAttachmentRow[];
    return rows.map((r) => this.map(r));
  }

  async deleteById(id: string): Promise<void> {
    this.db.prepare('DELETE FROM message_attachments WHERE id = ?').run(id);
  }

  async listActiveFilenames(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT filename FROM message_attachments WHERE evicted = 0 AND filename != ''")
      .all() as { filename: string }[];
    return rows.map((r) => r.filename);
  }
}

interface SqliteRoleRow {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: number;
  isDefault: number;
  createdAt: number;
}

export class SqliteRoleRepository implements IRoleRepository {
  constructor(private db: IDatabaseDriver) {}

  private static readonly SELECT =
    'SELECT id, name, color, position, permissions, is_default as isDefault, created_at as createdAt FROM roles';

  private mapRole(row: SqliteRoleRow): RoleRecord {
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      position: row.position,
      permissions: row.permissions,
      isDefault: Boolean(row.isDefault),
      createdAt: row.createdAt,
    };
  }

  async findById(id: string): Promise<RoleRecord | null> {
    const row = this.db.prepare(`${SqliteRoleRepository.SELECT} WHERE id = ?`).get(id) as SqliteRoleRow | undefined;
    return row ? this.mapRole(row) : null;
  }

  async findByName(name: string): Promise<RoleRecord | null> {
    const row = this.db.prepare(`${SqliteRoleRepository.SELECT} WHERE name = ? COLLATE NOCASE`).get(name) as SqliteRoleRow | undefined;
    return row ? this.mapRole(row) : null;
  }

  async listAll(): Promise<RoleRecord[]> {
    const rows = this.db.prepare(`${SqliteRoleRepository.SELECT} ORDER BY position DESC, created_at ASC`).all() as SqliteRoleRow[];
    return rows.map((row) => this.mapRole(row));
  }

  async listRolesForUser(userId: string): Promise<RoleRecord[]> {
    const rows = this.db.prepare(
      `SELECT roles.id, roles.name, roles.color, roles.position, roles.permissions, roles.is_default as isDefault, roles.created_at as createdAt
       FROM roles
       INNER JOIN user_roles ON user_roles.role_id = roles.id
       WHERE user_roles.user_id = ?
       ORDER BY position DESC, created_at ASC`
    ).all(userId) as SqliteRoleRow[];
    return rows.map((row) => this.mapRole(row));
  }

  async listUserRoles(): Promise<UserRoleRecord[]> {
    return this.db.prepare('SELECT user_id as userId, role_id as roleId FROM user_roles ORDER BY user_id ASC').all() as UserRoleRecord[];
  }

  async getDefaultRoles(): Promise<RoleRecord[]> {
    const rows = this.db.prepare(`${SqliteRoleRepository.SELECT} WHERE is_default = 1 ORDER BY position DESC, created_at ASC`).all() as SqliteRoleRow[];
    return rows.map((row) => this.mapRole(row));
  }

  async create(role: RoleRecord): Promise<void> {
    this.db.prepare(
      'INSERT INTO roles (id, name, color, position, permissions, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(role.id, role.name, role.color, role.position, role.permissions, role.isDefault ? 1 : 0, role.createdAt);
  }

  async update(roleId: string, updates: Partial<RoleRecord>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.color !== undefined) {
      fields.push('color = ?');
      values.push(updates.color);
    }
    if (updates.position !== undefined) {
      fields.push('position = ?');
      values.push(updates.position);
    }
    if (updates.permissions !== undefined) {
      fields.push('permissions = ?');
      values.push(updates.permissions);
    }
    if (updates.isDefault !== undefined) {
      fields.push('is_default = ?');
      values.push(updates.isDefault ? 1 : 0);
    }
    if (fields.length === 0) return;
    values.push(roleId);
    this.db.prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async delete(roleId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(roleId);
      this.db.prepare('DELETE FROM channel_allowed_roles WHERE role_id = ?').run(roleId);
      this.db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
    })();
  }

  async assignRole(userId: string, roleId: string): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleId);
  }

  async unassignRole(userId: string, roleId: string): Promise<void> {
    this.db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, roleId);
  }

  async hasRole(userId: string, roleId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 as found FROM user_roles WHERE user_id = ? AND role_id = ? LIMIT 1').get(userId, roleId) as { found?: number } | undefined;
    return Boolean(row?.found);
  }
}

export class SqliteBotRepository implements IBotRepository {
  constructor(private db: IDatabaseDriver) {}

  async create(bot: BotRecord): Promise<void> {
    this.db.prepare(
      `INSERT INTO bots (id, name, token_hash, avatar_path, bound_public_key, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(bot.id, bot.name, bot.tokenHash, bot.avatarPath, bot.boundPublicKey, bot.createdByUserId, bot.createdAt);
  }

  async findById(id: string): Promise<BotRecord | null> {
    const row = this.db.prepare(
      `SELECT id, name, token_hash as tokenHash, avatar_path as avatarPath,
              bound_public_key as boundPublicKey, created_by_user_id as createdByUserId,
              created_at as createdAt
       FROM bots WHERE id = ?`
    ).get(id) as BotRecord | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<BotRecord | null> {
    const row = this.db.prepare(
      `SELECT id, name, token_hash as tokenHash, avatar_path as avatarPath,
              bound_public_key as boundPublicKey, created_by_user_id as createdByUserId,
              created_at as createdAt
       FROM bots WHERE token_hash = ?`
    ).get(tokenHash) as BotRecord | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listAll(): Promise<BotRecord[]> {
    const rows = this.db.prepare(
      `SELECT id, name, token_hash as tokenHash, avatar_path as avatarPath,
              bound_public_key as boundPublicKey, created_by_user_id as createdByUserId,
              created_at as createdAt
       FROM bots ORDER BY created_at ASC`
    ).all() as BotRecord[];
    return rows.map((r) => this.mapRow(r));
  }

  async update(id: string, updates: Partial<BotRecord>): Promise<void> {
    const cols: string[] = [];
    const vals: Array<string | null> = [];
    if (updates.name !== undefined) { cols.push('name = ?'); vals.push(updates.name); }
    if (updates.tokenHash !== undefined) { cols.push('token_hash = ?'); vals.push(updates.tokenHash); }
    if (updates.avatarPath !== undefined) { cols.push('avatar_path = ?'); vals.push(updates.avatarPath); }
    if (updates.boundPublicKey !== undefined) { cols.push('bound_public_key = ?'); vals.push(updates.boundPublicKey); }
    if (cols.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE bots SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM bots WHERE id = ?').run(id);
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM bots').get() as { cnt: number };
    return row.cnt;
  }

  private mapRow(row: BotRecord): BotRecord {
    return {
      id: row.id,
      name: row.name,
      tokenHash: row.tokenHash,
      avatarPath: row.avatarPath ?? null,
      boundPublicKey: row.boundPublicKey ?? null,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
    };
  }
}
