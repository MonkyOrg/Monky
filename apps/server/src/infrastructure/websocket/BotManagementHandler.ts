import type { WebSocket } from 'ws';
import {
  MessageType, Permission, ProtocolErrorCode, botCreateSchema, botInstallPreviewRequestSchema, botInstallSchema,
  botPermissionsGetSchema, botPermissionsUpdateSchema, botProfileUpdateSchema, botSettingsGetSchema, botSettingsListSchema,
  botSettingsUpdateSchema, commandRegisterSchema, isBotStorageCapability, localBotIdentitySchema,
  type BotCreatedPayload, type BotInstalledPayload, type BotInstallPayload, type BotListResponsePayload,
  type BotProfileUpdatedPayload, type BotRevokedPayload, type BotRevokePayload, type BotStorageUsage,
  type CommandRegisteredPayload, type CommandsListResponsePayload, type ServerMessage, type UserUpdatedPayload,
} from '@monky/shared';
import type { BotLocalExecutionService } from '../../application/services/BotLocalExecutionService';
import { BotPermissionError } from '../../application/services/BotPermissionService';
import type { BotService } from '../../application/services/BotService';
import { BotSettingsError, type BotSettingsService } from '../../application/services/BotSettingsService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { CommandRegistry } from '../../application/services/CommandRegistry';
import type { CommunityService } from '../../application/services/CommunityService';
import type { PermissionService } from '../../application/services/PermissionService';
import { auditDiff, auditRef, type ServerAuditService } from '../../application/services/ServerAuditService';
import type { IServerRepository } from '../../domain/repositories';
import { Logger } from '../logger/Logger';
import type { AccessEpoch } from './access/AccessEpoch';
import type { AuditRecorder } from './AuditRecorder';
import type { BotInteractionHandler, BotInteractionSession } from './BotInteractionHandler';
import type { BotSelectorHandler } from './BotSelectorHandler';
import {
  supportsBotStorage, visibleBotInstallPreview, visibleBotPermissions, visibleBotSettings, visibleBotSettingsList,
} from './botStorageProjection';
import type { ClientSession, SignedInSession } from './ClientSession';
import type { FanOutFrames } from './Outbox';
import type { UnexpectedFailure } from './protocolErrors';
import { route, type Route } from './routing/MessageRouter';

export interface BotManagementHost {
  readonly botService?: BotService;
  readonly botSettings?: BotSettingsService;
  readonly commandRegistry: CommandRegistry;
  readonly botSelectors?: Pick<BotSelectorHandler, 'revokeBot'>;
  readonly botInteractions: Pick<BotInteractionHandler, 'commandsChanged' | 'settingsChanged'>;
  readonly botLocalExecution: Pick<BotLocalExecutionService<BotInteractionSession>, 'invalidateBot' | 'commandsChanged' | 'settingsChanged'>;
  readonly communityService?: Pick<CommunityService, 'prepareBotDeletion'>;
  readonly serverRepo: IServerRepository;
  readonly permissions: Pick<PermissionService, 'checkPermission'>;
  readonly channels: Pick<ChannelService, 'getRoleAccessVersion'>;
  readonly epoch: AccessEpoch;
  readonly audit?: ServerAuditService;
  readonly auditLog: AuditRecorder;
  readonly closing: boolean;
  sessions(): Iterable<ClientSession>;
  sessionsOfUser(userId: string): ClientSession[];
  findSession(sessionId: string): ClientSession | undefined;
  isCurrentSession(session: BotInteractionSession): boolean;
  /** Ends a bot's connection, and the commands it registered with it. */
  disconnectBot(botId: string, reason?: 'revoked'): void;
  send(ws: WebSocket, message: ServerMessage, frames?: FanOutFrames): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  sendCaughtError(ws: WebSocket, error: unknown, failure: UnexpectedFailure, requestId?: string): void;
  broadcast(message: ServerMessage, ignoreWs?: WebSocket): void;
}

/**
 * Bots as the server administers them (#569): creating, installing and
 * revoking them, their grants and profile, and what each one declares as it
 * connects — its slash commands and its settings — with the lists every
 * member and bot is kept up to date with.
 */
export class BotManagementHandler {
  /** Bot settings broadcasts run one after another, so older data never lands after newer (BOTS-5). */
  private settingsBroadcasts: Promise<void> = Promise.resolve();
  /** Level warnings go out in order, even while each recipient's permission is checked. */
  private storageLevels: Promise<void> = Promise.resolve();

  constructor(private readonly host: BotManagementHost) {}

  routes(): Route[] {
    return [
      route({
        types: [MessageType.BOT_SETTINGS_LIST, MessageType.BOT_SETTINGS_GET, MessageType.BOT_SETTINGS_UPDATE],
        handle: ({ session, type, payload, requestId }) => this.settingsRequest(session, type, payload, requestId),
      }),
      route({
        types: [MessageType.BOT_PERMISSIONS_GET, MessageType.BOT_PERMISSIONS_UPDATE],
        handle: ({ session, type, payload, requestId }) => this.grantsRequest(session, type, payload, requestId),
      }),
      route({
        types: [MessageType.BOT_INSTALL_PREVIEW],
        handle: ({ session, payload, requestId }) => this.installPreview(session, payload, requestId),
      }),
      route({
        types: [MessageType.BOT_CREATE], permission: Permission.MANAGE_BOTS,
        handle: ({ session, payload, requestId }) => this.create(session, payload, requestId),
      }),
      route({
        types: [MessageType.BOT_LIST], permission: Permission.MANAGE_BOTS,
        handle: ({ session, requestId }) => this.list(session, requestId),
      }),
      route({
        types: [MessageType.BOT_UPDATE_PROFILE],
        handle: ({ session, payload, requestId }) => this.updateProfile(session, payload, requestId),
      }),
      route({
        types: [MessageType.BOT_REVOKE], permission: Permission.MANAGE_BOTS,
        handle: ({ session, payload, requestId }) => this.revoke(session, payload as BotRevokePayload, requestId),
      }),
      route({
        types: [MessageType.BOT_INSTALL], permission: Permission.MANAGE_BOTS,
        handle: ({ session, payload, requestId }) => this.install(session, payload as BotInstallPayload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_REGISTER],
        handle: ({ session, payload, requestId }) => this.registerCommands(session, payload, requestId),
      }),
      route({ types: [MessageType.COMMANDS_LIST], handle: ({ session, requestId }) => this.sendCommands(session, requestId) }),
    ];
  }

  /** Resolves once every bot settings broadcast queued so far is over. */
  settled(): Promise<void> {
    return this.settingsBroadcasts;
  }

  private async create(session: SignedInSession, payload: unknown, requestId?: string): Promise<void> {
    if (!this.host.botService) return;

    const parsed = botCreateSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST,
        'O vínculo não aceita nome ou avatar definidos pelo cliente.', requestId);
      return;
    }
    const authorized = await this.authorizeManagement(session, requestId);
    if (!authorized) return;
    const result = await this.host.botService.create(session.user.id, authorized);

    if (!result.success) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao criar bot.',
        requestId
      );
      return;
    }
    if (!authorized()) {
      await this.host.botService.revoke(result.bot.id);
      return;
    }

    const createdPayload: BotCreatedPayload = {
      bot: result.bot,
      token: result.token,
    };
    this.host.send(session.ws, { type: MessageType.BOT_CREATED, requestId, payload: createdPayload });
    this.host.auditLog.record(session, 'bot.create', { target: auditRef.bot(result.bot.id, result.bot.name) });
    await this.broadcastSettings();
  }

  private async list(session: SignedInSession, requestId?: string): Promise<void> {
    if (!this.host.botService) return;
    const bots = await this.host.botService.list();
    const listPayload: BotListResponsePayload = { bots };
    this.host.send(session.ws, { type: MessageType.BOT_LIST_RESPONSE, requestId, payload: listPayload });
  }

  /**
   * Whether a person may manage bots, answering the refusal when not. The answer
   * returned stays true while neither that person's connection nor access moved.
   */
  async authorizeManagement(session: ClientSession, requestId?: string): Promise<(() => boolean) | undefined> {
    if (!session.user || session.isBot) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Only human bot administrators may approve access.', requestId);
      return undefined;
    }
    for (let attempt = 0; attempt < 8 && this.host.isCurrentSession(session); attempt++) {
      const version = this.host.epoch.generation;
      const roles = this.host.channels.getRoleAccessVersion();
      if (roles === null) continue;
      const allowed = await this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_BOTS);
      const current = () => this.host.isCurrentSession(session) && version === this.host.epoch.generation &&
        roles === this.host.channels.getRoleAccessVersion();
      if (!current()) continue;
      if (allowed) return current;
      break;
    }
    this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bot management permission is unavailable or changed.', requestId);
    return undefined;
  }

  /** A bot's grants: read by an administrator or by the bot itself, changed by an administrator. */
  private async grantsRequest(session: SignedInSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    try {
      const permissions = this.host.botService?.permissions;
      if (!permissions || !this.host.isCurrentSession(session)) return;
      const parsed = type === MessageType.BOT_PERMISSIONS_UPDATE
        ? botPermissionsUpdateSchema.safeParse(payload) : botPermissionsGetSchema.safeParse(payload);
      if (!parsed.success) throw new BotPermissionError(ProtocolErrorCode.BAD_REQUEST, 'Invalid bot permission request.');
      const { botId } = parsed.data;
      if (session.isBot && (type !== MessageType.BOT_PERMISSIONS_GET || session.botId !== botId)) {
        throw new BotPermissionError(ProtocolErrorCode.PERMISSION_DENIED, 'Bots may only read their own grants.');
      }
      if (!session.isBot) {
        const authorized = await this.authorizeManagement(session, requestId);
        if (!authorized || !authorized()) return;
      }
      if (type === MessageType.BOT_PERMISSIONS_UPDATE) {
        const previous = [...(permissions.get(botId)?.granted ?? [])];
        const update = botPermissionsUpdateSchema.parse(parsed.data);
        // A client that cannot see the storage capabilities leaves them as they were.
        permissions.approve(session.user.id, supportsBotStorage(session) ? update
          : { ...update, granted: [...update.granted, ...previous.filter(isBotStorageCapability)] });
        // Invalidate the old socket synchronously with persistence. Work resumed
        // after any await cannot reuse a grant, even if it is quickly re-enabled.
        this.host.disconnectBot(botId);
        await this.host.botSelectors?.revokeBot(botId);
        const granted = permissions.get(botId)?.granted ?? [];
        const added = granted.filter((capability) => !previous.includes(capability));
        const removed = previous.filter((capability) => !granted.includes(capability));
        if (this.host.audit && (added.length || removed.length)) {
          const bot = await this.host.botService?.findById(botId);
          this.host.auditLog.record(session, 'bot.permissions', {
            target: auditRef.bot(botId, bot?.name ?? botId),
            changes: [
              ...(added.length ? [{ field: 'capabilitiesGranted', after: added }] : []),
              ...(removed.length ? [{ field: 'capabilitiesRevoked', after: removed }] : []),
            ],
          });
        }
      }
      const state = permissions.get(botId);
      if (!state) throw new BotPermissionError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
      this.host.send(session.ws, { type: MessageType.BOT_PERMISSIONS_SNAPSHOT, requestId,
        payload: { botId, permissions: visibleBotPermissions(session, state) } });
      await this.broadcastSettings(botId);
    } catch (error) {
      this.sendSettingsError(session, error, requestId);
    }
  }

  private async installPreview(session: SignedInSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = botInstallPreviewRequestSchema.safeParse(payload);
    if (!parsed.success || !this.host.botService) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'URL do manifest inválida.', requestId);
      return;
    }
    const authorized = await this.authorizeManagement(session, requestId);
    if (!authorized || !session.sessionId) return;
    const result = await this.host.botService.previewInstallation(
      parsed.data.manifestUrl, session.sessionId, session.requestServerUrl,
    );
    if (!authorized()) return;
    if (!result.success) this.host.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
    else this.host.send(session.ws, { type: MessageType.BOT_INSTALL_PREVIEW_RESULT, requestId,
      payload: visibleBotInstallPreview(session, result.preview) });
  }

  /** A bot's name and avatar, which only the bot itself sets. */
  private async updateProfile(session: SignedInSession, payload: unknown, requestId?: string): Promise<void> {
    if (!this.host.botService) return;
    if (!session.isBot || !session.botId) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED,
        'Nome e avatar são definidos exclusivamente pelo próprio bot.', requestId);
      return;
    }
    const parsed = botProfileUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const code = parsed.error.issues.some((issue) => issue.path[0] === 'avatarBase64' && issue.code === 'too_big')
        ? ProtocolErrorCode.AVATAR_TOO_LARGE : ProtocolErrorCode.BOT_INVALID_PROFILE;
      this.host.sendError(session.ws, code, 'Perfil do bot inválido.', requestId);
      return;
    }
    const botId = session.botId;
    if (parsed.data.botId !== undefined && parsed.data.botId !== botId) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots só podem editar o próprio perfil.', requestId);
      return;
    }
    if (!this.host.isCurrentSession(session)) return;
    const previous = this.host.audit ? await this.host.botService.findById(botId) : null;
    const result = await this.host.botService.updateProfile(botId, parsed.data);
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    const updated: BotProfileUpdatedPayload = { bot: result.bot };
    // Bots announce their profile on every start: an unchanged one is only answered (BOTS-4).
    if (!result.changed) {
      this.host.send(session.ws, { type: MessageType.BOT_PROFILE_UPDATED, requestId, payload: updated });
      return;
    }
    if (previous) {
      // Bots resend their avatar on every start, so only a new name is worth recording.
      const changes = auditDiff([['name', previous.name, result.bot.name]]);
      if (changes.length) this.host.auditLog.record(session, 'bot.profile', { changes });
    }

    this.host.commandRegistry.updateBotIdentity(botId, result.bot.name, result.bot.avatarUrl);
    for (const target of this.host.sessionsOfUser(botId)) {
      if (!target.user || !target.isBot) continue;
      target.user = { ...target.user, nickname: result.bot.name, avatarUrl: result.bot.avatarUrl };
      this.host.broadcast({
        type: MessageType.USER_UPDATED,
        payload: { user: target.user } satisfies UserUpdatedPayload,
      });
    }
    this.host.send(session.ws, { type: MessageType.BOT_PROFILE_UPDATED, requestId, payload: updated });
    this.host.broadcast({ type: MessageType.BOT_PROFILE_UPDATED, payload: updated }, session.ws);
    this.broadcastCommands();
    await this.broadcastSettings();
  }

  private async revoke(session: SignedInSession, payload: BotRevokePayload, requestId?: string): Promise<void> {
    const botService = this.host.botService;
    if (!botService) return;

    if (typeof payload?.botId !== 'string' || !payload.botId || payload.botId.length > 128) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bot inválido.', requestId);
      return;
    }
    const cleanupCommunityMedia = this.host.communityService?.prepareBotDeletion(payload.botId);
    const revoked = this.host.audit ? await botService.findById(payload.botId) : null;
    const result = await this.host.epoch.change(() => botService.revoke(payload.botId));
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    cleanupCommunityMedia?.();
    if (revoked) this.host.auditLog.record(session, 'bot.revoke', { target: auditRef.bot(revoked.id, revoked.name) });

    this.host.disconnectBot(payload.botId, 'revoked');
    const revokedPayload: BotRevokedPayload = { botId: payload.botId };
    this.host.send(session.ws, { type: MessageType.BOT_REVOKED, requestId, payload: revokedPayload });
    this.host.broadcast({ type: MessageType.BOT_REVOKED, payload: revokedPayload }, session.ws);
    await this.broadcastSettings();
  }

  private async install(session: SignedInSession, payload: BotInstallPayload, requestId?: string): Promise<void> {
    if (!this.host.botService) return;

    const parsed = botInstallSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Revise as permissões do bot antes de instalar.', requestId);
      return;
    }
    const authorized = await this.authorizeManagement(session, requestId);
    if (!authorized || !session.sessionId) return;

    const server = await this.host.serverRepo.getServer();
    const serverName = server?.name || 'Monky Server';

    const result = await this.host.botService.installFromPreview(
      parsed.data.previewId,
      parsed.data.grantedCapabilities,
      session.sessionId,
      session.user.id,
      serverName,
      session.requestServerUrl,
      authorized,
    );

    if (!result.success) {
      if (result.revokedBotId) {
        this.host.disconnectBot(result.revokedBotId, 'revoked');
        this.host.broadcast({ type: MessageType.BOT_REVOKED, payload: { botId: result.revokedBotId } satisfies BotRevokedPayload });
        await this.broadcastSettings();
      }
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao instalar bot.',
        requestId
      );
      return;
    }

    const installedPayload: BotInstalledPayload = { bot: result.bot };
    this.host.send(session.ws, { type: MessageType.BOT_INSTALLED, requestId, payload: installedPayload });
    this.host.auditLog.record(session, 'bot.install', {
      target: auditRef.bot(result.bot.id, result.bot.name),
      changes: result.bot.permissions?.granted.length
        ? [{ field: 'capabilitiesGranted', after: [...result.bot.permissions.granted] }] : [],
    });
    this.broadcastCommands();
    await this.broadcastSettings(result.bot.id);
  }

  /** What a bot declares as it connects: its commands, its settings and the capabilities it asks for. */
  private async registerCommands(session: SignedInSession, payload: unknown, requestId?: string): Promise<void> {
    if (!session.isBot || !session.botId || !this.host.isCurrentSession(session)) {
      this.host.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Apenas bots podem registrar comandos.', requestId);
      return;
    }

    const parsed = commandRegisterSchema.safeParse(payload);
    if (!parsed.success) {
      const settingsError = parsed.error.issues.some((issue) => issue.path[0] === 'settings');
      const capabilitiesError = parsed.error.issues.some((issue) => issue.path[0] === 'requestedCapabilities');
      this.host.sendError(session.ws, capabilitiesError ? ProtocolErrorCode.BOT_CAPABILITIES_INVALID
        : settingsError ? ProtocolErrorCode.BOT_SETTINGS_INVALID : ProtocolErrorCode.BOT_INVALID_OPTIONS,
        settingsError || capabilitiesError ? parsed.error.message : 'Definições de comandos inválidas.', requestId);
      return;
    }
    const bot = await this.host.botService?.findById(session.botId);
    const botKey = localBotIdentitySchema.shape.botPublicKey.safeParse(bot?.boundPublicKey);
    if (!this.host.isCurrentSession(session)) return;
    if (!bot || !botKey.success || botKey.data !== session.botPublicKey) {
      this.host.botLocalExecution.invalidateBot(session.botId);
      this.host.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Bot binding is no longer valid.', requestId);
      return;
    }
    try {
      const permissionService = this.host.botService?.permissions;
      if (!permissionService) throw new BotPermissionError(ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED, 'Bot permission storage is unavailable.');
      const previous = permissionService.get(session.botId);
      const declaration = permissionService.declare(session.botId, parsed.data.requestedCapabilities);
      if (declaration.changed && previous?.requested !== null) {
        this.host.disconnectBot(session.botId);
        await this.host.botSelectors?.revokeBot(session.botId);
        await this.broadcastSettings(session.botId);
        return;
      }
      if (!this.host.botSettings && parsed.data.settings) {
        throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, 'Bot settings are unavailable.');
      }
      const settings = this.host.botSettings?.register(
        session.botId, parsed.data.settings, parsed.data.commands.some((command) => command.downloadsSound === true)
      ) ?? { schemaRevision: 0, revision: 0, values: {} };
      // No await between persistence and registry replacement: validation of both
      // declarations has completed before either set becomes visible.
      const registered = this.host.commandRegistry.register(
        session.botId, session.user.nickname, parsed.data.commands, session.user.avatarUrl, botKey.data
      );
      this.host.botLocalExecution.commandsChanged(session.botId);
      this.host.botInteractions.commandsChanged(session.botId);
      this.host.send(session.ws, {
        type: MessageType.COMMAND_REGISTERED, requestId,
        payload: { registered, settings, permissions: declaration.permissions } satisfies CommandRegisteredPayload,
      });
      session.botSettingsReady = true;
      this.broadcastCommands();
      await this.broadcastSettings(session.botId);
    } catch (error) {
      this.sendSettingsError(session, error, requestId);
    }
  }

  /** The settings of the bots: their list, one bot's settings, and changing them. */
  private async settingsRequest(session: SignedInSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    if (!this.host.isCurrentSession(session)) return;
    try {
      if (!this.host.botSettings || !this.host.botService) {
        throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'Bot settings are unavailable.');
      }
      const settingsService = this.host.botSettings;
      if (type === MessageType.BOT_SETTINGS_LIST) {
        if (session.isBot) throw new BotSettingsError(ProtocolErrorCode.PERMISSION_DENIED, 'Only human members may list bot settings.');
        if (!botSettingsListSchema.safeParse(payload).success) {
          throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'Invalid bot settings list request.');
        }
        await this.sendSettingsList(session, requestId);
        return;
      }
      const parsed = type === MessageType.BOT_SETTINGS_UPDATE
        ? botSettingsUpdateSchema.safeParse(payload) : botSettingsGetSchema.safeParse(payload);
      if (!parsed.success) throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, 'Invalid bot settings request.');
      const { botId } = parsed.data;
      if (session.isBot && (type !== MessageType.BOT_SETTINGS_GET || botId !== session.botId)) {
        throw new BotSettingsError(ProtocolErrorCode.PERMISSION_DENIED, 'Bots may only read their own settings.');
      }
      const bot = await this.host.botService.getInfo(botId);
      if (!bot) throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
      const manifestUrls = await this.manifestUrlsFor(session);
      const handled = await this.withSettingsPermission(session, (canConfigure, canManage) => {
        if (type === MessageType.BOT_SETTINGS_UPDATE) {
          if (!canConfigure) throw new BotSettingsError(ProtocolErrorCode.PERMISSION_DENIED, 'You cannot configure bots.');
          const update = botSettingsUpdateSchema.parse(parsed.data);
          const changed = settingsService.update(update);
          if (changed.revision !== update.expectedRevision) {
            this.host.botLocalExecution.settingsChanged(botId);
            this.host.botInteractions.settingsChanged(botId);
            // Setting values can hold secrets such as API keys, so only their names are kept.
            this.host.auditLog.record(session, 'bot.settings', {
              target: auditRef.bot(bot.id, bot.name), changes: [{ field: 'settings', after: Object.keys(update.patch) }],
            });
          }
          // Cache updates precede new-revision executions on the owning socket.
          const owner = this.host.findSession(`bot:${botId}`);
          if (owner?.botSettingsReady && this.host.isCurrentSession(owner)) {
            this.host.send(owner.ws, { type: MessageType.BOT_SETTINGS_SNAPSHOT,
              payload: settingsService.snapshot(bot, false, true) });
          }
        }
        this.host.send(session.ws, { type: MessageType.BOT_SETTINGS_SNAPSHOT, requestId,
          payload: visibleBotSettings(session, settingsService.snapshot(bot, canConfigure, session.isBot === true, canManage, manifestUrls)) });
      });
      if (handled && type === MessageType.BOT_SETTINGS_UPDATE) await this.broadcastSettings(botId);
    } catch (error) {
      this.sendSettingsError(session, error, requestId);
    }
  }

  /** Only clients that negotiated `bot-manifest-url` get the URLs; BotSettingsService still requires MANAGE_BOTS. */
  private async manifestUrlsFor(session: ClientSession): Promise<Map<string, string | null> | undefined> {
    if (session.isBot || !this.host.botService || !session.protocol?.features.includes('bot-manifest-url')) return undefined;
    return this.host.botService.manifestUrls();
  }

  /** The bot settings this person may see, as they sign in or ask for them. */
  async sendSettingsList(session: ClientSession, requestId?: string): Promise<void> {
    if (!this.host.botSettings || !this.host.botService || !session.user || session.isBot || !this.host.isCurrentSession(session)) return;
    const settingsService = this.host.botSettings;
    const bots = await this.host.botService.list();
    const manifestUrls = await this.manifestUrlsFor(session);
    await this.withSettingsPermission(session, (canConfigure, canManage) => {
      this.host.send(session.ws, { type: MessageType.BOT_SETTINGS_LIST_RESPONSE, requestId,
        payload: visibleBotSettingsList(session, settingsService.list(bots, canConfigure, canManage, manifestUrls)) });
    });
  }

  /**
   * Tells every connection the bot settings it may see after a change. Each
   * broadcast waits for the previous one: it reads the bots once for everyone,
   * so running two at a time could deliver its older data after newer (BOTS-5).
   */
  broadcastSettings(changedBotId?: string): Promise<void> {
    const broadcast = this.settingsBroadcasts.then(() => this.publishSettings(changedBotId));
    this.settingsBroadcasts = broadcast.catch(() => undefined);
    return broadcast;
  }

  /**
   * The bots and their manifest URLs are read once per broadcast, and each
   * kind of reader (what it may configure and manage, and which features its
   * app speaks) gets its message built and serialized once, instead of once
   * per connection.
   */
  private async publishSettings(changedBotId?: string): Promise<void> {
    if (!this.host.botSettings || !this.host.botService || this.host.closing) return;
    const settingsService = this.host.botSettings;
    const botService = this.host.botService;
    const bots = await botService.list();
    const changed = changedBotId === undefined ? undefined : bots.find((bot) => bot.id === changedBotId);
    let manifestUrls: Promise<Map<string, string | null>> | undefined;
    const lists = new Map<string, ServerMessage<MessageType.BOT_SETTINGS_LIST_RESPONSE>>();
    const snapshots = new Map<string, ServerMessage<MessageType.BOT_SETTINGS_SNAPSHOT>>();
    const frames: FanOutFrames = new Map();
    for (const session of this.host.sessions()) {
      if (!session.user || !this.host.isCurrentSession(session)) continue;
      // People get the list, and the changed bot's settings if they may configure or manage bots; a bot only its own.
      const wantsSnapshot = !!changed && (!session.isBot || (session.botId === changed.id && session.botSettingsReady === true));
      if (session.isBot && !wantsSnapshot) continue;
      // Only clients that negotiated `bot-manifest-url` get the URLs; BotSettingsService still requires MANAGE_BOTS.
      const urls = !session.isBot && session.protocol?.features.includes('bot-manifest-url')
        ? await (manifestUrls ??= botService.manifestUrls()) : undefined;
      await this.withSettingsPermission(session, (canConfigure, canManage) => {
        const kind = `${canConfigure}:${canManage}:${urls !== undefined}:${supportsBotStorage(session)}:${session.isBot === true}`;
        if (!session.isBot) {
          let list = lists.get(kind);
          if (!list) {
            list = { type: MessageType.BOT_SETTINGS_LIST_RESPONSE,
              payload: visibleBotSettingsList(session, settingsService.list(bots, canConfigure, canManage, urls)) };
            lists.set(kind, list);
          }
          this.host.send(session.ws, list, frames);
        }
        if (!changed || !wantsSnapshot || (!canConfigure && !canManage && !session.isBot)) return;
        let snapshot = snapshots.get(kind);
        if (!snapshot) {
          snapshot = { type: MessageType.BOT_SETTINGS_SNAPSHOT, payload: visibleBotSettings(session,
            settingsService.snapshot(changed, canConfigure, session.isBot === true, canManage, urls)) };
          snapshots.set(kind, snapshot);
        }
        this.host.send(session.ws, snapshot, frames);
      });
    }
  }

  /** Read-only check for the bot storage views: refusing it answers no error. */
  async canManageBots(session: ClientSession): Promise<boolean> {
    if (!session.user || session.isBot || !this.host.isCurrentSession(session)) return false;
    return this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_BOTS);
  }

  /**
   * Tells the people who manage bots, also on the bot's miniapps, that its server storage is about to stop
   * accepting saves. Everyone else only sees the storage of their own computer.
   */
  broadcastStorageLevel(botId: string, usage: BotStorageUsage): void {
    this.storageLevels = this.storageLevels.then(async () => {
      for (const session of [...this.host.sessions()]) {
        if (!session.user || session.isBot || !supportsBotStorage(session) || !this.host.isCurrentSession(session)) continue;
        if (!await this.canManageBots(session) || !this.host.isCurrentSession(session)) continue;
        this.host.send(session.ws, { type: MessageType.BOT_STORAGE_LEVEL, payload: { botId, usage } });
      }
    }).catch((error: unknown) => { Logger.error('BOT', 'Could not announce a bot storage level.', error); });
  }

  private sendSettingsError(session: ClientSession, error: unknown, requestId?: string): void {
    if (!this.host.isCurrentSession(session)) return;
    this.host.sendCaughtError(session.ws, error, { message: 'Bot settings operation failed.', category: 'BOT' }, requestId);
  }

  private async withSettingsPermission(session: ClientSession, use: (canConfigure: boolean, canManage: boolean) => void): Promise<boolean> {
    if (!session.user || !this.host.isCurrentSession(session)) return false;
    if (session.isBot) {
      use(false, false);
      return true;
    }
    while (this.host.isCurrentSession(session)) {
      const version = this.host.epoch.generation;
      const [allowed, canManage] = await Promise.all([
        this.host.permissions.checkPermission(session.user.id, Permission.CONFIGURE_BOTS),
        this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_BOTS),
      ]);
      if (!this.host.isCurrentSession(session)) return false;
      if (version !== this.host.epoch.generation) continue;
      // Checking and using the grant share one continuation, without another await.
      use(allowed, canManage);
      return true;
    }
    return false;
  }

  /** The slash commands this connection may use. */
  sendCommands(session: ClientSession, requestId?: string): void {
    if (!session.user) return;
    const listPayload: CommandsListResponsePayload = { commands: this.availableCommands() };
    this.host.send(session.ws, { type: MessageType.COMMANDS_LIST_RESPONSE, requestId, payload: listPayload });
  }

  /** The slash commands, to everyone, after a bot's changed. */
  broadcastCommands(): void {
    const payload: CommandsListResponsePayload = { commands: this.availableCommands() };
    this.host.broadcast({ type: MessageType.COMMANDS_LIST_RESPONSE, payload });
  }

  /** The commands of the bots approved for them, and for what each command needs beyond that. */
  private availableCommands() {
    return this.host.commandRegistry.listAll().filter((command) => this.host.botService?.permissions?.allows(command.botId, 'commands',
      ...(command.localCapabilities?.length ? ['local_execution'] as const : []),
      ...(command.downloadsSound ? ['sound_download'] as const : [])));
  }
}
