import { randomUUID } from 'crypto';
import {
  BOT_SELECTOR_MAX_DURATION_MS,
  botSelectorCreateSchema,
  botSelectorPatchSchema,
  type BotSelector,
  type BotSelectorCreate,
  type BotSelectorPatch,
} from '@monky/shared';
import type { IBotSelectorRepository } from '../../domain/repositories';

/**
 * Mutations contain no await: each vote, threshold and expiry is one repository
 * transaction. Timers are only a wake-up mechanism; persisted deadlines win.
 */
export class BotSelectorService {
  constructor(private repository: IBotSelectorRepository) {}

  get(id: string): BotSelector | undefined {
    return this.repository.findById(id);
  }

  list(botId?: string, channelId?: string): BotSelector[] {
    return this.repository.list(botId, channelId);
  }

  create(botId: string, input: BotSelectorCreate, now = Date.now(), creatorUserId?: string): BotSelector {
    const parsed = botSelectorCreateSchema.parse(input);
    const { invocationId, ...definition } = parsed;
    if (creatorUserId && !invocationId) throw new Error('A creator capability requires a verified invocation.');
    const id = parsed.id ?? randomUUID();
    return this.repository.transaction(() => {
      const existing = this.get(id);
      if (existing) {
        if (existing.botId !== botId || existing.channelId !== parsed.channelId) throw new Error('Selector id is already in use.');
        return existing;
      }
      this.validateDeadline(parsed.expiresAt, now);
      if (this.repository.countOpen(botId) >= 100) throw new Error('Too many open selectors.');
      const selector: BotSelector = {
        ...definition, id, botId, messageId: randomUUID(), createdAt: now,
        closedAt: null, responses: {}, resultMessageId: null,
        ...(creatorUserId ? { creatorUserId, sourceInvocationId: invocationId, invokerId: creatorUserId } : {}),
      };
      this.repository.create(selector);
      return selector;
    });
  }

  respond(id: string, userId: string, value: string, now = Date.now()): BotSelector {
    return this.repository.transaction(() => {
      const selector = this.require(id);
      if (selector.closedAt !== null || this.isDue(selector, now)) {
        this.closeIfDue(selector, now);
        throw new Error('This selector is closed.');
      }
      if (selector.responder === 'invoker' && selector.invokerId !== userId) throw new Error('Only the invoker may respond.');
      if (!selector.choices.some((choice) => choice.value === value)) throw new Error('Invalid selector choice.');
      if (Object.hasOwn(selector.responses, userId) && !selector.allowChange && selector.responses[userId] !== value) {
        throw new Error('This selector does not allow changing a response.');
      }
      selector.responses = { ...selector.responses, [userId]: value };
      if (this.isDue(selector, now)) selector.closedAt = now;
      this.save(selector);
      return selector;
    });
  }

  update(id: string, botId: string, patch: BotSelectorPatch, now = Date.now()): BotSelector {
    const parsed = botSelectorPatchSchema.parse(patch);
    return this.repository.transaction(() => {
      const selector = this.requireOwned(id, botId);
      if (selector.closedAt !== null || this.isDue(selector, now)) throw new Error('This selector is closed.');
      this.validateDeadline(parsed.expiresAt, now);
      Object.assign(selector, parsed);
      if (this.isDue(selector, now)) selector.closedAt = now;
      this.save(selector);
      return selector;
    });
  }

  close(id: string, botId: string, now = Date.now()): BotSelector {
    return this.repository.transaction(() => {
      const selector = this.requireOwned(id, botId);
      if (selector.closedAt === null) {
        selector.closedAt = now;
        this.save(selector);
      }
      return selector;
    });
  }

  expire(now = Date.now()): BotSelector[] {
    return this.repository.transaction(() => {
      return this.repository.listExpired(now).map((selector) => {
        this.closeIfDue(selector, now);
        return selector;
      });
    });
  }

  markFinalized(id: string, botId: string, messageId: string): BotSelector {
    return this.repository.transaction(() => {
      const selector = this.requireOwned(id, botId);
      if (selector.closedAt === null) throw new Error('Close the selector before publishing results.');
      selector.resultMessageId ??= messageId;
      this.save(selector);
      return selector;
    });
  }

  markPublished(id: string, botId: string): BotSelector {
    const selector = this.requireOwned(id, botId);
    selector.messagePublished = true;
    this.save(selector);
    return selector;
  }

  private require(id: string): BotSelector {
    const selector = this.get(id);
    if (!selector) throw new Error('Selector not found.');
    return selector;
  }

  private requireOwned(id: string, botId: string): BotSelector {
    const selector = this.require(id);
    if (selector.botId !== botId) throw new Error('Selector belongs to another bot.');
    return selector;
  }

  private validateDeadline(expiresAt: number | undefined, now: number): void {
    if (expiresAt !== undefined && (expiresAt <= now || expiresAt > now + BOT_SELECTOR_MAX_DURATION_MS)) {
      throw new Error('Selector deadline must be in the next 30 days.');
    }
  }

  private isDue(selector: BotSelector, now: number): boolean {
    return (selector.expiresAt !== undefined && selector.expiresAt <= now) ||
      (selector.maxResponders !== undefined && Object.keys(selector.responses).length >= selector.maxResponders);
  }

  private closeIfDue(selector: BotSelector, now: number): void {
    if (selector.closedAt === null && this.isDue(selector, now)) {
      selector.closedAt = Math.min(now, selector.expiresAt ?? now);
      this.save(selector);
    }
  }

  private save(selector: BotSelector): void {
    this.repository.save(selector);
  }
}
