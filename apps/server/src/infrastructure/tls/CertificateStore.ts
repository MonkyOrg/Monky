import { X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isAutoTlsErrorCode, type AutoTlsError } from '@monky/shared';
import { writeAtomically } from '../lifecycle/serverLock';

export interface StoredCertificate {
  ip: string;
  /** Leaf first, then the intermediates, as the CA delivered the chain. */
  certificatePem: string;
  privateKeyPem: string;
  notAfter: number;
}

export interface AutoTlsSettings {
  enabled: boolean;
  lastError: AutoTlsError | null;
}

const DEFAULT_SETTINGS: AutoTlsSettings = { enabled: false, lastError: null };

/**
 * Reads the leaf's expiry and refuses a pair that does not belong together or
 * does not cover `ip`: installing it would break every `wss://` connection.
 */
export function inspectCertificate(ip: string, certificatePem: string, privateKeyPem: string): StoredCertificate {
  const leaf = new X509Certificate(certificatePem);
  if (!leaf.checkPrivateKey(createPrivateKey(privateKeyPem))) throw new Error('The certificate does not match its private key.');
  if (leaf.checkIP(ip) === undefined) throw new Error(`The certificate does not cover ${ip}.`);
  const notAfter = Date.parse(leaf.validTo);
  if (!Number.isFinite(notAfter)) throw new Error('The certificate expiry could not be read.');
  return { ip, certificatePem, privateKeyPem, notAfter };
}

/**
 * Everything automatic TLS keeps under `<dataDir>/tls`. The certificate and
 * its key share one file written atomically, so a crash never leaves a new
 * certificate beside an old key, and the previous pair stays in place until
 * the new one is fully on disk.
 */
export class CertificateStore {
  public readonly directory: string;

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'tls');
  }

  public file(name: string): string {
    return path.join(this.directory, name);
  }

  public readSettings(): AutoTlsSettings {
    const value = this.readJson('settings.json');
    if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
    const enabled = 'enabled' in value && value.enabled === true;
    const lastError = 'lastError' in value ? parseError(value.lastError) : null;
    return { enabled, lastError };
  }

  public writeSettings(settings: AutoTlsSettings): void {
    this.writeJson('settings.json', settings);
  }

  /** The saved certificate, or null when there is none or it no longer makes sense. */
  public readCertificate(): StoredCertificate | null {
    const value = this.readJson('certificate.json');
    if (!value || typeof value !== 'object') return null;
    if (!('ip' in value) || typeof value.ip !== 'string') return null;
    if (!('certificatePem' in value) || typeof value.certificatePem !== 'string') return null;
    if (!('privateKeyPem' in value) || typeof value.privateKeyPem !== 'string') return null;
    try {
      return inspectCertificate(value.ip, value.certificatePem, value.privateKeyPem);
    } catch {
      return null;
    }
  }

  public writeCertificate(certificate: StoredCertificate): void {
    this.writeJson('certificate.json', {
      ip: certificate.ip,
      certificatePem: certificate.certificatePem,
      privateKeyPem: certificate.privateKeyPem,
    });
  }

  public readJson(name: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch {
      return null;
    }
  }

  public writeJson(name: string, value: unknown): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeAtomically(this.file(name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

function parseError(value: unknown): AutoTlsError | null {
  if (!value || typeof value !== 'object') return null;
  if (!('code' in value) || !isAutoTlsErrorCode(value.code)) return null;
  if (!('at' in value) || typeof value.at !== 'number') return null;
  const detail = 'detail' in value && typeof value.detail === 'string' ? value.detail : null;
  return { code: value.code, detail, at: value.at };
}
