import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Versions that mean "unknown", not a real release.
 *
 * The repository never bumps `package.json` — releases exist only as git tags —
 * so every checked-out manifest reads `1.0.0`. Trusting it would report a
 * two-year-old placeholder as the running version.
 */
const PLACEHOLDER_VERSIONS = new Set(['0.0.0', '1.0.0']);

/** How far up from the compiled file to look for the server's own manifest. */
const MAX_LOOKUP_DEPTH = 6;

let cached: string | null | undefined;

function readVersionFrom(pkgFile: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { name?: string; version?: string };
    // The published CLI tarball keeps the workspace name, so the same check
    // works for a global install and for a source checkout.
    if (pkg.name !== '@monky/server') return null;
    if (!pkg.version || PLACEHOLDER_VERSIONS.has(pkg.version)) return null;
    return pkg.version;
  } catch {
    return null;
  }
}

/**
 * Version stamped into the published package.
 *
 * `scripts/pack-cli.js` writes the release version into the tarball's
 * `package.json`, which makes it authoritative for the recommended install.
 * The manifest is located by walking up from the compiled file rather than by
 * a fixed number of `..` segments, so moving this module — or the difference
 * between `dist/infrastructure/version/` in the repo and in the tarball — does
 * not silently break the lookup.
 */
function readPackagedVersion(): string | null {
  let dir = __dirname;
  for (let depth = 0; depth <= MAX_LOOKUP_DEPTH; depth++) {
    const version = readVersionFrom(path.join(dir, 'package.json'));
    if (version) return version;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Version of a source checkout, taken from the nearest tag.
 *
 * Only reached when the manifest holds a placeholder, which is exactly the
 * case of someone running the server straight from the repository.
 */
function readGitVersion(): string | null {
  try {
    const described = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf8',
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return described ? described.replace(/^v/, '') : null;
  } catch {
    // Not a git checkout, git is absent, or the clone has no tags.
    return null;
  }
}

/**
 * Release this server is running, or `null` when it cannot be established.
 *
 * `null` is deliberate: a checkout with no tags genuinely does not know its
 * version, and inventing `0.0.0` for it would show a made-up number to the
 * admin reading the server settings (#559).
 *
 * Cached because the answer cannot change while the process lives, and the git
 * fallback spawns a subprocess.
 */
export function getServerVersion(): string | null {
  if (cached !== undefined) return cached;
  cached = readPackagedVersion() ?? readGitVersion();
  return cached;
}
