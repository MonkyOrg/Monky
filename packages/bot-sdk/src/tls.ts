import path from 'path';
import tls from 'tls';
import type { AutoTlsStatus } from '@monky/shared';
import {
  AcmeChallenges, AutoTlsFailure, AutoTlsService, CertificateStore, LetsEncryptIssuer, TlsSettingsStore,
  acmeTestOverrides, allowValidationPort, discoverPublicIp, sharedTlsDirectory,
  type StoredCertificate, type TlsLogger,
} from '@monky/shared/dist/tls';

export { AutoTlsFailure, sharedTlsDirectory };
export type { AutoTlsStatus, TlsLogger };

/** What `https.createServer` and `server.setSecureContext` take. */
export interface BotTlsMaterial {
  cert: string;
  key: string;
}

export interface BotTlsChange {
  status: AutoTlsStatus;
  /** `null` when TLS is off: serve plain connections only. */
  material: BotTlsMaterial | null;
}

export interface BotTlsOptions {
  /**
   * Folder holding this bot's own opt-in (`<dataDir>/tls/settings.json`). Defaults to
   * `MONKY_BOT_TLS_STATE_DIR` (set for bots started by the CLI), then `<cwd>/.monky/tls`.
   */
  dataDir?: string;
  log?: TlsLogger;
  /** Replaces the lookup of the machine's public IP. */
  publicIp?: () => Promise<string | null>;
}

export interface BotTlsEnableOptions {
  /** Let the process lift the Linux low-port restriction itself (root or passwordless sudo). */
  grantPortPermission?: boolean;
}

export interface BotTls {
  status(): AutoTlsStatus;
  /** Reuses the certificate shared on this machine, or issues one and shares it. Rejects with `AutoTlsFailure`. */
  enable(options?: BotTlsEnableOptions): Promise<AutoTlsStatus>;
  /** Turns TLS off for this bot; the shared certificate stays for the others. */
  disable(): Promise<AutoTlsStatus>;
  /** The certificate being served now, or `null` while TLS is off. */
  material(): BotTlsMaterial | null;
  secureContext(): tls.SecureContext | null;
  /** Loads the saved certificate, renews it ahead of expiry and follows renewals made by other processes. */
  start(): void;
  /** Called when the served certificate is installed, renewed or removed. Returns the unsubscribe function. */
  onChange(listener: (change: BotTlsChange) => void): () => void;
  /** The last `enable()` found a valid shared certificate and asked the CA for nothing. */
  readonly reusedSharedCertificate: boolean;
  dispose(): void;
}

function stateDirectory(options: BotTlsOptions): string {
  if (options.dataDir) return path.join(options.dataDir, 'tls');
  return process.env.MONKY_BOT_TLS_STATE_DIR || path.join(process.cwd(), '.monky', 'tls');
}

/**
 * Automatic TLS for a bot (#860): a Let's Encrypt certificate for the machine's
 * public IP, shared with the other bots and the server of this machine.
 *
 * ```ts
 * const botTls = createBotTls();
 * botTls.start();
 * const server = https.createServer(botTls.material() ?? undefined, handler);
 * botTls.onChange(({ material }) => { if (material) server.setSecureContext(material); });
 * ```
 */
export function createBotTls(options: BotTlsOptions = {}): BotTls {
  const overrides = acmeTestOverrides();
  const store = new CertificateStore();
  let current: { certificate: StoredCertificate; context: tls.SecureContext } | null = null;
  const listeners = new Set<(change: BotTlsChange) => void>();

  const material = (): BotTlsMaterial | null =>
    current ? { cert: current.certificate.certificatePem, key: current.certificate.privateKeyPem } : null;

  const service: AutoTlsService = new AutoTlsService({
    store,
    settings: new TlsSettingsStore(stateDirectory(options)),
    issuer: new LetsEncryptIssuer({
      store, challenges: new AcmeChallenges(),
      directoryOverride: overrides.directoryOverride, validationPort: overrides.validationPort,
    }),
    publicIp: options.publicIp ?? (async () => overrides.publicIp || discoverPublicIp()),
    allowNonPublicAddress: !!overrides.directoryOverride,
    grantPortPermission: allowValidationPort,
    log: options.log,
    install: (context, certificate) => {
      current = context && certificate ? { certificate, context } : null;
      // The service marks the certificate as installed right after this returns.
      queueMicrotask(() => {
        const change: BotTlsChange = { status: service.status(), material: material() };
        for (const listener of listeners) {
          try {
            listener(change);
          } catch (error) {
            options.log?.warn('A TLS change listener failed.', error);
          }
        }
      });
    },
  });

  return {
    status: () => service.status(),
    enable: (enableOptions) => service.enable(enableOptions),
    disable: () => service.disable(),
    material,
    secureContext: () => current?.context ?? null,
    start: () => service.start(),
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get reusedSharedCertificate() { return service.reusedSharedCertificate; },
    dispose: () => { service.dispose(); listeners.clear(); },
  };
}
