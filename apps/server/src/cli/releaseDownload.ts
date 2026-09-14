import { createHash } from 'crypto';
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { isReleaseVersion } from '@monky/shared';
import { t } from './i18n/index';

export interface CliReleaseArtifact {
  version: string;
  name: string;
  url: string;
  size: number;
  digest?: string | null;
}

export interface CliTransferProgress {
  received: number;
  total: number;
}

const TRUSTED_HOSTS = new Set([
  'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
]);
const MAX_PACKAGE_BYTES = 350 * 1024 * 1024;

export function validateCliArtifact(artifact: CliReleaseArtifact): void {
  if (!isReleaseVersion(artifact.version) ||
      artifact.name !== `monky-cli-${artifact.version}.tgz` ||
      artifact.url !== `https://github.com/MonkyOrg/Monky/releases/download/v${artifact.version}/${artifact.name}` ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_PACKAGE_BYTES ||
      (artifact.digest != null && (artifact.digest.length !== 71 || !/^sha256:[a-fA-F0-9]{64}$/.test(artifact.digest)))) {
    throw new Error(t('update.invalidArtifact'));
  }
}

async function requestArtifact(url: string, signal: AbortSignal, request: typeof fetch): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
        !TRUSTED_HOSTS.has(parsed.hostname)) throw new Error(t('update.invalidArtifact'));
    const response = await request(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'monky-cli' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error(t('update.invalidArtifact'));
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(t('update.downloadFailed', { reason: `HTTP ${response.status}` }));
    }
    return response;
  }
  throw new Error(t('update.invalidArtifact'));
}

export function checksumForArtifact(text: string, name: string): string | null {
  const matches = text.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})[ \t]+[* ]?(.+)$/.exec(line);
    return match && (match[2] === name || match[2] === `./${name}`) ? [match[1].toLowerCase()] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

async function artifactChecksum(
  artifact: CliReleaseArtifact, signal: AbortSignal, request: typeof fetch,
): Promise<string> {
  if (artifact.digest) return artifact.digest.slice('sha256:'.length).toLowerCase();
  const url = `https://github.com/MonkyOrg/Monky/releases/download/v${artifact.version}/checksums-sha256.txt`;
  const response = await requestArtifact(url, signal, request);
  if (!response.body) throw new Error(t('update.invalidArtifact'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > 256 * 1024) throw new Error(t('update.invalidArtifact'));
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const checksum = checksumForArtifact(text, artifact.name);
  if (!checksum) throw new Error(t('update.invalidArtifact'));
  return checksum;
}

export async function downloadCliArtifact(
  artifact: CliReleaseArtifact,
  destination: string,
  options: {
    request?: typeof fetch;
    onProgress?: (progress: CliTransferProgress) => void;
    onVerifying?: () => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  validateCliArtifact(artifact);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Download deadline exceeded.')), options.timeoutMs ?? 600_000);
  timer.unref();
  const request = options.request ?? globalThis.fetch;
  try {
    const checksum = await artifactChecksum(artifact, controller.signal, request);
    const response = await requestArtifact(artifact.url, controller.signal, request);
    if (!response.body) throw new Error(t('update.invalidArtifact'));
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== artifact.size) throw new Error(t('update.invalidArtifact'));
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let received = 0;
    options.onProgress?.({ received, total: artifact.size });
    async function* chunks(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > artifact.size) throw new Error(t('update.invalidArtifact'));
          hash.update(chunk.value);
          options.onProgress?.({ received, total: artifact.size });
          yield chunk.value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    await pipeline(Readable.from(chunks()), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), {
      signal: controller.signal,
    });
    options.onVerifying?.();
    if (received !== artifact.size || hash.digest('hex') !== checksum) throw new Error(t('update.invalidArtifact'));
  } finally {
    controller.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function createCliDownloadProgress(
  output: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stdout,
  now: () => number = Date.now,
): { update: (progress: CliTransferProgress) => void; finish: () => void } {
  let last = -Infinity;
  let lastPercent = -1;
  let lineOpen = false;
  const formatBytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return {
    update({ received, total }) {
      const percent = Math.floor(received / total * 100);
      const time = now();
      if (percent !== 100 && (time - last < 100 || percent === lastPercent)) return;
      last = time;
      lastPercent = percent;
      const label = t('update.downloadProgress', {
        received: formatBytes(received), total: formatBytes(total), percent,
      });
      if (output.isTTY) {
        const filled = Math.floor(percent / 5);
        output.write(`\r\x1b[2K[${'#'.repeat(filled)}${'-'.repeat(20 - filled)}] ${label}`);
        lineOpen = true;
      } else if (percent === 0 || percent === 100) {
        output.write(`${label}\n`);
      }
    },
    finish() {
      if (lineOpen) output.write('\n');
      lineOpen = false;
    },
  };
}
