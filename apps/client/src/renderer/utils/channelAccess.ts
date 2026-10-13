import { ChannelSummary } from '@monky/shared';
import { serverStore } from '../stores/serverStore';
import { showAlert } from '../views/Dialog';
import { t } from '../i18n';

/**
 * The channel that blocks moving the target member there (#390).
 *
 * VIEW_CHANNEL only decides who finds a room and joins it alone, so whoever may
 * move members can bring any person into a room they can reach themselves;
 * missing speaking permission only mutes the target after the move. Bots never
 * enter private rooms through someone else.
 *
 * An unknown channel is deliberately treated as allowed. The server stays the
 * authority, and guessing here would block a legitimate move on stale state.
 */
export function findBlockedMoveTarget(userId: string, channelId: string): ChannelSummary | null {
  const channel = serverStore.getChannel(channelId);
  if (!channel) return null;
  // Bot capabilities are not disclosed in member summaries; let the server
  // authorize their public-room admission.
  return serverStore.knownMembers.get(userId)?.isBot && channel.isPrivate ? channel : null;
}

/**
 * Warns whoever is moving someone and reports whether the move must be dropped
 * (#390). Without this the request just fails server-side and nothing happens
 * on screen, which reads as a broken drag rather than a denied one.
 */
export function warnIfMoveBlocked(userId: string, nickname: string, channelId: string): boolean {
  const blocked = findBlockedMoveTarget(userId, channelId);
  if (!blocked) return false;

  void showAlert({
    title: t('main.moveBlockedTitle'),
    message: t('main.moveBlockedMessage', { user: nickname, channel: blocked.name }),
    variant: 'warning',
  });
  return true;
}
