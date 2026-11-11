import { randomUUID } from 'crypto';
import { BOT_SCREEN_LIMITS, ProtocolErrorCode, type BotScreen, type BotScreenCreate, type BotScreenPatch, type BotScreenRef,
  type NativeScreenSource } from '@monky/shared';
import { ServiceError } from '../errors';

export class BotScreenError extends ServiceError {
  constructor(message: string, code: ProtocolErrorCode) { super(code, message); }
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

  create(botId: string, input: BotScreenCreate, creatorUserId?: string, hostSessionId?: string): ActiveBotScreen {
    if (creatorUserId && !input.invocationId) throw new Error('A screen creator requires a verified invocation.');
    if (input.kind === 'browser' && (!creatorUserId || !hostSessionId || !input.invocationId))
      throw new BotScreenError('A browser requires an authenticated host invocation.', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    if (input.id && this.active.has(input.id)) throw new BotScreenError('Screen ID already exists.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
    const screens = this.list();
    if (screens.length >= BOT_SCREEN_LIMITS.activePerServer ||
        screens.filter(({ screen }) => screen.botId === botId).length >= BOT_SCREEN_LIMITS.activePerBot ||
        screens.filter(({ screen }) => screen.channelId === input.channelId).length >= BOT_SCREEN_LIMITS.activePerChannel) {
      throw new BotScreenError('Active screen limit reached. Close a screen before creating another.', ProtocolErrorCode.BOT_INTERACTION_INVALID);
    }
    const metadata = {
      id: input.id ?? randomUUID(), instanceId: randomUUID(), botId, channelId: input.channelId, title: input.title,
      revision: 0, createdAt: Date.now(), ...(creatorUserId ? { creatorUserId } : {}),
    };
    const entry: ActiveBotScreen = {
      screen: input.kind === 'browser' ? { ...metadata, kind: 'browser', html: '', state: null,
        hostSessionId: hostSessionId!, broadcastSource: null }
        : { ...metadata, html: input.html, state: structuredClone(input.state) },
      creatorUserId, sourceInvocationId: input.invocationId,
    };
    this.active.set(entry.screen.id, entry);
    return entry;
  }

  update(ref: BotScreenRef, botId: string, patch: BotScreenPatch): ActiveBotScreen {
    const entry = this.requireOwner(ref, botId);
    if (entry.screen.kind === 'browser') throw new BotScreenError('Browser navigation is private and has no shared state.', ProtocolErrorCode.BOT_INTERACTION_INVALID);
    if (entry.screen.revision !== patch.expectedRevision) throw new BotScreenError('Screen revision is stale. Reload the current snapshot.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
    if (entry.screen.revision === Number.MAX_SAFE_INTEGER) {
      throw new BotScreenError('Screen revision limit reached.', ProtocolErrorCode.BOT_INTERACTION_INVALID);
    }
    entry.screen = { ...entry.screen, state: structuredClone(patch.state), revision: entry.screen.revision + 1 };
    return entry;
  }

  remove(ref: BotScreenRef, botId: string): ActiveBotScreen {
    const entry = this.requireOwner(ref, botId);
    this.active.delete(ref.id);
    return entry;
  }

  clear(): void { this.active.clear(); }

  publishBrowser(entry: ActiveBotScreen, source: NativeScreenSource): void {
    if (this.active.get(entry.screen.id) !== entry || entry.screen.kind !== 'browser' || entry.screen.broadcastSource)
      throw new BotScreenError('The browser host already published or retired.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
    entry.screen = { ...entry.screen, broadcastSource: source, revision: entry.screen.revision + 1 };
  }

  private requireOwner(ref: BotScreenRef, botId: string): ActiveBotScreen {
    const entry = this.active.get(ref.id);
    if (!entry || entry.screen.botId !== botId || entry.screen.instanceId !== ref.instanceId) {
      throw new BotScreenError('Screen instance not found.', ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);
    }
    return entry;
  }
}
