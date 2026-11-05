import tls from 'node:tls';
import type { AutoTlsErrorCode, AutoTlsStatus } from '../autoTls';
import { inspectCertificate, removeLegacyCertificate, type AutoTlsSettings, type CertificateStore, type StoredCertificate, type TlsSettingsStore } from './CertificateStore';
import { AutoTlsFailure, SILENT_TLS_LOGGER, type CertificateIssuer, type IssuedCertificate, type TlsLogger } from './errors';
import { FileLock } from './fileLock';
import { isPublicUnicastAddress } from './publicAddress';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface AutoTlsServiceOptions {
  /** The machine-wide certificate shared by every server and bot. */
  store: CertificateStore;
  /** This server's or bot's own opt-in. */
  settings: TlsSettingsStore;
  issuer: CertificateIssuer;
  publicIp: () => Promise<string | null>;
  /** Installs the context new connections use; `null` leaves no TLS. The certificate is `null` then too. */
  install: (context: tls.SecureContext | null, certificate: StoredCertificate | null) => void;
  /** Held while issuing, so only one process of the machine talks to the CA and binds the validation port. */
  lock?: FileLock;
  /** A data folder from before the certificate was shared; its certificate is adopted once. */
  legacyDirectory?: string;
  /** A test CA validates on loopback or a LAN; Let's Encrypt only ever reaches public addresses. */
  allowNonPublicAddress?: boolean;
  /** Lifts the system's restriction on the validation port; called only with the owner's consent. */
  grantPortPermission?: () => Promise<void>;
  log?: TlsLogger;
}

export interface AutoTlsEnableOptions {
  /** The owner agreed to let the process lift the port restriction itself (`sudo -n`). */
  grantPortPermission?: boolean;
}

/**
 * Keeps a certificate for the machine's public IP (#860) for one server or
 * bot: reuses the shared one when it is valid, otherwise issues it, renews it
 * ahead of expiry (only one process at a time, under a file lock), issues a
 * new one when the IP changes, and swaps it in for new connections without
 * touching the open ones. A certificate renewed by another process is picked
 * up from the shared store. While it cannot, the process keeps serving without
 * TLS and the last error is kept for the owner.
 */
export class AutoTlsService {
  /** Let's Encrypt `shortlived` certificates last about 6 days; renewal starts with 2 to spare. */
  static RENEW_BEFORE_MS = 2 * DAY;
  static IP_CHECK_INTERVAL_MS = HOUR;
  static RETRY_DELAYS_MS: readonly number[] = [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR];
  /** When another process is renewing, how long before looking at the shared certificate again. */
  static LOCK_RETRY_MS = 30_000;
  /** How long turning the feature on waits for another process that is issuing. */
  static LOCK_WAIT_MS = 3 * MINUTE;
  /** How often the shared certificate and this process's own setting are checked for changes made elsewhere. */
  static PICKUP_INTERVAL_MS = MINUTE;

  /** The last `enable()` found a valid shared certificate and asked the CA for nothing. */
  public reusedSharedCertificate = false;

  private settings: AutoTlsSettings;
  private certificate: StoredCertificate | null;
  private installed = false;
  private busy = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private pickupTimer: NodeJS.Timeout | null = null;
  private stamp: string | null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(status: AutoTlsStatus) => void>();
  private readonly lock: FileLock;
  private readonly log: TlsLogger;

  constructor(private readonly options: AutoTlsServiceOptions) {
    this.log = options.log ?? SILENT_TLS_LOGGER;
    this.lock = options.lock ?? new FileLock(options.store.file('renew.lock'));
    if (options.legacyDirectory) {
      try {
        if (options.store.adoptLegacy(options.legacyDirectory)) this.log.info('Adopted the certificate this server kept before certificates were shared.');
      } catch (error) {
        this.log.warn('Could not move the certificate to the shared folder.', error);
      }
    }
    this.settings = options.settings.read();
    this.certificate = this.settings.enabled ? options.store.readCertificate() : null;
    this.stamp = options.store.certificateStamp();
  }

  /** Installs a saved certificate that is still valid, then checks it in the background and watches for changes made elsewhere. */
  public start(): void {
    this.startPickup();
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

  /** Address new secure connections are valid for, if any. */
  public secureAddress(): string | null {
    return this.installed ? this.certificate?.ip ?? null : null;
  }

  public subscribe(listener: (status: AutoTlsStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Turns the feature on with the certificate already shared on this machine,
   * or, when there is none for this IP, only after the CA proved it can reach
   * this host and a certificate was issued. A failure rejects with an
   * `AutoTlsFailure` and leaves the feature off. `port-permission` may be
   * retried with the owner's consent to `grantPortPermission`.
   */
  public enable(options: AutoTlsEnableOptions = {}): Promise<AutoTlsStatus> {
    return this.exclusive(async () => {
      const signal = this.abort.signal;
      const ip = await this.resolveIp();
      this.reusedSharedCertificate = false;
      const shared = this.options.store.findUsable(ip);
      if (shared) {
        this.reusedSharedCertificate = true;
        this.useCertificate(shared);
      } else {
        const release = await this.lock.acquire(AutoTlsService.LOCK_WAIT_MS, signal);
        if (!release) {
          this.throwIfDisposed();
          throw new AutoTlsFailure('network', 'Another process is still issuing the certificate.');
        }
        try {
          const concurrent = this.options.store.findUsable(ip);
          if (concurrent) {
            this.reusedSharedCertificate = true;
            this.useCertificate(concurrent);
          } else {
            await this.precheck(ip, options);
            const issued = await this.options.issuer.issue(ip, signal);
            this.throwIfDisposed();
            this.adopt(ip, issued);
          }
        } finally {
          release();
        }
      }
      this.saveSettings({ enabled: true, lastError: null });
      this.failures = 0;
      this.log.info(`Automatic TLS enabled for ${ip}${this.reusedSharedCertificate ? ' with the shared certificate' : ''}.`);
      this.scheduleNext();
    }).then(() => this.status());
  }

  /** Turns this process off; the shared certificate stays for the others. */
  public disable(): Promise<AutoTlsStatus> {
    return this.exclusive(async () => {
      this.cancelTimer();
      this.saveSettings({ enabled: false, lastError: null });
      this.uninstall();
      this.certificate = null;
      this.failures = 0;
      if (this.options.legacyDirectory) removeLegacyCertificate(this.options.legacyDirectory);
      this.log.info('Automatic TLS disabled; only plain connections are accepted.');
    }).then(() => this.status());
  }

  /** Follows what other processes changed: a renewed certificate, or this process's own setting. Runs by itself while started. */
  public syncFromDisk(): void {
    if (this.abort.signal.aborted || this.busy) return;
    const stored = this.options.settings.read();
    if (stored.enabled !== this.settings.enabled) {
      this.settings = stored;
      if (stored.enabled) {
        this.certificate = this.options.store.readCertificate();
        this.restore();
        this.schedule(0);
      } else {
        this.cancelTimer();
        this.uninstall();
        this.certificate = null;
      }
      this.notify();
      return;
    }
    if (!this.settings.enabled) return;
    const stamp = this.options.store.certificateStamp();
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const shared = this.options.store.readCertificate();
    const current = this.certificate;
    if (!shared || Date.now() >= shared.notAfter) return;
    if (current && (shared.ip !== current.ip || shared.notAfter <= current.notAfter)) return;
    this.log.info(`Picked up the TLS certificate for ${shared.ip} renewed by another process.`);
    this.useCertificate(shared);
    this.notify();
    this.scheduleNext();
  }

  /** Idempotent: stops the timers and abandons work in flight. */
  public dispose(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.cancelTimer();
    if (this.pickupTimer) clearInterval(this.pickupTimer);
    this.pickupTimer = null;
    this.listeners.clear();
  }

  private static renewalTime(certificate: StoredCertificate): number {
    return certificate.notAfter - AutoTlsService.RENEW_BEFORE_MS;
  }

  private startPickup(): void {
    if (this.pickupTimer || this.abort.signal.aborted) return;
    this.pickupTimer = setInterval(() => {
      try {
        this.syncFromDisk();
      } catch (error) {
        this.log.warn('Could not check the shared TLS certificate.', error);
      }
    }, AutoTlsService.PICKUP_INTERVAL_MS);
    this.pickupTimer.unref?.();
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
    if (this.abort.signal.aborted) throw new AutoTlsFailure('network', 'The process is stopping.');
  }

  private async resolveIp(): Promise<string> {
    const ip = await this.options.publicIp();
    if (!ip) throw new AutoTlsFailure('no-public-ip');
    if (!this.options.allowNonPublicAddress && !isPublicUnicastAddress(ip)) throw new AutoTlsFailure('address-not-public', ip);
    return ip;
  }

  private async precheck(ip: string, options: AutoTlsEnableOptions): Promise<void> {
    const signal = this.abort.signal;
    try {
      await this.options.issuer.precheck(ip, signal);
    } catch (error) {
      const grant = this.options.grantPortPermission;
      if (!(error instanceof AutoTlsFailure) || error.code !== 'port-permission' || !options.grantPortPermission || !grant) throw error;
      await grant();
      await this.options.issuer.precheck(ip, signal);
    }
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
    this.useCertificate(certificate);
  }

  private useCertificate(certificate: StoredCertificate): void {
    this.certificate = certificate;
    this.stamp = this.options.store.certificateStamp();
    this.installCertificate(certificate);
  }

  private installCertificate(certificate: StoredCertificate): void {
    this.options.install(tls.createSecureContext({ cert: certificate.certificatePem, key: certificate.privateKeyPem }), certificate);
    this.installed = true;
  }

  private uninstall(): void {
    if (!this.installed) return;
    this.options.install(null, null);
    this.installed = false;
  }

  private saveSettings(settings: AutoTlsSettings): void {
    this.settings = settings;
    try {
      this.options.settings.write(settings);
    } catch (error) {
      this.log.warn('Could not save the automatic TLS settings.', error);
    }
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    if (this.abort.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.exclusive(() => this.refresh()).catch((error: unknown) => {
        if (!this.abort.signal.aborted) this.log.error('Automatic TLS check failed unexpectedly.', error);
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
      const shared = this.options.store.findUsable(ip);
      if (shared && (!this.certificate || shared.notAfter > this.certificate.notAfter)) this.useCertificate(shared);
      if (this.needsIssuing(ip)) {
        const release = this.lock.tryAcquire();
        if (!release) {
          this.uninstallIfExpired();
          this.schedule(AutoTlsService.LOCK_RETRY_MS);
          return;
        }
        try {
          const renewed = this.options.store.findUsable(ip);
          if (renewed && !AutoTlsService.isDue(renewed)) {
            this.useCertificate(renewed);
          } else {
            const current = this.certificate;
            if (current && current.ip !== ip) this.log.info(`Public IP changed from ${current.ip} to ${ip}; issuing a new certificate.`);
            const issued = await this.options.issuer.issue(ip, this.abort.signal);
            this.throwIfDisposed();
            this.adopt(ip, issued);
            this.log.info(`TLS certificate for ${ip} renewed.`);
          }
        } finally {
          release();
        }
      }
      this.failures = 0;
      if (this.settings.lastError) this.saveSettings({ enabled: true, lastError: null });
      this.scheduleNext();
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.recordFailure(error);
    }
  }

  private static isDue(certificate: StoredCertificate): boolean {
    return Date.now() >= AutoTlsService.renewalTime(certificate);
  }

  private needsIssuing(ip: string): boolean {
    const current = this.certificate;
    return !current || current.ip !== ip || AutoTlsService.isDue(current);
  }

  private uninstallIfExpired(): void {
    if (this.certificate && Date.now() >= this.certificate.notAfter) this.uninstall();
  }

  private recordFailure(error: unknown): void {
    const failure = error instanceof AutoTlsFailure
      ? error
      : new AutoTlsFailure('network', error instanceof Error ? error.message : String(error));
    this.saveSettings({ enabled: true, lastError: { code: failure.code as AutoTlsErrorCode, detail: failure.message, at: Date.now() } });
    const certificate = this.certificate;
    const now = Date.now();
    this.uninstallIfExpired();
    const delays = AutoTlsService.RETRY_DELAYS_MS;
    const retry = delays[Math.min(this.failures, delays.length - 1)];
    this.failures += 1;
    const untilExpiry = certificate && this.installed ? certificate.notAfter - now : Infinity;
    this.log.warn(`Could not renew the TLS certificate (${failure.code}); plain connections keep working. Retrying in ${Math.round(retry / MINUTE)} min.`, failure.message);
    this.schedule(Math.min(retry, untilExpiry));
  }

  private notify(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.log.warn('An automatic TLS status listener failed.', error);
      }
    }
  }
}
