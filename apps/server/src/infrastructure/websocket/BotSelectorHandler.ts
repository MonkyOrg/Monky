import { createHash } from 'crypto';
import {
  MessageType, Permission, ProtocolErrorCode, canAccessChannel, hasPermission,
  botSelectorCreateSchema, botSelectorFinalizeSchema, botSelectorIdSchema,
  botSelectorListSchema, botSelectorRespondSchema, botSelectorUpdateSchema,
  type BotSelector, type BotSelectorPublic, type ChatMessage, type ProtocolMessage,
  type UserSummary,
} from '@monky/shared';
import type { BotInteractionSession, SelectorInvocationAuthorization } from './BotInteractionHandler';
import type { BotSelectorService } from '../../application/services/BotSelectorService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { UserService } from '../../application/services/UserService';
import { Logger } from '../logger/Logger';

interface SelectorTransport {
  sessions(): Iterable<BotInteractionSession>;
  isCurrent(session: BotInteractionSession): boolean;
  send(session: BotInteractionSession, message: ProtocolMessage): void;
  authorizeInvocation(session: BotInteractionSession, invocationId: string, channelId: string): Promise<SelectorInvocationAuthorization | undefined>;
  publish(bot: UserSummary, channelId: string, content: string, messageId: string, canSend: () => boolean, accessUserId: string): Promise<ChatMessage>;
  broadcastMessage(message: ChatMessage): Promise<void>;
}

class SelectorAccessError extends Error {
  constructor(message: string, readonly code: ProtocolErrorCode) { super(message); }
}

export class BotSelectorHandler {
  private timer: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private selectors: BotSelectorService,
    private channels: ChannelService,
    private users: UserService,
    private transport: SelectorTransport
  ) {
    this.timer = setInterval(() => {
      void this.enqueue(async () => {
        for (const selector of this.selectors.expire()) await this.notify(selector);
      }).catch((error: unknown) => Logger.error('BOT', 'Failed to expire public selectors.', error));
    }, 1000);
    this.timer.unref();
  }

  handle(session: BotInteractionSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.transport.isCurrent(session) || !session.user) return;
      try {
        for (const expired of this.selectors.expire()) await this.notify(expired);
        if (type === MessageType.SELECTOR_LIST) {
          const input = botSelectorListSchema.parse(payload);
          if (!session.isBot && !input.channelId) throw new Error('A channel is required.');
          if (!session.isBot && input.channelId) await this.requireAccess(session, input.channelId, false);
          const selectors = session.isBot
            ? this.selectors.list(session.botId).filter((selector) => !input.channelId || selector.channelId === input.channelId)
            : this.selectors.list(undefined, input.channelId);
          const snapshots: Array<BotSelector | BotSelectorPublic> = [];
          for (const selector of selectors) {
            if (session.isBot) {
              try {
                await this.requireOwnerAccess(session, selector);
                if (!selector.messagePublished) {
                  const message = await this.publish(session, selector, selector.title, selector.messageId, true);
                  await this.transport.broadcastMessage(message);
                  const published = this.selectors.markPublished(selector.id, session.botId!);
                  await this.notify(published);
                  snapshots.push(published);
                } else snapshots.push(selector);
              } catch (error: unknown) {
                if (!(error instanceof SelectorAccessError)) throw error;
              }
            }
            else snapshots.push(await this.publicSnapshot(selector, session));
          }
          this.send(session, MessageType.SELECTOR_LIST_RESULT, { selectors: snapshots }, requestId);
          return;
        }

        let selector: BotSelector;
        if (type === MessageType.SELECTOR_CREATE) {
          this.requireBot(session);
          const input = botSelectorCreateSchema.parse(payload);
          const existing = input.id ? this.selectors.get(input.id) : undefined;
          let authorization: SelectorInvocationAuthorization | undefined;
          if (existing) {
            if (existing.botId !== session.botId || existing.channelId !== input.channelId ||
                (input.invocationId !== undefined && input.invocationId !== existing.sourceInvocationId) ||
                (existing.creatorUserId && input.invokerId !== undefined && input.invokerId !== existing.creatorUserId)) {
              throw new SelectorAccessError('Selector replay does not match its owner or invocation.', ProtocolErrorCode.PERMISSION_DENIED);
            }
            await this.requireOwnerAccess(session, existing, true);
          } else if (input.invocationId !== undefined) {
            authorization = await this.transport.authorizeInvocation(session, input.invocationId, input.channelId);
            if (!authorization || (input.invokerId !== undefined && input.invokerId !== authorization.creatorUserId)) {
              throw new SelectorAccessError('The selector requires a current, owned invocation in this channel.', ProtocolErrorCode.PERMISSION_DENIED);
            }
            await this.requirePrincipal(authorization.creatorUserId, input.channelId, true, true, true);
            if (!authorization.isCurrent()) throw new SelectorAccessError('The invocation has ended.', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
          } else {
            await this.requireAccess(session, input.channelId, true);
            if (input.invokerId && !(await this.users.isMember(input.invokerId))) throw new Error('Invoker is not a member.');
          }
          if (!this.transport.isCurrent(session)) return;
          selector = existing ?? this.selectors.create(session.botId!, input, Date.now(), authorization?.creatorUserId);
          // The ID is persisted before publication: retries after lost replies or
          // either process restarting reconcile the exact same channel message.
          const message = await this.publish(session, selector, selector.title, selector.messageId, true, authorization);
          await this.transport.broadcastMessage(message);
          selector = this.selectors.markPublished(selector.id, session.botId!);
        } else if (type === MessageType.SELECTOR_RESPOND) {
          if (session.isBot) throw new SelectorAccessError('Only human members may respond.', ProtocolErrorCode.PERMISSION_DENIED);
          const input = botSelectorRespondSchema.parse(payload);
          const existing = this.selectors.get(input.id);
          if (!existing) throw new Error('Selector not found.');
          await this.requireAccess(session, existing.channelId, true);
          if (!this.transport.isCurrent(session)) return;
          selector = this.selectors.respond(input.id, session.user.id, input.value);
        } else {
          this.requireBot(session);
          const input = botSelectorIdSchema.parse(
            type === MessageType.SELECTOR_UPDATE || type === MessageType.SELECTOR_FINALIZE
              ? this.readId(payload) : payload
          );
          const existing = this.selectors.get(input.id);
          if (!existing || existing.botId !== session.botId) throw new Error('Selector not found.');
          // Disabling commands stops new selectors/responses, not publication of
          // already-closed results or an owner's explicit close operation.
          await this.requireOwnerAccess(session, existing, type === MessageType.SELECTOR_UPDATE);
          if (!this.transport.isCurrent(session)) return;
          if (type === MessageType.SELECTOR_UPDATE) {
            selector = this.selectors.update(input.id, session.botId!, botSelectorUpdateSchema.parse(payload).patch);
          } else if (type === MessageType.SELECTOR_CLOSE) {
            selector = this.selectors.close(input.id, session.botId!);
          } else if (type === MessageType.SELECTOR_FINALIZE) {
            const final = botSelectorFinalizeSchema.parse(payload);
            if (existing.closedAt === null) throw new Error('Close the selector before publishing results.');
            if (existing.resultMessageId) selector = existing;
            else {
              const messageId = createHash('sha256').update(`selector-result:${existing.id}`).digest('hex');
              const message = await this.publish(session, existing, final.content, messageId, false);
              selector = this.selectors.markFinalized(existing.id, session.botId!, message.id);
              await this.transport.broadcastMessage(message);
            }
          } else throw new Error('Unsupported selector operation.');
        }
        if (session.isBot) await this.requireOwnerAccess(session, selector);
        this.send(session, MessageType.SELECTOR_SNAPSHOT,
          session.isBot ? selector : await this.publicSnapshot(selector, session), requestId);
        await this.notify(selector);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Selector operation failed.';
        Logger.warn('BOT', `Public selector operation ${type} failed: ${message}`);
        this.send(session, MessageType.SERVER_ERROR,
          { code: error instanceof SelectorAccessError ? error.code : ProtocolErrorCode.BOT_INTERACTION_INVALID, message }, requestId);
      }
    });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(async () => { if (!this.closed) await work(); });
    this.pending = next.catch(() => {});
    return next;
  }

  private readId(payload: unknown): { id: unknown } {
    return { id: typeof payload === 'object' && payload !== null && 'id' in payload ? payload.id : undefined };
  }

  private requireBot(session: BotInteractionSession): void {
    if (!session.isBot || !session.botId) throw new SelectorAccessError('A bot account is required.', ProtocolErrorCode.PERMISSION_DENIED);
  }

  private async requireAccess(session: BotInteractionSession, channelId: string, respond: boolean): Promise<void> {
    if (!session.user) throw new SelectorAccessError('Authentication is required.', ProtocolErrorCode.UNAUTHORIZED);
    await this.requirePrincipal(session.user.id, channelId, !session.isBot, respond, respond);
  }

  private async requirePrincipal(
    userId: string, channelId: string, human: boolean, interact: boolean, requireEnabled: boolean
  ): Promise<void> {
    const [channel, context] = await Promise.all([
      this.channels.getChannelSummary(channelId), this.channels.getAccessContext(userId),
    ]);
    if (!channel || channel.type !== 'TEXT' || !hasPermission(context.permissions, Permission.READ_MESSAGES) ||
        !canAccessChannel(channel, context.permissions, context.roleIds)) {
      throw new SelectorAccessError('Channel is unavailable.', ProtocolErrorCode.CHANNEL_NOT_FOUND);
    }
    if ((requireEnabled && channel.botCommandsEnabled === false) ||
        (interact && (!hasPermission(context.permissions, Permission.SEND_MESSAGES) ||
          (human && !hasPermission(context.permissions, Permission.USE_BOT_COMMANDS))))) {
      throw new SelectorAccessError('Bot interactions are not permitted in this channel.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    if (human && !(await this.users.isMember(userId))) {
      throw new SelectorAccessError('Membership is required.', ProtocolErrorCode.UNAUTHORIZED);
    }
  }

  private async requireOwnerAccess(
    session: BotInteractionSession, selector: BotSelector, requireEnabled = false
  ): Promise<string> {
    this.requireBot(session);
    if (!session.user || session.botId !== selector.botId) {
      throw new SelectorAccessError('Selector belongs to another bot.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    const principal = selector.creatorUserId ?? session.user.id;
    await this.requirePrincipal(principal, selector.channelId, selector.creatorUserId !== undefined, true, requireEnabled);
    return principal;
  }

  private async publish(
    session: BotInteractionSession, selector: BotSelector, content: string, messageId: string,
    requireEnabled: boolean, invocation?: SelectorInvocationAuthorization
  ): Promise<ChatMessage> {
    const principal = await this.requireOwnerAccess(session, selector, requireEnabled);
    if (!session.user) throw new SelectorAccessError('Authentication is required.', ProtocolErrorCode.UNAUTHORIZED);
    const canSend = () => this.transport.isCurrent(session) && (invocation?.isCurrent() ?? true);
    if (!canSend()) throw new SelectorAccessError('The requesting session or invocation has ended.', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    return this.transport.publish(session.user, selector.channelId, content, messageId, canSend, principal);
  }

  private async publicSnapshot(selector: BotSelector, session: BotInteractionSession): Promise<BotSelectorPublic> {
    const { responses, metadata: _metadata, invokerId, creatorUserId: _creator, sourceInvocationId: _invocation, ...publicFields } = selector;
    const counts: Record<string, number> = Object.fromEntries(selector.choices.map((choice) => [choice.value, 0]));
    for (const value of Object.values(responses)) counts[value] = (counts[value] ?? 0) + 1;
    const ownResponse = responses[session.user!.id];
    let permitted = true;
    try {
      await this.requireAccess(session, selector.channelId, true);
    } catch (error: unknown) {
      if (!(error instanceof SelectorAccessError)) throw error;
      permitted = false;
    }
    return {
      ...publicFields, counts, responseCount: Object.keys(responses).length, ownResponse,
      canRespond: permitted && selector.closedAt === null &&
        (selector.expiresAt === undefined || selector.expiresAt > Date.now()) &&
        (selector.responder === 'any' || invokerId === session.user!.id) &&
        (selector.allowChange || ownResponse === undefined),
    };
  }

  private async notify(selector: BotSelector): Promise<void> {
    for (const session of this.transport.sessions()) {
      if (!session.user || !this.transport.isCurrent(session)) continue;
      try {
        if (session.isBot) {
          if (session.botId !== selector.botId) continue;
          await this.requireOwnerAccess(session, selector);
          this.send(session, MessageType.SELECTOR_SNAPSHOT, selector);
        } else {
          await this.requireAccess(session, selector.channelId, false);
          const snapshot = await this.publicSnapshot(selector, session);
          this.send(session, MessageType.SELECTOR_SNAPSHOT, snapshot);
        }
      } catch (error: unknown) {
        if (!(error instanceof SelectorAccessError)) throw error;
      }
    }
  }

  private send(session: BotInteractionSession, type: MessageType, payload: unknown, requestId?: string): void {
    if (this.transport.isCurrent(session)) this.transport.send(session, { type, payload, requestId });
  }
}
