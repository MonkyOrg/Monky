import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaError, SourceRecoveryError, SOURCE_RECOVERY_FAILURE_LIMIT, aborted } from './errors';
import { bounded, safeDiagnostic } from './process';

const OPERATION_TIMEOUT_MS = 15_000;
const MAX_RETRY_DELAY_MS = 5000;
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_STREAM_PREMATURE_CLOSE',
]);

export type AudioRequest = (
  url: URL, headers: Readonly<Record<string, string>>, signal: AbortSignal,
) => Promise<IncomingMessage>;

export interface PersistentInput {
  readonly url: string;
  readonly failure: MediaError | undefined;
  waitingForData(): boolean;
  markAudioProgress(): void;
  setPaused(paused: boolean): void;
  close(): Promise<void>;
}

class TransientInputError extends Error {
  constructor(readonly retryAfterMs = 0, detail = 'Incomplete HTTP audio response.') { super(detail); }
}

function transient(error: unknown): boolean {
  return error instanceof TransientInputError ||
    (error instanceof MediaError && error.code === 'timeout') ||
    (typeof error === 'object' && error !== null && 'code' in error &&
      typeof error.code === 'string' && TRANSIENT_CODES.has(error.code));
}

function header(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  if (value !== undefined && typeof value !== 'string') throw new MediaError('unavailable', `Invalid audio response ${name} header.`);
  return value;
}

function integer(value: string): number {
  if (!/^\d+$/.test(value)) throw new MediaError('unavailable', 'Invalid audio response byte range.');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new MediaError('unavailable', 'Audio response byte range is too large.');
  return result;
}

function secureRequest(url: URL, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'GET', headers, signal, agent: false }, (response) => {
      response.on('error', reject);
      resolve(response);
    });
    request.once('error', reject);
    request.end();
  });
}

/**
 * Keep FFmpeg's seekable input alive while individual public HTTPS operations retry.
 * The private loopback endpoint serves one validated resource, never arbitrary URLs.
 */
export async function createPersistentInput(
  resource: string, signal: AbortSignal, validateUrl: (value: string) => string,
  request: AudioRequest = secureRequest,
): Promise<PersistentInput> {
  aborted(signal);
  let currentUrl = validateUrl(resource);
  const endpoint = `/${randomBytes(32).toString('hex')}`;
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  const transfers = new Set<Promise<void>>();
  let failure: MediaError | undefined;
  let closing: Promise<void> | undefined;
  let networkWaiters = 0;
  let lastProgressAt = performance.now();
  let retrying = false;
  let lastDiagnosticAt = -Infinity;
  let hasInterrupted = false;
  let consecutiveFailures = 0;
  let audioProgress = 0;
  let paused = false;
  let identity: { total?: number; etag?: string; modified?: string } | undefined;

  const stop = (): void => {
    lifetime.abort();
    for (const socket of sockets) socket.destroy();
  };
  const fail = (error: unknown): void => {
    failure ??= error instanceof MediaError ? error
      : new MediaError('unavailable', safeDiagnostic(error instanceof Error ? error.message : String(error)));
    stop();
  };
  const network = async <T>(operation: Promise<T>): Promise<T> => {
    networkWaiters++;
    try { return await operation; }
    finally { networkWaiters--; }
  };

  const transfer = async (localRequest: IncomingMessage, output: ServerResponse, start: number, requestedEnd?: number): Promise<void> => {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    lifetime.signal.addEventListener('abort', cancel, { once: true });
    localRequest.once('aborted', cancel);
    output.once('close', cancel);
    output.once('error', cancel);
    if (lifetime.signal.aborted) cancel();
    let position = start;
    let targetEnd = requestedEnd;
    let retryDelay = 1000;
    let redirects = 0;
    try {
      while (!controller.signal.aborted) {
        const recoveryAttempt = hasInterrupted;
        const progressBeforeAttempt = audioProgress;
        const operation = new AbortController();
        const cancelOperation = (): void => operation.abort();
        controller.signal.addEventListener('abort', cancelOperation, { once: true });
        let response: IncomingMessage | undefined;
        let responseError: unknown;
        let retry: number | undefined;
        try {
          aborted(controller.signal);
          const headers: Record<string, string> = { Range: `bytes=${position}-${targetEnd ?? ''}` };
          const validator = identity?.etag && !identity.etag.startsWith('W/') ? identity.etag : identity?.modified;
          if (position > 0 && validator) headers['If-Range'] = validator;
          response = await network(bounded(request(new URL(currentUrl), headers, operation.signal),
            controller.signal, OPERATION_TIMEOUT_MS));
          response.on('error', (error: Error) => { responseError = error; });
          const status = response.statusCode;
          if (status && [301, 302, 303, 307, 308].includes(status)) {
            const location = header(response, 'location');
            if (!location || ++redirects > 5) throw new MediaError('unavailable', 'Audio source redirect limit exceeded.');
            currentUrl = validateUrl(new URL(location, currentUrl).href);
            continue;
          }
          if (status && TRANSIENT_STATUS.has(status)) {
            const value = header(response, 'retry-after');
            const retryAfter = value && /^\d+$/.test(value) ? Number(value) * 1000 : 0;
            throw new TransientInputError(Math.min(MAX_RETRY_DELAY_MS, retryAfter), `Audio source returned HTTP ${status}.`);
          }
          if (status === 416) {
            const total = /^bytes \*\/(\d+)$/.exec(header(response, 'content-range') ?? '');
            if (total && identity?.total === integer(total[1]) && position >= identity.total) {
              if (!output.headersSent) output.writeHead(416, { 'Content-Range': `bytes */${identity.total}`, Connection: 'close' });
              output.end();
              return;
            }
          }
          if (status !== 200 && status !== 206) throw new MediaError('unavailable', `Audio source returned HTTP ${status ?? 'unknown'}.`);
          redirects = 0;
          const lengthHeader = header(response, 'content-length');
          const length = lengthHeader === undefined ? undefined : integer(lengthHeader);
          const encoding = header(response, 'content-encoding');
          if (encoding && encoding !== 'identity') throw new MediaError('unavailable', 'Audio source returned unsupported content encoding.');
          let total: number | undefined;
          let segmentEnd: number | undefined;
          if (status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header(response, 'content-range') ?? '');
            if (!range) throw new MediaError('unavailable', 'Audio source returned an invalid Content-Range.');
            const from = integer(range[1]);
            segmentEnd = integer(range[2]);
            total = integer(range[3]);
            if (from !== position || segmentEnd < from || segmentEnd >= total ||
                (length !== undefined && length !== segmentEnd - from + 1) ||
                (targetEnd !== undefined && segmentEnd > targetEnd)) {
              throw new MediaError('unavailable', 'Audio source returned a mismatched byte range.');
            }
          } else {
            if (position !== 0) throw new MediaError('unavailable', 'Audio source refused byte-range resume; restarting would duplicate audio.');
            total = length;
            segmentEnd = total === undefined ? undefined : total - 1;
            targetEnd = segmentEnd;
          }
          const etag = header(response, 'etag');
          const modified = header(response, 'last-modified');
          if (identity && ((identity.total !== undefined && total !== undefined && identity.total !== total) ||
              (identity.etag !== undefined && identity.etag !== etag) ||
              (identity.modified !== undefined && identity.modified !== modified))) {
            throw new MediaError('unavailable', 'Audio source changed while resuming; refusing to mix media.');
          }
          identity = { total: identity?.total ?? total, etag: identity?.etag ?? etag, modified: identity?.modified ?? modified };
          if (total !== undefined) targetEnd = Math.min(targetEnd ?? total - 1, total - 1);
          if (!output.headersSent) {
            const localHeaders: Record<string, string | number> = {
              'Content-Type': header(response, 'content-type') ?? 'application/octet-stream', Connection: 'close',
            };
            if (targetEnd !== undefined) localHeaders['Content-Length'] = targetEnd - start + 1;
            if (total !== undefined && (status === 206 || header(response, 'accept-ranges')?.toLowerCase() === 'bytes')) {
              localHeaders['Accept-Ranges'] = 'bytes';
            }
            if (status === 206 && total !== undefined) {
              localHeaders['Content-Range'] = `bytes ${start}-${targetEnd}/${total}`;
            }
            output.writeHead(status, localHeaders);
          }
          const reader = response[Symbol.asyncIterator]();
          for (;;) {
            if (responseError !== undefined) throw responseError;
            const next = await network(bounded(reader.next(), controller.signal, OPERATION_TIMEOUT_MS));
            if (next.done) break;
            aborted(controller.signal);
            if (!Buffer.isBuffer(next.value)) throw new MediaError('unavailable', 'Invalid audio response data.');
            const chunk = next.value;
            if (segmentEnd !== undefined && position + chunk.length > segmentEnd + 1) {
              throw new MediaError('unavailable', 'Audio response exceeded its declared byte range.');
            }
            if (responseError !== undefined) throw responseError;
            if (!chunk.length) continue;
            const writable = output.write(chunk);
            position += chunk.length;
            lastProgressAt = performance.now();
            if (!writable) await once(output, 'drain', { signal: controller.signal });
          }
          if (!response.complete || (segmentEnd !== undefined && position !== segmentEnd + 1)) throw new TransientInputError();
          if ((targetEnd !== undefined && position === targetEnd + 1) ||
              (targetEnd === undefined && status === 200)) {
            output.end();
            return;
          }
          // A complete partial Content-Range is not EOF of the resource.
          if (total === undefined || segmentEnd === undefined) throw new MediaError('unavailable', 'Audio source has no resumable resource length.');
        } catch (error: unknown) {
          if (controller.signal.aborted) return;
          if (!transient(error)) throw error;
          if (recoveryAttempt && progressBeforeAttempt === audioProgress && !paused) {
            consecutiveFailures = Math.min(SOURCE_RECOVERY_FAILURE_LIMIT, consecutiveFailures + 1);
          }
          if (progressBeforeAttempt !== audioProgress) retryDelay = 1000;
          hasInterrupted = true;
          retry = Math.min(MAX_RETRY_DELAY_MS, Math.max(retryDelay, error instanceof TransientInputError ? error.retryAfterMs : 0));
          retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2);
          if (!retrying && performance.now() - lastDiagnosticAt >= 5000) {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(`[media] Source transport interrupted (byte=${position}, retryDelayMs=${retry}): ${safeDiagnostic(detail)}`);
            lastDiagnosticAt = performance.now();
          }
          retrying = true;
        } finally {
          controller.signal.removeEventListener('abort', cancelOperation);
          operation.abort();
          response?.destroy();
        }
        if (retry !== undefined) {
          // Buffered/just-decoded audio can still advance before the next attempt.
          await network(delay(retry, undefined, { signal: controller.signal }));
          if (!paused && consecutiveFailures >= SOURCE_RECOVERY_FAILURE_LIMIT) {
            throw new SourceRecoveryError(consecutiveFailures);
          }
        }
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      lifetime.signal.removeEventListener('abort', cancel);
      localRequest.off('aborted', cancel);
      output.off('close', cancel);
      output.off('error', cancel);
    }
  };

  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== endpoint || lifetime.signal.aborted) {
      response.writeHead(404, { Connection: 'close' }).end();
      return;
    }
    const range = request.headers.range === undefined ? undefined : /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
    if (request.headers.range !== undefined && !range) {
      response.writeHead(416, { Connection: 'close' }).end();
      return;
    }
    let start: number, end: number | undefined;
    try {
      start = range ? integer(range[1]) : 0;
      end = range?.[2] ? integer(range[2]) : undefined;
      if (end !== undefined && end < start) throw new MediaError('input');
    } catch (error: unknown) {
      if (!(error instanceof MediaError)) throw error;
      response.writeHead(416, { Connection: 'close' }).end();
      return;
    }
    if (transfers.size >= 4) {
      response.writeHead(503, { Connection: 'close' }).end();
      return;
    }
    const pending = transfer(request, response, start, end);
    transfers.add(pending);
    void pending.then(() => transfers.delete(pending), (error: unknown) => { transfers.delete(pending); fail(error); });
  });
  server.maxConnections = 8;
  server.headersTimeout = 15000;
  server.requestTimeout = 15000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let ready = false;
  const cancelled = (): void => {
    stop();
    if (ready) void close().catch(fail);
  };
  const close = (): Promise<void> => closing ??= (async () => {
    signal.removeEventListener('abort', cancelled);
    stop();
    await Promise.all([...transfers]);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  })();
  signal.addEventListener('abort', cancelled, { once: true });
  let port: number;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    aborted(signal);
    const address = server.address();
    if (!address || typeof address === 'string') throw new MediaError('unavailable', 'Could not initialize the audio input transport.');
    port = address.port;
    ready = true;
  } catch (error: unknown) {
    signal.removeEventListener('abort', cancelled);
    stop();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    throw error;
  }
  server.on('error', fail);
  return {
    url: `http://127.0.0.1:${port}${endpoint}`,
    get failure() { return failure; },
    waitingForData: () => networkWaiters > 0 || performance.now() - lastProgressAt < 30000,
    markAudioProgress: () => {
      if (lifetime.signal.aborted) return;
      audioProgress++;
      consecutiveFailures = 0;
      retrying = false;
    },
    setPaused: (value) => { paused = value; },
    close,
  };
}
