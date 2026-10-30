import {
  LIMITS,
  LOCAL_EXECUTION_PROTOCOL_LIMITS as limits,
  ProtocolErrorCode,
  type LocalCapabilityId,
  type LocalMediaSignal,
  type LocalOperation,
  type LocalRequestContext,
  type LocalSourceContext,
  type LocalTaskCancellationCause,
  type LocalTaskControl,
  type LocalTaskFailureReason,
  type LocalTaskOffer,
  type LocalTaskRequest,
  type LocalWirePreviewResult,
  type LocalWireTaskResult,
  type ServerMessage,
} from '@monky/shared';
import { ServiceError } from '../errors';

/**
 * What BotLocalExecutionService keeps between messages, the refusal it answers with, and the one rule
 * that tells whether a session is still the connection a record was admitted for.
 */

/** Socket identity is deliberately opaque to the application layer. */
export interface BotLocalSession {
  ws: object;
  user?: { id: string };
  sessionId?: string;
  isBot?: boolean;
  botId?: string;
  botPublicKey?: string;
}

export interface BotLocalContext<Session extends BotLocalSession> {
  origin: Session;
  bot: Session;
  requestId: string;
  invokerId: string;
  originChannelId: string;
  commandName: string;
  capability: LocalCapabilityId;
  expiresAt: number;
  isCurrent(): boolean;
}

export interface BotLocalExecutionTransport<Session extends BotLocalSession> {
  isCurrent(session: Session): boolean;
  /** Whether this peer's negotiated protocol includes the operation; older clients drop unknown offers silently. */
  negotiated(session: Session, operation: LocalOperation): boolean;
  accessVersion(): string | null;
  authorizeContext(
    session: Session, context: Exclude<LocalRequestContext, { kind: 'source' }>, capability: LocalCapabilityId,
  ): Promise<BotLocalContext<Session> | undefined>;
  authorizeCaller(userId: string, channelId: string): Promise<boolean>;
  authorizeVoice(origin: Session, bot: Session, channelId: string): Promise<boolean>;
  botIdentity(session: Session): Promise<LocalTaskOffer['bot'] | undefined>;
  botBinding(botId: string): Promise<string | undefined>;
  commandHasCapability(botId: string, commandName: string, capability: LocalCapabilityId): boolean;
  voiceChannelId(session: Session): string | null;
  iceServers(session: Session): Promise<NonNullable<LocalTaskOffer['media']>['iceServers']>;
  send(session: Session, message: ServerMessage): boolean;
  error(session: Session, code: ProtocolErrorCode, reason: string, requestId?: string): void;
  reportError(error: unknown): void;
}

export type LocalAdmissionFailure = LocalTaskFailureReason | LocalTaskCancellationCause;

/** A refusal the bot or the executor reads: `reason` is the local-execution cause, `code` the protocol error. */
export class LocalAdmissionError extends ServiceError {
  constructor(readonly reason: LocalAdmissionFailure, code = ProtocolErrorCode.PERMISSION_DENIED) {
    super(code, reason);
  }
}

/** The refusal for a cause, with the protocol code each cause has always carried. */
export function localAdmissionError(reason: LocalAdmissionFailure): LocalAdmissionError {
  return new LocalAdmissionError(reason, reason === 'busy' ? ProtocolErrorCode.BOT_COMMAND_BUSY
    : reason === 'bot_disconnected' ? ProtocolErrorCode.BOT_OFFLINE
      : reason === 'permission_denied' || reason === 'permission_revoked' ? ProtocolErrorCode.PERMISSION_DENIED
        : ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
}

// Per-owner limits alone do not bound churn through disconnected/revoked bots.
export const MAX_SOURCES = limits.sourceContextsPerBot * LIMITS.MAX_BOTS_DEFAULT;
export const MAX_TASKS = LIMITS.MAX_BOT_INVOCATIONS;
export const MAX_PREVIEW_PROOFS = LIMITS.MAX_BOT_AUDIO_PREVIEW_REQUESTS;

/**
 * How a session differs from the connection a record was admitted for, in the order the checks run:
 * another socket, another login on that socket, or another identity on that login. Each caller decides
 * which of these is a departure and which is lost access, but none of them compares the fields itself.
 */
export type SessionChange = 'connection' | 'session' | 'identity';

/** The bot connection a record acts through. Every record names all four fields. */
export interface PinnedBot {
  readonly botSocket: object | undefined;
  readonly botSessionId: string | undefined;
  readonly botId: string | undefined;
  readonly botPublicKey: string | undefined;
}

/** The person a record acts for, and the connection that asked. Every record names all three fields. */
export interface PinnedInvoker {
  readonly originSocket: object | undefined;
  readonly invokerSessionId: string | undefined;
  readonly invokerId: string | undefined;
}

/** What a complete bot login presents, or undefined when it lacks any of it. */
export function pinBot(session: BotLocalSession): { botSocket: object; botSessionId: string; botId: string; botPublicKey: string } | undefined {
  const { botId, botPublicKey, sessionId } = session;
  if (!session.isBot || !botId || session.user?.id !== botId || !botPublicKey || !sessionId) return undefined;
  return { botSocket: session.ws, botSessionId: sessionId, botId, botPublicKey };
}

export function botChange(session: BotLocalSession, pinned: PinnedBot): SessionChange | undefined {
  if (session.ws !== pinned.botSocket) return 'connection';
  if (session.sessionId !== pinned.botSessionId) return 'session';
  if (!session.isBot || session.botId !== pinned.botId || session.user?.id !== pinned.botId ||
      session.botPublicKey !== pinned.botPublicKey) return 'identity';
  return undefined;
}

export function invokerChange(session: BotLocalSession, pinned: PinnedInvoker): SessionChange | undefined {
  if (session.ws !== pinned.originSocket) return 'connection';
  if (session.sessionId !== pinned.invokerSessionId) return 'session';
  if (session.isBot || session.user?.id !== pinned.invokerId) return 'identity';
  return undefined;
}

export interface Source<Session extends BotLocalSession> {
  value: LocalSourceContext;
  origin: Session;
  originSocket: object;
  commandName: string;
}

export interface ReleasedSource {
  botId: string;
  botPublicKey: string;
  expiresAt: number;
}

export interface Task<Session extends BotLocalSession> extends PinnedBot, PinnedInvoker {
  id: string;
  context: LocalRequestContext;
  scope: BotLocalContext<Session>;
  source?: Source<Session>;
  origin: Session;
  originSocket: object;
  bot: Session;
  botSocket: object;
  botId: string;
  botPublicKey: string;
  botSessionId: string;
  invokerId: string;
  invokerSessionId: string;
  requestId: string;
  spec: LocalTaskRequest['spec'];
  voiceChannelId?: string;
  expiresAt: number;
  setupDeadline: number;
  generation: number;
  botOffer?: LocalTaskOffer;
  executorOffer?: LocalTaskOffer;
  botAssigned: boolean;
  offered: boolean;
  accepted?: LocalWireTaskResult;
  ready: boolean;
  botReady: boolean;
  executorReady: boolean;
  offerRelayed: boolean;
  answerRelayed: boolean;
  candidates: number;
  queuedSignals: { endpoint: 'bot' | 'executor'; payload: LocalMediaSignal }[];
  revision: number;
  control?: LocalTaskControl;
  confirmedControl?: LocalTaskControl;
  setupTimer: NodeJS.Timeout;
  lifetimeTimer: NodeJS.Timeout;
  mediaTimer?: NodeJS.Timeout;
  controlTimer?: NodeJS.Timeout;
  controller: AbortController;
}

export interface PreviewProof<Session extends BotLocalSession> {
  result: LocalWirePreviewResult;
  contextId: string;
  bot: Session;
  botSocket: object;
  botId: string;
  botPublicKey: string;
  origin: Session;
  originSocket: object;
  expiresAt: number;
}

export interface RetiredTask<Session extends BotLocalSession> extends PinnedBot, PinnedInvoker {
  origin: Session;
  originSocket: object;
  invokerId: string;
  invokerSessionId: string;
  bot: Session;
  botSocket: object;
  botId: string;
  botPublicKey: string;
  botSessionId: string;
  generation?: number;
  revision: number;
  expiresAt: number;
}
