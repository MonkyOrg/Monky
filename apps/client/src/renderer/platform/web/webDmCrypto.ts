import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, type DmCryptoBackend } from '@monky/dm';

/**
 * The browser side of the shared DM engine's crypto (#858). WebCrypto is
 * asynchronous and the engine is not, so the same primitives come from the
 * audited, dependency-free @noble libraries. They produce the very bytes
 * Node's crypto does on the desktop: envelopes and stores open on either.
 */
export const webDmCrypto: DmCryptoBackend = {
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  sha256() {
    const hash = sha256.create();
    const wrapper = {
      update(data: Uint8Array) {
        hash.update(data);
        return wrapper;
      },
      digest: () => hash.digest(),
    };
    return wrapper;
  },
  hkdf32: (input, salt, info) => hkdf(sha256, input, salt, info, 32),
  ed25519PublicKey: (seed) => ed25519.getPublicKey(seed),
  ed25519Sign: (seed, message) => ed25519.sign(message, seed),
  ed25519Verify(publicKey, message, signature) {
    try {
      // Strict RFC 8032 checks, as OpenSSL does on the desktop.
      return ed25519.verify(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  },
  x25519PublicKey: (privateKey) => x25519.getPublicKey(privateKey),
  x25519SharedSecret: (privateKey, publicKey) => x25519.getSharedSecret(privateKey, publicKey),
  aesGcmSeal: (key, nonce, plaintext, aad) => gcm(key, nonce, aad).encrypt(plaintext),
  // GCM here seals in one go: the pieces are gathered, and the sealed bytes come out at the end.
  aesGcmSealer(key, nonce, aad) {
    const pieces: Uint8Array[] = [];
    return {
      update(data) {
        pieces.push(data.slice());
        return new Uint8Array(0);
      },
      final: () => gcm(key, nonce, aad).encrypt(concatBytes(...pieces)),
    };
  },
  aesGcmOpen: (key, nonce, sealed, aad) => gcm(key, nonce, aad).decrypt(sealed),
};
