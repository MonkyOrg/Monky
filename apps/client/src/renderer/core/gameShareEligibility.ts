import type { UserActivity } from '@monky/shared';

/**
 * One launch of a game. `startedAt` is when it was first seen running, so a
 * game closed and opened again gets a new key, and the row is rebuilt for it.
 */
export function gameSessionKey(activity: UserActivity): string {
  return `${activity.source}:${activity.appId}:${activity.startedAt}`;
}

export interface SuggestShareContext {
  /** The "Sugerir compartilhar o jogo" setting. */
  enabled: boolean;
  activity: UserActivity | null | undefined;
  inVoiceChannel: boolean;
  isScreenSharing: boolean;
}

/**
 * Whether the sidebar suggests sharing the game you are playing (#763): only
 * in a call, since there is nobody to share with otherwise, and not while
 * already on screen.
 */
export function shouldSuggestGameShare(context: SuggestShareContext): boolean {
  return context.enabled && !!context.activity && context.inVoiceChannel && !context.isScreenSharing;
}
