import type { UserActivity } from '@monky/shared';
import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { sessionManager, type SessionManager } from './SessionManager';

/**
 * Keeps the game shown on this person's card in sync with what they are
 * actually running (#675).
 *
 * The detection itself lives in the main process; this side only decides *when*
 * it may run — either setting that needs it — and where the result goes. The
 * app always hears about the game (the share suggestion, #763), but servers only
 * while the card setting is on: every connected server, plus each new connection
 * as it comes up, since a server that was not yet connected when the game
 * started would otherwise show nothing.
 */
export class GamePresenceController {
  private activity: UserActivity | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly sessionManager: SessionManager) {}

  /** The game running right now, or null when none is or detection is off. */
  public get current(): UserActivity | null {
    return this.activity;
  }

  public start(): void {
    const off = window.api?.onGamePresenceChanged?.((activity) => this.update(activity));
    if (off) this.disposers.push(off);

    // A server joined after the game started still has to learn about it.
    // Deferred past this dispatch: the listener that stores the server details,
    // and with them the negotiated features, is registered after this one.
    this.disposers.push(appEvents.on('network.connected', () => queueMicrotask(() => {
      if (!settingsStore.shareGameActivity || !this.activity) return;
      this.sessionManager.setGameActivity(this.activity);
    })));

    void this.refresh();
  }

  /**
   * Applies the settings after either one changes. Turning the card off clears
   * the activity on every server instead of merely stopping the polling —
   * otherwise the last game would stay on everyone else's screen, which is the
   * opposite of what the switch promises.
   */
  public async refresh(): Promise<void> {
    const detect = settingsStore.shareGameActivity || settingsStore.suggestGameShare;
    await window.api?.setGamePresenceEnabled?.(detect);
    this.update(detect ? (await window.api?.getCurrentGameActivity?.()) ?? null : null);
  }

  /** Servers learn the game through the sessions; the rest of the app, through the event. */
  private update(activity: UserActivity | null): void {
    this.activity = activity;
    this.sessionManager.setGameActivity(settingsStore.shareGameActivity ? activity : null);
    appEvents.emit('game_presence.changed', activity);
  }

  public dispose(): void {
    for (const off of this.disposers.splice(0)) off();
  }
}

/** One per app: the detector in the main process is a single machine-wide thing. */
export const gamePresence = new GamePresenceController(sessionManager);
