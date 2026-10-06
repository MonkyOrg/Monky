import { v4 as uuidv4 } from 'uuid';
import {
  ChannelCreatePayload,
  ChannelReorderPayload,
  ChannelSummary,
  ChannelUpdatePayload,
  ProtocolErrorCode,
  canAccessChannel,
  Permission,
  getChannelPermissions,
  hasPermission,
  hasChannelPermission,
  channelOverwrites,
  channelPrivacy,
  withChannelPrivacy,
  withVoicePresence,
  type ChannelAccessRules,
  type ChannelPermissionOverwrite,
  channelCreateSchema,
  channelReorderSchema,
  channelUpdateSchema,
  ChannelCategory,
  CategoryCreatePayload,
  CategoryUpdatePayload,
  CategoryDeletePayload,
  CategoryReorderPayload,
  categoryCreateSchema,
  categoryUpdateSchema,
  categoryDeleteSchema,
  categoryReorderSchema,
} from '@monky/shared';
import { ChannelRecord } from '../../domain/entities';
import { ICategoryRepository, IChannelRepository, IRoleRepository, IServerRepository, IUserRepository } from '../../domain/repositories';
import { PermissionService } from './PermissionService';
import { BotPermissionService } from './BotPermissionService';

/** Everything needed to decide what a member may see, resolved once per call. */
export interface ChannelAccessContext {
  userId: string;
  permissions: number;
  roleIds: string[];
  isBot?: boolean;
}

export class ChannelService {
  /** Answered by the voice layer, which knows who is inside each room. */
  private voicePresence: (userId: string, channelId: string) => boolean = () => false;

  constructor(
    private channelRepo: IChannelRepository,
    private serverRepo: IServerRepository,
    private roleRepo: IRoleRepository,
    private permissionService: PermissionService,
    private botPermissions: BotPermissionService,
    private userRepo: IUserRepository,
    private categoryRepo?: ICategoryRepository,
  ) {}

  public setVoicePresence(provider: (userId: string, channelId: string) => boolean): void {
    this.voicePresence = provider;
  }

  /**
   * Rules that apply to one member. VIEW_CHANNEL only decides who finds a voice
   * room and joins it by themselves: someone already inside keeps seeing it
   * until they leave, even when they were moved in or lost access meanwhile.
   */
  public rulesFor<T extends ChannelAccessRules & { id: string }>(channel: T, context: ChannelAccessContext): ChannelAccessRules {
    return !context.isBot && this.voicePresence(context.userId, channel.id) ? withVoicePresence(channel, context.userId) : channel;
  }

  private toSummary(record: ChannelRecord): ChannelSummary {
    return {
      permissionOverwrites: record.permissionOverwrites,
      forumId: record.forumId ?? null,
      forumLocked: record.forumLocked ?? false,
      forumClosed: record.forumClosed ?? false,
      categoryId: record.categoryId ?? null,
      inheritCategoryPermissions: record.inheritCategoryPermissions ?? true,
      id: record.id,
      serverId: record.serverId,
      name: record.name,
      type: record.type,
      position: record.position,
      createdAt: record.createdAt,
      maxParticipants: record.maxParticipants,
      isPrivate: record.isPrivate,
      botCommandsEnabled: record.botCommandsEnabled,
      allowedRoleIds: record.allowedRoleIds,
    };
  }

  /**
   * Drops role ids that do not exist (#384). The foreign key on
   * channel_allowed_roles is enforced, so an unknown id coming from a crafted
   * payload would throw mid-transaction instead of being quietly ignored.
   */
  private async sanitizeRoleIds(roleIds: string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const known = new Set((await this.roleRepo.listAll()).map((role) => role.id));
    return roleIds.filter((id) => known.has(id));
  }

  private async validOverwrites(
    overwrites: ChannelPermissionOverwrite[] | undefined, isPrivate?: boolean, allowedRoleIds?: string[],
  ): Promise<boolean> {
    if (!overwrites) return true;
    if (allowedRoleIds !== undefined || isPrivate !== undefined && channelPrivacy(overwrites).isPrivate !== isPrivate) return false;
    const roles = new Set((await this.roleRepo.listAll()).map(role => role.id));
    const userIds = overwrites.flatMap(overwrite => overwrite.userId !== undefined ? [overwrite.userId] : []);
    const members = new Set((await this.userRepo.findByIds(userIds)).map(user => user.id));
    return overwrites.every(overwrite => overwrite.userId !== undefined ? members.has(overwrite.userId)
      : overwrite.roleId === null || roles.has(overwrite.roleId));
  }

  public getRoleAccessVersion(): number | null {
    return this.permissionService.getRoleAccessVersion();
  }

  public async getAccessContext(userId: string, channelId?: string): Promise<ChannelAccessContext> {
    const botPermissions = this.botPermissions.getChannelPermissions(userId);
    if (botPermissions !== undefined) {
      const channel = channelId ? await this.channelRepo.findById(channelId) : null;
      return { userId, permissions: channelId
        ? channel && !channel.isPrivate ? getChannelPermissions(channel, botPermissions, [], true) : 0
        : botPermissions, roleIds: [], isBot: true };
    }
    const [permissions, roles] = await Promise.all([
      this.permissionService.getUserPermissions(userId),
      this.roleRepo.listRolesForUser(userId),
    ]);
    const roleIds = roles.map(role => role.id);
    const channel = channelId ? await this.channelRepo.findById(channelId) : null;
    return { userId, permissions: channelId ? channel
      ? getChannelPermissions(this.rulesFor(channel, { userId, permissions, roleIds }), permissions, roleIds, false, userId) : 0 : permissions, roleIds };
  }

  public async listChannels(): Promise<ChannelSummary[]> {
    const server = await this.serverRepo.getServer();
    if (!server) return [];

    const channels = await this.channelRepo.listByServerId(server.id);
    return channels.map((c) => this.toSummary(c));
  }

  public async canUserAccessChannel(userId: string, channelId: string, permission: Permission = Permission.VIEW_CHANNEL): Promise<boolean> {
    const channel = await this.channelRepo.findById(channelId);
    if (!channel) return false;

    const context = await this.getAccessContext(userId);
    if (permission === Permission.MANAGE_CHANNELS || permission === Permission.MOVE_MEMBERS) {
      return hasPermission(context.permissions, permission);
    }
    const rules = this.rulesFor(channel, context);
    return canAccessChannel(rules, context.permissions, context.roleIds, context.isBot, userId) &&
      hasChannelPermission(rules, context.permissions, context.roleIds, permission, context.isBot, userId);
  }

  public async canUserAccessCategory(userId: string, categoryId: string, permission: Permission): Promise<boolean> {
    const category = await this.categoryRepo?.findById(categoryId);
    if (!category) return false;
    const context = await this.getAccessContext(userId);
    if (permission === Permission.MANAGE_CHANNELS || permission === Permission.MOVE_MEMBERS) {
      return hasPermission(context.permissions, permission);
    }
    return canAccessChannel(category, context.permissions, context.roleIds, context.isBot, userId) &&
      hasChannelPermission(category, context.permissions, context.roleIds, permission, context.isBot, userId);
  }

  /** Visibility metadata for one channel, used to scope broadcasts (#384). */
  public async getChannelSummary(channelId: string): Promise<ChannelSummary | null> {
    const channel = await this.channelRepo.findById(channelId);
    return channel ? this.toSummary(channel) : null;
  }

  public async createChannel(
    payload: ChannelCreatePayload
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; channel?: ChannelSummary }> {
    const parseResult = channelCreateSchema.safeParse(payload);
    if (!parseResult.success) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: parseResult.error.errors[0]?.message || 'Parâmetros de canal inválidos',
      };
    }

    if (!await this.validOverwrites(parseResult.data.permissionOverwrites, payload.isPrivate, payload.allowedRoleIds)) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Permissões ou cargos inválidos.' };
    }

    const server = await this.serverRepo.getServer();
    if (!server) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.INTERNAL_ERROR,
        errorMessage: 'Servidor não encontrado',
      };
    }

    const existingChannels = await this.channelRepo.listByServerId(server.id);
    const { categoryId, inheritCategoryPermissions } = parseResult.data;
    if (categoryId && (await this.categoryRepo?.findById(categoryId))?.serverId !== server.id) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Categoria não encontrada' };
    }
    const isPrivate = parseResult.data.isPrivate;
    const channelRecord: ChannelRecord = {
      permissionOverwrites: parseResult.data.permissionOverwrites,
      categoryId,
      inheritCategoryPermissions,
      id: uuidv4(),
      serverId: server.id,
      name: parseResult.data.name,
      type: parseResult.data.type,
      position: Math.max(-1, ...existingChannels.filter((channel) => (channel.categoryId ?? null) === categoryId).map((channel) => channel.position)) + 1,
      createdAt: Date.now(),
      maxParticipants: parseResult.data.maxParticipants || 10,
      isPrivate,
      botCommandsEnabled: parseResult.data.botCommandsEnabled,
      // Links are meaningless on a public channel and would resurface if it were
      // later made private, so they are only stored while privacy is on.
      allowedRoleIds: isPrivate ? await this.sanitizeRoleIds(parseResult.data.allowedRoleIds) : [],
    };

    await this.channelRepo.create(channelRecord);

    return {
      success: true,
      channel: this.toSummary(await this.channelRepo.findById(channelRecord.id) ?? channelRecord),
    };
  }

  public async updateChannel(
    payload: ChannelUpdatePayload
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; channel?: ChannelSummary }> {
    const parseResult = channelUpdateSchema.safeParse(payload);
    if (!parseResult.success) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: parseResult.error.errors[0]?.message || 'Parâmetros de canal inválidos',
      };
    }

    const { channelId, name, maxParticipants, isPrivate, allowedRoleIds, botCommandsEnabled, categoryId, inheritCategoryPermissions, permissionOverwrites } = parseResult.data;
    if (!await this.validOverwrites(permissionOverwrites, isPrivate, allowedRoleIds)) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Permissões ou cargos inválidos.' };
    }
    const existing = await this.channelRepo.findById(channelId);
    if (!existing) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.CHANNEL_NOT_FOUND,
        errorMessage: 'Canal não encontrado',
      };
    }

    if (categoryId && (await this.categoryRepo?.findById(categoryId))?.serverId !== existing.serverId) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Categoria não encontrada' };
    }
    if (existing.forumId) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Use forum post controls.' };
    }
    const nextCategoryId = categoryId === undefined ? existing.categoryId ?? null : categoryId;
    const changesAccess = isPrivate !== undefined || allowedRoleIds !== undefined || permissionOverwrites !== undefined;
    const nextInherit = nextCategoryId
      ? inheritCategoryPermissions ?? (changesAccess ? false : existing.inheritCategoryPermissions ?? true)
      : false;
    const nextIsPrivate = isPrivate ?? existing.isPrivate;
    const nextBotCommandsEnabled = botCommandsEnabled ?? existing.botCommandsEnabled;
    // Turning privacy off clears the role list, so switching it back on later
    // starts from a blank slate instead of silently restoring the old audience.
    const nextRoleIds = !nextIsPrivate
      ? []
      : allowedRoleIds !== undefined
        ? await this.sanitizeRoleIds(allowedRoleIds)
        : existing.allowedRoleIds;
    const nextOverwrites = permissionOverwrites ?? (
      isPrivate !== undefined || allowedRoleIds !== undefined
        ? withChannelPrivacy(channelOverwrites(existing), nextIsPrivate, nextRoleIds)
        : channelOverwrites(existing));

    await this.channelRepo.update(channelId, {
      ...(changesAccess ? {
        permissionOverwrites: nextOverwrites,
        ...channelPrivacy(nextOverwrites, existing),
        ...(isPrivate !== undefined ? { isPrivate } : {}),
      }
        : nextCategoryId !== (existing.categoryId ?? null) || nextInherit !== (existing.inheritCategoryPermissions ?? true)
          ? { permissionOverwrites: nextOverwrites, isPrivate: existing.isPrivate, allowedRoleIds: existing.allowedRoleIds } : {}),
      categoryId: nextCategoryId,
      inheritCategoryPermissions: nextInherit,
      ...(name !== undefined ? { name } : {}),
      ...(maxParticipants !== undefined ? { maxParticipants } : {}),
      botCommandsEnabled: nextBotCommandsEnabled,
    });

    return {
      success: true,
      channel: this.toSummary(await this.channelRepo.findById(channelId) ?? {
        ...existing,
        name: name ?? existing.name,
        maxParticipants: maxParticipants ?? existing.maxParticipants,
        isPrivate: nextIsPrivate,
        botCommandsEnabled: nextBotCommandsEnabled,
        allowedRoleIds: nextRoleIds,
      }),
    };
  }

  /**
   * Reorders one mixed category (or a legacy type-scoped request). Unknown,
   * duplicate and out-of-scope ids are ignored; omitted channels stay at the
   * end so an out-of-date client cannot remove them from the ordering.
   */
  public async reorderChannels(
    payload: ChannelReorderPayload,
    actorUserId?: string,
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; positions?: Array<{ channelId: string; position: number }> }> {
    const parseResult = channelReorderSchema.safeParse(payload);
    if (!parseResult.success) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: parseResult.error.errors[0]?.message || 'Parâmetros de ordenação inválidos',
      };
    }

    const server = await this.serverRepo.getServer();
    if (!server) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.INTERNAL_ERROR,
        errorMessage: 'Servidor não encontrado',
      };
    }

    const { type, categoryId, orderedIds } = parseResult.data;
    const ofType = (await this.channelRepo.listByServerId(server.id)).filter((c) =>
      !c.forumId && (categoryId !== undefined ? (c.categoryId ?? null) === categoryId : c.type === type));
    const byId = new Map(ofType.map((c) => [c.id, c]));

    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of orderedIds) {
      if (!byId.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
    for (const channel of ofType) {
      if (!seen.has(channel.id)) ordered.push(channel.id);
    }

    const positions = ordered.map((channelId, index) => ({ channelId, position: index }));
    if (actorUserId) {
      const context = await this.getAccessContext(actorUserId);
      if (!hasPermission(context.permissions, Permission.MANAGE_CHANNELS) &&
          positions.some(position => byId.get(position.channelId)!.position !== position.position)) {
        return { success: false, errorCode: ProtocolErrorCode.PERMISSION_DENIED, errorMessage: 'Permissão insuficiente para reordenar estes canais.' };
      }
    }
    if (this.channelRepo.updatePositions) await this.channelRepo.updatePositions(positions);
    else for (const { channelId, position } of positions) await this.channelRepo.updatePosition(channelId, position);

    return { success: true, positions };
  }

  public async deleteChannel(
    channelId: string
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string }> {
    const channel = await this.channelRepo.findById(channelId);
    if (!channel) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.CHANNEL_NOT_FOUND,
        errorMessage: 'Canal não encontrado',
      };
    }

    await this.channelRepo.delete(channelId);
    return { success: true };
  }

  public async listCategories(): Promise<ChannelCategory[]> {
    const server = await this.serverRepo.getServer();
    return server && this.categoryRepo ? this.categoryRepo.listByServerId(server.id) : [];
  }

  public async mutateCategory(
    operation: 'create' | 'update' | 'delete' | 'reorder',
    payload: CategoryCreatePayload | CategoryUpdatePayload | CategoryDeletePayload | CategoryReorderPayload,
    actorUserId?: string,
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string }> {
    const repo = this.categoryRepo;
    const server = await this.serverRepo.getServer();
    if (!repo || !server) return { success: false, errorCode: ProtocolErrorCode.INTERNAL_ERROR };
    const invalid = { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Categoria inválida' };
    if (operation === 'create') {
      const parsed = categoryCreateSchema.safeParse(payload);
      if (!parsed.success || !await this.validOverwrites(parsed.data.permissionOverwrites,
        'isPrivate' in payload ? payload.isPrivate : undefined, 'allowedRoleIds' in payload ? payload.allowedRoleIds : undefined)) return invalid;
      const categories = await repo.listByServerId(server.id);
      if (categories.length >= 200) return invalid;
      await repo.create({
        ...parsed.data, id: uuidv4(), serverId: server.id, createdAt: Date.now(),
        position: Math.max(-1, ...categories.map((category) => category.position)) + 1,
        allowedRoleIds: parsed.data.isPrivate ? await this.sanitizeRoleIds(parsed.data.allowedRoleIds) : [],
      });
    } else if (operation === 'update') {
      const parsed = categoryUpdateSchema.safeParse(payload);
      if (!parsed.success || !await this.validOverwrites(parsed.data.permissionOverwrites, parsed.data.isPrivate, parsed.data.allowedRoleIds)) return invalid;
      const existing = await repo.findById(parsed.data.categoryId);
      if (!existing || existing.serverId !== server.id) return invalid;
      const isPrivate = parsed.data.isPrivate ?? existing.isPrivate;
      await repo.update(existing.id, {
        ...(parsed.data.isPrivate !== undefined ? { isPrivate: parsed.data.isPrivate } : {}),
        permissionOverwrites: parsed.data.permissionOverwrites ?? (
          parsed.data.isPrivate !== undefined || parsed.data.allowedRoleIds !== undefined
            ? withChannelPrivacy(channelOverwrites(existing), isPrivate,
              await this.sanitizeRoleIds(parsed.data.allowedRoleIds ?? existing.allowedRoleIds))
            : undefined),
        name: parsed.data.name,
      });
    } else if (operation === 'delete') {
      const parsed = categoryDeleteSchema.safeParse(payload);
      if (!parsed.success || (await repo.findById(parsed.data.categoryId))?.serverId !== server.id) return invalid;
      await repo.deletePreservingAccess(parsed.data.categoryId);
    } else {
      const parsed = categoryReorderSchema.safeParse(payload);
      if (!parsed.success) return invalid;
      const categories = await repo.listByServerId(server.id);
      const known = new Set(categories.map((category) => category.id));
      const ordered = [...new Set(parsed.data.orderedIds)].filter((id) => known.has(id));
      const next = [...ordered, ...categories.map(category => category.id).filter(id => !ordered.includes(id))];
      if (actorUserId) {
        const context = await this.getAccessContext(actorUserId);
        if (categories.some(category => category.position !== next.indexOf(category.id) &&
          !hasPermission(context.permissions, Permission.MANAGE_CHANNELS))) {
          return { success: false, errorCode: ProtocolErrorCode.PERMISSION_DENIED, errorMessage: 'Permissão insuficiente para reordenar estas categorias.' };
        }
      }
      await repo.reorder(next);
    }
    return { success: true };
  }
}
