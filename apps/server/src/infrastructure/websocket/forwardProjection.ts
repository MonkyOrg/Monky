import {
  MessageType,
  type ChatMessage,
  type ChatMessageUpdatedPayload,
  type ForumPostSaved,
  type ProtocolMessage,
} from '@monky/shared';

function withoutForward(message: ChatMessage): ChatMessage {
  if (!message.forwarded) return message;
  const legacy: ChatMessage = { ...message };
  delete legacy.forwarded;
  return legacy;
}

/**
 * Peers without `message-forward` may validate messages strictly, so every
 * message they receive goes without its `forwarded` marker. Payloads are shared
 * between recipients and are never mutated.
 */
export function projectLegacyForwards(message: ProtocolMessage): ProtocolMessage {
  switch (message.type) {
    case MessageType.CHAT_MESSAGE: {
      const chat: ChatMessage | undefined = message.payload;
      return chat?.forwarded ? { ...message, payload: withoutForward(chat) } : message;
    }
    case MessageType.CHAT_MESSAGE_UPDATED: {
      const payload: ChatMessageUpdatedPayload | undefined = message.payload;
      return payload?.message?.forwarded
        ? { ...message, payload: { ...payload, message: withoutForward(payload.message) } }
        : message;
    }
    case MessageType.FORUM_POST_SAVED: {
      const payload: ForumPostSaved | undefined = message.payload;
      return payload?.message?.forwarded
        ? { ...message, payload: { ...payload, message: withoutForward(payload.message) } }
        : message;
    }
    case MessageType.CHAT_HISTORY:
    case MessageType.CHAT_SEARCH_RESULTS: {
      const payload: { messages?: ChatMessage[] } | undefined = message.payload;
      const messages = payload?.messages;
      return payload && messages?.some(entry => entry.forwarded)
        ? { ...message, payload: { ...payload, messages: messages.map(withoutForward) } }
        : message;
    }
    default:
      return message;
  }
}
