import WebSocket from 'ws';
import type { BotPermissions, BotServerSettingsSnapshot, BotVoiceAuth, ChatMessage } from '@monky/shared';
import type { BotRegistration } from '../RegistrationStore';
import type { BotVoiceConnection } from '../voice/BotVoiceConnection';
import type { Invocation } from './commandRuntime';
import type { LiveRequest } from './liveRequests';
import { PendingReplies } from './pendingReplies';

/** A server frame with a valid envelope; each handler validates its own payload. */
export interface IncomingMessage {
  type: string;
  requestId?: string;
  payload?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readMessage(value: unknown): IncomingMessage {
  if (!isRecord(value) || typeof value.type !== 'string' ||
      (value.requestId !== undefined && typeof value.requestId !== 'string')) {
    throw new Error('Invalid Monky protocol message.');
  }
  return { type: value.type, requestId: value.requestId, payload: value.payload };
}

/** The reason a server wrote in an error payload, or `fallback` when it sent none. */
export function serverMessage(payload: unknown, fallback: string): string {
  return isRecord(payload) && typeof payload.message === 'string' ? payload.message : fallback;
}

/** A marketplace registration that completes once this connection authenticates. */
export interface PendingRegistration {
  registration: BotRegistration;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Everything the client tracks for one Monky server. A dropped socket
 * reconnects in place; after a teardown the connection is replaced, never reused.
 */
export interface ServerConnection {
  serverId: string;
  serverUrl: string;
  token: string;
  ws: WebSocket | null;
  /** Authenticated on the current socket. */
  connected: boolean;
  disposed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  retriedProtocol?: boolean;
  /** Features the server agreed to in AUTH_SUCCESS; empty for servers older than negotiation. */
  protocolFeatures?: readonly string[];
  botId: string | null;
  profileRequestId: string | null;
  serverSettings: BotServerSettingsSnapshot | undefined;
  permissions?: BotPermissions;
  voiceAuth?: BotVoiceAuth;
  voice?: BotVoiceConnection;
  voiceJoin?: Promise<BotVoiceConnection>;
  pendingMessages: PendingReplies<ChatMessage>;
  /** Selector, live action, miniapp and storage requests waiting for their acknowledgement. */
  resources: PendingReplies<unknown>;
  invocations: Map<string, Invocation>;
  /** Command handlers that have not settled, ones the server already finished included. */
  commandWork: number;
  autocompletes: Map<string, LiveRequest>;
  /** Autocomplete handlers that have not settled, cancelled ones included. */
  autocompleteWork: number;
  audioPreviews: Map<string, LiveRequest>;
  pendingRegistration: PendingRegistration | null;
  registrationPromise: Promise<void> | null;
}

/** Authenticated over a socket that is still open: the only state in which the bot acts for this server. */
export function isLive(conn: ServerConnection): boolean {
  return conn.connected && !conn.disposed && conn.ws?.readyState === WebSocket.OPEN;
}

export function createServerConnection(serverId: string, serverUrl: string, token: string): ServerConnection {
  return {
    serverId, serverUrl, token,
    ws: null,
    connected: false,
    botId: null,
    serverSettings: undefined,
    disposed: false,
    reconnectTimer: null,
    profileRequestId: null,
    invocations: new Map(),
    commandWork: 0,
    autocompletes: new Map(),
    autocompleteWork: 0,
    audioPreviews: new Map(),
    pendingMessages: new PendingReplies(),
    resources: new PendingReplies(),
    pendingRegistration: null,
    registrationPromise: null,
  };
}
