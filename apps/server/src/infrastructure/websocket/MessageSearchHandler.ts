import { MessageType, ProtocolErrorCode, type ProtocolMessage, type ServerErrorPayload,
  type MessageSearchResultPayload, type UserSummary } from '@monky/shared';
import type { WebSocket } from 'ws';
import { MessageSearchError, type MessageSearchService } from '../../application/services/MessageSearchService';
import { Logger } from '../logger/Logger';

export interface MessageSearchSession {
  ws: WebSocket;
  sessionId?: string;
  user?: UserSummary;
  isBot?: boolean;
}
export interface MessageSearchHooks {
  isCurrent(session: MessageSearchSession): boolean;
  send(session: MessageSearchSession, message: ProtocolMessage<MessageSearchResultPayload | ServerErrorPayload>): void;
}

export class MessageSearchHandler {
  private readonly pending = new WeakSet<MessageSearchSession>();
  private readonly lastRequest = new WeakMap<MessageSearchSession, number>();
  private closed = false;

  constructor(private readonly service: MessageSearchService, private readonly hooks: MessageSearchHooks) {}

  public async handle(session: MessageSearchSession, payload: unknown, requestId?: string): Promise<void> {
    if (this.closed) return;
    const { user, sessionId, ws } = session;
    const version = this.service.version();
    const contentVersion = this.service.contentVersion();
    const current = () => !this.closed && this.hooks.isCurrent(session) && session.ws === ws
      && session.user?.id === user?.id && session.sessionId === sessionId;
    const fail = (code: ProtocolErrorCode, message: string) => {
      if (current()) this.hooks.send(session, { type: MessageType.SERVER_ERROR, requestId, payload: { code, message } });
    };
    if (!current()) return;
    if (!user || !sessionId) { fail(ProtocolErrorCode.UNAUTHORIZED, 'Authenticate before searching.'); return; }
    if (session.isBot || user.isBot) { fail(ProtocolErrorCode.PERMISSION_DENIED, 'Bots cannot search messages.'); return; }
    if (!requestId || requestId.length > 128) { fail(ProtocolErrorCode.MESSAGE_SEARCH_INVALID, 'Invalid search request.'); return; }
    if (this.pending.has(session) || Date.now() - (this.lastRequest.get(session) ?? 0) < 250) {
      fail(ProtocolErrorCode.RATE_LIMITED, 'Wait before searching again.'); return;
    }
    this.pending.add(session);
    this.lastRequest.set(session, Date.now());
    try {
      const result = await this.service.search(user.id, payload, current);
      if (!current()) return;
      if (version === null || version !== this.service.version() || contentVersion !== this.service.contentVersion()) {
        fail(ProtocolErrorCode.PERMISSION_DENIED, 'Message search access changed.'); return;
      }
      this.hooks.send(session, { type: MessageType.CHAT_SEARCH_RESULTS, requestId, payload: result });
    } catch (error) {
      if (error instanceof MessageSearchError) fail(error.code, error.message);
      else {
        Logger.error('NETWORK', 'Message search failed.', error);
        fail(ProtocolErrorCode.INTERNAL_ERROR, 'Message search failed.');
      }
    } finally { this.pending.delete(session); }
  }

  public close(): void { this.closed = true; }
}
