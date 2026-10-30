import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants.js';

// Raise the affected floor for security or wire-breaking changes; additive
// features only raise PROTOCOL_VERSION and are negotiated independently.
// Protocol 26 introduced the native 4K/80 Mbps bounds and H.264 negotiation.
// Protocol 28 adds screen codec metadata to strict source/signaling schemas.
// Older clients cannot safely decode AV1 or accept those descriptors.
// Protocol 29 adds private screen audiences and 1080p240/4K120 profile bounds.
// Protocol 31 adds mixed categories and the FORUM channel kind.
// Channel permissions require clients to revoke cached content independently of visibility.
// Protocol 36 adds the negotiated human-only DM relay.
// role-deny: 36.1 roles carry allow/deny over Everyone; clients without it receive legacy full masks.
// role-grants: roles only grant on top of Everyone and add up; clients with only role-deny receive nothing denied.
// game-activity: USER_UPDATE_ACTIVITY and UserSummary.activity (#675); peers without it never see the game.
// game-share-request: GAME_SHARE_* (#763); asking requires it on both ends, so older peers never get prompts.
// channel-tree-order: categories and loose channels share one root order, sent as one CHANNEL_REORDER with categoryId null.
// poll-voters: polls carry anonymity and voters, votes can be withdrawn; other clients receive the earlier poll shape.
// poll-edit: the creator or a server manager may change an open poll; reset answers receive new ids.
// Protocol 37 adds the pre-authentication BOT_DIAGNOSTIC; older servers answer it as a malformed message.
// Protocol 38 adds local-youtube-playlist: bots learn the server relays youtube.playlist, and the server
// only offers it to executors that negotiated it, because older clients silently drop unknown offers.
// server-audit: SERVER_AUDIT_GET reads the audit log; clients without it never show the menu, and older
// servers would answer the unknown request as malformed.
// bot-manifest-url: bot settings summaries carry the manifest URL used at installation, only for people who
// manage bots; clients without it never receive the field their strict summary schema would reject.
// screen-shares-8: a session may publish up to SCREEN_SHARE_LIMITS.maximum screens; clients without it are sent
// only the first SCREEN_SHARE_LIMITS.legacy of each person, which is what their native roster accepts.
// voice-user-limit: a voice channel's maxParticipants is an optional limit shown next to its name, 0 meaning
// none. Older servers capped every room at a hidden 10, so clients only offer the setting when it is negotiated.
// afk-channel: ServerDetails.afkChannelId/afkTimeoutSeconds, the AFK settings and VOICE_AFK. Servers refuse entry into
// the AFK room on purpose; older clients list it as an ordinary room and, as on any refused switch there, leave their call.
// Protocol 39 adds bot-storage: the server_storage and device_storage capabilities and BOT_STORAGE_*. Peers
// without it never see those capability names, which their strict enum rejects, and keep them untouched.
// Protocol 40 adds message-forward: CHAT_SEND accepts `forward` and messages carry `forwarded`. Only peers that
// negotiated it receive the field; older servers ignore `forward`, so clients only offer the badge when negotiated.
// user-brb: USER_UPDATE_BRB and UserSummary.brb, the "Volto já" status. Older servers drop the auth flag and are never
// sent the update, and peers without it never receive the field, so they keep seeing the person as online.
// custom-status: USER_UPDATE_CUSTOM_STATUS and UserSummary.customStatus, the person's own status, negotiated the same way.
export const MIN_CLIENT_PROTOCOL = 35;
export const MIN_BOT_PROTOCOL = 24;
export const PROTOCOL_FEATURES = ['chat-blocks', 'message-length-setting', 'chat-delivery', 'message-delete-undo', 'screen-viewers', 'server-community', 'message-search', 'forums', 'native-polls', 'native-live-forms', 'recent-sounds', 'dm-relay', 'role-deny', 'role-grants', 'game-activity', 'game-share-request', 'channel-tree-order', 'poll-voters', 'poll-edit', 'local-youtube-playlist', 'server-audit', 'bot-manifest-url', 'screen-shares-8', 'voice-user-limit', 'afk-channel', 'bot-storage', 'message-forward', 'user-brb', 'custom-status'] as const;
export type ProtocolFeature = typeof PROTOCOL_FEATURES[number];
/**
 * What a bot is offered, listed rather than subtracted: a new feature is only
 * for people until someone decides a bot needs it too.
 */
export const BOT_PROTOCOL_FEATURES = [
  'message-length-setting', 'server-community', 'local-youtube-playlist', 'bot-storage',
] as const satisfies readonly ProtocolFeature[];
export const protocolOfferSchema = z.object({
  minimumVersion: z.number().int().positive(),
  features: z.array(z.string().min(1).max(80)).max(64),
});
export interface ProtocolOffer { minimumVersion: number; features: string[] }
export interface ProtocolAgreement extends ProtocolOffer { version: number }
export function createProtocolOffer(kind: 'client' | 'bot'): ProtocolOffer {
  return kind === 'bot'
    ? { minimumVersion: MIN_BOT_PROTOCOL, features: [...BOT_PROTOCOL_FEATURES] }
    : { minimumVersion: MIN_CLIENT_PROTOCOL, features: [...PROTOCOL_FEATURES] };
}
export function negotiateProtocol(version: unknown, offer: unknown, kind: 'client' | 'bot'): ProtocolAgreement | null {
  const minimumVersion = kind === 'bot' ? MIN_BOT_PROTOCOL : MIN_CLIENT_PROTOCOL;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < minimumVersion) return null;
  const parsed = offer === undefined ? undefined : protocolOfferSchema.safeParse(offer);
  if (parsed && (!parsed.success || parsed.data.minimumVersion > PROTOCOL_VERSION || parsed.data.minimumVersion > version)) return null;
  if (version > PROTOCOL_VERSION && !parsed?.success) return null;
  const offered: readonly string[] = parsed?.success ? parsed.data.features : version === PROTOCOL_VERSION ? PROTOCOL_FEATURES : [];
  return { version: PROTOCOL_VERSION, minimumVersion,
    features: createProtocolOffer(kind).features.filter(feature => offered.includes(feature)) };
}
export function legacyProtocolFallback(version: unknown, kind: 'client' | 'bot'): number | null {
  const minimum = kind === 'bot' ? MIN_BOT_PROTOCOL : MIN_CLIENT_PROTOCOL;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= minimum && version < PROTOCOL_VERSION
    ? version : null;
}
