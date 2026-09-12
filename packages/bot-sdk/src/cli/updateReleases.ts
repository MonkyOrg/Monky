import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { list } from 'tar';
import { isBotVersion, isRecord, releaseAssetName, type BotPackageDefinition, type GitHubReleaseSource } from '../tooling/config';

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

function releaseToken(tokenEnv: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env[tokenEnv];
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (tokenEnv === 'GH_TOKEN') {
    const fallback = env.GITHUB_TOKEN;
    if (typeof fallback === 'string' && fallback.trim()) return fallback;
  }
  return null;
}

function githubJson(url: string, token: string | null): Promise<HttpJsonResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: requestHeaders(token, JSON_ACCEPT), rejectUnauthorized: true }, (response) => {
      response.on('error', reject);
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        resolve({ statusCode, headers: response.headers, body: '' });
        return;
      }
      let body = '';
      let received = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        received += Buffer.byteLength(chunk, 'utf8');
        if (received > MAX_JSON_BYTES) {
          request.destroy(new Error('GitHub releases response exceeded the size limit.'));
          return;
        }
        body += chunk;
      });
      response.on('end', () => resolve({ statusCode, headers: response.headers, body }));
      response.on('aborted', () => reject(new Error('GitHub releases response was aborted.')));
    });
    request.on('error', reject);
    request.setTimeout(JSON_TIMEOUT_MS, () => request.destroy(new Error('Timed out while contacting the GitHub API.')));
  });
}

function trustedRedirectHost(hostname: string): boolean {
  return hostname === 'github.com' ||
    hostname === 'api.github.com' ||
    hostname === 'github-releases.githubusercontent.com' ||
    hostname === 'objects.githubusercontent.com' ||
    hostname.endsWith('.githubusercontent.com');
}

function downloadToFile(url: URL, file: string, token: string | null, includeAuth = true, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'https:') {
      reject(new Error('Release downloads must use HTTPS.'));
      return;
    }
    const headers = requestHeaders(includeAuth ? token : null, ASSET_ACCEPT);
    let activeResponse: IncomingMessage | undefined;
    const request = https.get(url, { headers, rejectUnauthorized: true }, (response) => {
      response.on('error', (error) => {
        if (response !== activeResponse) reject(error);
      });
      const statusCode = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        const location = response.headers.location;
        if (typeof location !== 'string' || redirects >= 5) {
          reject(new Error('GitHub returned an invalid asset redirect.'));
          return;
        }
        let target: URL;
        try {
          target = new URL(location, url);
        } catch {
          reject(new Error('GitHub returned an invalid asset redirect URL.'));
          return;
        }
        if (target.protocol !== 'https:' || !trustedRedirectHost(target.hostname) ||
            target.username || target.password || target.hash || (target.port && target.port !== '443')) {
          reject(new Error('GitHub redirected the release asset to an untrusted host.'));
          return;
        }
        void downloadToFile(target, file, token, false, redirects + 1).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub asset download failed with HTTP ${statusCode}.`));
        return;
      }
      const headerLength = response.headers['content-length'];
      if (typeof headerLength === 'string' && Number(headerLength) > MAX_TARBALL_BYTES) {
        response.resume();
        reject(new Error('Release asset exceeds the download size limit.'));
        return;
      }
      let written = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written > MAX_TARBALL_BYTES) {
            callback(new Error('Release asset exceeded the download size limit.'));
            return;
          }
          callback(null, chunk);
        },
      });
      activeResponse = response;
      const transfer = pipeline(response, bounded, fs.createWriteStream(file, { mode: 0o600, flags: 'wx' }));
      void transfer.then(resolve, reject);
    });
    request.on('error', (error) => {
      if (activeResponse) activeResponse.destroy(error);
      else reject(error);
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error('Timed out while downloading the release asset.')));
  });
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
    const htmlUrl = typeof entry.html_url === 'string'
      ? entry.html_url
      : definition.releases?.url ? `${definition.releases.url.replace(/\/releases\/?$/, '')}/releases/tag/${entry.tag_name}` : '';
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
  await downloadToFile(assetUrl, destinationFile, token);
}

export function readPackageManifestFromTarball(file: string): VerifiedTarballManifest {
  if (fs.statSync(file).size > MAX_TARBALL_BYTES) {
    throw new Error('Release asset exceeds the verification size limit.');
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
        throw new Error('Release archive exceeds the unpacked size or entry limit.');
      }
      if (path.posix.normalize(entry.path) !== 'package/package.json') return;
      if (found) throw new Error('Release archive contains duplicate package/package.json entries.');
      if (entry.type !== 'File' && entry.type !== 'OldFile') {
        throw new Error('Release archive package.json must be a regular file.');
      }
      if (entry.size > MAX_MANIFEST_BYTES) throw new Error('Release archive package.json exceeds the size limit.');
      found = true;
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
    },
  });
  if (!found) throw new Error('Release archive does not contain package/package.json.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Release archive package.json contains invalid JSON.');
  }
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || !isBotVersion(parsed.version)) {
    throw new Error('Release archive package.json is missing a valid name/version.');
  }
  const cliName = isRecord(parsed.monkyBot) && typeof parsed.monkyBot.cliName === 'string'
    ? parsed.monkyBot.cliName
    : undefined;
  return { name: parsed.name, version: parsed.version, ...(cliName ? { cliName } : {}) };
}

export async function withTemporaryDownload<T>(cliName: string, action: (directory: string) => Promise<T> | T): Promise<T> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `${cliName}-update-`));
  try {
    return await action(temporaryDirectory);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
