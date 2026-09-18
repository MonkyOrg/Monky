import type { UserActivity } from '@monky/shared';
import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { sessionManager, type SessionManager } from './SessionManager';

/**
 * Keeps the game shown on this person's card in sync with what they are
 * actually running (#675).
 *
 * The detection itself lives in the main process; this side only decides *when*
 * it may run — the setting — and where the result goes: every connected server,
 * plus each new connection as it comes up, since a server that was not yet
 * connected when the game started would otherwise show nothing.
 */
export class GamePresenceController {
  private current: UserActivity | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly sessionManager: SessionManager) {}

  public start(): void {
    const off = window.api?.onGamePresenceChanged?.((activity) => {
      this.current = activity;
      this.sessionManager.setGameActivity(activity);
    });
    if (off) this.disposers.push(off);

    // A server joined after the game started still has to learn about it.
    this.disposers.push(appEvents.on('network.connected', () => {
      if (!settingsStore.shareGameActivity || !this.current) return;
      this.sessionManager.setGameActivity(this.current);
    }));

    void this.setEnabled(settingsStore.shareGameActivity);
  }

  /**
   * Turning sharing off clears the activity everywhere instead of merely
   * stopping the polling — otherwise the last game would stay on everyone
   * else's screen, which is the opposite of what the switch promises.
   */
  public async setEnabled(enabled: boolean): Promise<void> {
    await window.api?.setGamePresenceEnabled?.(enabled);
    if (enabled) {
      const activity = (await window.api?.getCurrentGameActivity?.()) ?? null;
      this.current = activity;
      this.sessionManager.setGameActivity(activity);
      return;
    }
    this.current = null;
    this.sessionManager.setGameActivity(null);
  }

  public dispose(): void {
    for (const off of this.disposers.splice(0)) off();
  }
}

/** One per app: the detector in the main process is a single machine-wide thing. */
export const gamePresence = new GamePresenceController(sessionManager);
