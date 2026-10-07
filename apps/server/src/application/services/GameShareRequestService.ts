import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  gameShareRequestSchema,
  gameShareResponseSchema,
  type GameShareAnsweredPayload,
  type GameShareClosedPayload,
  type GameShareRequestSentPayload,
  type GameShareRequestedPayload,
  type ProtocolMessage,
  type UserActivity,
} from '@monky/shared';

export interface GameShareSession {
  user?: { id: string; nickname: string; activity?: UserActivity | null };
  sessionId?: string;
  isBot?: boolean;
  invisible?: boolean;
  protocol?: { features: readonly string[] };
}

/** What the service needs from the WebSocket layer; kept narrow so tests need no sockets. */
export interface GameShareTransport<TSession extends GameShareSession> {
  send(session: TSession, message: ProtocolMessage): void;
  sessionsOfUser(userId: string): TSession[];
  /** Voice channel of one connection, or null when it is not in a call. */
  voiceChannelOf(sessionId: string): string | null;
  /** True while any device of this person publishes a screen. */
  isScreenSharing(userId: string): boolean;
}

export interface GameShareTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GameShareError {
  code: ProtocolErrorCode;
  message: string;
}

interface PendingRequest<TSession> {
  id: string;
  requester: TSession;
  requesterId: string;
  playerId: string;
  /** Player connections that got the prompt; all of them are told when it closes. */
  prompted: TSession[];
  timer: unknown;
}

const FEATURE = 'game-share-request';

/**
 * "Pedir para ver a partida" (#763): relays an ask from someone in the same
 * voice channel to a player whose game is on their card, and the answer back.
 *
 * Every reason the ask cannot reach the player gets the same error. Telling
 * "not in your channel", "not playing", "already sharing" and "appearing
 * offline" apart would let anyone probe what a person is doing.
 *
 * Nothing is stored: the ask lives at most LIMITS.GAME_SHARE_REQUEST_TIMEOUT_MS.
 */
export class GameShareRequestService<TSession extends GameShareSession = GameShareSession> {
  private readonly pending = new Map<string, PendingRequest<TSession>>();
  /** `${requesterId}:${playerId}` -> earliest time the pair may ask again. */
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly transport: GameShareTransport<TSession>,
    private readonly timers: GameShareTimers = {
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  ) {}

  public request(requester: TSession, payload: unknown, requestId?: string): GameShareError | null {
    const user = requester.user;
    if (!user || requester.isBot) {
      return { code: ProtocolErrorCode.PERMISSION_DENIED, message: 'Bots não pedem para ver partidas.' };
    }
    if (!requester.protocol?.features.includes(FEATURE)) {
      return { code: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, message: 'Pedir para ver a partida exige um cliente e servidor atualizados.' };
    }
    const parsed = gameShareRequestSchema.safeParse(payload);
    if (!parsed.success) return { code: ProtocolErrorCode.BAD_REQUEST, message: 'Pedido inválido.' };

    const playerId = parsed.data.targetUserId;
    const prompted = this.reachablePlayerSessions(user.id, playerId);
    const game = prompted[0]?.user?.activity;
    if (!game) {
      return { code: ProtocolErrorCode.PERMISSION_DENIED, message: 'Não é possível pedir para ver a partida desta pessoa agora.' };
    }

    const pair = `${user.id}:${playerId}`;
    const now = this.timers.now();
    this.forgetExpiredCooldowns(now);
    const waiting = [...this.pending.values()].some(ask => ask.requesterId === user.id && ask.playerId === playerId);
    if (waiting || (this.cooldownUntil.get(pair) ?? 0) > now) {
      return { code: ProtocolErrorCode.RATE_LIMITED, message: 'Você acabou de pedir. Aguarde um pouco antes de pedir de novo.' };
    }

    const id = randomUUID();
    const expiresInMs = LIMITS.GAME_SHARE_REQUEST_TIMEOUT_MS;
    const timer = this.timers.setTimeout(() => this.finish(id, 'not-accepted', true), expiresInMs);
    this.pending.set(id, { id, requester, requesterId: user.id, playerId, prompted, timer });

    this.transport.send(requester, {
      type: MessageType.GAME_SHARE_REQUEST_SENT, requestId,
      payload: { shareRequestId: id, expiresInMs } satisfies GameShareRequestSentPayload,
    });
    const requested: GameShareRequestedPayload = {
      shareRequestId: id, fromUserId: user.id, nickname: user.nickname, gameName: game.name, expiresInMs,
    };
    for (const session of prompted) {
      this.transport.send(session, { type: MessageType.GAME_SHARE_REQUESTED, payload: requested });
    }
    return null;
  }

  public respond(player: TSession, payload: unknown): GameShareError | null {
    const parsed = gameShareResponseSchema.safeParse(payload);
    if (!parsed.success) return { code: ProtocolErrorCode.BAD_REQUEST, message: 'Resposta inválida.' };
    const ask = this.pending.get(parsed.data.shareRequestId);
    // An answer to an ask that already closed is not an error: two devices can
    // both answer, and the second simply arrives late.
    if (!ask || ask.playerId !== player.user?.id) return null;
    // Accepting only counts while the two are still together in a call.
    const accepted = parsed.data.accepted && this.reachablePlayerSessions(ask.requesterId, ask.playerId).length > 0;
    this.finish(ask.id, accepted ? 'accepted' : 'not-accepted', !accepted);
    return null;
  }

  /** The player went live on their own; there is nothing left to ask for. */
  public playerStartedSharing(playerId: string): void {
    for (const ask of [...this.pending.values()]) {
      if (ask.playerId === playerId) this.finish(ask.id, 'accepted', false);
    }
  }

  /** A connection went away: asks it made are dropped, asks it was the only target of fail. */
  public sessionClosed(session: TSession): void {
    for (const ask of [...this.pending.values()]) {
      if (ask.requester === session) {
        this.close(ask, false);
        continue;
      }
      ask.prompted = ask.prompted.filter(prompted => prompted !== session);
      if (ask.prompted.length === 0) this.finish(ask.id, 'not-accepted', false);
    }
  }

  public dispose(): void {
    for (const ask of [...this.pending.values()]) this.close(ask, false);
  }

  /**
   * Player connections that may be asked: in the same call as the requester,
   * negotiated the feature, visible, playing, and not already on screen.
   */
  private reachablePlayerSessions(requesterId: string, playerId: string): TSession[] {
    if (requesterId === playerId || this.transport.isScreenSharing(playerId)) return [];
    const channels = new Set(this.transport.sessionsOfUser(requesterId)
      .map(session => session.sessionId ? this.transport.voiceChannelOf(session.sessionId) : null)
      .filter((channel): channel is string => channel !== null));
    return this.transport.sessionsOfUser(playerId).filter(session => {
      const channel = session.sessionId ? this.transport.voiceChannelOf(session.sessionId) : null;
      return !session.isBot && !session.invisible && !!session.user?.activity &&
        session.protocol?.features.includes(FEATURE) === true && channel !== null && channels.has(channel);
    });
  }

  private finish(id: string, outcome: GameShareAnsweredPayload['outcome'], cooldown: boolean): void {
    const ask = this.pending.get(id);
    if (!ask) return;
    this.close(ask, cooldown);
    this.transport.send(ask.requester, {
      type: MessageType.GAME_SHARE_ANSWERED,
      payload: { shareRequestId: id, outcome } satisfies GameShareAnsweredPayload,
    });
  }

  private close(ask: PendingRequest<TSession>, cooldown: boolean): void {
    this.pending.delete(ask.id);
    this.timers.clearTimeout(ask.timer);
    if (cooldown) {
      this.cooldownUntil.set(`${ask.requesterId}:${ask.playerId}`,
        this.timers.now() + LIMITS.GAME_SHARE_REQUEST_COOLDOWN_MS);
    }
    for (const session of ask.prompted) {
      this.transport.send(session, {
        type: MessageType.GAME_SHARE_CLOSED,
        payload: { shareRequestId: ask.id } satisfies GameShareClosedPayload,
      });
    }
  }

  private forgetExpiredCooldowns(now: number): void {
    for (const [pair, until] of this.cooldownUntil) {
      if (until <= now) this.cooldownUntil.delete(pair);
    }
  }
}
