import type { WebSocket } from 'ws';
import {
  DEFAULT_PERMISSIONS, LIMITS, MessageType, PROTOCOL_VERSION, ProtocolErrorCode, authConnectSchema, botIdentitySchema,
  canAccessChannel, localBotIdentitySchema, negotiateProtocol, roleModelFor, rolesForModel,
  type AuthChallengePayload, type AuthConnectPayload, type AuthFailedPayload, type AuthSuccessPayload, type RolesListPayload,
  type ServerMessage, type UserConnectionStatePayload, type UserJoinedPayload, type UserSummary,
} from '@monky/shared';
import type { AuthService } from '../../application/services/AuthService';
import type { BotDiagnosticService } from '../../application/services/BotDiagnosticService';
import type { BotService } from '../../application/services/BotService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { CommandRegistry } from '../../application/services/CommandRegistry';
import type { DmRelayService } from '../../application/services/DmRelayService';
import type { RoleService } from '../../application/services/RoleService';
import { auditRef } from '../../application/services/ServerAuditService';
import type { SignalingService } from '../../application/services/SignalingService';
import type { IServerRepository } from '../../domain/repositories';
import { Logger } from '../logger/Logger';
import type { RateLimiter } from '../security/RateLimiter';
import { CoturnManager } from '../turn/CoturnManager';
import type { ChannelVisibility } from './access/ChannelVisibility';
import type { AuditRecorder } from './AuditRecorder';
import type { BotInteractionSession } from './BotInteractionHandler';
import type { BotManagementHandler } from './BotManagementHandler';
import type { ClientSession } from './ClientSession';
import type { PresenceHandler } from './PresenceHandler';
import type { RoleHandler } from './RoleHandler';
import { route, type Route } from './routing/MessageRouter';
import { sameCustomStatus, userForRecipient } from './userProjection';
import { voiceRosterUser } from './voice/VoiceSessionHandler';

/** How long a stale login waits for an access change in progress to end before catching up anyway (see resyncLoginAccess). */
const LOGIN_RESYNC_WAIT_MS = 1_000;
const LOGIN_RESYNC_POLL_MS = 20;

export interface AuthHost {
  readonly auth: AuthService;
  readonly rateLimiter: Pick<RateLimiter, 'reserve' | 'checkLimit'>;
  readonly botService?: BotService;
  readonly botDiagnostics?: BotDiagnosticService;
  readonly signaling: SignalingService;
  readonly channels: ChannelService;
  readonly roles: RoleService;
  readonly serverRepo: IServerRepository;
  readonly coturn: Pick<CoturnManager, 'buildIceServers'>;
  readonly serverVersion: string | null;
  readonly commandRegistry: CommandRegistry;
  readonly visibility: Pick<ChannelVisibility, 'presenceKey' | 'includePresenceChannels' | 'syncVoicePresence' | 'sendChannels' | 'visibleChannelIds'>;
  readonly presence: Pick<PresenceHandler, 'setVisibility' | 'applyBrb' | 'applyCustomStatus'>;
  readonly roleAdmin: Pick<RoleHandler, 'broadcastState'>;
  readonly botManagement: Pick<BotManagementHandler, 'sendCommands' | 'sendSettingsList' | 'broadcastCommands' | 'broadcastSettings'>;
  readonly auditLog: AuditRecorder;
  readonly dmRelay: Pick<DmRelayService<ClientSession>, 'register'>;
  /** Open, registered and the server not closing: checked again after every wait on the way to signing in. */
  isLive(session: ClientSession): boolean;
  isCurrentSession(session: BotInteractionSession): boolean;
  /** True while neither channel nor role access moved since. */
  captureAccess(): () => boolean;
  /** A connection signing in stops counting among the anonymous ones. */
  settleAnonymous(session: ClientSession): void;
  findSocket(sessionId: string): WebSocket | undefined;
  findSession(sessionId: string): ClientSession | undefined;
  /** Makes this socket the device's connection. */
  bindSocket(sessionId: string, ws: WebSocket): void;
  /** Lets go an older connection of the same device. */
  replaceConnection(ws: WebSocket): void;
  /** Ends the grace a dropped connection of this device had to come back (#44); whether one was pending. */
  endReconnectGrace(sessionId: string): boolean;
  onlineUsers(): Map<string, { user: UserSummary }>;
  sessionsOfUser(userId: string): ClientSession[];
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string, serverProtocolVersion?: number): void;
  broadcast(message: ServerMessage, ignoreWs?: WebSocket): void;
}

/**
 * Signing in, for people and bots, and what each connection is told as it
 * joins. Every wait on the way is followed by a check that the connection is
 * still live, so one let go meanwhile is neither answered nor admitted; the
 * connection itself is admitted by the server, which keeps them.
 */
export class AuthHandler {
  constructor(private readonly host: AuthHost) {}

  routes(): Route[] {
    return [
      route({
        types: [MessageType.AUTH_CONNECT], anonymous: true,
        handle: ({ session, payload, requestId }) => this.authenticate(session, payload, requestId),
      }),
      route({
        types: [MessageType.AUTH_CHALLENGE_RESPONSE], anonymous: true,
        handle: ({ session, payload, requestId }) => this.answerChallenge(session, payload, requestId),
      }),
      // A separate connection used by `<bot> doctor`, so it never creates, replaces or binds a bot session.
      route({
        types: [MessageType.BOT_DIAGNOSTIC], anonymous: true,
        handle: ({ session, payload, requestId }) => this.diagnoseBot(session, payload, requestId),
      }),
    ];
  }

  /** AUTH_CONNECT, within the budget of failed attempts per address (#372). */
  private async authenticate(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    // Verificar a senha custa uma derivação scrypt, então deixar isso sem
    // medida entregava de uma vez um laço infinito de adivinhação de senha e
    // um jeito de manter o servidor ocupado (#372). Só a tentativa que falha
    // gasta cota: quem entra normalmente não é penalizado, e várias pessoas
    // atrás do mesmo IP público continuam reconectando depois de uma queda.
    const release = this.host.rateLimiter.reserve(
      `auth:${session.ip}`,
      LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS,
      LIMITS.RATE_LIMIT_AUTH_WINDOW_MS
    );
    if (!release) {
      Logger.security(`Authentication rate limit reached for ${session.ip}`);
      // Código próprio: o cliente traduz por código, e RATE_LIMITED já
      // significa "flood de mensagens" para ele (#372).
      this.host.sendError(session.ws, ProtocolErrorCode.AUTH_RATE_LIMITED, 'Muitas tentativas de conexão. Aguarde um minuto.', requestId);
      return;
    }
    try {
      await this.connect(session, payload as AuthConnectPayload, requestId);
    } finally {
      release();
    }
  }

  /** The protocol both ends speak, then a challenge for a person or the token check of a bot. */
  private async connect(session: ClientSession, payload: AuthConnectPayload, requestId?: string): Promise<void> {
    if (!payload || typeof payload !== 'object') {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de autenticação inválidos.', requestId);
      return;
    }
    session.protocol = negotiateProtocol(payload.protocolVersion, payload.protocolOffer, payload.botToken ? 'bot' : 'client') ?? undefined;
    // Bot token auth: skip challenge-response, authenticate directly (#569).
    if (payload.botToken && this.host.botService) {
      await this.authenticateBot(session, payload, requestId);
      return;
    }

    const result = await this.host.auth.createChallenge(session.ws, payload);
    if (!this.host.isLive(session)) return;

    if (!result.success || !result.nonce) {
      // Aqui é onde a senha errada aparece: é esta tentativa que conta para o
      // limite por IP (#372).
      this.host.rateLimiter.checkLimit(
        `auth:${session.ip}`,
        LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS,
        LIMITS.RATE_LIMIT_AUTH_WINDOW_MS
      );
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.INTERNAL_ERROR,
        result.errorMessage || 'Falha na autenticação',
        requestId,
        result.serverProtocolVersion
      );
      return;
    }

    this.host.send(session.ws, {
      type: MessageType.AUTH_CHALLENGE,
      requestId,
      payload: { nonce: result.nonce } satisfies AuthChallengePayload,
    });
  }

  /** A person who signed the challenge joins: AUTH_SUCCESS with what they may see, then everyone else is told. */
  private async answerChallenge(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    // A malformed answer is the client's mistake, not a server failure to log with a stack.
    const signature = payload !== null && typeof payload === 'object' && 'signature' in payload ? payload.signature : undefined;
    if (typeof signature !== 'string') {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Resposta de autenticação inválida.', requestId);
      return;
    }
    // Probed before anything is read for this login: on Linux it runs `which`
    // and `sudo`, and a change published meanwhile would reach this connection
    // ahead of the AUTH_SUCCESS that overwrites it. Shared and cached, the probe
    // only delays the logins that arrive while it runs.
    const turnAvailability = await CoturnManager.availability();
    if (!this.host.isLive(session)) return;
    // Nothing from here to AUTH_SUCCESS may wait on a process or the network.
    // A role or channel change landing anyway makes the snapshot stale for this
    // connection alone (see resyncLoginAccess).
    const accessUnchanged = this.host.captureAccess();
    const result = await this.host.auth.verifyChallengeResponse(session.ws, signature);
    if (!this.host.isLive(session)) return;

    if (!result.success || !result.user || !result.serverDetails) {
      if (result.authFailed) {
        this.host.send(session.ws, {
          type: MessageType.AUTH_FAILED,
          requestId,
          payload: {
            code: result.errorCode,
            message: result.errorMessage || 'Falha na autenticação',
          } satisfies AuthFailedPayload,
        });
        return;
      }
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.INTERNAL_ERROR,
        result.errorMessage || 'Falha na autenticação',
        requestId
      );
      return;
    }

    session.user = result.user;
    this.host.settleAnonymous(session);
    const sessionId = result.user.sessionId!;
    session.sessionId = sessionId;
    session.invisible = result.appearOffline === true;
    // "Volto já" only exists between peers that negotiated it (user-brb).
    result.user.brb = !session.isBot && result.brb === true && session.protocol?.features.includes('user-brb') ? true : undefined;
    // A custom status is the other choice beside "Volto já", never both (custom-status).
    result.user.customStatus = !session.isBot && !result.user.brb && session.protocol?.features.includes('custom-status')
      ? result.customStatus : undefined;
    if (result.newMember) this.host.auditLog.record(session, 'member.join', { target: auditRef.member(result.user) });

    // Prevent duplicate sessions for the *same device*. A lingering/zombie socket
    // (e.g. after a reconnect where the old TCP connection was not yet cleaned
    // up) would otherwise receive every broadcast twice. Note this is keyed by
    // sessionId, not by user: another device of the same person is a legitimate
    // second session and must be left alone (#309).
    const existingWs = this.host.findSocket(sessionId);
    if (existingWs && existingWs !== session.ws) {
      this.host.replaceConnection(existingWs);
      Logger.info('NETWORK', `Replaced stale session ${sessionId}`);
    }

    this.host.bindSocket(sessionId, session.ws);
    this.host.dmRelay.register(session);

    // If this session had a pending "reconnecting" grace timer (from a recent
    // ungraceful drop), cancel it and tell everyone they are back online (#44).
    // Invisible users suppress the online broadcast (#561).
    if (this.host.endReconnectGrace(sessionId) && !session.invisible) {
      const backOnlinePayload: UserConnectionStatePayload = {
        userId: result.user.id,
        sessionId,
        nickname: result.user.nickname,
        status: 'online',
      };
      this.host.broadcast({
        type: MessageType.USER_CONNECTION_STATE,
        payload: backOnlinePayload,
      }, session.ws);
    }

    // Remember exactly which channels this client was told about, so later role
    // or privacy changes can be reconciled into deltas (#384).
    const voicePresenceKey = this.host.visibility.presenceKey(result.user.id);
    await this.host.visibility.includePresenceChannels(result.user.id, result.serverDetails);
    session.visibleChannelIds = new Set(result.serverDetails.channels.map((c) => c.id));
    session.voicePresenceKey = voicePresenceKey;
    result.serverDetails.voiceStates = Object.fromEntries(
      Object.entries(this.host.signaling.getAllVoiceStates())
        .filter(([, state]) => session.visibleChannelIds?.has(state.channelId))
    );

    // Each client reads roles in the model it negotiated.
    if (result.serverDetails.roles) {
      result.serverDetails.roles = rolesForModel(result.serverDetails.roles,
        result.serverDetails.everyonePermissions ?? DEFAULT_PERMISSIONS, roleModelFor(session.protocol?.features));
    }

    // Send AUTH_SUCCESS to the connecting client
    const iceServers = await this.buildIceServersFor(result.user.id, session);
    if (!this.host.isLive(session)) return;
    const successPayload: AuthSuccessPayload = {
      server: {
        ...result.serverDetails,
        protocol: session.protocol,
        serverVersion: this.host.serverVersion,
        // Told at login because it depends on the host OS and on coturn being
        // installed (#429), which only change through an installation.
        turnAvailability,
      },
      currentUser: result.user,
      voiceRestrictions: this.host.signaling.getVoiceRestrictions(result.user.id),
      roles: result.serverDetails.roles,
      userRoles: result.serverDetails.userRoles,
      ownerId: result.serverDetails.ownerId,
      myPermissions: result.serverDetails.myPermissions,
      iceServers,
    };

    // Auth and ICE setup await I/O. Refresh the live roster at the send boundary
    // so an intervening join/leave cannot be erased by an older auth snapshot.
    successPayload.server.members = Array.from(this.host.onlineUsers().values())
      .filter(({ user }) => !user.invisible || user.id === result.user!.id)
      .map(({ user }) => userForRecipient(session, user));
    // From here on this connection holds exactly the channels and categories of
    // the snapshot, whatever a reconciliation that ran while it was assembled
    // recorded for it: later deltas are computed against what it was sent.
    const snapshotChannelIds = new Set(result.serverDetails.channels.map((c) => c.id));
    successPayload.server.voiceStates = Object.fromEntries(
      Object.entries(this.host.signaling.getAllVoiceStates())
        .filter(([, state]) => snapshotChannelIds.has(state.channelId))
    );
    const snapshotCurrent = accessUnchanged();
    session.visibleChannelIds = snapshotChannelIds;
    session.categoriesKey = JSON.stringify(result.serverDetails.categories ?? []);
    this.host.send(session.ws, {
      type: MessageType.AUTH_SUCCESS,
      requestId,
      payload: successPayload,
    });
    this.host.botManagement.sendCommands(session);
    await this.host.botManagement.sendSettingsList(session);

    if (this.host.sessionsOfUser(result.user.id).some((other) => !!other.invisible !== !!session.invisible)) {
      this.host.presence.setVisibility(session, { appearOffline: session.invisible === true });
    }
    // The device that just connected carries the person's current choice, as
    // with visibility; one that does not know the status cannot clear it.
    if (session.protocol?.features.includes('user-brb') && this.host.sessionsOfUser(result.user.id)
      .some((other) => other !== session && !!other.user?.brb !== !!session.user?.brb)) {
      this.host.presence.applyBrb(session, session.user?.brb === true);
    }
    if (session.protocol?.features.includes('custom-status') && this.host.sessionsOfUser(result.user.id)
      .some((other) => other !== session && !sameCustomStatus(other.user?.customStatus, session.user?.customStatus))) {
      this.host.presence.applyCustomStatus(session, session.user?.customStatus ?? null);
    }

    // Broadcast USER_JOINED to all other clients — unless the user is invisible (#561).
    if (!session.invisible) {
      const userJoinedPayload: UserJoinedPayload = { user: result.user };
      this.host.broadcast({
        type: MessageType.USER_JOINED,
        payload: userJoinedPayload,
      }, session.ws);
    }

    // Signing in changes nobody's access unless it gave out a role. Republishing
    // roles, channels and community to every connection on each login made a
    // reconnection wave cost O(N²) (S-WS-4).
    if (result.rolesChanged) await this.host.roleAdmin.broadcastState(requestId);
    else if (!snapshotCurrent) await this.resyncLoginAccess(session);
    else if (session.voicePresenceKey !== this.host.visibility.presenceKey(result.user.id)) void this.host.visibility.syncVoicePresence();

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
      if (!userId || !this.host.isCurrentSession(session)) return;
      const unchanged = this.host.captureAccess();
      if (unchanged() || !waiting()) {
        const [state, channels, categories, context] = await Promise.all([
          this.host.roles.getRoleState(),
          this.host.channels.listChannels(),
          this.host.channels.listCategories(),
          this.host.channels.getAccessContext(userId),
        ]);
        if (!this.host.isCurrentSession(session)) return;
        if (unchanged() || !waiting()) {
          this.host.send(session.ws, {
            type: MessageType.ROLES_LIST,
            payload: {
              everyonePermissions: state.everyonePermissions,
              roles: rolesForModel(state.roles, state.everyonePermissions, roleModelFor(session.protocol?.features)),
              userRoles: state.userRoles,
            } satisfies RolesListPayload,
          });
          session.voicePresenceKey = this.host.visibility.presenceKey(userId);
          this.host.visibility.sendChannels(session, this.host.visibility.visibleChannelIds(channels, context), channels, categories, context, true);
          return;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOGIN_RESYNC_POLL_MS));
    }
  }

  /** `<bot> doctor`: what a bot's own connection would be told, on a connection that never signs in. */
  private async diagnoseBot(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    if (session.user) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Use uma conexão própria, sem autenticação, para o diagnóstico.', requestId);
      return;
    }
    if (!this.host.botDiagnostics) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Este servidor não aceita bots.', requestId);
      return;
    }
    const outcome = await this.host.botDiagnostics.diagnose(payload, session.ip);
    if (!this.host.isLive(session)) return;
    if (outcome.kind === 'invalid') {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Diagnóstico de bot inválido.', requestId);
    } else if (outcome.kind === 'rate_limited') {
      Logger.security(`Bot diagnostic rate limit reached for ${session.ip}`);
      this.host.sendError(session.ws, ProtocolErrorCode.AUTH_RATE_LIMITED, 'Muitas tentativas de conexão. Aguarde um minuto.', requestId);
    } else {
      this.host.send(session.ws, { type: MessageType.BOT_DIAGNOSTIC_RESULT, requestId, payload: outcome.result });
    }
  }

  /** A bot signs in with its token and the key it was bound to (TOFU), without a challenge (#569). */
  private async authenticateBot(session: ClientSession, payload: AuthConnectPayload, requestId?: string): Promise<void> {
    if (
      !this.host.botService || !payload?.botToken ||
      !authConnectSchema.shape.botToken.safeParse(payload.botToken).success ||
      !authConnectSchema.shape.publicKey.safeParse(payload.publicKey).success
    ) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de autenticação de bot inválidos.', requestId);
      return;
    }

    // Incompatible peers must never perform TOFU binding. An already-bound bot
    // can still identify its obsolete protocol for the owner's persistent warning.
    if (!session.protocol) {
      await this.host.botService.recordRejectedProtocol(payload.botToken, payload.publicKey, payload.protocolVersion);
      if (!this.host.isLive(session)) return;
      this.host.sendError(
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
      this.host.sendError(session.ws, ProtocolErrorCode.BOT_INVALID_PROFILE,
        'O bot precisa informar um nome válido na autenticação.', requestId);
      return;
    }

    // Probed before the bot is validated and anything is read for it, as for a
    // person: what changes while it runs, a revocation included, is then seen by
    // this login instead of reaching it ahead of AUTH_SUCCESS or being missed.
    const turnAvailability = await CoturnManager.availability();
    if (!this.host.isLive(session)) return;

    const publicKey = payload.publicKey;
    let botRecord = await this.host.botService.validateToken(payload.botToken, publicKey);
    if (!this.host.isLive(session)) return;
    if (!botRecord) {
      this.host.send(session.ws, {
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
      const result = await this.host.botService.updateProfile(botRecord.id, { name: nickname.data });
      if (!result.success) {
        this.host.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
        return;
      }
      botRecord = await this.host.botService.findById(botRecord.id);
      if (!botRecord) {
        this.host.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'O vínculo do bot foi revogado.', requestId);
        return;
      }
      if (!this.host.isLive(session)) return;
    }

    if (!await this.host.botService.recordCompatibleConnection(botRecord.id, payload.protocolVersion)) {
      this.host.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'O vínculo do bot foi revogado.', requestId);
      return;
    }
    if (!this.host.isLive(session)) return;

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
    this.host.settleAnonymous(session);
    session.sessionId = sessionId;
    session.isBot = true;
    session.botId = botRecord.id;
    session.botPublicKey = localBotIdentitySchema.shape.botPublicKey.parse(botRecord.boundPublicKey);
    session.botSettingsReady = false;

    // Replace existing bot session if any.
    const existingWs = this.host.findSocket(sessionId);
    if (existingWs && existingWs !== session.ws) {
      this.host.replaceConnection(existingWs);
      this.host.commandRegistry.clearBot(botRecord.id);
      this.host.botManagement.broadcastCommands();
    }
    this.host.bindSocket(sessionId, session.ws);

    // Headless clients need the same actual media mode, ICE and scoped roster as humans.
    const server = await this.host.serverRepo.getServer();
    const channels = server ? await this.host.channels.listChannels() : [];
    const access = await this.host.channels.getAccessContext(botRecord.id);
    const visibleChannels = channels.filter((channel) => canAccessChannel(channel, access.permissions, access.roleIds, access.isBot, access.userId));
    const visibleChannelIds = new Set(visibleChannels.map((channel) => channel.id));
    const voiceStates = Object.fromEntries(Object.entries(this.host.signaling.getAllVoiceStates())
      .filter(([, state]) => visibleChannelIds.has(state.channelId)));
    const iceServers = await this.buildIceServersFor(botRecord.id, session);
    const serverDetails = {
      protocol: session.protocol,
      maxMessageLength: server?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH,
      id: server?.id ?? '',
      name: server?.name ?? '',
      serverVersion: this.host.serverVersion,
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
      categories: (await this.host.channels.listCategories()).filter((category) =>
        canAccessChannel(category, access.permissions, access.roleIds, access.isBot, access.userId) || visibleChannels.some((channel) => channel.categoryId === category.id)),
      members: [botUser, ...Object.values(voiceStates).flatMap((state) => {
        const user = this.host.findSession(state.sessionId)?.user;
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

    if (session.replaced || !this.host.isLive(session)) return;
    this.host.send(session.ws, {
      type: MessageType.AUTH_SUCCESS,
      requestId,
      payload: {
        server: { ...serverDetails, turnAvailability },
        currentUser: botUser,
        voiceRestrictions: this.host.signaling.getVoiceRestrictions(botRecord.id),
        roles: [],
        userRoles: [],
        ownerId: serverDetails.ownerId,
        myPermissions: access.permissions,
        iceServers,
      } satisfies AuthSuccessPayload,
    });

    // Broadcast the bot joining.
    this.host.broadcast({ type: MessageType.USER_JOINED, payload: { user: botUser } satisfies UserJoinedPayload }, session.ws);
    await this.host.botManagement.broadcastSettings();
    Logger.info('BOT', `Bot "${botRecord.name}" (${botRecord.id}) connected.`);
  }

  /**
   * ICE servers for one client: STUN always, plus the relay when it is up (#425).
   *
   * The credentials are minted per connection and expire on their own, so a
   * leaked `AUTH_SUCCESS` cannot be replayed forever, and a member removed from
   * the server loses relay access once their current set lapses.
   */
  private async buildIceServersFor(userId: string, session: ClientSession) {
    try {
      const server = await this.host.serverRepo.getServer();
      // In SFU mode the server is already the relay, so handing out TURN
      // credentials would advertise a second one that nothing uses (#515).
      const secret = server?.voiceMode === 'sfu' ? null : server?.turnSecret ?? null;
      return this.host.coturn.buildIceServers(
        userId,
        session.requestHost ?? null,
        secret
      );
    } catch (error) {
      Logger.warn('NETWORK', 'Failed to build the ICE server list; sending STUN only.', error);
      return this.host.coturn.buildIceServers(userId, null, null);
    }
  }
}
