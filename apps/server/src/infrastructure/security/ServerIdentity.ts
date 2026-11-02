import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { serverAuthChallenge, serverPublicKeySchema } from '@monky/shared';
import type { IServerIdentityRepository } from '../../domain/repositories';

/**
 * The server's Ed25519 identity (server-key-auth, #821). Members' apps pin its
 * public key and bind their sign-in signature to it, so the key must outlive
 * restarts: it lives in the database, created on the first start that lacks one.
 */
export class ServerIdentity {
  private constructor(private readonly privateKey: KeyObject, readonly publicKey: string) {}

  /** Reads the stored identity, creating it the first time; the caller persists the database before serving. */
  static async load(repository: IServerIdentityRepository): Promise<ServerIdentity> {
    let stored = await repository.getIdentityKey();
    if (!stored) {
      const generated = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
      stored = await repository.createIdentityKey(generated, Date.now());
    }
    const privateKey = createPrivateKey({ key: Buffer.from(stored, 'hex'), format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The stored server identity is not an Ed25519 key.');
    const publicKey = serverPublicKeySchema.parse(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('hex'));
    return new ServerIdentity(privateKey, publicKey);
  }

  /** This server's signature of a challenge it issued, proving it holds the key it presents. */
  signChallenge(nonce: string): string {
    return sign(null, Buffer.from(serverAuthChallenge(nonce, this.publicKey), 'utf8'), this.privateKey).toString('hex');
  }
}
