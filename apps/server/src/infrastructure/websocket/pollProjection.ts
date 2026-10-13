import {
  MessageType,
  legacyNativePoll,
  type ChatMessage,
  type ChatMessageUpdatedPayload,
  type NativePoll,
  type ProtocolMessage,
} from '@monky/shared';

function legacyChatMessage(message: ChatMessage): ChatMessage {
  return message.poll ? { ...message, poll: legacyNativePoll(message.poll) } : message;
}

/**
 * Clients and bots without `poll-voters` validate polls with the earlier strict
 * schema, so every message that embeds a poll reaches them without anonymity or
 * voters. Payloads are shared between recipients and are never mutated.
 */
export function projectLegacyPolls(message: ProtocolMessage): ProtocolMessage {
  switch (message.type) {
    case MessageType.POLL_UPDATED: {
      const poll: NativePoll | undefined = message.payload;
      return poll ? { ...message, payload: legacyNativePoll(poll) } : message;
    }
    case MessageType.CHAT_MESSAGE: {
      const chat: ChatMessage | undefined = message.payload;
      return chat?.poll ? { ...message, payload: legacyChatMessage(chat) } : message;
    }
    case MessageType.CHAT_MESSAGE_UPDATED: {
      const payload: ChatMessageUpdatedPayload | undefined = message.payload;
      return payload?.message?.poll
        ? { ...message, payload: { ...payload, message: legacyChatMessage(payload.message) } }
        : message;
    }
    case MessageType.CHAT_HISTORY:
    case MessageType.CHAT_SEARCH_RESULTS: {
      const payload: { messages?: ChatMessage[] } | undefined = message.payload;
      const messages = payload?.messages;
      return payload && messages?.some(entry => entry.poll)
        ? { ...message, payload: { ...payload, messages: messages.map(legacyChatMessage) } }
        : message;
    }
    case MessageType.COMMUNITY_SNAPSHOT: {
      const payload: { polls?: NativePoll[] } | undefined = message.payload;
      const polls = payload?.polls;
      return payload && polls?.length ? { ...message, payload: { ...payload, polls: polls.map(legacyNativePoll) } } : message;
    }
    default:
      return message;
  }
}
