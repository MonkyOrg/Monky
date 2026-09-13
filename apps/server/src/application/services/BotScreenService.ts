import { randomUUID } from 'crypto';
import { BOT_SCREEN_LIMITS, ProtocolErrorCode, type BotScreen, type BotScreenCreate, type BotScreenPatch } from '@monky/shared';

export class BotScreenError extends Error {
  constructor(message: string, readonly code: ProtocolErrorCode) { super(message); }
}

export interface ActiveBotScreen {
  screen: BotScreen;
  /** Capability principal is server-derived and is never included in public snapshots. */
  creatorUserId?: string;
  sourceInvocationId?: string;
}

/** Active screens deliberately survive command completion, but not a bot/server restart. */
export class BotScreenService {
  private active = new Map<string, ActiveBotScreen>();

  get(id: string): ActiveBotScreen | undefined { return this.active.get(id); }
  list(): ActiveBotScreen[] { return [...this.active.values()]; }

  create(botId: string, input: BotScreenCreate, creatorUserId?: string): ActiveBotScreen {
    if (input.id && this.active.has(input.id)) throw new BotScreenError('Screen ID already exists.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
    const screens = this.list();
    if (screens.length >= BOT_SCREEN_LIMITS.activePerServer ||
        screens.filter(({ screen }) => screen.botId === botId).length >= BOT_SCREEN_LIMITS.activePerBot ||
        screens.filter(({ screen }) => screen.channelId === input.channelId).length >= BOT_SCREEN_LIMITS.activePerChannel) {
      throw new Error('Active screen limit reached. Close a screen before creating another.');
    }
    const entry: ActiveBotScreen = {
      screen: {
        id: input.id ?? randomUUID(), botId, channelId: input.channelId, title: input.title,
        html: input.html, state: structuredClone(input.state), revision: 0, createdAt: Date.now(),
      },
      creatorUserId, sourceInvocationId: input.invocationId,
    };
    this.active.set(entry.screen.id, entry);
    return entry;
  }

  update(id: string, botId: string, patch: BotScreenPatch): ActiveBotScreen {
    const entry = this.requireOwner(id, botId);
    if (entry.screen.revision !== patch.expectedRevision) throw new BotScreenError('Screen revision is stale. Reload the current snapshot.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
    if (entry.screen.revision === Number.MAX_SAFE_INTEGER) throw new Error('Screen revision limit reached.');
    entry.screen = { ...entry.screen, state: structuredClone(patch.state), revision: entry.screen.revision + 1 };
    return entry;
  }

  remove(id: string, botId: string): ActiveBotScreen {
    const entry = this.requireOwner(id, botId);
    this.active.delete(id);
    return entry;
  }

  clear(): void { this.active.clear(); }

  private requireOwner(id: string, botId: string): ActiveBotScreen {
    const entry = this.active.get(id);
    if (!entry || entry.screen.botId !== botId) throw new BotScreenError('Screen not found.', ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);
    return entry;
  }
}
