import { t } from '../i18n';
import { platformSupports } from '../platform/capabilities';
import { isLoopbackHost, isSecureServer } from './serverAddress';

/**
 * The web version only reaches servers with a secure connection (wss://), and
 * this one has none or did not answer over it (#858). Its owner has to turn the
 * secure connection on, so the app explains that and links the docs (#874).
 */
export class SecureServerRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureServerRequiredError';
  }
}

/** Whether this page can only reach the server over a secure connection: on the web, anything but this machine. */
export function needsSecureConnection(host: string): boolean {
  return !platformSupports('plainRemoteServers') && !isLoopbackHost(host);
}

/** The error for a server this page cannot even dial, or null when it can try. */
export function insecureServerError(host: string, port: number): SecureServerRequiredError | null {
  if (!needsSecureConnection(host) || isSecureServer({ host, port })) return null;
  return new SecureServerRequiredError(t('network.webUnsupportedServer', { host, port }));
}
