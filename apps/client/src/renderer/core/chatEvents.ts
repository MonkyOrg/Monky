import {
  MessageType,
  Permission,
  chatReactionEventSchema,
  getMessageText,
  nativePollSchema,
  type ChatHistoryPayload,
  type ChatMessage,
  type ChatMessageUpdatedPayload,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { networkClient, type ConnectionStatus } from './NetworkClient';
import { isForegroundEvent } from './sessionRouting';
import { soundEffects } from './SoundEffects';
import { chatMessageNotice } from './chatNotificationPolicy';
import { chatStore } from '../stores/chatStore';
import { serverStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { serverMentionMatcher } from '../utils/mentions';
import { getLanguage } from '../i18n';

export interface ChatEventsHost {
  /** Whether the channel's conversation is on screen (#14). */
  isViewingTextChannel(channelId: string): boolean;
}

/**
 * Chat traffic of every connected server. While a handler runs, the stores
 * point at the server that sent the event (#400).
 */
export function bindChatEvents(host: ChatEventsHost): () => void {
  const unbind = [
    appEvents.on('network.status', (status: ConnectionStatus) => {
      if (status === 'CONNECTED') return;
      chatStore.finishAllInvocations('caller_disconnected');
      chatStore.setCommands([]);
    }),

    appEvents.on(`message.${MessageType.CHAT_MESSAGE}`, (message: ChatMessage) => {
      if (!serverStore.hasPermission(Permission.READ_MESSAGES, message.channelId)) return;
      chatStore.addMessage(message);
      // Own and system messages call no attention to themselves.
      const me = serverStore.currentUser;
      if (message.isSystem || !me || message.userId === me.id
        || !serverStore.canUserReadChannel(me.id, message.channelId)) return;
      // Mentions follow the rule the server and the feed highlight use (#14);
      // `@todos` counts for everyone in the channel when the server allows it (#464).
      const isMention = serverMentionMatcher(serverStore).mentions(getMessageText(message, getLanguage()), me.nickname || '');
      const foreground = isForegroundEvent();
      const notice = chatMessageNotice({
        soundMode: settingsStore.getEffectiveChatSoundMode(serverStore.serverDetails?.id, message.channelId),
        isMention,
        foreground,
        viewing: foreground && host.isViewingTextChannel(message.channelId),
      });
      if (notice.sound) soundEffects.play('chat_message');
      if (notice.unread) chatStore.markUnread(message.channelId);
      if (notice.mention === 'read') networkClient.send(MessageType.CHAT_MENTIONS_READ, { channelId: message.channelId });
      else if (notice.mention === 'badge') chatStore.markMention(message.channelId);
    }),

    appEvents.on(`message.${MessageType.CHAT_HISTORY}`, (payload: ChatHistoryPayload) => {
      if (!serverStore.hasPermission(Permission.READ_MESSAGES, payload.channelId)) return;
      chatStore.setHistory(payload.channelId, payload.messages, payload.aroundMessageId);
    }),

    ...[MessageType.CHAT_REACTION_ADDED, MessageType.CHAT_REACTION_REMOVED].map(type =>
      appEvents.on(`message.${type}`, (payload: unknown) => {
        const parsed = chatReactionEventSchema.safeParse(payload);
        if (parsed.success) chatStore.updateReaction(parsed.data, type === MessageType.CHAT_REACTION_ADDED);
      })),

    // An existing message was edited or deleted (#504). No sound and no unread
    // marker: nothing new was said, so nothing should call attention to it.
    appEvents.on(`message.${MessageType.CHAT_MESSAGE_UPDATED}`, (payload: ChatMessageUpdatedPayload) => {
      if (payload?.message && serverStore.hasPermission(Permission.READ_MESSAGES, payload.message.channelId)) {
        chatStore.updateMessage(payload.message);
      }
    }),
    appEvents.on(`message.${MessageType.POLL_UPDATED}`, (payload: unknown) => {
      const poll = nativePollSchema.safeParse(payload);
      if (poll.success && serverStore.hasPermission(Permission.READ_MESSAGES, poll.data.channelId)) chatStore.updatePoll(poll.data);
    }),
  ];
  return () => unbind.forEach(off => off());
}
