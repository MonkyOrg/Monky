import { createHash } from 'crypto';
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  MONKY_RELEASE_HOSTS, TrustedFetchError, fetchTrusted, isReleaseVersion, linkedSignal, parseSha256Manifest, readLimitedText,
} from '@monky/shared';
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

const MAX_PACKAGE_BYTES = 350 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 256 * 1024;

export function validateCliArtifact(artifact: CliReleaseArtifact): void {
  if (!isReleaseVersion(artifact.version) ||
      artifact.name !== `monky-cli-${artifact.version}.tgz` ||
      artifact.url !== `https://github.com/MonkyOrg/Monky/releases/download/v${artifact.version}/${artifact.name}` ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_PACKAGE_BYTES ||
      (artifact.digest != null && (artifact.digest.length !== 71 || !/^sha256:[a-fA-F0-9]{64}$/.test(artifact.digest)))) {
    throw new Error(t('update.invalidArtifact'));
  }
}

function requestArtifact(url: string, signal: AbortSignal, request: typeof fetch): Promise<Response> {
  return fetchTrusted(url, { hosts: MONKY_RELEASE_HOSTS, signal, request, headers: { 'User-Agent': 'monky-cli' } });
}

/** An HTTP failure keeps its status; anything else about the release files means the artifact cannot be trusted. */
function transferFailure(error: unknown): unknown {
  if (!(error instanceof TrustedFetchError)) return error;
  return new Error(error.failure === 'http'
    ? t('update.downloadFailed', { reason: `HTTP ${error.status}` })
    : t('update.invalidArtifact'));
}

async function artifactChecksum(
  artifact: CliReleaseArtifact, signal: AbortSignal, request: typeof fetch,
): Promise<string> {
  if (artifact.digest) return artifact.digest.slice('sha256:'.length).toLowerCase();
  const url = `https://github.com/MonkyOrg/Monky/releases/download/v${artifact.version}/checksums-sha256.txt`;
  const manifest = await readLimitedText(await requestArtifact(url, signal, request), MAX_CHECKSUMS_BYTES);
  const checksum = parseSha256Manifest(manifest, artifact.name);
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
  const transfer = linkedSignal(options.signal, {
    ms: options.timeoutMs ?? 600_000, reason: () => new Error('Download deadline exceeded.'),
  });
  const request = options.request ?? globalThis.fetch;
  try {
    const checksum = await artifactChecksum(artifact, transfer.signal, request);
    const response = await requestArtifact(artifact.url, transfer.signal, request);
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
      signal: transfer.signal,
    });
    options.onVerifying?.();
    if (received !== artifact.size || hash.digest('hex') !== checksum) throw new Error(t('update.invalidArtifact'));
  } catch (error) {
    throw transferFailure(error);
  } finally {
    // Also tears down a body the failure left half-read.
    transfer.abort();
    transfer.dispose();
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
