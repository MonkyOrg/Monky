import { IDatabaseDriver } from './SqliteWrapper';
import { CHANNEL_PERMISSIONS, channelOverwrites, channelPrivacy, withChannelPrivacy, messageBlocksSchema, resolveChannelPermissions, type ChannelCategory, type ChannelPermissionOverwrite, type MessageBlock } from '@monky/shared';
import { SqliteCategoryRepository } from './SqliteCategoryRepository';
import { SqliteChannelPermissions } from './SqliteChannelPermissions';
import { partialUpdate } from './partialUpdate';
import { ChannelType, LIMITS, REACTION_LIMITS, botCommandContextSchema, botMessageLocalizationsSchema } from '@monky/shared';
import { AttachmentRecord, BotRecord, ChannelRecord, MentionRecord, MessageRecord, NewServerRecord, RoleRecord, ServerRecord, UserRecord, UserRoleRecord } from '../../domain/entities';
import { IAttachmentRepository, IBotRepository, IChannelRepository, IMentionRepository, IMessageRepository, IRoleRepository, IServerRepository, IUserRepository } from '../../domain/repositories';
import { SERVER_SETTING_DEFAULTS } from '../../domain/serverSettings';

/**
 * Note: all repository methods are declared `async` even though the underlying
 * sql.js driver is fully synchronous. This is a deliberate design choice: the
 * repository interfaces (domain/repositories.ts) return Promises so the storage
 * backend can later be swapped for a genuinely asynchronous driver (e.g.
 * better-sqlite3 on a worker thread, or PostgreSQL) without changing any caller.
 * The micro-task overhead is negligible for this application's scale.
 */

/** server_meta as stored: flags are 0 or 1, and older rows may lack a value. */
interface ServerMetaRow {
  id: string;
  name: string;
  everyonePermissions: number | null;
  passwordHash: string;
  createdAt: number;
  maxUsers: number;
  maxMessageLength: number | null;
  messageDeleteUndoSeconds: number | null;
  ownerUserId: string | null;
  allowSoundboard: number | null;
  dmRelayEnabled: number | null;
  recentSoundCacheEnabled: number | null;
  recentSoundCacheLimit: number | null;
  allowEveryoneMention: number | null;
  allowMessageEdit: number | null;
  showRoleBadgesToEveryone: number | null;
  voiceMode: string | null;
  iconPath: string | null;
  maxAttachmentFileBytes: number | null;
  maxAttachmentStorageBytes: number | null;
  turnEnabled: number | null;
  turnSecret: string | null;
  maxBots: number | null;
  afkChannelId: string | null;
  afkTimeoutSeconds: number | null;
}

const flag = (stored: number | null, fallback: boolean): boolean => stored === null ? fallback : stored !== 0;

/** Columns updateServer may write, by field. */
const SERVER_COLUMNS: { readonly [K in keyof ServerRecord]?: string } = {
  everyonePermissions: 'everyone_permissions',
  messageDeleteUndoSeconds: 'message_delete_undo_seconds',
  maxMessageLength: 'max_message_length',
  name: 'name',
  passwordHash: 'password_hash',
  maxUsers: 'max_users',
  ownerUserId: 'owner_user_id',
  allowSoundboard: 'allow_soundboard',
  dmRelayEnabled: 'dm_relay_enabled',
  recentSoundCacheEnabled: 'recent_sound_cache_enabled',
  recentSoundCacheLimit: 'recent_sound_cache_limit',
  allowEveryoneMention: 'allow_everyone_mention',
  allowMessageEdit: 'allow_message_edit',
  showRoleBadgesToEveryone: 'show_role_badges_to_everyone',
  voiceMode: 'voice_mode',
  iconPath: 'icon_path',
  maxAttachmentFileBytes: 'max_attachment_file_bytes',
  maxAttachmentStorageBytes: 'max_attachment_storage_bytes',
  turnEnabled: 'turn_enabled',
  turnSecret: 'turn_secret',
  afkChannelId: 'afk_channel_id',
  afkTimeoutSeconds: 'afk_timeout_seconds',
};

const USER_COLUMNS: { readonly [K in keyof UserRecord]?: string } = {
  nickname: 'nickname',
  publicKey: 'public_key',
  avatarPath: 'avatar_path',
  lastSeenAt: 'last_seen_at',
};

/** Access rules live in their own tables; SqliteChannelRepository.update writes them separately. */
const CHANNEL_COLUMNS: { readonly [K in keyof ChannelRecord]?: string } = {
  categoryId: 'category_id',
  inheritCategoryPermissions: 'inherit_category_permissions',
  name: 'name',
  position: 'position',
  maxParticipants: 'max_participants',
  isPrivate: 'is_private',
  botCommandsEnabled: 'bot_commands_enabled',
};

const ROLE_COLUMNS: { readonly [K in keyof RoleRecord]?: string } = {
  name: 'name',
  color: 'color',
  position: 'position',
  permissions: 'permissions',
  isDefault: 'is_default',
};

const BOT_COLUMNS: { readonly [K in keyof BotRecord]?: string } = {
  name: 'name',
  profilePending: 'profile_pending',
  tokenHash: 'token_hash',
  avatarPath: 'avatar_path',
  boundPublicKey: 'bound_public_key',
  lastProtocolVersion: 'last_protocol_version',
  manifestUrl: 'manifest_url',
  keyProofRequired: 'key_proof_required',
};

export class SqliteServerRepository implements IServerRepository {
  constructor(private db: IDatabaseDriver) {}

  async getLifecycleSettings(): Promise<Pick<ServerRecord, 'name' | 'turnEnabled'> | null> {
    const columns: unknown[] = this.db.prepare('PRAGMA table_info(server_meta)').all();
    if (columns.length === 0) return null;
    const hasTurn = columns.some((column) =>
      column !== null && typeof column === 'object' && 'name' in column && column.name === 'turn_enabled');
    // Lifecycle reads must also work before the running server applies newer migrations.
    const row: unknown = this.db.prepare(
      `SELECT name, ${hasTurn ? 'turn_enabled' : '0'} AS turnEnabled FROM server_meta LIMIT 1`
    ).get();
    if (row === undefined) return null;
    if (!row || typeof row !== 'object' || !('name' in row) || typeof row.name !== 'string' || !('turnEnabled' in row)) {
      throw new Error('Invalid stored server lifecycle settings.');
    }
    return { name: row.name, turnEnabled: Boolean(row.turnEnabled) };
  }

  async getServer(): Promise<ServerRecord | null> {
    const row = this.db.prepare('SELECT id, name, everyone_permissions as everyonePermissions, password_hash as passwordHash, created_at as createdAt, max_users as maxUsers, max_message_length as maxMessageLength, message_delete_undo_seconds as messageDeleteUndoSeconds, owner_user_id as ownerUserId, allow_soundboard as allowSoundboard, dm_relay_enabled as dmRelayEnabled, recent_sound_cache_enabled as recentSoundCacheEnabled, recent_sound_cache_limit as recentSoundCacheLimit, allow_everyone_mention as allowEveryoneMention, allow_message_edit as allowMessageEdit, show_role_badges_to_everyone as showRoleBadgesToEveryone, voice_mode as voiceMode, icon_path as iconPath, max_attachment_file_bytes as maxAttachmentFileBytes, max_attachment_storage_bytes as maxAttachmentStorageBytes, turn_enabled as turnEnabled, turn_secret as turnSecret, max_bots as maxBots, afk_channel_id as afkChannelId, afk_timeout_seconds as afkTimeoutSeconds FROM server_meta LIMIT 1').get() as ServerMetaRow | undefined;
    if (!row) return null;
    const defaults = SERVER_SETTING_DEFAULTS;
    return {
      id: row.id,
      everyonePermissions: row.everyonePermissions ?? defaults.everyonePermissions,
      name: row.name,
      passwordHash: row.passwordHash,
      createdAt: row.createdAt,
      maxUsers: row.maxUsers,
      maxMessageLength: row.maxMessageLength ?? defaults.maxMessageLength,
      messageDeleteUndoSeconds: row.messageDeleteUndoSeconds ?? defaults.messageDeleteUndoSeconds,
      ownerUserId: row.ownerUserId ?? null,
      allowSoundboard: flag(row.allowSoundboard, defaults.allowSoundboard),
      dmRelayEnabled: flag(row.dmRelayEnabled, defaults.dmRelayEnabled),
      recentSoundCacheEnabled: flag(row.recentSoundCacheEnabled, defaults.recentSoundCacheEnabled),
      recentSoundCacheLimit: row.recentSoundCacheLimit ?? defaults.recentSoundCacheLimit,
      allowEveryoneMention: flag(row.allowEveryoneMention, defaults.allowEveryoneMention),
      allowMessageEdit: flag(row.allowMessageEdit, defaults.allowMessageEdit),
      showRoleBadgesToEveryone: flag(row.showRoleBadgesToEveryone, defaults.showRoleBadgesToEveryone),
      voiceMode: row.voiceMode === 'sfu' ? 'sfu' : 'p2p',
      iconPath: row.iconPath || null,
      maxAttachmentFileBytes: row.maxAttachmentFileBytes ?? null,
      maxAttachmentStorageBytes: row.maxAttachmentStorageBytes ?? null,
      turnEnabled: flag(row.turnEnabled, defaults.turnEnabled),
      turnSecret: row.turnSecret ?? null,
      maxBots: row.maxBots ?? defaults.maxBots,
      afkChannelId: row.afkChannelId ?? null,
      afkTimeoutSeconds: row.afkTimeoutSeconds ?? defaults.afkTimeoutSeconds,
    };
  }

  async createServer(server: NewServerRecord): Promise<void> {
    const defaults = SERVER_SETTING_DEFAULTS;
    this.db.prepare(
      'INSERT INTO server_meta (id, name, password_hash, created_at, max_users, owner_user_id, allow_soundboard, allow_everyone_mention, show_role_badges_to_everyone, voice_mode, icon_path, max_message_length, message_delete_undo_seconds, everyone_permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      server.id,
      server.name,
      server.passwordHash,
      server.createdAt,
      server.maxUsers,
      server.ownerUserId ?? defaults.ownerUserId,
      (server.allowSoundboard ?? defaults.allowSoundboard) ? 1 : 0,
      (server.allowEveryoneMention ?? defaults.allowEveryoneMention) ? 1 : 0,
      (server.showRoleBadgesToEveryone ?? defaults.showRoleBadgesToEveryone) ? 1 : 0,
      server.voiceMode || defaults.voiceMode,
      server.iconPath || defaults.iconPath,
      server.maxMessageLength ?? defaults.maxMessageLength,
      server.messageDeleteUndoSeconds ?? defaults.messageDeleteUndoSeconds,
      server.everyonePermissions ?? defaults.everyonePermissions
    );
  }

  async updateServer(server: Partial<ServerRecord>): Promise<void> {
    const update = partialUpdate(server, SERVER_COLUMNS);
    if (!update) return;
    this.db.prepare(
      `UPDATE server_meta SET ${update.set} WHERE id = (SELECT id FROM server_meta LIMIT 1)`
    ).run(...update.values);
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
    const update = partialUpdate(updates, USER_COLUMNS);
    if (!update) return;
    this.db.prepare(`UPDATE users SET ${update.set} WHERE id = ?`).run(...update.values, id);
  }

  async delete(id: string): Promise<void> {
    // user_roles names the user without an ON DELETE action, so it is cleared
    // first. The foreign keys take care of the rest: what the member posted
    // stays and shows an unknown author (D2), the bots they added keep
    // working, and their votes, answers and individual channel rules go.
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
  forumId: string | null;
  forumLocked: number | null;
  forumClosed: number | null;
  categoryId: string | null;
  inheritCategoryPermissions: number;
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
  public readonly categories: SqliteCategoryRepository;
  private readonly permissions: SqliteChannelPermissions;
  constructor(private db: IDatabaseDriver) {
    this.categories = new SqliteCategoryRepository(db);
    this.permissions = new SqliteChannelPermissions(db, 'channel');
  }

  private static readonly SELECT_COLUMNS =
    'id, server_id as serverId, name, type, position, created_at as createdAt, max_participants as maxParticipants, is_private as isPrivate, bot_commands_enabled as botCommandsEnabled, category_id as categoryId, inherit_category_permissions as inheritCategoryPermissions, forum_parent_id as forumId, (SELECT locked FROM forum_posts WHERE channel_id = channels.id) as forumLocked, (SELECT closed FROM forum_posts WHERE channel_id = channels.id) as forumClosed';

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

  private toRecord(row: SqliteChannelRow, allowedRoleIds: string[], categories: ReadonlyMap<string, ChannelCategory>, permissionOverwrites: ChannelPermissionOverwrite[]): ChannelRecord {
    const access = resolveChannelPermissions({
      permissionOverwrites,
      categoryId: row.categoryId,
      inheritCategoryPermissions: row.inheritCategoryPermissions === 1,
      isPrivate: row.isPrivate === 1,
      allowedRoleIds,
    }, categories.get(row.categoryId ?? '') ?? null);
    return {
      permissionOverwrites: access.permissionOverwrites,
      forumId: row.forumId,
      forumLocked: row.forumLocked === 1,
      forumClosed: row.forumClosed === 1,
      categoryId: row.categoryId,
      inheritCategoryPermissions: row.inheritCategoryPermissions === 1,
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      type: row.type,
      position: row.position,
      createdAt: row.createdAt,
      maxParticipants: row.maxParticipants,
      isPrivate: access.isPrivate,
      botCommandsEnabled: row.botCommandsEnabled === 1,
      allowedRoleIds: access.allowedRoleIds,
    };
  }

  async findById(id: string): Promise<ChannelRecord | null> {
    const row = this.readRow(id);
    if (!row) return null;
    // A forum topic takes its access from the forum, which has to be read along with it.
    const parentRow = row.forumId ? this.readRow(row.forumId) : undefined;
    const rows = parentRow ? [row, parentRow] : [row];
    // Categories are read only when one of these rows can inherit from one (S-APP-5).
    const categories = new Map(rows.some((entry) => entry.categoryId)
      ? this.categories.readByServerId(row.serverId).map((category): [string, ChannelCategory] => [category.id, category]) : []);
    const [record, parent] = this.hydrate(rows, categories);
    return record.forumId ? this.withForumAccess(record, parent ?? null) : record;
  }

  async listByServerId(serverId: string): Promise<ChannelRecord[]> {
    const rows = this.db.prepare(
      `SELECT ${SqliteChannelRepository.SELECT_COLUMNS} FROM channels WHERE server_id = ? ORDER BY position ASC, created_at ASC`
    ).all(serverId) as SqliteChannelRow[];

    const categories = new Map(this.categories.readByServerId(serverId).map((category) => [category.id, category]));
    const records = this.hydrate(rows, categories);
    const byId = new Map(records.map(record => [record.id, record]));
    return records.map(record => record.forumId ? this.withForumAccess(record, byId.get(record.forumId) ?? null) : record);
  }

  private readRow(id: string): SqliteChannelRow | undefined {
    return this.db.prepare(`SELECT ${SqliteChannelRepository.SELECT_COLUMNS} FROM channels WHERE id = ?`).get(id);
  }

  /** Rows with their effective access, read for all of them at once to avoid N+1 (#384). */
  private hydrate(rows: SqliteChannelRow[], categories: ReadonlyMap<string, ChannelCategory>): ChannelRecord[] {
    const ids = rows.map((row) => row.id);
    const allowedRoles = this.loadAllowedRoles(ids);
    const permissions = this.permissions.read(ids);
    return rows.map((row) => this.toRecord(row, allowedRoles.get(row.id) ?? [], categories, permissions.get(row.id) ?? []));
  }

  private withForumAccess(record: ChannelRecord, parent: ChannelRecord | null): ChannelRecord {
    const valid = parent?.type === 'FORUM' && !parent.forumId && parent.serverId === record.serverId;
    return { ...record, isPrivate: valid ? parent.isPrivate : true,
      permissionOverwrites: valid ? channelOverwrites(parent) : [{ roleId: null, allow: 0, deny: CHANNEL_PERMISSIONS }],
      allowedRoleIds: valid ? [...parent.allowedRoleIds] : [], botCommandsEnabled: valid && parent.botCommandsEnabled };
  }

  async create(channel: ChannelRecord): Promise<void> {
    this.db.transaction(() => {
      if (channel.permissionOverwrites) channel = { ...channel, ...channelPrivacy(channel.permissionOverwrites) };
      this.db.prepare(
        'INSERT INTO channels (id, server_id, name, type, position, created_at, max_participants, is_private, bot_commands_enabled, category_id, inherit_category_permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        channel.id,
        channel.serverId,
        channel.name,
        channel.type,
        channel.position,
        channel.createdAt,
        channel.maxParticipants,
        channel.isPrivate ? 1 : 0,
        channel.botCommandsEnabled ? 1 : 0,
        channel.categoryId ?? null,
        channel.inheritCategoryPermissions === false ? 0 : 1
      );
      this.replaceAllowedRoles(channel.id, channel.allowedRoleIds);
      this.permissions.replace(channel.id, channelOverwrites(channel));
    })();
  }

  async update(id: string, updates: Partial<Omit<ChannelRecord, 'id' | 'serverId'>>): Promise<void> {
    this.db.transaction(() => {
      if (updates.permissionOverwrites !== undefined) {
        const stored = this.db.prepare('SELECT is_private AS isPrivate FROM channels WHERE id = ?').get(id) as { isPrivate: number } | undefined;
        const privacy = channelPrivacy(updates.permissionOverwrites, {
          isPrivate: stored?.isPrivate === 1, allowedRoleIds: [],
          permissionOverwrites: this.permissions.read([id]).get(id) ?? [],
        });
        updates = { ...updates, ...privacy, isPrivate: updates.isPrivate ?? privacy.isPrivate };
        this.permissions.replace(id, updates.permissionOverwrites!);
      } else if (updates.isPrivate !== undefined || updates.allowedRoleIds !== undefined) {
        const stored = this.db.prepare('SELECT is_private AS isPrivate FROM channels WHERE id = ?').get(id) as { isPrivate: number } | undefined;
        if (!stored) return;
        this.permissions.replace(id, withChannelPrivacy(this.permissions.read([id]).get(id) ?? [],
          updates.isPrivate ?? stored.isPrivate === 1, updates.allowedRoleIds ?? this.loadAllowedRoles([id]).get(id) ?? []));
      }
      const update = partialUpdate(updates, CHANNEL_COLUMNS);
      if (update) {
        this.db.prepare(`UPDATE channels SET ${update.set} WHERE id = ?`).run(...update.values, id);
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

  async updatePositions(positions: Array<{ channelId: string; position: number }>): Promise<void> {
    this.db.transaction(() => {
      const statement = this.db.prepare('UPDATE channels SET position = ? WHERE id = ?');
      for (const { channelId, position } of positions) statement.run(position, channelId);
    })();
  }
}

interface SqliteMessageRow {
  forwarded: number;
  forwardSource: string | null;
  forwardCreatedAt: number | null;
  revision: number;
  deletedByUserId: string | null;
  deleteUndoUntil: number | null;
  blocksJson: string | null;
  botLocalizationsJson: string | null;
  replyToMessageId: string | null;
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
  'id, channel_id as channelId, user_id as userId, content, blocks_json as blocksJson, created_at as createdAt, is_system as isSystem, edited_at as editedAt, deleted_at as deletedAt, revision, deleted_by_user_id as deletedByUserId, delete_undo_until as deleteUndoUntil, author_bot_id as authorBotId, author_bot_name as authorBotName, author_bot_avatar_path as authorBotAvatarPath, bot_command_json as botCommandJson, reply_to_message_id as replyToMessageId, bot_localizations_json as botLocalizationsJson, forwarded, forward_source as forwardSource, forward_created_at as forwardCreatedAt';

function toMessageRecord(r: SqliteMessageRow): MessageRecord {
  if (r.authorBotId && !r.authorBotName) throw new Error('Stored bot message is missing its author name.');
  return {
    replyToMessageId: r.replyToMessageId ?? undefined,
    blocks: !r.deletedAt && r.blocksJson ? messageBlocksSchema.parse(JSON.parse(r.blocksJson)) : undefined,
    id: r.id,
    channelId: r.channelId,
    userId: r.authorBotId ?? r.userId,
    botAuthor: r.authorBotId && r.authorBotName
      ? { id: r.authorBotId, name: r.authorBotName, avatarPath: r.authorBotAvatarPath, ownerUserId: r.userId }
      : undefined,
    botCommand: r.botCommandJson ? botCommandContextSchema.parse(JSON.parse(r.botCommandJson)) : undefined,
    content: r.content,
    localizations: r.authorBotId && !r.deletedAt && r.botLocalizationsJson
      ? botMessageLocalizationsSchema.parse(JSON.parse(r.botLocalizationsJson)) : undefined,
    createdAt: r.createdAt,
    isSystem: Boolean(r.isSystem),
    editedAt: r.editedAt ?? null,
    deletedAt: r.deletedAt ?? null,
    revision: r.revision,
    deletedByUserId: r.deletedByUserId,
    deleteUndoUntil: r.deleteUndoUntil,
    forwarded: r.forwarded ? { source: r.forwardSource, createdAt: r.forwardCreatedAt } : undefined,
  };
}

export class SqliteMessageRepository implements IMessageRepository {
  constructor(private db: IDatabaseDriver) {}

  async setReaction(messageId: string, userId: string, emoji: string, add: boolean): Promise<'changed' | 'unchanged' | 'limit' | 'invalid'> {
    return this.db.transaction(() => {
      // Check again inside the transaction: a message may have been deleted
      // while the service was resolving channel permissions.
      const message = this.db.prepare(`SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE m.id = ? AND m.deleted_at IS NULL AND m.is_system = 0
          AND c.type IN ('TEXT', 'VOICE')`).get(messageId);
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
        AND EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.deleted_at IS NULL)
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

  async createChatMessage(message: MessageRecord, attachmentIds: string[], mentions: MentionRecord[]): Promise<{
    message: MessageRecord; created: boolean;
  } | null> {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(message.id) as SqliteMessageRow | undefined;
      if (existing) return { message: toMessageRecord(existing), created: false };
      for (const id of attachmentIds) {
        if (!this.db.prepare(`SELECT id FROM message_attachments
          WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL AND evicted = 0`)
          .get(id, message.userId, message.channelId)) return null;
      }
      this.insertMessage(message);
      for (const id of attachmentIds) {
        this.db.prepare('UPDATE message_attachments SET message_id = ? WHERE id = ?').run(message.id, id);
      }
      for (const mention of mentions) this.insertMention(mention);
      return { message, created: true };
    })();
  }

  async createBotMessage(message: MessageRecord, mentions: MentionRecord[] = []): Promise<MessageRecord | null> {
    const author = message.botAuthor;
    if (!author) throw new Error('Bot messages require an author snapshot.');
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM bots WHERE id = ? AND created_by_user_id = ?').get(author.id, author.ownerUserId)) return null;
      // A retried post finds its first copy, whose mentions are already recorded.
      const stored = this.db.prepare('SELECT id FROM messages WHERE id = ?').get(message.id);
      this.insertMessage(message, true);
      if (!stored) for (const mention of mentions) this.insertMention(mention);
      const row = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(message.id) as SqliteMessageRow | undefined;
      if (!row) throw new Error('Bot message was not persisted.');
      return toMessageRecord(row);
    })();
  }

  private insertMention(mention: MentionRecord): void {
    this.db.prepare('INSERT INTO mentions (id, user_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(mention.id, mention.userId, mention.channelId, mention.messageId, mention.createdAt);
  }

  private insertMessage(message: MessageRecord, idempotent = false): void {
    this.db.prepare(
      'INSERT INTO messages (id, channel_id, user_id, content, created_at, is_system, author_bot_id, author_bot_name, author_bot_avatar_path, bot_command_json, reply_to_message_id, bot_localizations_json, blocks_json, forwarded, forward_source, forward_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      (idempotent ? ' ON CONFLICT(id) DO NOTHING' : '')
    ).run(message.id, message.channelId, message.botAuthor?.ownerUserId ?? message.userId, message.content, message.createdAt, message.isSystem ? 1 : 0,
      message.botAuthor?.id ?? null, message.botAuthor?.name ?? null, message.botAuthor?.avatarPath ?? null,
      message.botCommand ? JSON.stringify(message.botCommand) : null, message.replyToMessageId ?? null,
      message.botAuthor && message.localizations ? JSON.stringify(message.localizations) : null,
      message.blocks ? JSON.stringify(message.blocks) : null,
      message.forwarded ? 1 : 0, message.forwarded?.source ?? null, message.forwarded?.createdAt ?? null);
  }

  async findById(messageId: string): Promise<MessageRecord | null> {
    const row = this.db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`
    ).get(messageId) as SqliteMessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async listByChannel(channelId: string, limit: number, beforeTimestamp?: number): Promise<MessageRecord[]> {
    // The oldest timestamp of a page is the client's next `beforeTimestamp`, so
    // a page takes every message of its oldest millisecond: stopping inside it
    // would skip the rest (S-APP-11). Ties keep the order they were sent in.
    const before = beforeTimestamp ? 'AND created_at < ?' : '';
    const scope = beforeTimestamp ? [channelId, beforeTimestamp] : [channelId];
    const rows = this.db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = ? ${before} AND created_at >= (
        SELECT MIN(created_at) FROM (
          SELECT created_at FROM messages WHERE channel_id = ? ${before} ORDER BY created_at DESC LIMIT ?))
       ORDER BY created_at DESC, rowid DESC`
    ).all(...scope, ...scope, limit) as SqliteMessageRow[];

    return rows.reverse().map(toMessageRecord);
  }

  async updateContent(messageId: string, content: string, editedAt: number, blocks?: MessageBlock[]): Promise<void> {
    this.db.prepare('UPDATE messages SET content = ?, blocks_json = ?, bot_localizations_json = NULL, edited_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL')
      .run(content, blocks ? JSON.stringify(blocks) : null, editedAt, messageId);
  }

  async markDeleted(messageId: string, deletedAt: number, actorId?: string, undoUntil?: number): Promise<void> {
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(messageId) as { deleted_at: number | null } | undefined;
      if (!existing || existing.deleted_at !== null) return;
      if (actorId && undoUntil && undoUntil > deletedAt) {
        this.db.prepare(`INSERT INTO message_deletion_backups (message_id, deleted_at, expires_at, content, blocks_json, bot_localizations_json)
          SELECT id, ?, ?, content, blocks_json, bot_localizations_json FROM messages WHERE id = ?`).run(deletedAt, undoUntil, messageId);
      }
      this.db.prepare(`UPDATE messages SET content = '', blocks_json = NULL, bot_localizations_json = NULL,
        deleted_at = ?, deleted_by_user_id = ?, delete_undo_until = ?, revision = revision + 1 WHERE id = ?`)
        .run(deletedAt, actorId ?? null, undoUntil ?? null, messageId);
    })();
  }

  async restoreDeleted(messageId: string, actorId: string, deletedAt: number, revision: number, now: number): Promise<boolean> {
    return this.db.transaction(() => {
      const backup = this.db.prepare(`SELECT b.content, b.blocks_json, b.bot_localizations_json
        FROM message_deletion_backups b JOIN messages m ON m.id = b.message_id
        WHERE m.id = ? AND m.deleted_by_user_id = ? AND m.deleted_at = ? AND m.revision = ?
          AND b.deleted_at = m.deleted_at AND b.expires_at > ?`)
        .get(messageId, actorId, deletedAt, revision, now) as { content: string; blocks_json: string | null; bot_localizations_json: string | null } | undefined;
      if (!backup) return false;
      this.db.prepare(`UPDATE messages SET content = ?, blocks_json = ?, bot_localizations_json = ?,
        deleted_at = NULL, deleted_by_user_id = NULL, delete_undo_until = NULL, revision = revision + 1 WHERE id = ?`)
        .run(backup.content, backup.blocks_json, backup.bot_localizations_json, messageId);
      this.db.prepare('DELETE FROM message_deletion_backups WHERE message_id = ?').run(messageId);
      return true;
    })();
  }

  async listExpiredDeletionMessageIds(now: number): Promise<string[]> {
    const rows = this.db.prepare(`SELECT id FROM messages
      WHERE delete_undo_until IS NOT NULL AND delete_undo_until <= ?`).all(now) as Array<{ id: string }>;
    return rows.map(row => row.id);
  }

  async purgeExpiredDeletions(now: number): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT message_id FROM message_deletion_backups WHERE expires_at <= ?)').run(now);
      this.db.prepare('DELETE FROM message_deletion_backups WHERE expires_at <= ?').run(now);
      this.db.prepare(`UPDATE messages SET deleted_by_user_id = NULL, delete_undo_until = NULL
        WHERE delete_undo_until IS NOT NULL AND delete_undo_until <= ?`).run(now);
    })();
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
      .prepare(`${SqliteAttachmentRepository.SELECT} WHERE evicted = 0
        AND NOT EXISTS (SELECT 1 FROM message_deletion_backups b WHERE b.message_id = message_attachments.message_id AND b.expires_at > ?)
        ORDER BY created_at ASC LIMIT ?`)
      .all(Date.now(), limit) as SqliteAttachmentRow[];
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

  async listByChannelWithTopics(channelId: string): Promise<AttachmentRecord[]> {
    const rows = this.db
      .prepare(`${SqliteAttachmentRepository.SELECT}
        WHERE channel_id = ? OR channel_id IN (SELECT id FROM channels WHERE forum_parent_id = ?)`)
      .all(channelId, channelId) as SqliteAttachmentRow[];
    return rows.map((r) => this.map(r));
  }

  async listUnreachable(now: number): Promise<AttachmentRecord[]> {
    const rows = this.db
      .prepare(`${SqliteAttachmentRepository.SELECT}
        WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = message_attachments.channel_id
            AND (c.forum_parent_id IS NULL OR EXISTS (SELECT 1 FROM channels f WHERE f.id = c.forum_parent_id)))
          OR (message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = message_attachments.message_id
            AND (m.deleted_at IS NULL
              OR EXISTS (SELECT 1 FROM message_deletion_backups b WHERE b.message_id = m.id AND b.expires_at > ?))))`)
      .all(now) as SqliteAttachmentRow[];
    return rows.map((r) => this.map(r));
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
    const update = partialUpdate(updates, ROLE_COLUMNS);
    if (!update) return;
    this.db.prepare(`UPDATE roles SET ${update.set} WHERE id = ?`).run(...update.values, roleId);
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

type BotRow = Omit<BotRecord, 'profilePending' | 'keyProofRequired'> & { profilePending: number; keyProofRequired: number };

export class SqliteBotRepository implements IBotRepository {
  constructor(private db: IDatabaseDriver) {}

  async create(bot: BotRecord): Promise<void> {
    this.db.prepare(
      `INSERT INTO bots (id, name, token_hash, avatar_path, bound_public_key, created_by_user_id, created_at, profile_pending, last_protocol_version, manifest_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(bot.id, bot.name, bot.tokenHash, bot.avatarPath, bot.boundPublicKey, bot.createdByUserId, bot.createdAt, bot.profilePending ? 1 : 0,
      bot.lastProtocolVersion ?? null, bot.manifestUrl ?? null);
  }

  async findById(id: string): Promise<BotRecord | null> {
    const row = this.db.prepare(
      `SELECT id, name, token_hash as tokenHash, avatar_path as avatarPath,
              bound_public_key as boundPublicKey, created_by_user_id as createdByUserId,
              created_at as createdAt, profile_pending as profilePending, last_protocol_version as lastProtocolVersion,
              manifest_url as manifestUrl, key_proof_required as keyProofRequired
       FROM bots WHERE id = ?`
    ).get(id) as BotRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<BotRecord | null> {
    const row = this.db.prepare(
      `SELECT id, name, token_hash as tokenHash, avatar_path as avatarPath,
              bound_public_key as boundPublicKey, created_by_user_id as createdByUserId,
              created_at as createdAt, profile_pending as profilePending, last_protocol_version as lastProtocolVersion,
              manifest_url as manifestUrl, key_proof_required as keyProofRequired
       FROM bots WHERE token_hash = ?`
    ).get(tokenHash) as BotRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listAll(): Promise<BotRecord[]> {
    const rows = this.db.prepare(
      `SELECT id, name, token_hash as tokenHash, avatar_path as avatarPath,
              bound_public_key as boundPublicKey, created_by_user_id as createdByUserId,
              created_at as createdAt, profile_pending as profilePending, last_protocol_version as lastProtocolVersion,
              manifest_url as manifestUrl, key_proof_required as keyProofRequired
       FROM bots ORDER BY created_at ASC`
    ).all() as BotRow[];
    return rows.map((r) => this.mapRow(r));
  }

  async update(id: string, updates: Partial<BotRecord>): Promise<void> {
    const update = partialUpdate(updates, BOT_COLUMNS);
    if (!update) return;
    this.db.prepare(`UPDATE bots SET ${update.set} WHERE id = ?`).run(...update.values, id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM bots WHERE id = ?').run(id);
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM bots').get() as { cnt: number };
    return row.cnt;
  }

  private mapRow(row: BotRow): BotRecord {
    return {
      id: row.id,
      name: row.name,
      profilePending: row.profilePending === 1,
      tokenHash: row.tokenHash,
      avatarPath: row.avatarPath ?? null,
      boundPublicKey: row.boundPublicKey ?? null,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      lastProtocolVersion: row.lastProtocolVersion ?? null,
      manifestUrl: row.manifestUrl ?? null,
      keyProofRequired: row.keyProofRequired === 1,
    };
  }
}
