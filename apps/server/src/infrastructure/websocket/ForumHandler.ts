import { MessageType, ProtocolErrorCode, type ProtocolMessage, type ForumPostSaved } from '@monky/shared';
import { ForumError, type ForumService } from '../../application/services/ForumService';
import type { BotInteractionSession } from './BotInteractionHandler';
import type { RateLimiter } from '../security/RateLimiter';
import { Logger } from '../logger/Logger';

interface ForumTransport {
  isCurrent(session: BotInteractionSession): boolean;
  version(): number | null;
  send(session: BotInteractionSession, message: ProtocolMessage): void;
  changed(result: ForumPostSaved): Promise<void>;
}

export class ForumHandler {
  constructor(private readonly service: ForumService,
    private readonly limiter: RateLimiter, private readonly transport: ForumTransport) {}

  async handle(session: BotInteractionSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    if (!session.user || !this.transport.isCurrent(session)) return;
    const version = this.transport.version();
    const current = () => version !== null && version === this.transport.version() && this.transport.isCurrent(session);
    try {
      if (session.isBot) throw new ForumError('Human member required.', ProtocolErrorCode.PERMISSION_DENIED);
      if (!this.limiter.checkLimit(`forum:${session.user.id}`, 30, 10_000)) {
        throw new ForumError('Too many forum requests.', ProtocolErrorCode.RATE_LIMITED);
      }
      if (type === MessageType.FORUM_LIST) {
        const result = await this.service.list(session.user.id, payload, current);
        if (!current()) throw new ForumError('Access changed.', ProtocolErrorCode.PERMISSION_DENIED);
        this.transport.send(session, { type: MessageType.FORUM_LIST_RESULT, payload: result, requestId });
        return;
      }
      const result = type === MessageType.FORUM_CREATE_POST
        ? await this.service.create(session.user.id, payload, current)
        : type === MessageType.FORUM_DELETE_POST
          ? await this.service.delete(session.user.id, payload, current)
          : await this.service.update(session.user.id, payload, current);
      await this.transport.changed(result);
      const accessVersion = this.transport.version();
      await this.service.requireAccess(session.user.id, result.deleted ? result.post.forumId : result.post.channelId);
      if (accessVersion === null || accessVersion !== this.transport.version()) {
        throw new ForumError('Access changed.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      if (this.transport.isCurrent(session)) this.transport.send(session, { type: MessageType.FORUM_POST_SAVED, payload: result, requestId });
    } catch (error) {
      if (!(error instanceof ForumError)) Logger.error('NETWORK', 'Forum operation failed.', error);
      if (this.transport.isCurrent(session)) this.transport.send(session, {
        type: MessageType.SERVER_ERROR, requestId, payload: {
          code: error instanceof ForumError ? error.code : ProtocolErrorCode.INTERNAL_ERROR,
          message: error instanceof ForumError ? error.message : 'Forum operation failed.',
        },
      });
    }
  }
}
