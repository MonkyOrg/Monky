import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export type HttpGetFailure = 'refused' | 'redirects' | 'invalid-redirect' | 'timeout';

/** Why a GET stopped before its final response; `url` is the hop it stopped at. */
export class HttpGetError extends Error {
  constructor(readonly failure: HttpGetFailure, readonly url: URL) {
    super(failure === 'refused' ? `Refused to request ${url.protocol}//${url.host}`
      : failure === 'redirects' ? 'Too many redirects'
        : failure === 'invalid-redirect' ? 'Redirected to an invalid address' : 'Request timed out');
    this.name = 'HttpGetError';
  }
}

export interface HttpGetOptions {
  /** Checked before every request, redirects included: a URL it refuses is never contacted. */
  allows(url: URL): boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Fails a hop whose connection stays idle this long, before or during its body. */
  idleTimeoutMs?: number;
  /** Resolves names, e.g. to check the address a connection actually uses. */
  lookup?: LookupFunction;
}

export interface HttpGetResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** The caller reads or discards it. */
  body: IncomingMessage;
  /** The URL that answered, after redirects. */
  url: URL;
}

function requestOnce(url: URL, options: HttpGetOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let response: IncomingMessage | undefined;
    const request = transport.get(url, { headers: options.headers, signal: options.signal, lookup: options.lookup }, (received) => {
      response = received;
      resolve(received);
    });
    // Stays attached: an error after the response arrived must not become an uncaught exception.
    request.on('error', reject);
    const idle = options.idleTimeoutMs;
    if (idle === undefined) return;
    request.setTimeout(idle, () => {
      // The body fails with the timeout too. Destroying only the request made Node fail it with a generic
      // "aborted" or, when all of it had arrived but was not read yet, drop the rest and end it as if complete.
      const timeout = new HttpGetError('timeout', url);
      response?.destroy(timeout);
      request.destroy(timeout);
    });
  });
}

/**
 * GET for the main process. Redirects are followed in a loop, at most five, and
 * each hop must be http(s) and pass `allows` before it is requested. A redirect
 * to another scheme, or to something that is not a URL at all, rejects instead
 * of throwing inside a response callback, which crashed the main process
 * (E-MAIN-5). The final response is returned whatever its status.
 */
export async function httpGet(url: URL, options: HttpGetOptions): Promise<HttpGetResponse> {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    options.signal?.throwIfAborted();
    if ((current.protocol !== 'http:' && current.protocol !== 'https:') || !options.allows(current)) {
      throw new HttpGetError('refused', current);
    }
    const response = await requestOnce(current, options);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (!REDIRECT_STATUSES.has(status) || !location) {
      return { status, headers: response.headers, body: response, url: current };
    }
    response.resume();
    if (redirects >= MAX_REDIRECTS) throw new HttpGetError('redirects', current);
    try {
      current = new URL(location, current);
    } catch {
      throw new HttpGetError('invalid-redirect', current);
    }
  }
}
