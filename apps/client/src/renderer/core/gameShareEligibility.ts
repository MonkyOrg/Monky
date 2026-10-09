import type { UserActivity, VoiceParticipantState } from '@monky/shared';

const FEATURE = 'game-share-request';

export interface AskToWatchContext {
  isSelf: boolean;
  activity: UserActivity | null | undefined;
  /** Features negotiated with the server of the call being viewed. */
  features: readonly string[] | undefined;
  /**
   * Channel ids are unique per server, so "same channel" also means the menu
   * shows the server hosting the call.
   */
  myVoiceChannelId: string | null;
  targetVoiceStates: ReadonlyArray<Pick<VoiceParticipantState, 'channelId' | 'isScreenSharing'>>;
}

/**
 * Whether "Pedir para ver a partida" shows on someone's card (#763): their game
 * is on it, both are in the same call, and they are not on screen already —
 * when they are, there is nothing to ask for, just watch.
 */
export function canAskToWatchGame(context: AskToWatchContext): boolean {
  const channel = context.myVoiceChannelId;
  return !context.isSelf && !!context.activity && channel !== null &&
    context.features?.includes(FEATURE) === true &&
    context.targetVoiceStates.some(state => state.channelId === channel) &&
    !context.targetVoiceStates.some(state => state.isScreenSharing);
}

/**
 * One launch of a game. `startedAt` is when it was first seen running, so a
 * game closed and opened again gets a new key — and the suggestion comes back.
 */
export function gameSessionKey(activity: UserActivity): string {
  return `${activity.source}:${activity.appId}:${activity.startedAt}`;
}

export interface SuggestShareContext {
  activity: UserActivity | null | undefined;
  inVoiceChannel: boolean;
  isScreenSharing: boolean;
  /** Game session already dismissed or shared, if any: no second nudge for it. */
  settledSession: string | null;
}

/**
 * Whether the sidebar suggests sharing the game you are playing (#763): only
 * in a call, since there is nobody to share with otherwise, and not while
 * already on screen.
 */
export function shouldSuggestGameShare(context: SuggestShareContext): boolean {
  return !!context.activity && context.inVoiceChannel && !context.isScreenSharing &&
    context.settledSession !== gameSessionKey(context.activity);
}
