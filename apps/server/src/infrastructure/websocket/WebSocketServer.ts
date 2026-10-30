import http from 'http';
import { WebSocket, WebSocketServer as WSServer } from 'ws';
import {
  hasChannelPermission,
  LIMITS,
  MessageType,
  Permission,
  ProtocolErrorCode,
  ProtocolMessage,
  type ServerMessage,
  ServerErrorPayload,
  ServerShutdownPayload,
  ServerShutdownReason,
  UserLeftPayload,
  UserConnectionStatePayload,
  UserSummary,
  BotRevokedPayload,
  WebRtcSignalPayload,
  canAccessChannel,
  hasPermission,
  localBotIdentitySchema,
  localOperationNegotiated,
  type BotCapability,
} from '@monky/shared';
import { AuthService } from '../../application/services/AuthService';
import { AttachmentService } from '../../application/services/AttachmentService';
import { ChannelService } from '../../application/services/ChannelService';
import { ChatService } from '../../application/services/ChatService';
import { PermissionService } from '../../application/services/PermissionService';
import { RoleService } from '../../application/services/RoleService';
import { BotService } from '../../application/services/BotService';
import { BotDiagnosticService } from '../../application/services/BotDiagnosticService';
import { BOT_CHAT_EVENTS } from './botCapabilityPolicy';
import { BotSettingsService } from '../../application/services/BotSettingsService';
import { BotSelectorError, BotSelectorService } from '../../application/services/BotSelectorService';
import { BotSelectorHandler } from './BotSelectorHandler';
import { BotScreenHandler } from './BotScreenHandler';
import { BotScreenService } from '../../application/services/BotScreenService';
import { BotStorageHandler } from './BotStorageHandler';
import type { BotStorageService } from '../../application/services/BotStorageService';
import type { ServerMonitorService } from '../../application/services/ServerMonitorService';
import { ServerMonitorHandler } from './ServerMonitorHandler';
import { auditRef, type ServerAuditService } from '../../application/services/ServerAuditService';
import { ServerAuditHandler } from './ServerAuditHandler';
import { CommandRegistry } from '../../application/services/CommandRegistry';
import { BotLocalExecutionService } from '../../application/services/BotLocalExecutionService';
import { SignalingService } from '../../application/services/SignalingService';
import { UserService } from '../../application/services/UserService';
import { DmRelayService } from '../../application/services/DmRelayService';
import { GameShareRequestService } from '../../application/services/GameShareRequestService';
import { NativePollService } from '../../application/services/NativePollService';
import { projectLegacyPolls } from './pollProjection';
import { projectLegacyForwards } from './forwardProjection';
import { IServerRepository } from '../../domain/repositories';
import { CoturnManager } from '../turn/CoturnManager';
import { SfuManager } from '../sfu/SfuManager';
import { Logger } from '../logger/Logger';
import { RateLimiter } from '../security/RateLimiter';
import { describeFailure, ServerResourceScope } from '../lifecycle/ServerResourceScope';
import { BotInteractionHandler, BotInteractionSession } from './BotInteractionHandler';
import { clientAddress, DISCARDABLE_MESSAGES, WS_FLOW_LIMITS, type WsFlowLimits } from './flowControl';
import { type ClientSession, type SignedInSession } from './ClientSession';
import { toProtocolError, type UnexpectedFailure } from './protocolErrors';
import { RtcSignalRelay, type RtcSignalHost } from './voice/RtcSignalRelay';
import { ScreenAccessCoordinator, type ScreenAccessHost } from './voice/ScreenAccessCoordinator';
import { SfuSignalingHandler, type SfuSignalingHost } from './voice/SfuSignalingHandler';
import { VoiceSessionHandler, type VoiceSessionHost } from './voice/VoiceSessionHandler';
import { requestHostname, requestServerUrl } from './requestAddress';
import { AuditRecorder, type AuditRecorderHost } from './AuditRecorder';
import { Outbox, type FanOutFrames, type OutboxHost } from './Outbox';
import { AccessEpoch } from './access/AccessEpoch';
import { Authorizer, type AuthorizerHost } from './access/Authorizer';
import { MessageRouter, route, type Route, type RouterHost } from './routing/MessageRouter';
import { PollHandler, type PollHost } from './PollHandler';
import { ChatHandler, type ChatHost } from './ChatHandler';
import { ChannelHandler, type ChannelHost } from './ChannelHandler';
import { PresenceHandler, type PresenceHost } from './PresenceHandler';
import { RoleHandler, type RoleHost } from './RoleHandler';
import { ServerSettingsHandler, type ServerSettingsHost } from './ServerSettingsHandler';
import { SoundboardHandler, type SoundboardHost } from './SoundboardHandler';
import { BotManagementHandler, type BotManagementHost } from './BotManagementHandler';
import { AuthHandler, type AuthHost } from './AuthHandler';
import { ChannelVisibility, type ChannelVisibilityHost } from './access/ChannelVisibility';
import { CommunityHandler } from './CommunityHandler';
import { MessageSearchHandler } from './MessageSearchHandler';
import type { CommunityService } from '../../application/services/CommunityService';
import type { MessageSearchService } from '../../application/services/MessageSearchService';
import { ForumHandler } from './ForumHandler';
import type { ForumService } from '../../application/services/ForumService';
import type { RecentSoundCacheService } from '../../application/services/RecentSoundCacheService';

/** What the WebSocket server is built from. Optional services leave their features unavailable. */
export interface WebSocketServerDeps {
  httpServer: http.Server;
  authService: AuthService;
  userService: UserService;
  channelService: ChannelService;
  chatService: ChatService;
  signalingService: SignalingService;
  serverRepo: IServerRepository;
  attachmentService: AttachmentService;
  permissionService: PermissionService;
  roleService: RoleService;
  coturnManager: CoturnManager;
  rateLimiter: RateLimiter;
  /** A manager of its own when not given. */
  sfuManager?: SfuManager;
  botService?: BotService;
  /** A registry of its own when not given. */
  commandRegistry?: CommandRegistry;
  selectorService?: BotSelectorService;
  botSettings?: BotSettingsService;
  monitorService?: ServerMonitorService;
  serverVersion?: string | null;
  communityService?: CommunityService;
  messageSearchService?: MessageSearchService;
  forumService?: ForumService;
  pollService?: NativePollService;
  recentSoundCache?: RecentSoundCacheService;
  audit?: ServerAuditService;
  botStorageService?: BotStorageService;
}

/** What the modules of the server use of it, each through its own part of it. */
type ServerHost = AuditRecorderHost & OutboxHost & AuthorizerHost & RouterHost & ChannelVisibilityHost
  & AuthHost & ChatHost & PollHost & ChannelHost & PresenceHost & RoleHost & ServerSettingsHost & SoundboardHost & BotManagementHost
  & ScreenAccessHost & RtcSignalHost & SfuSignalingHost & VoiceSessionHost;

/**
 * The WebSocket side of a Monky server. It accepts connections and keeps the
 * registry of who is connected, with the grace of those who dropped and may
 * come back, and lets every connection go through releaseConnection(). Each
 * message goes through the MessageRouter to the module of its domain, and every
 * module sends through this server, so all of them share one transport.
 */
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
  private botInteractions: BotInteractionHandler;
  private readonly botDiagnostics?: BotDiagnosticService;
  private botLocalExecution: BotLocalExecutionService<BotInteractionSession>;
  private botSelectors?: BotSelectorHandler;
  private botScreens?: BotScreenHandler;
  private readonly botStorage?: BotStorageHandler<ClientSession>;
  private readonly serverMonitor?: ServerMonitorHandler;
  private readonly serverAudit?: ServerAuditHandler;
  private readonly community?: CommunityHandler;
  private readonly messageSearch?: MessageSearchHandler;
  private readonly forum?: ForumHandler;
  private shutdownReason: ServerShutdownReason = 'stopped';
  private dmRelay: DmRelayService<ClientSession>;
  private gameShareRequests: GameShareRequestService<ClientSession>;
  private screenAccess?: ScreenAccessCoordinator;
  private rtcSignalRelay?: RtcSignalRelay;
  private sfuSignalingHandler?: SfuSignalingHandler;
  private voiceSessionHandler?: VoiceSessionHandler;
  private serverHost?: ServerHost;
  private auditRecorder?: AuditRecorder;
  private audiences?: Outbox;
  private accessEpoch?: AccessEpoch;
  private accessAuthorizer?: Authorizer;
  private messageRouter?: MessageRouter;
  private pollHandler?: PollHandler;
  private chatHandler?: ChatHandler;
  private channelHandler?: ChannelHandler;
  private channelVisibility?: ChannelVisibility;
  private presenceHandler?: PresenceHandler;
  private roleHandler?: RoleHandler;
  private serverSettingsHandler?: ServerSettingsHandler;
  private soundboardHandler?: SoundboardHandler;
  private botManagementHandler?: BotManagementHandler;
  private authHandler?: AuthHandler;

  private httpServer: http.Server;
  private authService: AuthService;
  private userService: UserService;
  private channelService: ChannelService;
  private chatService: ChatService;
  private signalingService: SignalingService;
  private serverRepo: IServerRepository;
  private attachmentService: AttachmentService;
  private permissionService: PermissionService;
  private roleService: RoleService;
  private coturnManager: CoturnManager;
  private rateLimiter: RateLimiter;
  private sfuManager: SfuManager;
  private botService?: BotService;
  private commandRegistry: CommandRegistry;
  private botSettings?: BotSettingsService;
  private readonly serverVersion: string | null;
  private readonly communityService?: CommunityService;
  private readonly forumService?: ForumService;
  private readonly pollService?: NativePollService;
  private readonly recentSoundCache?: RecentSoundCacheService;
  private readonly audit?: ServerAuditService;

  constructor(deps: WebSocketServerDeps) {
    this.httpServer = deps.httpServer;
    this.authService = deps.authService;
    this.userService = deps.userService;
    this.channelService = deps.channelService;
    this.chatService = deps.chatService;
    this.signalingService = deps.signalingService;
    this.serverRepo = deps.serverRepo;
    this.attachmentService = deps.attachmentService;
    this.permissionService = deps.permissionService;
    this.roleService = deps.roleService;
    this.coturnManager = deps.coturnManager;
    this.rateLimiter = deps.rateLimiter;
    this.sfuManager = deps.sfuManager ?? new SfuManager();
    this.botService = deps.botService;
    this.commandRegistry = deps.commandRegistry ?? new CommandRegistry();
    this.botSettings = deps.botSettings;
    this.serverVersion = deps.serverVersion ?? null;
    this.communityService = deps.communityService;
    this.forumService = deps.forumService;
    this.pollService = deps.pollService;
    this.recentSoundCache = deps.recentSoundCache;
    this.audit = deps.audit;
    // Built before anything else starts: a message type answered by two routes
    // stops the server here, instead of on the first frame a client sends.
    this.messageRouter = this.buildRouter();
    const {
      botService, rateLimiter, audit, communityService, forumService, channelService,
      selectorService, monitorService, messageSearchService, botStorageService,
    } = deps;
    if (botService) this.botDiagnostics = new BotDiagnosticService(botService, rateLimiter);
    if (botService && botStorageService) {
      this.botStorage = new BotStorageHandler<ClientSession>(botStorageService, {
        isCurrent: (session) => session.isBot
          ? this.isCurrentBotOperation(session, 'server_storage') : this.isCurrentSession(session),
        send: (session, message) => this.send(session.ws, message),
        permissions: (botId) => this.botService?.permissions?.get(botId),
        authorizeManagement: (session, requestId) => this.botManagement.authorizeManagement(session, requestId),
        canManage: (session) => this.botManagement.canManageBots(session),
        audit: async (session, botId, changes) => {
          if (!this.audit) return;
          const bot = await this.botService?.findById(botId);
          this.auditLog.record(session, 'bot.storage', { target: auditRef.bot(botId, bot?.name ?? botId), changes });
        },
      });
      botStorageService.setLevelListener((botId, usage) => this.botManagement.broadcastStorageLevel(botId, usage));
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
      accessVersion: () => this.accessVersion(),
      botSession: id => this.findSessionById(`bot:${id}`),
      authorizeInvocation: (session, invocationId, channelId) => this.botInteractions.authorizeSelector(session, invocationId, channelId),
      send: (session, message) => this.send(session.ws, message),
      pollUpdated: poll => this.broadcastToChannel(poll.channelId, {
        type: MessageType.POLL_UPDATED,
        payload: poll,
      }),
      audit: async (session, action, input) => {
        if (!this.audit) return;
        this.auditLog.record(session, action, {
          target: input.target,
          related: {
            channel: await this.auditLog.channel(input.channelId),
            invoker: input.invokerId ? await this.auditLog.identity(input.invokerId) : null,
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
      version: () => this.accessVersion(),
      send: (session, message) => this.send(session.ws, message),
      changed: async result => {
        if (result.deleted) {
          this.botLocalExecution.deleteChannel(result.post.channelId);
          this.botInteractions.deleteChannel(result.post.channelId);
        }
        // A topic is a channel: a new or deleted one reaches each member as the
        // difference, an edited one is the only channel resent (S-WS-4).
        await this.visibility.reconcile(result.deleted ? false : new Set([result.post.channelId]));
        const activity: ServerMessage[] = [{ type: MessageType.FORUM_POST_SAVED, payload: result }];
        if (result.message) activity.push({ type: MessageType.CHAT_MESSAGE, payload: result.message });
        await this.outbox.forumActivity(result.post.forumId, activity);
      },
      audit: async (session, action, post, changes) => {
        if (!this.audit) return;
        this.auditLog.record(session, action, {
          target: auditRef.of('post', post.channelId, post.title),
          related: { channel: await this.auditLog.channel(post.forumId), author: await this.auditLog.identity(post.authorId) },
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
        accessVersion: () => this.epoch.generation,
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
      publishResponse: (session, response, canSend, requestId) => this.chatMessages.publishBotResponse(session, response, canSend, requestId),
      resolveImageAssets: (userId, channelId, refs) => {
        if (!this.communityService) throw new Error('Community media is unavailable.');
        return this.communityService.resolveImageAssets(refs, userId, channelId);
      },
      localContextEnded: (context, cause) => this.botLocalExecution.contextEnded(context, cause),
      consumeLocalPreview: (bot, origin, contextId, requestId, result) =>
        this.botLocalExecution.consumePreview(bot, origin, contextId, requestId, result),
      commandInvoked: (session, command, channelId, options) => this.auditLog.command(session, command, channelId, options),
    }, this.channelService, this.userService, this.commandRegistry, this.botSettings,
      async () => (await this.serverRepo.getServer())?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH);
    this.botLocalExecution = new BotLocalExecutionService({
      isCurrent: (session) => this.isCurrentBotOperation(session, 'local_execution'),
      negotiated: (session, operation) => localOperationNegotiated(operation, session.protocol?.features),
      accessVersion: () => {
        const version = this.accessVersion();
        return version === null ? null : String(version);
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
        accessVersion: () => this.epoch.miniapps,
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
        accessVersion: () => this.epoch.generation,
        send: (session, message) => this.send(session.ws, message),
      });
    }
    this.signalingService.setVoiceMembershipListener(() => this.voiceMembershipChanged());
    this.channelService.setVoicePresence((userId, channelId) => this.voiceSessions.voicePresenceChannelIds(userId).has(channelId));
    this.wss = new WSServer({ server: this.httpServer, maxPayload: LIMITS.WS_MAX_PAYLOAD_BYTES });
    this.setupWss();
    this.startHeartbeat();
    this.sfuStartup = this.sfuSignaling.initSfuIfConfigured();
  }

  /** Screens: who may receive which one, and what each connection is told of them. */
  private get screens(): ScreenAccessCoordinator {
    return this.screenAccess ??= new ScreenAccessCoordinator(this.host);
  }

  /** P2P signals between the participants of a room. */
  private get rtcSignals(): RtcSignalRelay {
    return this.rtcSignalRelay ??= new RtcSignalRelay(this.host);
  }

  /** Media through the SFU, for calls on a server in SFU mode. */
  private get sfuSignaling(): SfuSignalingHandler {
    return this.sfuSignalingHandler ??= new SfuSignalingHandler(this.host);
  }

  /** Who is in which voice room, and every way in and out of one. */
  private get voiceSessions(): VoiceSessionHandler {
    return this.voiceSessionHandler ??= new VoiceSessionHandler(this.host);
  }

  /**
   * Every message a connection sends, through the same checks, to the handler of
   * its type (S-WS-5). The constructor builds it; a server made without running
   * it, as white-box tests make one, builds it on first use.
   */
  private get router(): MessageRouter {
    return this.messageRouter ??= this.buildRouter();
  }

  /** Every route of the server. A type claimed twice throws here. */
  private buildRouter(): MessageRouter {
    return new MessageRouter(this.host).register(
      ...this.connectionRoutes(), ...this.authentication.routes(), ...this.chatMessages.routes(), ...this.polls.routes(), ...this.channelAdmin.routes(),
      ...this.presence.routes(), ...this.roleAdmin.routes(), ...this.serverSettings.routes(), ...this.soundboard.routes(),
      ...this.botManagement.routes(), ...this.callRoutes(), ...this.featureRoutes(), ...this.botRoutes());
  }

  /** Which channels each connection is told about (#384). */
  private get visibility(): ChannelVisibility {
    return this.channelVisibility ??= new ChannelVisibility(this.host);
  }

  /** Creating, editing, reordering and deleting channels and categories. */
  private get channelAdmin(): ChannelHandler {
    return this.channelHandler ??= new ChannelHandler(this.host);
  }

  /** Signing in, for people and bots. */
  private get authentication(): AuthHandler {
    return this.authHandler ??= new AuthHandler(this.host);
  }

  /** Bots as the server administers them, with their commands and settings. */
  private get botManagement(): BotManagementHandler {
    return this.botManagementHandler ??= new BotManagementHandler(this.host);
  }

  /** Sounds played to a call, and the cache of the recent ones. */
  private get soundboard(): SoundboardHandler {
    return this.soundboardHandler ??= new SoundboardHandler(this.host);
  }

  /** The server's own settings, and the addresses an invitation can use. */
  private get serverSettings(): ServerSettingsHandler {
    return this.serverSettingsHandler ??= new ServerSettingsHandler(this.host);
  }

  /** Roles, who holds them, and expelling a member. */
  private get roleAdmin(): RoleHandler {
    return this.roleHandler ??= new RoleHandler(this.host);
  }

  /** How each person appears to everyone else. */
  private get presence(): PresenceHandler {
    return this.presenceHandler ??= new PresenceHandler(this.host);
  }

  /** Messages in a channel. */
  private get chatMessages(): ChatHandler {
    return this.chatHandler ??= new ChatHandler(this.host);
  }

  /** Native polls. */
  private get polls(): PollHandler {
    return this.pollHandler ??= new PollHandler(this.host);
  }

  /** Versions of who may access what, to notice access moving under work that awaited. */
  private get epoch(): AccessEpoch {
    return this.accessEpoch ??= new AccessEpoch();
  }

  /** Whether a member or bot may do something, answering the refusal itself when not. */
  private get authorizer(): Authorizer {
    return this.accessAuthorizer ??= new Authorizer(this.host);
  }

  /** Who receives what: the audience of every message the server sends. */
  private get outbox(): Outbox {
    return this.audiences ??= new Outbox(this.host);
  }

  /** What members and bots did, for the server's audit log. */
  private get auditLog(): AuditRecorder {
    return this.auditRecorder ??= new AuditRecorder(this.host);
  }

  /**
   * What the modules use of this server. Each member is read when used, and
   * the modules are built on first use, so they always act on the server's
   * current collaborators.
   */
  private get host(): ServerHost {
    if (this.serverHost) return this.serverHost;
    // The getters below have a `this` of their own.
    const server = this;
    this.serverHost = {
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
      get pollService() { return server.pollService; },
      get chat() { return server.chatService; },
      get attachments() { return server.attachmentService; },
      get communityService() { return server.communityService; },
      get community() { return server.community; },
      get auditLog() { return server.auditLog; },
      get epoch() { return server.epoch; },
      get outbox() { return server.outbox; },
      get visibility() { return server.visibility; },
      get screens() { return server.screens; },
      get channelAdmin() { return server.channelAdmin; },
      get httpServer() { return server.httpServer; },
      get auth() { return server.authService; },
      get coturn() { return server.coturnManager; },
      get recentSoundCache() { return server.recentSoundCache; },
      get voiceSessions() { return server.voiceSessions; },
      get botScreens() { return server.botScreens; },
      get botDiagnostics() { return server.botDiagnostics; },
      get botManagement() { return server.botManagement; },
      get presence() { return server.presence; },
      get roleAdmin() { return server.roleAdmin; },
      get dmRelay() { return server.dmRelay; },
      get serverVersion() { return server.serverVersion; },
      get botSettings() { return server.botSettings; },
      get botSelectors() { return server.botSelectors; },
      get commandRegistry() { return server.commandRegistry; },
      get botLocalExecution() { return server.botLocalExecution; },
      get forumService() { return server.forumService; },
      get botSettingsPermissionVersion() { return server.epoch.generation; },
      get closing() { return server.closing; },
      get rateLimiter() { return server.rateLimiter; },
      get authorizer() { return server.authorizer; },
      isRevoked: (session) => session.replaced === true || server.closing || server.sessions.get(session.ws) !== session,
      sessions: () => server.sessions.values(),
      sessionsOfUser: (userId) => server.getSessionsOfUser(userId),
      closeSessionsOfUser: (userId) => server.closeSessionsOfUser(userId),
      findSession: (sessionId) => server.findSessionById(sessionId),
      findSocket: (sessionId) => server.sessionSockets.get(sessionId),
      bindSocket: (sessionId, ws) => { server.sessionSockets.set(sessionId, ws); },
      replaceConnection: (ws) => server.replaceConnection(ws),
      endReconnectGrace: (sessionId) => server.endReconnectGrace(sessionId),
      settleAnonymous: (session) => server.settleAnonymous(session),
      isLive: (session) => server.isLive(session),
      captureAccess: () => server.captureAccess(),
      onlineUsers: () => server.getOnlineUsersMap(),
      isCurrentSession: (session) => server.isCurrentSession(session),
      captureChannelOperation: (session) => server.captureChannelOperation(session),
      isCurrentBotOperation: (session, ...capabilities) => server.isCurrentBotOperation(session, ...capabilities),
      requirePermission: (session, permission, requestId, channelId) =>
        server.authorizer.requirePermission(session, permission, requestId, channelId),
      requireChannelAccess: (session, channelId, requestId) => server.authorizer.requireChannelAccess(session, channelId, requestId),
      hasBotVoiceGrant: (session, channelId) => server.hasBotVoiceGrant(session, channelId),
      canDeliverBotEvent: (session, message) => server.canDeliverBotEvent(session, message),
      channelAccessVersion: () => server.getChannelAccessVersion(),
      canReceiveProducer: (session, channelId, producerId) => server.screens.canReceiveProducer(session, channelId, producerId),
      reconcileScreenAccess: () => server.screens.reconcileScreenAccess(),
      voiceRoster: (channelId, viewerUserId) => server.voiceSessions.getVoiceRoster(channelId, viewerUserId),
      syncVoicePresenceVisibility: () => server.visibility.syncVoicePresence(),
      recordAudit: (session, action, input) => server.auditLog.record(session, action, input),
      auditChannel: (channelId) => server.auditLog.channel(channelId),
      auditIdentity: (id) => server.auditLog.identity(id),
      send: (ws: WebSocket, message: ServerMessage, frames?: FanOutFrames) => server.send(ws, message, frames),
      sendError: (ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string, serverProtocolVersion?: number) =>
        server.sendError(ws, code, message, requestId, serverProtocolVersion),
      sendCaughtError: (ws, error, failure, requestId) => server.sendCaughtError(ws, error, failure, requestId),
      broadcastBotSettings: (changedBotId) => server.botManagement.broadcastSettings(changedBotId),
      disconnectBot: (botId, reason) => server.disconnectBot(botId, reason),
      publish: (messageFor, skip) => server.publish(messageFor, skip),
      broadcast: (message, ignoreWs) => server.broadcast(message, ignoreWs),
      broadcastToChannel: (channelId, message, ignoreWs, canSend) => server.broadcastToChannel(channelId, message, ignoreWs, canSend),
    };
    return this.serverHost;
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
        requestHost: requestHostname(req.headers.host),
        requestServerUrl: requestServerUrl(req),
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
    if (!this.router.isOrdered(type)) {
      void dispatch();
      return;
    }
    // Preserve wire order for mutations, including bot reply/finish sequences.
    session.messageQueue = session.messageQueue.then(dispatch);
  }

  /** Each message, through the router's checks, to the handler of its type. */
  private handleMessage(session: ClientSession, message: ProtocolMessage<unknown>): Promise<void> {
    return this.router.dispatch(session, message);
  }

  /** The connection itself: its heartbeat, signing out, and the DM relay. */
  private connectionRoutes(): Route[] {
    return [
      route({
        types: [MessageType.PING], anonymous: true,
        // TURN installation can hold the mutation queue for minutes. Heartbeats
        // cannot wait behind it: the desktop otherwise reconnects after 12 seconds.
        unordered: true,
        handle: ({ session, requestId }) => this.send(session.ws, { type: MessageType.PONG, requestId, payload: { timestamp: Date.now() } }),
      }),
      route({
        types: [MessageType.DM_RELAY_SEND], screensBots: true,
        handle: ({ session, payload, requestId }) => this.handleDmRelaySend(session, payload, requestId),
      }),
      route({
        types: [MessageType.USER_LOGOUT],
        // Graceful logout: mark the session so the disconnect handler treats it
        // as an intentional leave (immediate USER_LEFT, no reconnecting grace).
        handle: ({ session }) => {
          session.intentionalLogout = true;
          this.voiceSessions.dropReconnectGrant(session);
          void this.visibility.syncVoicePresence();
          this.botLocalExecution.disconnect(session);
          this.botInteractions.disconnect(session);
          this.disconnectBotScreens(session);
        },
      }),
    ];
  }

  /** Calls: voice rooms, their media through WebRTC or the SFU, screens, and asking someone to share a game. */
  private callRoutes(): Route[] {
    return [
      route({
        types: [
          MessageType.VOICE_JOIN, MessageType.VOICE_RECONNECT, MessageType.VOICE_LEAVE, MessageType.VOICE_STATE_UPDATE,
          MessageType.VOICE_AFK, MessageType.ADMIN_MUTE_USER, MessageType.ADMIN_DEAFEN_USER, MessageType.ADMIN_GET_VOICE_RESTRICTIONS,
          MessageType.ADMIN_KICK_VOICE, MessageType.ADMIN_MOVE_USER,
        ],
        handle: ({ session, type, payload, requestId }) => this.voiceSessions.handle(session, type, payload, requestId),
      }),
      route({
        types: [
          MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES, MessageType.SFU_CREATE_WEBRTC_TRANSPORT, MessageType.SFU_CONNECT_WEBRTC_TRANSPORT,
          MessageType.SFU_PRODUCE, MessageType.SFU_CONSUME, MessageType.SFU_PRODUCER_CLOSED, MessageType.SFU_PRODUCER_SET_PAUSED,
          MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, MessageType.SFU_GET_PRODUCERS, MessageType.SFU_CONSUMER_SET_PAUSED,
          MessageType.SFU_CONSUMER_CLOSED,
        ],
        handle: ({ session, type, payload, requestId }) => this.sfuSignaling.handle(session, type, payload, requestId),
      }),
      route({
        types: [MessageType.RTC_SIGNAL],
        handle: ({ session, payload, requestId }) => this.rtcSignals.handleRtcSignal(session, payload as WebRtcSignalPayload, requestId),
      }),
      route({
        types: [MessageType.RTC_DIAGNOSTICS_REPORT],
        handle: ({ session, payload }) => this.rtcSignals.handleRtcDiagnosticsReport(session, payload),
      }),
      route({
        types: [MessageType.NATIVE_SCREEN_SIGNAL],
        handle: ({ session, payload, requestId }) => this.screens.handleNativeScreenSignal(session, payload, requestId),
      }),
      route({
        types: [MessageType.SCREEN_VIEWERS_GET],
        handle: ({ session, payload, requestId }) => this.screens.handleScreenViewers(session, payload, requestId),
      }),
      route({
        types: [MessageType.GAME_SHARE_REQUEST],
        handle: ({ session, payload, requestId }) => {
          const error = this.gameShareRequests.request(session, payload, requestId);
          if (error) this.sendError(session.ws, error.code, error.message, requestId);
        },
      }),
      route({
        types: [MessageType.GAME_SHARE_RESPONSE],
        handle: ({ session, payload, requestId }) => {
          const error = this.gameShareRequests.respond(session, payload);
          if (error) this.sendError(session.ws, error.code, error.message, requestId);
        },
      }),
    ];
  }

  /**
   * The community features — the server's page, events, live actions and forms,
   * forums and message search — and the audit log and monitor of its
   * administrators. A server built without one answers that it is unavailable,
   * each with the code its clients have always received for it.
   */
  private featureRoutes(): Route[] {
    return [
      route({
        types: [
          MessageType.COMMUNITY_GET, MessageType.COMMUNITY_IMAGE_UPLOAD, MessageType.COMMUNITY_UPDATE_SETTINGS,
          MessageType.EVENT_SAVE, MessageType.EVENT_GET, MessageType.EVENT_GET_INTERESTED, MessageType.EVENT_CONTROL,
          MessageType.EVENT_INTEREST, MessageType.LIVE_ACTION_CREATE, MessageType.LIVE_ACTION_UPDATE, MessageType.LIVE_ACTION_CLOSE,
          MessageType.LIVE_ACTION_LIST, MessageType.LIVE_ACTION_SUBMIT, MessageType.NATIVE_FORM_CREATE, MessageType.NATIVE_FORM_SUBMIT,
          MessageType.NATIVE_FORM_CLOSE, MessageType.NATIVE_FORM_RESULTS,
        ],
        unavailable: { when: () => !this.community, message: 'Server community unavailable.' },
        handle: ({ session, type, payload, requestId }) => this.community?.handle(session, type, payload, requestId),
      }),
      route({
        types: [MessageType.FORUM_LIST, MessageType.FORUM_CREATE_POST, MessageType.FORUM_UPDATE_POST, MessageType.FORUM_DELETE_POST],
        unavailable: { when: () => !this.forum, message: 'Forums unavailable.' },
        handle: ({ session, type, payload, requestId }) => this.forum?.handle(session, type, payload, requestId),
      }),
      route({
        types: [MessageType.CHAT_SEARCH],
        unavailable: { when: () => !this.messageSearch, message: 'Message search unavailable.' },
        handle: ({ session, payload, requestId }) => this.messageSearch?.handle(session, payload, requestId),
      }),
      route({
        types: [MessageType.SERVER_AUDIT_GET],
        unavailable: { when: () => !this.serverAudit, message: 'The audit log is unavailable.' },
        handle: ({ session, payload, requestId }) => this.serverAudit?.handle(session, payload, requestId),
      }),
      route({
        types: [MessageType.SERVER_MONITOR_GET],
        unavailable: { when: () => !this.serverMonitor, code: ProtocolErrorCode.INTERNAL_ERROR, message: 'Server monitoring is unavailable.' },
        handle: ({ session, payload, requestId }) => this.serverMonitor?.handle(session, payload, requestId),
      }),
    ];
  }

  /**
   * What bots do through the server: their commands and every step of them, work
   * on a member's computer, programmable screens, storage and selectors.
   */
  private botRoutes(): Route[] {
    return [
      route({
        types: [MessageType.COMMAND_INVOKE],
        handle: async ({ session, payload, requestId }) => {
          if (this.botCommandsApproved(session, payload, requestId)) await this.botInteractions.invoke(session, payload, requestId);
        },
      }),
      route({
        types: [MessageType.COMMAND_AUTOCOMPLETE],
        handle: async ({ session, payload, requestId }) => {
          if (this.botCommandsApproved(session, payload, requestId)) await this.botInteractions.autocomplete(session, payload, requestId);
        },
      }),
      route({
        types: [MessageType.COMMAND_AUDIO_PREVIEW],
        handle: async ({ session, payload, requestId }) => {
          if (this.botCommandsApproved(session, payload, requestId)) await this.botInteractions.audioPreview(session, payload, requestId);
        },
      }),
      route({
        types: [MessageType.BOT_VOICE_CONTEXT],
        handle: ({ session, payload, requestId }) => this.botInteractions.getVoiceContext(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_AUTOCOMPLETE_RESULT],
        handle: ({ session, payload, requestId }) => this.botInteractions.autocompleteResult(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_AUTOCOMPLETE_CANCEL],
        handle: ({ session, payload, requestId }) => this.botInteractions.cancelAutocomplete(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_AUDIO_PREVIEW_RESULT],
        handle: ({ session, payload, requestId }) => this.botInteractions.audioPreviewResult(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_AUDIO_PREVIEW_CANCEL],
        handle: ({ session, payload, requestId }) => this.botInteractions.cancelAudioPreview(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_SOUND_DOWNLOAD],
        handle: ({ session, payload, requestId }) => this.botInteractions.downloadSound(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_SOUND_DOWNLOAD_RESULT],
        handle: ({ session, payload, requestId }) => this.botInteractions.downloadSoundResult(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_RESPONSE],
        handle: ({ session, payload, requestId }) => this.botInteractions.respond(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_PROMPT],
        handle: ({ session, payload, requestId }) => this.botInteractions.prompt(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_SUBMIT],
        handle: ({ session, payload, requestId }) => this.botInteractions.submit(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_CANCEL],
        handle: ({ session, payload, requestId }) => this.botInteractions.cancel(session, payload, requestId),
      }),
      route({
        types: [MessageType.COMMAND_FINISH],
        handle: ({ session, payload, requestId }) => this.botInteractions.complete(session, payload, requestId),
      }),
      // The bot policy admits only what a bot may send of these; the rest are a member's.
      route({
        types: [
          MessageType.BOT_LOCAL_SOURCE_REQUEST, MessageType.BOT_LOCAL_TASK_REQUEST, MessageType.BOT_LOCAL_TASK_ACCEPT,
          MessageType.BOT_LOCAL_TASK_CONTROL, MessageType.BOT_LOCAL_TASK_EVENT, MessageType.BOT_LOCAL_MEDIA_SIGNAL,
        ],
        handle: ({ session, type, payload, requestId }) => this.botLocalExecution.handle(session, type, payload, requestId),
      }),
      route({
        types: [
          MessageType.BOT_SCREEN_CREATE, MessageType.BOT_SCREEN_UPDATE, MessageType.BOT_SCREEN_CLOSE, MessageType.BOT_SCREEN_END,
          MessageType.BOT_SCREEN_LIST, MessageType.BOT_SCREEN_ACTION,
        ],
        unavailable: { when: () => !this.botScreens, code: ProtocolErrorCode.BAD_REQUEST, message: 'Programmable screens are unavailable.' },
        handle: ({ session, type, payload, requestId }) => this.botScreens?.handle(session, type, payload, requestId),
      }),
      route({
        types: [
          MessageType.BOT_STORAGE_PUT, MessageType.BOT_STORAGE_GET, MessageType.BOT_STORAGE_DELETE, MessageType.BOT_STORAGE_LIST,
          MessageType.BOT_STORAGE_USAGE, MessageType.BOT_STORAGE_INFO_GET, MessageType.BOT_STORAGE_LIMIT_UPDATE,
          MessageType.BOT_STORAGE_CLEAR,
        ],
        unavailable: { when: () => !this.botStorage, message: 'Bot storage is unavailable.' },
        handle: ({ session, type, payload, requestId }) => this.botStorage?.handle(session, type, payload, requestId),
      }),
      route({
        types: [
          MessageType.SELECTOR_CREATE, MessageType.SELECTOR_LIST, MessageType.SELECTOR_UPDATE, MessageType.SELECTOR_CLOSE,
          MessageType.SELECTOR_RESPOND, MessageType.SELECTOR_FINALIZE,
        ],
        unavailable: { when: () => !this.botSelectors, code: ProtocolErrorCode.BAD_REQUEST, message: 'Selectors are unavailable.' },
        handle: ({ session, type, payload, requestId }) => this.botSelectors?.handle(session, type, payload, requestId),
      }),
    ];
  }

  /**
   * A person invoking a command of a connected bot that no administrator
   * approved for commands is told so, before the bot is asked anything.
   */
  private botCommandsApproved(session: ClientSession, payload: unknown, requestId?: string): boolean {
    if (session.isBot) return true;
    const botId = typeof payload === 'object' && payload !== null && 'botId' in payload ? payload.botId : undefined;
    if (typeof botId !== 'string' || !this.findSessionById(`bot:${botId}`) ||
        this.botService?.permissions?.allows(botId, 'commands')) return true;
    this.sendError(session.ws, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED,
      'An administrator must approve this bot before its commands can be used.', requestId);
    return false;
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

  /**
   * The version of channel access. Public because readers outside the
   * WebSocket layer check it too (MessageSearchService), and every reader here
   * goes through it as well.
   */
  public getChannelAccessVersion(): number | null {
    return this.epoch.channels();
  }

  /** Channel and role access as one version; null while either is changing. */
  private accessVersion(): number | null {
    const channels = this.getChannelAccessVersion();
    const roles = this.permissionService.getRoleAccessVersion();
    return channels === null || roles === null ? null : channels + roles;
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

  private async handleDmRelaySend(
    session: ClientSession,
    payload: unknown,
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

  /** Whether a connection is current and, for a bot, approved for all of these capabilities. */
  private isCurrentBotOperation(session: BotInteractionSession, ...capabilities: BotCapability[]): boolean {
    return this.isCurrentSession(session) && (!session.isBot ||
      (!!session.botId && this.botService?.permissions?.allows(session.botId, ...capabilities) === true));
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
    void this.visibility.syncVoicePresence();
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

  /**
   * Lets a bot's connection go once its access was revoked or changed, and the
   * commands it registered with it. The bot reconnects to be granted again.
   */
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
    this.botManagement.broadcastCommands();
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
      this.botManagement.broadcastCommands();
      void this.botManagement.broadcastSettings().catch((error: unknown) => Logger.error('BOT', 'Failed to publish offline bot settings.', error));
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

  /** Ends the grace a dropped connection of this device had to come back (#44). Returns whether one was pending. */
  private endReconnectGrace(sessionId: string): boolean {
    const timer = this.reconnectTimers.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.reconnectTimers.delete(sessionId);
    return true;
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

  /** Sends every signed-in connection the message `messageFor` picks for it, if any (Outbox.publish). */
  private publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void {
    this.outbox.publish(messageFor, skip);
  }

  public broadcast(message: ServerMessage, ignoreWs?: WebSocket): void {
    this.outbox.broadcast(message, ignoreWs);
  }

  /** Sends an event of a channel to the members allowed into it (Outbox.broadcastToChannel). */
  private broadcastToChannel(channelId: string, message: ServerMessage, ignoreWs?: WebSocket, canSend?: () => boolean): Promise<void> {
    return this.outbox.broadcastToChannel(channelId, message, ignoreWs, canSend);
  }

  private hasBotVoiceGrant(session: ClientSession, channelId: string): boolean {
    return !!session.isBot && !!session.sessionId && this.isCurrentSession(session) &&
      session.botVoiceGrant?.channelId === channelId &&
      session.botVoiceGrant.accessVersion === this.epoch.generation &&
      this.signalingService.getVoiceState(session.sessionId)?.channelId === channelId;
  }

  private voiceMembershipChanged(): void {
    // Voice admission grants track ACL changes only. A participant moving must
    // revoke viewer/command context without invalidating the bot's media grant.
    this.epoch.miniapps++;
    this.botLocalExecution.voiceChanged();
    this.botInteractions.voiceChanged();
    void this.botScreens?.revokeInvalid()
      .catch((error: unknown) => Logger.error('BOT', 'Failed to reconcile voice miniapp access.', error));
    void this.visibility.syncVoicePresence();
  }

  private disconnectBotScreens(session: BotInteractionSession): void {
    this.epoch.miniapps++;
    const screens = this.botScreens;
    if (!screens) return;
    void screens.disconnect(session).then(() => screens.revokeInvalid())
      .catch((error: unknown) => Logger.error('BOT', 'Failed to clean up disconnected bot screens.', error));
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
      const pending = [this.sfuStartup, this.serverSettingsHandler?.settled(), this.botManagementHandler?.settled(),
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
