import { generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { AUTO_TLS_VALIDATION_PORT } from '../autoTls';
import { AcmeClient } from './AcmeClient';
import type { AcmeChallenges } from './AcmeChallenges';
import { AutoTlsFailure, type CertificateIssuer, type IssuedCertificate } from './errors';
import type { CertificateStore } from './CertificateStore';
import { createIpCsr } from './Csr';

export const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
/** IP certificates must use it: about 6 days of validity. */
const SHORT_LIVED_PROFILE = 'shortlived';

/**
 * Test CAs only, such as Pebble: `MONKY_ACME_DIRECTORY` replaces Let's
 * Encrypt (staging included), `MONKY_ACME_HTTP_PORT` the validation port and
 * `MONKY_ACME_PUBLIC_IP` the discovered address. Never set in production.
 */
export function acmeTestOverrides(env: NodeJS.ProcessEnv = process.env): {
  directoryOverride: string | null; validationPort: number | undefined; publicIp: string | null;
} {
  const port = Number(env.MONKY_ACME_HTTP_PORT);
  return {
    directoryOverride: env.MONKY_ACME_DIRECTORY || null,
    validationPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
    publicIp: env.MONKY_ACME_PUBLIC_IP || null,
  };
}

export interface LetsEncryptIssuerOptions {
  store: CertificateStore;
  challenges: AcmeChallenges;
  /** The server's own port: when it is the validation port, it already answers the challenge. Bots omit it. */
  serverPort?: number;
  /**
   * Test servers such as Pebble (`MONKY_ACME_DIRECTORY`). Used for the
   * precheck as well, so a test never reaches Let's Encrypt.
   */
  directoryOverride?: string | null;
  /** Port the CA validates on; only a test CA uses another one (`MONKY_ACME_HTTP_PORT`). */
  validationPort?: number;
}

/**
 * Let's Encrypt for one IP address (#860). The precheck is a real issuance
 * against staging, so it proves from the CA's own vantage points that port 80
 * is reachable, without spending production rate limits.
 */
export class LetsEncryptIssuer implements CertificateIssuer {
  constructor(private readonly options: LetsEncryptIssuerOptions) {}

  public async precheck(ip: string, signal: AbortSignal): Promise<void> {
    await this.obtain(this.options.directoryOverride || LETS_ENCRYPT_STAGING, ip, signal);
  }

  public issue(ip: string, signal: AbortSignal): Promise<IssuedCertificate> {
    return this.obtain(this.options.directoryOverride || LETS_ENCRYPT_PRODUCTION, ip, signal);
  }

  private async obtain(directoryUrl: string, ip: string, signal: AbortSignal): Promise<IssuedCertificate> {
    const port = this.options.validationPort ?? AUTO_TLS_VALIDATION_PORT;
    const close = port === this.options.serverPort ? null : await this.options.challenges.openPort(port);
    try {
      const client = new AcmeClient({ directoryUrl, accountKey: this.accountKey(directoryUrl), signal });
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const certificatePem = await client.obtainIpCertificate({
        ip,
        profile: SHORT_LIVED_PROFILE,
        csr: createIpCsr(ip, privateKey, publicKey),
        challenges: this.options.challenges,
      });
      return { certificatePem, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    } finally {
      await close?.();
    }
  }

  /** One account key per CA, created on first use and kept with the certificate. */
  private accountKey(directoryUrl: string): KeyObject {
    const saved = this.options.store.readJson('accounts.json');
    const accounts: Record<string, string> = {};
    if (saved && typeof saved === 'object') {
      for (const [url, pem] of Object.entries(saved)) if (typeof pem === 'string') accounts[url] = pem;
    }
    const existing = accounts[directoryUrl];
    if (existing) {
      try {
        const key = createPrivateKey(existing);
        createPublicKey(key);
        return key;
      } catch {
        // A damaged key is replaced; the CA simply sees a new account.
      }
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    accounts[directoryUrl] = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    try {
      this.options.store.writeJson('accounts.json', accounts);
    } catch (error) {
      throw new AutoTlsFailure('storage', error instanceof Error ? error.message : String(error));
    }
    return privateKey;
  }
}
