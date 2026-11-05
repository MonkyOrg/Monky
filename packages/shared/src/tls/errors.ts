import type { AutoTlsErrorCode } from '../autoTls';

/** A failure each surface can explain by its code; `detail` only goes to logs. */
export class AutoTlsFailure extends Error {
  constructor(public readonly code: AutoTlsErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'AutoTlsFailure';
  }
}

export interface IssuedCertificate {
  certificatePem: string;
  privateKeyPem: string;
}

/** Talks to the CA. Every failure is an `AutoTlsFailure`. */
export interface CertificateIssuer {
  /** Proves the CA can reach this host on `ip` without keeping a certificate. */
  precheck(ip: string, signal: AbortSignal): Promise<void>;
  issue(ip: string, signal: AbortSignal): Promise<IssuedCertificate>;
}

export interface TlsLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export const SILENT_TLS_LOGGER: TlsLogger = { info() {}, warn() {}, error() {} };
