import fs from 'node:fs';
import tls from 'node:tls';
import type { AutoTlsErrorCode, AutoTlsStatus } from '@monky/shared';
import { Logger } from '../logger/Logger';
import { isPublicUnicastAddress } from '../network/ReachabilityProber';
import { CertificateStore, inspectCertificate, type AutoTlsSettings, type StoredCertificate } from './CertificateStore';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

export interface AutoTlsServiceOptions {
  store: CertificateStore;
  issuer: CertificateIssuer;
  publicIp: () => Promise<string | null>;
  /** Installs the context new connections use; `null` leaves only `ws://`. */
  install: (context: tls.SecureContext | null) => void;
  /** A test CA validates on loopback or a LAN; Let's Encrypt only ever reaches public addresses. */
  allowNonPublicAddress?: boolean;
  /** Lifts the system's restriction on the validation port; called only with the owner's consent. */
  grantPortPermission?: () => Promise<void>;
}

export interface AutoTlsEnableOptions {
  /** The owner agreed to let the server lift the port restriction itself (`sudo -n`). */
  grantPortPermission?: boolean;
}

/**
 * Keeps a certificate for the server's public IP (#860): issues it when the
 * owner turns the feature on, renews it ahead of expiry, issues a new one when
 * the IP changes, and swaps it in for new connections without touching the
 * open ones. While it cannot, the server keeps serving `ws://` and the last
 * error is kept for the owner.
 */
export class AutoTlsService {
  /** Let's Encrypt `shortlived` certificates last about 6 days; renewal starts with 2 to spare. */
  static RENEW_BEFORE_MS = 2 * DAY;
  static IP_CHECK_INTERVAL_MS = HOUR;
  static RETRY_DELAYS_MS: readonly number[] = [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR];

  private settings: AutoTlsSettings;
  private certificate: StoredCertificate | null;
  private installed = false;
  private busy = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(status: AutoTlsStatus) => void>();

  constructor(private readonly options: AutoTlsServiceOptions) {
    this.settings = options.store.readSettings();
    this.certificate = this.settings.enabled ? options.store.readCertificate() : null;
  }

  /** Installs a saved certificate that is still valid, then checks it in the background. */
  public start(): void {
    if (!this.restore()) return;
    this.schedule(0);
  }

  /** Installs a saved certificate that is still valid, without checking anything; false when the feature is off. */
  public restore(): boolean {
    if (!this.settings.enabled || this.abort.signal.aborted) return false;
    const certificate = this.certificate;
    if (certificate && Date.now() < certificate.notAfter) this.installCertificate(certificate);
    return true;
  }

  public status(): AutoTlsStatus {
    const certificate = this.installed ? this.certificate : null;
    return {
      enabled: this.settings.enabled,
      active: certificate !== null,
      busy: this.busy,
      ip: certificate?.ip ?? null,
      validUntil: certificate?.notAfter ?? null,
      nextRenewalAt: certificate ? AutoTlsService.renewalTime(certificate) : null,
      lastError: this.settings.lastError,
    };
  }

  /** Address new `wss://` connections are valid for, if any. */
  public secureAddress(): string | null {
    return this.installed ? this.certificate?.ip ?? null : null;
  }

  public subscribe(listener: (status: AutoTlsStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Turns the feature on only after the CA proved it can reach this host and
   * a certificate was issued. A failure rejects with an `AutoTlsFailure` and
   * leaves the feature off. `port-permission` may be retried with the owner's
   * consent to `grantPortPermission`.
   */
  public enable(options: AutoTlsEnableOptions = {}): Promise<AutoTlsStatus> {
    return this.exclusive(async () => {
      const signal = this.abort.signal;
      const ip = await this.resolveIp();
      try {
        await this.options.issuer.precheck(ip, signal);
      } catch (error) {
        const grant = this.options.grantPortPermission;
        if (!(error instanceof AutoTlsFailure) || error.code !== 'port-permission' || !options.grantPortPermission || !grant) throw error;
        await grant();
        await this.options.issuer.precheck(ip, signal);
      }
      const issued = await this.options.issuer.issue(ip, signal);
      this.throwIfDisposed();
      this.adopt(ip, issued);
      this.saveSettings({ enabled: true, lastError: null });
      this.failures = 0;
      Logger.info('NETWORK', `Automatic TLS enabled for ${ip}.`);
      this.scheduleNext();
    }).then(() => this.status());
  }

  public disable(): Promise<AutoTlsStatus> {
    return this.exclusive(async () => {
      this.cancelTimer();
      this.saveSettings({ enabled: false, lastError: null });
      this.uninstall();
      this.certificate = null;
      this.failures = 0;
      fs.rmSync(this.options.store.file('certificate.json'), { force: true });
      Logger.info('NETWORK', 'Automatic TLS disabled; the server accepts ws:// only.');
    }).then(() => this.status());
  }

  /** Idempotent: stops the timer and abandons work in flight. */
  public dispose(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.cancelTimer();
    this.listeners.clear();
  }

  private static renewalTime(certificate: StoredCertificate): number {
    return certificate.notAfter - AutoTlsService.RENEW_BEFORE_MS;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.throwIfDisposed();
      this.busy = true;
      this.notify();
      try {
        return await work();
      } finally {
        this.busy = false;
        this.notify();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private throwIfDisposed(): void {
    if (this.abort.signal.aborted) throw new AutoTlsFailure('network', 'The server is stopping.');
  }

  private async resolveIp(): Promise<string> {
    const ip = await this.options.publicIp();
    if (!ip) throw new AutoTlsFailure('no-public-ip');
    if (!this.options.allowNonPublicAddress && !isPublicUnicastAddress(ip)) throw new AutoTlsFailure('address-not-public', ip);
    return ip;
  }

  /** Saves the new pair before it replaces the one in use. */
  private adopt(ip: string, issued: IssuedCertificate): void {
    let certificate: StoredCertificate;
    try {
      certificate = inspectCertificate(ip, issued.certificatePem, issued.privateKeyPem);
      this.options.store.writeCertificate(certificate);
    } catch (error) {
      throw new AutoTlsFailure('storage', error instanceof Error ? error.message : String(error));
    }
    this.certificate = certificate;
    this.installCertificate(certificate);
  }

  private installCertificate(certificate: StoredCertificate): void {
    this.options.install(tls.createSecureContext({ cert: certificate.certificatePem, key: certificate.privateKeyPem }));
    this.installed = true;
  }

  private uninstall(): void {
    if (!this.installed) return;
    this.options.install(null);
    this.installed = false;
  }

  private saveSettings(settings: AutoTlsSettings): void {
    this.settings = settings;
    try {
      this.options.store.writeSettings(settings);
    } catch (error) {
      Logger.warn('NETWORK', 'Could not save the automatic TLS settings.', error);
    }
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    if (this.abort.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.exclusive(() => this.refresh()).catch((error: unknown) => {
        if (!this.abort.signal.aborted) Logger.error('NETWORK', 'Automatic TLS check failed unexpectedly.', error);
      });
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wakes for the renewal, the hourly IP check or the expiry, whichever comes first. */
  private scheduleNext(): void {
    const now = Date.now();
    const certificate = this.certificate;
    const wake = certificate
      ? Math.min(AutoTlsService.renewalTime(certificate), certificate.notAfter, now + AutoTlsService.IP_CHECK_INTERVAL_MS)
      : now + AutoTlsService.IP_CHECK_INTERVAL_MS;
    this.schedule(wake - now);
  }

  private async refresh(): Promise<void> {
    if (!this.settings.enabled) return;
    try {
      const ip = await this.resolveIp();
      const current = this.certificate;
      if (!current || current.ip !== ip || Date.now() >= AutoTlsService.renewalTime(current)) {
        if (current && current.ip !== ip) Logger.info('NETWORK', `Public IP changed from ${current.ip} to ${ip}; issuing a new certificate.`);
        const issued = await this.options.issuer.issue(ip, this.abort.signal);
        this.throwIfDisposed();
        this.adopt(ip, issued);
        Logger.info('NETWORK', `TLS certificate for ${ip} renewed.`);
      }
      this.failures = 0;
      if (this.settings.lastError) this.saveSettings({ enabled: true, lastError: null });
      this.scheduleNext();
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.recordFailure(error);
    }
  }

  private recordFailure(error: unknown): void {
    const failure = error instanceof AutoTlsFailure
      ? error
      : new AutoTlsFailure('network', error instanceof Error ? error.message : String(error));
    this.saveSettings({ enabled: true, lastError: { code: failure.code, detail: failure.message, at: Date.now() } });
    const certificate = this.certificate;
    const now = Date.now();
    if (certificate && now >= certificate.notAfter) this.uninstall();
    const delays = AutoTlsService.RETRY_DELAYS_MS;
    const retry = delays[Math.min(this.failures, delays.length - 1)];
    this.failures += 1;
    const untilExpiry = certificate && this.installed ? certificate.notAfter - now : Infinity;
    Logger.warn('NETWORK', `Could not renew the TLS certificate (${failure.code}); ws:// keeps working. Retrying in ${Math.round(retry / MINUTE)} min.`, failure.message);
    this.schedule(Math.min(retry, untilExpiry));
  }

  private notify(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        Logger.warn('NETWORK', 'An automatic TLS status listener failed.', error);
      }
    }
  }
}
