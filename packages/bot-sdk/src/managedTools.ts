import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export type ManagedToolRepository = 'yt-dlp/yt-dlp' | 'yt-dlp/FFmpeg-Builds' | 'eugeneware/ffmpeg-static';

export interface ManagedToolAsset {
  name: string;
  url: string;
  size: number;
  sha256: string;
  version: string;
}

export interface ManagedToolDownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  done?: boolean;
}

export interface ManagedToolDownloadCallbacks {
  onProgress?: (progress: ManagedToolDownloadProgress) => void;
  onVerify?: () => void;
}

export type ManagedToolDownloadFailure =
  | 'downloadOrigin' | 'downloadRedirects' | 'downloadRedirectMissing' | 'downloadHttp'
  | 'responseEmpty' | 'responseTooLarge' | 'releaseInvalid' | 'assetInvalid'
  | 'checksumMissing' | 'checksumAmbiguous' | 'metadataInvalid' | 'downloadEmpty'
  | 'downloadTooLarge' | 'downloadWriteFailed' | 'downloadMismatch' | 'archiveUnsupported';

export class ManagedToolDownloadError extends Error {
  constructor(
    readonly code: ManagedToolDownloadFailure,
    readonly parameters: Record<string, string | number> = {},
  ) {
    super(`Managed tool download failed: ${code}`);
    this.name = 'ManagedToolDownloadError';
  }
}

export const MANAGED_TOOL_MAX_DOWNLOAD = 350 * 1024 * 1024;
export const MANAGED_NODE_VERSION = '24.20.0';
const REPOSITORIES = new Set<string>(['yt-dlp/yt-dlp', 'yt-dlp/FFmpeg-Builds', 'eugeneware/ffmpeg-static']);
const HOSTS = new Set([
  'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'nodejs.org',
]);

function approvedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ManagedToolDownloadError('downloadOrigin');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !HOSTS.has(url.hostname)) {
    throw new ManagedToolDownloadError('downloadOrigin');
  }
  return url;
}

async function openResponse(
  value: string, signal: AbortSignal, method: 'GET' | 'HEAD' = 'GET', redirects = 0,
): Promise<Response> {
  if (redirects > 5) throw new ManagedToolDownloadError('downloadRedirects');
  signal.throwIfAborted();
  const url = approvedUrl(value);
  const response = await fetch(url, {
    signal, method, redirect: 'manual',
    headers: { 'User-Agent': 'monky-managed-tools', Accept: 'application/vnd.github+json' },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new ManagedToolDownloadError('downloadRedirectMissing');
    return openResponse(new URL(location, url).href, signal, method, redirects + 1);
  }
  if (response.status !== 200 || method === 'GET' && !response.body) {
    await response.body?.cancel();
    throw new ManagedToolDownloadError('downloadHttp', { status: response.status });
  }
  return response;
}

async function readText(url: string, signal: AbortSignal, limit = 2 * 1024 * 1024): Promise<string> {
  const response = await openResponse(url, signal);
  if (!response.body) throw new ManagedToolDownloadError('responseEmpty');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new ManagedToolDownloadError('responseTooLarge');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checksumFromManifest(manifest: string, name: string): string {
  const matches = manifest.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line))
    .filter((entry) => entry?.[2] === name);
  if (matches.length !== 1 || !matches[0]) throw new ManagedToolDownloadError('checksumAmbiguous', { name });
  return matches[0][1];
}

export async function findManagedToolAsset(
  repository: ManagedToolRepository, name: string, signal: AbortSignal,
): Promise<ManagedToolAsset> {
  if (!REPOSITORIES.has(repository) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(name)) {
    throw new ManagedToolDownloadError('downloadOrigin');
  }
  const text = await readText(`https://api.github.com/repos/${repository}/releases/latest`, signal);
  const release: unknown = JSON.parse(text);
  if (!record(release) || release.draft !== false || release.prerelease !== false ||
      typeof release.tag_name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(release.tag_name) ||
      !Array.isArray(release.assets)) throw new ManagedToolDownloadError('releaseInvalid');
  const version = release.tag_name;
  const prefix = `https://github.com/${repository}/releases/download/${version}/`;
  const matches = release.assets.filter((asset: unknown) => record(asset) && asset.name === name);
  const asset: unknown = matches[0];
  if (matches.length !== 1 || !record(asset) || asset.browser_download_url !== `${prefix}${name}` ||
      typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 || asset.size > MANAGED_TOOL_MAX_DOWNLOAD) {
    throw new ManagedToolDownloadError('assetInvalid', { name });
  }
  let sha256 = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest)
    ? asset.digest.slice(7) : undefined;
  if (!sha256) {
    if (repository === 'eugeneware/ffmpeg-static') throw new ManagedToolDownloadError('checksumMissing');
    const checksumName = repository === 'yt-dlp/yt-dlp' ? 'SHA2-256SUMS' : 'checksums.sha256';
    const checksums = release.assets.filter((entry: unknown) => record(entry) &&
      entry.name === checksumName && entry.browser_download_url === `${prefix}${checksumName}`);
    if (checksums.length !== 1) throw new ManagedToolDownloadError('checksumMissing');
    sha256 = checksumFromManifest(await readText(`${prefix}${checksumName}`, signal, 1024 * 1024), name);
  }
  return { name, url: `${prefix}${name}`, size: asset.size, sha256, version };
}

export function managedNodeArtifact(platform: NodeJS.Platform, arch: string): { name: string; entry: string | null } {
  if (arch !== 'x64' && arch !== 'arm64') throw new ManagedToolDownloadError('assetInvalid', { name: `${platform}-${arch}` });
  if (platform === 'win32') return { name: `win-${arch}/node.exe`, entry: null };
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new ManagedToolDownloadError('assetInvalid', { name: `${platform}-${arch}` });
  }
  const root = `node-v${MANAGED_NODE_VERSION}-${platform}-${arch}`;
  return { name: `${root}.tar.gz`, entry: `${root}/bin/node` };
}

export async function findManagedNodeAsset(
  platform: NodeJS.Platform, arch: string, signal: AbortSignal,
): Promise<ManagedToolAsset> {
  const { name } = managedNodeArtifact(platform, arch);
  const version = `v${MANAGED_NODE_VERSION}`;
  const prefix = `https://nodejs.org/dist/${version}/`;
  const manifest = await readText(`${prefix}SHASUMS256.txt`, signal, 1024 * 1024);
  const sha256 = checksumFromManifest(manifest, name);
  const url = `${prefix}${name}`;
  const response = await openResponse(url, signal, 'HEAD');
  const contentLength = response.headers.get('content-length');
  await response.body?.cancel();
  const size = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : 0;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MANAGED_TOOL_MAX_DOWNLOAD) {
    throw new ManagedToolDownloadError('assetInvalid', { name });
  }
  return { name, url, size, sha256, version };
}

export async function downloadManagedToolAsset(
  asset: ManagedToolAsset, destination: string, signal: AbortSignal, callbacks: ManagedToolDownloadCallbacks = {},
): Promise<void> {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MANAGED_TOOL_MAX_DOWNLOAD ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new ManagedToolDownloadError('metadataInvalid');
  approvedUrl(asset.url);
  signal.throwIfAborted();
  const output = await fs.open(destination, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    const response = await openResponse(asset.url, signal);
    if (!response.body) throw new ManagedToolDownloadError('downloadEmpty');
    const reader = response.body.getReader();
    try {
      callbacks.onProgress?.({ receivedBytes: 0, totalBytes: asset.size });
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > asset.size) throw new ManagedToolDownloadError('downloadTooLarge');
        digest.update(next.value);
        let offset = 0;
        while (offset < next.value.byteLength) {
          signal.throwIfAborted();
          const written = await output.write(next.value, offset, next.value.byteLength - offset);
          if (!written.bytesWritten) throw new ManagedToolDownloadError('downloadWriteFailed');
          offset += written.bytesWritten;
        }
        callbacks.onProgress?.({ receivedBytes: bytes, totalBytes: asset.size });
      }
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
    signal.throwIfAborted();
    callbacks.onProgress?.({ receivedBytes: bytes, totalBytes: asset.size, done: true });
    signal.throwIfAborted();
    callbacks.onVerify?.();
    signal.throwIfAborted();
    if (bytes !== asset.size || digest.digest('hex') !== asset.sha256) {
      throw new ManagedToolDownloadError('downloadMismatch');
    }
    await output.sync();
  } finally {
    await output.close();
  }
  signal.throwIfAborted();
}

export function managedFfmpegArchiveEntry(archiveName: string): string {
  const linux = /^(ffmpeg-master-latest-linux(?:64|arm64)-gpl)\.tar\.xz$/.exec(archiveName);
  if (linux && linux[0] === archiveName) return `${linux[1]}/bin/ffmpeg`;
  const windows = /^(ffmpeg-master-latest-win(?:32|64|arm64)-gpl)\.zip$/.exec(archiveName);
  if (windows && windows[0] === archiveName) return `${windows[1]}/bin/ffmpeg.exe`;
  throw new ManagedToolDownloadError('archiveUnsupported');
}
