import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { list } from 'tar';
import {
  httpsUpdateUrl, isBotVersion, isRecord, releaseAssetName,
  type BotPackageDefinition, type GitHubReleaseSource, type HttpsUpdateSource,
} from '../tooling/config';

const GITHUB_API = 'https://api.github.com';
const JSON_ACCEPT = 'application/vnd.github+json';
const ASSET_ACCEPT = 'application/octet-stream';
const JSON_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 2_000_000;
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_RELEASE_PAGES = 20;

class UpdateArchiveError extends Error {}

function archiveFailure(error: unknown, message: string): Error {
  if (error instanceof UpdateArchiveError) return error;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const safeCodes = [
    'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EEXIST', 'ELOOP', 'ETIMEDOUT', 'ECONNRESET',
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE',
    'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ];
  return new Error(`${message}${safeCodes.includes(code) ? ` (${code})` : ''}`);
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number | bigint>;
}

export interface ReleaseInfo {
  version: string;
  tagName: string;
  htmlUrl: string;
  assetId: number;
  assetName: string;
  repository: string;
}

export interface VerifiedTarballManifest {
  name: string;
  version: string;
  cliName?: string;
}

interface HttpJsonResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function requestHeaders(token: string | null, accept: string): Record<string, string> {
  return {
    'User-Agent': 'monky-bot-sdk-cli',
    Accept: accept,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function normalizeVersion(value: string): string | null {
  const version = value.startsWith('v') ? value.slice(1) : value;
  return isBotVersion(version) ? version : null;
}

function parseIdentifier(value: string): string | number | bigint {
  if (!/^\d+$/.test(value)) return value;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : BigInt(value);
}

export function parseVersion(value: string): ParsedVersion | null {
  const normalized = normalizeVersion(value);
  if (!normalized) return null;
  const [withoutBuild] = normalized.split('+', 1);
  const separator = withoutBuild.indexOf('-');
  const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease = separator === -1 ? '' : withoutBuild.slice(separator + 1);
  const [major, minor, patch] = core.split('.').map(Number);
  return {
    major,
    minor,
    patch,
    prerelease: prerelease ? prerelease.split('.').map(parseIdentifier) : [],
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid bot version: ${!a ? left : right}`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    if (leftId === rightId) continue;
    if (typeof leftId !== 'string' && typeof rightId !== 'string') return leftId < rightId ? -1 : 1;
    if (typeof leftId !== 'string') return -1;
    if (typeof rightId !== 'string') return 1;
    return leftId < rightId ? -1 : 1;
  }
  return 0;
}

function environmentToken(tokenEnv: string, env: NodeJS.ProcessEnv): string | null {
  const direct = env[tokenEnv];
  if (typeof direct !== 'string' || !direct.trim()) return null;
  if (direct.length > 8192 || !/^[\x21-\x7e]+$/.test(direct)) {
    throw new Error(`The update credential in ${tokenEnv} must be a single header-safe token.`);
  }
  return direct;
}

function releaseToken(tokenEnv: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = environmentToken(tokenEnv, env);
  if (direct) return direct;
  if (tokenEnv === 'GH_TOKEN') {
    return environmentToken('GITHUB_TOKEN', env);
  }
  return null;
}

async function githubJson(url: string, token: string | null): Promise<HttpJsonResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      let activeResponse: IncomingMessage | undefined;
      const request = https.get(url, { headers: requestHeaders(token, JSON_ACCEPT), rejectUnauthorized: true }, (response) => {
        activeResponse = response;
        response.on('error', reject);
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.destroy();
          resolve({ statusCode, headers: response.headers, body: '' });
          return;
        }
        let body = '';
        let received = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          received += Buffer.byteLength(chunk, 'utf8');
          if (received > MAX_JSON_BYTES) {
            response.destroy(new UpdateArchiveError('GitHub releases response exceeded the size limit.'));
            return;
          }
          body += chunk;
        });
        response.on('end', () => resolve({ statusCode, headers: response.headers, body }));
        response.on('aborted', () => reject(new UpdateArchiveError('GitHub releases response was aborted.')));
      });
      const timedOut = (): void => {
        const error = new UpdateArchiveError('Timed out while contacting the GitHub API.');
        activeResponse?.destroy(error);
        request.destroy(error);
        reject(error);
      };
      request.on('error', reject);
      timer = setTimeout(timedOut, JSON_TIMEOUT_MS);
      request.setTimeout(JSON_TIMEOUT_MS, timedOut);
    });
  } catch (error: unknown) {
    throw archiveFailure(error, 'Could not contact the GitHub releases API.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trustedRedirectHost(hostname: string): boolean {
  return hostname === 'github.com' ||
    hostname === 'api.github.com' ||
    hostname === 'github-releases.githubusercontent.com' ||
    hostname === 'objects.githubusercontent.com' ||
    hostname.endsWith('.githubusercontent.com');
}

function assetResponse(url: URL, token: string | null, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let activeResponse: IncomingMessage | undefined;
    const request = https.get(url, {
      headers: requestHeaders(token, ASSET_ACCEPT), rejectUnauthorized: true, signal,
    }, (response) => {
      activeResponse = response;
      response.on('error', () => {});
      resolve(response);
    });
    request.on('error', (error) => {
      if (activeResponse) activeResponse.destroy(error);
      else reject(error);
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () =>
      request.destroy(new UpdateArchiveError('Timed out while downloading the update archive.')));
  });
}

function boundedTarball(): Transform {
  let written = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > MAX_TARBALL_BYTES) {
        callback(new UpdateArchiveError('Update archive exceeded the download size limit.'));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function downloadToFile(url: URL, file: string, token: string | null, github: boolean): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DOWNLOAD_TIMEOUT_MS);
  let current = url;
  let includeAuth = true;
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await assetResponse(current, includeAuth ? token : null, abort.signal);
      const statusCode = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = response.headers.location;
        response.destroy();
        if (typeof location !== 'string' || location.length > 8192 || redirects >= 5) {
          throw new UpdateArchiveError('The update source returned an invalid or excessive asset redirect.');
        }
        let target: URL;
        try {
          if (/[\\\u0000-\u0020\u007f]/.test(location) || /^(?:https?:)?\/\/[^/]*@/i.test(location)) {
            throw new Error('Invalid redirect.');
          }
          target = new URL(location, current);
        } catch {
          throw new UpdateArchiveError('The update source returned an invalid asset redirect URL.');
        }
        if (target.protocol !== 'https:' || target.username || target.password || target.hash ||
            (github ? !trustedRedirectHost(target.hostname) || !!target.port : target.origin !== url.origin)) {
          throw new UpdateArchiveError(github
            ? 'GitHub redirected the release asset to an untrusted host.'
            : 'HTTPS update redirects must remain on the configured HTTPS origin without embedded credentials.');
        }
        current = target;
        if (github) includeAuth = false;
        continue;
      }
      if (statusCode !== 200) {
        response.destroy();
        throw new UpdateArchiveError(`Update archive download failed with HTTP ${statusCode}.`);
      }
      const headerLength = response.headers['content-length'];
      if (typeof headerLength === 'string' && Number(headerLength) > MAX_TARBALL_BYTES) {
        response.destroy();
        throw new UpdateArchiveError('Update archive exceeds the download size limit.');
      }
      await pipeline(response, boundedTarball(), fs.createWriteStream(file, { mode: 0o600, flags: 'wx' }));
      return;
    }
  } catch (error: unknown) {
    if (abort.signal.aborted) throw new Error('Timed out while downloading the update archive.');
    throw archiveFailure(error, 'Update archive download failed.');
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadHttpsUpdateArchive(
  source: HttpsUpdateSource,
  destinationFile: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const url = new URL(httpsUpdateUrl(source.url));
  const token = source.tokenEnv ? environmentToken(source.tokenEnv, env) : null;
  if (source.tokenEnv && !token) throw new Error(`Set ${source.tokenEnv} before fetching this HTTPS update source.`);
  await downloadToFile(url, destinationFile, token, false);
}

export async function copyLocalUpdateArchive(file: string, destinationFile: string): Promise<void> {
  let descriptor: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expected = fs.lstatSync(file);
    if (!expected.isFile()) throw new UpdateArchiveError('The local update archive must be a regular file, not a directory or symbolic link.');
    const flags = fs.constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    descriptor = fs.openSync(file, flags);
    const original = fs.fstatSync(descriptor);
    if (!original.isFile() || original.dev !== expected.dev || original.ino !== expected.ino) {
      throw new UpdateArchiveError('The local update archive changed before it could be copied.');
    }
    if (original.size > MAX_TARBALL_BYTES) throw new UpdateArchiveError('The local update archive exceeds the size limit.');
    const input = fs.createReadStream(file, { fd: descriptor, autoClose: false });
    timer = setTimeout(() => input.destroy(new UpdateArchiveError('Timed out while copying the local update archive.')), DOWNLOAD_TIMEOUT_MS);
    await pipeline(input, boundedTarball(), fs.createWriteStream(destinationFile, { mode: 0o600, flags: 'wx' }));
    const after = fs.fstatSync(descriptor);
    if (after.size !== original.size || after.mtimeMs !== original.mtimeMs || after.ctimeMs !== original.ctimeMs ||
        fs.statSync(destinationFile).size !== original.size) {
      throw new UpdateArchiveError('The local update archive changed while being copied; retry with a complete .tgz file.');
    }
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') throw new Error('The configured local update archive is missing.');
    throw archiveFailure(error, 'Could not read or copy the configured local update archive.');
  } finally {
    if (timer) clearTimeout(timer);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function selectRelease(definition: BotPackageDefinition, data: unknown, includePrerelease: boolean): ReleaseInfo | null {
  if (!Array.isArray(data)) throw new Error('GitHub releases response must be an array.');
  let selected: ReleaseInfo | null = null;
  for (const entry of data) {
    if (!isRecord(entry) || entry.draft === true || typeof entry.tag_name !== 'string') continue;
    const version = normalizeVersion(entry.tag_name);
    if (!version) continue;
    const parsedVersion = parseVersion(version);
    if (!parsedVersion) continue;
    const prerelease = parsedVersion.prerelease.length > 0;
    if (!includePrerelease && prerelease) continue;
    if (typeof entry.prerelease === 'boolean' && entry.prerelease !== prerelease) continue;
    const expectedAssetName = releaseAssetName(definition, version);
    const asset = Array.isArray(entry.assets)
      ? entry.assets.find((candidate: unknown) =>
        isRecord(candidate) &&
        typeof candidate.id === 'number' &&
        Number.isSafeInteger(candidate.id) &&
        candidate.id > 0 &&
        candidate.name === expectedAssetName)
      : undefined;
    if (!asset || typeof asset.id !== 'number') continue;
    const htmlUrl = definition.releases?.url
      ? `${definition.releases.url}/tag/${encodeURIComponent(entry.tag_name)}` : '';
    const release: ReleaseInfo = {
      version,
      tagName: entry.tag_name,
      htmlUrl,
      assetId: asset.id,
      assetName: expectedAssetName,
      repository: definition.releases?.repository ?? '',
    };
    if (!selected || compareVersions(release.version, selected.version) > 0) selected = release;
  }
  return selected;
}

export async function fetchLatestRelease(
  source: GitHubReleaseSource,
  definition: BotPackageDefinition,
  includePrerelease: boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<ReleaseInfo | null> {
  const token = releaseToken(source.tokenEnv, env);
  const releases: unknown[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const url = `${GITHUB_API}/repos/${source.repository}/releases?per_page=100&page=${page}`;
    const response = await githubJson(url, token);
    if (response.statusCode === 404) {
      throw new Error(`GitHub releases for ${source.repository} are not accessible. If the repository is private, set ${source.tokenEnv}${source.tokenEnv === 'GH_TOKEN' ? ' or GITHUB_TOKEN' : ''}.`);
    }
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error(`GitHub denied access to ${source.repository} (HTTP ${response.statusCode}). Check ${source.tokenEnv}${source.tokenEnv === 'GH_TOKEN' ? ' or GITHUB_TOKEN' : ''}.`);
    }
    if (response.statusCode !== 200) {
      throw new Error(`GitHub releases lookup failed with HTTP ${response.statusCode}.`);
    }
    let pageData: unknown;
    try {
      pageData = JSON.parse(response.body);
    } catch {
      throw new Error('GitHub returned invalid JSON while listing releases.');
    }
    if (!Array.isArray(pageData)) throw new Error('GitHub releases response must be an array.');
    releases.push(...pageData);
    if (pageData.length < 100) break;
    if (page === MAX_RELEASE_PAGES) throw new Error('GitHub returned too many releases to inspect safely.');
  }
  return selectRelease(definition, releases, includePrerelease);
}

export async function downloadReleaseAsset(
  source: GitHubReleaseSource,
  release: ReleaseInfo,
  destinationFile: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const token = releaseToken(source.tokenEnv, env);
  const assetUrl = new URL(`${GITHUB_API}/repos/${source.repository}/releases/assets/${release.assetId}`);
  await downloadToFile(assetUrl, destinationFile, token, true);
}

function inspectPackageManifest(file: string): VerifiedTarballManifest {
  const info = fs.statSync(file);
  if (!info.isFile()) throw new UpdateArchiveError('The update archive must be a regular .tgz file.');
  if (info.size > MAX_TARBALL_BYTES) {
    throw new UpdateArchiveError('Release asset exceeds the verification size limit.');
  }
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(3);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length ||
        header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8) {
      throw new UpdateArchiveError('The update archive must be a valid gzip-compressed .tgz package.');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  let unpacked = 0;
  let entries = 0;
  let found = false;
  const chunks: Buffer[] = [];
  list({
    file,
    sync: true,
    strict: true,
    maxReadSize: 64 * 1024,
    onReadEntry(entry) {
      unpacked += entry.size;
      entries += 1;
      if (unpacked > MAX_UNPACKED_BYTES || entries > MAX_ARCHIVE_ENTRIES) {
        throw new UpdateArchiveError('Release archive exceeds the unpacked size or entry limit.');
      }
      if (path.posix.normalize(entry.path) !== 'package/package.json') return;
      if (found) throw new UpdateArchiveError('Release archive contains duplicate package/package.json entries.');
      if (entry.type !== 'File' && entry.type !== 'OldFile') {
        throw new UpdateArchiveError('Release archive package.json must be a regular file.');
      }
      if (entry.size > MAX_MANIFEST_BYTES) throw new UpdateArchiveError('Release archive package.json exceeds the size limit.');
      found = true;
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
    },
  });
  if (!found) throw new UpdateArchiveError('Release archive does not contain package/package.json.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UpdateArchiveError('Release archive package.json contains invalid JSON.');
  }
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || !isBotVersion(parsed.version)) {
    throw new UpdateArchiveError('Release archive package.json is missing a valid name/version.');
  }
  const cliName = isRecord(parsed.monkyBot) && typeof parsed.monkyBot.cliName === 'string'
    ? parsed.monkyBot.cliName
    : undefined;
  return { name: parsed.name, version: parsed.version, ...(cliName ? { cliName } : {}) };
}

export function readPackageManifestFromTarball(file: string): VerifiedTarballManifest {
  try {
    return inspectPackageManifest(file);
  } catch (error: unknown) {
    throw archiveFailure(error, 'The update archive is not a readable, valid .tgz package.');
  }
}

export async function withTemporaryDownload<T>(cliName: string, action: (directory: string) => Promise<T> | T): Promise<T> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `${cliName}-update-`));
  try {
    return await action(temporaryDirectory);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
