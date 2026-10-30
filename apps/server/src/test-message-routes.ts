import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  MessageType, PROTOCOL_FEATURES, PROTOCOL_VERSION, Permission, ProtocolErrorCode, type ClientMessageType,
} from '@monky/shared';
import { Logger } from './infrastructure/logger/Logger';
import type { ClientSession } from './infrastructure/websocket/ClientSession';
import { MessageRouter, type Route } from './infrastructure/websocket/routing/MessageRouter';
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
  /**
   * A service this server may run without: FEATURE_UNAVAILABLE to an app that announces
   * `feature-unavailable`, and this code, the one it always answered, to older apps (#839).
   */
  service?: ProtocolErrorCode;
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
  [MessageType.CHAT_MENTIONS_READ]: { schema: true },
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
  [MessageType.CHANNEL_DELETE]: { schema: true, permission: Permission.MANAGE_CHANNELS },
  [MessageType.CHANNEL_REORDER]: { permission: Permission.MANAGE_CHANNELS },
  [MessageType.CATEGORY_CREATE]: { permission: Permission.MANAGE_CHANNELS },
  [MessageType.CATEGORY_REORDER]: { permission: Permission.MANAGE_CHANNELS },
  // The handler checks the management of the category the payload names (requireCategoryManagement).
  [MessageType.CATEGORY_UPDATE]: {},
  [MessageType.CATEGORY_DELETE]: {},
  // How each person appears (PresenceHandler).
  [MessageType.USER_CHANGE_NICKNAME]: { schema: true },
  [MessageType.USER_UPDATE_AVATAR]: { schema: true },
  [MessageType.USER_UPDATE_VISIBILITY]: {},
  [MessageType.USER_UPDATE_ACTIVITY]: {},
  [MessageType.USER_UPDATE_BRB]: {},
  [MessageType.USER_UPDATE_CUSTOM_STATUS]: {},
  // Roles and expelling a member (RoleHandler).
  [MessageType.ROLE_CREATE]: {},
  [MessageType.ROLE_UPDATE]: {},
  [MessageType.ROLE_DELETE]: { schema: true },
  [MessageType.ROLE_ASSIGN]: {},
  [MessageType.ROLE_UNASSIGN]: {},
  [MessageType.MEMBER_KICK]: { permission: Permission.KICK_MEMBERS },
  // The server's settings and invitation (ServerSettingsHandler).
  // The handler checks MANAGE_SERVER again after the waits of a save.
  [MessageType.SERVER_UPDATE_SETTINGS]: { schema: true, permission: Permission.MANAGE_SERVER },
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
  [MessageType.COMMUNITY_GET]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.COMMUNITY_IMAGE_UPLOAD]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.COMMUNITY_UPDATE_SETTINGS]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_SAVE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_GET]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_GET_INTERESTED]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_CONTROL]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.EVENT_INTEREST]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_CREATE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_UPDATE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_CLOSE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_LIST]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.LIVE_ACTION_SUBMIT]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_CREATE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_SUBMIT]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_CLOSE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.NATIVE_FORM_RESULTS]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_LIST]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_CREATE_POST]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_UPDATE_POST]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.FORUM_DELETE_POST]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.CHAT_SEARCH]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.SERVER_AUDIT_GET]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.SERVER_MONITOR_GET]: { service: ProtocolErrorCode.INTERNAL_ERROR },
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
  [MessageType.BOT_SCREEN_CREATE]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_UPDATE]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_CLOSE]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_END]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_LIST]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_SCREEN_ACTION]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.BOT_STORAGE_PUT]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_GET]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_DELETE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_LIST]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_USAGE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_INFO_GET]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_LIMIT_UPDATE]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.BOT_STORAGE_CLEAR]: { service: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE },
  [MessageType.SELECTOR_CREATE]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_LIST]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_UPDATE]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_CLOSE]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_RESPOND]: { service: ProtocolErrorCode.BAD_REQUEST },
  [MessageType.SELECTOR_FINALIZE]: { service: ProtocolErrorCode.BAD_REQUEST },
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
  if (route.service) checks.service = route.service.legacyCode ?? ProtocolErrorCode.FEATURE_REQUIRES_UPDATE;
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

/** A router over the server's own routes, recording what it answers instead of sending it. */
function routerOver(types: readonly MessageType[]) {
  const refusals: Array<{ code: ProtocolErrorCode; message: string; requestId?: string }> = [];
  const router = new MessageRouter({
    rateLimiter: { checkLimit: () => true },
    authorizer: { requirePermission: async () => true, authorizeChannel: async () => true },
    isRevoked: () => false,
    isCurrentBotOperation: () => true,
    sendError: (_ws, code, message, requestId) => { refusals.push({ code, message, requestId }); },
  });
  const routes = serverRoutes();
  for (const route of new Set(types.map((type) => routes.get(type)))) {
    assert.ok(route);
    router.register(route);
  }
  return { router, refusals, routes };
}

function member(features: readonly string[] = PROTOCOL_FEATURES): ClientSession {
  return {
    ws: Object.create(WebSocket.prototype) as WebSocket, ip: '127.0.0.1', lastSeenAt: 0, messageQueue: Promise.resolve(), isBot: false,
    sessionId: 'session', protocol: { version: PROTOCOL_VERSION, minimumVersion: PROTOCOL_VERSION, features: [...features] },
    user: { id: 'member', clientId: 'member', nickname: 'Member', status: 'ONLINE', joinedAt: 1 },
  };
}

/** What the apps send today, which must keep reaching the handlers whole. */
const CURRENT_PAYLOADS = new Map<MessageType, readonly object[]>([
  [MessageType.CHAT_MENTIONS_READ, [{ channelId: 'general' }]],
  [MessageType.USER_CHANGE_NICKNAME, [{ newNickname: 'João' }]],
  [MessageType.USER_UPDATE_AVATAR, [{ avatarBase64: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }, { avatarBase64: 'iVBORw0KGgo=' }, { avatarBase64: null }]],
  [MessageType.CHANNEL_DELETE, [{ channelId: 'general' }]],
  [MessageType.ROLE_DELETE, [{ roleId: 'moderators' }]],
  [MessageType.SERVER_UPDATE_SETTINGS, [
    { iconBase64: 'iVBORw0KGgo=' }, { iconBase64: null }, { password: null }, { password: '' }, { voiceMode: 'sfu' },
    { afkChannelEnabled: true, afkChannelName: 'Away' }, { afkTimeoutSeconds: 300 },
    {
      name: 'Monky', password: 'secret', maxMessageLength: 2000, allowSoundboard: true, recentSoundCacheEnabled: true,
      recentSoundCacheLimit: 20, dmRelayEnabled: false, allowEveryoneMention: true, allowMessageEdit: true,
      messageDeleteUndoSeconds: 10, showRoleBadgesToEveryone: false, maxAttachmentFileBytes: 1024,
      maxAttachmentStorageBytes: 4096, maxUsers: 50, voiceMode: 'p2p', turnEnabled: false,
    },
  ]],
]);

/** Shapes that used to reach the handler and throw a TypeError there, answered as INTERNAL_ERROR (#839). */
const MALFORMED = new Map<MessageType, readonly unknown[]>([
  [MessageType.CHAT_MENTIONS_READ, [{ channelId: 7 }, { channelId: '' }]],
  [MessageType.USER_CHANGE_NICKNAME, [{ newNickname: 7 }, { newNickname: null }]],
  [MessageType.USER_UPDATE_AVATAR, [{ avatarBase64: 7 }, { avatarBase64: 'x', mimeType: 7 }]],
  [MessageType.CHANNEL_DELETE, [{ channelId: 7 }, { channelId: '' }]],
  [MessageType.ROLE_DELETE, [{ roleId: ['moderators'] }, { roleId: '' }]],
  [MessageType.SERVER_UPDATE_SETTINGS, [[], 'settings', { name: 7 }, { voiceMode: 'mesh' }, { password: 7 }, { afkChannelEnabled: 'yes' }]],
]);

test('payloads read without a schema before #839 are refused as BAD_REQUEST, never reaching the handler nor the error log', async (t) => {
  const errors = t.mock.method(Logger, 'error', () => {});
  const { router, refusals } = routerOver([...MALFORMED.keys()]);
  for (const [type, shapes] of MALFORMED) {
    const universal: readonly unknown[] = type === MessageType.SERVER_UPDATE_SETTINGS ? [null, 7] : [null, {}, 7, 'x', []];
    for (const [index, payload] of [...universal, ...shapes].entries()) {
      const requestId = `${type}-${index}`;
      await router.dispatch(member(), { type, requestId, payload });
      assert.equal(refusals.at(-1)?.requestId, requestId, `${type} answered ${JSON.stringify(payload)}`);
      assert.equal(refusals.at(-1)?.code, ProtocolErrorCode.BAD_REQUEST, `${type} with ${JSON.stringify(payload)}`);
    }
  }
  assert.equal(errors.mock.callCount(), 0, 'a malformed payload is not a server error');
});

test('the payloads current apps send still fit the new schemas, without losing a field', () => {
  const routes = serverRoutes();
  for (const [type, payloads] of CURRENT_PAYLOADS) {
    const schema = routes.get(type)?.schema;
    assert.ok(schema, type);
    for (const payload of payloads) {
      const parsed = schema.type.safeParse({ ...payload, fieldOfANewerApp: true });
      assert.ok(parsed.success, `${type} refused ${JSON.stringify(payload)}`);
      assert.deepEqual(parsed.data, payload, `${type} reaches the handler as sent, minus unknown fields`);
    }
  }
});

test('a service this server runs without is FEATURE_UNAVAILABLE to a current app, and the code it always was to an older one', async () => {
  const types = Object.entries(ROUTES).filter(([, checks]) => checks?.service).map(([type]) => type as MessageType);
  assert.ok(types.length > 0);
  const { router, refusals, routes } = routerOver(types);
  const older = PROTOCOL_FEATURES.filter((feature) => feature !== 'feature-unavailable');
  for (const type of types) {
    await router.dispatch(member(), { type, requestId: `${type}-current`, payload: {} });
    assert.deepEqual(refusals.at(-1), { code: ProtocolErrorCode.FEATURE_UNAVAILABLE, message: routes.get(type)?.service?.message, requestId: `${type}-current` });
    await router.dispatch(member(older), { type, requestId: `${type}-older`, payload: {} });
    assert.deepEqual(refusals.at(-1), { code: ROUTES[type as ClientMessageType]?.service, message: routes.get(type)?.service?.message, requestId: `${type}-older` });
  }
});
