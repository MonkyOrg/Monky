import { z } from 'zod';
import { protocolOfferSchema } from './protocolCompatibility.js';

/**
 * Pre-authentication bot diagnostics (protocol 37). The bot runtime CLI asks a
 * Monky server to validate its credential and to reach the bot's own public
 * ports from outside. Nothing here creates a session or binds a key.
 */
export const BOT_REACHABILITY_PATH = '/.well-known/monky-bot-reachability';
export const BOT_REACHABILITY_MAX_TARGETS = 8;
export const BOT_REACHABILITY_MAX_RESPONSE_BYTES = 1024;

export const botReachabilityNonceSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const botReachabilityProofSchema = z.object({
  signature: z.string().regex(/^[0-9a-f]{128}$/),
}).strict();
export type BotReachabilityProof = z.infer<typeof botReachabilityProofSchema>;

/**
 * Bytes signed by the bot's Ed25519 identity. The fixed prefix keeps these
 * signatures from ever being valid in another protocol.
 */
export function botReachabilityChallenge(nonce: string): string {
  return `monky-bot-reachability:v1:${botReachabilityNonceSchema.parse(nonce)}`;
}

/** Only an http(s) origin is accepted: no credentials, path, query or fragment. */
export function normalizeBotReachabilityOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || value.replace(/\/$/, '').toLowerCase() !== url.origin.toLowerCase()) {
    return null;
  }
  return url.origin;
}

export const botReachabilityTargetIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const botReachabilityTargetSchema = z.object({
  id: botReachabilityTargetIdSchema,
  origin: z.string().max(2048).refine((value) => normalizeBotReachabilityOrigin(value) !== null),
});

export const botDiagnosticRequestSchema = z.object({
  protocolVersion: z.number().int().positive(),
  protocolOffer: protocolOfferSchema.optional(),
  botToken: z.string().min(1).max(128),
  publicKey: z.string().min(64).max(128).regex(/^[a-fA-F0-9]+$/),
  targets: z.array(botReachabilityTargetSchema).max(BOT_REACHABILITY_MAX_TARGETS),
}).refine((request) => new Set(request.targets.map((target) => target.id)).size === request.targets.length, {
  message: 'Reachability target ids must be unique.', path: ['targets'],
});
export type BotDiagnosticRequest = z.infer<typeof botDiagnosticRequestSchema>;

export const BOT_DIAGNOSTIC_CREDENTIALS = ['valid', 'pending_binding', 'invalid', 'key_mismatch'] as const;
export type BotDiagnosticCredential = typeof BOT_DIAGNOSTIC_CREDENTIALS[number];
export const BOT_REACHABILITY_STATUSES = ['verified', 'unverified', 'skipped'] as const;
export type BotReachabilityStatus = typeof BOT_REACHABILITY_STATUSES[number];
/**
 * Reasons describe the request, never the target: a closed, filtered or
 * foreign port is always just `unverified`.
 */
export const BOT_REACHABILITY_SKIP_REASONS = [
  'address_not_allowed', 'port_not_allowed', 'rate_limited', 'busy', 'credential',
] as const;
export type BotReachabilitySkipReason = typeof BOT_REACHABILITY_SKIP_REASONS[number];

export const botReachabilityResultSchema = z.object({
  id: botReachabilityTargetIdSchema,
  status: z.enum(BOT_REACHABILITY_STATUSES),
  reason: z.enum(BOT_REACHABILITY_SKIP_REASONS).optional(),
});
export type BotReachabilityResult = z.infer<typeof botReachabilityResultSchema>;

export const botDiagnosticResultSchema = z.object({
  serverProtocolVersion: z.number().int().positive(),
  protocol: z.object({
    version: z.number().int().positive(),
    minimumVersion: z.number().int().positive(),
    features: z.array(z.string().min(1).max(80)).max(64),
  }).nullable(),
  credential: z.enum(BOT_DIAGNOSTIC_CREDENTIALS),
  serverName: z.string().min(1).max(200).optional(),
  reachability: z.array(botReachabilityResultSchema).max(BOT_REACHABILITY_MAX_TARGETS),
});
export type BotDiagnosticResult = z.infer<typeof botDiagnosticResultSchema>;
