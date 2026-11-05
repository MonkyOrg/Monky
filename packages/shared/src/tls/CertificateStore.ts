import { X509Certificate, createPrivateKey, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAutoTlsErrorCode, type AutoTlsError } from '../autoTls';

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

/** Where every server and bot of this machine keeps the one certificate they share. */
export function sharedTlsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.MONKY_TLS_DIR ? path.resolve(env.MONKY_TLS_DIR) : path.join(os.homedir(), '.monky', 'tls');
}

export function writeAtomically(file: string, contents: string): void {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pending, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(pending, file);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
}

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

/** Forgets the certificate a server kept in its own folder; the shared one stays for the others. */
export function removeLegacyCertificate(legacyDirectory: string): void {
  fs.rmSync(path.join(legacyDirectory, 'certificate.json'), { force: true });
}

class JsonDirectory {
  constructor(public readonly directory: string) {}

  public file(name: string): string {
    return path.join(this.directory, name);
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

function parseCertificate(value: unknown): StoredCertificate | null {
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

/**
 * The certificate of this machine, shared by all servers and bots on it. The
 * certificate and its key share one file written atomically, so a crash never
 * leaves a new certificate beside an old key, and the previous pair stays in
 * place until the new one is fully on disk.
 */
export class CertificateStore extends JsonDirectory {
  constructor(directory: string = sharedTlsDirectory()) {
    super(directory);
  }

  /** The saved certificate, or null when there is none or it no longer makes sense. */
  public readCertificate(): StoredCertificate | null {
    return parseCertificate(this.readJson('certificate.json'));
  }

  /** Changes whenever another process replaces the certificate; cheap enough to poll. */
  public certificateStamp(): string | null {
    try {
      const stat = fs.statSync(this.file('certificate.json'));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  /** A certificate for `ip` that has not expired, if the shared store holds one. */
  public findUsable(ip: string, now = Date.now()): StoredCertificate | null {
    const certificate = this.readCertificate();
    return certificate && certificate.ip === ip && now < certificate.notAfter ? certificate : null;
  }

  public writeCertificate(certificate: StoredCertificate): void {
    this.writeJson('certificate.json', {
      ip: certificate.ip,
      certificatePem: certificate.certificatePem,
      privateKeyPem: certificate.privateKeyPem,
    });
  }

  /**
   * Copies the certificate a server kept in its own data folder before
   * sharing existed, unless the shared store already has a certificate in use.
   */
  public adoptLegacy(legacyDirectory: string, now = Date.now()): boolean {
    const shared = this.readCertificate();
    if (shared && now < shared.notAfter) return false;
    const legacyFiles = new JsonDirectory(legacyDirectory);
    const legacy = parseCertificate(legacyFiles.readJson('certificate.json'));
    if (!legacy || now >= legacy.notAfter) return false;
    this.writeCertificate(legacy);
    const accounts = legacyFiles.readJson('accounts.json');
    if (!this.readJson('accounts.json') && accounts && typeof accounts === 'object') this.writeJson('accounts.json', accounts);
    return true;
  }
}

/** One server's or bot's own choice to use the shared certificate. */
export class TlsSettingsStore extends JsonDirectory {
  public read(): AutoTlsSettings {
    const value = this.readJson('settings.json');
    if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
    const enabled = 'enabled' in value && value.enabled === true;
    const lastError = 'lastError' in value ? parseError(value.lastError) : null;
    return { enabled, lastError };
  }

  public write(settings: AutoTlsSettings): void {
    this.writeJson('settings.json', settings);
  }
}

function parseError(value: unknown): AutoTlsError | null {
  if (!value || typeof value !== 'object') return null;
  if (!('code' in value) || !isAutoTlsErrorCode(value.code)) return null;
  if (!('at' in value) || typeof value.at !== 'number') return null;
  const detail = 'detail' in value && typeof value.detail === 'string' ? value.detail : null;
  return { code: value.code, detail, at: value.at };
}
