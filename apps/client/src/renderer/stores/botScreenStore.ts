import { BOT_SCREEN_LIMITS, type BotScreen } from '@monky/shared';
import { appEvents, type EventBus } from '../core/EventBus';
import { createActiveProxy } from '../core/activeProxy';
import { emitOutsideRouting } from '../core/sessionRouting';
import { voiceStore } from './voiceStore';

export class BotScreenStore {
  public bus: EventBus = appEvents;
  public version = 0;
  public loadFailed = false;
  private screens = new Map<string, BotScreen>();
  private dismissedInvitations = new Set<string>();

  constructor(public readonly sessionKey: string | null = null) {}

  get(id: string): BotScreen | undefined { return this.screens.get(id); }
  list(channelId: string): BotScreen[] {
    return [...this.screens.values()].filter((screen) => screen.channelId === channelId);
  }

  isInvitationDismissed(id: string): boolean { return this.dismissedInvitations.has(id); }

  // Local view controls publish their own update; this must not invalidate an in-flight snapshot load.
  setInvitationDismissed(id: string, dismissed: boolean): void {
    if (!this.screens.has(id)) return;
    if (dismissed) this.dismissedInvitations.add(id);
    else this.dismissedInvitations.delete(id);
  }

  upsert(screen: BotScreen): void {
    const previous = this.screens.get(screen.id);
    if (previous && (previous.channelId !== screen.channelId || previous.botId !== screen.botId ||
        previous.revision >= screen.revision)) return;
    if (!previous && this.screens.size >= BOT_SCREEN_LIMITS.activePerServer) {
      const oldest = this.screens.keys().next().value;
      if (oldest !== undefined) {
        this.screens.delete(oldest);
        this.dismissedInvitations.delete(oldest);
      }
    }
    this.screens.set(screen.id, screen);
    this.changed(screen.channelId);
  }

  replace(channelId: string, screens: BotScreen[]): void {
    for (const screen of this.list(channelId)) this.screens.delete(screen.id);
    for (const screen of screens) {
      if (screen.channelId === channelId && this.screens.size < BOT_SCREEN_LIMITS.activePerServer) this.screens.set(screen.id, screen);
    }
    for (const id of this.dismissedInvitations) {
      if (!this.screens.has(id)) this.dismissedInvitations.delete(id);
    }
    this.changed(channelId);
  }

  remove(id: string, channelId: string): void {
    if (this.screens.get(id)?.channelId !== channelId) return;
    this.screens.delete(id);
    this.dismissedInvitations.delete(id);
    this.changed(channelId);
  }

  clear(): void {
    if (!this.screens.size && !this.loadFailed && !this.dismissedInvitations.size) return;
    this.screens.clear();
    this.dismissedInvitations.clear();
    this.loadFailed = false;
    this.changed(null);
  }

  setLoadFailed(failed: boolean): void {
    if (failed === this.loadFailed) return;
    this.loadFailed = failed;
    this.changed(null);
  }

  private changed(channelId: string | null): void {
    this.version++;
    this.bus.emit('bot.screens_updated', { channelId });
    if (this.sessionKey && this.sessionKey === voiceStore.voiceSessionKey) {
      emitOutsideRouting(() => appEvents.emit('voice.bot_screens_updated', { key: this.sessionKey, channelId }));
    }
  }
}

let active = new BotScreenStore();
export const botScreenStore = createActiveProxy(() => active);
export const getActiveBotScreenStore = (): BotScreenStore => active;
export const setActiveBotScreenStore = (store: BotScreenStore): void => { active = store; };
