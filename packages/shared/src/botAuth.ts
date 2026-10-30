import { z } from 'zod';
import { botReachabilityNonceSchema } from './botDiagnostics.js';

/** The nonce a server sends a bot in AUTH_CHALLENGE (bot-key-proof). */
export const botAuthNonceSchema = botReachabilityNonceSchema;
export const botAuthSignatureSchema = z.string().regex(/^[0-9a-fA-F]{128}$/);

/**
 * Bytes a bot signs with its Ed25519 identity to prove it holds the private
 * key (bot-key-proof). The prefix keeps the signature from being valid in any
 * other Monky protocol, and the token binds it to the credential this
 * connection presents: a server the same bot also joined cannot relay another
 * server's nonce and replay the answer there, since its token differs.
 */
export function botAuthChallenge(nonce: string, botToken: string): string {
  return `monky-bot-auth:v1:${botAuthNonceSchema.parse(nonce)}:${botToken}`;
}
