import {
  MessageType,
  type ChatMessage,
  type ServerMessage,
} from '@monky/shared';

function withoutForward(message: ChatMessage): ChatMessage {
  if (!message.forwarded) return message;
  const legacy: ChatMessage = { ...message };
  delete legacy.forwarded;
  return legacy;
}

const forwarded = (message: ChatMessage): boolean => !!message.forwarded;

/**
 * Peers without `message-forward` may validate messages strictly, so every
 * message they receive goes without its `forwarded` marker. Payloads are shared
 * between recipients and are never mutated.
 */
export function projectLegacyForwards(message: ServerMessage): ServerMessage {
  switch (message.type) {
    case MessageType.CHAT_MESSAGE:
      return message.payload.forwarded ? { ...message, payload: withoutForward(message.payload) } : message;
    case MessageType.CHAT_MESSAGE_UPDATED:
      return message.payload.message.forwarded
        ? { ...message, payload: { ...message.payload, message: withoutForward(message.payload.message) } }
        : message;
    case MessageType.FORUM_POST_SAVED:
      return message.payload.message?.forwarded
        ? { ...message, payload: { ...message.payload, message: withoutForward(message.payload.message) } }
        : message;
    case MessageType.CHAT_HISTORY:
      return message.payload.messages.some(forwarded)
        ? { ...message, payload: { ...message.payload, messages: message.payload.messages.map(withoutForward) } }
        : message;
    case MessageType.CHAT_SEARCH_RESULTS:
      return message.payload.messages.some(forwarded)
        ? { ...message, payload: { ...message.payload, messages: message.payload.messages.map(withoutForward) } }
        : message;
    default:
      return message;
  }
}
