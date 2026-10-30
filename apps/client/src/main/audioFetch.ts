import { Resolver } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { LIMITS, type SoundDownloadFailureReason } from '@monky/shared';
import { isLocalHost, isPublicAddress } from './net/addressPolicy';
import { isSoundAudio, isSoundFileName, isSoundMime, soundFileNameForMime, soundMimeType } from './soundAudioValidation';

export class SoundDownloadError extends Error {
  constructor(public readonly reason: SoundDownloadFailureReason) { super(reason); }
}

interface Address { address: string; family: 4 | 6 }
export interface SoundDownloadTransport {
  resolve(host: string, signal: AbortSignal): Promise<Address[]>;
  request(url: URL, address: Address, signal: AbortSignal): Promise<{
    status: number; headers: IncomingHttpHeaders; body: Readable;
  }>;
}

export function soundDownloadUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SoundDownloadError('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname ||
      (url.port && url.port !== '443')) throw new SoundDownloadError('blocked_url');
  if (isLocalHost(url.hostname)) throw new SoundDownloadError('blocked_url');
  return url;
}

export const nativeSoundTransport: SoundDownloadTransport = {
  async resolve(host, signal) {
    if (isIP(host)) return [{ address: host, family: isIP(host) === 4 ? 4 : 6 }];
    const resolver = new Resolver({ timeout: 5000, tries: 1 });
    const cancel = () => resolver.cancel();
    signal.throwIfAborted();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
      signal.throwIfAborted();
      const addresses: Address[] = [];
      if (v4.status === 'fulfilled') addresses.push(...v4.value.map((address): Address => ({ address, family: 4 })));
      if (v6.status === 'fulfilled') addresses.push(...v6.value.map((address): Address => ({ address, family: 6 })));
      if (!addresses.length) throw new SoundDownloadError('network_error');
      return addresses;
    } finally { signal.removeEventListener('abort', cancel); }
  },
  request(url, address, signal) {
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method: 'GET', agent: false, signal, family: address.family, rejectUnauthorized: true,
        headers: { 'User-Agent': 'Monky/1.0 (local sound download)', Accept: 'audio/*, application/ogg', 'Accept-Encoding': 'identity' },
        // Preserve HTTPS Host/SNI but never perform a second, rebound DNS lookup.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
      request.once('error', reject);
      request.once('close', () => request.removeListener('error', reject));
      request.end();
    });
  },
};

export async function fetchSoundAudio(
  input: { url: string; fileName?: string },
  signal: AbortSignal,
  transport: SoundDownloadTransport = nativeSoundTransport,
  progress?: (receivedBytes: number, totalBytes?: number) => void
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (input.fileName !== undefined && !isSoundFileName(input.fileName)) {
    throw new SoundDownloadError('invalid_file_name');
  }
  let url = soundDownloadUrl(input.url);
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await transport.resolve(host, signal);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address.address))) {
      throw new SoundDownloadError('blocked_url');
    }
    const response = await transport.request(url, addresses[0], signal);
    try {
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === 5 || !response.headers.location) throw new SoundDownloadError('http_error');
        let target: URL;
        try { target = new URL(response.headers.location, url); } catch { throw new SoundDownloadError('invalid_url'); }
        url = soundDownloadUrl(target.href);
        continue;
      }
      if (response.status !== 200) throw new SoundDownloadError('http_error');
      const contentType = String(response.headers['content-type'] ?? '');
      const fileName = input.fileName ?? soundFileNameForMime(contentType);
      const mimeType = fileName ? soundMimeType(fileName) : undefined;
      if (!fileName || !mimeType || !isSoundMime(fileName, contentType) ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        throw new SoundDownloadError('unsupported_audio');
      }
      const rawLength = response.headers['content-length'];
      const total = typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
      if (total !== undefined && (!Number.isSafeInteger(total) || total > LIMITS.MAX_SOUNDBOARD_FILE_SIZE)) {
        throw new SoundDownloadError('too_large');
      }
      let received = 0;
      const chunks: Buffer[] = [];
      progress?.(0, total);
      const stop = () => response.body.destroy();
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new SoundDownloadError('unsupported_audio');
          received += chunk.byteLength;
          if (received > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) throw new SoundDownloadError('too_large');
          chunks.push(Buffer.from(chunk));
          progress?.(received, total);
        }
      } finally { signal.removeEventListener('abort', stop); }
      signal.throwIfAborted();
      if (total !== undefined && received !== total) throw new SoundDownloadError('network_error');
      const bytes = Buffer.concat(chunks, received);
      if (!isSoundAudio(bytes, fileName)) throw new SoundDownloadError('unsupported_audio');
      return { bytes, mimeType };
    } finally { response.body.destroy(); }
  }
  throw new SoundDownloadError('http_error');
}
