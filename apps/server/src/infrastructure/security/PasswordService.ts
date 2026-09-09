import crypto from 'crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

export class PasswordService {
  /**
   * Hashes a plain password using scrypt with a unique salt
   */
  public static hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  /**
   * Validates a candidate password against the stored salt:hash.
   *
   * Derivation is asynchronous on purpose: scrypt with these parameters costs
   * tens of milliseconds, and the synchronous version ran on the connection
   * path, where an unauthenticated client could freeze voice, chat and
   * signaling for everyone just by retrying (#372).
   */
  public static async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!storedHash || !storedHash.includes(':')) {
      return false;
    }
    const [salt, key] = storedHash.split(':');
    const keyBuffer = Buffer.from(key, 'hex');
    // A truncated or corrupt hash used to reach timingSafeEqual with mismatched
    // lengths, which throws instead of answering "wrong password" (#372).
    if (keyBuffer.length !== KEY_LENGTH) {
      return false;
    }

    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  }
}
