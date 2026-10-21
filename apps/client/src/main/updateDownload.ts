import fs from 'node:fs';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export async function downloadToFile(
  address: string, destination: string, signal: AbortSignal, onProgress: (percent: number) => void,
): Promise<void> {
  let url = new URL(address);
  const partial = `${destination}.part`;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname)) {
        throw new Error('Untrusted update download location.');
      }
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        https.get(url, { signal, headers: { 'User-Agent': 'Monky-App' } }, resolve).once('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        url = new URL(response.headers.location, url);
        continue;
      }
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error(`HTTP ${response.statusCode}`);
      }
      const total = Number(response.headers['content-length']);
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0 && !signal.aborted) onProgress(Math.min(100, Math.round(received / total * 100)));
      });
      await pipeline(response, fs.createWriteStream(partial), { signal });
      signal.throwIfAborted();
      await fs.promises.rename(partial, destination);
      return;
    }
    throw new Error('Too many update download redirects.');
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    throw error;
  }
}
