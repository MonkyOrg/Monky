import { z } from 'zod';
import { ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX } from './constants.js';
import { protocolOfferSchema } from './protocolCompatibility.js';

/**
 * server-key-auth (#821): a person's sign-in signature names the server it is
 * meant for. Each server holds an Ed25519 identity, presents its public key in
 * AUTH_CHALLENGE and signs the nonce with it; the app pins that key per saved
 * server (on the first protected login, or from an invitation that carries it)
 * and signs memberAuthChallenge(), never the bare nonce. A server that relays
 * another server's challenge then gets a signature bound to its own key, which
 * the other server rejects.
 */
export const SERVER_KEY_AUTH_FEATURE = 'server-key-auth';

const nonceSchema = z.string().regex(/^[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase());
const signatureSchema = z.string().regex(/^[0-9a-fA-F]{128}$/).transform(value => value.toLowerCase());
const agreementSchema = protocolOfferSchema.extend({ version: z.number().int().positive() });

/** A server's identity: an Ed25519 public key as SPKI DER, in lowercase hexadecimal. */
export const serverPublicKeySchema = z.string()
  .regex(new RegExp(`^${ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX}[0-9a-f]{64}$`, 'i'))
  .transform(value => value.toLowerCase());

/** AUTH_CHALLENGE: the bare nonce from servers that never present a key, all three fields otherwise. */
export const authChallengeSchema = z.union([
  z.object({ nonce: nonceSchema, serverKey: serverPublicKeySchema, serverSignature: signatureSchema, protocol: agreementSchema.optional() }).strict(),
  z.object({ nonce: nonceSchema, protocol: agreementSchema.optional() }).strict(),
]);
export type AuthChallenge = z.infer<typeof authChallengeSchema>;

/** What the app hands the signer: a challenge, and the key it pinned when the server presented one. */
export interface ServerChallengeBinding {
  serverKey: string;
  serverSignature: string;
}
export const serverChallengeBindingSchema = z.object({
  serverKey: serverPublicKeySchema,
  serverSignature: signatureSchema,
}).strict();

/** Bytes the server signs with its identity, proving it holds the key it presents. */
export function serverAuthChallenge(nonce: string, serverKey: string): string {
  return `monky-server-auth:v1:${serverPublicKeySchema.parse(serverKey)}:${nonceSchema.parse(nonce)}`;
}

/**
 * Bytes a person signs to sign in to the server whose key is `serverKey`. The
 * prefix differs from every other Monky signature, and the key binds it to
 * that one server.
 */
export function memberAuthChallenge(nonce: string, serverKey: string): string {
  return `monky-auth:v2:${serverPublicKeySchema.parse(serverKey)}:${nonceSchema.parse(nonce)}`;
}

/** Outcome of `identity:sign-challenge`: a refused server proof is not an app failure. */
export type SignChallengeResult = { signature: string } | { refused: 'server-signature' };

export type ServerKeyRefusal = 'key-changed' | 'key-missing' | 'key-of-other-server';

/** What the app knows about the key of the server at the address it dialled. */
export interface ServerKeyExpectation {
  /** Pinned for this address: on its first protected login, by an invitation, or by "Add address". */
  pinned?: string;
  /** Brought by the invitation being accepted for this address. */
  invited?: string;
}

/**
 * Whether the app may answer a challenge for the server at this address.
 * `bind` signs memberAuthChallenge(); `legacy` signs the bare nonce, only for a
 * server that never presented a key, so a server once seen with a key can never
 * be downgraded. `pinnedElsewhere` tells whether another saved address pinned a key.
 */
export type ServerKeyDecision =
  | { kind: 'bind'; serverKey: string }
  | { kind: 'legacy' }
  | { kind: 'refuse'; reason: ServerKeyRefusal };

export function decideServerKey(challenge: AuthChallenge, expectation: ServerKeyExpectation,
  pinnedElsewhere: (serverKey: string) => boolean): ServerKeyDecision {
  const { pinned } = expectation;
  // An invitation repeating the pinned key is no different from the pin.
  const invited = expectation.invited !== pinned ? expectation.invited : undefined;
  if (!('serverKey' in challenge)) return pinned || invited ? { kind: 'refuse', reason: 'key-missing' } : { kind: 'legacy' };
  const serverKey = challenge.serverKey;
  const expected = invited ?? pinned;
  if (expected && expected !== serverKey) return { kind: 'refuse', reason: 'key-changed' };
  // A key reaching an address for the first time, by sign-in or invitation, may
  // be another saved server's, presented by a server relaying its challenge.
  // A second address of the same server is only added from that server's entry.
  if ((invited || !pinned) && pinnedElsewhere(serverKey)) return { kind: 'refuse', reason: 'key-of-other-server' };
  return { kind: 'bind', serverKey };
}
