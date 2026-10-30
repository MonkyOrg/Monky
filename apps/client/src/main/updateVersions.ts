import { compareReleaseVersions, pickNewestRelease } from '@monky/shared';

/**
 * Version arithmetic and release selection for the in-app updater, kept free of
 * any Electron import so it can be unit tested (#354). Versions are ordered by
 * `compareReleaseVersions`, the same order the server CLI and the bot SDK use.
 */

const GITHUB_REPO = 'MonkyOrg/Monky';

export interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

export function cleanVer(v?: string): string {
  return String(v ?? '')
    .replace(/^v/i, '')
    .trim();
}

export function isNewer(latest: string, current: string): boolean {
  return compareReleaseVersions(latest, current) > 0;
}

/**
 * Highest-versioned release of a GitHub listing, ignoring drafts and untagged
 * entries; anything that is not a list has none.
 */
export function pickBestRelease(list: unknown): GithubRelease | null {
  return Array.isArray(list) ? pickNewestRelease<GithubRelease>(list) : null;
}

/**
 * Update feed for one release. Its assets are published side by side under a
 * per-tag path, so that folder works as a "generic" electron-updater feed:
 * `latest.yml` sits next to the installer it describes, and the manifest
 * references the installer by a relative name.
 */
export function feedUrlForTag(tag: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}`;
}
