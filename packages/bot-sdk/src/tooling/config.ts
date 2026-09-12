import fs from 'node:fs';
import path from 'node:path';

export type BotMode = 'manual' | 'marketplace';

export interface GitHubReleaseSource {
  url: string;
  repository: string;
  assetName: string;
  tokenEnv: string;
}

export interface BotPackageDefinition {
  cliName: string;
  displayName: string;
  entry: string;
  buildScript: string | null;
  files: string[];
  modes: BotMode[];
  releases?: GitHubReleaseSource;
}

export interface BotPackageManifest extends Record<string, unknown> {
  name: string;
  version: string;
}

export interface BotProject {
  root: string;
  manifest: BotPackageManifest;
  definition: BotPackageDefinition;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBotVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return !!match && match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) &&
    (!match[4] || match[4].split('.').every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')));
}

function stringValue(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

export function relativeBotPath(value: unknown, label: string): string {
  const normalized = stringValue(value, label).replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((part) => part === '..') || /[\u0000*?]/.test(normalized)) {
    throw new Error(`${label} must be a relative file or directory inside the bot project, without glob patterns.`);
  }
  const result = path.posix.normalize(normalized).replace(/^\.\//, '');
  if (!result || result === '.') throw new Error(`${label} cannot include the entire project directory.`);
  return result;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const key = Object.keys(value).find((entry) => !allowed.includes(entry));
  if (key) throw new Error(`Unknown ${label} property: ${key}.`);
}

export function releaseAssetName(definition: BotPackageDefinition, version: string): string {
  if (!isBotVersion(version)) throw new Error('The bot package version must be valid SemVer.');
  return (definition.releases?.assetName ?? `${definition.cliName}-{version}.tgz`).replace('{version}', version);
}

function releaseSource(value: unknown, cliName: string): GitHubReleaseSource | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('monkyBot.releases must be an object or omitted.');
  rejectUnknown(value, ['url', 'assetName', 'tokenEnv'], 'monkyBot.releases');
  let url: URL;
  try { url = new URL(stringValue(value.url, 'monkyBot.releases.url', 2048)); } catch {
    throw new Error('monkyBot.releases.url must point to a GitHub repository or its releases page.');
  }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)(?:\/releases)?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username ||
      url.password || url.search || url.hash || !match || ['.', '..'].includes(match[2])) {
    throw new Error('Updates require an explicit https://github.com/owner/repository/releases URL.');
  }
  const repository = `${match[1]}/${match[2]}`;
  const assetName = value.assetName === undefined
    ? `${cliName}-{version}.tgz` : stringValue(value.assetName, 'monkyBot.releases.assetName', 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._{}+-]*\.tgz$/.test(assetName) ||
      /[{}]/.test(assetName.replace('{version}', '1.0.0')) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(assetName)) {
    throw new Error('The release asset must be a safe .tgz filename, optionally containing one {version} placeholder.');
  }
  const tokenEnv = value.tokenEnv === undefined ? 'GH_TOKEN' : stringValue(value.tokenEnv, 'monkyBot.releases.tokenEnv', 100);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) throw new Error('The GitHub token must be supplied through a named environment variable.');
  return { url: `https://github.com/${repository}/releases`, repository, assetName, tokenEnv };
}

export function loadBotProject(packageRoot: string): BotProject {
  const root = fs.realpathSync(packageRoot);
  const packageFile = path.join(root, 'package.json');
  if (fs.statSync(packageFile).size > 1024 * 1024) throw new Error('The bot package.json exceeds the size limit.');
  let input: unknown;
  try { input = JSON.parse(fs.readFileSync(packageFile, 'utf8')); } catch {
    throw new Error('The bot package.json contains invalid JSON.');
  }
  if (!isRecord(input)) throw new Error('The bot package.json must contain an object.');
  const name = stringValue(input.name, 'package.name', 214);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error('The bot must have a valid npm package name.');
  }
  if (!isBotVersion(input.version)) throw new Error('package.version must be valid SemVer.');
  const manifest: BotPackageManifest = { ...input, name, version: input.version };
  const raw = input.monkyBot === undefined ? {} : input.monkyBot;
  if (!isRecord(raw)) throw new Error('package.monkyBot must contain an object.');
  rejectUnknown(raw, ['cliName', 'displayName', 'entry', 'buildScript', 'files', 'modes', 'releases'], 'monkyBot');
  const cliName = stringValue(raw.cliName ?? name.split('/').pop(), 'monkyBot.cliName', 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(cliName)) throw new Error('monkyBot.cliName must be a safe executable name.');
  const displayName = stringValue(raw.displayName ?? cliName, 'monkyBot.displayName', 32);
  if (displayName.length < 2) throw new Error('monkyBot.displayName must contain at least two characters.');
  const entry = relativeBotPath(raw.entry ?? input.main ?? 'dist/index.js', 'monkyBot.entry');
  const scripts = isRecord(input.scripts) ? input.scripts : {};
  const buildScript = raw.buildScript === false ? null
    : raw.buildScript === undefined ? typeof scripts.build === 'string' ? 'build' : null
      : stringValue(raw.buildScript, 'monkyBot.buildScript', 100);
  if (buildScript && !/^[A-Za-z0-9:_-]+$/.test(buildScript)) throw new Error('monkyBot.buildScript must name an npm script.');
  const defaultFiles = entry.includes('/') ? [entry.split('/')[0]] : [entry];
  const rawFiles = raw.files ?? defaultFiles;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > 100) {
    throw new Error('monkyBot.files must list 1 to 100 relative files or directories.');
  }
  const files = [...new Set(rawFiles.map((file) => relativeBotPath(file, 'monkyBot.files')))];
  const rawModes = raw.modes ?? ['manual'];
  if (!Array.isArray(rawModes) || rawModes.length === 0 || rawModes.length > 2) {
    throw new Error('monkyBot.modes must contain manual, marketplace or both.');
  }
  const modes: BotMode[] = rawModes.map((mode: unknown) => {
    if (mode !== 'manual' && mode !== 'marketplace') throw new Error('Unsupported bot runtime mode.');
    return mode;
  });
  if (new Set(modes).size !== modes.length) throw new Error('monkyBot.modes must not contain duplicates.');
  const releases = releaseSource(raw.releases, cliName);
  return {
    root, manifest,
    definition: { cliName, displayName, entry, buildScript, files, modes, ...(releases ? { releases } : {}) },
  };
}

export function botEntryPath(project: BotProject): string {
  const entry = fs.realpathSync(path.resolve(project.root, project.definition.entry));
  const relative = path.relative(project.root, entry);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) {
    throw new Error('The bot entry must be a built file inside its installed package.');
  }
  return entry;
}
