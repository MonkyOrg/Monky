import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, sign,
  verify,
} from 'crypto';
import fs from 'fs';
import path from 'path';
import { installDmCrypto, type DmCryptoBackend, type DmFileStore, type DmService } from '@monky/dm';
import { fileErrorCode, renameFileSync, writeFileAtomicSync } from '../atomicFile';

/**
 * The desktop side of the shared DM engine (#858): Node's crypto, and the
 * encrypted store as files in the profile folder, written atomically.
 */

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const bytes = (data: Buffer): Uint8Array => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

function ed25519Private(seed: Uint8Array) {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function x25519Private(privateKey: Uint8Array) {
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]), format: 'der', type: 'pkcs8' });
}

function rawPublicKey(privateKey: ReturnType<typeof createPrivateKey>, prefixLength: number): Uint8Array {
  return bytes(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(prefixLength));
}

export const nodeDmCrypto: DmCryptoBackend = {
  randomBytes: (length) => bytes(randomBytes(length)),
  sha256() {
    const hash = createHash('sha256');
    const wrapper = {
      update(data: Uint8Array) {
        hash.update(data);
        return wrapper;
      },
      digest: () => bytes(hash.digest()),
    };
    return wrapper;
  },
  hkdf32: (input, salt, info) => new Uint8Array(hkdfSync('sha256', input, salt, info, 32)),
  ed25519PublicKey: (seed) => rawPublicKey(ed25519Private(seed), ED25519_SPKI_PREFIX.length),
  ed25519Sign: (seed, message) => bytes(sign(null, message, ed25519Private(seed))),
  ed25519Verify(publicKey, message, signature) {
    try {
      const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
      return verify(null, message, key, signature);
    } catch {
      return false;
    }
  },
  x25519PublicKey: (privateKey) => rawPublicKey(x25519Private(privateKey), X25519_SPKI_PREFIX.length),
  x25519SharedSecret: (privateKey, publicKey) => bytes(diffieHellman({
    privateKey: x25519Private(privateKey),
    publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' }),
  })),
  aesGcmSeal(key, nonce, plaintext, aad) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    return bytes(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  aesGcmSealer(key, nonce, aad) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    return {
      update: (data) => bytes(cipher.update(data)),
      // GCM hands out every byte in update(); final() only closes it, so the tag is all that is left.
      final: () => bytes(Buffer.concat([cipher.final(), cipher.getAuthTag()])),
    };
  },
  aesGcmOpen(key, nonce, sealed, aad) {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plaintext = decipher.update(sealed.subarray(0, sealed.length - 16));
    decipher.final();
    return bytes(plaintext);
  },
};

// Every DM module of the main process uses Node's crypto; installed before any of them runs.
installDmCrypto(nodeDmCrypto);

/** The encrypted DM store of one identity, as files under `dir`. */
export function nodeDmFileStore(dir: string): DmFileStore {
  const filePath = (name: string): string => path.join(dir, ...name.split('/'));
  const ensureParent = (name: string): void => {
    fs.mkdirSync(path.dirname(filePath(name)), { recursive: true });
  };
  return {
    read(name) {
      try {
        return bytes(fs.readFileSync(filePath(name)));
      } catch (error) {
        if (fileErrorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    exists: (name) => fs.existsSync(filePath(name)),
    write(name, data) {
      ensureParent(name);
      writeFileAtomicSync(filePath(name), data);
    },
    remove(name) {
      fs.rmSync(filePath(name), { force: true });
    },
    rename(name, aside) {
      renameFileSync(filePath(name), filePath(aside));
    },
    list(folder) {
      try {
        return fs.readdirSync(filePath(folder));
      } catch (error) {
        if (fileErrorCode(error) === 'ENOENT') return [];
        throw error;
      }
    },
    /** A full disk can tear an append: the torn bytes are cut off again so the next one does not land after garbage. */
    append(name, data) {
      ensureParent(name);
      const target = filePath(name);
      let sizeBefore = 0;
      try {
        sizeBefore = fs.statSync(target).size;
      } catch (error) {
        if (fileErrorCode(error) !== 'ENOENT') throw error;
      }
      try {
        fs.appendFileSync(target, data);
      } catch (error) {
        try {
          fs.truncateSync(target, sizeBefore);
        } catch {
          // repairPart() drops the torn tail before the download resumes.
        }
        throw error;
      }
    },
    size(name) {
      try {
        return fs.statSync(filePath(name)).size;
      } catch (error) {
        if (fileErrorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    truncate(name, length) {
      fs.truncateSync(filePath(name), length);
    },
    openReader(name) {
      let descriptor: number;
      try {
        descriptor = fs.openSync(filePath(name), 'r');
      } catch (error) {
        if (fileErrorCode(error) === 'ENOENT') return null;
        throw error;
      }
      return {
        read(offset, length) {
          const buffer = Buffer.allocUnsafe(length);
          const read = fs.readSync(descriptor, buffer, 0, length, offset);
          return bytes(buffer.subarray(0, read));
        },
        close: () => fs.closeSync(descriptor),
      };
    },
  };
}

/**
 * Decrypts a ready/local attachment into `destination` (absolute path), creating
 * or overwriting it. For main-process features such as batch downloads.
 */
export async function writeDmAttachmentFile(
  service: DmService, peer: string, messageId: string, fileId: string, destination: string,
): Promise<void> {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
    throw new Error('Invalid destination for the DM attachment: an absolute file path is required.');
  }
  const file = service.readAttachment(peer, messageId, fileId);
  await fs.promises.writeFile(destination, file.data);
}