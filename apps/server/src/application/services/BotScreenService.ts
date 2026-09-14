import { randomUUID } from 'crypto';
import { BOT_SCREEN_LIMITS, ProtocolErrorCode, type BotScreen, type BotScreenCreate, type BotScreenPatch, type BotScreenRef } from '@monky/shared';

export class BotScreenError extends Error {
  constructor(message: string, readonly code: ProtocolErrorCode) { super(message); }
}

export interface ActiveBotScreen {
  screen: BotScreen;
  /** Only the authenticated invocation registry may supply this capability principal. */
  creatorUserId?: string;
  sourceInvocationId?: string;
}

/** Active screens deliberately survive command completion, but not a bot/server restart. */
export class BotScreenService {
  private active = new Map<string, ActiveBotScreen>();

  get(id: string): ActiveBotScreen | undefined { return this.active.get(id); }
  list(): ActiveBotScreen[] { return [...this.active.values()]; }

  create(botId: string, input: BotScreenCreate, creatorUserId?: string): ActiveBotScreen {
    if (creatorUserId && !input.invocationId) throw new Error('A screen creator requires a verified invocation.');
    if (input.id && this.active.has(input.id)) throw new BotScreenError('Screen ID already exists.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
    const screens = this.list();
    if (screens.length >= BOT_SCREEN_LIMITS.activePerServer ||
        screens.filter(({ screen }) => screen.botId === botId).length >= BOT_SCREEN_LIMITS.activePerBot ||
        screens.filter(({ screen }) => screen.channelId === input.channelId).length >= BOT_SCREEN_LIMITS.activePerChannel) {
      throw new Error('Active screen limit reached. Close a screen before creating another.');
    }
    const entry: ActiveBotScreen = {
      screen: {
        id: input.id ?? randomUUID(), instanceId: randomUUID(), botId, channelId: input.channelId, title: input.title,
        html: input.html, state: structuredClone(input.state), revision: 0, createdAt: Date.now(),
        ...(creatorUserId ? { creatorUserId } : {}),
      },
      creatorUserId, sourceInvocationId: input.invocationId,
    };
    this.active.set(entry.screen.id, entry);
    return entry;
  }

  update(ref: BotScreenRef, botId: string, patch: BotScreenPatch): ActiveBotScreen {
    const entry = this.requireOwner(ref, botId);
    if (entry.screen.revision !== patch.expectedRevision) throw new BotScreenError('Screen revision is stale. Reload the current snapshot.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
    if (entry.screen.revision === Number.MAX_SAFE_INTEGER) throw new Error('Screen revision limit reached.');
    entry.screen = { ...entry.screen, state: structuredClone(patch.state), revision: entry.screen.revision + 1 };
    return entry;
  }

  remove(ref: BotScreenRef, botId: string): ActiveBotScreen {
    const entry = this.requireOwner(ref, botId);
    this.active.delete(ref.id);
    return entry;
  }

  clear(): void { this.active.clear(); }

  private requireOwner(ref: BotScreenRef, botId: string): ActiveBotScreen {
    const entry = this.active.get(ref.id);
    if (!entry || entry.screen.botId !== botId || entry.screen.instanceId !== ref.instanceId) {
      throw new BotScreenError('Screen instance not found.', ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);
    }
    return entry;
  }
}
