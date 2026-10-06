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
// channel-tree-order: categories and loose channels share one root order, sent as one CHANNEL_REORDER with categoryId null.
// poll-voters: polls carry anonymity and voters, votes can be withdrawn; other clients receive the earlier poll shape.
// poll-edit: the creator or a server manager may change an open poll; reset answers receive new ids.
export const MIN_CLIENT_PROTOCOL = 35;
export const MIN_BOT_PROTOCOL = 24;
export const PROTOCOL_FEATURES = ['chat-blocks', 'message-length-setting', 'chat-delivery', 'message-delete-undo', 'screen-viewers', 'server-community', 'message-search', 'forums', 'native-polls', 'native-live-forms', 'recent-sounds', 'dm-relay', 'role-deny', 'role-grants', 'game-activity', 'channel-tree-order', 'poll-voters', 'poll-edit'] as const;
export type ProtocolFeature = typeof PROTOCOL_FEATURES[number];
export const protocolOfferSchema = z.object({
  minimumVersion: z.number().int().positive(),
  features: z.array(z.string().min(1).max(80)).max(64),
});
export interface ProtocolOffer { minimumVersion: number; features: string[] }
export interface ProtocolAgreement extends ProtocolOffer { version: number }
export function createProtocolOffer(kind: 'client' | 'bot'): ProtocolOffer {
  return { minimumVersion: kind === 'bot' ? MIN_BOT_PROTOCOL : MIN_CLIENT_PROTOCOL,
    features: PROTOCOL_FEATURES.filter(feature => kind !== 'bot' || (feature !== 'chat-blocks' &&
      feature !== 'chat-delivery' && feature !== 'message-delete-undo' && feature !== 'screen-viewers' &&
      feature !== 'message-search' && feature !== 'forums' && feature !== 'native-polls' &&
      feature !== 'native-live-forms' && feature !== 'recent-sounds' && feature !== 'dm-relay' &&
      feature !== 'role-deny' && feature !== 'role-grants' && feature !== 'game-activity' &&
      feature !== 'channel-tree-order' && feature !== 'poll-voters' && feature !== 'poll-edit')) };
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
