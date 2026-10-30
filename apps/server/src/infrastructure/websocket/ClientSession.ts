import type { WebSocket } from 'ws';
import type { ProtocolAgreement, UserSummary } from '@monky/shared';

/** What a bot presented in its AUTH_CONNECT, once validated. */
export interface BotSignIn {
  botToken: string;
  publicKey: string;
  nickname: string;
  protocolVersion: number;
}

/** One WebSocket connection, signed in or not, and what the server keeps about it. */
export interface ClientSession {
  protocol?: ProtocolAgreement;
  ws: WebSocket;
  messageQueue: Promise<void>;
  user?: UserSummary;
  /**
   * `userId:deviceId` of this connection, set once authenticated (#309). It is
   * stable across reconnects of the same install, which is what lets the server
   * tell a returning device from a second one.
   */
  sessionId?: string;
  knownProducerIds?: Set<string>;
  retiredProducerIds?: Set<string>;
  /** Monotonic time of the last frame or pong received on this connection. */
  lastSeenAt: number;
  ip: string;
  /** Closes the connection if it is still anonymous when it fires. */
  authDeadline?: NodeJS.Timeout;
  /** Counted among the anonymous connections until it authenticates or leaves. */
  countedAnonymous?: boolean;
  /** True when this session was replaced by a newer connection of the same device. */
  replaced?: boolean;
  /** True when the client explicitly logged out (graceful disconnect). */
  intentionalLogout?: boolean;
  /** True when this connection has "appear offline" active (#561). */
  invisible?: boolean;
  /** True when this connection is a bot, not a human user (#569). */
  isBot?: boolean;
  botVoiceTransports?: Map<string, { channelId: string; direction: 'send' | 'recv' }>;
  botVoiceReceiveEpoch?: number;
  botVoiceJoinAttempt?: object;
  botVoiceGrant?: {
    channelId: string; creatorUserId: string; originChannelId: string; accessVersion: number;
  };
  /** The bot record id — set only for bot sessions (#569). */
  botId?: string;
  botPublicKey?: string;
  botSettingsReady?: boolean;
  /** A bot asked to prove its private key (bot-key-proof): what it signed in with, waiting for the signed challenge. */
  botKeyChallenge?: { nonce: string; signIn: BotSignIn };
  /**
   * Channels this connection currently knows about (#384). The server filters
   * private channels out before sending, so it has to remember what each client
   * was told in order to push the difference when a role or a channel's privacy
   * changes.
   */
  visibleChannelIds?: Set<string>;
  /** The categories this connection was last sent, serialized: an identical list is not sent again. */
  categoriesKey?: string;
  /** Voice rooms this connection was last shown because its person is inside them. */
  voicePresenceKey?: string;
  /**
   * Hostname this client used to reach the server, from the upgrade request's
   * `Host` header (#425).
   *
   * TURN URLs are built from it instead of an address the server guesses about
   * itself, which would be wrong behind a reverse proxy, on a multi-homed host
   * or on a LAN. Whatever brought the client here is reachable by definition.
   */
  requestHost?: string;
  /** Full endpoint used by this connection, including a proxy's port and path. */
  requestServerUrl?: string;
}

export type SignedInSession = ClientSession & { user: UserSummary };

export function isSignedIn(session: ClientSession): session is SignedInSession {
  return session.user !== undefined;
}
