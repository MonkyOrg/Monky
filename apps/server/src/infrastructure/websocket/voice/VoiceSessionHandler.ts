import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  LIMITS,
  MessageType,
  Permission,
  ProtocolErrorCode,
  adminDeafenUserSchema,
  adminKickVoiceSchema,
  adminMoveUserSchema,
  adminMuteUserSchema,
  adminVoiceRestrictionsGetSchema,
  botVoiceChannelSchema,
  botVoiceJoinSchema,
  botVoiceStateUpdateSchema,
  hasPermission,
  isReceivingBotVoice,
  nativeScreenSourcesSchema,
  voiceAfkSchema,
  voiceJoinSchema,
  voiceReconnectSchema,
  voiceStateUpdateSchema,
  type AdminDeafenUserPayload,
  type AdminMoveUserPayload,
  type AdminMuteUserPayload,
  type BotCapability,
  type ServerMessage,
  type ServerAuditAction,
  type ServerAuditRef,
  type UserSummary,
  type VoiceJoinPayload,
  type VoiceLeavePayload,
  type VoiceMode,
  type VoiceModeTransition,
  type VoiceParticipantState,
  type VoiceReconnectPayload,
  type VoiceRestrictionsUpdatedPayload,
  type VoiceRosterParticipant,
  type VoiceStateChangedPayload,
  type VoiceStateUpdatePayload,
  type VoiceUserJoinedPayload,
  type VoiceUserLeftPayload,
} from '@monky/shared';
import type { BotService } from '../../../application/services/BotService';
import type { ChannelService } from '../../../application/services/ChannelService';
import type { GameShareRequestService } from '../../../application/services/GameShareRequestService';
import type { PermissionService } from '../../../application/services/PermissionService';
import { auditRef, type ServerAuditInput, type ServerAuditService } from '../../../application/services/ServerAuditService';
import type { SignalingService } from '../../../application/services/SignalingService';
import type { UserService } from '../../../application/services/UserService';
import type { IServerRepository } from '../../../domain/repositories';
import { Logger } from '../../logger/Logger';
import type { SfuManager } from '../../sfu/SfuManager';
import type { BotInteractionHandler } from '../BotInteractionHandler';
import type { ClientSession, SignedInSession } from '../ClientSession';
import { screenAccessChanged } from './ScreenAccessCoordinator';
import type { SfuSignalingHandler } from './SfuSignalingHandler';

/** How a connection leaves its voice room, for `endVoiceSession`. */
interface VoiceExit {
  /** Correlates the departure with the request that caused it. */
  requestId?: string;
  /** What the person removed acts on, such as a kick: it reaches them, and whoever asked, before the room hears. */
  notice?: ServerMessage;
  requester?: ClientSession;
}

/** A participant as the others in the room see them. */
export function voiceRosterUser(user: UserSummary, viewerUserId?: string): UserSummary {
  if (user.id === viewerUserId) return user;
  // Voice needs physical session IDs even when logical presence is offline.
  return { ...user, invisible: undefined, ...(user.invisible ? { status: 'DISCONNECTED' } : {}) };
}

/** What voice membership uses of the WebSocket server. */
export interface VoiceSessionHost {
  readonly signaling: SignalingService;
  readonly sfu: SfuManager;
  readonly sfuSignaling: Pick<SfuSignalingHandler, 'closeBotVoiceReception' | 'closePermissionMutedAudio' | 'closeSfuSession'
    | 'notifyProducersClosed' | 'sfuCallHealth' | 'syncSfuMicrophoneMute'>;
  readonly serverRepo: IServerRepository;
  readonly channels: ChannelService;
  readonly permissions: PermissionService;
  readonly users: UserService;
  readonly botService?: BotService;
  readonly botInteractions: BotInteractionHandler;
  readonly gameShareRequests: GameShareRequestService<ClientSession>;
  readonly audit?: ServerAuditService;
  /** Moves on every change of access: a bot's admission holds only under the one it was given in. */
  readonly botSettingsPermissionVersion: number;
  sessions(): Iterable<ClientSession>;
  sessionsOfUser(userId: string): ClientSession[];
  findSession(sessionId: string): ClientSession | undefined;
  isCurrentSession(session: ClientSession): boolean;
  isCurrentBotOperation(session: ClientSession, ...capabilities: BotCapability[]): boolean;
  requirePermission(session: ClientSession, permission: Permission, requestId?: string, channelId?: string): Promise<boolean>;
  requireChannelAccess(session: ClientSession, channelId: string | undefined, requestId?: string): Promise<boolean>;
  hasBotVoiceGrant(session: ClientSession, channelId: string): boolean;
  reconcileScreenAccess(): void;
  /** Lists the rooms each person is in, or returning to, and withdraws the ones they left. */
  syncVoicePresenceVisibility(): Promise<void>;
  recordAudit(session: ClientSession, action: ServerAuditAction, input?: Omit<ServerAuditInput, 'actor'>): void;
  auditChannel(channelId: string | null | undefined): Promise<ServerAuditRef | null>;
  auditIdentity(id: string): Promise<ServerAuditRef>;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void;
  broadcastToChannel(channelId: string, message: ServerMessage, ignoreWs?: WebSocket, canSend?: () => boolean): Promise<void>;
}

/**
 * Who is in which voice room (S-VOICE-12): joining, reconnecting after a
 * voice mode switch, state updates, the AFK room, moderation and every way
 * out. What a call carries belongs to SfuSignalingHandler, and who sees which
 * screen to ScreenAccessCoordinator.
 */
export class VoiceSessionHandler {
  /** How long a leave that crossed a move waits for the join of a client following it (`deferCrossedLeave`). */
  public static FOLLOW_MOVE_MS = 3000;

  private voiceReconnectGrants = new Map<ClientSession, {
    transitionId: string;
    channelId: string;
    expiresAt: number;
    inFlight: boolean;
  }>();

  /**
   * The room a dropped connection was in, kept through the reconnection grace
   * period: a member moved into a room they cannot see must still find it to
   * rejoin by themselves after a network blip.
   */
  private voiceReturnGrants = new Map<string, { userId: string; channelId: string; timer: NodeJS.Timeout }>();

  /**
   * The room each connection is being moved out of, by session. It stays
   * listed to its person until they are told they left it: withdrawn sooner,
   * the people still inside would leave a call their client is still in
   * (`roomWithdrawn`).
   */
  private movingOut = new Map<string, { userId: string; channelId: string }>();

  /**
   * Where the server last moved each person's connection, by session, until
   * it joins a room by itself or leaves voice. A leave naming the room it was
   * moved out of, while it sits in the other, is either its client following
   * the move or a hang-up that crossed it (`deferCrossedLeave`).
   */
  private moves = new Map<string, { from: string; to: string; leave?: NodeJS.Timeout }>();

  constructor(private readonly host: VoiceSessionHost) {}

  /** One voice request from a signed-in connection. */
  public async handle(session: ClientSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    switch (type) {
      case MessageType.VOICE_JOIN: {
        const join = session.isBot ? botVoiceJoinSchema.safeParse(payload) : voiceJoinSchema.safeParse(payload);
        if (!join.success) {
          this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST,
            session.isBot ? 'Invalid voice join.' : 'Pedido de entrada na chamada inválido.', requestId);
          return;
        }
        this.forgetMove(session.sessionId);
        this.voiceReconnectGrants.delete(session);
        await this.handleVoiceJoin(session, join.data, requestId);
        if (session.sessionId) this.clearVoiceReturn(session.sessionId);
        void this.host.syncVoicePresenceVisibility();
        break;
      }

      case MessageType.VOICE_RECONNECT: {
        const parsed = voiceReconnectSchema.safeParse(payload);
        if (!parsed.success) {
          this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de reconexão inválido.', requestId);
          return;
        }
        await this.handleVoiceReconnect(session, parsed.data, requestId);
        break;
      }

      case MessageType.VOICE_LEAVE:
        if (session.isBot && !botVoiceChannelSchema.safeParse(payload).success) {
          this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid voice leave.', requestId);
          return;
        }
        if (this.deferCrossedLeave(session, payload, requestId)) break;
        await this.leaveVoice(session, payload as VoiceLeavePayload, requestId);
        break;

      case MessageType.VOICE_STATE_UPDATE:
        await this.handleVoiceStateUpdate(session, payload, requestId);
        break;

      case MessageType.VOICE_AFK:
        await this.handleVoiceAfk(session, payload, requestId);
        break;

      case MessageType.ADMIN_MUTE_USER:
        if (!(await this.host.requirePermission(session, Permission.MUTE_MEMBERS, requestId))) return;
        await this.handleAdminMuteUser(session, payload as AdminMuteUserPayload, requestId);
        break;

      case MessageType.ADMIN_DEAFEN_USER:
        if (!(await this.host.requirePermission(session, Permission.DEAFEN_MEMBERS, requestId))) return;
        await this.handleAdminDeafenUser(session, payload as AdminDeafenUserPayload, requestId);
        break;

      case MessageType.ADMIN_GET_VOICE_RESTRICTIONS:
        await this.handleAdminGetVoiceRestrictions(session, payload, requestId);
        break;

      case MessageType.ADMIN_KICK_VOICE:
        if (!(await this.host.requirePermission(session, Permission.KICK_MEMBERS, requestId))) return;
        await this.handleAdminKickVoice(session, payload, requestId);
        break;

      case MessageType.ADMIN_MOVE_USER: {
        const move = adminMoveUserSchema.safeParse(payload);
        if (!move.success) {
          this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido para mover da chamada inválido.', requestId);
          return;
        }
        await this.handleAdminMoveUser(session, move.data, requestId);
        break;
      }
    }
  }

  /** A connection that logged out or went away can no longer use the reconnection it was given. */
  public dropReconnectGrant(session: ClientSession): void {
    this.voiceReconnectGrants.delete(session);
  }

  /**
   * The voice mode changed. Bots leave their calls. A switch to P2P also
   * empties every room, the whole SFU with them, and lets each connection that
   * was inside rejoin its room once, through the transition returned.
   */
  public voiceModeChanged(voiceMode: VoiceMode): VoiceModeTransition | undefined {
    this.voiceReconnectGrants.clear();
    void this.host.syncVoicePresenceVisibility();
    for (const session of this.host.sessions()) {
      if (!session.isBot) continue;
      session.botVoiceJoinAttempt = undefined;
      session.botVoiceGrant = undefined;
      const state = session.sessionId && this.host.signaling.getVoiceState(session.sessionId);
      if (state) this.evictFromVoiceChannel(state.sessionId, state.channelId);
    }
    if (voiceMode !== 'p2p') return undefined;
    const voiceTransition: VoiceModeTransition = { id: randomUUID(), from: 'sfu', to: 'p2p' };
    // Keep the deliberate full SFU teardown. Admission is granted once to
    // each exact connection, never to a user ID shared by several devices.
    this.host.sfu.close();
    const evictedStates = this.host.signaling.clearAllVoiceStates();
    const grantMs = 30000;
    for (const vs of evictedStates) {
      const participant = this.host.findSession(vs.sessionId);
      if (participant) {
        this.voiceReconnectGrants.set(participant, {
          transitionId: voiceTransition.id,
          channelId: vs.channelId,
          expiresAt: Date.now() + grantMs,
          inFlight: false,
        });
      }
      this.announceVoiceDeparture(vs, { reconnect: voiceTransition });
    }
    // Unused grants lapse silently; withdraw rooms only they kept listed.
    if (evictedStates.length > 0) setTimeout(() => void this.host.syncVoicePresenceVisibility(), grantMs + 50).unref();
    return voiceTransition;
  }

  /** The server is shutting down: no grant outlives it. */
  public close(): void {
    this.voiceReconnectGrants.clear();
    for (const grant of this.voiceReturnGrants.values()) clearTimeout(grant.timer);
    this.voiceReturnGrants.clear();
    for (const move of this.moves.values()) clearTimeout(move.leave);
    this.moves.clear();
  }

  private async handleVoiceJoin(
    session: ClientSession,
    payload: VoiceJoinPayload & { invocationId?: string },
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    const attempt = {};
    if (session.isBot) session.botVoiceJoinAttempt = attempt;
    const accessVersion = this.host.botSettingsPermissionVersion;
    // A person's access to the room is checked once, below, as for a bot not invoked into it (S-WS-5).
    if (session.isBot && !(await this.host.requirePermission(session, Permission.SPEAK, requestId,
      payload.invocationId !== undefined ? undefined : payload.channelId))) return;
    let authorization: Awaited<ReturnType<BotInteractionHandler['authorizeVoiceJoin']>>;
    if (session.isBot && payload.invocationId !== undefined) {
      authorization = await this.host.botInteractions.authorizeVoiceJoin(session, payload.invocationId, payload.channelId);
      if (!authorization) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'The invocation no longer authorizes entry into this voice room.', requestId);
        return;
      }
    } else if (!(await this.host.requireChannelAccess(session, payload.channelId, requestId))) return;
    const isSfu = (await this.host.serverRepo.getServer())?.voiceMode === 'sfu';
    const isCurrent = () => this.host.isCurrentSession(session) && (!session.isBot ||
      (session.botVoiceJoinAttempt === attempt && accessVersion === this.host.botSettingsPermissionVersion &&
        (!authorization || authorization.isCurrent())));
    if (!isCurrent()) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Voice admission changed; retry with the current caller context.', requestId);
      return;
    }
    const previous = this.host.signaling.getVoiceState(session.sessionId);
    if (session.isBot && previous && previous.channelId !== payload.channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Leave the current voice channel before joining another.', requestId);
      return;
    }
    const afkChannelId = await this.host.channels.getAfkChannelId();
    if (payload.channelId === afkChannelId && !this.mayEnterAfkChannel(session, afkChannelId)) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED,
        'O canal AFK só recebe quem fica inativo em uma chamada.', requestId);
      return;
    }
    // Leaving the AFK room trades its server mute for an ordinary one, which only the member undoes.
    const leavingAfk = !!afkChannelId && previous?.channelId === afkChannelId && payload.channelId !== afkChannelId;

    const result = await this.host.signaling.joinVoiceChannel(
      session.sessionId,
      session.user.id,
      payload.channelId,
      leavingAfk ? true : payload.isMuted,
      payload.isDeafened,
      await this.resolvePermissionMuted(session, payload.channelId),
      { bypassUserLimit: () => this.mayExceedVoiceUserLimit(session, payload.channelId) },
    );
    if (!result.success || !result.voiceState) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.CHANNEL_NOT_FOUND,
        result.errorMessage || 'Erro ao entrar no canal de voz',
        requestId
      );
      return;
    }
    const departed = result.previousVoiceState;
    if (departed && departed.channelId !== payload.channelId) {
      // The old room may not see the destination. Retire its peers explicitly,
      // before announcing arrival, rather than relying on a visible JOIN.
      this.announceVoiceDeparture(departed);
    }
    if (!isCurrent()) {
      if (this.host.signaling.getVoiceState(session.sessionId) === result.voiceState) {
        this.evictFromVoiceChannel(session.sessionId, payload.channelId);
      }
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Voice admission changed; retry with the current caller context.', requestId);
      return;
    }
    result.voiceState = await this.applyPermissionMuted(session.sessionId, await this.resolvePermissionMuted(session, payload.channelId)) ?? result.voiceState;
    if (session.isBot) {
      // The command authorizes admission only. Playback can outlive it; the
      // channel-scoped grant is subsequently checked against the creator's ACLs.
      session.botVoiceGrant = authorization ? {
        channelId: payload.channelId, creatorUserId: authorization.creatorUserId,
        originChannelId: authorization.originChannelId, accessVersion,
      } : undefined;
      const permissions = session.botId ? this.host.botService?.permissions?.get(session.botId) : undefined;
      result.voiceState = this.host.signaling.updateVoiceState(session.sessionId, {
        receivesVoice: payload.receiveAudio === true,
        botVoicePermissions: {
          publish: this.host.isCurrentBotOperation(session, 'publish_voice'),
          receive: this.host.isCurrentBotOperation(session, 'receive_voice'),
          publishRequested: permissions?.requested?.includes('publish_voice') === true,
          receiveRequested: permissions?.requested?.includes('receive_voice') === true,
        },
      }) ?? result.voiceState;
    }
    if (isSfu) {
      result.voiceState = this.host.signaling.updateVoiceState(session.sessionId, {
        connectionHealth: this.host.sfuSignaling.sfuCallHealth(session.sessionId, payload.channelId),
      }) ?? result.voiceState;
    }

    const joinPayload: VoiceUserJoinedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
      sessionId: session.sessionId,
      voiceState: result.voiceState,
      user: voiceRosterUser(session.user),
    };

    // Whatever this session had in another channel is over: switching channels
    // on the same server sends no VOICE_LEAVE, and the client's own teardown is
    // local, so nothing else would ever close those transports — they would sit
    // on their port pairs until the socket dropped.
    if (this.host.sfu) {
      const { closedProducerIds } = this.host.sfu.closeSessionExcept(
        session.sessionId,
        payload.channelId
      );
      for (const { channelId, producerId } of closedProducerIds) this.host.sfuSignaling.notifyProducersClosed(channelId, [producerId]);
    }

    // Scoped to the channel's audience so a private room's activity does not
    // reach members who cannot see it (#384).
    await this.host.broadcastToChannel(payload.channelId, {
      type: MessageType.VOICE_USER_JOINED,
      payload: joinPayload,
    });
    // Capture and send without an await: membership can change while a scoped
    // broadcast resolves permissions. The joining client needs today's roster,
    // not the auth snapshot from before its connection finished.
    const currentVoiceState = this.host.signaling.getVoiceState(session.sessionId);
    if (currentVoiceState?.channelId === payload.channelId) {
      this.host.send(session.ws, {
        type: MessageType.VOICE_USER_JOINED,
        requestId,
        payload: {
          ...joinPayload,
          user: session.user,
          voiceState: currentVoiceState,
          participants: this.getVoiceRoster(payload.channelId, session.user.id),
        } satisfies VoiceUserJoinedPayload,
      });
    } else {
      this.host.sendError(
        session.ws,
        ProtocolErrorCode.BAD_REQUEST,
        'A entrada no canal de voz foi interrompida',
        requestId
      );
    }
  }

  private cancelVoiceReconnect(sessionId: string): boolean {
    let cancelled = false;
    for (const session of this.voiceReconnectGrants?.keys() ?? []) {
      if (session.sessionId === sessionId) {
        this.voiceReconnectGrants.delete(session);
        cancelled = true;
      }
    }
    if (cancelled) void this.host.syncVoicePresenceVisibility();
    return cancelled;
  }

  private async handleVoiceReconnect(
    session: ClientSession,
    payload: VoiceReconnectPayload,
    requestId?: string
  ): Promise<void> {
    const grant = this.voiceReconnectGrants.get(session);
    const isCurrent = () => !!grant
      && this.voiceReconnectGrants.get(session) === grant
      && grant.expiresAt > Date.now()
      && this.host.isCurrentSession(session);
    if (!session.user || !session.sessionId || !isCurrent() || !grant
      || grant.inFlight || grant.transitionId !== payload.transitionId || grant.channelId !== payload.channelId
      || this.host.signaling.getVoiceState(session.sessionId)) {
      this.host.sendError(session.ws, ProtocolErrorCode.VOICE_RECONNECT_EXPIRED, 'Esta reconexão não é mais válida.', requestId);
      return;
    }
    grant.inFlight = true;
    let admitted = false;
    try {
      if (!(await this.host.requireChannelAccess(session, payload.channelId, requestId))) return;
      if (!isCurrent() || (await this.host.serverRepo.getServer())?.voiceMode !== 'p2p') {
        this.host.sendError(session.ws, ProtocolErrorCode.VOICE_RECONNECT_EXPIRED, 'O modo de voz mudou novamente.', requestId);
        return;
      }
      const permissionMuted = await this.resolvePermissionMuted(session, payload.channelId);
      // The grant proves this connection was inside the room before the mode switch emptied it.
      const result = await this.host.signaling.joinVoiceChannel(
        session.sessionId, session.user.id, payload.channelId, payload.isMuted, payload.isDeafened, permissionMuted,
        { bypassUserLimit: true },
      );
      admitted = !!result.voiceState;
      if (!result.success || !result.voiceState) {
        this.host.sendError(session.ws, result.errorCode ?? ProtocolErrorCode.CHANNEL_NOT_FOUND,
          result.errorMessage ?? 'Não foi possível reconectar ao canal.', requestId);
        return;
      }
      if (!isCurrent()) return;
      if (!(await this.host.requireChannelAccess(session, payload.channelId, requestId))) return;
      if (!isCurrent()) return;
      result.voiceState = await this.applyPermissionMuted(session.sessionId, await this.resolvePermissionMuted(session, payload.channelId)) ?? result.voiceState;
      const joined: VoiceUserJoinedPayload = {
        channelId: payload.channelId,
        sessionId: session.sessionId,
        userId: session.user.id,
        voiceState: result.voiceState,
        user: voiceRosterUser(session.user),
      };
      await this.host.broadcastToChannel(payload.channelId, {
        type: MessageType.VOICE_USER_JOINED,
        payload: joined,
      });
      if (!isCurrent()
        || !(await this.host.requireChannelAccess(session, payload.channelId, requestId))) return;
      await this.applyPermissionMuted(session.sessionId, await this.resolvePermissionMuted(session, payload.channelId));
      const state = this.host.signaling.getVoiceState(session.sessionId);
      if (!isCurrent() || state?.channelId !== payload.channelId) return;
      this.host.send(session.ws, {
        type: MessageType.VOICE_RECONNECTED,
        requestId,
        payload: {
          ...joined, user: session.user, voiceState: state,
          participants: this.getVoiceRoster(payload.channelId, session.user.id),
        } satisfies VoiceUserJoinedPayload,
      });
      admitted = false;
    } finally {
      if (this.voiceReconnectGrants.get(session) === grant) this.voiceReconnectGrants.delete(session);
      if (admitted && this.host.signaling.getVoiceState(session.sessionId)?.channelId === payload.channelId) {
        await this.handleVoiceLeave(session, { channelId: payload.channelId });
      }
      void this.host.syncVoicePresenceVisibility();
    }
  }

  public getVoiceRoster(channelId: string, viewerUserId?: string): VoiceRosterParticipant[] {
    return this.host.signaling.getParticipantsInChannel(channelId).flatMap((voiceState) => {
      const user = this.host.findSession(voiceState.sessionId)?.user;
      return user ? [{ user: voiceRosterUser(user, viewerUserId), voiceState }] : [];
    });
  }

  /** A connection's own leave: nothing that would have brought it back to a room is kept either. */
  private async leaveVoice(session: ClientSession, payload: VoiceLeavePayload, requestId?: string): Promise<void> {
    this.voiceReconnectGrants.delete(session);
    if (session.sessionId) this.clearVoiceReturn(session.sessionId);
    await this.handleVoiceLeave(session, payload, requestId);
    void this.host.syncVoicePresenceVisibility();
  }

  /**
   * A person's leave naming the room the server moved their connection out
   * of, while it sits in the room it was moved into. Light follows a move by
   * leaving the room it was in and joining the new one right after; a hang-up
   * that crossed the move on its way names the old room too, and has to end
   * the call all the same. So this leave waits for that join: right behind it
   * from a client following the move, the join cancels it, and otherwise it
   * takes effect. Any other leave ends the call at once, wherever it is.
   */
  private deferCrossedLeave(session: ClientSession, payload: unknown, requestId?: string): boolean {
    const sessionId = session.sessionId;
    const move = sessionId ? this.moves.get(sessionId) : undefined;
    if (!sessionId || !move || typeof payload !== 'object' || payload === null || !('channelId' in payload)
      || payload.channelId !== move.from || this.host.signaling.getVoiceState(sessionId)?.channelId !== move.to) return false;
    clearTimeout(move.leave);
    move.leave = setTimeout(() => {
      if (this.moves.get(sessionId) !== move) return;
      this.moves.delete(sessionId);
      if (!this.host.isCurrentSession(session) || this.host.signaling.getVoiceState(sessionId)?.channelId !== move.to) return;
      this.leaveVoice(session, { channelId: move.from }, requestId)
        .catch((error: unknown) => Logger.error('WEBRTC', 'Failed to end a call whose leave crossed a move.', error));
    }, VoiceSessionHandler.FOLLOW_MOVE_MS);
    move.leave.unref();
    return true;
  }

  /** The connection is out of voice, or joined a room by itself: no move of the server's is left to follow. */
  private forgetMove(sessionId: string | undefined): void {
    if (!sessionId) return;
    clearTimeout(this.moves.get(sessionId)?.leave);
    this.moves.delete(sessionId);
  }

  private async handleVoiceLeave(
    session: ClientSession,
    payload: VoiceLeavePayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    session.botVoiceJoinAttempt = undefined;
    session.botVoiceGrant = undefined;

    // Hanging up keeps the socket open, so nothing else would ever reap what
    // this session held in the SFU: the client's own teardown is local, and
    // the producers would stay listed for the next person to join, who would
    // then be told to consume a microphone that left.
    const previous = this.endVoiceSession(session.sessionId, { requestId });
    // A correlated acknowledgement is required even after an administrative
    // removal or a failed admission. It makes headless teardown idempotent.
    // A departure already answered it: the person who left always hears of it.
    if (session.isBot && requestId && !previous) {
      this.host.send(session.ws, {
        type: MessageType.VOICE_USER_LEFT, requestId,
        payload: {
          channelId: payload.channelId, userId: session.user.id, sessionId: session.sessionId,
        } satisfies VoiceUserLeftPayload,
      });
    }
  }

  private async handleVoiceStateUpdate(
    session: ClientSession,
    value: unknown,
    requestId?: string
  ): Promise<void> {
    const sessionId = session.sessionId;
    if (!session.user || !sessionId) return;

    const current = this.host.signaling.getVoiceState(sessionId);
    if (session.isBot && (!current || !botVoiceStateUpdateSchema.safeParse(value).success ||
        (!this.host.isCurrentBotOperation(session, 'publish_voice') && !this.host.isCurrentBotOperation(session, 'receive_voice')))) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bot voice state update is not permitted.', requestId);
      return;
    }
    // The state is replayed to the whole room and to every login that sees it:
    // only known fields of the right type may land there.
    const parsed = voiceStateUpdateSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Atualização do estado de voz inválida.', requestId);
      return;
    }
    const { nativeScreenShares, ...fields } = parsed.data;
    const effectivePayload: VoiceStateUpdatePayload = { ...fields };
    if (nativeScreenShares !== undefined) {
      const sources = nativeScreenSourcesSchema.safeParse(nativeScreenShares);
      const shareIds = fields.isScreenSharing === false ? [] : (fields.screenShareIds ?? current?.screenShareIds ?? []);
      if (!sources.success || sources.data.some(source => !shareIds.includes(source.shareId))
        || (session.isBot && sources.data.length > 0)) {
        this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Descritores de transmissão inválidos.', requestId);
        return;
      }
      effectivePayload.nativeScreenShares = sources.data;
    }
    if (current?.serverMuted || current?.permissionMuted || (session.isBot && !this.host.isCurrentBotOperation(session, 'publish_voice'))) {
      effectivePayload.isSpeaking = false;
      if (current?.permissionMuted) effectivePayload.isSharingScreenAudio = false;
    }
    if (current?.permissionMuted && effectivePayload.nativeScreenShares) {
      effectivePayload.nativeScreenShares = effectivePayload.nativeScreenShares.map(source => ({ ...source, audio: false }));
    }

    // Health is server-observed; renderer payloads cannot overwrite it.
    const updated = this.host.signaling.updateVoiceState(sessionId, {
      ...effectivePayload,
      connectionHealth: current?.connectionHealth,
      receivesVoice: current?.receivesVoice,
      botVoicePermissions: current?.botVoicePermissions,
    });
    if (updated) {
      // Only screens decide who may receive what: a mute or a speaking flag,
      // which bots publish at every pause, leaves every grant as it was (S-VOICE-10).
      if (screenAccessChanged(current, updated)) this.host.reconcileScreenAccess();
      if (updated.isScreenSharing && !current?.isScreenSharing) this.host.gameShareRequests.playerStartedSharing(session.user.id);
      if (session.isBot && !isReceivingBotVoice(updated)) {
        this.host.sfuSignaling.closeBotVoiceReception(session, updated.channelId);
      }
      if (!current || current.isMuted !== updated.isMuted || current.isDeafened !== updated.isDeafened ||
          current.serverMuted !== updated.serverMuted || current.serverDeafened !== updated.serverDeafened ||
          current.permissionMuted !== updated.permissionMuted) {
        await this.host.sfuSignaling.syncSfuMicrophoneMute(sessionId);
      }
      const changedPayload: VoiceStateChangedPayload = { voiceState: updated };
      await this.host.broadcastToChannel(updated.channelId, {
        type: MessageType.VOICE_STATE_CHANGED,
        requestId: session.isBot ? undefined : requestId,
        payload: changedPayload,
      }, undefined, () => this.host.signaling.getVoiceState(sessionId) === updated);
      if (session.isBot && requestId && this.host.isCurrentSession(session)) {
        const acknowledged = this.host.signaling.getVoiceState(sessionId);
        if (acknowledged?.channelId === updated.channelId) {
          this.host.send(session.ws, {
            type: MessageType.VOICE_STATE_CHANGED, requestId,
            payload: { voiceState: acknowledged } satisfies VoiceStateChangedPayload,
          });
        } else this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bot left voice before the update completed.', requestId);
      }
    }
  }

  /** A client reports it went idle: it is moved to the AFK room, where the server mutes it (`afk-channel`). */
  private async handleVoiceAfk(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    if (!session.user || !session.sessionId || session.isBot) return;
    const parsed = voiceAfkSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de canal AFK inválido.', requestId);
      return;
    }
    const afkChannelId = await this.host.channels.getAfkChannelId();
    const previous = this.host.signaling.getVoiceState(session.sessionId);
    // A late report must not move someone who changed rooms meanwhile, and a
    // server without an AFK room, or a member already in it, has nothing to do.
    if (!afkChannelId || !previous || previous.channelId !== parsed.data.channelId
      || previous.channelId === afkChannelId || !this.host.isCurrentSession(session)) return;
    const moved = await this.moveVoiceSession(session, previous, afkChannelId, undefined, session, requestId);
    if (!moved.success) {
      this.host.sendError(session.ws, moved.errorCode ?? ProtocolErrorCode.BAD_REQUEST,
        moved.errorMessage ?? 'Não foi possível ir para o canal AFK.', requestId);
    }
  }

  private async resolvePermissionMuted(session: ClientSession, channelId: string): Promise<boolean> {
    if (!session.user || session.isBot) return false;
    // Whoever is in the AFK room is muted by the server, administrators included.
    if (channelId === await this.host.channels.getAfkChannelId()) return true;
    return !(await this.host.channels.canUserAccessChannel(session.user.id, channelId, Permission.SPEAK));
  }

  /**
   * Nobody joins the AFK room on purpose: a connection gets there only when the
   * server moves it in, and may then announce itself again while inside or when
   * returning to it after a dropped socket.
   */
  private mayEnterAfkChannel(session: ClientSession, afkChannelId: string): boolean {
    if (session.isBot || !session.sessionId) return false;
    return this.host.signaling.getVoiceState(session.sessionId)?.channelId === afkChannelId
      || this.voiceReturnGrants.get(session.sessionId)?.channelId === afkChannelId;
  }

  /**
   * A full voice room still admits members with Move Members (administrators
   * included) and anyone returning to the room their dropped socket was in.
   */
  private async mayExceedVoiceUserLimit(session: ClientSession, channelId: string): Promise<boolean> {
    if (!session.user || !session.sessionId) return false;
    if (this.voiceReturnGrants.get(session.sessionId)?.channelId === channelId) return true;
    return session.isBot
      ? hasPermission((await this.host.channels.getAccessContext(session.user.id)).permissions, Permission.MOVE_MEMBERS)
      : this.host.permissions.checkPermission(session.user.id, Permission.MOVE_MEMBERS);
  }

  public async applyPermissionMuted(sessionId: string, muted: boolean): Promise<VoiceParticipantState | null> {
    const current = this.host.signaling.getVoiceState(sessionId);
    if (!current) return null;
    let updated = this.host.signaling.setPermissionMuted(sessionId, muted);
    if (muted && updated?.isSharingScreenAudio) {
      updated = this.host.signaling.updateVoiceState(sessionId, {
        isSharingScreenAudio: false,
        nativeScreenShares: updated.nativeScreenShares?.map(source => ({ ...source, audio: false })),
      }) ?? updated;
    }
    if (updated && muted) this.host.sfuSignaling.closePermissionMutedAudio(updated);
    await this.host.sfuSignaling.syncSfuMicrophoneMute(sessionId);
    return updated;
  }

  private async handleAdminMuteUser(session: ClientSession, payload: AdminMuteUserPayload, requestId?: string): Promise<void> {
    const parsed = adminMuteUserSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de moderação inválidos.', requestId);
      return;
    }
    await this.applyVoiceRestriction(session, parsed.data.targetUserId, 'serverMuted', parsed.data.muted, requestId);
  }

  private async handleAdminDeafenUser(session: ClientSession, payload: AdminDeafenUserPayload, requestId?: string): Promise<void> {
    const parsed = adminDeafenUserSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de moderação inválidos.', requestId);
      return;
    }
    await this.applyVoiceRestriction(session, parsed.data.targetUserId, 'serverDeafened', parsed.data.deafened, requestId);
  }

  private async handleAdminGetVoiceRestrictions(session: ClientSession, payload: unknown, requestId?: string): Promise<void> {
    if (!session.user) return;
    const permissions = await this.host.permissions.getUserPermissions(session.user.id);
    if (!hasPermission(permissions, Permission.MUTE_MEMBERS) && !hasPermission(permissions, Permission.DEAFEN_MEMBERS)) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Você não tem permissão para executar esta ação.', requestId);
      return;
    }
    const parsed = adminVoiceRestrictionsGetSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de moderação inválidos.', requestId);
      return;
    }
    if (!(await this.isVoiceIdentity(parsed.data.targetUserId))) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Membro não encontrado.', requestId);
      return;
    }
    if (!this.host.isCurrentSession(session)) return;
    this.host.send(session.ws, {
      type: MessageType.VOICE_RESTRICTIONS_UPDATED,
      requestId,
      payload: { userId: parsed.data.targetUserId, ...this.host.signaling.getVoiceRestrictions(parsed.data.targetUserId) } satisfies VoiceRestrictionsUpdatedPayload,
    });
  }

  private async applyVoiceRestriction(
    session: ClientSession,
    userId: string,
    restriction: 'serverMuted' | 'serverDeafened',
    value: boolean,
    requestId?: string,
  ): Promise<void> {
    if (!(await this.isVoiceIdentity(userId))) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Membro não encontrado.', requestId);
      return;
    }
    const permission = restriction === 'serverMuted' ? Permission.MUTE_MEMBERS : Permission.DEAFEN_MEMBERS;
    if (!(await this.host.requirePermission(session, permission, requestId))) return;
    if (!this.host.isCurrentSession(session)) return;
    const previous = this.host.signaling.getVoiceRestrictions(userId)[restriction];
    const states = restriction === 'serverMuted'
      ? this.host.signaling.setServerMuted(userId, value)
      : this.host.signaling.setServerDeafened(userId, value);
    const updated: VoiceRestrictionsUpdatedPayload = { userId, ...this.host.signaling.getVoiceRestrictions(userId) };
    const channelId = states[0]?.channelId;
    for (const state of states) {
      const target = this.host.findSession(state.sessionId);
      if (target?.isBot && !isReceivingBotVoice(state)) this.host.sfuSignaling.closeBotVoiceReception(target, state.channelId);
    }
    const muteApplied = Promise.all(states.map((state) => this.host.sfuSignaling.syncSfuMicrophoneMute(state.sessionId)));
    this.notifyVoiceRestrictions(updated);
    await muteApplied;
    await Promise.all(states.map((voiceState) => this.host.broadcastToChannel(voiceState.channelId, {
      type: MessageType.VOICE_STATE_CHANGED,
      payload: { voiceState } satisfies VoiceStateChangedPayload,
    }, undefined, () => this.host.signaling.getVoiceState(voiceState.sessionId) === voiceState)));
    this.host.send(session.ws, { type: MessageType.VOICE_RESTRICTIONS_UPDATED, requestId, payload: updated });
    if (this.host.audit && previous !== value) {
      this.host.recordAudit(session, restriction === 'serverMuted'
        ? value ? 'voice.mute' : 'voice.unmute'
        : value ? 'voice.deafen' : 'voice.undeafen', {
        target: await this.host.auditIdentity(userId),
        related: { channel: await this.host.auditChannel(channelId) },
      });
    }
  }

  private async isVoiceIdentity(userId: string): Promise<boolean> {
    return await this.host.users.isMember(userId) || !!(await this.host.botService?.findById(userId));
  }

  private notifyVoiceRestrictions({ userId, serverMuted, serverDeafened }: VoiceRestrictionsUpdatedPayload): void {
    for (const session of this.host.sessionsOfUser(userId)) {
      this.host.send(session.ws, {
        type: MessageType.VOICE_RESTRICTIONS_UPDATED,
        payload: { userId, serverMuted, serverDeafened } satisfies VoiceRestrictionsUpdatedPayload,
      });
    }
  }

  private async handleAdminKickVoice(session: ClientSession, value: unknown, requestId?: string): Promise<void> {
    const kick = adminKickVoiceSchema.safeParse(value);
    if (!kick.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de desconexão da chamada inválido.', requestId);
      return;
    }
    const { targetSessionId } = kick.data;
    const notice: ServerMessage<MessageType.ADMIN_KICK_VOICE> = {
      type: MessageType.ADMIN_KICK_VOICE, requestId, payload: { targetSessionId },
    };
    this.clearVoiceReturn(targetSessionId);
    // Someone waiting to reconnect after a voice mode switch is already out of
    // the room: the kick takes away the way back in.
    const reconnecting = [...this.voiceReconnectGrants.entries()]
      .find(([grantSession]) => grantSession.sessionId === targetSessionId);
    if (this.cancelVoiceReconnect(targetSessionId) && !this.host.signaling.getVoiceState(targetSessionId)) {
      this.sendVoiceNotice(targetSessionId, notice, session);
      const [kicked, grant] = reconnecting ?? [];
      if (this.host.audit && kicked?.user) {
        this.host.recordAudit(session, 'voice.disconnect', {
          target: auditRef.member(kicked.user), related: { from: await this.host.auditChannel(grant?.channelId) },
        });
      }
      return;
    }

    // Being kicked out of the call is a departure like any other, but the
    // client only tears itself down locally — it never sends VOICE_LEAVE — so
    // the SFU has to be reaped from here (#527).
    const previous = this.endVoiceSession(targetSessionId, { requestId, notice, requester: session });
    if (!previous) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário não está em um canal de voz.', requestId);
      return;
    }
    if (this.host.audit) {
      this.host.recordAudit(session, 'voice.disconnect', {
        target: await this.host.auditIdentity(previous.userId), related: { from: await this.host.auditChannel(previous.channelId) },
      });
    }
  }

  private async handleAdminMoveUser(session: ClientSession, payload: AdminMoveUserPayload, requestId?: string): Promise<void> {
    const previous = this.host.signaling.getVoiceState(payload.targetSessionId);
    const target = this.host.findSession(payload.targetSessionId);
    if (!previous || !target?.user) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário não está em um canal de voz.', requestId);
      return;
    }
    if (previous.channelId === payload.channelId) {
      return;
    }
    if (!(await this.host.requirePermission(session, Permission.MOVE_MEMBERS, requestId))) return;
    // Whoever moves must be able to reach the room themselves. The member being
    // moved does not need to see it: VIEW_CHANNEL only gates seeing a room and
    // joining it by oneself, so being brought in by someone allowed is fine.
    if (!(await this.host.requireChannelAccess(session, payload.channelId, requestId))) return;
    const afkChannelId = await this.host.channels.getAfkChannelId();
    if (payload.channelId === afkChannelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED,
        'Ninguém é levado ao canal AFK: ele só recebe quem fica inativo em uma chamada.', requestId);
      return;
    }

    // Bots never enter private rooms through someone else, and still need voice
    // publish permission. Humans without SPEAK enter permission-muted.
    if (target.isBot && !(await this.host.channels.canUserAccessChannel(previous.userId, payload.channelId, Permission.SPEAK))) {
      this.host.sendError(
        session.ws,
        ProtocolErrorCode.PERMISSION_DENIED,
        'O usuário não tem acesso a esse canal.',
        requestId
      );
      return;
    }

    // Leaving the AFK room trades its server mute for an ordinary one, which only the member undoes.
    const moved = await this.moveVoiceSession(target, previous, payload.channelId,
      previous.channelId === afkChannelId ? true : undefined, session, requestId);
    if (!moved.success) {
      this.host.sendError(session.ws, moved.errorCode || ProtocolErrorCode.BAD_REQUEST, moved.errorMessage || 'Não foi possível mover o usuário.', requestId);
      return;
    }
    if (this.host.audit) {
      this.host.recordAudit(session, 'voice.move', {
        target: auditRef.member({ ...target.user, isBot: target.isBot === true || target.user.isBot === true }),
        related: { from: await this.host.auditChannel(previous.channelId), to: await this.host.auditChannel(payload.channelId) },
      });
    }
  }

  /**
   * Moves one connection to another voice room on the server's authority,
   * whatever the room's user limit. The moved client follows ADMIN_MOVE_USER,
   * the old room sees it leave and the new one sees it arrive. The membership
   * moves at once, so this is the voice exit without its leave: the steps
   * after it are the ones `endVoiceSession` takes. The old room stays in the
   * member's list until they are told they left it (`movingOut`).
   */
  private async moveVoiceSession(
    target: ClientSession,
    previous: VoiceParticipantState,
    channelId: string,
    selfMuted: boolean | undefined,
    requester: ClientSession,
    requestId?: string,
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string }> {
    if (!target.user) return { success: false };
    // Set before the membership moves, which already starts a presence pass.
    const leaving = { userId: previous.userId, channelId: previous.channelId };
    this.movingOut.set(previous.sessionId, leaving);
    let voiceState: VoiceParticipantState;
    try {
      const joinResult = await this.host.signaling.joinVoiceChannel(
        previous.sessionId, previous.userId, channelId, selfMuted, undefined, false, { bypassUserLimit: true });
      if (!joinResult.success || !joinResult.voiceState) {
        return { success: false, errorCode: joinResult.errorCode, errorMessage: joinResult.errorMessage };
      }
      // A person's client follows the move once told; until then, a leave of
      // theirs naming the old room may be either (`deferCrossedLeave`). A bot
      // stops instead, and its leave ends the call as any other.
      if (!target.isBot) {
        const pending = this.moves.get(previous.sessionId);
        // A hang-up already waiting outlives a later move: the same record
        // takes the new rooms, so it still ends the call wherever it is.
        if (pending?.leave) Object.assign(pending, { from: previous.channelId, to: channelId });
        else this.moves.set(previous.sessionId, { from: previous.channelId, to: channelId });
      }
      // Resolved once inside: being in a room is what lets someone moved in see it.
      voiceState = await this.applyPermissionMuted(previous.sessionId, await this.resolvePermissionMuted(target, channelId))
        ?? joinResult.voiceState;

      this.host.sfuSignaling.closeSfuSession(previous.sessionId, previous.channelId);
      // The destination has to be in the member's list before they are told to
      // follow the move, or their client would have no room to join.
      await this.host.syncVoicePresenceVisibility();
      this.sendVoiceNotice(previous.sessionId, {
        type: MessageType.ADMIN_MOVE_USER,
        requestId,
        payload: { targetSessionId: previous.sessionId, channelId } satisfies AdminMoveUserPayload,
      }, requester);
      this.announceVoiceDeparture(previous, { requestId });
    } finally {
      if (this.movingOut.get(previous.sessionId) === leaving) this.movingOut.delete(previous.sessionId);
      void this.host.syncVoicePresenceVisibility();
    }
    // The arrival is scoped like any other join, so a private room's activity
    // stays with the members who can see it (#384).
    await this.host.broadcastToChannel(channelId, {
      type: MessageType.VOICE_USER_JOINED,
      requestId,
      payload: {
        channelId,
        userId: previous.userId,
        sessionId: previous.sessionId,
        voiceState,
        user: voiceRosterUser(target.user),
      } satisfies VoiceUserJoinedPayload,
    });
    return { success: true };
  }

  /**
   * The one way out of a voice room, whatever ended the stay: leaving,
   * disconnecting, a kick, a lost access or a deleted room (S-VOICE-5). What
   * the connection held in the SFU goes with it, the person removed is told
   * why first when there is a `notice`, and then everyone who may know the
   * room hears of the departure.
   *
   * Idempotent: `leaveVoiceChannel` returns null when the session is not in a
   * channel, so calling it twice (a socket that reports both `error` and
   * `close`, for instance) announces the departure only once. Returns the
   * state that ended, if any.
   */
  public endVoiceSession(sessionId: string, exit: VoiceExit = {}): VoiceParticipantState | null {
    this.forgetMove(sessionId);
    const departed = this.host.signaling.leaveVoiceChannel(sessionId);
    if (!departed) return null;
    this.host.sfuSignaling.closeSfuSession(sessionId, departed.channelId);
    if (exit.notice) this.sendVoiceNotice(sessionId, exit.notice, exit.requester);
    this.announceVoiceDeparture(departed, { requestId: exit.requestId });
    return departed;
  }

  /**
   * Tells who may know a voice room that a connection left it: whoever was
   * told the room exists (#384), a bot a command admitted into it, and the
   * person who left, on every device, who needs it to clear their own state
   * even once the room is no longer theirs to see.
   *
   * Sent at once instead of resolving the room's audience first: a departure
   * has to reach them ahead of anything announced after it, such as the same
   * connection arriving in another room, and no access change meanwhile may
   * drop it, or a participant who left would stay listed for good.
   */
  private announceVoiceDeparture(
    departed: VoiceParticipantState, { requestId, reconnect }: { requestId?: string; reconnect?: VoiceModeTransition } = {},
  ): void {
    const message: ServerMessage<MessageType.VOICE_USER_LEFT> = {
      type: MessageType.VOICE_USER_LEFT,
      requestId,
      payload: {
        channelId: departed.channelId, userId: departed.userId, sessionId: departed.sessionId,
        ...(reconnect ? { reconnect } : {}),
      },
    };
    this.host.publish((session) => session.user.id === departed.userId
      || session.visibleChannelIds?.has(departed.channelId) || this.host.hasBotVoiceGrant(session, departed.channelId)
      ? message : undefined);
  }

  /**
   * A voice room leaves a connection's list (#384), and with it the audience
   * of `announceVoiceDeparture`: nobody inside would ever be seen leaving.
   * The connection is told now that they left, or its client would keep them
   * in the room for good, shown offline by #401. Left out are its own
   * person's sessions, whose departures reach it from any room, and everyone
   * for a bot a command keeps in the room, which still hears of them.
   */
  public roomWithdrawn(session: ClientSession, channelId: string): void {
    if (!session.user || this.host.hasBotVoiceGrant(session, channelId)) return;
    for (const participant of this.host.signaling.getParticipantsInChannel(channelId)) {
      if (participant.userId === session.user.id) continue;
      this.host.send(session.ws, {
        type: MessageType.VOICE_USER_LEFT,
        payload: { channelId, userId: participant.userId, sessionId: participant.sessionId } satisfies VoiceUserLeftPayload,
      });
    }
  }

  /**
   * The reverse of `roomWithdrawn`: a voice room joins a connection's list,
   * for the first time or again, and whoever is already inside arrives with
   * it, or the room would look empty until each of them changed something.
   * The same ones are left out. Nobody is pulled into a call by this: clients
   * act on a join only in the room of their own call, and a connection
   * cannot be in a room it is only now shown, other than one the server just
   * moved it into, which its client follows once told.
   */
  public roomListed(session: ClientSession, channelId: string): void {
    if (!session.user || this.host.hasBotVoiceGrant(session, channelId)) return;
    for (const { user, voiceState } of this.getVoiceRoster(channelId, session.user.id)) {
      if (voiceState.userId === session.user.id) continue;
      this.host.send(session.ws, {
        type: MessageType.VOICE_USER_JOINED,
        payload: {
          channelId, userId: voiceState.userId, sessionId: voiceState.sessionId, voiceState, user,
        } satisfies VoiceUserJoinedPayload,
      });
    }
  }

  /**
   * A kick or a move is acted on only by the connection it names, so it goes
   * to that one and, as its answer, to whoever asked. Telling every member
   * would show who was taken out of a private room, and where to.
   */
  private sendVoiceNotice(targetSessionId: string, notice: ServerMessage, requester?: ClientSession): void {
    const target = this.host.findSession(targetSessionId);
    if (target) this.host.send(target.ws, notice);
    if (requester && requester !== target) this.host.send(requester.ws, notice);
  }

  /**
   * Removes one connection from a voice channel it may no longer be in, telling
   * the remaining participants it left (#384). No-op when it was not connected.
   */
  public evictFromVoiceChannel(sessionId: string, channelId: string): void {
    if (this.host.signaling.getVoiceState(sessionId)?.channelId === channelId) this.endVoiceSession(sessionId);
  }

  /**
   * Voice rooms a person is inside, is being moved out of, or is returning to
   * after a dropped socket or a voice mode switch. They see those rooms even
   * without VIEW_CHANNEL.
   */
  public voicePresenceChannelIds(userId: string): Set<string> {
    const rooms = new Set(this.host.signaling.getSessionsOfUser(userId).map((state) => state.channelId));
    const now = Date.now();
    for (const [session, grant] of this.voiceReconnectGrants) {
      if (session.user?.id === userId && grant.expiresAt > now) rooms.add(grant.channelId);
    }
    for (const grant of this.voiceReturnGrants.values()) {
      if (grant.userId === userId) rooms.add(grant.channelId);
    }
    for (const move of this.movingOut.values()) {
      if (move.userId === userId) rooms.add(move.channelId);
    }
    return rooms;
  }

  public grantVoiceReturn(userId: string, sessionId: string): void {
    const state = this.host.signaling.getVoiceState(sessionId);
    if (!state) return;
    const previous = this.voiceReturnGrants.get(sessionId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.clearVoiceReturn(sessionId), LIMITS.RECONNECT_GRACE_MS);
    this.voiceReturnGrants.set(sessionId, { userId, channelId: state.channelId, timer });
  }

  public clearVoiceReturn(sessionId: string): void {
    const grant = this.voiceReturnGrants.get(sessionId);
    if (!grant) return;
    clearTimeout(grant.timer);
    this.voiceReturnGrants.delete(sessionId);
    void this.host.syncVoicePresenceVisibility();
  }
}
