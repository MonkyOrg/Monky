import http from 'node:http';
import { AutoTlsFailure } from './errors';
import type { Http01Publisher } from './AcmeClient';

export const ACME_CHALLENGE_PATH = '/.well-known/acme-challenge/';
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * HTTP-01 answers while a validation is in progress (RFC 8555 §8.3). A server
 * already on port 80 serves them through its own router; anything else opens
 * the port only for the validation.
 */
export class AcmeChallenges implements Http01Publisher {
  private readonly answers = new Map<string, string>();

  public publish(token: string, keyAuthorization: string): void {
    this.answers.set(token, keyAuthorization);
  }

  public withdraw(token: string): void {
    this.answers.delete(token);
  }

  /** The key authorization published for the request path, if it is a live challenge. */
  public answer(pathname: string): string | undefined {
    if (!pathname.startsWith(ACME_CHALLENGE_PATH)) return undefined;
    const token = pathname.slice(ACME_CHALLENGE_PATH.length);
    return TOKEN.test(token) ? this.answers.get(token) : undefined;
  }

  public handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const answer = req.method === 'GET' || req.method === 'HEAD'
      ? this.answer(new URL(req.url ?? '/', 'http://localhost').pathname)
      : undefined;
    if (answer === undefined) {
      res.writeHead(404, { 'content-length': 0 });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(answer) });
    res.end(req.method === 'HEAD' ? undefined : answer);
  }

  /**
   * Opens `port` only for the validation. Not being allowed to (ports below
   * 1024 on Linux) and finding it taken are reported apart, since the owner
   * fixes them differently.
   */
  public async openPort(port: number): Promise<() => Promise<void>> {
    const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code === 'EACCES' || code === 'EPERM') throw new AutoTlsFailure('port-permission', `Port ${port} needs permission to open.`);
      if (code === 'EADDRINUSE') throw new AutoTlsFailure('port-in-use', `Port ${port} is already in use.`);
      throw new AutoTlsFailure('port-in-use', error instanceof Error ? error.message : String(error));
    }
    return () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
