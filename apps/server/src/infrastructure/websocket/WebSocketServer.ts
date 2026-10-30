import http from 'http';
import { TLSSocket } from 'node:tls';
import { WebSocket, WebSocketServer as WSServer } from 'ws';
import {
  hasChannelPermission,
  type ChannelAccessRules,
  type ChannelCategory,
  type ChannelSummary,
  AuthConnectPayload,
  AuthChallengePayload,
  AuthFailedPayload,
  AuthSuccessPayload,
  ChannelCreatePayload,
  CategoryCreatePayload,
  CategoryUpdatePayload,
  CategoryDeletePayload,
  CategoryReorderPayload,
  ChannelCreatedPayload,
  ChannelDeletePayload,
  ChannelDeletedPayload,
  ChannelReorderPayload,
  ChannelsReorderedPayload,
  ChannelUpdatePayload,
  ChannelUpdatedPayload,
  ChatDeletePayload,
  ChatRestorePayload,
  ChatEditPayload,
  ChatHistoryPayload,
  ChatLoadHistoryPayload,
  chatHistoryRequestSchema,
  ChatMentionsReadPayload,
  ChatMessage,
  ChatMessageUpdatedPayload,
  ChatRequestUploadTokenPayload,
  ChatSendPayload,
  BotCommandMessagePayload,
  chatReactionSchema,
  ChatUploadTokenPayload,
  LIMITS,
  MessageType,
  PROTOCOL_VERSION,
  negotiateProtocol,
  MemberKickPayload,
  MemberKickedPayload,
  Permission,
  ProtocolErrorCode,
  ProtocolMessage,
  type ServerMessage,
  RoleAssignPayload,
  RoleCreatePayload,
  RoleDeletePayload,
  RoleUpdatePayload,
  RolesListPayload,
  RoleModel,
  roleModelFor,
  rolesForModel,
  DEFAULT_PERMISSIONS,
  ServerErrorPayload,
  ServerInviteInfoPayload,
  ServerNetworkInterface,
  ServerSettingsUpdatedPayload,
  ServerShutdownPayload,
  ServerShutdownReason,
  ServerUpdateSettingsPayload,
  SoundboardPlayPayload,
  DmRelaySendPayload,
  RecentSoundRecordPayload,
  SoundboardStopPayload,
  SoundboardStoppedPayload,
  SoundboardPlayedPayload,
  recentSoundMimeTypeSchema,
  type RecentSoundEntry,
  type RecentSoundMimeType,
  UserChangeNicknamePayload,
  UserJoinedPayload,
  UserLeftPayload,
  UserConnectionStatePayload,
  UserSummary,
  UserUpdateAvatarPayload,
  UserUpdatedPayload,
  UserUpdateVisibilityPayload,
  UserUpdateActivityPayload,
  BotCreatedPayload,
  BotInstallPayload,
  BotInstalledPayload,
  BotListResponsePayload,
  BotRevokePayload,
  BotRevokedPayload,
  BotProfileUpdatedPayload,
  CommandRegisteredPayload,
  CommandsListResponsePayload,
  VoiceModeTransition,
  VoiceStateChangedPayload,
  WebRtcSignalPayload,
  canAccessChannel,
  authConnectSchema,
  botCreateSchema,
  botIdentitySchema,
  botProfileUpdateSchema,
  botSettingsGetSchema,
  botSettingsListSchema,
  botSettingsUpdateSchema,
  commandRegisterSchema,
  hasPermission,
  localBotIdentitySchema,
  localOperationNegotiated,
  botInstallPreviewRequestSchema,
  botInstallSchema,
  botPermissionsGetSchema,
  botPermissionsUpdateSchema,
  isBotStorageCapability,
  withoutBotStorageCapabilities,
  withoutBotStoragePermissions,
  type BotPermissions,
  type BotSettingsListResponse,
  type BotSettingsSnapshot,
  type BotStorageUsage,
  type BotCapability,
  nativePollCreateSchema,
  nativePollEditSchema,
  nativePollIdSchema,
  nativePollVoteSchema,
  type NativePollCreate,
  type NativePollVote,
  EVERYONE_ROLE_ID,
  channelNameSchema,
  isAfkTimeoutSeconds,
} from '@monky/shared';
import { AuthService } from '../../application/services/AuthService';
import { AttachmentService } from '../../application/services/AttachmentService';
import { ChannelService, type ChannelAccessContext } from '../../application/services/ChannelService';
import { ChatService } from '../../application/services/ChatService';
import { PermissionService } from '../../application/services/PermissionService';
import { RoleService } from '../../application/services/RoleService';
import { BotService } from '../../application/services/BotService';
import { BotDiagnosticService } from '../../application/services/BotDiagnosticService';
import { BotPermissionError } from '../../application/services/BotPermissionService';
import { BOT_CHAT_EVENTS, botMessageCapabilities } from './botCapabilityPolicy';
import { BotSettingsError, BotSettingsService } from '../../application/services/BotSettingsService';
import { BotSelectorError, BotSelectorService } from '../../application/services/BotSelectorService';
import { BotSelectorHandler } from './BotSelectorHandler';
import { BotScreenHandler } from './BotScreenHandler';
import { BotScreenService } from '../../application/services/BotScreenService';
import { BotStorageHandler } from './BotStorageHandler';
import type { BotStorageService } from '../../application/services/BotStorageService';
import type { ServerMonitorService } from '../../application/services/ServerMonitorService';
import { ServerMonitorHandler } from './ServerMonitorHandler';
import { auditDiff, auditRef, type ServerAuditInput, type ServerAuditService } from '../../application/services/ServerAuditService';
import {
  categoryChanges, channelChanges, channelCreationChanges, channelTreeMoves, permissionChanges, pollChanges,
  serverSettingsChanges, type AuditNames,
} from '../../application/services/serverAuditChanges';
import { ServerAuditHandler } from './ServerAuditHandler';
import type {
  ServerAuditAction, ServerAuditChange, ServerAuditRef, ChannelPermissionOverwrite, CommandValues, SlashCommand,
} from '@monky/shared';
import { CommandRegistry } from '../../application/services/CommandRegistry';
import { BotLocalExecutionService } from '../../application/services/BotLocalExecutionService';
import { SignalingService } from '../../application/services/SignalingService';
import { UserService } from '../../application/services/UserService';
import { DmRelayService } from '../../application/services/DmRelayService';
import { GameShareRequestService } from '../../application/services/GameShareRequestService';
import { NativePollError, NativePollService } from '../../application/services/NativePollService';
import { projectLegacyPolls } from './pollProjection';
import { projectLegacyForwards } from './forwardProjection';
import { IServerRepository } from '../../domain/repositories';
import type { NativePollRecord } from '../../domain/entities';
import { scanServerNetworkInterfaces } from '../discovery/ServerIpScanner';
import { CoturnManager } from '../turn/CoturnManager';
import { describeSfuPortProblem, SfuManager } from '../sfu/SfuManager';
import { checkSfuPreflight, formatSfuPreflightForLog } from '../sfu/SfuPreflight';
import { Logger } from '../logger/Logger';
import { RateLimiter } from '../security/RateLimiter';
import { describeFailure, ServerResourceScope } from '../lifecycle/ServerResourceScope';
import { BotInteractionHandler, BotInteractionSession } from './BotInteractionHandler';
import { clientAddress, DISCARDABLE_MESSAGES, MESSAGE_BUDGETS, WS_FLOW_LIMITS, type WsFlowLimits } from './flowControl';
import { userUpdateActivitySchema, userUpdateBrbSchema, userUpdateCustomStatusSchema, type CustomStatus } from '@monky/shared';
import { isSignedIn, type ClientSession, type SignedInSession } from './ClientSession';
import { toProtocolError, type UnexpectedFailure } from './protocolErrors';
import { RtcSignalRelay, type RtcSignalHost } from './voice/RtcSignalRelay';
import { ScreenAccessCoordinator, type ScreenAccessHost } from './voice/ScreenAccessCoordinator';
import { SfuSignalingHandler, type SfuSignalingHost } from './voice/SfuSignalingHandler';
import { VoiceSessionHandler, voiceRosterUser, type VoiceSessionHost } from './voice/VoiceSessionHandler';

/** Whether two devices of one person show the same custom status (custom-status). */
function sameCustomStatus(a: CustomStatus | undefined, b: CustomStatus | undefined): boolean {
  if (!a || !b) return a === b;
  return a.text === b.text && a.emoji === b.emoji && a.tag === b.tag && a.color === b.color
    && a.showEmoji === b.showEmoji && a.showTag === b.showTag;
}

const BOT_LOCAL_ALLOWED_MESSAGES = new Set<MessageType>([
  MessageType.BOT_LOCAL_SOURCE_REQUEST,
  MessageType.BOT_LOCAL_TASK_REQUEST,
  MessageType.BOT_LOCAL_TASK_CONTROL,
  MessageType.BOT_LOCAL_TASK_EVENT,
  MessageType.BOT_LOCAL_MEDIA_SIGNAL,
]);
/** A reorder from an outdated client can shuffle a whole list; past this, the rest is not itemized. */
const MAX_AUDITED_MOVES = 10;
/** Channels whose rows changed, resent to whoever keeps seeing them: every one of them, or the ones listed. */
type ChannelRefresh = boolean | ReadonlySet<string>;
/** How long a stale login waits for an access change in progress to end before catching up anyway (see resyncLoginAccess). */
const LOGIN_RESYNC_WAIT_MS = 1_000;
const LOGIN_RESYNC_POLL_MS = 20;

/**
 * Serialized frames of one fan-out, keyed by the message a recipient ends up
 * with after its projections: recipients sharing a message share its bytes.
 */
type FanOutFrames = Map<ServerMessage, Buffer>;

/** What the voice modules use of the server, each through its own part of it. */
type VoiceModulesHost = ScreenAccessHost & RtcSignalHost & SfuSignalingHost & VoiceSessionHost;

import { CommunityHandler } from './CommunityHandler';
import { MessageSearchHandler } from './MessageSearchHandler';
import type { CommunityService } from '../../application/services/CommunityService';
import type { MessageSearchService } from '../../application/services/MessageSearchService';
import { ForumHandler } from './ForumHandler';
import type { ForumService } from '../../application/services/ForumService';
import type { RecentSoundCacheService } from '../../application/services/RecentSoundCacheService';

export class WebSocketServer {
  private wss: WSServer;
  private sessions: Map<WebSocket, ClientSession> = new Map();
  /** Live sockets keyed by sessionId: one person may hold several at once (#309). */
  private sessionSockets: Map<string, WebSocket> = new Map();
  /** Pending "user left" timers for sessions that dropped and may still reconnect. */
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Connections that have not authenticated yet, oldest first: each holds a descriptor and costs nothing to open. */
  private readonly anonymousSessions = new Set<ClientSession>();
  /** How many of them each client address holds. */
  private readonly anonymousPerAddress = new Map<string, number>();
  /** Process-wide, like the constants it holds: a test lowers it for one case. */
  private static flowLimits: WsFlowLimits = WS_FLOW_LIMITS;
  private heartbeatTimer?: NodeJS.Timeout;
  /** Monotonic time of the previous liveness round, to notice when the server itself stalled. */
  private lastLivenessCheckAt?: number;
  private closing = false;
  private readonly shutdownResources = new ServerResourceScope();
  private sfuStartup: Promise<void> = Promise.resolve();
  private settingsUpdateQueue: Promise<void> = Promise.resolve();
  private voicePresenceSync: Promise<void> = Promise.resolve();
  /** Last "ask to join" per requester/host pair, for the spam guard (#675). */
  private botInteractions: BotInteractionHandler;
  private readonly botDiagnostics?: BotDiagnosticService;
  private botLocalExecution: BotLocalExecutionService<BotInteractionSession>;
  private botSelectors?: BotSelectorHandler;
  private botScreens?: BotScreenHandler;
  private readonly botStorage?: BotStorageHandler<ClientSession>;
  /** Level warnings go out in order, even while each recipient's permission is checked. */
  private botStorageLevels: Promise<void> = Promise.resolve();
  /** Bot settings broadcasts run one after another, so older data never lands after newer (BOTS-5). */
  private botSettingsBroadcasts: Promise<void> = Promise.resolve();
  private readonly serverMonitor?: ServerMonitorHandler;
  private readonly serverAudit?: ServerAuditHandler;
  private readonly community?: CommunityHandler;
  private readonly messageSearch?: MessageSearchHandler;
  private readonly forum?: ForumHandler;
  private botSettingsPermissionVersion = 0;
  private botScreenAccessVersion = 0;
  private localAccessVersion = 0;
  private pendingLocalAccessMutations = 0;
  private shutdownReason: ServerShutdownReason = 'stopped';
  private dmRelay: DmRelayService<ClientSession>;
  private gameShareRequests: GameShareRequestService<ClientSession>;
  private screenAccess?: ScreenAccessCoordinator;
  private rtcSignalRelay?: RtcSignalRelay;
  private sfuSignalingHandler?: SfuSignalingHandler;
  private voiceSessionHandler?: VoiceSessionHandler;
  private voiceModulesHost?: VoiceModulesHost;

  constructor(
    private server: http.Server,
    private authService: AuthService,
    private userService: UserService,
    private channelService: ChannelService,
    private chatService: ChatService,
    private signalingService: SignalingService,
    private serverRepo: IServerRepository,
    private attachmentService: AttachmentService,
    private permissionService: PermissionService,
    private roleService: RoleService,
    private coturnManager: CoturnManager,
    // Ahead of the SFU manager because it has no default, and TypeScript
    // requires every required parameter to come before the ones with an
    // initialiser (#372).
    private rateLimiter: RateLimiter,
    private sfuManager: SfuManager = new SfuManager(),
    private botService?: BotService,
    private commandRegistry: CommandRegistry = new CommandRegistry(),
    selectorService?: BotSelectorService,
    private botSettings?: BotSettingsService,
    monitorService?: ServerMonitorService,
    private readonly serverVersion: string | null = null,
    private readonly communityService?: CommunityService,
    messageSearchService?: MessageSearchService,
    private readonly forumService?: ForumService,
    private readonly pollService?: NativePollService,
    private readonly recentSoundCache?: RecentSoundCacheService,
    private readonly audit?: ServerAuditService,
    botStorageService?: BotStorageService,
  ) {
    if (botService) this.botDiagnostics = new BotDiagnosticService(botService, rateLimiter);
    if (botService && botStorageService) {
      this.botStorage = new BotStorageHandler<ClientSession>(botStorageService, {
        isCurrent: (session) => session.isBot
          ? this.isCurrentBotOperation(session, 'server_storage') : this.isCurrentSession(session),
        send: (session, message) => this.send(session.ws, message),
        permissions: (botId) => this.botService?.permissions?.get(botId),
        authorizeManagement: (session, requestId) => this.botManagementAuthorization(session, requestId),
        canManage: (session) => this.canManageBots(session),
        audit: async (session, botId, changes) => {
          if (!this.audit) return;
          const bot = await this.botService?.findById(botId);
          this.recordAudit(session, 'bot.storage', { target: auditRef.bot(botId, bot?.name ?? botId), changes });
        },
      });
      botStorageService.setLevelListener((botId, usage) => this.broadcastBotStorageLevel(botId, usage));
    }
    if (audit) this.serverAudit = new ServerAuditHandler(audit, this.permissionService, {
      isCurrent: (session) => this.isCurrentSession(session),
      send: (session, message) => this.send(session.ws, message),
    });
    this.dmRelay = new DmRelayService<ClientSession>({
      isCurrent: (session) => this.isCurrentSession(session),
      send: (session, message) => this.send(session.ws, message),
    });
    this.gameShareRequests = new GameShareRequestService<ClientSession>({
      send: (session, message) => this.send(session.ws, message),
      sessionsOfUser: (userId) => this.getSessionsOfUser(userId),
      voiceChannelOf: (sessionId) => this.signalingService.getVoiceState(sessionId)?.channelId ?? null,
      isScreenSharing: (userId) => this.signalingService.getSessionsOfUser(userId).some(state => state.isScreenSharing),
    });
    if (communityService) this.community = new CommunityHandler(communityService, channelService, rateLimiter, {
      sessions: () => this.sessions.values(),
      isCurrent: session => this.isCurrentSession(session),
      accessVersion: () => {
        const channels = this.getChannelAccessVersion();
        const roles = this.permissionService.getRoleAccessVersion();
        return channels === null || roles === null ? null : channels + roles;
      },
      botSession: id => this.findSessionById(`bot:${id}`),
      authorizeInvocation: (session, invocationId, channelId) => this.botInteractions.authorizeSelector(session, invocationId, channelId),
      send: (session, message) => this.send(session.ws, message),
      pollUpdated: poll => this.broadcastToChannel(poll.channelId, {
        type: MessageType.POLL_UPDATED,
        payload: poll,
      }),
      audit: async (session, action, input) => {
        if (!this.audit) return;
        this.recordAudit(session, action, {
          target: input.target,
          related: {
            channel: await this.auditChannel(input.channelId),
            invoker: input.invokerId ? await this.auditIdentity(input.invokerId) : null,
          },
          changes: input.changes,
        });
      },
    });
    if (messageSearchService) this.messageSearch = new MessageSearchHandler(messageSearchService, {
      isCurrent: session => this.isCurrentSession(session),
      send: (session, message) => this.send(session.ws, message),
    });
    if (forumService) this.forum = new ForumHandler(forumService, rateLimiter, {
      isCurrent: session => this.isCurrentSession(session),
      version: () => {
        const channels = this.getChannelAccessVersion();
        const roles = this.permissionService.getRoleAccessVersion();
        return channels === null || roles === null ? null : channels + roles;
      },
      send: (session, message) => this.send(session.ws, message),
      changed: async result => {
        if (result.deleted) {
          this.botLocalExecution.deleteChannel(result.post.channelId);
          this.botInteractions.deleteChannel(result.post.channelId);
        }
        // A topic is a channel: a new or deleted one reaches each member as the
        // difference, an edited one is the only channel resent (S-WS-4).
        await this.reconcileChannelVisibility(result.deleted ? false : new Set([result.post.channelId]));
        const activity: ServerMessage[] = [{ type: MessageType.FORUM_POST_SAVED, payload: result }];
        if (result.message) activity.push({ type: MessageType.CHAT_MESSAGE, payload: result.message });
        await this.broadcastForumActivity(result.post.forumId, activity);
      },
      audit: async (session, action, post, changes) => {
        if (!this.audit) return;
        this.recordAudit(session, action, {
          target: auditRef.of('post', post.channelId, post.title),
          related: { channel: await this.auditChannel(post.forumId), author: await this.auditIdentity(post.authorId) },
          changes,
        });
      },
    });
    this.signalingService.configureScreenAccess(
      () => this.permissionService.getScreenRoleAccessVersion(),
      request => this.screens.revokeNativeSubscription(request),
    );
    this.permissionService.setRoleMutationListener(revocation => this.screens.rolesChanged(revocation));
    // Signing in no longer touches roles, so the map behind role-gated screens
    // is loaded here: otherwise nothing would load it before a role edit.
    void this.screens.refreshScreenRoles().catch(error => Logger.error('WEBRTC', 'Screen audience refresh failed.', error));
    this.sfuManager.setHealthListener((sessionId, channelId, transportHealth) =>
      this.sfuSignaling.transportHealthChanged(sessionId, channelId, transportHealth));
    this.sfuManager.setWorkerLostListener(() => this.sfuSignaling.sfuWorkerLost());
    if (selectorService) {
      this.botSelectors = new BotSelectorHandler(selectorService, this.channelService, this.userService, {
        sessions: () => this.sessions.values(),
        isCurrent: (session) => this.isCurrentBotOperation(session, 'selectors', 'send_messages'),
        allowsBot: (botId) => this.botService?.permissions?.allows(botId, 'selectors', 'send_messages') === true,
        accessVersion: () => this.botSettingsPermissionVersion,
        send: (session, message) => this.send(session.ws, message),
        authorizeInvocation: (session, invocationId, channelId) => this.botInteractions.authorizeSelector(session, invocationId, channelId),
        // Refusals reach the bot as worded, with the code selectors have always answered them with (BOTS-8).
        publish: async (bot, channelId, content, messageId, canSend, accessUserId, localizations) => {
          const record = await this.botService?.findById(bot.id);
          if (!record) throw new BotSelectorError('Bot is unavailable.');
          const session = this.findSessionById(`bot:${record.id}`);
          if (!session || !this.isCurrentSession(session) || !canSend()) throw new BotSelectorError('Bot is disconnected.');
          const result = await this.chatService.sendBotMessage(
            record, channelId, content, undefined, messageId, () => canSend() && this.isCurrentSession(session), accessUserId, undefined, localizations
          );
          if (!result.success) throw new BotSelectorError(result.errorMessage);
          return result.message;
        },
        broadcastMessage: (message) => this.broadcastToChannel(
          message.channelId, { type: MessageType.CHAT_MESSAGE, payload: message }
        ),
      }, this.botSettings);
    }
    this.botInteractions = new BotInteractionHandler({
      getVoiceChannelId: (sessionId) => this.signalingService.getVoiceState(sessionId)?.channelId ?? null,
      isCurrent: (session) => this.isCurrentBotOperation(session, 'commands'),
      findBot: (botId) => this.botService?.permissions?.allows(botId, 'commands')
        ? this.findSessionById(`bot:${botId}`) : undefined,
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, code, message, requestId) => this.sendError(ws, code, message, requestId),
      broadcastToChannel: (channelId, message, canSend) => this.broadcastToChannel(channelId, message, undefined, canSend),
      publishResponse: (session, response, canSend, requestId) => this.publishBotResponse(session, response, canSend, requestId),
      resolveImageAssets: (userId, channelId, refs) => {
        if (!this.communityService) throw new Error('Community media is unavailable.');
        return this.communityService.resolveImageAssets(refs, userId, channelId);
      },
      localContextEnded: (context, cause) => this.botLocalExecution.contextEnded(context, cause),
      consumeLocalPreview: (bot, origin, contextId, requestId, result) =>
        this.botLocalExecution.consumePreview(bot, origin, contextId, requestId, result),
      commandInvoked: (session, command, channelId, options) => this.auditCommand(session, command, channelId, options),
    }, this.channelService, this.userService, this.commandRegistry, this.botSettings,
      async () => (await this.serverRepo.getServer())?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH);
    this.botLocalExecution = new BotLocalExecutionService({
      isCurrent: (session) => this.isCurrentBotOperation(session, 'local_execution'),
      negotiated: (session, operation) => localOperationNegotiated(operation, session.protocol?.features),
      accessVersion: () => {
        const roles = this.channelService.getRoleAccessVersion();
        return roles === null || this.pendingLocalAccessMutations > 0
          ? null : `${this.localAccessVersion}:${this.botSettingsPermissionVersion}:${roles}`;
      },
      authorizeContext: (session, context, capability) => this.botInteractions.authorizeLocalContext(session, context, capability),
      authorizeCaller: (userId, channelId) => this.botInteractions.authorizeLocalCaller(userId, channelId),
      authorizeVoice: (origin, bot, channelId) => this.authorizeLocalVoice(origin, bot, channelId),
      botIdentity: async (session) => {
        if (!session.botId) return undefined;
        const [server, bot] = await Promise.all([this.serverRepo.getServer(), this.botService?.findById(session.botId)]);
        const key = localBotIdentitySchema.shape.botPublicKey.safeParse(bot?.boundPublicKey);
        if (!server || !bot || !key.success || !this.isCurrentSession(session)) return undefined;
        return { serverId: server.id, serverName: server.name, botId: bot.id, botName: bot.name, botPublicKey: key.data };
      },
      botBinding: async (botId) => {
        const bot = await this.botService?.findById(botId);
        const key = localBotIdentitySchema.shape.botPublicKey.safeParse(bot?.boundPublicKey);
        return key.success ? key.data : undefined;
      },
      commandHasCapability: (botId, name, capability) =>
        this.botService?.permissions?.allows(botId, 'commands', 'local_execution') === true &&
        this.commandRegistry.find(botId, name)?.localCapabilities?.includes(capability) === true,
      voiceChannelId: (session) => session.sessionId
        ? this.signalingService.getVoiceState(session.sessionId)?.channelId ?? null : null,
      iceServers: (session) => this.buildLocalIceServersFor(session),
      send: (session, message) => {
        if (session.ws.readyState !== WebSocket.OPEN) return false;
        try {
          session.ws.send(JSON.stringify(message), (error) => {
            if (error) {
              this.botLocalExecution.disconnect(session);
              Logger.error('BOT', 'Failed to deliver a local execution message.', error);
            }
          });
          return true;
        } catch (error) {
          Logger.error('BOT', 'Failed to send a local execution message.', error);
          return false;
        }
      },
      error: (session, code, reason, requestId) => this.sendError(session.ws, code, reason, requestId),
      reportError: (error) => Logger.error('BOT', 'Local execution authorization or transport failed.', error),
    });
    if (this.botService) {
      this.botScreens = new BotScreenHandler(new BotScreenService(), this.channelService, this.userService, {
        sessions: () => this.sessions.values(),
        isCurrent: (session) => this.isCurrentBotOperation(session, 'miniapps'),
        accessVersion: () => this.botScreenAccessVersion,
        getVoiceChannelId: (sessionId) => this.signalingService.getVoiceState(sessionId)?.channelId ?? null,
        send: (session, message) => this.send(session.ws, message),
        authorizeInvocation: (session, invocationId, channelId) =>
          this.botInteractions.authorizeVoiceScreen(session, invocationId, channelId),
        endInvocation: (session, invocationId) => this.botInteractions.endScreenInvocation(session, invocationId),
      });
    }
    if (monitorService) {
      this.serverMonitor = new ServerMonitorHandler(monitorService, this.permissionService, {
        isCurrent: (session) => this.isCurrentSession(session),
        accessVersion: () => this.botSettingsPermissionVersion,
        send: (session, message) => this.send(session.ws, message),
      });
    }
    this.signalingService.setVoiceMembershipListener(() => this.voiceMembershipChanged());
    this.channelService.setVoicePresence((userId, channelId) => this.voiceSessions.voicePresenceChannelIds(userId).has(channelId));
    this.wss = new WSServer({ server: this.server, maxPayload: LIMITS.WS_MAX_PAYLOAD_BYTES });
    this.setupWss();
    this.startHeartbeat();
    this.sfuStartup = this.sfuSignaling.initSfuIfConfigured();
  }

  /** Screens: who may receive which one, and what each connection is told of them. */
  private get screens(): ScreenAccessCoordinator {
    return this.screenAccess ??= new ScreenAccessCoordinator(this.voiceHost);
  }

  /** P2P signals between the participants of a room. */
  private get rtcSignals(): RtcSignalRelay {
    return this.rtcSignalRelay ??= new RtcSignalRelay(this.voiceHost);
  }

  /** Media through the SFU, for calls on a server in SFU mode. */
  private get sfuSignaling(): SfuSignalingHandler {
    return this.sfuSignalingHandler ??= new SfuSignalingHandler(this.voiceHost);
  }

  /** Who is in which voice room, and every way in and out of one. */
  private get voiceSessions(): VoiceSessionHandler {
    return this.voiceSessionHandler ??= new VoiceSessionHandler(this.voiceHost);
  }

  /**
   * What the voice modules use of this server. Each member is read when used,
   * and the modules are built on first use, so they always act on the
   * server's current collaborators.
   */
  private get voiceHost(): VoiceModulesHost {
    if (this.voiceModulesHost) return this.voiceModulesHost;
    // The getters below have a `this` of their own.
    const server = this;
    this.voiceModulesHost = {
      get signaling() { return server.signalingService; },
      get sfu() { return server.sfuManager; },
      get sfuSignaling() { return server.sfuSignaling; },
      get serverRepo() { return server.serverRepo; },
      get channels() { return server.channelService; },
      get permissions() { return server.permissionService; },
      get roles() { return server.roleService; },
      get users() { return server.userService; },
      get botService() { return server.botService; },
      get botInteractions() { return server.botInteractions; },
      get gameShareRequests() { return server.gameShareRequests; },
      get audit() { return server.audit; },
      get botSettingsPermissionVersion() { return server.botSettingsPermissionVersion; },
      get closing() { return server.closing; },
      sessions: () => server.sessions.values(),
      sessionsOfUser: (userId) => server.getSessionsOfUser(userId),
      findSession: (sessionId) => server.findSessionById(sessionId),
      isCurrentSession: (session) => server.isCurrentSession(session),
      isCurrentBotOperation: (session, ...capabilities) => server.isCurrentBotOperation(session, ...capabilities),
      requirePermission: (session, permission, requestId, channelId) =>
        server.requirePermission(session, permission, requestId, channelId),
      requireChannelAccess: (session, channelId, requestId) => server.requireChannelAccess(session, channelId, requestId),
      hasBotVoiceGrant: (session, channelId) => server.hasBotVoiceGrant(session, channelId),
      canReceiveProducer: (session, channelId, producerId) => server.screens.canReceiveProducer(session, channelId, producerId),
      reconcileScreenAccess: () => server.screens.reconcileScreenAccess(),
      voiceRoster: (channelId, viewerUserId) => server.voiceSessions.getVoiceRoster(channelId, viewerUserId),
      syncVoicePresenceVisibility: () => server.syncVoicePresenceVisibility(),
      recordAudit: (session, action, input) => server.recordAudit(session, action, input),
      auditChannel: (channelId) => server.auditChannel(channelId),
      auditIdentity: (id) => server.auditIdentity(id),
      send: (ws, message) => server.send(ws, message),
      sendError: (ws, code, message, requestId) => server.sendError(ws, code, message, requestId),
      publish: (messageFor, skip) => server.publish(messageFor, skip),
      broadcast: (message, ignoreWs) => server.broadcast(message, ignoreWs),
      broadcastToChannel: (channelId, message, ignoreWs, canSend) => server.broadcastToChannel(channelId, message, ignoreWs, canSend),
    };
    return this.voiceModulesHost;
  }

  /** Live connections keyed by sessionId — one person may hold several (#309). */
  public getOnlineUsersMap(): Map<string, { user: UserSummary }> {
    const map = new Map<string, { user: UserSummary }>();
    for (const session of this.sessions.values()) {
      if (session.user && session.sessionId) {
        map.set(session.sessionId, { user: session.user });
      }
    }
    return map;
  }

  /**
   * Like `getOnlineUsersMap` but excludes sessions marked invisible (#561).
   * Used when building the member list for AUTH_SUCCESS sent to other clients.
   */
  public getVisibleOnlineUsersMap(): Map<string, { user: UserSummary }> {
    const map = new Map<string, { user: UserSummary }>();
    for (const session of this.sessions.values()) {
      if (session.user && session.sessionId && !session.invisible) {
        map.set(session.sessionId, { user: session.user });
      }
    }
    return map;
  }

  /**
   * Disconnects every device of a person. Callers address people by user id and
   * must not leave the other devices online (#309). Returns how many live
   * sessions were closed.
   */
  public closeSessionsOfUser(userId: string): number {
    for (const [pendingSessionId, pendingTimer] of this.reconnectTimers.entries()) {
      if (pendingSessionId.startsWith(`${userId}:`)) {
        clearTimeout(pendingTimer);
        this.reconnectTimers.delete(pendingSessionId);
      }
    }

    const targets = this.getSessionsOfUser(userId);
    for (const target of targets) {
      // Out at once: nothing of theirs lingers, nor shows them online, while
      // their sockets finish closing.
      target.replaced = true;
      this.releaseConnection(target);
      try {
        target.ws.close();
      } catch {
        // ignore
      }
    }
    return targets.length;
  }

  /**
   * Extracts the hostname from a `Host` header, dropping the port (#425).
   *
   * The port has to go because the TURN listener is on 3478, not on whatever
   * port the client used to reach the API. IPv6 literals arrive bracketed
   * (`[::1]:3000`) and the brackets are kept, since ICE URLs need them too.
   */
  private static parseRequestHostname(header: string | undefined): string | undefined {
    const raw = (header || '').trim();
    if (!raw) return undefined;

    if (raw.startsWith('[')) {
      const end = raw.indexOf(']');
      return end > 0 ? raw.slice(0, end + 1) : undefined;
    }

    const host = raw.split(':')[0].trim();
    return host.length > 0 ? host : undefined;
  }

  private static parseRequestServerUrl(req: http.IncomingMessage): string | undefined {
    if (!req.headers.host) return undefined;
    try {
      const forwarded = req.headers['x-forwarded-proto'];
      if (forwarded !== undefined && typeof forwarded !== 'string') return undefined;
      const protocol = typeof forwarded === 'string' ? forwarded.split(',')[0].trim().toLowerCase() : undefined;
      if (protocol !== undefined && protocol !== 'http' && protocol !== 'https') return undefined;
      const secure = (req.socket instanceof TLSSocket && req.socket.encrypted) || protocol === 'https';
      const url = new URL(`${secure ? 'wss' : 'ws'}://${req.headers.host}`);
      const target = req.url || '/';
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
          !target.startsWith('/') || target.startsWith('//') || target.includes('#')) return undefined;
      const endpoint = new URL(target, url);
      return endpoint.origin === url.origin && !endpoint.hash ? endpoint.href : undefined;
    } catch {
      return undefined;
    }
  }

  private setupWss(): void {
    // ws forwards HTTP listener errors here before the startup promise sees
    // them. Log them without throwing or tearing down unrelated live sessions.
    this.wss.on('error', (error: Error) => {
      Logger.error('NETWORK', 'WebSocket server error', error);
    });
    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const ip = req.socket.remoteAddress || 'unknown';
      const address = clientAddress(ip);
      if (address !== undefined &&
          (this.anonymousPerAddress.get(address) ?? 0) >= WebSocketServer.flowLimits.PREAUTH_MAX_SOCKETS_PER_ADDRESS) {
        // Dropped at once: a close handshake would keep the descriptor for up
        // to 30 s from a peer that never answers it, and the client retries
        // either way.
        ws.on('error', () => {});
        ws.terminate();
        return;
      }
      // A full server drops its oldest waiting connection, not the newest:
      // sockets held open only to fill it cannot keep out someone who
      // authenticates in a moment.
      const [oldest] = this.anonymousSessions;
      if (oldest && this.anonymousSessions.size >= WebSocketServer.flowLimits.PREAUTH_MAX_SOCKETS) {
        this.settleAnonymous(oldest);
        oldest.ws.terminate();
      }
      Logger.info('NETWORK', `New connection established from ${ip}`);

      const session: ClientSession = {
        ws,
        messageQueue: Promise.resolve(),
        lastSeenAt: performance.now(),
        ip,
        countedAnonymous: true,
        requestHost: WebSocketServer.parseRequestHostname(req.headers.host),
        requestServerUrl: WebSocketServer.parseRequestServerUrl(req),
      };
      this.anonymousSessions.add(session);
      if (address !== undefined) this.anonymousPerAddress.set(address, (this.anonymousPerAddress.get(address) ?? 0) + 1);
      session.authDeadline = setTimeout(() => {
        if (!session.user && ws.readyState === WebSocket.OPEN) ws.close(1008, 'Authentication timeout');
      }, WebSocketServer.flowLimits.AUTH_TIMEOUT_MS);
      session.authDeadline.unref?.();
      this.sessions.set(ws, session);

      // Anything the peer sends proves the connection alive, not only pongs.
      ws.on('pong', () => {
        session.lastSeenAt = performance.now();
      });

      ws.on('message', (data: Buffer) => {
        session.lastSeenAt = performance.now();
        this.receiveMessage(session, data);
      });

      ws.on('close', () => {
        this.handleDisconnect(session);
      });

      ws.on('error', (err) => {
        Logger.error('NETWORK', `Socket error for ${ip}`, err);
        this.handleDisconnect(session);
      });
    });
  }

  private receiveMessage(session: ClientSession, data: Buffer): void {
    // Before authentication only small frames are legitimate: a large one is
    // refused before it costs a parse.
    if (!session.user && data.length > WebSocketServer.flowLimits.PREAUTH_MAX_FRAME_BYTES) {
      session.ws.close(1009, 'Message too big');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch (error) {
      Logger.error('NETWORK', 'Failed to parse message', error);
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem malformada');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed) || !('payload' in parsed)) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem malformada');
      return;
    }
    const type = Object.values(MessageType).find((value) => value === parsed.type);
    const requestId = 'requestId' in parsed ? parsed.requestId : undefined;
    // The id is copied into events every other connection receives, so an
    // unbounded one multiplied a single frame by the audience. Not echoed back.
    if (typeof requestId === 'string' && requestId.length > LIMITS.MAX_REQUEST_ID_LENGTH) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem malformada');
      return;
    }
    if (!type || (requestId !== undefined && typeof requestId !== 'string')) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem malformada',
        typeof requestId === 'string' ? requestId : undefined);
      return;
    }
    const message: ProtocolMessage<unknown> = { type, requestId, payload: parsed.payload };
    const dispatch = async () => {
      try {
        await this.handleMessage(session, message);
      } catch (error) {
        Logger.error('NETWORK', 'Failed to process message', error);
        this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
          'Não foi possível concluir a operação. Verifique o log do servidor.', requestId);
      }
    };
    // TURN installation can hold the mutation queue for minutes. Heartbeats
    // cannot wait behind it: the desktop otherwise reconnects after 12 seconds.
    if (type === MessageType.PING) {
      void dispatch();
      return;
    }
    // Preserve wire order for mutations, including bot reply/finish sequences.
    session.messageQueue = session.messageQueue.then(dispatch);
  }

  private async handleMessage(session: ClientSession, message: ProtocolMessage<unknown>): Promise<void> {
    const { type, requestId, payload } = message;

    // A revoked session — one kicked from the server or replaced by a newer
    // connection of the same user — must not mutate or observe any state.
    if (session.replaced || this.closing || this.sessions.get(session.ws) !== session) {
      return;
    }

    if (session.user && (type === MessageType.AUTH_CONNECT || type === MessageType.AUTH_CHALLENGE_RESPONSE)) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Esta conexão já está autenticada.', requestId);
      return;
    }

    // Heartbeat ping
    if (type === MessageType.PING) {
      this.send(session.ws, { type: MessageType.PONG, requestId, payload: { timestamp: Date.now() } });
      return;
    }

    // Connect / Auth
    if (type === MessageType.AUTH_CONNECT) {
      // Verificar a senha custa uma derivação scrypt, então deixar isso sem
      // medida entregava de uma vez um laço infinito de adivinhação de senha e
      // um jeito de manter o servidor ocupado (#372). Só a tentativa que falha
      // gasta cota: quem entra normalmente não é penalizado, e várias pessoas
      // atrás do mesmo IP público continuam reconectando depois de uma queda.
      const release = this.rateLimiter.reserve(
        `auth:${session.ip}`,
        LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS,
        LIMITS.RATE_LIMIT_AUTH_WINDOW_MS
      );
      if (!release) {
        Logger.security(`Authentication rate limit reached for ${session.ip}`);
        // Código próprio: o cliente traduz por código, e RATE_LIMITED já
        // significa "flood de mensagens" para ele (#372).
        this.sendError(session.ws, ProtocolErrorCode.AUTH_RATE_LIMITED, 'Muitas tentativas de conexão. Aguarde um minuto.', requestId);
        return;
      }
      try {
        await this.handleAuthConnect(session, payload as AuthConnectPayload, requestId);
      } finally {
        release();
      }
      return;
    }

    if (type === MessageType.AUTH_CHALLENGE_RESPONSE) {
      await this.handleAuthChallengeResponse(session, payload, requestId);
      return;
    }

    // Pre-authentication: a separate connection used by `<bot> doctor`, so it
    // never creates, replaces or binds a bot session.
    if (type === MessageType.BOT_DIAGNOSTIC) {
      await this.handleBotDiagnostic(session, payload, requestId);
      return;
    }

    // Require authentication for all subsequent messages
    if (!session.user) {
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Não autenticado no servidor', requestId);
      return;
    }

    if (type === MessageType.DM_RELAY_SEND) {
      await this.handleDmRelaySend(session, payload as DmRelaySendPayload, requestId);
      return;
    }

    if (session.isBot) {
      const capabilities = botMessageCapabilities(type, payload);
      if (!capabilities || !this.isCurrentBotOperation(session, ...capabilities)) {
        this.sendError(session.ws, capabilities ? ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED : ProtocolErrorCode.PERMISSION_DENIED,
          'This operation is not supported or has not been approved by a bot administrator.', requestId);
        return;
      }
    } else if (type === MessageType.COMMAND_INVOKE || type === MessageType.COMMAND_AUTOCOMPLETE ||
        type === MessageType.COMMAND_AUDIO_PREVIEW) {
      const botId = typeof payload === 'object' && payload !== null && 'botId' in payload ? payload.botId : undefined;
      if (typeof botId === 'string' && this.findSessionById(`bot:${botId}`) &&
          !this.botService?.permissions?.allows(botId, 'commands')) {
        this.sendError(session.ws, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED,
          'An administrator must approve this bot before its commands can be used.', requestId);
        return;
      }
    }

    if (!this.withinMessageBudget(session, type, requestId)) return;

    switch (type) {
      case MessageType.CHAT_REACTION_ADD:
      case MessageType.CHAT_REACTION_REMOVE: {
        if (!session.user) return;
        const reaction = chatReactionSchema.safeParse(payload);
        if (!reaction.success) {
          this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Reação inválida.', requestId);
          return;
        }
        if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId, reaction.data.channelId))) return;
        if (!(await this.requireChannelAccess(session, reaction.data.channelId, requestId))) return;
        if (!this.isCurrentSession(session)) return;
        const result = await this.chatService.setReaction(session.user, reaction.data, type === MessageType.CHAT_REACTION_ADD,
          this.captureChannelOperation(session));
        if (!result.success) {
          this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
        } else if (result.event) {
          await this.broadcastToChannel(reaction.data.channelId, {
            type: type === MessageType.CHAT_REACTION_ADD ? MessageType.CHAT_REACTION_ADDED : MessageType.CHAT_REACTION_REMOVED,
            requestId,
            payload: result.event,
          });
        }
        return;
      }
      case MessageType.CHAT_SEND:
        if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId, (payload as ChatSendPayload)?.channelId))) return;
        if (!(await this.requireChannelAccess(session, (payload as ChatSendPayload)?.channelId, requestId))) return;
        await this.handleChatSend(session, payload as ChatSendPayload, requestId);
        break;

      case MessageType.CHAT_LOAD_HISTORY:
        if (!(await this.requirePermission(session, Permission.READ_MESSAGES, requestId, (payload as ChatLoadHistoryPayload)?.channelId))) return;
        await this.handleChatLoadHistory(session, payload as ChatLoadHistoryPayload, requestId);
        break;

      case MessageType.CHAT_SEARCH:
        if (this.messageSearch) await this.messageSearch.handle(session, payload, requestId);
        else this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Message search unavailable.', requestId);
        break;

      case MessageType.POLL_CREATE:
        await this.handlePollCreate(session, payload as NativePollCreate, requestId);
        break;

      case MessageType.POLL_VOTE:
        await this.handlePollVote(session, payload as NativePollVote, requestId);
        break;

      case MessageType.POLL_CLOSE:
        await this.handlePollClose(session, payload, requestId);
        break;

      case MessageType.POLL_VOTERS:
        await this.handlePollVoters(session, payload, requestId);
        break;

      case MessageType.POLL_EDIT:
        await this.handlePollEdit(session, payload, requestId);
        break;

      case MessageType.POLL_GET:
        await this.handlePollGet(session, payload, requestId);
        break;

      case MessageType.FORUM_LIST:
      case MessageType.FORUM_CREATE_POST:
      case MessageType.FORUM_UPDATE_POST:
      case MessageType.FORUM_DELETE_POST:
        if (this.forum) await this.forum.handle(session, type, payload, requestId);
        else this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Forums unavailable.', requestId);
        break;

      case MessageType.COMMUNITY_GET:
      case MessageType.COMMUNITY_IMAGE_UPLOAD:
      case MessageType.COMMUNITY_UPDATE_SETTINGS:
      case MessageType.EVENT_SAVE:
      case MessageType.EVENT_GET:
      case MessageType.EVENT_GET_INTERESTED:
      case MessageType.EVENT_CONTROL:
      case MessageType.EVENT_INTEREST:
      case MessageType.LIVE_ACTION_CREATE:
      case MessageType.LIVE_ACTION_UPDATE:
      case MessageType.LIVE_ACTION_CLOSE:
      case MessageType.LIVE_ACTION_LIST:
      case MessageType.LIVE_ACTION_SUBMIT:
      case MessageType.NATIVE_FORM_CREATE:
      case MessageType.NATIVE_FORM_SUBMIT:
      case MessageType.NATIVE_FORM_CLOSE:
      case MessageType.NATIVE_FORM_RESULTS:
        if (this.community) await this.community.handle(session, type, payload, requestId);
        else this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Server community unavailable.', requestId);
        break;

      case MessageType.CHAT_EDIT:
        if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId, (payload as ChatEditPayload)?.channelId))) return;
        if (!(await this.requireChannelAccess(session, (payload as ChatEditPayload)?.channelId, requestId))) return;
        await this.handleChatEdit(session, payload as ChatEditPayload, requestId);
        break;

      case MessageType.CHAT_DELETE:
        if (!(await this.requireChannelAccess(session, (payload as ChatDeletePayload)?.channelId, requestId))) return;
        await this.handleChatDelete(session, payload as ChatDeletePayload, requestId);
        break;

      case MessageType.CHAT_RESTORE:
        if (!session.protocol?.features.includes('message-delete-undo')) {
          this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Atualize para desfazer exclusões.', requestId);
          return;
        }
        if (!(await this.requireChannelAccess(session, (payload as ChatRestorePayload)?.channelId, requestId))) return;
        await this.handleChatRestore(session, payload as ChatRestorePayload, requestId);
        break;

      case MessageType.CHAT_MENTIONS_READ:
        await this.handleChatMentionsRead(session, payload as ChatMentionsReadPayload);
        break;

      case MessageType.CHAT_REQUEST_UPLOAD_TOKEN:
        if (!(await this.requirePermission(session, Permission.ATTACH_FILES, requestId, (payload as ChatRequestUploadTokenPayload)?.channelId))) return;
        if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId, (payload as ChatRequestUploadTokenPayload)?.channelId))) return;
        if (!(await this.requireChannelAccess(session, (payload as ChatRequestUploadTokenPayload)?.channelId, requestId))) return;
        this.handleRequestUploadToken(session, payload as ChatRequestUploadTokenPayload, requestId);
        break;

      case MessageType.CHANNEL_CREATE:
        if ((payload as ChannelCreatePayload)?.categoryId
          ? !(await this.requireCategoryManagement(session, (payload as ChannelCreatePayload).categoryId!, requestId))
          : !(await this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
        await this.handleChannelCreate(session, payload as ChannelCreatePayload, requestId);
        break;

      case MessageType.CHANNEL_UPDATE:
        if (!(await this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
        await this.handleChannelUpdate(session, payload as ChannelUpdatePayload, requestId);
        break;

      case MessageType.CHANNEL_DELETE:
        if (!(await this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
        await this.handleChannelDelete(session, payload as ChannelDeletePayload, requestId);
        break;

      case MessageType.CHANNEL_REORDER:
        if (!(await this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
        await this.handleChannelReorder(session, payload as ChannelReorderPayload, requestId);
        break;

      case MessageType.CATEGORY_CREATE:
      case MessageType.CATEGORY_UPDATE:
      case MessageType.CATEGORY_DELETE:
      case MessageType.CATEGORY_REORDER: {
        if (type === MessageType.CATEGORY_UPDATE || type === MessageType.CATEGORY_DELETE) {
          if (!(await this.requireCategoryManagement(session, (payload as CategoryUpdatePayload)?.categoryId, requestId))) return;
        } else if (!(await this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
        const operation = type === MessageType.CATEGORY_CREATE ? 'create'
          : type === MessageType.CATEGORY_UPDATE ? 'update'
          : type === MessageType.CATEGORY_DELETE ? 'delete' : 'reorder';
        await this.handleCategoryMutation(session, operation, payload as CategoryCreatePayload | CategoryUpdatePayload | CategoryDeletePayload | CategoryReorderPayload, requestId);
        break;
      }

      case MessageType.USER_CHANGE_NICKNAME:
        await this.handleUserChangeNickname(session, payload as UserChangeNicknamePayload, requestId);
        break;

      case MessageType.USER_UPDATE_AVATAR:
        await this.handleUserUpdateAvatar(session, payload as UserUpdateAvatarPayload, requestId);
        break;

      case MessageType.USER_UPDATE_VISIBILITY:
        this.handleUserUpdateVisibility(session, payload as UserUpdateVisibilityPayload, requestId);
        break;

      case MessageType.USER_UPDATE_ACTIVITY:
        this.handleUserUpdateActivity(session, payload as UserUpdateActivityPayload, requestId);
        break;
      case MessageType.USER_UPDATE_BRB:
        this.handleUserUpdateBrb(session, payload, requestId);
        break;
      case MessageType.USER_UPDATE_CUSTOM_STATUS:
        this.handleUserUpdateCustomStatus(session, payload, requestId);
        break;

      case MessageType.GAME_SHARE_REQUEST: {
        const error = this.gameShareRequests.request(session, payload, requestId);
        if (error) this.sendError(session.ws, error.code, error.message, requestId);
        break;
      }

      case MessageType.GAME_SHARE_RESPONSE: {
        const error = this.gameShareRequests.respond(session, payload);
        if (error) this.sendError(session.ws, error.code, error.message, requestId);
        break;
      }

      case MessageType.SERVER_UPDATE_SETTINGS:
        if (!(await this.requirePermission(session, Permission.MANAGE_SERVER, requestId))) return;
        await this.handleServerUpdateSettings(session, payload as ServerUpdateSettingsPayload, requestId);
        break;

      case MessageType.ROLE_CREATE:
        await this.handleRoleCreate(session, payload as RoleCreatePayload, requestId);
        break;

      case MessageType.ROLE_UPDATE:
        await this.handleRoleUpdate(session, payload as RoleUpdatePayload, requestId);
        break;

      case MessageType.ROLE_DELETE:
        await this.handleRoleDelete(session, payload as RoleDeletePayload, requestId);
        break;

      case MessageType.ROLE_ASSIGN:
        await this.handleRoleAssign(session, payload as RoleAssignPayload, requestId);
        break;

      case MessageType.ROLE_UNASSIGN:
        await this.handleRoleUnassign(session, payload as RoleAssignPayload, requestId);
        break;

      case MessageType.VOICE_JOIN:
      case MessageType.VOICE_RECONNECT:
      case MessageType.VOICE_LEAVE:
      case MessageType.VOICE_STATE_UPDATE:
      case MessageType.VOICE_AFK:
      case MessageType.ADMIN_MUTE_USER:
      case MessageType.ADMIN_DEAFEN_USER:
      case MessageType.ADMIN_GET_VOICE_RESTRICTIONS:
      case MessageType.ADMIN_KICK_VOICE:
      case MessageType.ADMIN_MOVE_USER:
        await this.voiceSessions.handle(session, type, payload, requestId);
        break;

      case MessageType.RTC_SIGNAL:
        this.rtcSignals.handleRtcSignal(session, payload as WebRtcSignalPayload, requestId);
        break;

      case MessageType.NATIVE_SCREEN_SIGNAL:
        this.screens.handleNativeScreenSignal(session, payload, requestId);
        break;
      case MessageType.SCREEN_VIEWERS_GET:
        this.screens.handleScreenViewers(session, payload, requestId);
        break;

      case MessageType.RTC_DIAGNOSTICS_REPORT:
        this.rtcSignals.handleRtcDiagnosticsReport(session, payload);
        break;

      case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
      case MessageType.SFU_CREATE_WEBRTC_TRANSPORT:
      case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
      case MessageType.SFU_PRODUCE:
      case MessageType.SFU_CONSUME:
      case MessageType.SFU_PRODUCER_CLOSED:
      case MessageType.SFU_PRODUCER_SET_PAUSED:
      case MessageType.SFU_CLOSE_WEBRTC_TRANSPORT:
      case MessageType.SFU_GET_PRODUCERS:
      case MessageType.SFU_CONSUMER_SET_PAUSED:
      case MessageType.SFU_CONSUMER_CLOSED:
        await this.sfuSignaling.handle(session, type, payload, requestId);
        break;

      case MessageType.SOUNDBOARD_PLAY:
        if (!(await this.requirePermission(session, Permission.SPEAK, requestId, (payload as SoundboardPlayPayload)?.channelId))) return;
        if (!(await this.requireChannelAccess(session, (payload as SoundboardPlayPayload)?.channelId, requestId))) return;
        await this.handleSoundboardPlay(session, payload as SoundboardPlayPayload, requestId);
        break;

      case MessageType.RECENT_SOUND_RECORD:
        await this.handleRecentSoundRecord(session, payload as RecentSoundRecordPayload, requestId);
        break;

      case MessageType.RECENT_SOUNDS_LIST:
        await this.handleRecentSoundsList(session, requestId);
        break;

      case MessageType.RECENT_SOUND_DOWNLOAD:
        await this.handleRecentSoundDownload(session, payload, requestId);
        break;

      case MessageType.SOUNDBOARD_STOP:
        if (!(await this.requireChannelAccess(session, (payload as SoundboardStopPayload)?.channelId, requestId))) return;
        this.handleSoundboardStop(session, payload as SoundboardStopPayload, requestId);
        break;

      case MessageType.MEMBER_KICK:
        if (!(await this.requirePermission(session, Permission.KICK_MEMBERS, requestId))) return;
        await this.handleMemberKick(session, payload as MemberKickPayload, requestId);
        break;

      case MessageType.SERVER_GET_INVITE_INFO:
        await this.handleGetServerInviteInfo(session, requestId);
        break;

      case MessageType.USER_LOGOUT:
        // Graceful logout: mark the session so the disconnect handler treats it
        // as an intentional leave (immediate USER_LEFT, no reconnecting grace).
        session.intentionalLogout = true;
        this.voiceSessions.dropReconnectGrant(session);
        void this.syncVoicePresenceVisibility();
        this.botLocalExecution.disconnect(session);
        this.botInteractions.disconnect(session);
        this.disconnectBotScreens(session);
        break;

      case MessageType.SERVER_MONITOR_GET:
        if (this.serverMonitor) {
          await this.serverMonitor.handle(session, payload, requestId);
        } else {
          this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, 'Server monitoring is unavailable.', requestId);
        }
        break;

      case MessageType.SERVER_AUDIT_GET:
        if (this.serverAudit) await this.serverAudit.handle(session, payload, requestId);
        else this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'The audit log is unavailable.', requestId);
        break;

      // ── Bot management (#569) ────────────────────────────────────────
      case MessageType.BOT_SETTINGS_LIST:
      case MessageType.BOT_SETTINGS_GET:
      case MessageType.BOT_SETTINGS_UPDATE:
        await this.handleBotSettings(session, type, payload, requestId);
        break;

      case MessageType.BOT_PERMISSIONS_GET:
      case MessageType.BOT_PERMISSIONS_UPDATE:
        await this.handleBotPermissions(session, type, payload, requestId);
        break;

      case MessageType.BOT_INSTALL_PREVIEW:
        await this.handleBotInstallPreview(session, payload, requestId);
        break;

      case MessageType.BOT_CREATE:
        if (!(await this.requirePermission(session, Permission.MANAGE_BOTS, requestId))) return;
        await this.handleBotCreate(session, payload, requestId);
        break;

      case MessageType.BOT_LIST:
        if (!(await this.requirePermission(session, Permission.MANAGE_BOTS, requestId))) return;
        await this.handleBotList(session, requestId);
        break;

      case MessageType.BOT_UPDATE_PROFILE:
        await this.handleBotUpdateProfile(session, payload, requestId);
        break;

      case MessageType.BOT_REVOKE:
        if (!(await this.requirePermission(session, Permission.MANAGE_BOTS, requestId))) return;
        await this.handleBotRevoke(session, payload as BotRevokePayload, requestId);
        break;

      case MessageType.BOT_INSTALL:
        if (!(await this.requirePermission(session, Permission.MANAGE_BOTS, requestId))) return;
        await this.handleBotInstall(session, payload as BotInstallPayload, requestId);
        break;

      // ── Slash commands (#569) ────────────────────────────────────────
      case MessageType.COMMAND_REGISTER:
        await this.handleCommandRegister(session, payload, requestId);
        break;

      case MessageType.BOT_LOCAL_SOURCE_REQUEST:
      case MessageType.BOT_LOCAL_TASK_REQUEST:
      case MessageType.BOT_LOCAL_TASK_ACCEPT:
      case MessageType.BOT_LOCAL_TASK_CONTROL:
      case MessageType.BOT_LOCAL_TASK_EVENT:
      case MessageType.BOT_LOCAL_MEDIA_SIGNAL:
        if (session.isBot && !BOT_LOCAL_ALLOWED_MESSAGES.has(type)) {
          this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'permission_denied', requestId);
          break;
        }
        await this.botLocalExecution.handle(session, type, payload, requestId);
        break;

      case MessageType.BOT_SCREEN_CREATE:
      case MessageType.BOT_SCREEN_UPDATE:
      case MessageType.BOT_SCREEN_CLOSE:
      case MessageType.BOT_SCREEN_END:
      case MessageType.BOT_SCREEN_LIST:
      case MessageType.BOT_SCREEN_ACTION:
        if (this.botScreens) await this.botScreens.handle(session, type, payload, requestId);
        else this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Programmable screens are unavailable.', requestId);
        break;

      case MessageType.BOT_STORAGE_PUT:
      case MessageType.BOT_STORAGE_GET:
      case MessageType.BOT_STORAGE_DELETE:
      case MessageType.BOT_STORAGE_LIST:
      case MessageType.BOT_STORAGE_USAGE:
      case MessageType.BOT_STORAGE_INFO_GET:
      case MessageType.BOT_STORAGE_LIMIT_UPDATE:
      case MessageType.BOT_STORAGE_CLEAR:
        if (this.botStorage) await this.botStorage.handle(session, type, payload, requestId);
        else this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Bot storage is unavailable.', requestId);
        break;

      case MessageType.SELECTOR_CREATE:
      case MessageType.SELECTOR_LIST:
      case MessageType.SELECTOR_UPDATE:
      case MessageType.SELECTOR_CLOSE:
      case MessageType.SELECTOR_RESPOND:
      case MessageType.SELECTOR_FINALIZE:
        if (this.botSelectors) await this.botSelectors.handle(session, type, payload, requestId);
        else this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Selectors are unavailable.', requestId);
        break;

      case MessageType.COMMANDS_LIST:
        this.handleCommandsList(session, requestId);
        break;

      case MessageType.COMMAND_INVOKE:
        await this.botInteractions.invoke(session, payload, requestId);
        break;

      case MessageType.BOT_VOICE_CONTEXT:
        await this.botInteractions.getVoiceContext(session, payload, requestId);
        break;

      case MessageType.COMMAND_AUTOCOMPLETE:
        await this.botInteractions.autocomplete(session, payload, requestId);
        break;

      case MessageType.COMMAND_AUTOCOMPLETE_RESULT:
        await this.botInteractions.autocompleteResult(session, payload, requestId);
        break;

      case MessageType.COMMAND_AUTOCOMPLETE_CANCEL:
        this.botInteractions.cancelAutocomplete(session, payload, requestId);
        break;

      case MessageType.COMMAND_AUDIO_PREVIEW:
        await this.botInteractions.audioPreview(session, payload, requestId);
        break;

      case MessageType.COMMAND_AUDIO_PREVIEW_RESULT:
        await this.botInteractions.audioPreviewResult(session, payload, requestId);
        break;

      case MessageType.COMMAND_AUDIO_PREVIEW_CANCEL:
        this.botInteractions.cancelAudioPreview(session, payload, requestId);
        break;

      case MessageType.COMMAND_SOUND_DOWNLOAD:
        await this.botInteractions.downloadSound(session, payload, requestId);
        break;

      case MessageType.COMMAND_SOUND_DOWNLOAD_RESULT:
        await this.botInteractions.downloadSoundResult(session, payload, requestId);
        break;

      case MessageType.COMMAND_RESPONSE:
        await this.botInteractions.respond(session, payload, requestId);
        break;

      case MessageType.COMMAND_PROMPT:
        await this.botInteractions.prompt(session, payload, requestId);
        break;

      case MessageType.COMMAND_SUBMIT:
        await this.botInteractions.submit(session, payload, requestId);
        break;

      case MessageType.COMMAND_CANCEL:
        this.botInteractions.cancel(session, payload, requestId);
        break;

      case MessageType.COMMAND_FINISH:
        this.botInteractions.complete(session, payload, requestId);
        break;

      default:
        Logger.warn('NETWORK', `Unknown message type received: ${type}`);
        this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, `Tipo de mensagem não suportado: ${type}`, requestId);
    }
  }

  private async handleAuthConnect(
    session: ClientSession,
    payload: AuthConnectPayload,
    requestId?: string
  ): Promise<void> {
    if (!payload || typeof payload !== 'object') {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de autenticação inválidos.', requestId);
      return;
    }
    session.protocol = negotiateProtocol(payload.protocolVersion, payload.protocolOffer, payload.botToken ? 'bot' : 'client') ?? undefined;
    // Bot token auth: skip challenge-response, authenticate directly (#569).
    if (payload.botToken && this.botService) {
      await this.handleBotAuth(session, payload, requestId);
      return;
    }

    const result = await this.authService.createChallenge(session.ws, payload);
    if (!this.isLive(session)) return;

    if (!result.success || !result.nonce) {
      // Aqui é onde a senha errada aparece: é esta tentativa que conta para o
      // limite por IP (#372).
      this.rateLimiter.checkLimit(
        `auth:${session.ip}`,
        LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS,
        LIMITS.RATE_LIMIT_AUTH_WINDOW_MS
      );
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.INTERNAL_ERROR,
        result.errorMessage || 'Falha na autenticação',
        requestId,
        result.serverProtocolVersion
      );
      return;
    }

    this.send(session.ws, {
      type: MessageType.AUTH_CHALLENGE,
      requestId,
      payload: { nonce: result.nonce } satisfies AuthChallengePayload,
    });
  }

  private async handleAuthChallengeResponse(
    session: ClientSession,
    payload: unknown,
    requestId?: string
  ): Promise<void> {
    // A malformed answer is the client's mistake, not a server failure to log with a stack.
    const signature = payload !== null && typeof payload === 'object' && 'signature' in payload ? payload.signature : undefined;
    if (typeof signature !== 'string') {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Resposta de autenticação inválida.', requestId);
      return;
    }
    // Probed before anything is read for this login: on Linux it runs `which`
    // and `sudo`, and a change published meanwhile would reach this connection
    // ahead of the AUTH_SUCCESS that overwrites it. Shared and cached, the probe
    // only delays the logins that arrive while it runs.
    const turnAvailability = await CoturnManager.availability();
    if (!this.isLive(session)) return;
    // Nothing from here to AUTH_SUCCESS may wait on a process or the network.
    // A role or channel change landing anyway makes the snapshot stale for this
    // connection alone (see resyncLoginAccess).
    const accessUnchanged = this.captureAccess();
    const result = await this.authService.verifyChallengeResponse(session.ws, signature);
    if (!this.isLive(session)) return;

    if (!result.success || !result.user || !result.serverDetails) {
      if (result.authFailed) {
        this.send(session.ws, {
          type: MessageType.AUTH_FAILED,
          requestId,
          payload: {
            code: result.errorCode,
            message: result.errorMessage || 'Falha na autenticação',
          } satisfies AuthFailedPayload,
        });
        return;
      }
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.INTERNAL_ERROR,
        result.errorMessage || 'Falha na autenticação',
        requestId
      );
      return;
    }

    session.user = result.user;
    this.settleAnonymous(session);
    const sessionId = result.user.sessionId!;
    session.sessionId = sessionId;
    session.invisible = result.appearOffline === true;
    // "Volto já" only exists between peers that negotiated it (user-brb).
    result.user.brb = !session.isBot && result.brb === true && session.protocol?.features.includes('user-brb') ? true : undefined;
    // A custom status is the other choice beside "Volto já", never both (custom-status).
    result.user.customStatus = !session.isBot && !result.user.brb && session.protocol?.features.includes('custom-status')
      ? result.customStatus : undefined;
    if (result.newMember) this.recordAudit(session, 'member.join', { target: auditRef.member(result.user) });

    // Prevent duplicate sessions for the *same device*. A lingering/zombie socket
    // (e.g. after a reconnect where the old TCP connection was not yet cleaned
    // up) would otherwise receive every broadcast twice. Note this is keyed by
    // sessionId, not by user: another device of the same person is a legitimate
    // second session and must be left alone (#309).
    const existingWs = this.sessionSockets.get(sessionId);
    if (existingWs && existingWs !== session.ws) {
      this.replaceConnection(existingWs);
      Logger.info('NETWORK', `Replaced stale session ${sessionId}`);
    }

    this.sessionSockets.set(sessionId, session.ws);
    this.dmRelay.register(session);

    // If this session had a pending "reconnecting" grace timer (from a recent
    // ungraceful drop), cancel it and tell everyone they are back online (#44).
    // Invisible users suppress the online broadcast (#561).
    const pendingTimer = this.reconnectTimers.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.reconnectTimers.delete(sessionId);
      if (!session.invisible) {
        const backOnlinePayload: UserConnectionStatePayload = {
          userId: result.user.id,
          sessionId,
          nickname: result.user.nickname,
          status: 'online',
        };
        this.broadcast({
          type: MessageType.USER_CONNECTION_STATE,
          payload: backOnlinePayload,
        }, session.ws);
      }
    }

    // Remember exactly which channels this client was told about, so later role
    // or privacy changes can be reconciled into deltas (#384).
    const voicePresenceKey = this.voicePresenceKey(result.user.id);
    await this.includeVoicePresenceChannels(result.user.id, result.serverDetails);
    session.visibleChannelIds = new Set(result.serverDetails.channels.map((c) => c.id));
    session.voicePresenceKey = voicePresenceKey;
    result.serverDetails.voiceStates = Object.fromEntries(
      Object.entries(this.signalingService.getAllVoiceStates())
        .filter(([, state]) => session.visibleChannelIds?.has(state.channelId))
    );

    // Each client reads roles in the model it negotiated.
    if (result.serverDetails.roles) {
      result.serverDetails.roles = rolesForModel(result.serverDetails.roles,
        result.serverDetails.everyonePermissions ?? DEFAULT_PERMISSIONS, roleModelFor(session.protocol?.features));
    }

    // Send AUTH_SUCCESS to the connecting client
    const iceServers = await this.buildIceServersFor(result.user.id, session);
    if (!this.isLive(session)) return;
    const successPayload: AuthSuccessPayload = {
      server: {
        ...result.serverDetails,
        protocol: session.protocol,
        serverVersion: this.serverVersion,
        // Told at login because it depends on the host OS and on coturn being
        // installed (#429), which only change through an installation.
        turnAvailability,
      },
      currentUser: result.user,
      voiceRestrictions: this.signalingService.getVoiceRestrictions(result.user.id),
      roles: result.serverDetails.roles,
      userRoles: result.serverDetails.userRoles,
      ownerId: result.serverDetails.ownerId,
      myPermissions: result.serverDetails.myPermissions,
      iceServers,
    };

    // Auth and ICE setup await I/O. Refresh the live roster at the send boundary
    // so an intervening join/leave cannot be erased by an older auth snapshot.
    successPayload.server.members = Array.from(this.getOnlineUsersMap().values())
      .filter(({ user }) => !user.invisible || user.id === result.user!.id)
      .map(({ user }) => this.userForRecipient(session, user));
    // From here on this connection holds exactly the channels and categories of
    // the snapshot, whatever a reconciliation that ran while it was assembled
    // recorded for it: later deltas are computed against what it was sent.
    const snapshotChannelIds = new Set(result.serverDetails.channels.map((c) => c.id));
    successPayload.server.voiceStates = Object.fromEntries(
      Object.entries(this.signalingService.getAllVoiceStates())
        .filter(([, state]) => snapshotChannelIds.has(state.channelId))
    );
    const snapshotCurrent = accessUnchanged();
    session.visibleChannelIds = snapshotChannelIds;
    session.categoriesKey = JSON.stringify(result.serverDetails.categories ?? []);
    this.send(session.ws, {
      type: MessageType.AUTH_SUCCESS,
      requestId,
      payload: successPayload,
    });
    this.handleCommandsList(session);
    await this.sendBotSettingsList(session);

    if (this.getSessionsOfUser(result.user.id).some((other) => !!other.invisible !== !!session.invisible)) {
      this.handleUserUpdateVisibility(session, { appearOffline: session.invisible === true });
    }
    // The device that just connected carries the person's current choice, as
    // with visibility; one that does not know the status cannot clear it.
    if (session.protocol?.features.includes('user-brb') && this.getSessionsOfUser(result.user.id)
      .some((other) => other !== session && !!other.user?.brb !== !!session.user?.brb)) {
      this.applyBrb(session, session.user?.brb === true);
    }
    if (session.protocol?.features.includes('custom-status') && this.getSessionsOfUser(result.user.id)
      .some((other) => other !== session && !sameCustomStatus(other.user?.customStatus, session.user?.customStatus))) {
      this.applyCustomStatus(session, session.user?.customStatus ?? null);
    }

    // Broadcast USER_JOINED to all other clients — unless the user is invisible (#561).
    if (!session.invisible) {
      const userJoinedPayload: UserJoinedPayload = { user: result.user };
      this.broadcast({
        type: MessageType.USER_JOINED,
        payload: userJoinedPayload,
      }, session.ws);
    }

    // Signing in changes nobody's access unless it gave out a role. Republishing
    // roles, channels and community to every connection on each login made a
    // reconnection wave cost O(N²) (S-WS-4).
    if (result.rolesChanged) await this.broadcastRolesState(requestId);
    else if (!snapshotCurrent) await this.resyncLoginAccess(session);
    else if (session.voicePresenceKey !== this.voicePresenceKey(result.user.id)) void this.syncVoicePresenceVisibility();

    Logger.info('NETWORK', `User ${result.user.nickname} (${result.user.id}) joined the server.`);
  }

  /**
   * Catches up a connection whose login snapshot went stale: roles or channel
   * access changed while it signed in, and the broadcast of that change did not
   * reach it, or reached it ahead of the AUTH_SUCCESS that replaced it. It gets
   * the roles and every channel it may see, rows included, as a channel it kept
   * may have been renamed or had its rules changed.
   *
   * The read waits, for a bounded time, until no change is in progress and none
   * lands while it runs, so it is not older than what a concurrent broadcast
   * already sent. Past that time it is sent anyway: a change still running then
   * publishes to this connection itself once it ends, as it is registered now.
   */
  private async resyncLoginAccess(session: ClientSession): Promise<void> {
    const deadline = performance.now() + LOGIN_RESYNC_WAIT_MS;
    const waiting = () => performance.now() < deadline;
    for (;;) {
      const userId = session.user?.id;
      if (!userId || !this.isCurrentSession(session)) return;
      const unchanged = this.captureAccess();
      if (unchanged() || !waiting()) {
        const [state, channels, categories, context] = await Promise.all([
          this.roleService.getRoleState(),
          this.channelService.listChannels(),
          this.channelService.listCategories(),
          this.channelService.getAccessContext(userId),
        ]);
        if (!this.isCurrentSession(session)) return;
        if (unchanged() || !waiting()) {
          this.send(session.ws, {
            type: MessageType.ROLES_LIST,
            payload: {
              everyonePermissions: state.everyonePermissions,
              roles: rolesForModel(state.roles, state.everyonePermissions, roleModelFor(session.protocol?.features)),
              userRoles: state.userRoles,
            } satisfies RolesListPayload,
          });
          session.voicePresenceKey = this.voicePresenceKey(userId);
          this.sendChannelVisibility(session, this.visibleChannelIdsFor(channels, context), channels, categories, context, true);
          return;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOGIN_RESYNC_POLL_MS));
    }
  }

  /**
   * ICE servers for one client: STUN always, plus the relay when it is up (#425).
   *
   * The credentials are minted per connection and expire on their own, so a
   * leaked `AUTH_SUCCESS` cannot be replayed forever, and a member removed from
   * the server loses relay access once their current set lapses.
   */
  /**
   * Brings the relay in line with the freshly saved setting (#425).
   *
   * Members already in a call keep the ICE servers they were given at login, so
   * switching the relay on only helps the calls started afterwards — which is
   * why the UI tells the operator to reconnect.
   */
  private async applyTurnState(enabled: boolean): Promise<void> {
    try {
      if (!enabled) {
        await this.coturnManager.stop();
        return;
      }
      const server = await this.serverRepo.getServer();
      if (!server?.turnSecret) {
        throw new Error('O relay TURN não pôde iniciar: a chave compartilhada não está disponível.');
      }
      const started = await this.coturnManager.start(server.turnSecret);
      if (!started || !this.coturnManager.isRunning()) {
        throw new Error('O coturn não iniciou ou encerrou antes de ficar pronto. Verifique o log do servidor.');
      }

      // Verify the relay is actually reachable. A VPS whose firewall blocks
      // port 3478 will silently swallow TURN allocations, and the only sign is
      // that members behind CGNAT never connect — exactly the bug #425
      // reported. Checking right after start catches the most common
      // misconfiguration before anyone tries to call.
      const portProblem = await CoturnManager.checkPortReachability();
      if (portProblem) {
        throw new Error(portProblem);
      }
    } catch (error) {
      Logger.error('NETWORK', 'Failed to apply the TURN relay state', error);
      throw error;
    }
  }

  /**
   * Makes sure coturn is actually usable, installing it when needed.
   *
   * Returns null when the relay can run, or the reason it cannot.
   */
  private async ensureRelayCanRun(session: ClientSession): Promise<string | null> {
    if (!CoturnManager.isSupportedPlatform()) {
      return 'O relay TURN só é suportado em servidores Linux. Não existe pacote do coturn para Windows ou macOS.';
    }
    if (CoturnManager.isInstalled()) return null;

    // The install takes minutes, so whoever asked for it gets told how far it
    // has gone instead of watching a frozen modal (#438).
    const outcome = await CoturnManager.ensureInstalled((progress) => {
      this.send(session.ws, { type: MessageType.TURN_INSTALL_PROGRESS, payload: progress });
    });
    if (outcome.ok) return null;

    switch (outcome.reason) {
      case 'no-privileges':
        return 'O coturn não está instalado e o servidor não tem privilégio para instalá-lo. Rode "sudo bash scripts/install-turn.sh" no host.';
      case 'unknown-package-manager':
        return 'O coturn não está instalado e nenhum gerenciador de pacotes conhecido foi encontrado. Instale o coturn manualmente no host.';
      case 'unsupported-platform':
        return 'O relay TURN só é suportado em servidores Linux. Não existe pacote do coturn para Windows ou macOS.';
      default:
        return `Não foi possível instalar o coturn automaticamente: ${outcome.detail ?? 'erro desconhecido'}`;
    }
  }

  // ── Bot authentication (token-based, no challenge) ───────────────────────
  private async handleBotDiagnostic(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    if (session.user) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Use uma conexão própria, sem autenticação, para o diagnóstico.', requestId);
      return;
    }
    if (!this.botDiagnostics) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Este servidor não aceita bots.', requestId);
      return;
    }
    const outcome = await this.botDiagnostics.diagnose(payload, session.ip);
    if (!this.isLive(session)) return;
    if (outcome.kind === 'invalid') {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Diagnóstico de bot inválido.', requestId);
    } else if (outcome.kind === 'rate_limited') {
      Logger.security(`Bot diagnostic rate limit reached for ${session.ip}`);
      this.sendError(session.ws, ProtocolErrorCode.AUTH_RATE_LIMITED, 'Muitas tentativas de conexão. Aguarde um minuto.', requestId);
    } else {
      this.send(session.ws, { type: MessageType.BOT_DIAGNOSTIC_RESULT, requestId, payload: outcome.result });
    }
  }

  private async handleBotAuth(
    session: ClientSession,
    payload: AuthConnectPayload,
    requestId?: string
  ): Promise<void> {
    if (
      !this.botService || !payload?.botToken ||
      !authConnectSchema.shape.botToken.safeParse(payload.botToken).success ||
      !authConnectSchema.shape.publicKey.safeParse(payload.publicKey).success
    ) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de autenticação de bot inválidos.', requestId);
      return;
    }

    // Incompatible peers must never perform TOFU binding. An already-bound bot
    // can still identify its obsolete protocol for the owner's persistent warning.
    if (!session.protocol) {
      await this.botService.recordRejectedProtocol(payload.botToken, payload.publicKey, payload.protocolVersion);
      if (!this.isLive(session)) return;
      this.sendError(
        session.ws,
        ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
        `Versão de protocolo incompatível. Este servidor usa a versão ${PROTOCOL_VERSION}.`,
        requestId,
        PROTOCOL_VERSION
      );
      return;
    }

    const nickname = botIdentitySchema.shape.name.safeParse(payload.nickname);
    if (!nickname.success) {
      this.sendError(session.ws, ProtocolErrorCode.BOT_INVALID_PROFILE,
        'O bot precisa informar um nome válido na autenticação.', requestId);
      return;
    }

    // Probed before the bot is validated and anything is read for it, as for a
    // person: what changes while it runs, a revocation included, is then seen by
    // this login instead of reaching it ahead of AUTH_SUCCESS or being missed.
    const turnAvailability = await CoturnManager.availability();
    if (!this.isLive(session)) return;

    const publicKey = payload.publicKey;
    let botRecord = await this.botService.validateToken(payload.botToken, publicKey);
    if (!this.isLive(session)) return;
    if (!botRecord) {
      this.send(session.ws, {
        type: MessageType.AUTH_FAILED,
        requestId,
        payload: {
          code: ProtocolErrorCode.UNAUTHORIZED,
          message: 'Token de bot inválido ou chave pública não corresponde ao vínculo TOFU.',
        } satisfies AuthFailedPayload,
      });
      return;
    }

    if (botRecord.profilePending) {
      const result = await this.botService.updateProfile(botRecord.id, { name: nickname.data });
      if (!result.success) {
        this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
        return;
      }
      botRecord = await this.botService.findById(botRecord.id);
      if (!botRecord) {
        this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'O vínculo do bot foi revogado.', requestId);
        return;
      }
      if (!this.isLive(session)) return;
    }

    if (!await this.botService.recordCompatibleConnection(botRecord.id, payload.protocolVersion)) {
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'O vínculo do bot foi revogado.', requestId);
      return;
    }
    if (!this.isLive(session)) return;

    // Build a synthetic UserSummary for the bot.
    const sessionId = `bot:${botRecord.id}`;
    const now = Date.now();
    const botUser: UserSummary = {
      id: botRecord.id,
      clientId: `bot-${botRecord.id}`,
      nickname: botRecord.name,
      avatarUrl: botRecord.avatarPath ? `/avatars/${botRecord.avatarPath}` : undefined,
      status: 'ONLINE',
      joinedAt: now,
      sessionId,
      connectedAt: now,
      isBot: true,
    };

    session.user = botUser;
    this.settleAnonymous(session);
    session.sessionId = sessionId;
    session.isBot = true;
    session.botId = botRecord.id;
    session.botPublicKey = localBotIdentitySchema.shape.botPublicKey.parse(botRecord.boundPublicKey);
    session.botSettingsReady = false;

    // Replace existing bot session if any.
    const existingWs = this.sessionSockets.get(sessionId);
    if (existingWs && existingWs !== session.ws) {
      this.replaceConnection(existingWs);
      this.commandRegistry.clearBot(botRecord.id);
      this.broadcastCommands();
    }
    this.sessionSockets.set(sessionId, session.ws);

    // Headless clients need the same actual media mode, ICE and scoped roster as humans.
    const server = await this.serverRepo.getServer();
    const channels = server ? await this.channelService.listChannels() : [];
    const access = await this.channelService.getAccessContext(botRecord.id);
    const visibleChannels = channels.filter((channel) => canAccessChannel(channel, access.permissions, access.roleIds, access.isBot, access.userId));
    const visibleChannelIds = new Set(visibleChannels.map((channel) => channel.id));
    const voiceStates = Object.fromEntries(Object.entries(this.signalingService.getAllVoiceStates())
      .filter(([, state]) => visibleChannelIds.has(state.channelId)));
    const iceServers = await this.buildIceServersFor(botRecord.id, session);
    const serverDetails = {
      protocol: session.protocol,
      maxMessageLength: server?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH,
      id: server?.id ?? '',
      name: server?.name ?? '',
      serverVersion: this.serverVersion,
      createdAt: server?.createdAt ?? now,
      maxUsers: server?.maxUsers ?? 0,
      hasPassword: false,
      allowSoundboard: false,
      dmRelayEnabled: false,
      allowEveryoneMention: false,
      allowMessageEdit: false,
      showRoleBadgesToEveryone: false,
      voiceMode: server?.voiceMode ?? 'p2p',
      hostSpecs: { cpuCores: 0, ramTotalGb: 0 },
      turnEnabled: server?.turnEnabled ?? false,
      maxBots: server?.maxBots ?? LIMITS.MAX_BOTS_DEFAULT,
      iconUrl: null,
      channels: visibleChannels.map((c) => ({
        permissionOverwrites: c.permissionOverwrites,
        categoryId: c.categoryId ?? null,
        inheritCategoryPermissions: c.inheritCategoryPermissions ?? true,
        id: c.id, serverId: c.serverId, name: c.name, type: c.type,
        position: c.position, createdAt: c.createdAt,
        maxParticipants: c.maxParticipants, isPrivate: c.isPrivate,
        botCommandsEnabled: c.botCommandsEnabled,
        allowedRoleIds: c.allowedRoleIds,
      })),
      categories: (await this.channelService.listCategories()).filter((category) =>
        canAccessChannel(category, access.permissions, access.roleIds, access.isBot, access.userId) || visibleChannels.some((channel) => channel.categoryId === category.id)),
      members: [botUser, ...Object.values(voiceStates).flatMap((state) => {
        const user = this.findSessionById(state.sessionId)?.user;
        return user && user.id !== botUser.id ? [voiceRosterUser(user)] : [];
      })],
      knownMembers: [botUser],
      mentionedChannelIds: [],
      voiceStates,
      roles: [],
      userRoles: [],
      ownerId: server?.ownerUserId ?? null,
      myPermissions: access.permissions,
      attachmentStorage: { maxFileBytes: 0, maxTotalBytes: 0, usedBytes: 0 },
    };
    session.visibleChannelIds = new Set(serverDetails.channels.map((channel) => channel.id));

    if (session.replaced || !this.isLive(session)) return;
    this.send(session.ws, {
      type: MessageType.AUTH_SUCCESS,
      requestId,
      payload: {
        server: { ...serverDetails, turnAvailability },
        currentUser: botUser,
        voiceRestrictions: this.signalingService.getVoiceRestrictions(botRecord.id),
        roles: [],
        userRoles: [],
        ownerId: serverDetails.ownerId,
        myPermissions: access.permissions,
        iceServers,
      } satisfies AuthSuccessPayload,
    });

    // Broadcast the bot joining.
    this.broadcast({ type: MessageType.USER_JOINED, payload: { user: botUser } satisfies UserJoinedPayload }, session.ws);
    await this.broadcastBotSettings();
    Logger.info('BOT', `Bot "${botRecord.name}" (${botRecord.id}) connected.`);
  }

  // ── Bot management handlers (#569) ─────────────────────────────────────

  private async handleBotCreate(
    session: ClientSession,
    payload: unknown,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !this.botService) return;

    const parsed = botCreateSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST,
        'O vínculo não aceita nome ou avatar definidos pelo cliente.', requestId);
      return;
    }
    const authorized = await this.botManagementAuthorization(session, requestId);
    if (!authorized) return;
    const result = await this.botService.create(session.user.id, authorized);

    if (!result.success) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao criar bot.',
        requestId
      );
      return;
    }
    if (!authorized()) {
      await this.botService.revoke(result.bot.id);
      return;
    }

    const createdPayload: BotCreatedPayload = {
      bot: result.bot,
      token: result.token,
    };
    this.send(session.ws, { type: MessageType.BOT_CREATED, requestId, payload: createdPayload });
    this.recordAudit(session, 'bot.create', { target: auditRef.bot(result.bot.id, result.bot.name) });
    await this.broadcastBotSettings();
  }

  private async handleBotList(
    session: ClientSession,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !this.botService) return;
    const bots = await this.botService.list();
    const listPayload: BotListResponsePayload = { bots };
    this.send(session.ws, { type: MessageType.BOT_LIST_RESPONSE, requestId, payload: listPayload });
  }

  private isCurrentBotOperation(session: BotInteractionSession, ...capabilities: BotCapability[]): boolean {
    return this.isCurrentSession(session) && (!session.isBot ||
      (!!session.botId && this.botService?.permissions?.allows(session.botId, ...capabilities) === true));
  }

  private async botManagementAuthorization(session: ClientSession, requestId?: string): Promise<(() => boolean) | undefined> {
    if (!session.user || session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Only human bot administrators may approve access.', requestId);
      return undefined;
    }
    for (let attempt = 0; attempt < 8 && this.isCurrentSession(session); attempt++) {
      const version = this.botSettingsPermissionVersion;
      const roles = this.channelService.getRoleAccessVersion();
      if (roles === null) continue;
      const allowed = await this.permissionService.checkPermission(session.user.id, Permission.MANAGE_BOTS);
      const current = () => this.isCurrentSession(session) && version === this.botSettingsPermissionVersion &&
        roles === this.channelService.getRoleAccessVersion();
      if (!current()) continue;
      if (allowed) return current;
      break;
    }
    this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bot management permission is unavailable or changed.', requestId);
    return undefined;
  }

  private async handleBotPermissions(session: ClientSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    try {
      const permissions = this.botService?.permissions;
      if (!permissions || !session.user || !this.isCurrentSession(session)) return;
      const parsed = type === MessageType.BOT_PERMISSIONS_UPDATE
        ? botPermissionsUpdateSchema.safeParse(payload) : botPermissionsGetSchema.safeParse(payload);
      if (!parsed.success) throw new BotPermissionError(ProtocolErrorCode.BAD_REQUEST, 'Invalid bot permission request.');
      const { botId } = parsed.data;
      if (session.isBot && (type !== MessageType.BOT_PERMISSIONS_GET || session.botId !== botId)) {
        throw new BotPermissionError(ProtocolErrorCode.PERMISSION_DENIED, 'Bots may only read their own grants.');
      }
      if (!session.isBot) {
        const authorized = await this.botManagementAuthorization(session, requestId);
        if (!authorized || !authorized()) return;
      }
      if (type === MessageType.BOT_PERMISSIONS_UPDATE) {
        const previous = [...(permissions.get(botId)?.granted ?? [])];
        const update = botPermissionsUpdateSchema.parse(parsed.data);
        // A client that cannot see the storage capabilities leaves them as they were.
        permissions.approve(session.user.id, this.supportsBotStorage(session) ? update
          : { ...update, granted: [...update.granted, ...previous.filter(isBotStorageCapability)] });
        // Invalidate the old socket synchronously with persistence. Work resumed
        // after any await cannot reuse a grant, even if it is quickly re-enabled.
        this.disconnectBot(botId);
        await this.botSelectors?.revokeBot(botId);
        const granted = permissions.get(botId)?.granted ?? [];
        const added = granted.filter((capability) => !previous.includes(capability));
        const removed = previous.filter((capability) => !granted.includes(capability));
        if (this.audit && (added.length || removed.length)) {
          const bot = await this.botService?.findById(botId);
          this.recordAudit(session, 'bot.permissions', {
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
      this.send(session.ws, { type: MessageType.BOT_PERMISSIONS_SNAPSHOT, requestId,
        payload: { botId, permissions: this.visibleBotPermissions(session, state) } });
      await this.broadcastBotSettings(botId);
    } catch (error) {
      this.sendBotSettingsError(session, error, requestId);
    }
  }

  private async handleBotInstallPreview(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = botInstallPreviewRequestSchema.safeParse(payload);
    if (!parsed.success || !this.botService) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'URL do manifest inválida.', requestId);
      return;
    }
    const authorized = await this.botManagementAuthorization(session, requestId);
    if (!authorized || !session.sessionId) return;
    const result = await this.botService.previewInstallation(
      parsed.data.manifestUrl, session.sessionId, session.requestServerUrl,
    );
    if (!authorized()) return;
    if (!result.success) this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
    else this.send(session.ws, { type: MessageType.BOT_INSTALL_PREVIEW_RESULT, requestId, payload: this.supportsBotStorage(session)
      ? result.preview : { ...result.preview, manifest: {
        ...result.preview.manifest, requestedCapabilities: withoutBotStorageCapabilities(result.preview.manifest.requestedCapabilities),
      } } });
  }

  private async handleBotUpdateProfile(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    if (!session.user || !this.botService) return;
    if (!session.isBot || !session.botId) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED,
        'Nome e avatar são definidos exclusivamente pelo próprio bot.', requestId);
      return;
    }
    const parsed = botProfileUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const code = parsed.error.issues.some((issue) => issue.path[0] === 'avatarBase64' && issue.code === 'too_big')
        ? ProtocolErrorCode.AVATAR_TOO_LARGE : ProtocolErrorCode.BOT_INVALID_PROFILE;
      this.sendError(session.ws, code, 'Perfil do bot inválido.', requestId);
      return;
    }
    const botId = session.botId;
    if (parsed.data.botId !== undefined && parsed.data.botId !== botId) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots só podem editar o próprio perfil.', requestId);
      return;
    }
    if (!this.isCurrentSession(session)) return;
    const previous = this.audit ? await this.botService.findById(botId) : null;
    const result = await this.botService.updateProfile(botId, parsed.data);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    const updated: BotProfileUpdatedPayload = { bot: result.bot };
    // Bots announce their profile on every start: an unchanged one is only answered (BOTS-4).
    if (!result.changed) {
      this.send(session.ws, { type: MessageType.BOT_PROFILE_UPDATED, requestId, payload: updated });
      return;
    }
    if (previous) {
      // Bots resend their avatar on every start, so only a new name is worth recording.
      const changes = auditDiff([['name', previous.name, result.bot.name]]);
      if (changes.length) this.recordAudit(session, 'bot.profile', { changes });
    }

    this.commandRegistry.updateBotIdentity(botId, result.bot.name, result.bot.avatarUrl);
    for (const target of this.getSessionsOfUser(botId)) {
      if (!target.user || !target.isBot) continue;
      target.user = { ...target.user, nickname: result.bot.name, avatarUrl: result.bot.avatarUrl };
      this.broadcast({
        type: MessageType.USER_UPDATED,
        payload: { user: target.user } satisfies UserUpdatedPayload,
      });
    }
    this.send(session.ws, { type: MessageType.BOT_PROFILE_UPDATED, requestId, payload: updated });
    this.broadcast({ type: MessageType.BOT_PROFILE_UPDATED, payload: updated }, session.ws);
    this.broadcastCommands();
    await this.broadcastBotSettings();
  }

  private async handleBotRevoke(
    session: ClientSession,
    payload: BotRevokePayload,
    requestId?: string
  ): Promise<void> {
    const botService = this.botService;
    if (!session.user || !botService) return;

    if (typeof payload?.botId !== 'string' || !payload.botId || payload.botId.length > 128) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bot inválido.', requestId);
      return;
    }
    const cleanupCommunityMedia = this.communityService?.prepareBotDeletion(payload.botId);
    const revoked = this.audit ? await botService.findById(payload.botId) : null;
    const result = await this.mutateLocalAccess(() => botService.revoke(payload.botId));
    if (!result.success) {
      this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    cleanupCommunityMedia?.();
    if (revoked) this.recordAudit(session, 'bot.revoke', { target: auditRef.bot(revoked.id, revoked.name) });

    this.disconnectBot(payload.botId, 'revoked');
    const revokedPayload: BotRevokedPayload = { botId: payload.botId };
    this.send(session.ws, { type: MessageType.BOT_REVOKED, requestId, payload: revokedPayload });
    this.broadcast({ type: MessageType.BOT_REVOKED, payload: revokedPayload }, session.ws);
    await this.broadcastBotSettings();
  }

  private disconnectBot(botId: string, reason?: 'revoked'): void {
    this.botLocalExecution.invalidateBot(botId);
    const botSessionId = `bot:${botId}`;
    const botWs = this.sessionSockets.get(botSessionId);
    if (botWs) {
      const botSession = this.sessions.get(botWs);
      if (botSession) {
        if (reason === 'revoked') {
          this.send(botWs, { type: MessageType.BOT_REVOKED, payload: { botId } satisfies BotRevokedPayload });
        }
        botSession.replaced = true;
        this.releaseConnection(botSession);
        if (botSession.user && botSession.sessionId) this.finalizeSessionLeave(botSession.user, botSession.sessionId);
      }
      this.sessionSockets.delete(botSessionId);
      try { botWs.close(); } catch { /* ignore */ }
    }

    // Unregister commands.
    this.commandRegistry.clearBot(botId);
    this.broadcastCommands();
  }

  private async handleBotInstall(
    session: ClientSession,
    payload: BotInstallPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !this.botService) return;

    const parsed = botInstallSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Revise as permissões do bot antes de instalar.', requestId);
      return;
    }
    const authorized = await this.botManagementAuthorization(session, requestId);
    if (!authorized || !session.sessionId) return;

    const server = await this.serverRepo.getServer();
    const serverName = server?.name || 'Monky Server';

    const result = await this.botService.installFromPreview(
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
        this.disconnectBot(result.revokedBotId, 'revoked');
        this.broadcast({ type: MessageType.BOT_REVOKED, payload: { botId: result.revokedBotId } satisfies BotRevokedPayload });
        await this.broadcastBotSettings();
      }
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao instalar bot.',
        requestId
      );
      return;
    }

    const installedPayload: BotInstalledPayload = { bot: result.bot };
    this.send(session.ws, { type: MessageType.BOT_INSTALLED, requestId, payload: installedPayload });
    this.recordAudit(session, 'bot.install', {
      target: auditRef.bot(result.bot.id, result.bot.name),
      changes: result.bot.permissions?.granted.length
        ? [{ field: 'capabilitiesGranted', after: [...result.bot.permissions.granted] }] : [],
    });
    this.broadcastCommands();
    await this.broadcastBotSettings(result.bot.id);
  }

  // ── Slash command handlers (#569) ──────────────────────────────────────

  private async handleCommandRegister(
    session: ClientSession,
    payload: unknown,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.isBot || !session.botId || !this.isCurrentSession(session)) {
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Apenas bots podem registrar comandos.', requestId);
      return;
    }

    const parsed = commandRegisterSchema.safeParse(payload);
    if (!parsed.success) {
      const settingsError = parsed.error.issues.some((issue) => issue.path[0] === 'settings');
      const capabilitiesError = parsed.error.issues.some((issue) => issue.path[0] === 'requestedCapabilities');
      this.sendError(session.ws, capabilitiesError ? ProtocolErrorCode.BOT_CAPABILITIES_INVALID
        : settingsError ? ProtocolErrorCode.BOT_SETTINGS_INVALID : ProtocolErrorCode.BOT_INVALID_OPTIONS,
        settingsError || capabilitiesError ? parsed.error.message : 'Definições de comandos inválidas.', requestId);
      return;
    }
    const bot = await this.botService?.findById(session.botId);
    const botKey = localBotIdentitySchema.shape.botPublicKey.safeParse(bot?.boundPublicKey);
    if (!this.isCurrentSession(session)) return;
    if (!bot || !botKey.success || botKey.data !== session.botPublicKey) {
      this.botLocalExecution.invalidateBot(session.botId);
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Bot binding is no longer valid.', requestId);
      return;
    }
    try {
      const permissionService = this.botService?.permissions;
      if (!permissionService) throw new BotPermissionError(ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED, 'Bot permission storage is unavailable.');
      const previous = permissionService.get(session.botId);
      const declaration = permissionService.declare(session.botId, parsed.data.requestedCapabilities);
      if (declaration.changed && previous?.requested !== null) {
        this.disconnectBot(session.botId);
        await this.botSelectors?.revokeBot(session.botId);
        await this.broadcastBotSettings(session.botId);
        return;
      }
      if (!this.botSettings && parsed.data.settings) {
        throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, 'Bot settings are unavailable.');
      }
      const settings = this.botSettings?.register(
        session.botId, parsed.data.settings, parsed.data.commands.some((command) => command.downloadsSound === true)
      ) ?? { schemaRevision: 0, revision: 0, values: {} };
      // No await between persistence and registry replacement: validation of both
      // declarations has completed before either set becomes visible.
      const registered = this.commandRegistry.register(
        session.botId, session.user.nickname, parsed.data.commands, session.user.avatarUrl, botKey.data
      );
      this.botLocalExecution.commandsChanged(session.botId);
      this.botInteractions.commandsChanged(session.botId);
      this.send(session.ws, {
        type: MessageType.COMMAND_REGISTERED, requestId,
        payload: { registered, settings, permissions: declaration.permissions } satisfies CommandRegisteredPayload,
      });
      session.botSettingsReady = true;
      this.broadcastCommands();
      await this.broadcastBotSettings(session.botId);
    } catch (error) {
      this.sendBotSettingsError(session, error, requestId);
    }
  }

  private async handleBotSettings(
    session: ClientSession, type: MessageType, payload: unknown, requestId?: string
  ): Promise<void> {
    if (!session.user || !this.isCurrentSession(session)) return;
    try {
      if (!this.botSettings || !this.botService) {
        throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'Bot settings are unavailable.');
      }
      const settingsService = this.botSettings;
      if (type === MessageType.BOT_SETTINGS_LIST) {
        if (session.isBot) throw new BotSettingsError(ProtocolErrorCode.PERMISSION_DENIED, 'Only human members may list bot settings.');
        if (!botSettingsListSchema.safeParse(payload).success) {
          throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'Invalid bot settings list request.');
        }
        await this.sendBotSettingsList(session, requestId);
        return;
      }
      const parsed = type === MessageType.BOT_SETTINGS_UPDATE
        ? botSettingsUpdateSchema.safeParse(payload) : botSettingsGetSchema.safeParse(payload);
      if (!parsed.success) throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, 'Invalid bot settings request.');
      const { botId } = parsed.data;
      if (session.isBot && (type !== MessageType.BOT_SETTINGS_GET || botId !== session.botId)) {
        throw new BotSettingsError(ProtocolErrorCode.PERMISSION_DENIED, 'Bots may only read their own settings.');
      }
      const bot = await this.botService.getInfo(botId);
      if (!bot) throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
      const manifestUrls = await this.botManifestUrls(session);
      const handled = await this.withBotSettingsPermission(session, (canConfigure, canManage) => {
        if (type === MessageType.BOT_SETTINGS_UPDATE) {
          if (!canConfigure) throw new BotSettingsError(ProtocolErrorCode.PERMISSION_DENIED, 'You cannot configure bots.');
          const update = botSettingsUpdateSchema.parse(parsed.data);
          const changed = settingsService.update(update);
          if (changed.revision !== update.expectedRevision) {
            this.botLocalExecution.settingsChanged(botId);
            this.botInteractions.settingsChanged(botId);
            // Setting values can hold secrets such as API keys, so only their names are kept.
            this.recordAudit(session, 'bot.settings', {
              target: auditRef.bot(bot.id, bot.name), changes: [{ field: 'settings', after: Object.keys(update.patch) }],
            });
          }
          // Cache updates precede new-revision executions on the owning socket.
          const owner = this.findSessionById(`bot:${botId}`);
          if (owner?.botSettingsReady && this.isCurrentSession(owner)) {
            this.send(owner.ws, { type: MessageType.BOT_SETTINGS_SNAPSHOT,
              payload: settingsService.snapshot(bot, false, true) });
          }
        }
        this.send(session.ws, { type: MessageType.BOT_SETTINGS_SNAPSHOT, requestId,
          payload: this.visibleBotSettings(session, settingsService.snapshot(bot, canConfigure, session.isBot === true, canManage, manifestUrls)) });
      });
      if (handled && type === MessageType.BOT_SETTINGS_UPDATE) await this.broadcastBotSettings(botId);
    } catch (error) {
      this.sendBotSettingsError(session, error, requestId);
    }
  }

  /** Only clients that negotiated `bot-manifest-url` get the URLs; BotSettingsService still requires MANAGE_BOTS. */
  private async botManifestUrls(session: ClientSession): Promise<Map<string, string | null> | undefined> {
    if (session.isBot || !this.botService || !session.protocol?.features.includes('bot-manifest-url')) return undefined;
    return this.botService.manifestUrls();
  }

  private async sendBotSettingsList(session: ClientSession, requestId?: string): Promise<void> {
    if (!this.botSettings || !this.botService || !session.user || session.isBot || !this.isCurrentSession(session)) return;
    const settingsService = this.botSettings;
    const bots = await this.botService.list();
    const manifestUrls = await this.botManifestUrls(session);
    await this.withBotSettingsPermission(session, (canConfigure, canManage) => {
      this.send(session.ws, { type: MessageType.BOT_SETTINGS_LIST_RESPONSE, requestId,
        payload: this.visibleBotSettingsList(session, settingsService.list(bots, canConfigure, canManage, manifestUrls)) });
    });
  }

  /**
   * Tells every connection the bot settings it may see after a change. Each
   * broadcast waits for the previous one: it reads the bots once for everyone,
   * so running two at a time could deliver its older data after newer (BOTS-5).
   */
  private broadcastBotSettings(changedBotId?: string): Promise<void> {
    const broadcast = (this.botSettingsBroadcasts ?? Promise.resolve()).then(() => this.publishBotSettings(changedBotId));
    this.botSettingsBroadcasts = broadcast.catch(() => undefined);
    return broadcast;
  }

  /**
   * The bots and their manifest URLs are read once per broadcast, and each
   * kind of reader (what it may configure and manage, and which features its
   * app speaks) gets its message built and serialized once, instead of once
   * per connection.
   */
  private async publishBotSettings(changedBotId?: string): Promise<void> {
    if (!this.botSettings || !this.botService || this.closing) return;
    const settingsService = this.botSettings;
    const botService = this.botService;
    const bots = await botService.list();
    const changed = changedBotId === undefined ? undefined : bots.find((bot) => bot.id === changedBotId);
    let manifestUrls: Promise<Map<string, string | null>> | undefined;
    const lists = new Map<string, ServerMessage<MessageType.BOT_SETTINGS_LIST_RESPONSE>>();
    const snapshots = new Map<string, ServerMessage<MessageType.BOT_SETTINGS_SNAPSHOT>>();
    const frames: FanOutFrames = new Map();
    for (const session of this.sessions.values()) {
      if (!session.user || !this.isCurrentSession(session)) continue;
      // People get the list, and the changed bot's settings if they may configure or manage bots; a bot only its own.
      const wantsSnapshot = !!changed && (!session.isBot || (session.botId === changed.id && session.botSettingsReady === true));
      if (session.isBot && !wantsSnapshot) continue;
      // Only clients that negotiated `bot-manifest-url` get the URLs; BotSettingsService still requires MANAGE_BOTS.
      const urls = !session.isBot && session.protocol?.features.includes('bot-manifest-url')
        ? await (manifestUrls ??= botService.manifestUrls()) : undefined;
      await this.withBotSettingsPermission(session, (canConfigure, canManage) => {
        const kind = `${canConfigure}:${canManage}:${urls !== undefined}:${this.supportsBotStorage(session)}:${session.isBot === true}`;
        if (!session.isBot) {
          let list = lists.get(kind);
          if (!list) {
            list = { type: MessageType.BOT_SETTINGS_LIST_RESPONSE,
              payload: this.visibleBotSettingsList(session, settingsService.list(bots, canConfigure, canManage, urls)) };
            lists.set(kind, list);
          }
          this.send(session.ws, list, frames);
        }
        if (!changed || !wantsSnapshot || (!canConfigure && !canManage && !session.isBot)) return;
        let snapshot = snapshots.get(kind);
        if (!snapshot) {
          snapshot = { type: MessageType.BOT_SETTINGS_SNAPSHOT, payload: this.visibleBotSettings(session,
            settingsService.snapshot(changed, canConfigure, session.isBot === true, canManage, urls)) };
          snapshots.set(kind, snapshot);
        }
        this.send(session.ws, snapshot, frames);
      });
    }
  }

  /** Peers without `bot-storage` reject the storage capability names in their strict enum. */
  private supportsBotStorage(session: BotInteractionSession): boolean {
    return session.protocol?.features.includes('bot-storage') === true;
  }

  private visibleBotPermissions(session: BotInteractionSession, permissions: BotPermissions): BotPermissions {
    return this.supportsBotStorage(session) ? permissions : withoutBotStoragePermissions(permissions);
  }

  private visibleBotSettings(session: BotInteractionSession, snapshot: BotSettingsSnapshot): BotSettingsSnapshot {
    const { permissions } = snapshot.bot;
    return permissions && !this.supportsBotStorage(session)
      ? { ...snapshot, bot: { ...snapshot.bot, permissions: withoutBotStoragePermissions(permissions) } } : snapshot;
  }

  private visibleBotSettingsList(session: BotInteractionSession, list: BotSettingsListResponse): BotSettingsListResponse {
    if (this.supportsBotStorage(session)) return list;
    return { bots: list.bots.map((bot) => bot.permissions ? { ...bot, permissions: withoutBotStoragePermissions(bot.permissions) } : bot) };
  }

  /** Read-only check for the bot storage views: refusing it answers no error. */
  private async canManageBots(session: ClientSession): Promise<boolean> {
    if (!session.user || session.isBot || !this.isCurrentSession(session)) return false;
    return this.permissionService.checkPermission(session.user.id, Permission.MANAGE_BOTS);
  }

  /**
   * Tells the people who manage bots, also on the bot's miniapps, that its server storage is about to stop
   * accepting saves. Everyone else only sees the storage of their own computer.
   */
  private broadcastBotStorageLevel(botId: string, usage: BotStorageUsage): void {
    this.botStorageLevels = this.botStorageLevels.then(async () => {
      for (const session of [...this.sessions.values()]) {
        if (!session.user || session.isBot || !this.supportsBotStorage(session) || !this.isCurrentSession(session)) continue;
        if (!await this.canManageBots(session) || !this.isCurrentSession(session)) continue;
        this.send(session.ws, { type: MessageType.BOT_STORAGE_LEVEL, payload: { botId, usage } });
      }
    }).catch((error: unknown) => { Logger.error('BOT', 'Could not announce a bot storage level.', error); });
  }

  private sendBotSettingsError(session: ClientSession, error: unknown, requestId?: string): void {
    if (!this.isCurrentSession(session)) return;
    this.sendCaughtError(session.ws, error, { message: 'Bot settings operation failed.', category: 'BOT' }, requestId);
  }

  private async withBotSettingsPermission(session: ClientSession, use: (canConfigure: boolean, canManage: boolean) => void): Promise<boolean> {
    if (!session.user || !this.isCurrentSession(session)) return false;
    if (session.isBot) {
      use(false, false);
      return true;
    }
    while (this.isCurrentSession(session)) {
      const version = this.botSettingsPermissionVersion;
      const [allowed, canManage] = await Promise.all([
        this.permissionService.checkPermission(session.user.id, Permission.CONFIGURE_BOTS),
        this.permissionService.checkPermission(session.user.id, Permission.MANAGE_BOTS),
      ]);
      if (!this.isCurrentSession(session)) return false;
      if (version !== this.botSettingsPermissionVersion) continue;
      // Checking and using the grant share one continuation, without another await.
      use(allowed, canManage);
      return true;
    }
    return false;
  }

  private handleCommandsList(
    session: ClientSession,
    requestId?: string
  ): void {
    if (!session.user) return;
    const listPayload: CommandsListResponsePayload = { commands: this.availableCommands() };
    this.send(session.ws, { type: MessageType.COMMANDS_LIST_RESPONSE, requestId, payload: listPayload });
  }

  private broadcastCommands(): void {
    const payload: CommandsListResponsePayload = { commands: this.availableCommands() };
    this.broadcast({ type: MessageType.COMMANDS_LIST_RESPONSE, payload });
  }

  private availableCommands() {
    return this.commandRegistry.listAll().filter((command) => this.botService?.permissions?.allows(command.botId, 'commands',
      ...(command.localCapabilities?.length ? ['local_execution'] as const : []),
      ...(command.downloadsSound ? ['sound_download'] as const : [])));
  }

  private async buildIceServersFor(userId: string, session: ClientSession) {
    try {
      const server = await this.serverRepo.getServer();
      // In SFU mode the server is already the relay, so handing out TURN
      // credentials would advertise a second one that nothing uses (#515).
      const secret = server?.voiceMode === 'sfu' ? null : server?.turnSecret ?? null;
      return this.coturnManager.buildIceServers(
        userId,
        session.requestHost ?? null,
        secret
      );
    } catch (error) {
      Logger.warn('NETWORK', 'Failed to build the ICE server list; sending STUN only.', error);
      return this.coturnManager.buildIceServers(userId, null, null);
    }
  }

  private async buildLocalIceServersFor(session: BotInteractionSession) {
    const current = this.sessions.get(session.ws);
    if (current !== session || !session.user || !this.isCurrentSession(session)) throw new Error('Local endpoint disconnected.');
    const server = await this.serverRepo.getServer();
    if (!server || !this.isCurrentSession(session)) throw new Error('Local ICE authorization unavailable.');
    // Use the same authorized ICE builder, but never convert an authorization/I/O failure into a successful fallback.
    const secret = server.voiceMode === 'sfu' || !server.turnEnabled ? null : server.turnSecret ?? null;
    return this.coturnManager.buildIceServers(session.user.id, current.requestHost ?? null, secret);
  }

  private async authorizeLocalVoice(
    origin: BotInteractionSession, bot: BotInteractionSession, channelId: string,
  ): Promise<boolean> {
    const currentBot = this.sessions.get(bot.ws);
    if (!origin.user || !bot.user || origin.isBot || !bot.isBot || currentBot !== bot) return false;
    const [channel, callerAccess, botAccess] = await Promise.all([
      this.channelService.getChannelSummary(channelId),
      this.channelService.getAccessContext(origin.user.id),
      this.channelService.getAccessContext(bot.user.id),
    ]);
    return this.isCurrentSession(origin) && this.isCurrentBotOperation(bot, 'local_execution', 'publish_voice') &&
      channel?.type === 'VOICE' && hasChannelPermission(channel, callerAccess.permissions, callerAccess.roleIds, Permission.SPEAK, false, callerAccess.userId) &&
      hasPermission(botAccess.permissions, Permission.SPEAK) &&
      (hasChannelPermission(channel, botAccess.permissions, botAccess.roleIds, Permission.SPEAK, true) &&
        canAccessChannel(channel, botAccess.permissions, botAccess.roleIds, true) || this.hasBotVoiceGrant(currentBot, channelId));
  }

  private async mutateLocalAccess<T>(mutation: () => Promise<T>): Promise<T> {
    this.localAccessVersion++;
    this.pendingLocalAccessMutations++;
    try {
      return await mutation();
    } finally {
      this.pendingLocalAccessMutations--;
      this.localAccessVersion++;
    }
  }

  public getChannelAccessVersion(): number | null {
    return this.pendingLocalAccessMutations > 0 ? null : this.localAccessVersion + this.botSettingsPermissionVersion;
  }

  /**
   * Captures the channel and role access versions. The answer is true while
   * neither moved since, nor was in the middle of a change at either end.
   */
  private captureAccess(): () => boolean {
    const channels = this.getChannelAccessVersion();
    const roles = this.permissionService.getRoleAccessVersion();
    return () => channels !== null && roles !== null &&
      channels === this.getChannelAccessVersion() && roles === this.permissionService.getRoleAccessVersion();
  }

  private captureChannelOperation(session: ClientSession): () => boolean {
    const unchanged = this.captureAccess();
    return () => unchanged() && this.isCurrentSession(session);
  }

  private async handleChatSend(
    session: ClientSession,
    payload: ChatSendPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;
    const canSend = this.captureChannelOperation(session);

    const bot = session.isBot && session.botId ? await this.botService?.findById(session.botId) : undefined;
    if (payload.clientMessageId !== undefined && (session.isBot || !session.protocol?.features.includes('chat-delivery'))) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Confirmação de envio exige um cliente compatível atualizado.', requestId);
      return;
    }
    if (payload.blocks !== undefined && (bot || !session.protocol?.features.includes('chat-blocks'))) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Blocos de mensagem exigem um cliente compatível atualizado.', requestId);
      return;
    }
    if (session.isBot && (!bot || !this.isCurrentSession(session))) {
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Bot indisponível.', requestId);
      return;
    }
    if (bot && payload.attachmentIds?.length) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bots devem enviar mensagens de texto.', requestId);
      return;
    }
    if (!bot && payload.localizations !== undefined) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Somente bots podem fornecer traduções de mensagens.', requestId);
      return;
    }
    const result = bot
      ? await this.chatService.sendBotMessage(bot, payload.channelId, payload.content, undefined, undefined, canSend, bot.id, payload.replyToMessageId, payload.localizations)
      : await this.chatService.sendMessage(
      session.user.id,
      payload.channelId,
      payload.content,
      payload.attachmentIds,
      payload.replyToMessageId,
      payload.blocks,
      payload.clientMessageId,
      canSend,
      // Peers without message-forward never asked for the badge; their field is ignored.
      session.protocol?.features.includes('message-forward') ? payload.forward : undefined,
    );
    if (!result.success) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao enviar mensagem',
        requestId
      );
      return;
    }
    if (!result.message) {
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, 'Mensagem não foi persistida.', requestId);
      return;
    }

    // Writers (including approved bots) may lack history access, but still need their own acknowledgement.
    if (this.isCurrentSession(session)) this.send(session.ws, { type: MessageType.CHAT_MESSAGE, requestId, payload: result.message });
    if ('replayed' in result && result.replayed) return;
    // Broadcast message to everyone allowed into this channel (#384).
    await this.broadcastToChannel(result.message.channelId, {
      type: MessageType.CHAT_MESSAGE,
      requestId,
      payload: result.message,
    }, session.ws);
  }

  private async handlePollCreate(
    session: ClientSession,
    payload: NativePollCreate,
    requestId?: string,
  ): Promise<void> {
    if (!this.pollService || !session.user || session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Native polls unavailable.', requestId);
      return;
    }
    const parsed = nativePollCreateSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid poll.', requestId);
      return;
    }
    if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId, parsed.data.channelId)) ||
        !(await this.requirePermission(session, Permission.READ_MESSAGES, requestId, parsed.data.channelId)) ||
        !(await this.requireChannelAccess(session, parsed.data.channelId, requestId))) return;
    const channel = await this.channelService.getChannelSummary(parsed.data.channelId);
    if (!channel || channel.forumId || (channel.type !== 'TEXT' && channel.type !== 'VOICE')) {
      this.sendError(session.ws, ProtocolErrorCode.CHANNEL_NOT_FOUND, 'Polls require a message channel.', requestId);
      return;
    }
    if (parsed.data.liveAction &&
        !(await this.requirePermission(session, Permission.EMIT_LIVE_ACTIONS, requestId, parsed.data.channelId))) return;
    if (parsed.data.liveAction && this.communityService && !this.communityService.settings().eventsEnabled) {
      this.sendError(session.ws, ProtocolErrorCode.COMMUNITY_INVALID, 'Live actions are disabled.', requestId);
      return;
    }
    try {
      const result = this.pollService.create(session.user.id, parsed.data);
      const [message] = await this.chatService.loadHistory(
        parsed.data.channelId, 1, undefined, result.poll.messageId, session.user.id,
      );
      if (!message) throw new NativePollError('Poll message was not persisted.', ProtocolErrorCode.INTERNAL_ERROR);
      if (!result.created) {
        this.send(session.ws, { type: MessageType.CHAT_MESSAGE, requestId, payload: message });
        return;
      }
      await this.broadcastToChannel(message.channelId, {
        type: MessageType.CHAT_MESSAGE,
        requestId,
        payload: message,
      });
      if (result.poll.liveAction) {
        await this.auditPoll(session, 'poll.create', undefined, result.poll);
        await this.community?.refresh();
      }
    } catch (error: unknown) {
      this.sendCaughtError(session.ws, error, { message: 'Could not create poll.', category: 'NETWORK' }, requestId);
    }
  }

  /** Polls run as live actions are always recorded; ordinary polls only when someone else's is changed. */
  private async auditPoll(
    session: ClientSession, action: 'poll.create' | 'poll.edit' | 'poll.close', before: NativePollRecord | undefined, after: NativePollRecord,
  ): Promise<void> {
    if (!this.audit || !session.user) return;
    this.recordAudit(session, action, {
      target: auditRef.of('poll', after.id, after.question),
      related: {
        channel: await this.auditChannel(after.channelId),
        author: after.creatorUserId !== session.user.id ? await this.auditIdentity(after.creatorUserId) : null,
      },
      changes: action === 'poll.close' ? [] : pollChanges(before, after),
    });
  }

  private async handlePollVote(
    session: ClientSession,
    payload: NativePollVote,
    requestId?: string,
  ): Promise<void> {
    if (!this.pollService || !session.user || session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Native polls unavailable.', requestId);
      return;
    }

    const parsed = nativePollVoteSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid vote.', requestId);
      return;
    }
    try {
      const existing = this.pollService.get(parsed.data.id);
      if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId, existing.channelId)) ||
          !(await this.requireChannelAccess(session, existing.channelId, requestId))) return;
      if (!await this.pollService.canView(session.user.id, existing)) {
        throw new NativePollError('Poll not found.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      const updated = this.pollService.vote(session.user.id, parsed.data.id, parsed.data.optionIds);
      const personalized = await this.pollService.publicPollForUser(updated, session.user.id);
      this.send(session.ws, { type: MessageType.POLL_UPDATED, requestId, payload: personalized });
      await this.broadcastToChannel(updated.channelId, {
        type: MessageType.POLL_UPDATED,
        payload: this.pollService.publicPoll(updated),
      });
      if (updated.liveAction) await this.community?.refresh();
    } catch (error: unknown) {
      this.sendCaughtError(session.ws, error, { message: 'Could not record vote.', category: 'NETWORK' }, requestId);
    }
  }

  private async handlePollClose(
    session: ClientSession,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    if (!this.pollService || !session.user || session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Native polls unavailable.', requestId);
      return;
    }
    const parsed = nativePollIdSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid poll.', requestId);
      return;
    }
    try {
      const existing = this.pollService.get(parsed.data.id);
      if (!(await this.requireChannelAccess(session, existing.channelId, requestId))) return;
      if (!await this.pollService.canView(session.user.id, existing)) {
        throw new NativePollError('Poll not found.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      const canManage = existing.creatorUserId === session.user.id ||
        await this.permissionService.checkPermission(session.user.id, Permission.MANAGE_SERVER) ||
        (await this.permissionService.isSelectedAudienceMember(session.user.id, existing.audience) &&
          await this.channelService.canUserAccessChannel(session.user.id, existing.channelId, Permission.EMIT_LIVE_ACTIONS));
      if (!canManage) {
        this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Poll unavailable.', requestId);
        return;
      }
      const closed = this.pollService.close(existing.id);
      const personalized = await this.pollService.publicPollForUser(closed, session.user.id);
      this.send(session.ws, { type: MessageType.POLL_UPDATED, requestId, payload: personalized });
      await this.broadcastToChannel(closed.channelId, {
        type: MessageType.POLL_UPDATED,
        payload: this.pollService.publicPoll(closed),
      });
      if (existing.liveAction || existing.creatorUserId !== session.user.id) {
        await this.auditPoll(session, 'poll.close', existing, closed);
      }
      if (existing.liveAction) await this.community?.refresh();
    } catch (error: unknown) {
      this.sendCaughtError(session.ws, error, { message: 'Could not close poll.', category: 'NETWORK' }, requestId);
    }
  }

  private async handlePollVoters(
    session: ClientSession,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    if (!this.pollService || !session.user || session.isBot || !session.protocol?.features.includes('poll-voters')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Poll voters unavailable.', requestId);
      return;
    }
    const parsed = nativePollIdSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid poll.', requestId);
      return;
    }
    try {
      const poll = this.pollService.get(parsed.data.id);
      if (!(await this.requirePermission(session, Permission.READ_MESSAGES, requestId, poll.channelId)) ||
          !(await this.requireChannelAccess(session, poll.channelId, requestId))) return;
      if (!await this.pollService.canView(session.user.id, poll)) {
        throw new NativePollError('Poll not found.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      this.send(session.ws, {
        type: MessageType.POLL_VOTERS_RESULT,
        requestId,
        payload: this.pollService.voters(poll),
      });
    } catch (error: unknown) {
      this.sendCaughtError(session.ws, error, { message: 'Could not load poll voters.', category: 'NETWORK' }, requestId);
    }
  }

  /** The creator and server managers may change an open poll. */
  private async handlePollEdit(
    session: ClientSession,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    if (!this.pollService || !session.user || session.isBot || !session.protocol?.features.includes('poll-edit')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Poll editing unavailable.', requestId);
      return;
    }
    const parsed = nativePollEditSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid poll.', requestId);
      return;
    }
    try {
      const existing = this.pollService.get(parsed.data.id);
      if (!(await this.requireChannelAccess(session, existing.channelId, requestId))) return;
      if (!await this.pollService.canView(session.user.id, existing)) {
        throw new NativePollError('Poll not found.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      if (existing.creatorUserId !== session.user.id &&
          !await this.permissionService.checkPermission(session.user.id, Permission.MANAGE_SERVER)) {
        this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Poll unavailable.', requestId);
        return;
      }
      if (parsed.data.liveAction && !existing.liveAction) {
        if (!(await this.requirePermission(session, Permission.EMIT_LIVE_ACTIONS, requestId, existing.channelId))) return;
        if (this.communityService && !this.communityService.settings().eventsEnabled) {
          this.sendError(session.ws, ProtocolErrorCode.COMMUNITY_INVALID, 'Live actions are disabled.', requestId);
          return;
        }
      }
      const updated = this.pollService.edit(session.user.id, parsed.data);
      const personalized = await this.pollService.publicPollForUser(updated, session.user.id);
      this.send(session.ws, { type: MessageType.POLL_UPDATED, requestId, payload: personalized });
      await this.broadcastToChannel(updated.channelId, {
        type: MessageType.POLL_UPDATED,
        payload: this.pollService.publicPoll(updated),
      });
      if (existing.liveAction || updated.liveAction || existing.creatorUserId !== session.user.id) {
        await this.auditPoll(session, 'poll.edit', existing, updated);
      }
      if (existing.liveAction || updated.liveAction) await this.community?.refresh();
    } catch (error: unknown) {
      this.sendCaughtError(session.ws, error, { message: 'Could not edit poll.', category: 'NETWORK' }, requestId);
    }
  }

  /** Broadcast polls carry no personal vote or revealed audience; an editor starts from its own view. */
  private async handlePollGet(
    session: ClientSession,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    if (!this.pollService || !session.user || session.isBot || !session.protocol?.features.includes('poll-edit')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Poll editing unavailable.', requestId);
      return;
    }
    const parsed = nativePollIdSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid poll.', requestId);
      return;
    }
    try {
      const poll = this.pollService.get(parsed.data.id);
      if (!(await this.requirePermission(session, Permission.READ_MESSAGES, requestId, poll.channelId)) ||
          !(await this.requireChannelAccess(session, poll.channelId, requestId))) return;
      if (!await this.pollService.canView(session.user.id, poll)) {
        throw new NativePollError('Poll not found.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      this.send(session.ws, {
        type: MessageType.POLL_UPDATED,
        requestId,
        payload: await this.pollService.publicPollForUser(poll, session.user.id),
      });
    } catch (error: unknown) {
      this.sendCaughtError(session.ws, error, { message: 'Could not load poll.', category: 'NETWORK' }, requestId);
    }
  }

  private async publishBotResponse(
    session: BotInteractionSession,
    response: BotCommandMessagePayload,
    canSend: () => boolean,
    requestId?: string
  ): Promise<void> {
    const bot = session.botId ? await this.botService?.findById(session.botId) : null;
    if (!bot || !canSend() || !this.isCurrentSession(session)) return;
    const result = await this.chatService.sendBotMessage(bot, response.channelId, response.content, {
      invocationId: response.invocationId, commandName: response.commandName,
      invokerId: response.invokerId, invokerNickname: response.invokerNickname,
      invokerAvatarUrl: response.invokerAvatarUrl,
    }, response.messageId, () => canSend() && this.isCurrentSession(session), response.invokerId, undefined, response.localizations);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    // Keep the existing live event to avoid duplicate client rows; history
    // returns the same persisted ID and the same authenticated attribution.
    await this.broadcastToChannel(response.channelId, {
      type: MessageType.COMMAND_RESPONSE,
      payload: { ...response, createdAt: result.message.createdAt },
    }, undefined, canSend);
  }

  private async handleChatEdit(
    session: ClientSession,
    payload: ChatEditPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;
    if (!payload?.messageId || !payload?.channelId) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem inválida', requestId);
      return;
    }

    const result = await this.chatService.editMessage(
      session.user.id,
      payload.channelId,
      payload.messageId,
      payload.content,
      this.captureChannelOperation(session),
    );
    if (!result.success || !result.message) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao editar mensagem',
        requestId
      );
      return;
    }

    await this.broadcastChatMessageUpdated(result.message, requestId);
  }

  private async handleChatDelete(
    session: ClientSession,
    payload: ChatDeletePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;
    if (!payload?.messageId || !payload?.channelId) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem inválida', requestId);
      return;
    }

    // Moderators clean up after anyone; everybody else only after themselves.
    const canModerate = await this.permissionService.checkPermission(session.user.id, Permission.MANAGE_SERVER);

    const result = await this.chatService.deleteMessage(
      session.user.id,
      payload.channelId,
      payload.messageId,
      canModerate
    );
    if (!result.success || !result.message) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao apagar mensagem',
        requestId
      );
      return;
    }

    await this.broadcastChatMessageUpdated(result.message, requestId);
    if (this.audit && result.message.userId !== session.user.id) {
      this.recordAudit(session, 'message.delete', {
        target: auditRef.member({ id: result.message.userId, nickname: result.message.userNickname, isBot: result.message.isBot }),
        related: { channel: await this.auditChannel(result.message.channelId) },
      });
    }
    const poll = this.pollService?.repository.findByMessageId(payload.messageId);
    if (poll) {
      await this.broadcastToChannel(poll.channelId, {
        type: MessageType.POLL_UPDATED,
        payload: this.pollService!.publicPoll(poll),
      });
      await this.community?.refresh();
    }
  }

  /** Sends the new state of an edited/deleted message to the channel (#504). */
  private async handleChatRestore(session: ClientSession, payload: ChatRestorePayload, requestId?: string): Promise<void> {
    if (!session.user || !payload) return;
    const canModerate = await this.permissionService.checkPermission(session.user.id, Permission.MANAGE_SERVER);
    if (!this.isCurrentSession(session)) return;
    const result = await this.chatService.restoreMessage(session.user.id, payload.channelId, payload.messageId,
      payload.deletedAt, payload.revision, canModerate);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    await this.broadcastChatMessageUpdated(result.message, requestId);
    if (this.audit && result.message.userId !== session.user.id) {
      this.recordAudit(session, 'message.restore', {
        target: auditRef.member({ id: result.message.userId, nickname: result.message.userNickname, isBot: result.message.isBot }),
        related: { channel: await this.auditChannel(result.message.channelId) },
      });
    }
  }

  private async broadcastChatMessageUpdated(message: ChatMessage, requestId?: string): Promise<void> {
    // The message was loaded for the actor: its poll must not carry their vote or revealed audience to everyone.
    const polls = this.pollService;
    const poll = message.poll && polls ? polls.repository.findById(message.poll.id) : undefined;
    const updatedPayload: ChatMessageUpdatedPayload = {
      message: poll && polls ? { ...message, poll: polls.publicPoll(poll) } : message,
    };
    await this.broadcastToChannel(message.channelId, {
      type: MessageType.CHAT_MESSAGE_UPDATED,
      requestId,
      payload: updatedPayload,
    });
  }

  private async handleChatLoadHistory(
    session: ClientSession,
    payload: ChatLoadHistoryPayload,
    requestId?: string
  ): Promise<void> {
    const parsed = chatHistoryRequestSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Histórico inválido.', requestId);
      return;
    }
    const messages = await this.chatService.loadHistory(
      parsed.data.channelId,
      parsed.data.limit || LIMITS.MAX_HISTORY_MESSAGES_INITIAL,
      parsed.data.beforeTimestamp,
      parsed.data.aroundMessageId,
      session.user?.id,
    );

    const historyPayload: ChatHistoryPayload = {
      aroundMessageId: parsed.data.aroundMessageId,
      channelId: payload.channelId,
      messages,
    };

    if (!(await this.requirePermission(session, Permission.READ_MESSAGES, requestId, parsed.data.channelId))) return;
    this.send(session.ws, {
      type: MessageType.CHAT_HISTORY,
      requestId,
      payload: historyPayload,
    });
  }

  private async handleChatMentionsRead(
    session: ClientSession,
    payload: ChatMentionsReadPayload
  ): Promise<void> {
    if (!session.user) return;
    await this.chatService.markMentionsRead(session.user.id, payload.channelId);
  }

  private handleRequestUploadToken(
    session: ClientSession,
    payload: ChatRequestUploadTokenPayload,
    requestId?: string
  ): void {
    if (!session.user) return;
    const issued = this.attachmentService.issueUploadToken(session.user.id, payload.channelId);
    if (!issued) {
      this.sendError(
        session.ws,
        ProtocolErrorCode.RATE_LIMITED,
        'Muitos envios em pouco tempo. Aguarde alguns segundos.',
        requestId
      );
      return;
    }
    const tokenPayload: ChatUploadTokenPayload = { token: issued.token, expiresAt: issued.expiresAt };
    this.send(session.ws, {
      type: MessageType.CHAT_UPLOAD_TOKEN,
      requestId,
      payload: tokenPayload,
    });
  }

  private async handleChannelCreate(
    session: ClientSession,
    payload: ChannelCreatePayload,
    requestId?: string
  ): Promise<void> {
    const result = await this.channelService.createChannel(payload);
    if (!result.success || !result.channel) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao criar canal',
        requestId
      );
      return;
    }

    const channelPayload: ChannelCreatedPayload = { channel: result.channel };
    // The author gets the correlated reply first — the client awaits it by
    // requestId — and is marked as already knowing the channel so the
    // reconciliation below does not send it twice. Everyone else allowed in
    // learns about it through that same reconciliation (#384).
    this.send(session.ws, {
      type: MessageType.CHANNEL_CREATED,
      requestId,
      payload: channelPayload,
    });
    session.visibleChannelIds?.add(result.channel.id);
    if (this.audit) {
      this.recordAudit(session, 'channel.create', {
        target: auditRef.channel(result.channel),
        changes: channelCreationChanges(result.channel, await this.auditNames()),
      });
    }

    await this.reconcileChannelVisibility();
    await this.broadcastBotSettings();
  }

  private async handleCategoryMutation(
    session: ClientSession,
    operation: 'create' | 'update' | 'delete' | 'reorder',
    payload: CategoryCreatePayload | CategoryUpdatePayload | CategoryDeletePayload | CategoryReorderPayload,
    requestId?: string,
  ): Promise<void> {
    const before = this.audit ? await this.channelTreeSnapshot() : undefined;
    const result = await this.mutateLocalAccess(() => this.channelService.mutateCategory(operation, payload, session.user?.id));
    if (!result.success) {
      this.sendError(session.ws, result.errorCode ?? ProtocolErrorCode.BAD_REQUEST, result.errorMessage ?? 'Categoria inválida', requestId);
      return;
    }
    if (before) await this.auditCategoryMutation(session, operation, payload, before);
    await this.reconcileChannelVisibility(true);
    if (!session.user || !this.isCurrentSession(session)) return;
    const canDeliver = this.captureChannelOperation(session);
    const [categories, channels, context] = await Promise.all([
      this.channelService.listCategories(), this.channelService.listChannels(),
      this.channelService.getAccessContext(session.user.id),
    ]);
    if (!canDeliver()) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Access changed.', requestId);
      return;
    }
    const visibleCategories = categories.filter(category =>
      canAccessChannel(category, context.permissions, context.roleIds, context.isBot, context.userId) ||
      channels.some(channel => channel.categoryId === category.id &&
        canAccessChannel(this.channelService.rulesFor(channel, context), context.permissions, context.roleIds, context.isBot, context.userId)));
    // The author always gets the answer it awaits; later lists are compared with it.
    session.categoriesKey = JSON.stringify(visibleCategories);
    this.send(session.ws, {
      type: MessageType.CATEGORIES_UPDATED,
      requestId,
      payload: { categories: visibleCategories },
    });
  }

  private async auditCategoryMutation(
    session: ClientSession,
    operation: 'create' | 'update' | 'delete' | 'reorder',
    payload: CategoryCreatePayload | CategoryUpdatePayload | CategoryDeletePayload | CategoryReorderPayload,
    before: { channels: ChannelSummary[]; categories: ChannelCategory[] },
  ): Promise<void> {
    const after = await this.channelTreeSnapshot();
    if (operation === 'reorder') {
      this.recordTreeMoves(session, before, after);
      return;
    }
    const known = new Set(before.categories.map((category) => category.id));
    const id = operation === 'create'
      ? after.categories.filter((category) => !known.has(category.id)).at(-1)?.id
      : 'categoryId' in payload ? payload.categoryId : undefined;
    const previous = before.categories.find((category) => category.id === id);
    const next = after.categories.find((category) => category.id === id);
    if (operation === 'delete') {
      if (previous) this.recordAudit(session, 'category.delete', { target: auditRef.category(previous) });
      return;
    }
    if (!next) return;
    if (operation === 'create') {
      this.recordAudit(session, 'category.create', {
        target: auditRef.category(next), changes: next.isPrivate ? [{ field: 'private', after: true }] : [],
      });
      return;
    }
    if (!previous) return;
    const changes = categoryChanges(previous, next, await this.auditNames(previous, next));
    if (changes.length) this.recordAudit(session, 'category.update', { target: auditRef.category(next), changes });
  }

  private async handleChannelUpdate(
    session: ClientSession,
    payload: ChannelUpdatePayload,
    requestId?: string
  ): Promise<void> {
    const before = payload?.channelId ? await this.channelService.getChannelSummary(payload.channelId) : null;
    if (payload?.categoryId !== undefined) {
      if (before && payload.categoryId !== (before.categoryId ?? null)) {
        if (payload.categoryId
          ? !(await this.requireCategoryManagement(session, payload.categoryId, requestId))
          : !(await this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
      }
    }
    const result = await this.mutateLocalAccess(() => this.channelService.updateChannel(payload));
    if (!result.success || !result.channel) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao atualizar canal',
        requestId
      );
      return;
    }

    const channel = result.channel;
    if (this.audit && before) {
      const changes = channelChanges(before, channel, await this.auditNames(before, channel));
      if (changes.length) this.recordAudit(session, 'channel.update', { target: auditRef.channel(channel), changes });
    }
    const updatedPayload: ChannelUpdatedPayload = { channel };
    this.send(session.ws, {
      type: MessageType.CHANNEL_UPDATED,
      requestId,
      payload: updatedPayload,
    });
    await this.publishChannelUpdate(channel, session.ws);
  }

  /**
   * CHANNEL_UPDATED only makes sense for clients that already have the channel
   * and keep access to it. Those who just gained or lost it are served by the
   * reconciliation, which sends them a CREATED or a DELETED instead (#384).
   */
  private async publishChannelUpdate(channel: ChannelSummary, skip?: WebSocket): Promise<void> {
    const message: ServerMessage<MessageType.CHANNEL_UPDATED> = { type: MessageType.CHANNEL_UPDATED, payload: { channel } };
    const audience = await this.resolveChannelAudience(channel);
    this.publish((peer) => peer.visibleChannelIds?.has(channel.id) && audience.has(peer.user.id) ? message : undefined, skip);

    await this.reconcileChannelVisibility();
  }

  /**
   * Applies a new channel order and tells everyone (#471).
   *
   * Each recipient only gets the positions of the channels they can already
   * see: sending the whole list would leak the existence of private channels
   * they have no access to.
   */
  private async handleChannelReorder(
    session: ClientSession,
    payload: ChannelReorderPayload,
    requestId?: string
  ): Promise<void> {
    const before = this.audit ? await this.channelTreeSnapshot() : undefined;
    const result = await this.channelService.reorderChannels(payload, session.user?.id);
    if (!result.success || !result.positions) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao reordenar canais',
        requestId
      );
      return;
    }
    if (before) this.recordTreeMoves(session, before, await this.channelTreeSnapshot());
    // Categories share the root with loose channels: when they move, everyone
    // receives their new positions before the channel positions land.
    if (result.categoriesChanged) await this.reconcileChannelVisibility();

    const positions = result.positions;
    const visibleTo = (peer: ClientSession) =>
      positions.filter((p) => peer.visibleChannelIds?.has(p.channelId));

    this.send(session.ws, {
      type: MessageType.CHANNELS_REORDERED,
      requestId,
      payload: { positions: visibleTo(session) } satisfies ChannelsReorderedPayload,
    });

    this.publish((peer) => {
      const mine = visibleTo(peer);
      return mine.length === 0 ? undefined : {
        type: MessageType.CHANNELS_REORDERED,
        payload: { positions: mine } satisfies ChannelsReorderedPayload,
      };
    }, session.ws);
  }

  private async handleChannelDelete(
    session: ClientSession,
    payload: ChannelDeletePayload,
    requestId?: string
  ): Promise<void> {
    const cleanupCommunityMedia = this.communityService?.prepareChannelDeletion(payload.channelId);
    const deleted = this.audit ? await this.channelService.getChannelSummary(payload.channelId) : null;
    const result = await this.mutateLocalAccess(() => this.channelService.deleteChannel(payload.channelId));
    if (!result.success) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.CHANNEL_NOT_FOUND,
        result.errorMessage || 'Erro ao deletar canal',
        requestId
      );
      return;
    }
    cleanupCommunityMedia?.();
    if (deleted) this.recordAudit(session, 'channel.delete', { target: auditRef.channel(deleted) });
    this.releaseDeletedChannel(payload.channelId);

    const channelPayload: ChannelDeletedPayload = { channelId: payload.channelId };
    this.send(session.ws, {
      type: MessageType.CHANNEL_DELETED,
      requestId,
      payload: channelPayload,
    });
    session.visibleChannelIds?.delete(payload.channelId);

    // Everyone else who could see it is told by the reconciliation, which no
    // longer finds the channel and therefore removes it from their list (#384).
    await this.reconcileChannelVisibility();
  }

  /** What a removed channel leaves behind: bot state tied to it, anyone still in its voice room and its SFU router. */
  private releaseDeletedChannel(channelId: string): void {
    this.botLocalExecution.deleteChannel(channelId);
    this.botInteractions.deleteChannel(channelId);

    // If it was a voice channel, disconnect any participants still in it so they
    // are not stranded in a "ghost" channel after it has been removed.
    for (const participant of this.signalingService.getParticipantsInChannel(channelId)) {
      this.voiceSessions.endVoiceSession(participant.sessionId);
    }
    // Nothing else would ever close the room's router: the channel is gone.
    if (this.sfuManager) this.sfuSignaling.notifyProducersClosed(channelId, this.sfuManager.closeChannel(channelId).closedProducerIds);
  }

  private async handleUserChangeNickname(
    session: ClientSession,
    payload: UserChangeNicknamePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;

    const previousNickname = session.user.nickname;
    const result = await this.userService.changeNickname(session.user.id, payload.newNickname);
    if (!result.success || !result.updatedUser) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.NICKNAME_INVALID,
        result.errorMessage || 'Erro ao alterar nickname',
        requestId
      );
      return;
    }

    if (previousNickname !== result.updatedUser.nickname) {
      this.recordAudit(session, 'member.nickname', {
        changes: [{ field: 'nickname', before: previousNickname, after: result.updatedUser.nickname }],
      });
    }
    this.applyUserUpdate(result.updatedUser);
    this.broadcastUserUpdate(session.user, requestId);
  }

  private async handleUserUpdateAvatar(
    session: ClientSession,
    payload: UserUpdateAvatarPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;

    const result = await this.userService.updateAvatar(session.user.id, payload.avatarBase64);
    if (!result.success || !result.updatedUser) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.AVATAR_INVALID_TYPE,
        result.errorMessage || 'Erro ao atualizar avatar',
        requestId
      );
      return;
    }

    this.applyUserUpdate(result.updatedUser);
    this.broadcastUserUpdate(session.user, requestId);
  }

  /**
   * Drops the game for peers that did not negotiate `game-activity` (#675).
   * Older clients would ignore the field anyway, but the icon is up to 32 KB
   * per update and nothing on their side would ever show it.
   */
  private userForRecipient(recipient: ClientSession, user: UserSummary): UserSummary {
    const features = recipient.protocol?.features;
    let shared = user;
    if (shared.activity !== undefined && !features?.includes('game-activity')) shared = { ...shared, activity: undefined };
    // Peers without user-brb keep seeing a plain online person.
    if (shared.brb !== undefined && !features?.includes('user-brb')) shared = { ...shared, brb: undefined };
    if (shared.customStatus !== undefined && !features?.includes('custom-status')) shared = { ...shared, customStatus: undefined };
    return shared;
  }

  /** Presence updates must not masquerade as a physical disconnect from voice. */
  private broadcastUserUpdate(user: UserSummary, requestId?: string): void {
    const invisible = this.getSessionsOfUser(user.id).some((session) => session.invisible);
    const publicUser: UserSummary = {
      ...user,
      invisible: undefined,
      // Hiding has to hide the game too, or "aparecer offline" leaks what the
      // person is doing while claiming they are offline (#675).
      ...(invisible
        ? { status: 'DISCONNECTED', sessionId: undefined, connectedAt: undefined, activity: undefined, brb: undefined, customStatus: undefined }
        : {}),
    };
    const messages = new Map<UserSummary, ServerMessage<MessageType.USER_UPDATED>>();
    this.publish((recipient) => {
      const shown = recipient.user.id === user.id ? recipient.user : this.userForRecipient(recipient, publicUser);
      let message = messages.get(shown);
      if (!message) {
        message = { type: MessageType.USER_UPDATED, requestId, payload: { user: shown } };
        messages.set(shown, message);
      }
      return message;
    });
  }

  private handleUserUpdateVisibility(
    session: ClientSession,
    payload: UserUpdateVisibilityPayload,
    requestId?: string
  ): void {
    if (!session.user || !session.sessionId) return;
    if (session.isBot || !payload || typeof payload.appearOffline !== 'boolean') {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Visibilidade inválida.', requestId);
      return;
    }
    const nowInvisible = payload.appearOffline;
    const userSessions = this.getSessionsOfUser(session.user.id);
    const changed = userSessions.some((other) => !!other.invisible !== nowInvisible);

    // Propagate to all sessions of the same user so multi-device is consistent.
    for (const s of userSessions) {
      s.invisible = nowInvisible;
      if (s.user) s.user.invisible = nowInvisible;
    }

    this.broadcastUserUpdate(session.user, requestId);
    if (changed && !nowInvisible) {
      // Tell everyone else the user joined (for each device session).
      for (const s of userSessions) {
        if (!s.user) continue;
        // Same delivery rules as broadcast(), but the game is per recipient.
        const user: UserSummary = { ...s.user, invisible: undefined };
        this.publish((recipient) => ({
          type: MessageType.USER_JOINED,
          payload: { user: this.userForRecipient(recipient, user) } satisfies UserJoinedPayload,
        }), s.ws);
      }
    }

    Logger.info('NETWORK', `User ${session.user.nickname} is now ${nowInvisible ? 'invisible' : 'visible'}.`);
  }

  /**
   * Publishes what this person is playing, or clears it (#675).
   *
   * Clearing matters as much as setting: when the settings toggle goes off the
   * client sends `null`, and without that the last game would stay frozen on
   * everyone else's card forever.
   */
  private handleUserUpdateActivity(
    session: ClientSession,
    payload: UserUpdateActivityPayload,
    requestId?: string
  ): void {
    if (!session.user) return;
    if (session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED,
        'Bots não publicam atividade de jogo.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('game-activity')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Mostrar o jogo exige um cliente e servidor atualizados.', requestId);
      return;
    }
    const parsed = userUpdateActivitySchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Atividade inválida.', requestId);
      return;
    }

    const { activity } = parsed.data;
    // Applied to every device of this person: otherwise a later broadcast from
    // another session (a nickname change, say) would carry a stale activity.
    for (const target of this.getSessionsOfUser(session.user.id)) {
      if (target.user) target.user = { ...target.user, activity };
    }
    this.broadcastUserUpdate(session.user, requestId);
  }

  /** "Volto já" on or off (user-brb), for every device of the person at once. */
  private handleUserUpdateBrb(session: ClientSession, payload: unknown, requestId?: string): void {
    if (!session.user) return;
    if (session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots não usam o status Volto já.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('user-brb')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'O status Volto já exige um cliente e servidor atualizados.', requestId);
      return;
    }
    const parsed = userUpdateBrbSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Status inválido.', requestId);
      return;
    }
    this.applyBrb(session, parsed.data.brb, requestId);
  }

  private applyBrb(session: ClientSession, brb: boolean, requestId?: string): void {
    if (!session.user) return;
    // Every device carries it, or a later broadcast from another one (a
    // nickname change, say) would bring back a stale status.
    for (const target of this.getSessionsOfUser(session.user.id)) {
      // "Volto já" replaces a custom status: the person picked one of the two.
      if (target.user) target.user = { ...target.user, brb: brb || undefined, ...(brb ? { customStatus: undefined } : {}) };
    }
    this.broadcastUserUpdate(session.user, requestId);
  }

  /** The person's own status (custom-status), for every device at once; null clears it. */
  private handleUserUpdateCustomStatus(session: ClientSession, payload: unknown, requestId?: string): void {
    if (!session.user) return;
    if (session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots não usam status personalizado.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('custom-status')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'O status personalizado exige um cliente e servidor atualizados.', requestId);
      return;
    }
    const parsed = userUpdateCustomStatusSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Status personalizado inválido.', requestId);
      return;
    }
    this.applyCustomStatus(session, parsed.data.customStatus, requestId);
  }

  private applyCustomStatus(session: ClientSession, customStatus: CustomStatus | null, requestId?: string): void {
    if (!session.user) return;
    for (const target of this.getSessionsOfUser(session.user.id)) {
      if (target.user) {
        target.user = { ...target.user, customStatus: customStatus ?? undefined, ...(customStatus ? { brb: undefined } : {}) };
      }
    }
    this.broadcastUserUpdate(session.user, requestId);
  }

  private async handleServerUpdateSettings(
    session: ClientSession,
    payload: ServerUpdateSettingsPayload,
    requestId?: string
  ): Promise<void> {
    if (payload.messageDeleteUndoSeconds !== undefined && !session.protocol?.features.includes('message-delete-undo')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o prazo de exclusão.', requestId);
      return;
    }
    if (payload.maxMessageLength !== undefined && !session.protocol?.features.includes('message-length-setting')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o limite de mensagens.', requestId);
      return;
    }
    if ((payload.recentSoundCacheEnabled !== undefined || payload.recentSoundCacheLimit !== undefined)
      && !session.protocol?.features.includes('recent-sounds')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o cache de áudios.', requestId);
      return;
    }
    if (payload.dmRelayEnabled !== undefined && !session.protocol?.features.includes('dm-relay')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar mensagens diretas.', requestId);
      return;
    }
    const changesAfk = payload.afkChannelEnabled !== undefined || payload.afkChannelName !== undefined
      || payload.afkTimeoutSeconds !== undefined;
    if (changesAfk && !session.protocol?.features.includes('afk-channel')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o canal AFK.', requestId);
      return;
    }
    // Checked before anything is applied, so a bad field never leaves the AFK room half configured.
    if ((payload.afkChannelEnabled !== undefined && typeof payload.afkChannelEnabled !== 'boolean')
      || (payload.afkTimeoutSeconds !== undefined && !isAfkTimeoutSeconds(payload.afkTimeoutSeconds))) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Configuração do canal AFK inválida.', requestId);
      return;
    }
    if (payload.afkChannelName !== undefined) {
      const name = channelNameSchema.safeParse(payload.afkChannelName);
      if (!name.success) {
        this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST,
          name.error.errors[0]?.message ?? 'Nome do canal AFK inválido.', requestId);
        return;
      }
    }
    if ((payload.recentSoundCacheEnabled !== undefined || payload.recentSoundCacheLimit !== undefined)
      && !this.recentSoundCache) {
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        'O cache de áudios não está disponível neste servidor.', requestId);
      return;
    }
    // Admins have separate socket queues. Serialize settings across them so a
    // duplicate save cannot observe the old mode and evict the new call twice.
    const update = (this.settingsUpdateQueue ?? Promise.resolve()).then(() =>
      this.applyServerUpdateSettings(session, payload, requestId));
    this.settingsUpdateQueue = update.catch(() => {});
    await update;
  }

  private async applyServerUpdateSettings(
    session: ClientSession,
    payload: ServerUpdateSettingsPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !this.isCurrentSession(session)) return;
    if (!(await this.requirePermission(session, Permission.MANAGE_SERVER, requestId)) || !this.isCurrentSession(session)) return;
    const previousServer = await this.serverRepo.getServer();
    const previousVoiceMode = previousServer?.voiceMode ?? 'p2p';
    if (!this.isCurrentSession(session)) return;

    // Switching the relay on is the whole intent, so the server installs coturn
    // itself when it is missing rather than sending the operator to a terminal
    // (#431). Only a relay that truly cannot run is rejected, so the toggle
    // never shows "on" while nothing is actually relaying (#425).
    //
    // A save that enters SFU is exempt: the relay flag rides along because the
    // desktop submits the whole form, but `resolveTurnSfuExclusion` is about to
    // discard it. Acting on it here would install coturn (a multi-minute
    // apt-get) only to switch it off moments later — or, on a host that cannot
    // run a relay at all, refuse the SFU switch outright (#515).
    if (payload.turnEnabled === true && payload.voiceMode !== 'sfu') {
      if (previousVoiceMode === 'sfu' && payload.voiceMode !== 'p2p') {
        this.sendError(session.ws, ProtocolErrorCode.TURN_UNAVAILABLE,
          'O relay TURN não pode ser ativado no modo SFU.', requestId);
        return;
      }
      const blocked = await this.ensureRelayCanRun(session);
      if (blocked) {
        this.sendError(session.ws, ProtocolErrorCode.TURN_UNAVAILABLE, blocked, requestId);
        return;
      }
    }

    // Same contract for the SFU: a mode the host cannot serve is refused up
    // front, because accepting it would only surface later as a call that
    // quietly fell back to P2P (#515).
    //
    // Only an actual switch is probed. The desktop submits the current voice
    // mode on every save, so probing on `payload.voiceMode === 'sfu'` alone
    // would bind UDP ports on every rename or password change — and a worker
    // already serving a call legitimately holds ports in this range, so the
    // probe would report the admin's own SFU as a blocked firewall. Comparing
    // against the stored mode is what excludes that case; the worker's own
    // state is not a substitute, since creating it binds no RTC port and so
    // proves nothing about the range.
    if (payload.voiceMode === 'sfu') {
      if (previousVoiceMode !== 'sfu') {
        const portProblem = await this.sfuManager.checkPortAvailability();
        if (portProblem) {
          this.sendError(
            session.ws,
            ProtocolErrorCode.SFU_UNAVAILABLE,
            describeSfuPortProblem(portProblem),
            requestId
          );
          return;
        }
      }
      const ok = await this.sfuManager.init({ retryNow: true });
      if (!ok) {
        const preflight = checkSfuPreflight();
        const diagnosis = preflight.ok ? '' : ` ${formatSfuPreflightForLog(preflight)}`;
        const reason = `${this.sfuManager.getLastError() || 'SFU worker failed to initialize'}${diagnosis}`.trim();
        Logger.error('SFU', `SFU initialization failed on mode change: ${reason}`);
        this.sfuManager.close();
        this.sendError(session.ws, ProtocolErrorCode.SFU_UNAVAILABLE, reason, requestId);
        return;
      }
    }

    // Installation and the shared settings queue can both take minutes. A
    // permission/session valid before waiting must not authorize a later write.
    const stillAllowed = await this.requirePermission(session, Permission.MANAGE_SERVER, requestId);
    if (!stillAllowed || !this.isCurrentSession(session)) {
      if (payload.voiceMode === 'sfu' && previousVoiceMode !== 'sfu') this.sfuManager.close();
      return;
    }
    const afkError = await this.applyAfkChannelSettings(session, payload);
    if (afkError) {
      if (payload.voiceMode === 'sfu' && previousVoiceMode !== 'sfu') this.sfuManager.close();
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, afkError, requestId);
      return;
    }
    const result = await this.mutateLocalAccess(() => this.authService.updateServerSettings(payload));
    if (!result.success) {
      if (payload.voiceMode === 'sfu' && previousVoiceMode !== 'sfu') this.sfuManager.close();
      this.sendError(
        session.ws,
        ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao atualizar configurações do servidor',
        requestId
      );
      return;
    }
    let { settings } = result;
    let recentSoundCacheError: string | undefined;
    if ((payload.recentSoundCacheEnabled !== undefined || payload.recentSoundCacheLimit !== undefined
      || payload.allowSoundboard === false)
      && this.recentSoundCache) {
      try {
        const configuration = await this.recentSoundCache.configure(settings.recentSoundCacheEnabled, settings.recentSoundCacheLimit);
        if (configuration.cleanupError) {
          Logger.warn('SOUNDBOARD', 'Recent sound cache settings were applied, but stale files could not all be removed.',
            configuration.cleanupError);
        }
      } catch (error) {
        const reconciled = await this.mutateLocalAccess(() => this.authService.updateServerSettings({
          recentSoundCacheEnabled: Boolean(previousServer?.recentSoundCacheEnabled),
          recentSoundCacheLimit: previousServer?.recentSoundCacheLimit ?? LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT,
        }));
        if (reconciled.success) settings = reconciled.settings;
        recentSoundCacheError = 'Não foi possível aplicar as configurações do cache de áudios.';
        if (!reconciled.success) {
          recentSoundCacheError += ` ${reconciled.errorMessage || 'Não foi possível restaurar o estado persistido.'}`;
        }
        Logger.error('SOUNDBOARD', 'Could not apply recent sound cache settings.', error);
      }
    }

    let voiceTransition: VoiceModeTransition | undefined;
    if (settings.voiceMode !== previousVoiceMode) {
      this.botLocalExecution.voiceModeChanged();
      voiceTransition = this.voiceSessions.voiceModeChanged(settings.voiceMode);
    }

    let relayError: string | undefined;
    if (payload.turnEnabled !== undefined || payload.voiceMode !== undefined) {
      // Also runs on a plain mode change: switching to SFU forces the relay off
      // in AuthService, and coturn has to actually stop (#515).
      try {
        await this.applyTurnState(settings.turnEnabled);
      } catch (error) {
        relayError = error instanceof Error && error.message.trim() ? error.message : 'Não foi possível aplicar o estado do relay TURN.';
        // A failed start used to acknowledge turnEnabled=true even with no
        // process. Publish actual persisted truth before rejecting the request.
        const running = this.coturnManager.isRunning();
        if (running !== settings.turnEnabled) {
          const reconciled = await this.mutateLocalAccess(() => this.authService.updateServerSettings({ turnEnabled: running }));
          if (!reconciled.success) {
            this.sendError(session.ws, ProtocolErrorCode.TURN_UNAVAILABLE,
              `${relayError} ${reconciled.errorMessage || 'Não foi possível atualizar o estado persistido.'}`, requestId);
            return;
          }
          settings = reconciled.settings;
        }
      }
    }

    if (this.audit && previousServer) {
      const current = await this.serverRepo.getServer();
      const changes = current ? serverSettingsChanges(previousServer, current) : [];
      if (changes.length) this.recordAudit(session, 'server.update', { changes });
    }

    const broadcastPayload: ServerSettingsUpdatedPayload = {
      ...settings,
      voiceTransition,
      turnAvailability: await CoturnManager.availability(),
      afkChannelId: await this.channelService.getAfkChannelId(),
    };

    // Broadcast updated server settings to all clients
    const settingsError = [relayError, recentSoundCacheError].filter(Boolean).join(' ');
    this.broadcast({
      type: MessageType.SERVER_SETTINGS_UPDATED,
      requestId: settingsError ? undefined : requestId,
      payload: broadcastPayload,
    });
    if (settingsError) {
      this.sendError(session.ws, relayError ? ProtocolErrorCode.TURN_UNAVAILABLE : ProtocolErrorCode.BAD_REQUEST,
        settingsError, requestId);
    }

    Logger.info(
      'INFO',
      `Configurações do servidor atualizadas (Nome: ${settings.name}, Senha: ${
        settings.hasPassword ? 'Ativa' : 'Sem Senha'
      }, Modo de Voz: ${settings.voiceMode}, Soundboard: ${settings.allowSoundboard ? 'Habilitado' : 'Desabilitado'})`
    );
  }

  /**
   * Creates, renames or removes the AFK room (`afk-channel`). It is an ordinary
   * voice channel, so its arrival, rename and removal reach members through the
   * usual channel events. Returns why nothing changed, or null.
   */
  private async applyAfkChannelSettings(session: ClientSession, payload: ServerUpdateSettingsPayload): Promise<string | null> {
    if (payload.afkChannelEnabled === undefined && payload.afkChannelName === undefined) return null;
    const current = await this.channelService.getAfkChannelId();
    if (payload.afkChannelEnabled === false) {
      if (!current) return null;
      const cleanupCommunityMedia = this.communityService?.prepareChannelDeletion(current);
      const removed = await this.mutateLocalAccess(() => this.channelService.removeAfkChannel());
      cleanupCommunityMedia?.();
      if (removed) this.releaseDeletedChannel(removed);
      await this.reconcileChannelVisibility();
      return null;
    }
    if (payload.afkChannelEnabled === true && !current) {
      const created = await this.mutateLocalAccess(() => this.channelService.createAfkChannel(payload.afkChannelName ?? 'AFK'));
      if (!created.success) return created.errorMessage ?? 'Não foi possível criar o canal AFK.';
      await this.reconcileChannelVisibility();
      return null;
    }
    if (payload.afkChannelName === undefined || !current) return null;
    const before = await this.channelService.getChannelSummary(current);
    const renamed = await this.mutateLocalAccess(() => this.channelService.updateChannel({ channelId: current, name: payload.afkChannelName }));
    if (!renamed.success || !renamed.channel) return renamed.errorMessage ?? 'Não foi possível renomear o canal AFK.';
    if (this.audit && before) {
      const changes = channelChanges(before, renamed.channel, await this.auditNames(before, renamed.channel));
      if (changes.length) this.recordAudit(session, 'channel.update', { target: auditRef.channel(renamed.channel), changes });
    }
    await this.publishChannelUpdate(renamed.channel);
    return null;
  }

  /**
   * Relays "stop my sound" to the channel (#499). No permission gate beyond
   * channel access: the payload carries no audio and the server only ever
   * silences the sound of the very session that asked, so the worst a caller
   * can do is cut their own playback short.
   */
  private handleSoundboardStop(
    session: ClientSession,
    payload: SoundboardStopPayload,
    requestId?: string
  ): void {
    if (!session.user) return;
    if (!payload || !payload.channelId) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Canal inválido', requestId);
      return;
    }

    const stoppedPayload: SoundboardStoppedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
    };
    this.sendToCall(payload.channelId, { type: MessageType.SOUNDBOARD_STOPPED, requestId, payload: stoppedPayload });
  }

  /** Delivers one message to the connections in a call, serialized once for all of them (S-WS-8). */
  private sendToCall(channelId: string, message: ServerMessage): void {
    const frames: FanOutFrames = new Map();
    for (const participant of this.signalingService.getParticipantsInChannel(channelId)) {
      const ws = this.sessionSockets.get(participant.sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) this.send(ws, message, frames);
    }
  }

  private async handleSoundboardPlay(
    session: ClientSession,
    payload: SoundboardPlayPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;

    // Check if soundboard is allowed on the server
    const server = await this.serverRepo.getServer();
    if (server && server.allowSoundboard === false) {
      this.sendError(
        session.ws,
        ProtocolErrorCode.BAD_REQUEST,
        'A reprodução de soundboard está desabilitada neste servidor.',
        requestId
      );
      return;
    }

    // Checked after the server-wide switch so the more specific "disabled here"
    // message wins when the whole feature is off (#359).
    if (!(await this.requirePermission(session, Permission.USE_SOUNDBOARD, requestId, payload?.channelId))) return;

    if (!payload?.channelId) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de som inválidos', requestId);
      return;
    }
    // A sound belongs to the call its author is in. Naming any other channel,
    // a text one included, used to reach everyone online when nobody was there.
    if (this.signalingService.getVoiceState(session.sessionId)?.channelId !== payload.channelId) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Entre na chamada deste canal para tocar sons.', requestId);
      return;
    }
    // The AFK room silences everyone inside it, the Soundboard included.
    if (payload.channelId === await this.channelService.getAfkChannelId()) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'O canal AFK não toca sons da Soundboard.', requestId);
      return;
    }
    const audio = this.validateRecentSoundPayload(session, payload, requestId);
    if (!audio) return;

    if (server?.recentSoundCacheEnabled && this.recentSoundCache) {
      void this.recentSoundCache.record({
          ...audio,
          userId: session.user.id,
          userName: session.user.nickname,
        }).then((entry) => {
          if (entry) this.notifyRecentSoundAdded(entry);
        }).catch((error) => {
          Logger.warn('SOUNDBOARD', 'Could not persist a recent sound; playback will continue.', error);
        });
    }

    const broadcastPayload: SoundboardPlayedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
      userName: session.user.nickname,
      soundName: audio.soundName,
      audioBase64: payload.audioBase64,
      mimeType: audio.mimeType,
    };

    // Only the participants of that call hear it, the author included.
    this.sendToCall(payload.channelId, { type: MessageType.SOUNDBOARD_PLAYED, requestId, payload: broadcastPayload });

    Logger.info('SOUNDBOARD', `User ${session.user.nickname} played sound "${audio.soundName}" in channel ${payload.channelId}`);
  }

  private async handleRecentSoundRecord(
    session: ClientSession,
    payload: RecentSoundRecordPayload,
    requestId?: string,
  ): Promise<void> {
    if (!session.user || session.isBot || !session.protocol?.features.includes('recent-sounds')) return;
    const server = await this.serverRepo.getServer();
    if (!server?.recentSoundCacheEnabled || server.allowSoundboard === false) return;
    if (!(await this.requirePermission(session, Permission.USE_SOUNDBOARD, requestId))) return;
    const audio = this.validateRecentSoundPayload(session, payload, requestId);
    if (!audio || !this.recentSoundCache) return;
    try {
      const entry = await this.recentSoundCache.record({
        ...audio,
        userId: session.user.id,
        userName: session.user.nickname,
      });
      if (entry) this.notifyRecentSoundAdded(entry);
    } catch (error) {
      Logger.warn('SOUNDBOARD', 'Could not persist a local Soundboard playback.', error);
    }
  }

  private async handleDmRelaySend(
    session: ClientSession,
    payload: DmRelaySendPayload,
    requestId?: string,
  ): Promise<void> {
    const server = await this.serverRepo.getServer();
    const error = this.dmRelay.relay(session, payload, {
      enabled: server?.dmRelayEnabled !== false,
      requestId,
    });
    if (error) {
      const errorPayload: ServerErrorPayload = {
        code: error.code,
        message: error.message,
        requestId,
        relayId: error.relayId,
      };
      this.send(session.ws, { type: MessageType.SERVER_ERROR, requestId, payload: errorPayload });
    }
  }

  private validateRecentSoundPayload(
    session: ClientSession,
    payload: RecentSoundRecordPayload,
    requestId?: string,
  ): { soundName: string; mimeType: RecentSoundMimeType; bytes: Buffer } | null {
    if (!payload?.audioBase64 || !payload.soundName) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de som inválidos', requestId);
      return null;
    }
    if (payload.audioBase64.length > 4 * 1024 * 1024) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio muito grande (máximo 15 segundos / ~2MB)', requestId);
      return null;
    }
    const soundName = String(payload.soundName).trim().slice(0, 100);
    const mimeType = recentSoundMimeTypeSchema.safeParse(payload.mimeType || 'audio/mpeg');
    if (!soundName || !mimeType.success || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.audioBase64)) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de som inválidos', requestId);
      return null;
    }
    const bytes = Buffer.from(payload.audioBase64, 'base64');
    if (bytes.length < 1 || bytes.length > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio muito grande', requestId);
      return null;
    }
    return { soundName, mimeType: mimeType.data, bytes };
  }

  private notifyRecentSoundAdded(entry: RecentSoundEntry): void {
    const message: ServerMessage<MessageType.RECENT_SOUND_ADDED> = { type: MessageType.RECENT_SOUND_ADDED, payload: entry };
    this.publish((recipient) =>
      !recipient.isBot && recipient.protocol?.features.includes('recent-sounds') ? message : undefined);
  }

  private async handleRecentSoundsList(session: ClientSession, requestId?: string): Promise<void> {
    if (!session.user) return;
    if (session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots não podem acessar áudios recentes.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('recent-sounds')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'O histórico de áudios exige um cliente e servidor atualizados.', requestId);
      return;
    }
    if (!this.recentSoundCache) {
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        'O cache de áudios não está disponível neste servidor.', requestId);
      return;
    }
    const server = await this.serverRepo.getServer();
    const enabled = Boolean(server?.recentSoundCacheEnabled);
    this.send(session.ws, {
      type: MessageType.RECENT_SOUNDS_RESULT,
      requestId,
      payload: {
        enabled,
        limit: server?.recentSoundCacheLimit ?? LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT,
        items: enabled ? await this.recentSoundCache.list() : [],
      },
    });
  }

  private async handleRecentSoundDownload(
    session: ClientSession,
    payload: unknown,
    requestId?: string,
  ): Promise<void> {
    if (!session.user) return;
    if (session.isBot) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots não podem acessar áudios recentes.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('recent-sounds')) {
      this.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'O histórico de áudios exige um cliente e servidor atualizados.', requestId);
      return;
    }
    if (!this.recentSoundCache) {
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        'O cache de áudios não está disponível neste servidor.', requestId);
      return;
    }
    const server = await this.serverRepo.getServer();
    if (!server?.recentSoundCacheEnabled) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'O cache de áudios está desabilitado.', requestId);
      return;
    }
    if (!this.rateLimiter.checkLimit(
      `recent-sound-download:${session.user.id}`,
      LIMITS.RECENT_SOUND_DOWNLOAD_RATE_LIMIT,
      LIMITS.RECENT_SOUND_DOWNLOAD_RATE_WINDOW_MS,
    )) {
      this.sendError(session.ws, ProtocolErrorCode.RATE_LIMITED,
        'Muitas solicitações de áudio. Aguarde um momento.', requestId);
      return;
    }
    const id = payload && typeof payload === 'object' && 'id' in payload ? payload.id : null;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/iu.test(id)) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio recente inválido.', requestId);
      return;
    }
    const sound = await this.recentSoundCache.download(id);
    if (!sound) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio recente não encontrado.', requestId);
      return;
    }
    this.send(session.ws, { type: MessageType.RECENT_SOUND_DATA, requestId, payload: sound });
  }

  private findSessionById(sessionId: string): ClientSession | undefined {
    const ws = this.sessionSockets.get(sessionId);
    if (ws) return this.sessions.get(ws);
    return undefined;
  }

  /**
   * Whether a connection is still the open, registered one. Rechecked after
   * every await on the way to authentication: a connection let go meanwhile
   * must neither be answered nor authenticated.
   */
  private isLive(session: ClientSession): boolean {
    return !this.closing && this.sessions.get(session.ws) === session && session.ws.readyState === WebSocket.OPEN;
  }

  private isCurrentSession(session: BotInteractionSession): boolean {
    const current = this.sessions.get(session.ws);
    return !this.closing && current === session && !current.replaced && !current.intentionalLogout &&
      session.ws.readyState === WebSocket.OPEN && !!session.sessionId &&
      this.sessionSockets.get(session.sessionId) === session.ws;
  }

  /** Records what a member or bot did; servers without the audit log ignore it. */
  private recordAudit(session: BotInteractionSession, action: ServerAuditAction, input: Omit<ServerAuditInput, 'actor'> = {}): void {
    if (!this.audit || !session.user) return;
    this.audit.record(action, {
      ...input,
      actor: auditRef.member({ ...session.user, isBot: session.isBot === true || session.user.isBot === true }),
    });
  }

  /** A member or bot by id, with the name it has now. */
  private async auditIdentity(id: string): Promise<ServerAuditRef> {
    const nickname = (await this.userService.nicknames([id])).get(id);
    if (nickname !== undefined) return auditRef.user(id, nickname);
    const bot = await this.botService?.findById(id);
    return bot ? auditRef.bot(bot.id, bot.name) : auditRef.user(id, id);
  }

  private async auditChannel(channelId: string | null | undefined): Promise<ServerAuditRef | null> {
    if (!channelId) return null;
    const channel = await this.channelService.getChannelSummary(channelId);
    return channel ? auditRef.channel(channel) : null;
  }

  private async auditNames(...withOverwrites: Array<{ permissionOverwrites?: readonly ChannelPermissionOverwrite[] } | null | undefined>): Promise<AuditNames> {
    const userIds = withOverwrites.flatMap((item) =>
      (item?.permissionOverwrites ?? []).flatMap((overwrite) => overwrite.userId !== undefined ? [overwrite.userId] : []));
    const [roles, categories, users] = await Promise.all([
      this.roleService.listRoles(), this.channelService.listCategories(), this.userService.nicknames(userIds),
    ]);
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    return {
      category: (id) => id ? categoryNames.get(id) ?? null : null,
      role: (id) => roleNames.get(id) ?? id,
      user: (id) => users.get(id) ?? id,
    };
  }

  /** A command and the options it was given; values stay out, since members type anything into them. */
  private async auditCommand(session: BotInteractionSession, command: SlashCommand, channelId: string, options: CommandValues): Promise<void> {
    if (!this.audit) return;
    const provided = Object.keys(options);
    this.recordAudit(session, 'bot.command', {
      target: auditRef.bot(command.botId, command.botName),
      related: { channel: await this.auditChannel(channelId) },
      detail: `/${command.name}`,
      changes: provided.length ? [{ field: 'commandOptions', after: provided }] : [],
    });
  }

  private async channelTreeSnapshot(): Promise<{ channels: ChannelSummary[]; categories: ChannelCategory[] }> {
    const [channels, categories] = await Promise.all([this.channelService.listChannels(), this.channelService.listCategories()]);
    return { channels, categories };
  }

  /** One entry per item that changed place; a drag records the dragged item, not everything it shifted. */
  private recordTreeMoves(
    session: ClientSession,
    before: { channels: ChannelSummary[]; categories: ChannelCategory[] },
    after: { channels: ChannelSummary[]; categories: ChannelCategory[] },
  ): void {
    for (const move of channelTreeMoves(before, after).slice(0, MAX_AUDITED_MOVES)) {
      this.recordAudit(session, move.target.type === 'category' ? 'category.move' : 'channel.move', {
        target: move.target,
        related: { category: move.container },
        changes: [{ field: 'position', before: move.from, after: move.to }],
      });
    }
  }

  private async requirePermission(
    session: ClientSession,
    permission: Permission,
    requestId?: string,
    channelId?: string,
  ): Promise<boolean> {
    if (!session.user) return false;
    const serverLevelOnly = permission === Permission.MANAGE_CHANNELS || permission === Permission.MOVE_MEMBERS;
    if (channelId && !serverLevelOnly && !await this.requireChannelAccess(session, channelId, requestId)) return false;
    const allowed = channelId && !serverLevelOnly
      ? await this.channelService.canUserAccessChannel(session.user.id, channelId, permission)
      : session.isBot
      ? hasPermission((await this.channelService.getAccessContext(session.user.id)).permissions, permission)
      : await this.permissionService.checkPermission(session.user.id, permission);
    if (allowed) return true;
    this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Você não tem permissão para executar esta ação.', requestId);
    return false;
  }

  /**
   * `channelsChanged` resends every visible channel. Only deleting a role or a
   * member edits channel rows (rules naming them go with it); resending them on
   * any other role change, or on every sign-in, made every client redraw its
   * whole sidebar.
   */
  private async broadcastRolesState(requestId?: string, channelsChanged = false): Promise<void> {
    this.botSettingsPermissionVersion++;
    const state = await this.roleService.getRoleState();
    await this.screens.refreshScreenRoles();
    const payload: RolesListPayload = {
      everyonePermissions: state.everyonePermissions,
      roles: state.roles,
      userRoles: state.userRoles,
    };
    const message: ServerMessage<MessageType.ROLES_LIST> = { type: MessageType.ROLES_LIST, requestId, payload };
    const byModel = new Map<RoleModel, ServerMessage<MessageType.ROLES_LIST>>();
    const messageFor = (model: RoleModel): ServerMessage<MessageType.ROLES_LIST> => {
      let variant = byModel.get(model);
      if (!variant) {
        variant = { ...message, payload: { ...payload, roles: rolesForModel(state.roles, state.everyonePermissions, model) } };
        byModel.set(model, variant);
      }
      return variant;
    };
    this.publish((session) => messageFor(roleModelFor(session.protocol?.features)));

    // Roles decide who may see a private channel, so any change to them can
    // grant or revoke access. Reconciling here covers every role mutation at
    // once — create, update, delete, assign and unassign all end up in this
    // method (#384).
    await this.reconcileChannelVisibility(channelsChanged);
    await this.community?.refresh();
  }

  private async handleRoleCreate(session: ClientSession, payload: RoleCreatePayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const result = await this.roleService.createRole(session.user.id, payload, roleModelFor(session.protocol?.features));
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao criar cargo.', requestId);
      return;
    }
    if (result.role) {
      this.recordAudit(session, 'role.create', {
        target: auditRef.role(result.role),
        changes: [
          ...(result.role.color ? [{ field: 'color', after: result.role.color }] : []),
          ...(result.role.isDefault ? [{ field: 'isDefault', after: true }] : []),
          ...permissionChanges(0, result.role.permissions),
        ],
      });
    }
    await this.broadcastRolesState(requestId);
  }

  /** A role as the audit compares it; Everyone is the base every member has. */
  private async auditRoleState(roleId: string): Promise<{ id: string; name: string; color: string | null; isDefault: boolean; permissions: number } | undefined> {
    if (roleId === EVERYONE_ROLE_ID) {
      return { id: EVERYONE_ROLE_ID, name: '@everyone', color: null, isDefault: false, permissions: await this.permissionService.getEveryonePermissions() };
    }
    return (await this.roleService.listRoles()).find((role) => role.id === roleId);
  }

  private async handleRoleUpdate(session: ClientSession, payload: RoleUpdatePayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const roleId = typeof payload?.roleId === 'string' ? payload.roleId : undefined;
    const before = this.audit && roleId ? await this.auditRoleState(roleId) : undefined;
    const result = await this.roleService.updateRole(session.user.id, payload, roleModelFor(session.protocol?.features));
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao atualizar cargo.', requestId);
      return;
    }
    const after = before && roleId ? await this.auditRoleState(roleId) : undefined;
    if (before && after) {
      const changes = [
        ...auditDiff([
          ['name', before.name, after.name],
          ['color', before.color, after.color],
          ['isDefault', before.isDefault, after.isDefault],
        ]),
        ...permissionChanges(before.permissions, after.permissions),
      ];
      if (changes.length) this.recordAudit(session, 'role.update', { target: auditRef.role(after), changes });
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleRoleDelete(session: ClientSession, payload: RoleDeletePayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const deleted = this.audit && typeof payload?.roleId === 'string' ? await this.auditRoleState(payload.roleId) : undefined;
    const result = await this.roleService.deleteRole(session.user.id, payload.roleId);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao excluir cargo.', requestId);
      return;
    }
    if (deleted) this.recordAudit(session, 'role.delete', { target: auditRef.role(deleted) });
    await this.broadcastRolesState(requestId, true);
  }

  /** Assigning a role someone already has, or removing one they lack, changes nothing and is not recorded. */
  private async auditRoleAssignment(payload: RoleAssignPayload): Promise<{ held: boolean; role?: ServerAuditRef } | undefined> {
    if (!this.audit || typeof payload?.userId !== 'string' || typeof payload.roleId !== 'string') return undefined;
    const [roles, userRoles] = await Promise.all([this.roleService.listRoles(), this.roleService.listUserRoles()]);
    const role = roles.find((entry) => entry.id === payload.roleId);
    return {
      held: userRoles.some((entry) => entry.userId === payload.userId && entry.roleIds.includes(payload.roleId)),
      role: role ? auditRef.role(role) : undefined,
    };
  }

  private async handleRoleAssign(session: ClientSession, payload: RoleAssignPayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const before = await this.auditRoleAssignment(payload);
    const result = await this.roleService.assignRole(session.user.id, payload);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao atribuir cargo.', requestId);
      return;
    }
    if (before && !before.held && before.role) {
      this.recordAudit(session, 'role.assign', { target: await this.auditIdentity(payload.userId), related: { role: before.role } });
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleRoleUnassign(session: ClientSession, payload: RoleAssignPayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const before = await this.auditRoleAssignment(payload);
    const result = await this.roleService.unassignRole(session.user.id, payload);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao remover cargo.', requestId);
      return;
    }
    if (before?.held && before.role) {
      this.recordAudit(session, 'role.unassign', { target: await this.auditIdentity(payload.userId), related: { role: before.role } });
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleMemberKick(session: ClientSession, payload: MemberKickPayload, requestId?: string): Promise<void> {
    if (!session.user) return;

    const targetUserId = payload?.targetUserId;
    if (!targetUserId) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário inválido.', requestId);
      return;
    }
    if (targetUserId === session.user.id) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Você não pode expulsar a si mesmo.', requestId);
      return;
    }
    if (await this.permissionService.isOwner(targetUserId)) {
      this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'O dono do servidor não pode ser expulso.', requestId);
      return;
    }

    const result = await this.mutateLocalAccess(() => this.userService.deleteMember(targetUserId));
    if (!result.success) {
      this.sendError(session.ws, result.errorCode ?? ProtocolErrorCode.BAD_REQUEST, result.errorMessage ?? 'Não foi possível expulsar o membro.', requestId);
      return;
    }
    this.recordAudit(session, 'member.kick', { target: auditRef.user(targetUserId, result.nickname ?? targetUserId) });

    // Kicking removes the person, so every device they are signed in from has to
    // go — not just the most recent one (#309). Marked before any further await
    // so concurrent in-flight messages from them are dropped by handleMessage.
    const targetSessions = this.getSessionsOfUser(targetUserId);
    for (const targetSession of targetSessions) targetSession.replaced = true;

    // Invalidate any outstanding HTTP upload tokens the member still holds.
    this.attachmentService.revokeTokensForUser(targetUserId);

    // Remove the target from any voice channel they were in (one state per device).
    // The sessions were already marked as replaced above, which makes
    // handleDisconnect return early, so this is the last chance to reap what
    // they held in the SFU (#527).
    for (const previousVoice of this.signalingService.getSessionsOfUser(targetUserId)) {
      this.voiceSessions.endVoiceSession(previousVoice.sessionId);
    }

    // Replaced sessions no longer receive broadcasts, so notify every kicked
    // device directly before closing it. Only the initiator needs the requestId.
    const kickedPayload: MemberKickedPayload = { userId: targetUserId, nickname: result.nickname ?? '' };
    this.send(session.ws, { type: MessageType.MEMBER_KICKED, requestId, payload: kickedPayload });
    for (const targetSession of targetSessions) {
      this.send(targetSession.ws, { type: MessageType.MEMBER_KICKED, payload: kickedPayload });
    }
    this.broadcast({ type: MessageType.MEMBER_KICKED, payload: kickedPayload }, session.ws);

    // Cancel pending reconnect-grace timers and forcefully disconnect every
    // live session of the kicked user.
    this.closeSessionsOfUser(targetUserId);

    // Role assignments were removed with the user, so refresh role state. Any
    // channel rule naming them went too, so channels are resent as well.
    await this.broadcastRolesState(undefined, true);

    Logger.info('NETWORK', `User ${result.nickname} was kicked from the server by ${session.user.nickname}`);
  }

  /**
   * Refreshes the cached summary on every live session of that person, keeping
   * the per-connection fields the service layer knows nothing about (#309).
   */
  private applyUserUpdate(updatedUser: UserSummary): void {
    for (const target of this.getSessionsOfUser(updatedUser.id)) {
      target.user = {
        ...updatedUser,
        sessionId: target.sessionId,
        connectedAt: target.user?.connectedAt,
        invisible: target.invisible,
        // The service only knows the stored profile, so the live presence is carried over.
        activity: target.user?.activity,
        brb: target.user?.brb,
        customStatus: target.user?.customStatus,
      };
    }
  }

  /** Every live session of a person: they may be signed in from several devices (#309). */
  private getSessionsOfUser(userId: string): ClientSession[] {
    const found: ClientSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.user?.id === userId) found.push(session);
    }
    return found;
  }

  /**
   * Releases what one connection holds, whatever ended it: its socket closing,
   * a newer connection of the same device, a kick or a revoked bot. Every path
   * that lets a connection go runs this same list, so a resource added per
   * connection is released by all of them. Idempotent: the socket's own close
   * event still arrives for a connection that was already let go.
   * Returns whether the connection was still registered.
   */
  private releaseConnection(session: ClientSession): boolean {
    this.settleAnonymous(session);
    session.botVoiceJoinAttempt = undefined;
    session.botVoiceGrant = undefined;
    this.voiceSessions.dropReconnectGrant(session);
    // Runs after the caller's synchronous teardown, so it sees any return grant set there.
    void this.syncVoicePresenceVisibility();
    const registered = this.sessions.delete(session.ws);
    // A newer connection of the same device may already own the mapping.
    if (session.sessionId && this.sessionSockets.get(session.sessionId) === session.ws) {
      this.sessionSockets.delete(session.sessionId);
    }
    this.authService.clearChallenge(session.ws);
    this.botLocalExecution.disconnect(session);
    this.botInteractions.disconnect(session);
    this.disconnectBotScreens(session);
    this.dmRelay.unregister(session);
    this.gameShareRequests.sessionClosed(session);
    return registered;
  }

  /**
   * Lets the older connection of a device go once that device connected again.
   * A person's call stays for the new connection to resume, as their client
   * rejoins by itself; a bot's call ends with the connection that made it.
   */
  private replaceConnection(existingWs: WebSocket): void {
    const stale = this.sessions.get(existingWs);
    if (stale) {
      stale.replaced = true;
      this.releaseConnection(stale);
      if (stale.isBot && stale.sessionId) this.voiceSessions.endVoiceSession(stale.sessionId);
    }
    try {
      existingWs.close();
    } catch {
      /* already closing */
    }
  }

  private handleDisconnect(session: ClientSession): void {
    const wasConnected = this.releaseConnection(session);

    // A connection already let go — replaced by a newer one of the same device,
    // kicked or revoked — had its departure handled by whoever let it go.
    if (!wasConnected || session.replaced) {
      return;
    }

    // Bots: clear registered commands on disconnect (#569).
    if (session.isBot && session.botId) {
      this.commandRegistry.clearBot(session.botId);
      this.broadcastCommands();
      void this.broadcastBotSettings().catch((error: unknown) => Logger.error('BOT', 'Failed to publish offline bot settings.', error));
    }

    if (!session.user || !session.sessionId) {
      return;
    }

    const user = session.user;
    const sessionId = session.sessionId;
    if (this.closing) return;

    // A call cannot outlive the socket that carries its signalling: once this
    // connection is gone the person can no longer be heard, WebRTC has nowhere
    // to renegotiate and nobody can move them out of the channel. So leaving
    // voice is immediate for every kind of disconnect — closing the app,
    // crashing or dropping the network — and everyone still in the channel gets
    // the departure (and its sound) right away instead of after the 20 s
    // reconnection grace period (#458).
    //
    // Presence in the member list keeps that grace period (#44): the person is
    // still shown as "reconnecting", and the client rejoins the voice channel by
    // itself as soon as it reconnects.
    if (!session.intentionalLogout && !session.isBot) this.voiceSessions.grantVoiceReturn(user.id, sessionId);
    this.voiceSessions.endVoiceSession(sessionId);

    // Graceful logout (user clicked disconnect / switched servers): remove them
    // immediately. Otherwise treat it as a possible temporary connection loss
    // and give them a grace period to reconnect before announcing USER_LEFT.
    if (session.intentionalLogout || session.isBot) {
      this.finalizeSessionLeave(user, sessionId, session.invisible);
      return;
    }

    // Invisible users are already "offline" to everyone: skip the reconnecting
    // broadcast so the UI doesn't flash them into existence (#561).
    if (!session.invisible) {
      const reconnectingPayload: UserConnectionStatePayload = {
        userId: user.id,
        sessionId,
        nickname: user.nickname,
        status: 'reconnecting',
      };
      this.broadcast({
        type: MessageType.USER_CONNECTION_STATE,
        payload: reconnectingPayload,
      });
    }
    Logger.info('NETWORK', `User ${user.nickname} lost connection (aguardando reconexão)`);

    // Capture the invisible flag before the session object is reclaimed.
    const wasInvisible = session.invisible;

    // Clear any previous timer just in case, then start the grace period.
    const existingTimer = this.reconnectTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      // Only finalize if this session hasn't reconnected in the meantime.
      if (this.sessionSockets.has(sessionId)) return;
      this.finalizeSessionLeave(user, sessionId, wasInvisible);
    }, LIMITS.RECONNECT_GRACE_MS);
    this.reconnectTimers.set(sessionId, timer);
  }

  /**
   * Removes one connection from voice, announces USER_LEFT for it and logs the
   * departure. Used both for graceful logouts and when the reconnection grace
   * period expires. The person may still be online from another device, which
   * the client resolves from the `sessionId` carried in the payload (#309).
   */
  private finalizeSessionLeave(user: UserSummary, sessionId: string, invisible?: boolean): void {
    // Normally already done by handleDisconnect; kept for the paths that
    // finalize a session without going through it.
    this.voiceSessions.clearVoiceReturn(sessionId);
    this.voiceSessions.endVoiceSession(sessionId);

    // Invisible users were never announced as online, so don't announce
    // their departure either (#561).
    if (!invisible) {
      const userLeftPayload: UserLeftPayload = {
        userId: user.id,
        sessionId,
        nickname: user.nickname,
      };
      this.broadcast({
        type: MessageType.USER_LEFT,
        payload: userLeftPayload,
      });
    }

    Logger.info('NETWORK', `User ${user.nickname} disconnected`);
  }

  private startHeartbeat(): void {
    const expire = () => { void this.chatService.expireDeletedMessages()
      .catch(error => Logger.error('DATABASE', 'Failed to expire message deletion backups.', error)); };
    expire();
    this.lastLivenessCheckAt = performance.now();
    this.heartbeatTimer = setInterval(() => {
      expire();
      this.checkLiveness();
    }, LIMITS.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Pings every connection and closes the ones that stopped answering.
   *
   * A connection goes only after HEARTBEAT_TIMEOUT_MS without a frame or a
   * pong, on a monotonic clock: long enough to ride out a Wi-Fi roam or a
   * saturated uplink, which the old "answered since the last tick" flag cut
   * after 5 to 10 s — taking the person out of the call with it (#458).
   *
   * When this round itself ran late, the server is what stalled: answers that
   * arrived meanwhile are still unread in the sockets, and judging by them
   * would drop every client at once and start a reconnection storm. Nobody is
   * closed on that round; the next one, on time, decides.
   */
  private checkLiveness(now = performance.now()): void {
    const previous = this.lastLivenessCheckAt;
    this.lastLivenessCheckAt = now;
    const stalled = previous !== undefined && now - previous > LIMITS.HEARTBEAT_INTERVAL_MS * 2;
    for (const [ws, session] of this.sessions.entries()) {
      if (!stalled && now - session.lastSeenAt > LIMITS.HEARTBEAT_TIMEOUT_MS) {
        Logger.warn('NETWORK', `Terminating dead socket for ${session.user?.nickname || session.ip}`);
        ws.terminate();
        this.handleDisconnect(session);
        continue;
      }
      ws.ping();
    }
  }

  /** The connection authenticated or is gone: it stops counting as anonymous. */
  private settleAnonymous(session: ClientSession): void {
    clearTimeout(session.authDeadline);
    session.authDeadline = undefined;
    if (!session.countedAnonymous) return;
    session.countedAnonymous = false;
    this.anonymousSessions.delete(session);
    const address = clientAddress(session.ip);
    if (address === undefined) return;
    const remaining = (this.anonymousPerAddress.get(address) ?? 1) - 1;
    if (remaining > 0) this.anonymousPerAddress.set(address, remaining);
    else this.anonymousPerAddress.delete(address);
  }

  /**
   * Delivers one message to one connection, after the projections that depend
   * on the recipient. `frames` is shared by the recipients of a single fan-out:
   * those that end up with the very same message reuse its serialization
   * instead of encoding it again, which for a sound means megabytes each (S-WS-8).
   */
  public send(ws: WebSocket, message: ServerMessage, frames?: FanOutFrames): void {
    const session = this.sessions.get(ws);
    if (ws.readyState === WebSocket.OPEN && (!session || this.canDeliverBotEvent(session, message))) {
      // A recipient that stopped reading would make the server hold everything
      // sent to it in memory. It is dropped instead, and resynchronizes when it
      // reconnects; a late sound is simply skipped before that point.
      if (ws.bufferedAmount > WebSocketServer.flowLimits.OUTBOUND_MAX_BYTES) {
        Logger.warn('NETWORK', `Closing a connection that stopped reading: ${session?.user?.nickname ?? session?.ip ?? 'unknown'}`);
        ws.terminate();
        return;
      }
      if (DISCARDABLE_MESSAGES.has(message.type) && ws.bufferedAmount > WebSocketServer.flowLimits.OUTBOUND_DISCARDABLE_BYTES) return;
      const projected = session?.user ? this.screens.projectScreenMessage(session, message) : message;
      if (!projected) return;
      const polls = session && !session.protocol?.features.includes('poll-voters') ? projectLegacyPolls(projected) : projected;
      const delivered = session && !session.protocol?.features.includes('message-forward') ? projectLegacyForwards(polls) : polls;
      if (!frames) {
        ws.send(JSON.stringify(delivered));
        return;
      }
      let frame = frames.get(delivered);
      if (!frame) {
        frame = Buffer.from(JSON.stringify(delivered));
        frames.set(delivered, frame);
      }
      // Text frame on the wire, as a string would be: a binary one reaches browsers as a Blob.
      ws.send(frame, { binary: false });
    }
  }

  /** Per-person budget of the expensive messages listed in MESSAGE_BUDGETS. */
  private withinMessageBudget(session: ClientSession, type: MessageType, requestId?: string): boolean {
    const budget = MESSAGE_BUDGETS.get(type);
    if (!budget || !session.user) return true;
    if (this.rateLimiter.checkLimit(`message:${type}:${session.user.id}`, budget.max, budget.windowMs)) return true;
    if (!budget.silent) {
      this.sendError(session.ws, ProtocolErrorCode.RATE_LIMITED,
        'Muitas solicitações em pouco tempo. Aguarde um momento.', requestId);
    }
    return false;
  }

  private canDeliverBotEvent(session: ClientSession, message: ServerMessage): boolean {
    if (!session.isBot) return true;
    // Termination notifications must survive the synchronous invalidation of their endpoint.
    if (message.type === MessageType.COMMAND_FINISHED || message.type === MessageType.SERVER_SHUTDOWN) return true;
    if (!this.isCurrentSession(session)) return false;
    // Soundboard playback is incoming user audio, not a bot publishing API.
    if (message.type === MessageType.SOUNDBOARD_PLAYED || message.type === MessageType.SOUNDBOARD_STOPPED) return false;
    if (!BOT_CHAT_EVENTS.has(message.type) || this.botService?.permissions?.allows(session.botId ?? '', 'read_messages')) return true;
    const payload = message.payload;
    return message.type === MessageType.CHAT_MESSAGE && !!message.requestId &&
      typeof payload === 'object' && payload !== null && 'userId' in payload && payload.userId === session.botId &&
      this.isCurrentBotOperation(session, 'send_messages');
  }

  /**
   * Sends every connection that may receive broadcasts — open, signed in and
   * not superseded by a newer connection of its device — the message
   * `messageFor` picks for it, if any. Recipients that end up with the same
   * message share one serialization (S-WS-8); bots are filtered by `send`.
   */
  private publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void {
    const frames: FanOutFrames = new Map();
    for (const [ws, session] of this.sessions) {
      if (ws === skip || ws.readyState !== WebSocket.OPEN || !isSignedIn(session) || session.replaced) continue;
      const message = messageFor(session);
      if (message) this.send(ws, message, frames);
    }
  }

  public broadcast(message: ServerMessage, ignoreWs?: WebSocket): void {
    this.publish(() => message, ignoreWs);
  }

  /**
   * Broadcasts an event that belongs to a channel, reaching only the members
   * allowed to see its content. Even public channels may deny message reading.
   */
  private async broadcastToChannelAudience(
    channel: ChannelAccessRules & { id: string },
    message: ServerMessage,
    ignoreWs?: WebSocket,
    canSend?: () => boolean,
    voiceChannelId?: string
  ): Promise<void> {
    const version = this.getChannelAccessVersion();
    const roleVersion = this.permissionService.getRoleAccessVersion();
    if (version === null || roleVersion === null) return;
    const permission = BOT_CHAT_EVENTS.has(message.type) || message.type === MessageType.POLL_UPDATED
      ? Permission.READ_MESSAGES : Permission.VIEW_CHANNEL;
    const allowedUserIds = await this.resolveChannelAudience(channel, permission);
    if ((canSend && !canSend()) || version !== this.getChannelAccessVersion() ||
        roleVersion !== this.permissionService.getRoleAccessVersion()) return;
    this.publish((session) => allowedUserIds.has(session.user.id) ||
      (voiceChannelId && this.hasBotVoiceGrant(session, voiceChannelId)) ? message : undefined, ignoreWs);
  }

  /**
   * Ids of the connected users allowed into a channel. Permissions are resolved
   * once per person, not per socket, since one member may hold several
   * connections (#309), and the whole set is settled before anything is sent so
   * the delivery loop itself stays synchronous.
   */
  private async resolveChannelAudience(
    channel: ChannelAccessRules & { id: string }, permission: Permission = Permission.VIEW_CHANNEL,
  ): Promise<Set<string>> {
    const userIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.user) userIds.add(session.user.id);
    }

    const allowed = new Set<string>();
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        const context = await this.channelService.getAccessContext(userId);
        const rules = this.channelService.rulesFor(channel, context);
        if (canAccessChannel(rules, context.permissions, context.roleIds, context.isBot, context.userId) &&
            hasChannelPermission(rules, context.permissions, context.roleIds, permission, context.isBot, context.userId)) {
          allowed.add(userId);
        }
      })
    );
    return allowed;
  }

  /**
   * Guards an action targeting a channel the caller may not be allowed into.
   *
   * The refusal deliberately reuses CHANNEL_NOT_FOUND: answering "you lack
   * access" would confirm that a private channel with that id exists, which is
   * exactly what hiding it is meant to prevent (#384).
   */
  private async requireChannelAccess(
    session: ClientSession,
    channelId: string | undefined,
    requestId?: string
  ): Promise<boolean> {
    if (!session.user) return false;
    if (channelId && (await this.channelService.canUserAccessChannel(session.user.id, channelId))) return true;

    this.sendError(session.ws, ProtocolErrorCode.CHANNEL_NOT_FOUND, 'Canal não encontrado', requestId);
    return false;
  }

  private async requireCategoryManagement(session: ClientSession, categoryId: string, requestId?: string): Promise<boolean> {
    if (session.user && categoryId) return this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId);
    this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Categoria indisponível.', requestId);
    return false;
  }

  private hasBotVoiceGrant(session: ClientSession, channelId: string): boolean {
    return !!session.isBot && !!session.sessionId && this.isCurrentSession(session) &&
      session.botVoiceGrant?.channelId === channelId &&
      session.botVoiceGrant.accessVersion === this.botSettingsPermissionVersion &&
      this.signalingService.getVoiceState(session.sessionId)?.channelId === channelId;
  }

  private async broadcastForumActivity(
    channelId: string, messages: ServerMessage[], ignoreWs?: WebSocket, canSend?: () => boolean
  ): Promise<void> {
    const frames: FanOutFrames = new Map();
    for (const session of this.sessions.values()) {
      if (!session.user || session.ws === ignoreWs || !this.isCurrentSession(session)) continue;
      const channels = this.getChannelAccessVersion();
      const roles = this.permissionService.getRoleAccessVersion();
      if (channels === null || roles === null || !await this.forumService?.canRead(session.user.id, channelId) ||
          channels !== this.getChannelAccessVersion() || roles !== this.permissionService.getRoleAccessVersion() ||
          !this.isCurrentSession(session) || (canSend && !canSend())) continue;
      for (const message of messages) this.send(session.ws, message, frames);
    }
  }

  /**
   * Scopes an event to the members allowed into the channel it belongs to
   * (#384). A deleted channel no longer has an audience; broadcasting it to
   * everyone would expose previously private content during a deletion race.
   */
  private async broadcastToChannel(
    channelId: string,
    message: ServerMessage,
    ignoreWs?: WebSocket,
    canSend?: () => boolean
  ): Promise<void> {
    const channelVersion = this.getChannelAccessVersion();
    const roleVersion = this.permissionService.getRoleAccessVersion();
    const isCurrent = () => channelVersion !== null && roleVersion !== null &&
      channelVersion === this.getChannelAccessVersion() && roleVersion === this.permissionService.getRoleAccessVersion() &&
      (!canSend || canSend());
    if (!isCurrent()) return;
    const privatePoll = this.privatePollForMessage(message);
    if (privatePoll) {
      const frames: FanOutFrames = new Map();
      for (const session of this.sessions.values()) {
        if (!session.user || session.ws === ignoreWs || !this.isCurrentSession(session) ||
            session.ws.readyState !== WebSocket.OPEN || !this.canDeliverBotEvent(session, message) ||
            (canSend && !canSend())) continue;
        if (await this.pollService?.canView(session.user.id, privatePoll) && isCurrent() &&
            this.isCurrentSession(session)) this.send(session.ws, message, frames);
      }
      return;
    }
    const channel = await this.channelService.getChannelSummary(channelId);
    if (!channel || !isCurrent()) return;
    if (channel.type === 'FORUM' || channel.forumId) {
      await this.broadcastForumActivity(channelId, [message], ignoreWs, isCurrent);
      return;
    }
    // Departures and closed producers never come this way: they go out at once
    // (VoiceSessionHandler.announceVoiceDeparture, SfuSignalingHandler.notifyProducersClosed).
    const isVoiceEvent = message.type === MessageType.VOICE_USER_JOINED || message.type === MessageType.VOICE_STATE_CHANGED;
    await this.broadcastToChannelAudience(channel, message, ignoreWs, isCurrent, isVoiceEvent ? channelId : undefined);
  }

  private privatePollForMessage(message: ServerMessage): import('../../domain/entities').NativePollRecord | undefined {
    if (!this.pollService) return undefined;
    const payload = message.payload;
    if (typeof payload !== 'object' || payload === null) return undefined;
    let messageId: string | undefined;
    let pollId: string | undefined;
    if (message.type === MessageType.CHAT_MESSAGE && 'id' in payload && typeof payload.id === 'string') {
      messageId = payload.id;
    } else if (message.type === MessageType.CHAT_MESSAGE_UPDATED && 'message' in payload &&
        typeof payload.message === 'object' && payload.message !== null &&
        'id' in payload.message && typeof payload.message.id === 'string') {
      messageId = payload.message.id;
    } else if ((message.type === MessageType.CHAT_REACTION_ADDED ||
        message.type === MessageType.CHAT_REACTION_REMOVED) &&
        'messageId' in payload && typeof payload.messageId === 'string') {
      messageId = payload.messageId;
    } else if (message.type === MessageType.POLL_UPDATED && 'id' in payload && typeof payload.id === 'string') {
      pollId = payload.id;
    }
    const poll = pollId
      ? this.pollService.repository.findById(pollId)
      : messageId ? this.pollService.repository.findByMessageId(messageId) : undefined;
    return poll?.audience.visibility === 'private' ? poll : undefined;
  }

  /**
   * Brings every client's channel list back in sync with what it is allowed to
   * see (#384), pushing only the difference: channels that just became visible
   * arrive as CHANNEL_CREATED, ones that no longer are leave as CHANNEL_DELETED.
   * `refreshChannels` also resends channels whose rows changed to whoever keeps
   * seeing them: `true` all of them, a set only those.
   *
   * A bot that loses access while sitting in a voice channel is disconnected
   * from it. A person stays: VIEW_CHANNEL only gates finding a room and joining
   * it by oneself, so they keep seeing the room until they leave.
   */
  private async reconcileChannelVisibility(refreshChannels: ChannelRefresh = false): Promise<void> {
    this.botSettingsPermissionVersion++;
    this.botScreenAccessVersion++;
    const accessVersion = this.botSettingsPermissionVersion;
    await this.botScreens?.revokeInvalid();
    const channels = await this.channelService.listChannels();
    const categories = await this.channelService.listCategories();
    const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
    const afkChannelId = await this.channelService.getAfkChannelId();

    const contexts = new Map<string, ChannelAccessContext>();
    const userIds = new Set<string>();
    const grantCreators = new Set<string>();
    const members = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.user) userIds.add(session.user.id);
      if (session.botVoiceGrant) {
        userIds.add(session.botVoiceGrant.creatorUserId);
        grantCreators.add(session.botVoiceGrant.creatorUserId);
      }
    }
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        contexts.set(userId, await this.channelService.getAccessContext(userId));
        if (grantCreators.has(userId) && await this.userService.isMember(userId)) members.add(userId);
      })
    );
    this.botInteractions.reconcileAccess(channelsById, contexts);

    if (accessVersion === this.botSettingsPermissionVersion) for (const session of this.sessions.values()) {
      const grant = session.botVoiceGrant;
      if (!grant || !session.sessionId) continue;
      const creator = contexts.get(grant.creatorUserId);
      const bot = session.user && contexts.get(session.user.id);
      const voice = channelsById.get(grant.channelId);
      const origin = channelsById.get(grant.originChannelId);
      const valid = members.has(grant.creatorUserId) && creator && bot &&
        hasPermission(bot.permissions, Permission.SPEAK) &&
        voice?.type === 'VOICE' && (origin?.type === 'TEXT' || origin?.type === 'VOICE') && origin.botCommandsEnabled &&
        hasChannelPermission(voice, creator.permissions, creator.roleIds, Permission.SPEAK, false, creator.userId) &&
        hasChannelPermission(origin, creator.permissions, creator.roleIds, Permission.SEND_MESSAGES, false, creator.userId) &&
        hasChannelPermission(origin, creator.permissions, creator.roleIds, Permission.USE_BOT_COMMANDS, false, creator.userId);
      if (valid) grant.accessVersion = accessVersion;
      else {
        session.botVoiceGrant = undefined;
        this.voiceSessions.evictFromVoiceChannel(session.sessionId, grant.channelId);
      }
    }

    await this.botLocalExecution.reconcileAccess();
    for (const [ws, session] of this.sessions.entries()) {
      if (!session.user || ws.readyState !== WebSocket.OPEN) continue;

      const context = contexts.get(session.user.id);
      if (!context) continue;

      const nowVisible = this.visibleChannelIdsFor(channels, context);
      if (!session.isBot) session.voicePresenceKey = this.voicePresenceKey(session.user.id);
      this.sendChannelVisibility(session, nowVisible, channels, categories, context, refreshChannels, (channelId) => {
        if (session.sessionId && !this.hasBotVoiceGrant(session, channelId)) this.voiceSessions.evictFromVoiceChannel(session.sessionId, channelId);
      });

      const voiceState = session.sessionId && this.signalingService.getVoiceState(session.sessionId);
      const voiceChannel = voiceState && channelsById.get(voiceState.channelId);
      if (voiceState && voiceChannel && !this.hasBotVoiceGrant(session, voiceState.channelId)) {
        const rules = this.channelService.rulesFor(voiceChannel, context);
        const canView = hasChannelPermission(rules, context.permissions, context.roleIds, Permission.VIEW_CHANNEL, context.isBot, context.userId);
        const canSpeak = hasChannelPermission(rules, context.permissions, context.roleIds, Permission.SPEAK, context.isBot, context.userId);
        if (!canView || (session.isBot && !canSpeak)) {
          this.voiceSessions.evictFromVoiceChannel(voiceState.sessionId, voiceState.channelId);
        } else {
          const afkMuted = !session.isBot && voiceState.channelId === afkChannelId;
          const updated = await this.voiceSessions.applyPermissionMuted(voiceState.sessionId, !canSpeak || afkMuted);
          if (updated && updated !== voiceState) {
            await this.broadcastToChannel(updated.channelId, {
              type: MessageType.VOICE_STATE_CHANGED,
              payload: { voiceState: updated } satisfies VoiceStateChangedPayload,
            }, undefined, () => this.signalingService.getVoiceState(updated.sessionId) === updated);
          }
        }
      }
    }
  }

  private voiceMembershipChanged(): void {
    // Voice admission grants track ACL changes only. A participant moving must
    // revoke viewer/command context without invalidating the bot's media grant.
    this.botScreenAccessVersion++;
    this.botLocalExecution.voiceChanged();
    this.botInteractions.voiceChanged();
    void this.botScreens?.revokeInvalid()
      .catch((error: unknown) => Logger.error('BOT', 'Failed to reconcile voice miniapp access.', error));
    void this.syncVoicePresenceVisibility();
  }

  private voicePresenceKey(userId: string): string {
    return [...this.voiceSessions.voicePresenceChannelIds(userId)].sort().join('\n');
  }

  private visibleChannelIdsFor(channels: readonly ChannelSummary[], context: ChannelAccessContext): Set<string> {
    return new Set(channels
      .filter((channel) => canAccessChannel(this.channelService.rulesFor(channel, context),
        context.permissions, context.roleIds, context.isBot, context.userId))
      .map((channel) => channel.id));
  }

  /**
   * Sends one connection the difference between the channels it was told about
   * and `nowVisible` (#384). A voice room it is shown comes with whoever is
   * inside. `beforeRemoval` runs before a channel is withdrawn, so a voice
   * eviction still reaches the client while it knows the room, and whoever is
   * still inside is then withdrawn with it. Its categories go only when they
   * differ from the ones it already has (S-WS-4).
   */
  private sendChannelVisibility(
    session: ClientSession,
    nowVisible: Set<string>,
    channels: readonly ChannelSummary[],
    categories: readonly ChannelCategory[],
    context: ChannelAccessContext,
    refreshChannels: ChannelRefresh,
    beforeRemoval?: (channelId: string) => void,
  ): void {
    const previouslyVisible = session.visibleChannelIds ?? new Set<string>();
    const visibleCategories = categories.filter((category) =>
      canAccessChannel(category, context.permissions, context.roleIds, context.isBot, context.userId) ||
      channels.some((channel) => channel.categoryId === category.id && nowVisible.has(channel.id)));
    const categoriesKey = JSON.stringify(visibleCategories);
    if (session.categoriesKey !== categoriesKey) {
      session.categoriesKey = categoriesKey;
      this.send(session.ws, {
        type: MessageType.CATEGORIES_UPDATED,
        payload: { categories: visibleCategories },
      });
    }

    const refreshed = (channelId: string) =>
      refreshChannels === true || (refreshChannels !== false && refreshChannels.has(channelId));
    for (const channel of channels) {
      if (!nowVisible.has(channel.id) || (previouslyVisible.has(channel.id) && !refreshed(channel.id))) continue;
      const listed = previouslyVisible.has(channel.id);
      this.send(session.ws, {
        type: listed ? MessageType.CHANNEL_UPDATED : MessageType.CHANNEL_CREATED,
        payload: { channel } as ChannelCreatedPayload,
      });
      if (!listed && channel.type === 'VOICE') this.voiceSessions.roomListed(session, channel.id);
    }

    for (const channelId of previouslyVisible) {
      if (nowVisible.has(channelId)) continue;
      beforeRemoval?.(channelId);
      this.voiceSessions.roomWithdrawn(session, channelId);
      this.send(session.ws, {
        type: MessageType.CHANNEL_DELETED,
        payload: { channelId } as ChannelDeletedPayload,
      });
    }
    session.visibleChannelIds = nowVisible;
  }

  /**
   * Lists the voice room a person is inside even when their own access would
   * not, and withdraws it once they leave. One pass runs at a time, so the
   * deltas sent to a connection never interleave.
   */
  private syncVoicePresenceVisibility(): Promise<void> {
    // Being in a room is access (rulesFor), and every change to it comes through
    // here, including a return or reconnect grant that lapses or is withdrawn
    // while its holder is offline. Miniapps recheck now, as on voice membership.
    this.botScreenAccessVersion++;
    void this.botScreens?.revokeInvalid()
      .catch((error: unknown) => Logger.error('BOT', 'Failed to reconcile voice miniapp access.', error));
    const run = (this.voicePresenceSync ?? Promise.resolve()).then(() => this.applyVoicePresenceVisibility());
    this.voicePresenceSync = run.catch((error: unknown) => Logger.error('NETWORK', 'Failed to sync voice room visibility.', error));
    return this.voicePresenceSync;
  }

  private async applyVoicePresenceVisibility(): Promise<void> {
    const stale = [...this.sessions.values()].filter((session) => !!session.user && !session.isBot &&
      !!session.visibleChannelIds && session.voicePresenceKey !== this.voicePresenceKey(session.user.id));
    if (this.closing || stale.length === 0) return;
    const [channels, categories] = await Promise.all([this.channelService.listChannels(), this.channelService.listCategories()]);
    const contexts = new Map<string, ChannelAccessContext>();
    for (const session of stale) {
      const userId = session.user?.id;
      if (!userId || !this.isCurrentSession(session)) continue;
      const context = contexts.get(userId) ?? await this.channelService.getAccessContext(userId);
      contexts.set(userId, context);
      if (!this.isCurrentSession(session)) continue;
      const previouslyVisible = session.visibleChannelIds ?? new Set<string>();
      const nowVisible = this.visibleChannelIdsFor(channels, context);
      session.voicePresenceKey = this.voicePresenceKey(userId);
      if (nowVisible.size === previouslyVisible.size && [...nowVisible].every((id) => previouslyVisible.has(id))) continue;
      this.sendChannelVisibility(session, nowVisible, channels, categories, context, false);
    }
  }

  /** A person signing in while inside a room they cannot see by themselves still gets it listed. */
  private async includeVoicePresenceChannels(
    userId: string, details: { channels: ChannelSummary[]; categories?: ChannelCategory[] },
  ): Promise<void> {
    const missing = [...this.voiceSessions.voicePresenceChannelIds(userId)].filter((id) => !details.channels.some((channel) => channel.id === id));
    if (missing.length === 0) return;
    const [channels, categories] = await Promise.all([this.channelService.listChannels(), this.channelService.listCategories()]);
    for (const channel of channels) {
      if (!missing.includes(channel.id)) continue;
      details.channels.push(channel);
      const category = categories.find((entry) => entry.id === channel.categoryId);
      if (category && !details.categories?.some((entry) => entry.id === category.id)) {
        details.categories = [...(details.categories ?? []), category];
      }
    }
  }

  private disconnectBotScreens(session: BotInteractionSession): void {
    this.botScreenAccessVersion++;
    const screens = this.botScreens;
    if (!screens) return;
    void screens.disconnect(session).then(() => screens.revokeInvalid())
      .catch((error: unknown) => Logger.error('BOT', 'Failed to clean up disconnected bot screens.', error));
  }

  private async handleGetServerInviteInfo(session: ClientSession, requestId?: string): Promise<void> {
    try {
      const server = await this.serverRepo.getServer();
      const addr = this.server.address();
      const port = addr && typeof addr === 'object' ? addr.port : LIMITS.DEFAULT_PORT;
      const networkInterfaces = await scanServerNetworkInterfaces();

      this.send(session.ws, {
        type: MessageType.SERVER_INVITE_INFO,
        requestId,
        payload: {
          port,
          serverName: server?.name || 'Monky Server',
          networkInterfaces,
        },
      });
    } catch (err: any) {
      Logger.error('NETWORK', 'Error generating server invite info', err);
      this.sendError(
        session.ws,
        ProtocolErrorCode.INTERNAL_ERROR,
        'Erro ao obter informações de convite do servidor',
        requestId
      );
    }
  }

  /** Answers an error a handler caught: a service's refusal as worded, anything else logged and in general terms. */
  private sendCaughtError(ws: WebSocket, error: unknown, failure: UnexpectedFailure, requestId?: string): void {
    const { code, message } = toProtocolError(error, failure);
    this.sendError(ws, code, message, requestId);
  }

  public sendError(
    ws: WebSocket,
    code: ProtocolErrorCode,
    message: string,
    requestId?: string,
    serverProtocolVersion?: number
  ): void {
    const payload: ServerErrorPayload = { code, message, requestId, serverProtocolVersion };
    this.send(ws, {
      type: MessageType.SERVER_ERROR,
      requestId,
      payload,
    });
  }

  public close(reason: ServerShutdownReason = 'stopped'): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.shutdownReason = reason;
      this.botLocalExecution.close();
      this.gameShareRequests.dispose();
      this.serverMonitor?.close();
      this.serverAudit?.close();
      this.botStorage?.close();
      this.messageSearch?.close();
      this.shutdownResources.defer('server community', () => this.community?.close());
      this.signalingService.setVoiceMembershipListener(undefined);
      this.channelService.setVoicePresence(() => false);
      this.signalingService.configureScreenAccess(() => null, undefined);
      this.permissionService.setRoleMutationListener(undefined);
      for (const session of this.sessions.values()) {
        session.botVoiceJoinAttempt = undefined;
        session.botVoiceGrant = undefined;
      }
      const pending = [this.sfuStartup, this.settingsUpdateQueue, this.botSettingsBroadcasts,
        ...[...this.sessions.values()].map(session => session.messageQueue)];
      this.shutdownResources.defer('SFU runtime', () => this.sfuManager.close());
      this.shutdownResources.defer('voice state', () => {
        for (const sessionId of Object.keys(this.signalingService.getAllVoiceStates())) {
          this.signalingService.leaveVoiceChannel(sessionId);
        }
      });
      this.shutdownResources.defer('pending WebSocket work', async () => { await Promise.allSettled(pending); });
      this.shutdownResources.defer('WebSocket transport', () => this.closeTransport());
      this.shutdownResources.defer('bot selectors', () => this.botSelectors?.close());
      this.shutdownResources.defer('bot screens', () => this.botScreens?.close());
      this.shutdownResources.defer('bot interactions', () => this.botInteractions.close());
      this.shutdownResources.defer('WebSocket timers', () => {
        this.voiceSessions.close();
        for (const session of this.sessions.values()) this.settleAnonymous(session);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();
      });
    }
    return this.shutdownResources.close();
  }

  private closeTransport(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Give peers time to receive SERVER_SHUTDOWN, but never keep upgraded
      // sockets alive for ws's default 30-second close timeout.
      const forceClose = setTimeout(() => {
        try {
          this.terminatePeers();
        } catch (error) {
          reject(error);
        }
      }, LIMITS.SHUTDOWN_GRACE_MS);
      forceClose.unref?.();
      try {
        this.broadcast({
          type: MessageType.SERVER_SHUTDOWN,
          payload: { reasonCode: this.shutdownReason } satisfies ServerShutdownPayload,
        });
        for (const ws of this.openSockets()) ws.close();
        this.wss.close((error) => {
          clearTimeout(forceClose);
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        clearTimeout(forceClose);
        try {
          this.terminatePeers();
        } catch (cleanupError) {
          reject(new AggregateError([error, cleanupError], `WebSocket shutdown failed: ${describeFailure(error)}; ${describeFailure(cleanupError)}`));
          return;
        }
        reject(error);
      }
    });
  }

  /**
   * Every socket still open: the registered ones, and the ones already let go
   * — replaced, kicked, revoked — whose close handshake has not finished.
   * `wss.close()` waits for all of them, so shutdown has to end them all.
   */
  private openSockets(): Set<WebSocket> {
    return new Set([...this.sessions.keys(), ...this.wss.clients]);
  }

  private terminatePeers(): void {
    const errors: unknown[] = [];
    for (const ws of this.openSockets()) {
      try {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to terminate WebSocket peers: ${errors.map(describeFailure).join('; ')}`);
    }
  }
}
