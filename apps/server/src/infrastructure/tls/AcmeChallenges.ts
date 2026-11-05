import http from 'node:http';
import { GET_OR_HEAD, createHttpRequestListener, sendStatus, type HttpRoute } from '../http/HttpRouter';
import { listenHttpServer, closeHttpServer } from '../lifecycle/httpLifecycle';
import { AutoTlsFailure } from './AutoTlsService';
import type { Http01Publisher } from './AcmeClient';

const CHALLENGE_PATH = '/.well-known/acme-challenge/';
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * HTTP-01 answers while a validation is in progress (RFC 8555 §8.3). The
 * server's own port serves them too, so a server already on port 80 needs no
 * second listener.
 */
export class AcmeChallenges implements Http01Publisher {
  private readonly answers = new Map<string, string>();

  public publish(token: string, keyAuthorization: string): void {
    this.answers.set(token, keyAuthorization);
  }

  public withdraw(token: string): void {
    this.answers.delete(token);
  }

  public routes(): HttpRoute[] {
    return [{
      methods: GET_OR_HEAD,
      path: CHALLENGE_PATH,
      handle: (_req, res, target) => {
        const token = target.pathname.slice(CHALLENGE_PATH.length);
        const answer = TOKEN.test(token) ? this.answers.get(token) : undefined;
        if (answer === undefined) {
          sendStatus(res, 404);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(answer) });
        res.end(answer);
      },
    }];
  }

  /**
   * Opens `port` only for the validation. Not being allowed to (ports below
   * 1024 on Linux) and finding it taken are reported apart, since the owner
   * fixes them differently.
   */
  public async openPort(port: number): Promise<() => Promise<void>> {
    const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, createHttpRequestListener(this.routes()));
    try {
      await listenHttpServer(server, port, '0.0.0.0');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code === 'EACCES' || code === 'EPERM') throw new AutoTlsFailure('port-permission', `Port ${port} needs permission to open.`);
      if (code === 'EADDRINUSE') throw new AutoTlsFailure('port-in-use', `Port ${port} is already in use.`);
      throw new AutoTlsFailure('port-in-use', error instanceof Error ? error.message : String(error));
    }
    return () => closeHttpServer(server);
  }
}
