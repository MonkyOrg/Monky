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
  ChatMentionsReadPayload,
  ChatMessage,
  ChatMessageUpdatedPayload,
  ChatRequestUploadTokenPayload,
  ChatSendPayload,
  ChatUploadTokenPayload,
  LIMITS,
  MessageType,
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
  VoiceJoinPayload,
  VoiceLeavePayload,
  VoiceStateChangedPayload,
  VoiceStateUpdatePayload,
  VoiceUserJoinedPayload,
  VoiceUserLeftPayload,
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
} from '@monky/shared';
import { AuthService } from '../../application/services/AuthService';
import { AttachmentService } from '../../application/services/AttachmentService';
import { ChannelService } from '../../application/services/ChannelService';
import { ChatService } from '../../application/services/ChatService';
import { PermissionService } from '../../application/services/PermissionService';
import { RoleService } from '../../application/services/RoleService';
import { SignalingService } from '../../application/services/SignalingService';
import { UserService } from '../../application/services/UserService';
import { IServerRepository } from '../../domain/repositories';
import { scanServerNetworkInterfaces } from '../discovery/ServerIpScanner';
import { CoturnManager } from '../turn/CoturnManager';
import { describeSfuPortProblem, SfuManager } from '../sfu/SfuManager';
import { checkSfuPreflight, formatSfuPreflightForLog } from '../sfu/SfuPreflight';
import { Logger } from '../logger/Logger';
import { RateLimiter } from '../security/RateLimiter';

interface ClientSession {
  ws: WebSocket;
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
    private rateLimiter: RateLimiter,
    // Kept last: it is the only one with a default, and TypeScript requires a
    // parameter with an initialiser to come after every required one.
    private sfuManager: SfuManager = new SfuManager()
  ) {
    // Without a ceiling the ws default of 100 MiB applies, so an
    // unauthenticated client could have the server buffer and JSON.parse a
    // frame that size (#372).
    this.wss = new WSServer({ server: this.server, maxPayload: LIMITS.WS_MAX_PAYLOAD_BYTES });
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
        isAlive: true,
        ip,
        requestHost: WebSocketServer.parseRequestHostname(req.headers.host),
      };
      this.sessions.set(ws, session);

      ws.on('pong', () => {
        session.isAlive = true;
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const rawStr = data.toString('utf8');
          const message: ProtocolMessage = JSON.parse(rawStr);
          await this.handleMessage(session, message);
        } catch (err: any) {
          Logger.error('NETWORK', 'Failed to process message', err);
          this.sendError(ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem malformada');
        }
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
    if (session.replaced) {
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
      // Verificar a senha custa uma derivação scrypt, então deixar isso sem
      // medida entregava de uma vez um laço infinito de adivinhação de senha e
      // um jeito de manter o servidor ocupado (#372). Só a tentativa que falha
      // gasta cota: quem entra normalmente não é penalizado, e várias pessoas
      // atrás do mesmo IP público continuam reconectando depois de uma queda.
      if (!this.rateLimiter.peek(
        `auth:${session.ip}`,
        LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS,
        LIMITS.RATE_LIMIT_AUTH_WINDOW_MS
      )) {
        Logger.security(`Authentication rate limit reached for ${session.ip}`);
        // Código próprio: o cliente traduz por código, e RATE_LIMITED já
        // significa "flood de mensagens" para ele (#372).
        this.sendError(session.ws, ProtocolErrorCode.AUTH_RATE_LIMITED, 'Muitas tentativas de conexão. Aguarde um minuto.', requestId);
        return;
      }
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
    const result = await this.authService.createChallenge(session.ws, payload);

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
    payload: AuthChallengeResponsePayload,
    requestId?: string
  ): Promise<void> {
    const result = await this.authService.verifyChallengeResponse(session.ws, payload.signature);

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

    // Prevent duplicate sessions for the *same device*. A lingering/zombie socket
    // (e.g. after a reconnect where the old TCP connection was not yet cleaned
    // up) would otherwise receive every broadcast twice. Note this is keyed by
    // sessionId, not by user: another device of the same person is a legitimate
    // second session and must be left alone (#309).
    const existingWs = this.sessionSockets.get(sessionId);
    if (existingWs && existingWs !== session.ws) {
      const staleSession = this.sessions.get(existingWs);
      if (staleSession) {
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
    const pendingTimer = this.reconnectTimers.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.reconnectTimers.delete(sessionId);
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

    // Populate current voice states into serverDetails
    result.serverDetails.voiceStates = this.signalingService.getAllVoiceStates();

    // Remember exactly which channels this client was told about, so later role
    // or privacy changes can be reconciled into deltas (#384).
    session.visibleChannelIds = new Set(result.serverDetails.channels.map((c) => c.id));

    // Send AUTH_SUCCESS to the connecting client
    const successPayload: AuthSuccessPayload = {
      server: {
        ...result.serverDetails,
        // Told at login because it never changes while the process lives: it
        // depends on the host OS and on coturn being installed (#429).
        turnAvailability: CoturnManager.describeAvailability(),
      },
      currentUser: result.user,
      roles: result.serverDetails.roles,
      userRoles: result.serverDetails.userRoles,
      ownerId: result.serverDetails.ownerId,
      myPermissions: result.serverDetails.myPermissions,
      iceServers: await this.buildIceServersFor(result.user.id, session),
    };

    this.send(session.ws, {
      type: MessageType.AUTH_SUCCESS,
      requestId,
      payload: successPayload,
    });

    // Broadcast USER_JOINED to all other clients
    const userJoinedPayload: UserJoinedPayload = { user: result.user };
    this.broadcast({
      type: MessageType.USER_JOINED,
      payload: userJoinedPayload,
    }, session.ws);

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

    const result = await this.chatService.sendMessage(
      session.user.id,
      payload.channelId,
      payload.content,
      payload.attachmentIds
    );
    if (!result.success || !result.message) {
      this.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao enviar mensagem',
        requestId
      );
      return;
    }

    // Broadcast message to everyone allowed into this channel (#384).
    await this.broadcastToChannel(result.message.channelId, {
      type: MessageType.CHAT_MESSAGE,
      requestId,
      payload: result.message,
    });
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
    const messages = await this.chatService.loadHistory(
      payload.channelId,
      payload.limit || LIMITS.MAX_HISTORY_MESSAGES_INITIAL,
      payload.beforeTimestamp
    );

    const historyPayload: ChatHistoryPayload = {
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
    const updatePayload: UserUpdatedPayload = { user: result.updatedUser };

    this.broadcast({
      type: MessageType.USER_UPDATED,
      requestId,
      payload: updatePayload,
    });
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
    const updatePayload: UserUpdatedPayload = { user: result.updatedUser };

    this.broadcast({
      type: MessageType.USER_UPDATED,
      requestId,
      payload: updatePayload,
    });
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

    const joinPayload: VoiceUserJoinedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
      sessionId: session.sessionId,
      voiceState: result.voiceState,
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

    const updated = this.signalingService.updateVoiceState(session.sessionId, effectivePayload);
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
    } catch (err: any) {
      console.error(`[SFU Server:WS] Error consuming producer ${payload.producerId} for ${session.user.nickname}:`, err);
      this.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err?.message || 'Erro ao consumir mídia no SFU', requestId);
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

    // Announce the removal. The initiator gets a direct reply carrying the
    // requestId (resolving their pending request) while everyone else — the
    // kicked user included — receives it via broadcast. Sent before closing the
    // target socket so it still arrives.
    const kickedPayload: MemberKickedPayload = { userId: targetUserId, nickname: result.nickname ?? '' };
    this.send(session.ws, { type: MessageType.MEMBER_KICKED, requestId, payload: kickedPayload });
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
    this.sessions.delete(session.ws);
    this.authService.clearChallenge(session.ws);

    // If this session was replaced by a newer connection of the same device, it
    // is a stale/zombie socket. Do not broadcast USER_LEFT nor touch the
    // sessionSockets mapping (which now points at the newer session).
    if (session.replaced) {
      return;
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
    if (session.intentionalLogout) {
      this.finalizeSessionLeave(user, sessionId);
      return;
    }

    // Notify everyone else that this session lost connection (#44).
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
    Logger.info('NETWORK', `User ${user.nickname} lost connection (aguardando reconexão)`);

    // Clear any previous timer just in case, then start the grace period.
    const existingTimer = this.reconnectTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      // Only finalize if this session hasn't reconnected in the meantime.
      if (this.sessionSockets.has(sessionId)) return;
      this.finalizeSessionLeave(user, sessionId);
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
  private finalizeSessionLeave(user: UserSummary, sessionId: string): void {
    // Normally already done by handleDisconnect; kept for the paths that
    // finalize a session without going through it.
    this.announceVoiceLeave(user, sessionId);
    const userLeftPayload: UserLeftPayload = {
      userId: user.id,
      sessionId,
      nickname: user.nickname,
    };
    this.broadcast({
      type: MessageType.USER_LEFT,
      payload: userLeftPayload,
    });

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
      if (ws !== ignoreWs && ws.readyState === WebSocket.OPEN && session.user) {
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
    ignoreWs?: WebSocket
  ): Promise<void> {
    if (!channel.isPrivate) {
      this.broadcast(message, ignoreWs);
      return;
    }

    const allowedUserIds = await this.resolveChannelAudience(channel);
    const raw = JSON.stringify(message);
    for (const [ws, session] of this.sessions.entries()) {
      if (ws !== ignoreWs && ws.readyState === WebSocket.OPEN && session.user && allowedUserIds.has(session.user.id)) {
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
   * (#384). Falls back to a plain broadcast when the channel is gone, matching
   * the previous behaviour for events that outlive their channel.
   */
  private async broadcastToChannel(
    channelId: string,
    message: ProtocolMessage,
    ignoreWs?: WebSocket
  ): Promise<void> {
    const channel = await this.channelService.getChannelSummary(channelId);
    if (!channel) {
      this.broadcast(message, ignoreWs);
      return;
    }
    await this.broadcastToChannelAudience(channel, message, ignoreWs);
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

  public close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    // Let connected clients know the host is shutting the server down so they can
    // show a friendly notice and return to the home screen instead of silently
    // trying to reconnect forever.
    this.broadcast({
      type: MessageType.SERVER_SHUTDOWN,
      payload: { reason: 'O anfitrião encerrou o servidor.' },
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
