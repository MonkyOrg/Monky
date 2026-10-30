import type { WebSocket } from 'ws';
import {
  MessageType, Permission, ProtocolErrorCode,
  type BotCapability, type ClientMessageType, type ProtocolMessage,
} from '@monky/shared';
import { Logger } from '../../logger/Logger';
import type { RateLimiter } from '../../security/RateLimiter';
import type { Authorizer } from '../access/Authorizer';
import { botMessageCapabilities } from '../botCapabilityPolicy';
import { isSignedIn, type ClientSession, type SignedInSession } from '../ClientSession';
import { MESSAGE_BUDGETS } from '../flowControl';

/** A payload's shape. Every zod schema is one. */
export interface PayloadSchema<P> {
  safeParse(payload: unknown): { success: true; data: P } | { success: false };
}

/** One message on its way to a handler, its payload as the route's schema read it. */
export interface RouteRequest<P, S extends ClientSession = SignedInSession> {
  session: S;
  type: MessageType;
  payload: P;
  requestId?: string;
}

/** A route's schema and the refusal for a payload that does not fit it (BAD_REQUEST). */
export interface RouteSchema<P> {
  type: PayloadSchema<P>;
  message: string;
}

/**
 * What a route requires, checked in this order before its handler runs. A
 * check whose place among the others matters to the answer, such as one made
 * after a wait, stays in the handler (#359).
 */
interface RouteChecks<P> {
  readonly types: readonly ClientMessageType[];
  /** Answered as it arrives, ahead of what the connection sent before (the heartbeat). */
  readonly unordered?: boolean;
  /** When this server or the peer's app cannot serve it. FEATURE_REQUIRES_UPDATE unless `code` says otherwise. */
  readonly unavailable?: { when(session: ClientSession): boolean; code?: ProtocolErrorCode; message: string };
  readonly schema?: RouteSchema<P>;
  /** A permission held on the server. */
  readonly permission?: Permission;
  /** The channel it acts on and the permissions it needs there, resolved together (Authorizer.authorizeChannel). */
  readonly channel?: { id(payload: P): unknown; permissions?: readonly Permission[] };
}

/** How a message from a signed-in member or bot is answered. */
export interface MemberRoute<P = unknown> extends RouteChecks<P> {
  readonly anonymous?: false;
  /** Its handler answers bots itself, and no budget applies to it (the DM relay). */
  readonly screensBots?: boolean;
  handle(request: RouteRequest<P>): Promise<void> | void;
}

/** Answered before authentication: the handshake, the heartbeat and a bot's diagnostic. */
export interface AnonymousRoute extends RouteChecks<unknown> {
  readonly anonymous: true;
  handle(request: RouteRequest<unknown, ClientSession>): Promise<void> | void;
}

export type Route = MemberRoute | AnonymousRoute;

/** A route whose payload is what its schema accepts. */
export function route<P>(definition: MemberRoute<P> & { schema: RouteSchema<P> }): Route;
/** A route whose handler reads the payload unchecked, or checks it itself. */
export function route(definition: MemberRoute & { schema?: undefined }): Route;
export function route(definition: AnonymousRoute): Route;
export function route(definition: Route): Route {
  return definition;
}

/** The channel a request names, as sent; Authorizer.authorizeChannel refuses anything that is not one. */
export function channelIdOf(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null && 'channelId' in payload ? payload.channelId : undefined;
}

export interface RouterHost {
  readonly rateLimiter: Pick<RateLimiter, 'checkLimit'>;
  readonly authorizer: Pick<Authorizer, 'requirePermission' | 'authorizeChannel'>;
  /** A connection let go, replaced or shutting down: nothing it sends is answered. */
  isRevoked(session: ClientSession): boolean;
  isCurrentBotOperation(session: ClientSession, ...capabilities: BotCapability[]): boolean;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
}

/**
 * Takes each message a connection sends through the same checks, in a fixed
 * order, to the handler of its type (S-WS-5):
 *
 * 1. a connection let go is ignored, and one already signed in cannot sign in again;
 * 2. routes answered before authentication;
 * 3. authentication;
 * 4. what a bot may send (botCapabilityPolicy, which fails closed) and the
 *    budget of the expensive messages (MESSAGE_BUDGETS);
 * 5. availability, payload shape, server permission and channel access, as
 *    the route declares them;
 * 6. the handler.
 */
export class MessageRouter {
  private readonly routes = new Map<MessageType, Route>();

  constructor(private readonly host: RouterHost) {}

  /** Adds routes. A type claimed twice is a mistake in the server, refused at startup. */
  register(...routes: Route[]): this {
    for (const route of routes) {
      for (const type of route.types) {
        if (this.routes.has(type)) throw new Error(`More than one route answers ${type}.`);
        this.routes.set(type, route);
      }
    }
    return this;
  }

  /** Whether messages of this type wait for the ones the connection sent before. */
  isOrdered(type: MessageType): boolean {
    return this.routes.get(type)?.unordered !== true;
  }

  async dispatch(session: ClientSession, message: ProtocolMessage<unknown>): Promise<void> {
    const { type, requestId, payload } = message;
    // A revoked session — one kicked from the server or replaced by a newer
    // connection of the same user — must not mutate or observe any state.
    if (this.host.isRevoked(session)) return;

    if (session.user && (type === MessageType.AUTH_CONNECT || type === MessageType.AUTH_CHALLENGE_RESPONSE)) {
      this.refuse(session, ProtocolErrorCode.BAD_REQUEST, 'Esta conexão já está autenticada.', requestId);
      return;
    }
    const route = this.routes.get(type);
    if (route?.anonymous) {
      await this.run(route, session, type, payload, requestId);
      return;
    }
    if (!isSignedIn(session)) {
      this.refuse(session, ProtocolErrorCode.UNAUTHORIZED, 'Não autenticado no servidor', requestId);
      return;
    }
    if (route?.screensBots) {
      await this.run(route, session, type, payload, requestId);
      return;
    }
    if (session.isBot) {
      const capabilities = botMessageCapabilities(type, payload);
      if (!capabilities || !this.host.isCurrentBotOperation(session, ...capabilities)) {
        this.refuse(session, capabilities ? ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED : ProtocolErrorCode.PERMISSION_DENIED,
          'This operation is not supported or has not been approved by a bot administrator.', requestId);
        return;
      }
    }
    if (!this.withinBudget(session, type, requestId)) return;
    if (route) {
      await this.run(route, session, type, payload, requestId);
    } else {
      Logger.warn('NETWORK', `Unknown message type received: ${type}`);
      this.refuse(session, ProtocolErrorCode.BAD_REQUEST, `Tipo de mensagem não suportado: ${type}`, requestId);
    }
  }

  private async run<S extends ClientSession>(
    route: RouteChecks<unknown> & { handle(request: RouteRequest<unknown, S>): Promise<void> | void },
    session: S, type: MessageType, payload: unknown, requestId: string | undefined,
  ): Promise<void> {
    if (route.unavailable?.when(session)) {
      this.refuse(session, route.unavailable.code ?? ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, route.unavailable.message, requestId);
      return;
    }
    const parsed = route.schema ? route.schema.type.safeParse(payload) : { success: true as const, data: payload };
    if (!parsed.success) {
      this.refuse(session, ProtocolErrorCode.BAD_REQUEST, route.schema?.message ?? 'Mensagem malformada', requestId);
      return;
    }
    if (route.permission !== undefined && !(await this.host.authorizer.requirePermission(session, route.permission, requestId))) return;
    if (route.channel && !(await this.host.authorizer.authorizeChannel(
      session, route.channel.id(parsed.data), route.channel.permissions ?? [], requestId))) return;
    await route.handle({ session, type, payload: parsed.data, requestId });
  }

  /** Per-person budget of the expensive messages listed in MESSAGE_BUDGETS. */
  private withinBudget(session: ClientSession, type: MessageType, requestId?: string): boolean {
    const budget = MESSAGE_BUDGETS.get(type);
    if (!budget || !session.user) return true;
    if (this.host.rateLimiter.checkLimit(`message:${type}:${session.user.id}`, budget.max, budget.windowMs)) return true;
    if (!budget.silent) {
      this.refuse(session, ProtocolErrorCode.RATE_LIMITED, 'Muitas solicitações em pouco tempo. Aguarde um momento.', requestId);
    }
    return false;
  }

  private refuse(session: ClientSession, code: ProtocolErrorCode, message: string, requestId?: string): void {
    this.host.sendError(session.ws, code, message, requestId);
  }
}
