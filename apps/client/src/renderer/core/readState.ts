import { MessageType } from '@monky/shared';
import type { ServerSession } from './SessionManager';

/** What reading a server touches: its chat state and its own connection. */
type ReadTarget = Pick<ServerSession, 'chatStore' | 'client'>;

/**
 * Clears the unread dot of these channels and, on the server too, any mention
 * pending in them, so it is not delivered again as unread (#263, #14).
 */
export function markChannelsRead(target: ReadTarget, channelIds: readonly string[]): void {
  for (const channelId of channelIds) {
    target.chatStore.clearUnread(channelId);
    if (!target.chatStore.hasMention(channelId)) continue;
    target.chatStore.clearMention(channelId);
    target.client.send(MessageType.CHAT_MENTIONS_READ, { channelId });
  }
}

/**
 * Marks every channel of a server as read. Each session talks through its own
 * client, never the proxied one, so a background server is cleared on its own
 * connection instead of the one on screen (#400).
 */
export function markSessionRead(session: ServerSession): void {
  const mentions = session.chatStore.markAllRead();
  if (session.client.getStatus() === 'CONNECTED') {
    for (const channelId of mentions) session.client.send(MessageType.CHAT_MENTIONS_READ, { channelId });
  }
}
