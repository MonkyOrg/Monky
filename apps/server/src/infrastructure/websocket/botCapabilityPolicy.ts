import { MessageType, type BotCapability } from '@monky/shared';

/** Bot sockets are not human accounts: unknown or human-only operations fail closed. */
export function botMessageCapabilities(type: MessageType, payload: unknown): BotCapability[] | undefined {
  switch (type) {
    case MessageType.COMMAND_REGISTER:
    case MessageType.BOT_UPDATE_PROFILE:
    case MessageType.BOT_SETTINGS_GET:
    case MessageType.BOT_PERMISSIONS_GET:
    case MessageType.USER_LOGOUT:
    case MessageType.VOICE_LEAVE:
    case MessageType.COMMAND_FINISH:
    case MessageType.COMMAND_CANCEL:
      return [];
    case MessageType.CHAT_LOAD_HISTORY:
      return ['read_messages'];
    case MessageType.CHAT_SEND:
      return typeof payload === 'object' && payload !== null && 'replyToMessageId' in payload &&
        payload.replyToMessageId !== undefined ? ['send_messages', 'read_messages'] : ['send_messages'];
    case MessageType.CHAT_REACTION_ADD:
    case MessageType.CHAT_REACTION_REMOVE:
      return ['send_messages'];
    case MessageType.VOICE_JOIN:
    case MessageType.VOICE_STATE_UPDATE:
    case MessageType.RTC_SIGNAL:
    case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
    case MessageType.SFU_CREATE_WEBRTC_TRANSPORT:
    case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
    case MessageType.SFU_PRODUCE:
    case MessageType.SFU_PRODUCER_CLOSED:
      return ['publish_voice'];
    case MessageType.COMMAND_RESPONSE:
      return typeof payload === 'object' && payload !== null && 'ephemeral' in payload && payload.ephemeral === false
        ? ['commands', 'send_messages'] : ['commands'];
    case MessageType.COMMAND_PROMPT:
    case MessageType.COMMAND_AUTOCOMPLETE_RESULT:
    case MessageType.COMMAND_AUDIO_PREVIEW_RESULT:
    case MessageType.BOT_VOICE_CONTEXT:
      return ['commands'];
    case MessageType.COMMAND_SOUND_DOWNLOAD:
      return ['commands', 'sound_download'];
    case MessageType.SELECTOR_CREATE:
    case MessageType.SELECTOR_UPDATE:
    case MessageType.SELECTOR_FINALIZE:
    case MessageType.SELECTOR_LIST:
    case MessageType.SELECTOR_CLOSE:
      return ['selectors', 'send_messages'];
    case MessageType.BOT_SCREEN_CREATE:
    case MessageType.BOT_SCREEN_UPDATE:
    case MessageType.BOT_SCREEN_CLOSE:
    case MessageType.BOT_SCREEN_LIST:
      return ['miniapps'];
    case MessageType.BOT_LOCAL_SOURCE_REQUEST:
    case MessageType.BOT_LOCAL_TASK_REQUEST:
    case MessageType.BOT_LOCAL_TASK_CONTROL:
    case MessageType.BOT_LOCAL_TASK_EVENT:
    case MessageType.BOT_LOCAL_MEDIA_SIGNAL:
      return ['local_execution'];
    default:
      return undefined;
  }
}

export const BOT_CHAT_EVENTS = new Set<MessageType>([
  MessageType.CHAT_MESSAGE, MessageType.CHAT_HISTORY, MessageType.CHAT_MESSAGE_UPDATED,
  MessageType.CHAT_REACTION_ADDED, MessageType.CHAT_REACTION_REMOVED,
  MessageType.COMMAND_RESPONSE,
]);
