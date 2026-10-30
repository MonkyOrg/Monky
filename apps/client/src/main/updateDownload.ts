import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { MONKY_RELEASE_HOSTS, isTrustedDownloadUrl } from '@monky/shared';
import { HttpGetError, httpGet } from './net/httpGet';

/** Downloads the macOS installer from the Monky releases on GitHub, every redirect included. */
export async function downloadToFile(
  address: string, destination: string, signal: AbortSignal, onProgress: (percent: number) => void,
): Promise<void> {
  const partial = `${destination}.part`;
  try {
    const response = await httpGet(new URL(address), {
      allows: (url) => isTrustedDownloadUrl(url, MONKY_RELEASE_HOSTS), signal, headers: { 'User-Agent': 'Monky-App' },
    });
    if (response.status !== 200) {
      response.body.resume();
      throw new Error(`HTTP ${response.status}`);
    }
    const total = Number(response.headers['content-length']);
    let received = 0;
    response.body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (total > 0 && !signal.aborted) onProgress(Math.min(100, Math.round(received / total * 100)));
    });
    await pipeline(response.body, fs.createWriteStream(partial), { signal });
    signal.throwIfAborted();
    await fs.promises.rename(partial, destination);
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    if (error instanceof HttpGetError) {
      throw new Error(error.failure === 'redirects' ? 'Too many update download redirects.' : 'Untrusted update download location.');
    }
    throw error;
  }
}
