import { MessageType } from '@monky/shared';
import type { ServerSession } from './SessionManager';

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
