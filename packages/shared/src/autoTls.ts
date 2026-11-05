/**
 * Automatic TLS for servers reached by public IP (#860): a short-lived Let's
 * Encrypt certificate issued to the IP itself and renewed by the server.
 * Shared by the server, the desktop host screen and the CLI.
 */

/**
 * Why issuing or renewing failed, so each surface can explain it in its own language:
 * - `no-public-ip`: no public IP could be discovered;
 * - `address-not-public`: the address is not one the CA can reach;
 * - `port-in-use`: another program holds the validation port;
 * - `port-permission`: the system does not let the server open the validation port (Linux below 1024);
 * - `privilege-unavailable`: the server could not lift that restriction itself (no passwordless sudo);
 * - `unreachable`: the CA could not reach the validation port from the internet;
 * - `rate-limited`: the CA asked to wait before trying again;
 * - `rejected`: the CA refused the request for another reason;
 * - `network`: the CA itself could not be reached;
 * - `storage`: the certificate could not be saved or read back.
 */
export const AUTO_TLS_ERROR_CODES = [
  'no-public-ip', 'address-not-public', 'port-in-use', 'port-permission', 'privilege-unavailable', 'unreachable', 'rate-limited', 'rejected', 'network', 'storage',
] as const;
export type AutoTlsErrorCode = typeof AUTO_TLS_ERROR_CODES[number];

export function isAutoTlsErrorCode(value: unknown): value is AutoTlsErrorCode {
  return typeof value === 'string' && (AUTO_TLS_ERROR_CODES as readonly string[]).includes(value);
}

export interface AutoTlsError {
  code: AutoTlsErrorCode;
  /** Technical detail for logs and support; never shown as the explanation itself. */
  detail: string | null;
  at: number;
}

export interface AutoTlsStatus {
  /** The owner turned automatic TLS on. */
  enabled: boolean;
  /** A valid certificate is installed: new connections may use `wss://`. */
  active: boolean;
  /** Issuing, renewing or checking right now. */
  busy: boolean;
  /** Address the current certificate covers. */
  ip: string | null;
  validUntil: number | null;
  nextRenewalAt: number | null;
  /** Last failure since the last success; `ws://` keeps working meanwhile. */
  lastError: AutoTlsError | null;
}

/** What the desktop host screen gets back when it turns the feature on. */
export type AutoTlsEnableResult =
  | { ok: true; status: AutoTlsStatus }
  | { ok: false; code: AutoTlsErrorCode };

export const AUTO_TLS_DISABLED_STATUS: AutoTlsStatus = Object.freeze({
  enabled: false,
  active: false,
  busy: false,
  ip: null,
  validUntil: null,
  nextRenewalAt: null,
  lastError: null,
});

/** HTTP-01 validation port: Let's Encrypt only ever connects to port 80. */
export const AUTO_TLS_VALIDATION_PORT = 80;

/**
 * What the owner runs once on Linux so an unprivileged server may open the
 * validation port; the server offers to run it through `sudo -n` itself.
 */
export const AUTO_TLS_LOW_PORT_SYSCTL = 'net.ipv4.ip_unprivileged_port_start=80';
export const AUTO_TLS_LOW_PORT_SYSCTL_FILE = '/etc/sysctl.d/60-monky-tls.conf';
export const AUTO_TLS_LOW_PORT_COMMAND =
  `echo '${AUTO_TLS_LOW_PORT_SYSCTL}' | sudo tee ${AUTO_TLS_LOW_PORT_SYSCTL_FILE} && sudo sysctl -w ${AUTO_TLS_LOW_PORT_SYSCTL}`;