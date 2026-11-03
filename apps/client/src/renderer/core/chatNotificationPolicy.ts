import { getMessageTexts, type ChatMessage, type MentionMatcher } from '@monky/shared';
import type { ResolvedChatSoundMode } from '../stores/settingsStore';

/**
 * Whether a message names the member, by the rule the server records the mention with (#14):
 * a bot post counts in any of its languages, whatever language the reader shows (#843), so
 * the cue and the @ badge live match the badge after reconnecting. The feed highlight follows
 * the text on screen.
 */
export function mentionsMember(message: ChatMessage, matcher: MentionMatcher, nickname: string): boolean {
  return getMessageTexts(message).some(text => matcher.mentions(text, nickname));
}

/** How a message from someone else calls attention to itself. */
export interface ChatMessageNotice {
  /** The incoming-message cue (#152). */
  sound: boolean;
  /** The unread dot on the channel (#263). */
  unread: boolean;
  /**
   * A mention seen live is read at once on the server, so it is not delivered
   * again as unread on the next connection; one that was not seen keeps the
   * @-badge until the channel is opened (#14).
   */
  mention: 'read' | 'badge' | null;
}

/**
 * The notification settings of the channel (channel → server → global, #153)
 * decide both the cue and the unread dot: 'none' never marks, 'mentions' only
 * marks mentions and 'all' marks everything. A server the user is not looking
 * at gets the dot on the rail instead of a cue, which would have no visible
 * cause (#400).
 */
export function chatMessageNotice(message: {
  soundMode: ResolvedChatSoundMode;
  isMention: boolean;
  /** The message came from the server on screen. */
  foreground: boolean;
  /** Its conversation is on screen right now. */
  viewing: boolean;
}): ChatMessageNotice {
  const notify = message.soundMode === 'all' || (message.soundMode === 'mentions' && message.isMention);
  return {
    sound: notify && message.foreground,
    unread: notify && !message.viewing,
    mention: !message.isMention ? null : message.viewing ? 'read' : 'badge',
  };
}
