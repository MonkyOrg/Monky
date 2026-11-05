import path from 'node:path';
import { CertificateStore, TlsSettingsStore, type AutoTlsServiceOptions, type TlsLogger } from '@monky/shared/dist/tls';
import { GET_OR_HEAD, sendStatus, type HttpRoute } from '../http/HttpRouter';
import { Logger } from '../logger/Logger';
import type { AcmeChallenges } from '@monky/shared/dist/tls';

const ACME_CHALLENGE_PATH = '/.well-known/acme-challenge/';

const serverTlsLogger: TlsLogger = {
  info: (message, meta) => Logger.info('NETWORK', message, meta),
  warn: (message, meta) => Logger.warn('NETWORK', message, meta),
  error: (message, meta) => Logger.error('NETWORK', message, meta),
};

/** The certificate is shared by the machine; only the opt-in stays in this server's data folder. */
export function serverTlsStorage(dataDir: string): Pick<AutoTlsServiceOptions, 'store' | 'settings' | 'legacyDirectory' | 'log'> {
  const own = path.join(dataDir, 'tls');
  return { store: new CertificateStore(), settings: new TlsSettingsStore(own), legacyDirectory: own, log: serverTlsLogger };
}

export function acmeRoutes(challenges: AcmeChallenges): HttpRoute[] {
  return [{
    methods: GET_OR_HEAD,
    path: ACME_CHALLENGE_PATH,
    handle: (_req, res, target) => {
      const answer = challenges.answer(target.pathname);
      if (answer === undefined) {
        sendStatus(res, 404);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(answer) });
      res.end(answer);
    },
  }];
}
