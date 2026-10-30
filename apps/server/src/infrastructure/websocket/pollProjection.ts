import {
  MessageType,
  legacyNativePoll,
  type ChatMessage,
  type ServerMessage,
} from '@monky/shared';

function legacyChatMessage(message: ChatMessage): ChatMessage {
  return message.poll ? { ...message, poll: legacyNativePoll(message.poll) } : message;
}

const hasPoll = (message: ChatMessage): boolean => !!message.poll;

/**
 * Clients and bots without `poll-voters` validate polls with the earlier strict
 * schema, so every message that embeds a poll reaches them without anonymity or
 * voters. Payloads are shared between recipients and are never mutated.
 */
export function projectLegacyPolls(message: ServerMessage): ServerMessage {
  switch (message.type) {
    case MessageType.POLL_UPDATED:
      return { ...message, payload: legacyNativePoll(message.payload) };
    case MessageType.CHAT_MESSAGE:
      return message.payload.poll ? { ...message, payload: legacyChatMessage(message.payload) } : message;
    case MessageType.CHAT_MESSAGE_UPDATED:
      return message.payload.message.poll
        ? { ...message, payload: { ...message.payload, message: legacyChatMessage(message.payload.message) } }
        : message;
    case MessageType.CHAT_HISTORY:
      return message.payload.messages.some(hasPoll)
        ? { ...message, payload: { ...message.payload, messages: message.payload.messages.map(legacyChatMessage) } }
        : message;
    case MessageType.CHAT_SEARCH_RESULTS:
      return message.payload.messages.some(hasPoll)
        ? { ...message, payload: { ...message.payload, messages: message.payload.messages.map(legacyChatMessage) } }
        : message;
    case MessageType.COMMUNITY_SNAPSHOT:
      return message.payload.polls.length
        ? { ...message, payload: { ...message.payload, polls: message.payload.polls.map(legacyNativePoll) } }
        : message;
    default:
      return message;
  }
}
