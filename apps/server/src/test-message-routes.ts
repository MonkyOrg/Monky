import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageType, Permission, ProtocolErrorCode, type ClientMessageType } from '@monky/shared';
import type { Route } from './infrastructure/websocket/routing/MessageRouter';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';

/**
 * What the router checks before a route's handler runs, as the route declares
 * it (S-WS-5). A check whose place among the others matters stays in the
 * handler and is not part of it.
 */
interface Checks {
  /** Answered before signing in. */
  anonymous?: true;
  /** Answered ahead of what the connection sent before. */
  unordered?: true;
  /** Past the bot policy and the budget: its handler answers bots itself. */
  screensBots?: true;
  /** The code answered when this server or the peer's app cannot serve it. */
  unavailable?: ProtocolErrorCode;
  /** The payload goes through a schema first, refused as BAD_REQUEST. */
  schema?: true;
  /** A permission held on the server. */
  permission?: Permission;
  /** The channel the payload names, refused as CHANNEL_NOT_FOUND (#384), and the permissions needed in it. */
  channel?: readonly Permission[];
}

/**
 * Every message type a client may send, with the checks of the route that
 * answers it, or null when no route does. Changing a line changes who may do
 * what: it is changed on purpose, together with its route.
 */
const ROUTES: Record<ClientMessageType, Checks | null> = {
  // The connection itself: its heartbeat, signing out and the DM relay.
  [MessageType.PING]: { anonymous: true, unordered: true },
  [MessageType.DM_RELAY_SEND]: { screensBots: true },
  [MessageType.USER_LOGOUT]: {},
  // Signing in (AuthHandler).
  [MessageType.AUTH_CONNECT]: { anonymous: true },
  [MessageType.AUTH_CHALLENGE_RESPONSE]: { anonymous: true },
  [MessageType.BOT_DIAGNOSTIC]: { anonymous: true },
  // Messages in a channel (ChatHandler).
  [MessageType.CHAT_REACTION_ADD]: { schema: true, channel: [Permission.SEND_MESSAGES] },
  [MessageType.CHAT_REACTION_REMOVE]: { schema: true, channel: [Permission.SEND_MESSAGES] },
  [MessageType.CHAT_SEND]: { channel: [Permission.SEND_MESSAGES] },
  // A missing channel is CHANNEL_NOT_FOUND here; before the router it was the BAD_REQUEST of the history schema.
  [MessageType.CHAT_LOAD_HISTORY]: { channel: [Permission.READ_MESSAGES] },
  [MessageType.CHAT_EDIT]: { channel: [Permission.SEND_MESSAGES] },
  [MessageType.CHAT_DELETE]: { channel: [] },
  [MessageType.CHAT_RESTORE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, channel: [] },
  [MessageType.CHAT_MENTIONS_READ]: {},
  [MessageType.CHAT_REQUEST_UPLOAD_TOKEN]: { channel: [Permission.ATTACH_FILES, Permission.SEND_MESSAGES] },
  // Polls (PollHandler).
  [MessageType.POLL_CREATE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, schema: true, channel: [Permission.SEND_MESSAGES, Permission.READ_MESSAGES] },
  [MessageType.POLL_VOTE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, schema: true },
  [MessageType.POLL_CLOSE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, schema: true },
  [MessageType.POLL_VOTERS]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, schema: true },
  [MessageType.POLL_EDIT]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, schema: true },
  [MessageType.POLL_GET]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, schema: true },
  // Channels and categories (ChannelHandler).
  [MessageType.CHANNEL_CREATE]: { permission: Permission.MANAGE_CHANNELS },
  [MessageType.CHANNEL_UPDATE]: { permission: Permission.MANAGE_CHANNELS },
  [MessageType.CHANNEL_DELETE]: { permission: Permission.MANAGE_CHANNELS },
  [MessageType.CHANNEL_REORDER]: { permission: Permission.MANAGE_CHANNELS },
  [MessageType.CATEGORY_CREATE]: { permission: Permission.MANAGE_CHANNELS },
  [MessageType.CATEGORY_REORDER]: { permission: Permission.MANAGE_CHANNELS },
  // The handler checks the management of the category the payload names (requireCategoryManagement).
  [MessageType.CATEGORY_UPDATE]: {},
  [MessageType.CATEGORY_DELETE]: {},
  // How each person appears (PresenceHandler).
  [MessageType.USER_CHANGE_NICKNAME]: {},
  [MessageType.USER_UPDATE_AVATAR]: {},
  [MessageType.USER_UPDATE_VISIBILITY]: {},
  [MessageType.USER_UPDATE_ACTIVITY]: {},
  [MessageType.USER_UPDATE_BRB]: {},
  [MessageType.USER_UPDATE_CUSTOM_STATUS]: {},
  // Roles and expelling a member (RoleHandler).
  [MessageType.ROLE_CREATE]: {},
  [MessageType.ROLE_UPDATE]: {},
  [MessageType.ROLE_DELETE]: {},
  [MessageType.ROLE_ASSIGN]: {},
  [MessageType.ROLE_UNASSIGN]: {},
  [MessageType.MEMBER_KICK]: { permission: Permission.KICK_MEMBERS },
  // The server's settings and invitation (ServerSettingsHandler).
  // The handler checks MANAGE_SERVER again after the waits of a save.
  [MessageType.SERVER_UPDATE_SETTINGS]: { permission: Permission.MANAGE_SERVER },
  [MessageType.SERVER_GET_INVITE_INFO]: {},
  // The Soundboard and the recent sounds (SoundboardHandler).
  // USE_SOUNDBOARD is checked by the handler, after whether the server allows the Soundboard at all (#359).
  [MessageType.SOUNDBOARD_PLAY]: { channel: [Permission.SPEAK] },
  [MessageType.SOUNDBOARD_STOP]: { channel: [] },
  [MessageType.RECENT_SOUND_RECORD]: {},
  [MessageType.RECENT_SOUNDS_LIST]: {},
  [MessageType.RECENT_SOUND_DOWNLOAD]: {},
  // Bots as the server administers them (BotManagementHandler).
  [MessageType.BOT_SETTINGS_LIST]: {},
  [MessageType.BOT_SETTINGS_GET]: {},
  [MessageType.BOT_SETTINGS_UPDATE]: {},
  [MessageType.BOT_PERMISSIONS_GET]: {},
  [MessageType.BOT_PERMISSIONS_UPDATE]: {},
  [MessageType.BOT_INSTALL_PREVIEW]: {},
  [MessageType.BOT_CREATE]: { permission: Permission.MANAGE_BOTS },
  [MessageType.BOT_LIST]: { permission: Permission.MANAGE_BOTS },
  [MessageType.BOT_UPDATE_PROFILE]: {},
  [MessageType.BOT_REVOKE]: { permission: Permission.MANAGE_BOTS },
  [MessageType.BOT_INSTALL]: { permission: Permission.MANAGE_BOTS },
  [MessageType.COMMAND_REGISTER]: {},
  [MessageType.COMMANDS_LIST]: {},
  // Calls: voice rooms, the SFU, WebRTC signals, screens and game sharing.
  [MessageType.VOICE_JOIN]: {},
  [MessageType.VOICE_RECONNECT]: {},
  [MessageType.VOICE_LEAVE]: {},
  [MessageType.VOICE_STATE_UPDATE]: {},
  [MessageType.VOICE_AFK]: {},
  [MessageType.ADMIN_MUTE_USER]: {},
  [MessageType.ADMIN_DEAFEN_USER]: {},
  [MessageType.ADMIN_GET_VOICE_RESTRICTIONS]: {},
  [MessageType.ADMIN_KICK_VOICE]: {},
  [MessageType.ADMIN_MOVE_USER]: {},
  [MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES]: {},
  [MessageType.SFU_CREATE_WEBRTC_TRANSPORT]: {},
  [MessageType.SFU_CONNECT_WEBRTC_TRANSPORT]: {},
  [MessageType.SFU_PRODUCE]: {},
  [MessageType.SFU_CONSUME]: {},
  [MessageType.SFU_PRODUCER_CLOSED]: {},
  [MessageType.SFU_PRODUCER_SET_PAUSED]: {},
  [MessageType.SFU_CLOSE_WEBRTC_TRANSPORT]: {},
  [MessageType.SFU_GET_PRODUCERS]: {},
  [MessageType.SFU_CONSUMER_SET_PAUSED]: {},
  [MessageType.SFU_CONSUMER_CLOSED]: {},
  [MessageType.RTC_SIGNAL]: {},
  [MessageType.RTC_DIAGNOSTICS_REPORT]: {},
  [MessageType.NATIVE_SCREEN_SIGNAL]: {},
  [MessageType.SCREEN_VIEWERS_GET]: {},
  [MessageType.GAME_SHARE_REQUEST]: {},
  [MessageType.GAME_SHARE_RESPONSE]: {},
  // Community features, the audit log and the monitor.
  [MessageType.COMMUNITY_GET]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.COMMUNITY_IMAGE_UPLOAD]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.COMMUNITY_UPDATE_SETTINGS]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_SAVE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_GET]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_GET_INTERESTED]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_CONTROL]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_INTEREST]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_CREATE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_UPDATE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_CLOSE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_LIST]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_SUBMIT]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_CREATE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_SUBMIT]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_CLOSE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_RESULTS]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_LIST]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_CREATE_POST]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_UPDATE_POST]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_DELETE_POST]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.CHAT_SEARCH]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.SERVER_AUDIT_GET]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.SERVER_MONITOR_GET]: { unavailable: ProtocolErrorCode.INTERNAL_ERROR },
  // What bots do through the server.
  // The handler tells a person when nobody approved the bot for commands (BOT_PERMISSIONS_REQUIRED).
  [MessageType.COMMAND_INVOKE]: {},
  [MessageType.COMMAND_AUTOCOMPLETE]: {},
  [MessageType.COMMAND_AUDIO_PREVIEW]: {},
  [MessageType.BOT_VOICE_CONTEXT]: {},
  [MessageType.COMMAND_AUTOCOMPLETE_RESULT]: {},
  [MessageType.COMMAND_AUTOCOMPLETE_CANCEL]: {},
  [MessageType.COMMAND_AUDIO_PREVIEW_RESULT]: {},
  [MessageType.COMMAND_AUDIO_PREVIEW_CANCEL]: {},
  [MessageType.COMMAND_SOUND_DOWNLOAD]: {},
  [MessageType.COMMAND_SOUND_DOWNLOAD_RESULT]: {},
  [MessageType.COMMAND_RESPONSE]: {},
  [MessageType.COMMAND_PROMPT]: {},
  [MessageType.COMMAND_SUBMIT]: {},
  [MessageType.COMMAND_CANCEL]: {},
  [MessageType.COMMAND_FINISH]: {},
  [MessageType.BOT_LOCAL_SOURCE_REQUEST]: {},
  [MessageType.BOT_LOCAL_TASK_REQUEST]: {},
  [MessageType.BOT_LOCAL_TASK_ACCEPT]: {},
  [MessageType.BOT_LOCAL_TASK_CONTROL]: {},
  [MessageType.BOT_LOCAL_TASK_EVENT]: {},
  [MessageType.BOT_LOCAL_MEDIA_SIGNAL]: {},
  [MessageType.BOT_SCREEN_CREATE]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_UPDATE]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_CLOSE]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_END]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_LIST]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_ACTION]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_STORAGE_PUT]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_GET]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_DELETE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_LIST]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_USAGE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_INFO_GET]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_LIMIT_UPDATE]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_CLEAR]: { unavailable: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.SELECTOR_CREATE]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_LIST]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_UPDATE]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_CLOSE]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_RESPOND]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_FINALIZE]: { unavailable: ProtocolErrorCode.BAD_REQUEST },
  // No route: refused as an unsupported type, as it always was.
  [MessageType.PONG]: null,
};

const isClientType = (type: MessageType): type is ClientMessageType => type in ROUTES;

/** The checks a route declares, in the shape of the table. */
function checksOf(route: Route): Checks {
  const checks: Checks = {};
  if (route.anonymous) checks.anonymous = true;
  if (route.unordered) checks.unordered = true;
  if (!route.anonymous && route.screensBots) checks.screensBots = true;
  if (route.unavailable) checks.unavailable = route.unavailable.code ?? ProtocolErrorCode.FEATURE_REQUIRES_UPDATE;
  if (route.schema) checks.schema = true;
  if (route.permission !== undefined) checks.permission = route.permission;
  if (route.channel) checks.channel = route.channel.permissions ?? [];
  return checks;
}

/** The routes the server registers, as its constructor registers them. */
function serverRoutes(): ReadonlyMap<MessageType, Route> {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  return server['router']['routes'];
}

test('every message type is answered with exactly the checks the table lists, and a type it lists without a route by none', () => {
  const routes = serverRoutes();
  for (const type of Object.values(MessageType)) {
    const route = routes.get(type);
    const expected = isClientType(type) ? ROUTES[type] : null;
    if (expected === null) {
      assert.equal(route, undefined, `${type} has a route the table does not list`);
      continue;
    }
    assert.ok(route, `${type} has no route`);
    assert.deepEqual(checksOf(route), expected, `the checks of ${type} changed`);
  }
});

test('a route that resolves a channel reads the channelId of the payload, and finds none in a payload without it', () => {
  for (const [type, route] of serverRoutes()) {
    if (!route.channel) continue;
    assert.equal(route.channel.id({ channelId: 'channel' }), 'channel', type);
    assert.equal(route.channel.id({}), undefined, type);
  }
});
