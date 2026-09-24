import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants.js';

// Raise the affected floor for security or wire-breaking changes; additive
// features only raise PROTOCOL_VERSION and are negotiated independently.
// Native 4K/80 Mbps renditions require the new bounds and H.264 negotiation;
// both incompatible published protocol-25 client contracts must be rejected.
export const MIN_CLIENT_PROTOCOL = 26;
export const MIN_BOT_PROTOCOL = 24;
export const PROTOCOL_FEATURES = ['chat-blocks', 'message-length-setting', 'chat-delivery'] as const;
export type ProtocolFeature = typeof PROTOCOL_FEATURES[number];
export const protocolOfferSchema = z.object({
  minimumVersion: z.number().int().positive(),
  features: z.array(z.string().min(1).max(80)).max(64),
});
export interface ProtocolOffer { minimumVersion: number; features: string[] }
export interface ProtocolAgreement extends ProtocolOffer { version: number }
export function createProtocolOffer(kind: 'client' | 'bot'): ProtocolOffer {
  return { minimumVersion: kind === 'bot' ? MIN_BOT_PROTOCOL : MIN_CLIENT_PROTOCOL,
    features: PROTOCOL_FEATURES.filter(feature => kind !== 'bot' || (feature !== 'chat-blocks' && feature !== 'chat-delivery')) };
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
