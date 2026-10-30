import { MessageType } from '@monky/shared';
import { isPublicUnicastAddress, normalizeIpAddress } from '../network/ReachabilityProber';

/** Limits of the WebSocket transport itself, before and after authentication. */
export interface WsFlowLimits {
  /** A connection still anonymous by then is closed. Clients give up on their own after 15 s. */
  readonly AUTH_TIMEOUT_MS: number;
  /** Before authentication only small frames are legitimate: a bot diagnostic, the largest, fits ~22 KiB. */
  readonly PREAUTH_MAX_FRAME_BYTES: number;
  /** Anonymous connections one client address may hold at once (see `clientAddress`). */
  readonly PREAUTH_MAX_SOCKETS_PER_ADDRESS: number;
  /** Anonymous connections the whole server holds; past it the oldest makes room for the newest. */
  readonly PREAUTH_MAX_SOCKETS: number;
  /** Above this, discardable messages skip a recipient that is not keeping up. */
  readonly OUTBOUND_DISCARDABLE_BYTES: number;
  /** Above this, a recipient that stopped reading is dropped; it reconnects and resynchronizes. */
  readonly OUTBOUND_MAX_BYTES: number;
}

export const WS_FLOW_LIMITS: WsFlowLimits = Object.freeze({
  AUTH_TIMEOUT_MS: 30_000,
  PREAUTH_MAX_FRAME_BYTES: 64 * 1024,
  PREAUTH_MAX_SOCKETS_PER_ADDRESS: 32,
  PREAUTH_MAX_SOCKETS: 1024,
  OUTBOUND_DISCARDABLE_BYTES: 8 * 1024 * 1024,
  OUTBOUND_MAX_BYTES: 32 * 1024 * 1024,
});

/**
 * The address that stands for a single client, if any. A reverse proxy, a
 * tunnel or a container network brings every client from one loopback or
 * private address, so capping such an address would cap the whole server.
 */
export function clientAddress(remoteAddress: string): string | undefined {
  return isPublicUnicastAddress(remoteAddress) ? normalizeIpAddress(remoteAddress) : undefined;
}

/** A sound that would only arrive late anyway can be skipped without losing any state. */
export const DISCARDABLE_MESSAGES: ReadonlySet<MessageType> = new Set([MessageType.SOUNDBOARD_PLAYED]);

/**
 * Budget of one message type per person and window.
 *
 * Listed are the messages whose cost lands on the whole server: a sound or a
 * profile change sent to everyone, a file written, a heavy query. The budgets
 * sit well above what a client sends by itself, where a click, a status change
 * or a reconnection costs one.
 */
export interface MessageBudget {
  max: number;
  windowMs: number;
  /** Fire-and-forget reports are dropped without an answer. */
  silent?: boolean;
}

export const MESSAGE_BUDGETS: ReadonlyMap<MessageType, MessageBudget> = new Map<MessageType, MessageBudget>([
  // Every play sends the whole clip (up to ~4 MB of base64) to each participant.
  [MessageType.SOUNDBOARD_PLAY, { max: 5, windowMs: 10_000 }],
  // Sent once a peer link is given up on; each one is a warning in the log.
  [MessageType.RTC_DIAGNOSTICS_REPORT, { max: 10, windowMs: 60_000, silent: true }],
  // Each reaches every member online. The avatar is also written to disk, and
  // clients send it again on every connection.
  [MessageType.USER_CHANGE_NICKNAME, { max: 10, windowMs: 60_000 }],
  [MessageType.USER_UPDATE_AVATAR, { max: 10, windowMs: 60_000 }],
  [MessageType.USER_UPDATE_VISIBILITY, { max: 20, windowMs: 60_000 }],
  [MessageType.USER_UPDATE_BRB, { max: 20, windowMs: 60_000 }],
  [MessageType.USER_UPDATE_CUSTOM_STATUS, { max: 20, windowMs: 60_000 }],
  [MessageType.USER_UPDATE_ACTIVITY, { max: 20, windowMs: 60_000 }],
  // A page of history runs thousands of statements; a client asks for one per channel opened.
  [MessageType.CHAT_LOAD_HISTORY, { max: 30, windowMs: 10_000 }],
  // May look up the public address on an external service.
  [MessageType.SERVER_GET_INVITE_INFO, { max: 10, windowMs: 60_000 }],
]);
