import http from 'http';
import { WebSocket, WebSocketServer as WSServer } from 'ws';
import {
  AdminDeafenUserPayload,
  AdminKickVoicePayload,
  AdminMoveUserPayload,
  AdminMuteUserPayload,
  AuthConnectPayload,
  AuthChallengePayload,
  AuthChallengeResponsePayload,
  AuthFailedPayload,
  AuthSuccessPayload,
  ChannelCreatePayload,
  ChannelCreatedPayload,
  ChannelDeletePayload,
  ChannelDeletedPayload,
  ChannelReorderPayload,
  ChannelsReorderedPayload,
  ChannelUpdatePayload,
  ChannelUpdatedPayload,
  ChatDeletePayload,
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
  MemberKickPayload,
  MemberKickedPayload,
  Permission,
  ProtocolErrorCode,
  ProtocolMessage,
  RoleAssignPayload,
  RoleCreatePayload,
  RoleDeletePayload,
  RoleUpdatePayload,
  RolesListPayload,
  ServerErrorPayload,
  ServerInviteInfoPayload,
  ServerNetworkInterface,
  ServerSettingsUpdatedPayload,
  ServerShutdownKind,
  ServerShutdownPayload,
  ServerUpdateSettingsPayload,
  SoundboardPlayPayload,
  SoundboardStopPayload,
  SoundboardStoppedPayload,
  SoundboardPlayedPayload,
  UserChangeNicknamePayload,
  UserJoinedPayload,
  UserLeftPayload,
  UserConnectionStatePayload,
  UserSummary,
  UserUpdateAvatarPayload,
  UserUpdatedPayload,
  UserUpdateVisibilityPayload,
  BotCreatedPayload,
  BotInstallPayload,
  BotInstalledPayload,
  BotListResponsePayload,
  BotRevokePayload,
  BotRevokedPayload,
  BotProfileUpdatedPayload,
  CommandRegisteredPayload,
  CommandsListResponsePayload,
  VoiceJoinPayload,
  VoiceLeavePayload,
  VoiceStateChangedPayload,
  VoiceStateUpdatePayload,
  VoiceUserJoinedPayload,
  VoiceUserLeftPayload,
  VoiceRosterParticipant,
  WebRtcSignalPayload,
  RtcDiagnosticsReportPayload,
  SfuGetRouterRtpCapabilitiesPayload,
  SfuRouterRtpCapabilitiesPayload,
  SfuCreateWebRtcTransportPayload,
  SfuWebRtcTransportCreatedPayload,
  SfuConnectWebRtcTransportPayload,
  SfuProducePayload,
  SfuProducedPayload,
  SfuConsumePayload,
  SfuConsumedPayload,
  SfuProducerClosedPayload,
  SfuConsumerClosedPayload,
  SfuConsumerSetPausedPayload,
  SfuNewProducerPayload,
  SfuGetProducersPayload,
  SfuProducersListPayload,
  canAccessChannel,
  authConnectSchema,
  botCreateSchema,
  botProfileUpdateSchema,
  commandRegisterSchema,
} from '@monky/shared';
import { getServerVersion } from '../version/ServerVersion';
import { AuthService } from '../../application/services/AuthService';
import { AttachmentService } from '../../application/services/AttachmentService';
import { ChannelService } from '../../application/services/ChannelService';
import { ChatService } from '../../application/services/ChatService';
import { PermissionService } from '../../application/services/PermissionService';
import { RoleService } from '../../application/services/RoleService';
import { BotService } from '../../application/services/BotService';
import { BotSelectorService } from '../../application/services/BotSelectorService';
import { BotSelectorHandler } from './BotSelectorHandler';
import { CommandRegistry } from '../../application/services/CommandRegistry';
import { SignalingService } from '../../application/services/SignalingService';
import { UserService } from '../../application/services/UserService';
import { IServerRepository } from '../../domain/repositories';
import { scanServerNetworkInterfaces } from '../discovery/ServerIpScanner';
import { CoturnManager } from '../turn/CoturnManager';
import { describeSfuPortProblem, SfuManager, SfuProducerClosedError } from '../sfu/SfuManager';
import { checkSfuPreflight, formatSfuPreflightForLog } from '../sfu/SfuPreflight';
import { Logger } from '../logger/Logger';
import { BotInteractionHandler, BotInteractionSession } from './BotInteractionHandler';

interface ClientSession {
  ws: WebSocket;
  messageQueue: Promise<void>;
  user?: UserSummary;
  /**
   * `userId:deviceId` of this connection, set once authenticated (#309). It is
   * stable across reconnects of the same install, which is what lets the server
   * tell a returning device from a second one.
   */
  sessionId?: string;
  isAlive: boolean;
  ip: string;
  /** True when this session was replaced by a newer connection of the same device. */
  replaced?: boolean;
  /** True when the client explicitly logged out (graceful disconnect). */
  intentionalLogout?: boolean;
  /** True when this connection has "appear offline" active (#561). */
  invisible?: boolean;
  /** True when this connection is a bot, not a human user (#569). */
  isBot?: boolean;
  /** The bot record id — set only for bot sessions (#569). */
  botId?: string;
  /**
   * Channels this connection currently knows about (#384). The server filters
   * private channels out before sending, so it has to remember what each client
   * was told in order to push the difference when a role or a channel's privacy
   * changes.
   */
  visibleChannelIds?: Set<string>;
  /**
   * Hostname this client used to reach the server, from the upgrade request's
   * `Host` header (#425).
   *
   * TURN URLs are built from it instead of an address the server guesses about
   * itself, which would be wrong behind a reverse proxy, on a multi-homed host
   * or on a LAN. Whatever brought the client here is reachable by definition.
   */
  requestHost?: string;
}

export class WebSocketServer {
  private wss: WSServer;
  private sessions: Map<WebSocket, ClientSession> = new Map();
  /** Live sockets keyed by sessionId: one person may hold several at once (#309). */
  private sessionSockets: Map<string, WebSocket> = new Map();
  /** Pending "user left" timers for sessions that dropped and may still reconnect. */
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private heartbeatTimer?: NodeJS.Timeout;
  private closing = false;
  private botInteractions: BotInteractionHandler;
  private botSelectors?: BotSelectorHandler;

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
    private sfuManager: SfuManager = new SfuManager(),
    private botService?: BotService,
    private commandRegistry: CommandRegistry = new CommandRegistry(),
    selectorService?: BotSelectorService
  ) {
    this.sfuManager.setHealthListener((sessionId, channelId, connectionHealth) => {
      const current = this.signalingService.getVoiceState(sessionId);
      if (!current || current.channelId !== channelId || current.connectionHealth === connectionHealth) return;
      const voiceState = this.signalingService.updateVoiceState(sessionId, { connectionHealth });
      if (voiceState) {
        void this.broadcastToChannel(channelId, {
          type: MessageType.VOICE_STATE_CHANGED,
          payload: { voiceState } satisfies VoiceStateChangedPayload,
        }, undefined, () => this.signalingService.getVoiceState(sessionId) === voiceState);
      }
    });
    if (selectorService) {
      this.botSelectors = new BotSelectorHandler(selectorService, this.channelService, this.userService, {
        sessions: () => this.sessions.values(),
        isCurrent: (session) => this.isCurrentSession(session),
        send: (session, message) => this.send(session.ws, message),
        authorizeInvocation: (session, invocationId, channelId) => this.botInteractions.authorizeSelector(session, invocationId, channelId),
        publish: async (bot, channelId, content, messageId, canSend, accessUserId) => {
          const record = await this.botService?.findById(bot.id);
          if (!record) throw new Error('Bot is unavailable.');
          const session = this.findSessionById(`bot:${record.id}`);
          if (!session || !this.isCurrentSession(session) || !canSend()) throw new Error('Bot is disconnected.');
          const result = await this.chatService.sendBotMessage(
            record, channelId, content, undefined, messageId, () => canSend() && this.isCurrentSession(session), accessUserId
          );
          if (!result.success) throw new Error(result.errorMessage);
          return result.message;
        },
        broadcastMessage: (message) => this.broadcastToChannel(
          message.channelId, { type: MessageType.CHAT_MESSAGE, payload: message }
        ),
      });
    }
    this.botInteractions = new BotInteractionHandler({
      isCurrent: (session) => this.isCurrentSession(session),
      findBot: (botId) => this.findSessionById(`bot:${botId}`),
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, code, message, requestId) => this.sendError(ws, code, message, requestId),
      broadcastToChannel: (channelId, message, canSend) => this.broadcastToChannel(channelId, message, undefined, canSend),
      publishResponse: (session, response, canSend, requestId) => this.publishBotResponse(session, response, canSend, requestId),
    }, this.channelService, this.userService, this.commandRegistry);
    this.wss = new WSServer({ server: this.server });
    this.setupWss();
    this.startHeartbeat();
    void this.initSfuIfConfigured();
  }

  private async initSfuIfConfigured(): Promise<void> {
    try {
      const server = await this.serverRepo.getServer();
      if (server?.voiceMode === 'sfu') {
        const ok = await this.sfuManager.init();
        if (!ok) {
          // Silently downgrading a mode the operator deliberately configured
          // is an error, not a warning — the preflight names the part of the
          // environment that is missing instead of only echoing the throw.
          const preflight = checkSfuPreflight();
          const diagnosis = preflight.ok ? '' : ` ${formatSfuPreflightForLog(preflight)}`;
          Logger.error(
            'SFU',
            `voiceMode is "sfu" but the SFU worker failed to start: ${this.sfuManager.getLastError()}.${diagnosis} ` +
              'Clients will keep retrying until it comes up.'
          );
        }
      }
    } catch (e: any) {
      Logger.warn('SFU', `Error checking SFU configuration on startup: ${e?.message}`);
    }
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
      this.botInteractions.disconnect(target);
      if (target.sessionId) this.sessionSockets.delete(target.sessionId);
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

  private setupWss(): void {    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const ip = req.socket.remoteAddress || 'unknown';
      Logger.info('NETWORK', `New connection established from ${ip}`);

      const session: ClientSession = {
        ws,
        messageQueue: Promise.resolve(),
        isAlive: true,
        ip,
        requestHost: WebSocketServer.parseRequestHostname(req.headers.host),
      };
      this.sessions.set(ws, session);

      ws.on('pong', () => {
        session.isAlive = true;
      });

      ws.on('message', (data: Buffer) => {
        // A bot can reply and immediately finish (or update its profile and
        // register commands). Preserve wire order across asynchronous handlers.
        session.messageQueue = session.messageQueue.then(async () => {
          const message: ProtocolMessage<unknown> = JSON.parse(data.toString('utf8'));
          await this.handleMessage(session, message);
        }).catch((err: unknown) => {
          Logger.error('NETWORK', 'Failed to process message', err);
          this.sendError(ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem malformada');
        });
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

  private async handleMessage(session: ClientSession, message: ProtocolMessage): Promise<void> {
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
      session.isAlive = true;
      this.send(session.ws, { type: MessageType.PONG, requestId, payload: { timestamp: Date.now() } });
      return;
    }

    // Connect / Auth
    if (type === MessageType.AUTH_CONNECT) {
      await this.handleAuthConnect(session, payload as AuthConnectPayload, requestId);
      return;
    }

    if (type === MessageType.AUTH_CHALLENGE_RESPONSE) {
      await this.handleAuthChallengeResponse(session, payload as AuthChallengeResponsePayload, requestId);
      return;
    }

    // Require authentication for all subsequent messages
    if (!session.user) {
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Não autenticado no servidor', requestId);
      return;
    }

    switch (type) {
      case MessageType.CHAT_REACTION_ADD:
      case MessageType.CHAT_REACTION_REMOVE: {
        if (!session.user) return;
        const reaction = chatReactionSchema.safeParse(payload);
        if (!reaction.success) {
          this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Reação inválida.', requestId);
          return;
        }
        if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId))) return;
        if (!(await this.requireChannelAccess(session, reaction.data.channelId, requestId))) return;
        if (!this.isCurrentSession(session)) return;
        const result = await this.chatService.setReaction(session.user, reaction.data, type === MessageType.CHAT_REACTION_ADD,
          () => this.isCurrentSession(session));
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
        if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId))) return;
        if (!(await this.requireChannelAccess(session, (payload as ChatSendPayload)?.channelId, requestId))) return;
        await this.handleChatSend(session, payload as ChatSendPayload, requestId);
        break;

      case MessageType.CHAT_LOAD_HISTORY:
        if (!(await this.requireChannelAccess(session, (payload as ChatLoadHistoryPayload)?.channelId, requestId))) return;
        await this.handleChatLoadHistory(session, payload as ChatLoadHistoryPayload, requestId);
        break;

      case MessageType.CHAT_EDIT:
        if (!(await this.requirePermission(session, Permission.SEND_MESSAGES, requestId))) return;
        if (!(await this.requireChannelAccess(session, (payload as ChatEditPayload)?.channelId, requestId))) return;
        await this.handleChatEdit(session, payload as ChatEditPayload, requestId);
        break;

      case MessageType.CHAT_DELETE:
        if (!(await this.requireChannelAccess(session, (payload as ChatDeletePayload)?.channelId, requestId))) return;
        await this.handleChatDelete(session, payload as ChatDeletePayload, requestId);
        break;

      case MessageType.CHAT_MENTIONS_READ:
        await this.handleChatMentionsRead(session, payload as ChatMentionsReadPayload);
        break;

      case MessageType.CHAT_REQUEST_UPLOAD_TOKEN:
        if (!(await this.requirePermission(session, Permission.ATTACH_FILES, requestId))) return;
        if (!(await this.requireChannelAccess(session, (payload as ChatRequestUploadTokenPayload)?.channelId, requestId))) return;
        this.handleRequestUploadToken(session, payload as ChatRequestUploadTokenPayload, requestId);
        break;

      case MessageType.CHANNEL_CREATE:
        if (!(await this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
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

      case MessageType.USER_CHANGE_NICKNAME:
        await this.handleUserChangeNickname(session, payload as UserChangeNicknamePayload, requestId);
        break;

      case MessageType.USER_UPDATE_AVATAR:
        await this.handleUserUpdateAvatar(session, payload as UserUpdateAvatarPayload, requestId);
        break;

      case MessageType.USER_UPDATE_VISIBILITY:
        this.handleUserUpdateVisibility(session, payload as UserUpdateVisibilityPayload, requestId);
        break;

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
        if (!(await this.requirePermission(session, Permission.SPEAK, requestId))) return;
        if (!(await this.requireChannelAccess(session, (payload as VoiceJoinPayload)?.channelId, requestId))) return;
        await this.handleVoiceJoin(session, payload as VoiceJoinPayload, requestId);
        break;

      case MessageType.VOICE_LEAVE:
        await this.handleVoiceLeave(session, payload as VoiceLeavePayload, requestId);
        break;

      case MessageType.VOICE_STATE_UPDATE:
        await this.handleVoiceStateUpdate(session, payload as VoiceStateUpdatePayload, requestId);
        break;

      case MessageType.RTC_SIGNAL:
        this.handleRtcSignal(session, payload as WebRtcSignalPayload, requestId);
        break;

      case MessageType.RTC_DIAGNOSTICS_REPORT:
        this.handleRtcDiagnosticsReport(session, payload as RtcDiagnosticsReportPayload);
        break;

      case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
        if (!(await this.requireSfuMode(session, requestId))) return;
        await this.handleSfuGetRouterRtpCapabilities(session, payload as SfuGetRouterRtpCapabilitiesPayload, requestId);
        break;

      case MessageType.SFU_CREATE_WEBRTC_TRANSPORT:
        if (!(await this.requireSfuMode(session, requestId))) return;
        await this.handleSfuCreateWebRtcTransport(session, payload as SfuCreateWebRtcTransportPayload, requestId);
        break;

      case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
        if (!(await this.requireSfuMode(session, requestId))) return;
        await this.handleSfuConnectWebRtcTransport(session, payload as SfuConnectWebRtcTransportPayload, requestId);
        break;

      case MessageType.SFU_PRODUCE:
        if (!(await this.requireSfuMode(session, requestId))) return;
        await this.handleSfuProduce(session, payload as SfuProducePayload, requestId);
        break;

      case MessageType.SFU_CONSUME:
        if (!(await this.requireSfuMode(session, requestId))) return;
        await this.handleSfuConsume(session, payload as SfuConsumePayload, requestId);
        break;

      case MessageType.SFU_PRODUCER_CLOSED:
        if (!(await this.requireSfuMode(session, requestId))) return;
        this.handleSfuProducerClosed(session, payload as SfuProducerClosedPayload);
        break;

      case MessageType.SFU_GET_PRODUCERS:
        if (!(await this.requireSfuMode(session, requestId))) return;
        await this.handleSfuGetProducers(session, payload as SfuGetProducersPayload, requestId);
        break;

      case MessageType.SFU_CONSUMER_SET_PAUSED:
        if (!(await this.requireSfuMode(session, requestId))) return;
        await this.handleSfuConsumerSetPaused(session, payload as SfuConsumerSetPausedPayload);
        break;

      case MessageType.SOUNDBOARD_PLAY:
        if (!(await this.requirePermission(session, Permission.SPEAK, requestId))) return;
        if (!(await this.requireChannelAccess(session, (payload as SoundboardPlayPayload)?.channelId, requestId))) return;
        await this.handleSoundboardPlay(session, payload as SoundboardPlayPayload, requestId);
        break;

      case MessageType.SOUNDBOARD_STOP:
        if (!(await this.requireChannelAccess(session, (payload as SoundboardStopPayload)?.channelId, requestId))) return;
        this.handleSoundboardStop(session, payload as SoundboardStopPayload, requestId);
        break;

      case MessageType.ADMIN_MUTE_USER:
        if (!(await this.requirePermission(session, Permission.MUTE_MEMBERS, requestId))) return;
        await this.handleAdminMuteUser(session, payload as AdminMuteUserPayload, requestId);
        break;

      case MessageType.ADMIN_DEAFEN_USER:
        if (!(await this.requirePermission(session, Permission.DEAFEN_MEMBERS, requestId))) return;
        await this.handleAdminDeafenUser(session, payload as AdminDeafenUserPayload, requestId);
        break;

      case MessageType.ADMIN_KICK_VOICE:
        if (!(await this.requirePermission(session, Permission.KICK_MEMBERS, requestId))) return;
        await this.handleAdminKickVoice(session, payload as AdminKickVoicePayload, requestId);
        break;

      case MessageType.ADMIN_MOVE_USER:
        if (!(await this.requirePermission(session, Permission.MOVE_MEMBERS, requestId))) return;
        await this.handleAdminMoveUser(session, payload as AdminMoveUserPayload, requestId);
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
        this.botInteractions.disconnect(session);
        break;

      // ── Bot management (#569) ────────────────────────────────────────
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
        this.handleCommandRegister(session, payload, requestId);
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
    // Bot token auth: skip challenge-response, authenticate directly (#569).
    if (payload.botToken && this.botService) {
      await this.handleBotAuth(session, payload, requestId);
      return;
    }

    const result = await this.authService.createChallenge(session.ws, payload);

    if (!result.success || !result.nonce) {
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
    payload: AuthChallengeResponsePayload,
    requestId?: string
  ): Promise<void> {
    const result = await this.authService.verifyChallengeResponse(session.ws, payload.signature);
    if (this.closing || this.sessions.get(session.ws) !== session || session.ws.readyState !== WebSocket.OPEN) return;

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
    const sessionId = result.user.sessionId!;
    session.sessionId = sessionId;
    session.invisible = result.appearOffline === true;

    // Prevent duplicate sessions for the *same device*. A lingering/zombie socket
    // (e.g. after a reconnect where the old TCP connection was not yet cleaned
    // up) would otherwise receive every broadcast twice. Note this is keyed by
    // sessionId, not by user: another device of the same person is a legitimate
    // second session and must be left alone (#309).
    const existingWs = this.sessionSockets.get(sessionId);
    if (existingWs && existingWs !== session.ws) {
      const staleSession = this.sessions.get(existingWs);
      if (staleSession) {
        this.botInteractions.disconnect(staleSession);
        this.authService.clearChallenge(existingWs);
        staleSession.replaced = true;
        this.sessions.delete(existingWs);
      }
      try {
        existingWs.close();
      } catch {
        /* ignore */
      }
      Logger.info('NETWORK', `Replaced stale session ${sessionId}`);
    }

    this.sessionSockets.set(sessionId, session.ws);

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

    // Populate current voice states into serverDetails
    result.serverDetails.voiceStates = this.signalingService.getAllVoiceStates();

    // Remember exactly which channels this client was told about, so later role
    // or privacy changes can be reconciled into deltas (#384).
    session.visibleChannelIds = new Set(result.serverDetails.channels.map((c) => c.id));

    // Send AUTH_SUCCESS to the connecting client
    const serverVersion = getServerVersion();
    const successPayload: AuthSuccessPayload = {
      server: {
        ...result.serverDetails,
        // Told at login because it never changes while the process lives: it
        // depends on the host OS and on coturn being installed (#429).
        turnAvailability: CoturnManager.describeAvailability(),
        // Same reasoning: the release is fixed for the life of the process, and
        // sending it lets an admin read the version of a server running on a
        // VPS without opening a shell on it (#559). Left out entirely when the
        // server cannot establish it, so the client shows nothing rather than
        // an invented number.
        ...(serverVersion ? { version: serverVersion } : {}),
      },
      currentUser: result.user,
      roles: result.serverDetails.roles,
      userRoles: result.serverDetails.userRoles,
      ownerId: result.serverDetails.ownerId,
      myPermissions: result.serverDetails.myPermissions,
      iceServers: await this.buildIceServersFor(result.user.id, session),
    };

    // Auth and ICE setup await I/O. Refresh the live roster at the send boundary
    // so an intervening join/leave cannot be erased by an older auth snapshot.
    successPayload.server.members = Array.from(this.getOnlineUsersMap().values())
      .filter(({ user }) => !user.invisible || user.id === result.user!.id)
      .map(({ user }) => user);
    successPayload.server.voiceStates = Object.fromEntries(
      Object.entries(this.signalingService.getAllVoiceStates())
        .filter(([, state]) => session.visibleChannelIds?.has(state.channelId))
    );
    this.send(session.ws, {
      type: MessageType.AUTH_SUCCESS,
      requestId,
      payload: successPayload,
    });
    this.handleCommandsList(session);

    if (this.getSessionsOfUser(result.user.id).some((other) => !!other.invisible !== !!session.invisible)) {
      this.handleUserUpdateVisibility(session, { appearOffline: session.invisible === true });
    }

    // Broadcast USER_JOINED to all other clients — unless the user is invisible (#561).
    if (!session.invisible) {
      const userJoinedPayload: UserJoinedPayload = { user: result.user };
      this.broadcast({
        type: MessageType.USER_JOINED,
        payload: userJoinedPayload,
      }, session.ws);
    }

    await this.broadcastRolesState(requestId);

    Logger.info('NETWORK', `User ${result.user.nickname} (${result.user.id}) joined the server.`);
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
        Logger.warn('NETWORK', 'TURN relay enabled without a shared secret; leaving it off.');
        return;
      }
      const started = await this.coturnManager.start(server.turnSecret);
      if (!started) return;

      // Verify the relay is actually reachable. A VPS whose firewall blocks
      // port 3478 will silently swallow TURN allocations, and the only sign is
      // that members behind CGNAT never connect — exactly the bug #425
      // reported. Checking right after start catches the most common
      // misconfiguration before anyone tries to call.
      const portProblem = await CoturnManager.checkPortReachability();
      if (portProblem) {
        Logger.warn('NETWORK', `TURN relay started but may not work: ${portProblem}`);
      }
    } catch (error) {
      Logger.error('NETWORK', 'Failed to apply the TURN relay state', error);
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

    // Token validation performs TOFU binding, so incompatible peers must be
    // rejected before looking up or binding their token.
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      this.sendError(
        session.ws,
        ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
        `Versão de protocolo incompatível. Este servidor usa a versão ${PROTOCOL_VERSION}.`,
        requestId,
        PROTOCOL_VERSION
      );
      return;
    }

    const publicKey = payload.publicKey;
    const botRecord = await this.botService.validateToken(payload.botToken, publicKey);
    if (this.closing || this.sessions.get(session.ws) !== session || session.ws.readyState !== WebSocket.OPEN) return;
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
    session.sessionId = sessionId;
    session.isBot = true;
    session.botId = botRecord.id;

    // Replace existing bot session if any.
    const existingWs = this.sessionSockets.get(sessionId);
    if (existingWs && existingWs !== session.ws) {
      const stale = this.sessions.get(existingWs);
      if (stale) {
        this.botInteractions.disconnect(stale);
        this.authService.clearChallenge(existingWs);
        stale.replaced = true;
        this.sessions.delete(existingWs);
      }
      this.commandRegistry.clearBot(botRecord.id);
      this.broadcastCommands();
      try { existingWs.close(); } catch { /* ignore */ }
    }
    this.sessionSockets.set(sessionId, session.ws);

    // Build a minimal ServerDetails for the bot.
    const server = await this.serverRepo.getServer();
    const channels = server ? await this.channelService.listChannels() : [];
    const serverDetails = {
      id: server?.id ?? '',
      name: server?.name ?? '',
      createdAt: server?.createdAt ?? now,
      maxUsers: server?.maxUsers ?? 0,
      hasPassword: false,
      allowSoundboard: false,
      allowEveryoneMention: false,
      allowMessageEdit: false,
      showRoleBadgesToEveryone: false,
      voiceMode: 'p2p' as const,
      hostSpecs: { cpuCores: 0, ramTotalGb: 0 },
      turnEnabled: false,
      maxBots: server?.maxBots ?? LIMITS.MAX_BOTS_DEFAULT,
      iconUrl: null,
      channels: channels.filter((channel) => canAccessChannel(channel, 0, [])).map((c) => ({
        id: c.id, serverId: c.serverId, name: c.name, type: c.type,
        position: c.position, createdAt: c.createdAt,
        maxParticipants: c.maxParticipants, isPrivate: c.isPrivate,
        botCommandsEnabled: c.botCommandsEnabled,
        allowedRoleIds: c.allowedRoleIds,
      })),
      members: [botUser],
      knownMembers: [botUser],
      mentionedChannelIds: [],
      voiceStates: {},
      roles: [],
      userRoles: [],
      ownerId: server?.ownerUserId ?? null,
      myPermissions: 0,
      attachmentStorage: { maxFileBytes: 0, maxTotalBytes: 0, usedBytes: 0 },
    };
    session.visibleChannelIds = new Set(serverDetails.channels.map((channel) => channel.id));

    if (this.closing || session.replaced || this.sessions.get(session.ws) !== session ||
        session.ws.readyState !== WebSocket.OPEN) return;
    this.send(session.ws, {
      type: MessageType.AUTH_SUCCESS,
      requestId,
      payload: {
        server: { ...serverDetails, turnAvailability: CoturnManager.describeAvailability() },
        currentUser: botUser,
        roles: [],
        userRoles: [],
        ownerId: serverDetails.ownerId,
        myPermissions: 0,
        iceServers: [],
      } satisfies AuthSuccessPayload,
    });

    // Broadcast the bot joining.
    this.broadcast({ type: MessageType.USER_JOINED, payload: { user: botUser } satisfies UserJoinedPayload }, session.ws);
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
      const code = parsed.error.issues.some((issue) => issue.path[0] === 'avatarBase64' && issue.code === 'too_big')
        ? ProtocolErrorCode.AVATAR_TOO_LARGE : ProtocolErrorCode.BOT_INVALID_PROFILE;
      this.sendError(session.ws, code, 'Nome ou avatar do bot inválido.', requestId);
      return;
    }
    const result = await this.botService.create(
      parsed.data.name,
      session.user.id,
      parsed.data.avatarBase64
    );

    if (!result.success) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao criar bot.',
        requestId
      );
      return;
    }

    const createdPayload: BotCreatedPayload = {
      bot: result.bot,
      token: result.token,
    };
    this.send(session.ws, { type: MessageType.BOT_CREATED, requestId, payload: createdPayload });
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

  private async handleBotUpdateProfile(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    if (!session.user || !this.botService) return;
    const parsed = botProfileUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const code = parsed.error.issues.some((issue) => issue.path[0] === 'avatarBase64' && issue.code === 'too_big')
        ? ProtocolErrorCode.AVATAR_TOO_LARGE : ProtocolErrorCode.BOT_INVALID_PROFILE;
      this.sendError(session.ws, code, 'Perfil do bot inválido.', requestId);
      return;
    }
    let botId = parsed.data.botId;
    if (session.isBot) {
      if (!session.botId || (botId !== undefined && botId !== session.botId)) {
        this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots só podem editar o próprio perfil.', requestId);
        return;
      }
      botId = session.botId;
    } else {
      if (!(await this.requirePermission(session, Permission.MANAGE_BOTS, requestId))) return;
      if (!botId) {
        this.sendError(session.ws, ProtocolErrorCode.BOT_INVALID_PROFILE, 'Informe o bot a editar.', requestId);
        return;
      }
    }
    if (!this.isCurrentSession(session)) return;
    const result = await this.botService.updateProfile(botId, parsed.data);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
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
    const updated: BotProfileUpdatedPayload = { bot: result.bot };
    this.send(session.ws, { type: MessageType.BOT_PROFILE_UPDATED, requestId, payload: updated });
    this.broadcast({ type: MessageType.BOT_PROFILE_UPDATED, payload: updated }, session.ws);
    this.broadcastCommands();
  }

  private async handleBotRevoke(
    session: ClientSession,
    payload: BotRevokePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !this.botService) return;

    if (typeof payload?.botId !== 'string' || !payload.botId || payload.botId.length > 128) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bot inválido.', requestId);
      return;
    }
    const result = await this.botService.revoke(payload.botId);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }

    this.disconnectBot(payload.botId);
    const revokedPayload: BotRevokedPayload = { botId: payload.botId };
    this.send(session.ws, { type: MessageType.BOT_REVOKED, requestId, payload: revokedPayload });
    this.broadcast({ type: MessageType.BOT_REVOKED, payload: revokedPayload }, session.ws);
  }

  private disconnectBot(botId: string): void {
    const botSessionId = `bot:${botId}`;
    const botWs = this.sessionSockets.get(botSessionId);
    if (botWs) {
      const botSession = this.sessions.get(botWs);
      if (botSession) {
        this.botInteractions.disconnect(botSession);
        if (botSession.user && botSession.sessionId) this.finalizeSessionLeave(botSession.user, botSession.sessionId);
        botSession.replaced = true;
        this.sessions.delete(botWs);
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

    try {
      if (typeof payload?.manifestUrl !== 'string' || payload.manifestUrl.length > 2048) throw new Error('Invalid URL');
      const url = new URL(payload.manifestUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
    } catch {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'URL do manifest inválida.', requestId);
      return;
    }

    const server = await this.serverRepo.getServer();
    const serverName = server?.name || 'Monky Server';

    // Derive the server's WebSocket URL so the bot can auto-connect.
    const addr = this.server.address();
    let serverWsUrl: string | undefined;
    if (addr && typeof addr === 'object') {
      const host = addr.address === '::' || addr.address === '0.0.0.0' ? 'localhost' : addr.address;
      serverWsUrl = `ws://${host}:${addr.port}`;
    }

    const result = await this.botService.installFromManifest(
      payload.manifestUrl,
      session.user.id,
      serverName,
      serverWsUrl
    );

    if (!result.success) {
      if (result.revokedBotId) {
        this.disconnectBot(result.revokedBotId);
        this.broadcast({ type: MessageType.BOT_REVOKED, payload: { botId: result.revokedBotId } satisfies BotRevokedPayload });
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
  }

  // ── Slash command handlers (#569) ──────────────────────────────────────

  private handleCommandRegister(
    session: ClientSession,
    payload: unknown,
    requestId?: string
  ): void {
    if (!session.user || !session.isBot || !session.botId || !this.isCurrentSession(session)) {
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Apenas bots podem registrar comandos.', requestId);
      return;
    }

    const parsed = commandRegisterSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(session.ws, ProtocolErrorCode.BOT_INVALID_OPTIONS, 'Definições de comandos inválidas.', requestId);
      return;
    }
    const registered = this.commandRegistry.register(
      session.botId, session.user.nickname, parsed.data.commands, session.user.avatarUrl
    );
    this.send(session.ws, {
      type: MessageType.COMMAND_REGISTERED,
      requestId,
      payload: { registered } satisfies CommandRegisteredPayload,
    });
    this.broadcastCommands();
  }

  private handleCommandsList(
    session: ClientSession,
    requestId?: string
  ): void {
    if (!session.user) return;
    const listPayload: CommandsListResponsePayload = { commands: this.commandRegistry.listAll() };
    this.send(session.ws, { type: MessageType.COMMANDS_LIST_RESPONSE, requestId, payload: listPayload });
  }

  private broadcastCommands(): void {
    const payload: CommandsListResponsePayload = { commands: this.commandRegistry.listAll() };
    this.broadcast({ type: MessageType.COMMANDS_LIST_RESPONSE, payload });
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

  private async handleChatSend(    session: ClientSession,
    payload: ChatSendPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;

    const bot = session.isBot && session.botId ? await this.botService?.findById(session.botId) : undefined;
    if (session.isBot && (!bot || !this.isCurrentSession(session))) {
      this.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Bot indisponível.', requestId);
      return;
    }
    if (bot && payload.attachmentIds?.length) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bots devem enviar mensagens de texto.', requestId);
      return;
    }
    const result = bot
      ? await this.chatService.sendBotMessage(bot, payload.channelId, payload.content, undefined, undefined, () => this.isCurrentSession(session), bot.id, payload.replyToMessageId)
      : await this.chatService.sendMessage(
      session.user.id,
      payload.channelId,
      payload.content,
      payload.attachmentIds,
      payload.replyToMessageId
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

    // Broadcast message to everyone allowed into this channel (#384).
    await this.broadcastToChannel(result.message.channelId, {
      type: MessageType.CHAT_MESSAGE,
      requestId,
      payload: result.message,
    });
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
    }, response.messageId, () => canSend() && this.isCurrentSession(session), response.invokerId);
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
      payload.content
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
  }

  /** Sends the new state of an edited/deleted message to the channel (#504). */
  private async broadcastChatMessageUpdated(message: ChatMessage, requestId?: string): Promise<void> {
    const updatedPayload: ChatMessageUpdatedPayload = { message };
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
      parsed.data.aroundMessageId
    );

    const historyPayload: ChatHistoryPayload = {
      aroundMessageId: parsed.data.aroundMessageId,
      channelId: payload.channelId,
      messages,
    };

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

    await this.reconcileChannelVisibility();
  }

  private async handleChannelUpdate(
    session: ClientSession,
    payload: ChannelUpdatePayload,
    requestId?: string
  ): Promise<void> {
    const result = await this.channelService.updateChannel(payload);
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
    const updatedPayload: ChannelUpdatedPayload = { channel };
    this.send(session.ws, {
      type: MessageType.CHANNEL_UPDATED,
      requestId,
      payload: updatedPayload,
    });

    // CHANNEL_UPDATED only makes sense for clients that already have the channel
    // and keep access to it. Those who just gained or lost it are served by the
    // reconciliation, which sends them a CREATED or a DELETED instead (#384).
    const audience = await this.resolveChannelAudience(channel);
    for (const [ws, peer] of this.sessions.entries()) {
      if (ws === session.ws || !peer.user || ws.readyState !== WebSocket.OPEN) continue;
      if (!peer.visibleChannelIds?.has(channel.id)) continue;
      if (!audience.has(peer.user.id)) continue;

      this.send(ws, {
        type: MessageType.CHANNEL_UPDATED,
        payload: updatedPayload,
      });
    }

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
    const result = await this.channelService.reorderChannels(payload);
    if (!result.success || !result.positions) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao reordenar canais',
        requestId
      );
      return;
    }

    const positions = result.positions;
    const visibleTo = (peer: ClientSession) =>
      positions.filter((p) => peer.visibleChannelIds?.has(p.channelId));

    this.send(session.ws, {
      type: MessageType.CHANNELS_REORDERED,
      requestId,
      payload: { positions: visibleTo(session) } satisfies ChannelsReorderedPayload,
    });

    for (const [ws, peer] of this.sessions.entries()) {
      if (ws === session.ws || !peer.user || ws.readyState !== WebSocket.OPEN) continue;
      const mine = visibleTo(peer);
      if (mine.length === 0) continue;
      this.send(ws, {
        type: MessageType.CHANNELS_REORDERED,
        payload: { positions: mine } satisfies ChannelsReorderedPayload,
      });
    }
  }

  private async handleChannelDelete(
    session: ClientSession,
    payload: ChannelDeletePayload,
    requestId?: string
  ): Promise<void> {
    const result = await this.channelService.deleteChannel(payload.channelId);
    if (!result.success) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.CHANNEL_NOT_FOUND,
        result.errorMessage || 'Erro ao deletar canal',
        requestId
      );
      return;
    }

    this.botInteractions.deleteChannel(payload.channelId);

    // If it was a voice channel, disconnect any participants still in it so they
    // are not stranded in a "ghost" channel after it has been removed.
    const strandedParticipants = this.signalingService.getParticipantsInChannel(payload.channelId);
    for (const participant of strandedParticipants) {
      this.signalingService.leaveVoiceChannel(participant.sessionId);
      const leavePayload: VoiceUserLeftPayload = {
        channelId: payload.channelId,
        userId: participant.userId,
        sessionId: participant.sessionId,
      };
      this.broadcast({
        type: MessageType.VOICE_USER_LEFT,
        payload: leavePayload,
      });
    }

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

  private async handleUserChangeNickname(
    session: ClientSession,
    payload: UserChangeNicknamePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;

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

    this.applyUserUpdate(result.updatedUser);
    this.broadcastUserUpdate(result.updatedUser, requestId);
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
    this.broadcastUserUpdate(result.updatedUser, requestId);
  }

  /** Presence updates must not masquerade as a physical disconnect from voice. */
  private broadcastUserUpdate(user: UserSummary, requestId?: string): void {
    const invisible = this.getSessionsOfUser(user.id).some((session) => session.invisible);
    const publicUser: UserSummary = {
      ...user,
      invisible: undefined,
      ...(invisible ? { status: 'DISCONNECTED', sessionId: undefined, connectedAt: undefined } : {}),
    };
    for (const recipient of this.sessions.values()) {
      if (!recipient.user) continue;
      const payload: UserUpdatedPayload = {
        user: recipient.user.id === user.id ? recipient.user : publicUser,
      };
      this.send(recipient.ws, { type: MessageType.USER_UPDATED, requestId, payload });
    }
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
        const joinPayload: UserJoinedPayload = {
          user: { ...s.user, invisible: undefined },
        };
        this.broadcast({ type: MessageType.USER_JOINED, payload: joinPayload }, s.ws);
      }
    }

    Logger.info('NETWORK', `User ${session.user.nickname} is now ${nowInvisible ? 'invisible' : 'visible'}.`);
  }

  private async handleServerUpdateSettings(
    session: ClientSession,
    payload: ServerUpdateSettingsPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;

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
      const current = await this.serverRepo.getServer();
      if (current?.voiceMode !== 'sfu') {
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
    }

    const result = await this.authService.updateServerSettings(payload);
    if (!result.success) {
      this.sendError(
        session.ws,
        ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao atualizar configurações do servidor',
        requestId
      );
      return;
    }

    if (payload.voiceMode === 'sfu') {
      const ok = await this.sfuManager.init();
      if (!ok) {
        // The admin is watching this switch right now, so the reason travels
        // to the client instead of staying in the server log. Nothing is
        // downgraded here: clients keep retrying the SFU on their own until
        // the worker comes up.
        const preflight = checkSfuPreflight();
        const diagnosis = preflight.ok ? '' : ` ${formatSfuPreflightForLog(preflight)}`;
        Logger.error(
          'SFU',
          `SFU initialization failed on mode change: ${this.sfuManager.getLastError()}.${diagnosis}`
        );
        const reason =
          `${this.sfuManager.getLastError() || 'SFU worker failed to initialize'}${diagnosis}`.trim();
        // Deliberately uncorrelated: the settings change itself succeeded and
        // is confirmed by the broadcast below, so tying this to the requestId
        // would fail the very request that worked.
        this.sendError(session.ws, ProtocolErrorCode.SFU_UNAVAILABLE, reason);
      }
    } else if (payload.voiceMode === 'p2p') {
      // When switching to P2P, cleanly terminate any active SFU channels and evict call participants
      this.sfuManager.close();
      const evictedStates = this.signalingService.clearAllVoiceStates();
      for (const vs of evictedStates) {
        this.broadcast({
          type: MessageType.VOICE_USER_LEFT,
          payload: {
            channelId: vs.channelId,
            userId: vs.userId,
            sessionId: vs.sessionId,
          },
        });
      }
    }

    if (payload.turnEnabled !== undefined || payload.voiceMode !== undefined) {
      // Also runs on a plain mode change: switching to SFU forces the relay off
      // in AuthService, and coturn has to actually stop (#515).
      await this.applyTurnState(Boolean(result.turnEnabled));
    }

    const broadcastPayload: ServerSettingsUpdatedPayload = {
      name: result.name!,
      hasPassword: result.hasPassword!,
      allowSoundboard: result.allowSoundboard,
      allowEveryoneMention: result.allowEveryoneMention,
      allowMessageEdit: result.allowMessageEdit,
      showRoleBadgesToEveryone: result.showRoleBadgesToEveryone,
      voiceMode: result.voiceMode,
      iconUrl: result.iconUrl,
      attachmentStorage: result.attachmentStorage,
      maxUsers: result.maxUsers,
      turnEnabled: result.turnEnabled,
      turnAvailability: CoturnManager.describeAvailability(),
    };

    // Broadcast updated server settings to all clients
    this.broadcast({
      type: MessageType.SERVER_SETTINGS_UPDATED,
      requestId,
      payload: broadcastPayload,
    });

    Logger.info(
      'INFO',
      `Configurações do servidor atualizadas (Nome: ${result.name}, Senha: ${
        result.hasPassword ? 'Ativa' : 'Sem Senha'
      }, Modo de Voz: ${result.voiceMode ?? 'p2p'}, Soundboard: ${result.allowSoundboard ? 'Habilitado' : 'Desabilitado'})`
    );
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

    for (const p of this.signalingService.getParticipantsInChannel(payload.channelId)) {
      const sock = this.sessionSockets.get(p.sessionId);
      if (sock && sock.readyState === WebSocket.OPEN) {
        this.send(sock, { type: MessageType.SOUNDBOARD_STOPPED, requestId, payload: stoppedPayload });
      }
    }
  }

  private async handleSoundboardPlay(
    session: ClientSession,
    payload: SoundboardPlayPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user) return;

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
    if (!(await this.requirePermission(session, Permission.USE_SOUNDBOARD, requestId))) return;

    if (!payload || !payload.channelId || !payload.audioBase64 || !payload.soundName) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de som inválidos', requestId);
      return;
    }

    // Limit audioBase64 to ~4MB to prevent flood abuse
    if (payload.audioBase64.length > 4 * 1024 * 1024) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio muito grande (máximo 15 segundos / ~2MB)', requestId);
      return;
    }

    const soundName = String(payload.soundName).slice(0, 100);

    const broadcastPayload: SoundboardPlayedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
      userName: session.user.nickname,
      soundName,
      audioBase64: payload.audioBase64,
      mimeType: payload.mimeType || 'audio/mp3',
    };

    // Broadcast SOUNDBOARD_PLAYED to participants in this channel
    const participants = this.signalingService.getParticipantsInChannel(payload.channelId);
    if (participants.length > 0) {
      for (const p of participants) {
        const sock = this.sessionSockets.get(p.sessionId);
        if (sock && sock.readyState === WebSocket.OPEN) {
          this.send(sock, {
            type: MessageType.SOUNDBOARD_PLAYED,
            requestId,
            payload: broadcastPayload,
          });
        }
      }
    } else {
      this.broadcast({
        type: MessageType.SOUNDBOARD_PLAYED,
        requestId,
        payload: broadcastPayload,
      });
    }

    Logger.info('SOUNDBOARD', `User ${session.user.nickname} played sound "${soundName}" in channel ${payload.channelId}`);
  }

  private async handleVoiceJoin(
    session: ClientSession,
    payload: VoiceJoinPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    const isSfu = (await this.serverRepo.getServer())?.voiceMode === 'sfu';

    const result = await this.signalingService.joinVoiceChannel(
      session.sessionId,
      session.user.id,
      payload.channelId,
      payload.isMuted,
      payload.isDeafened
    );
    if (!result.success || !result.voiceState) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.CHANNEL_NOT_FOUND,
        result.errorMessage || 'Erro ao entrar no canal de voz',
        requestId
      );
      return;
    }
    if (isSfu) {
      result.voiceState = this.signalingService.updateVoiceState(session.sessionId, {
        connectionHealth: this.sfuManager.getConnectionHealth(session.sessionId, payload.channelId),
      }) ?? result.voiceState;
    }

    const joinPayload: VoiceUserJoinedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
      sessionId: session.sessionId,
      voiceState: result.voiceState,
      user: this.voiceRosterUser(session.user),
    };

    // Whatever this session had in another channel is over: switching channels
    // on the same server sends no VOICE_LEAVE, and the client's own teardown is
    // local, so nothing else would ever close those transports — they would sit
    // on their port pairs until the socket dropped.
    if (this.sfuManager) {
      const { closedProducerIds } = this.sfuManager.closeSessionExcept(
        session.sessionId,
        payload.channelId
      );
      for (const { channelId, producerId } of closedProducerIds) {
        this.broadcast({
          type: MessageType.SFU_PRODUCER_CLOSED,
          payload: { channelId, producerId } satisfies SfuProducerClosedPayload,
        });
      }
    }

    // Scoped to the channel's audience so a private room's activity does not
    // reach members who cannot see it (#384).
    await this.broadcastToChannel(payload.channelId, {
      type: MessageType.VOICE_USER_JOINED,
      requestId,
      payload: joinPayload,
    });
    // Capture and send without an await: membership can change while a scoped
    // broadcast resolves permissions. The joining client needs today's roster,
    // not the auth snapshot from before its connection finished.
    const currentVoiceState = this.signalingService.getVoiceState(session.sessionId);
    if (currentVoiceState?.channelId === payload.channelId) {
      this.send(session.ws, {
        type: MessageType.VOICE_USER_JOINED,
        payload: {
          ...joinPayload,
          user: session.user,
          voiceState: currentVoiceState,
          participants: this.getVoiceRoster(payload.channelId, session.user.id),
        } satisfies VoiceUserJoinedPayload,
      });
    }
  }

  private voiceRosterUser(user: UserSummary, viewerUserId?: string): UserSummary {
    if (user.id === viewerUserId) return user;
    // Voice needs physical session IDs even when logical presence is offline.
    return { ...user, invisible: undefined, ...(user.invisible ? { status: 'DISCONNECTED' } : {}) };
  }

  private getVoiceRoster(channelId: string, viewerUserId?: string): VoiceRosterParticipant[] {
    return this.signalingService.getParticipantsInChannel(channelId).flatMap((voiceState) => {
      const user = this.findSessionById(voiceState.sessionId)?.user;
      return user ? [{ user: this.voiceRosterUser(user, viewerUserId), voiceState }] : [];
    });
  }

  private async handleVoiceLeave(
    session: ClientSession,
    payload: VoiceLeavePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;

    const previous = this.signalingService.leaveVoiceChannel(session.sessionId);
    if (previous) {
      // Hanging up keeps the socket open, so nothing else would ever reap what
      // this session held in the SFU: the client's own teardown is local, and
      // the producers would stay listed for the next person to join, who would
      // then be told to consume a microphone that left.
      this.closeSfuSession(session.sessionId, previous.channelId);

      const leavePayload: VoiceUserLeftPayload = {
        channelId: previous.channelId,
        userId: session.user.id,
        sessionId: session.sessionId,
      };

      await this.broadcastToChannel(previous.channelId, {
        type: MessageType.VOICE_USER_LEFT,
        requestId,
        payload: leavePayload,
      });
    }
  }

  private async handleVoiceStateUpdate(
    session: ClientSession,
    payload: VoiceStateUpdatePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;

    const current = this.signalingService.getVoiceState(session.sessionId);
    const effectivePayload: VoiceStateUpdatePayload = { ...payload };
    if (current?.serverMuted) {
      effectivePayload.isSpeaking = false;
    }

    // Health is server-observed; renderer payloads cannot overwrite it.
    const updated = this.signalingService.updateVoiceState(session.sessionId, {
      ...effectivePayload,
      connectionHealth: current?.connectionHealth,
    });
    if (updated) {
      const changedPayload: VoiceStateChangedPayload = { voiceState: updated };
      this.broadcast({
        type: MessageType.VOICE_STATE_CHANGED,
        requestId,
        payload: changedPayload,
      });
    }
  }

  private handleRtcSignal(
    session: ClientSession,
    payload: WebRtcSignalPayload,
    requestId?: string
  ): void {
    if (!session.user || !session.sessionId) return;

    // Enforce that fromSessionId matches the authenticated connection
    payload.fromSessionId = session.sessionId;

    if (!this.signalingService.validateSignalRouting(payload)) {
      Logger.warn('WEBRTC', `Invalid signal routing attempt from ${session.sessionId} to ${payload.targetSessionId}`);
      return;
    }

    const targetSocket = this.sessionSockets.get(payload.targetSessionId);
    if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
      this.send(targetSocket, {
        type: MessageType.RTC_SIGNAL,
        requestId,
        payload,
      });
    }
  }

  // SFU Handlers (#515)
  private async handleSfuGetRouterRtpCapabilities(
    session: ClientSession,
    payload: SfuGetRouterRtpCapabilitiesPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) requested router capabilities for channel ${payload.channelId}`);
      if (!this.sfuManager.isReady()) {
        await this.sfuManager.init();
      }
      const rtpCapabilities = await this.sfuManager.getRouterRtpCapabilities(payload.channelId);
      this.send(session.ws, {
        type: MessageType.SFU_ROUTER_RTP_CAPABILITIES,
        requestId,
        payload: {
          channelId: payload.channelId,
          rtpCapabilities,
        } satisfies SfuRouterRtpCapabilitiesPayload,
      });
    } catch (err: any) {
      console.error(`[SFU Server:WS] Error getting router capabilities for ${session.user.nickname}:`, err);
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err?.message || 'Erro ao obter capacidades do roteador SFU', requestId);
    }
  }

  private async handleSfuCreateWebRtcTransport(
    session: ClientSession,
    payload: SfuCreateWebRtcTransportPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    try {
      if (!this.sfuManager.isReady()) {
        await this.sfuManager.init();
      }
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) creating ${payload.direction} transport for channel ${payload.channelId}`);
      // A client asking for a transport it already has is rejoining after a
      // failure. Its previous one is never coming back, and nothing else would
      // ever close it, so it goes now — along with the producers other clients
      // would otherwise keep trying to consume.
      const { closedProducerIds } = this.sfuManager.closeTransportsFor(
        session.sessionId,
        payload.channelId,
        payload.direction
      );
      for (const producerId of closedProducerIds) {
        this.broadcast({
          type: MessageType.SFU_PRODUCER_CLOSED,
          payload: { channelId: payload.channelId, producerId } satisfies SfuProducerClosedPayload,
        });
      }
      // Whatever this session still holds in another channel is over too. The
      // join it belonged to may only have reached this point *after* the
      // VOICE_JOIN for the new channel was handled — clicking straight from one
      // channel to another starts a join for the old one that is only abandoned
      // once its first round-trip returns — and joins are serialised, so a
      // transport for another channel arriving here is always the older one.
      const abandoned = this.sfuManager.closeSessionExcept(
        session.sessionId,
        payload.channelId
      );
      for (const { channelId, producerId } of abandoned.closedProducerIds) {
        this.broadcast({
          type: MessageType.SFU_PRODUCER_CLOSED,
          payload: { channelId, producerId } satisfies SfuProducerClosedPayload,
        });
      }
      const transportOptions = await this.sfuManager.createWebRtcTransport(
        session.sessionId,
        payload.channelId,
        payload.direction,
        session.requestHost
      );
      this.send(session.ws, {
        type: MessageType.SFU_WEBRTC_TRANSPORT_CREATED,
        requestId,
        payload: {
          channelId: payload.channelId,
          direction: payload.direction,
          transportOptions,
        } satisfies SfuWebRtcTransportCreatedPayload,
      });
    } catch (err: any) {
      console.error(`[SFU Server:WS] Error creating transport for ${session.user.nickname}:`, err);
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err?.message || 'Erro ao criar transporte SFU', requestId);
    }
  }

  private async handleSfuConnectWebRtcTransport(
    session: ClientSession,
    payload: SfuConnectWebRtcTransportPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) connecting transport ${payload.transportId}`);
      await this.sfuManager.connectWebRtcTransport(payload.transportId, payload.dtlsParameters);
      this.send(session.ws, {
        type: MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED,
        requestId,
        payload: {
          channelId: payload.channelId,
          transportId: payload.transportId,
        },
      });
    } catch (err: any) {
      console.error(`[SFU Server:WS] Error connecting transport ${payload.transportId} for ${session.user.nickname}:`, err);
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err?.message || 'Erro ao conectar transporte SFU', requestId);
    }
  }

  private async handleSfuProduce(
    session: ClientSession,
    payload: SfuProducePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) producing ${payload.kind} (${payload.appData?.mediaType}) in channel ${payload.channelId}`);
      const { id } = await this.sfuManager.produce(
        session.sessionId,
        payload.channelId,
        payload.transportId,
        payload.kind,
        payload.rtpParameters,
        payload.appData || {}
      );

      this.send(session.ws, {
        type: MessageType.SFU_PRODUCED,
        requestId,
        payload: {
          channelId: payload.channelId,
          id,
        } satisfies SfuProducedPayload,
      });

      // Notify other participants in the channel about the new producer
      const newProducerPayload: SfuNewProducerPayload = {
        channelId: payload.channelId,
        producerId: id,
        producerSessionId: session.sessionId,
        kind: payload.kind,
        appData: payload.appData || {},
      };

      const participants = this.signalingService.getParticipantsInChannel(payload.channelId);
      console.log(`[SFU Server:WS] Broadcasting SFU_NEW_PRODUCER to ${participants.length - 1} other participants in channel ${payload.channelId}`);
      for (const p of participants) {
        if (p.sessionId === session.sessionId) continue;
        const sock = this.sessionSockets.get(p.sessionId);
        if (sock && sock.readyState === WebSocket.OPEN) {
          this.send(sock, {
            type: MessageType.SFU_NEW_PRODUCER,
            payload: newProducerPayload,
          });
        }
      }
    } catch (err: any) {
      console.error(`[SFU Server:WS] Error producing for ${session.user.nickname}:`, err);
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err?.message || 'Erro ao produzir mídia no SFU', requestId);
    }
  }

  private async handleSfuConsume(
    session: ClientSession,
    payload: SfuConsumePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) consuming producer ${payload.producerId}`);
      const consumed = await this.sfuManager.consume(
        session.sessionId,
        payload.channelId,
        payload.transportId,
        payload.producerId,
        payload.rtpCapabilities
      );

      this.send(session.ws, {
        type: MessageType.SFU_CONSUMED,
        requestId,
        payload: {
          channelId: payload.channelId,
          ...consumed,
        } satisfies SfuConsumedPayload,
      });
    } catch (err) {
      if (err instanceof SfuProducerClosedError) {
        // The normal close broadcast may still be awaiting channel permissions.
        // Complete this request with the same terminal event, not a link error.
        this.send(session.ws, {
          type: MessageType.SFU_PRODUCER_CLOSED,
          requestId,
          payload: { channelId: payload.channelId, producerId: err.producerId } satisfies SfuProducerClosedPayload,
        });
        return;
      }
      console.error(`[SFU Server:WS] Error consuming producer ${payload.producerId} for ${session.user.nickname}:`, err);
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : 'Erro ao consumir mídia no SFU', requestId);
    }
  }

  private handleSfuProducerClosed(
    session: ClientSession,
    payload: SfuProducerClosedPayload
  ): void {
    if (!session.user || !session.sessionId) return;
    console.log(`[SFU Server:WS] User ${session.user.nickname} closed producer ${payload.producerId}`);
    this.sfuManager.closeProducer(payload.producerId);
    void this.broadcastToChannel(payload.channelId, {
      type: MessageType.SFU_PRODUCER_CLOSED,
      payload,
    });
  }

  private async handleSfuGetProducers(
    session: ClientSession,
    payload: SfuGetProducersPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    try {
      const channelProducers = this.sfuManager.getProducersInChannel(payload.channelId);
      console.log(`[SFU Server:WS] User ${session.user.nickname} requested producers list for channel ${payload.channelId} (found ${channelProducers.length})`);
      const producers: SfuNewProducerPayload[] = channelProducers.map((p) => ({
        channelId: payload.channelId,
        producerId: p.producerId,
        producerSessionId: p.producerSessionId,
        kind: p.kind,
        appData: p.appData,
      }));

      this.send(session.ws, {
        type: MessageType.SFU_PRODUCERS_LIST,
        requestId,
        payload: {
          channelId: payload.channelId,
          producers,
          participants: this.getVoiceRoster(payload.channelId, session.user.id),
        } satisfies SfuProducersListPayload,
      });
    } catch (err: any) {
      console.error(`[SFU Server:WS] Error listing producers for ${session.user.nickname}:`, err);
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err?.message || 'Erro ao listar produtores SFU', requestId);
    }
  }

  private async handleSfuConsumerSetPaused(
    session: ClientSession,
    payload: SfuConsumerSetPausedPayload
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    await this.sfuManager.setConsumerPaused(payload.consumerId, payload.paused);
  }

  private handleRtcDiagnosticsReport(
    session: ClientSession,
    payload: RtcDiagnosticsReportPayload
  ): void {
    if (!session.user || !session.sessionId) return;

    const targetSession = this.findSessionById(payload.targetSessionId);
    const fromName = session.user.nickname;
    const toName = targetSession?.user?.nickname ?? payload.targetSessionId;

    const fmtCandidate = (c: RtcDiagnosticsReportPayload['localCandidate']): string => {
      if (!c) return 'none';
      const addr = c.address ? `${c.address}:${c.port ?? '?'}` : 'unknown';
      return `${c.type} ${addr} (${c.protocol ?? '?'})`;
    };

    // Infer probable cause from candidate types
    let probableCause = 'unknown';
    if (!payload.remoteCandidate && !payload.localCandidate) {
      probableCause = 'signaling_failure_or_firewall';
    } else if (!payload.remoteCandidate) {
      probableCause = 'remote_unreachable (firewall or peer disconnected)';
    } else if (payload.localCandidate?.type === 'srflx' && payload.remoteCandidate?.type === 'srflx') {
      probableCause = 'symmetric_nat_or_cgnat (no TURN relay configured)';
    } else if (payload.localCandidate?.type === 'host' && payload.remoteCandidate?.type === 'host') {
      probableCause = 'different_networks_no_stun_success';
    } else {
      probableCause = 'nat_traversal_failed';
    }

    Logger.warn(
      'WEBRTC',
      `P2P connection failed: ${fromName} → ${toName} | ` +
      `local=${fmtCandidate(payload.localCandidate)} | ` +
      `remote=${fmtCandidate(payload.remoteCandidate)} | ` +
      `ICE gathering=${payload.iceGatheringState}, signaling=${payload.signalingState} | ` +
      `attempts: ICE restart=${payload.iceRestartAttempts}, hard reconnect=${payload.hardReconnectAttempts} | ` +
      `probable cause: ${probableCause}`
    );
  }

  private findSessionById(sessionId: string): ClientSession | undefined {
    const ws = this.sessionSockets.get(sessionId);
    if (ws) return this.sessions.get(ws);
    return undefined;
  }

  private isCurrentSession(session: BotInteractionSession): boolean {
    const current = this.sessions.get(session.ws);
    return !this.closing && current === session && !current.replaced && !current.intentionalLogout &&
      session.ws.readyState === WebSocket.OPEN && !!session.sessionId &&
      this.sessionSockets.get(session.sessionId) === session.ws;
  }

  private async requirePermission(
    session: ClientSession,
    permission: Permission,
    requestId?: string
  ): Promise<boolean> {
    if (!session.user) return false;
    const allowed = await this.permissionService.checkPermission(session.user.id, permission);
    if (allowed) return true;
    this.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Você não tem permissão para executar esta ação.', requestId);
    return false;
  }

  private async broadcastRolesState(requestId?: string): Promise<void> {
    const state = await this.roleService.getRoleState();
    const payload: RolesListPayload = {
      roles: state.roles,
      userRoles: state.userRoles,
    };
    this.broadcast({
      type: MessageType.ROLES_LIST,
      requestId,
      payload,
    });

    // Roles decide who may see a private channel, so any change to them can
    // grant or revoke access. Reconciling here covers every role mutation at
    // once — create, update, delete, assign and unassign all end up in this
    // method (#384).
    await this.reconcileChannelVisibility();
  }

  private async handleRoleCreate(session: ClientSession, payload: RoleCreatePayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const result = await this.roleService.createRole(session.user.id, payload);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao criar cargo.', requestId);
      return;
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleRoleUpdate(session: ClientSession, payload: RoleUpdatePayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const result = await this.roleService.updateRole(session.user.id, payload);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao atualizar cargo.', requestId);
      return;
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleRoleDelete(session: ClientSession, payload: RoleDeletePayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const result = await this.roleService.deleteRole(session.user.id, payload.roleId);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao excluir cargo.', requestId);
      return;
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleRoleAssign(session: ClientSession, payload: RoleAssignPayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const result = await this.roleService.assignRole(session.user.id, payload);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao atribuir cargo.', requestId);
      return;
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleRoleUnassign(session: ClientSession, payload: RoleAssignPayload, requestId?: string): Promise<void> {
    if (!session.user) return;
    const result = await this.roleService.unassignRole(session.user.id, payload);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao remover cargo.', requestId);
      return;
    }
    await this.broadcastRolesState(requestId);
  }

  private async handleAdminMuteUser(session: ClientSession, payload: AdminMuteUserPayload, requestId?: string): Promise<void> {
    const state = this.signalingService.getVoiceState(payload.targetSessionId);
    if (!state) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário não está em um canal de voz.', requestId);
      return;
    }
    const updated = this.signalingService.updateVoiceState(payload.targetSessionId, { serverMuted: payload.muted, isSpeaking: false });
    if (!updated) return;
    this.broadcast({ type: MessageType.ADMIN_MUTE_USER, requestId, payload });
    this.broadcast({ type: MessageType.VOICE_STATE_CHANGED, requestId, payload: { voiceState: updated } });
  }

  private async handleAdminDeafenUser(session: ClientSession, payload: AdminDeafenUserPayload, requestId?: string): Promise<void> {
    const state = this.signalingService.getVoiceState(payload.targetSessionId);
    if (!state) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário não está em um canal de voz.', requestId);
      return;
    }
    const updated = this.signalingService.updateVoiceState(payload.targetSessionId, { serverDeafened: payload.deafened, isSpeaking: false });
    if (!updated) return;
    this.broadcast({ type: MessageType.ADMIN_DEAFEN_USER, requestId, payload });
    this.broadcast({ type: MessageType.VOICE_STATE_CHANGED, requestId, payload: { voiceState: updated } });
  }

  private async handleAdminKickVoice(session: ClientSession, payload: AdminKickVoicePayload, requestId?: string): Promise<void> {
    const previous = this.signalingService.leaveVoiceChannel(payload.targetSessionId);
    if (!previous) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário não está em um canal de voz.', requestId);
      return;
    }

    // Being kicked out of the call is a departure like any other, but the
    // client only tears itself down locally — it never sends VOICE_LEAVE — so
    // the SFU has to be reaped from here (#527).
    this.closeSfuSession(previous.sessionId, previous.channelId);

    this.broadcast({ type: MessageType.ADMIN_KICK_VOICE, requestId, payload });
    this.broadcast({
      type: MessageType.VOICE_USER_LEFT,
      requestId,
      payload: { channelId: previous.channelId, userId: previous.userId, sessionId: previous.sessionId },
    });
  }

  private async handleAdminMoveUser(session: ClientSession, payload: AdminMoveUserPayload, requestId?: string): Promise<void> {
    const previous = this.signalingService.getVoiceState(payload.targetSessionId);
    if (!previous) {
      this.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário não está em um canal de voz.', requestId);
      return;
    }
    if (previous.channelId === payload.channelId) {
      return;
    }

    // Moving someone into a private channel they cannot access would drop them
    // into a room that is not even in their channel list (#384).
    if (!(await this.channelService.canUserAccessChannel(previous.userId, payload.channelId))) {
      this.sendError(
        session.ws,
        ProtocolErrorCode.PERMISSION_DENIED,
        'O usuário não tem acesso a esse canal.',
        requestId
      );
      return;
    }

    const joinResult = await this.signalingService.joinVoiceChannel(payload.targetSessionId, previous.userId, payload.channelId);
    if (!joinResult.success || !joinResult.voiceState) {
      this.sendError(session.ws, joinResult.errorCode || ProtocolErrorCode.BAD_REQUEST, joinResult.errorMessage || 'Não foi possível mover o usuário.', requestId);
      return;
    }

    this.broadcast({ type: MessageType.ADMIN_MOVE_USER, requestId, payload });
    this.broadcast({
      type: MessageType.VOICE_USER_LEFT,
      requestId,
      payload: { channelId: previous.channelId, userId: previous.userId, sessionId: previous.sessionId },
    });
    // The arrival is scoped like any other join, so a private room's activity
    // stays with the members who can see it (#384).
    await this.broadcastToChannel(payload.channelId, {
      type: MessageType.VOICE_USER_JOINED,
      requestId,
      payload: {
        channelId: payload.channelId,
        userId: previous.userId,
        sessionId: previous.sessionId,
        voiceState: joinResult.voiceState,
      },
    });
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

    const result = await this.userService.deleteMember(targetUserId);
    if (!result.success) {
      this.sendError(session.ws, result.errorCode ?? ProtocolErrorCode.BAD_REQUEST, result.errorMessage ?? 'Não foi possível expulsar o membro.', requestId);
      return;
    }

    // Kicking removes the person, so every device they are signed in from has to
    // go — not just the most recent one (#309). Marked before any further await
    // so concurrent in-flight messages from them are dropped by handleMessage.
    const targetSessions = this.getSessionsOfUser(targetUserId);
    for (const targetSession of targetSessions) targetSession.replaced = true;

    // Invalidate any outstanding HTTP upload tokens the member still holds.
    this.attachmentService.revokeTokensForUser(targetUserId);

    // Remove the target from any voice channel they were in (one state per device).
    for (const previousVoice of this.signalingService.getSessionsOfUser(targetUserId)) {
      this.signalingService.leaveVoiceChannel(previousVoice.sessionId);
      // The sessions were already marked as replaced above, which makes
      // handleDisconnect return early and skip announceVoiceLeave, so this is
      // the last chance to reap what they held in the SFU (#527).
      this.closeSfuSession(previousVoice.sessionId, previousVoice.channelId);
      this.broadcast({
        type: MessageType.VOICE_USER_LEFT,
        payload: {
          channelId: previousVoice.channelId,
          userId: targetUserId,
          sessionId: previousVoice.sessionId,
        },
      });
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

    // Role assignments were removed with the user, so refresh role state.
    await this.broadcastRolesState();

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

  private handleDisconnect(session: ClientSession): void {
    const wasConnected = this.sessions.delete(session.ws);
    this.authService.clearChallenge(session.ws);
    this.botInteractions.disconnect(session);

    // If this session was replaced by a newer connection of the same device, it
    // is a stale/zombie socket. Do not broadcast USER_LEFT nor touch the
    // sessionSockets mapping (which now points at the newer session).
    if (!wasConnected || session.replaced) {
      return;
    }

    // Bots: clear registered commands on disconnect (#569).
    if (session.isBot && session.botId) {
      this.commandRegistry.clearBot(session.botId);
      this.broadcastCommands();
    }

    if (!session.user || !session.sessionId) {
      return;
    }

    const user = session.user;
    const sessionId = session.sessionId;

    // Only clear the mapping if it still points at this exact socket.
    if (this.sessionSockets.get(sessionId) === session.ws) {
      this.sessionSockets.delete(sessionId);
    }
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
    this.announceVoiceLeave(user, sessionId);

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
   * Reaps everything one connection held in the SFU and tells the channel that
   * those producers are gone. Without this, whoever joins next is handed a
   * producer with nobody behind it and sits there consuming a ghost (#527).
   */
  private closeSfuSession(sessionId: string, channelId: string): void {
    if (!this.sfuManager) return;
    const { closedProducerIds } = this.sfuManager.closeSession(sessionId);
    for (const producerId of closedProducerIds) {
      this.broadcast({
        type: MessageType.SFU_PRODUCER_CLOSED,
        payload: { channelId, producerId } satisfies SfuProducerClosedPayload,
      });
    }
  }

  /**
   * Takes one connection out of its voice channel and tells everyone about it.
   *
   * Idempotent: `leaveVoiceChannel` returns null when the session is not in a
   * channel, so calling it twice (a socket that reports both `error` and
   * `close`, for instance) announces the departure only once.
   */
  private announceVoiceLeave(user: UserSummary, sessionId: string): void {
    const previousVoice = this.signalingService.leaveVoiceChannel(sessionId);
    if (!previousVoice) return;

    this.closeSfuSession(sessionId, previousVoice.channelId);

    const leavePayload: VoiceUserLeftPayload = {
      channelId: previousVoice.channelId,
      userId: user.id,
      sessionId,
    };
    this.broadcast({
      type: MessageType.VOICE_USER_LEFT,
      payload: leavePayload,
    });
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
    this.announceVoiceLeave(user, sessionId);

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
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, session] of this.sessions.entries()) {
        if (!session.isAlive) {
          Logger.warn('NETWORK', `Terminating dead socket for ${session.user?.nickname || session.ip}`);
          ws.terminate();
          this.handleDisconnect(session);
          continue;
        }
        session.isAlive = false;
        ws.ping();
      }
    }, LIMITS.HEARTBEAT_INTERVAL_MS);
  }

  public send(ws: WebSocket, message: ProtocolMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  public broadcast(message: ProtocolMessage, ignoreWs?: WebSocket): void {
    const raw = JSON.stringify(message);
    for (const [ws, session] of this.sessions.entries()) {
      if (ws !== ignoreWs && ws.readyState === WebSocket.OPEN && session.user && !session.replaced) {
        ws.send(raw);
      }
    }
  }

  /**
   * Broadcasts an event that belongs to a channel, reaching only the members
   * allowed into it (#384). Public channels take the plain broadcast path, so
   * the common case costs nothing extra.
   */
  private async broadcastToChannelAudience(
    channel: { isPrivate: boolean; allowedRoleIds: string[] },
    message: ProtocolMessage,
    ignoreWs?: WebSocket,
    canSend?: () => boolean
  ): Promise<void> {
    if (!channel.isPrivate) {
      if (!canSend || canSend()) this.broadcast(message, ignoreWs);
      return;
    }

    const allowedUserIds = await this.resolveChannelAudience(channel);
    if (canSend && !canSend()) return;
    const raw = JSON.stringify(message);
    for (const [ws, session] of this.sessions.entries()) {
      if (ws !== ignoreWs && ws.readyState === WebSocket.OPEN && session.user && !session.replaced && allowedUserIds.has(session.user.id)) {
        ws.send(raw);
      }
    }
  }

  /**
   * Ids of the connected users allowed into a channel. Permissions are resolved
   * once per person, not per socket, since one member may hold several
   * connections (#309), and the whole set is settled before anything is sent so
   * the delivery loop itself stays synchronous.
   */
  private async resolveChannelAudience(channel: {
    isPrivate: boolean;
    allowedRoleIds: string[];
  }): Promise<Set<string>> {
    const userIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.user) userIds.add(session.user.id);
    }

    const allowed = new Set<string>();
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        const context = await this.channelService.getAccessContext(userId);
        if (canAccessChannel(channel, context.permissions, context.roleIds)) {
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
  /**
   * Refuses SFU traffic on a server that is not in SFU mode (#515).
   *
   * Sits at dispatch because two of these handlers are self-sufficient:
   * `SFU_GET_ROUTER_RTP_CAPABILITIES` and `SFU_CREATE_WEBRTC_TRANSPORT` both
   * boot the mediasoup worker on demand, and the latter goes further and
   * allocates a UDP/TCP port pair per call. Without this any authenticated
   * member could spawn a worker — and burn ports — on a server the operator
   * deliberately left in P2P. Guarding only the handshake entry point would
   * miss the shorter and more expensive path.
   */
  private async requireSfuMode(session: ClientSession, requestId?: string): Promise<boolean> {
    const server = await this.serverRepo.getServer();
    if (server?.voiceMode === 'sfu') return true;

    // Not SFU_UNAVAILABLE: that code means the host cannot carry SFU media and
    // the client surfaces it to the admin with the reason attached. This is an
    // ordinary request arriving for the wrong mode — a client still closing
    // producers while the server is switched to P2P hits it on the normal
    // path, and it must not raise an alarm at everyone in the call.
    this.sendError(
      session.ws,
      ProtocolErrorCode.BAD_REQUEST,
      'Este servidor não está no modo SFU.',
      requestId
    );
    return false;
  }

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

  /**
   * Scopes an event to the members allowed into the channel it belongs to
   * (#384). A deleted channel no longer has an audience; broadcasting it to
   * everyone would expose previously private content during a deletion race.
   */
  private async broadcastToChannel(
    channelId: string,
    message: ProtocolMessage,
    ignoreWs?: WebSocket,
    canSend?: () => boolean
  ): Promise<void> {
    const channel = await this.channelService.getChannelSummary(channelId);
    if (!channel) return;
    await this.broadcastToChannelAudience(channel, message, ignoreWs, canSend);
  }

  /**
   * Brings every client's channel list back in sync with what it is allowed to
   * see (#384), pushing only the difference: channels that just became visible
   * arrive as CHANNEL_CREATED, ones that no longer are leave as CHANNEL_DELETED.
   *
   * Anyone who loses access while sitting in that voice channel is disconnected
   * from it, otherwise they would keep talking in a room they can no longer see.
   */
  private async reconcileChannelVisibility(): Promise<void> {
    const channels = await this.channelService.listChannels();
    const channelsById = new Map(channels.map((channel) => [channel.id, channel]));

    const contexts = new Map<string, { permissions: number; roleIds: string[] }>();
    const userIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.user) userIds.add(session.user.id);
    }
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        contexts.set(userId, await this.channelService.getAccessContext(userId));
      })
    );
    this.botInteractions.reconcileAccess(channelsById, contexts);

    for (const [ws, session] of this.sessions.entries()) {
      if (!session.user || ws.readyState !== WebSocket.OPEN) continue;

      const context = contexts.get(session.user.id);
      if (!context) continue;

      const previouslyVisible = session.visibleChannelIds ?? new Set<string>();
      const nowVisible = new Set(
        channels
          .filter((channel) => canAccessChannel(channel, context.permissions, context.roleIds))
          .map((channel) => channel.id)
      );

      for (const channelId of nowVisible) {
        if (previouslyVisible.has(channelId)) continue;
        const channel = channelsById.get(channelId);
        if (!channel) continue;
        this.send(ws, {
          type: MessageType.CHANNEL_CREATED,
          payload: { channel } as ChannelCreatedPayload,
        });
      }

      for (const channelId of previouslyVisible) {
        if (nowVisible.has(channelId)) continue;
        if (session.sessionId) this.evictFromVoiceChannel(session.sessionId, channelId);
        this.send(ws, {
          type: MessageType.CHANNEL_DELETED,
          payload: { channelId } as ChannelDeletedPayload,
        });
      }

      session.visibleChannelIds = nowVisible;
    }
  }

  /**
   * Removes one connection from a voice channel it may no longer be in, telling
   * the remaining participants it left (#384). No-op when it was not connected.
   */
  private evictFromVoiceChannel(sessionId: string, channelId: string): void {
    const participants = this.signalingService.getParticipantsInChannel(channelId);
    const participant = participants.find((p) => p.sessionId === sessionId);
    if (!participant) return;

    this.signalingService.leaveVoiceChannel(sessionId);
    const leavePayload: VoiceUserLeftPayload = {
      channelId,
      userId: participant.userId,
      sessionId,
    };
    // Deliberately unscoped: the person being evicted is, by definition, no
    // longer in the channel's audience, and they still need this event to clear
    // their own voice state before the channel disappears from their list.
    this.broadcast({
      type: MessageType.VOICE_USER_LEFT,
      payload: leavePayload,
    });
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

  /**
   * @param kind Why the sessions are being closed. 'update' tells the clients
   * the server is coming back on its own, so they keep reconnecting instead of
   * dropping to the home screen (#558).
   */
  public close(kind: ServerShutdownKind = 'shutdown'): void {
    if (this.closing) return;
    this.closing = true;
    this.botInteractions.close();
    this.botSelectors?.close();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    // Let connected clients know why their session is ending, so they can show a
    // friendly notice instead of silently trying to reconnect forever — and, on
    // an update, keep reconnecting instead of dropping to the home screen.
    //
    // `reason` stays for clients that predate `kind` and would otherwise show
    // nothing; anyone who understands `kind` translates it themselves, because
    // this text is written in the server's language, not the reader's.
    const shutdownPayload: ServerShutdownPayload = {
      kind,
      reason:
        kind === 'update'
          ? 'O servidor está sendo atualizado e volta em instantes.'
          : 'O anfitrião encerrou o servidor.',
    };
    this.broadcast({
      type: MessageType.SERVER_SHUTDOWN,
      payload: shutdownPayload,
    });
    for (const ws of this.sessions.keys()) {
      ws.close();
    }
    // Closing gracefully lets clients show the shutdown notice, but a peer that
    // never answers the close frame would keep its socket — and the HTTP server
    // waiting on it — alive for the ws library's 30s close timeout. Unref'd so
    // it can never hold the process open by itself (#333).
    const forceClose = setTimeout(() => {
      for (const ws of this.sessions.keys()) {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
    }, LIMITS.SHUTDOWN_GRACE_MS);
    forceClose.unref?.();
    this.sfuManager?.close();
    this.wss.close();
  }
}
