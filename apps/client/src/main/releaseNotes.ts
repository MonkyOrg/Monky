import { compareReleaseVersions, type ReleaseHistoryEntry, type ReleaseHistoryResult, type ReleaseNotesResult } from '@monky/shared';

const REPOSITORY = 'MonkyOrg/Monky';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
export const RELEASE_HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_PAGE = 50;

/** The updater passes Electron's `net.fetch`, which honours the system proxy like the update check does. */
export type ReleaseRequest = (url: string, init: RequestInit) => Promise<Response>;

const baseVersion = (version: string): string => version.split(/[-+]/)[0];

/**
 * One page of the GitHub release listing, reduced to releases older than
 * `before` (the version already on screen), newest first. Beta and stable
 * builds of the same number carry the same notes, so the caller dedupes them
 * by base version; the stable one sorts first within a page.
 */
export async function fetchReleaseHistory(
  installedVersion: string, page: number, before?: string, request: ReleaseRequest = fetch,
): Promise<ReleaseHistoryResult> {
  const anchor = (before?.trim() || installedVersion).replace(/^v/i, '');
  if (!Number.isInteger(page) || page < 1 || page > MAX_HISTORY_PAGE || anchor.length > 128 || !VERSION.test(anchor)) {
    return { ok: false, error: 'Invalid release history request' };
  }
  try {
    const response = await request(
      `https://api.github.com/repos/${REPOSITORY}/releases?per_page=${RELEASE_HISTORY_PAGE_SIZE}&page=${page}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Monky-App' },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const list: unknown = await response.json();
    if (!Array.isArray(list)) return { ok: false, error: 'Unexpected GitHub release response' };
    const entries: ReleaseHistoryEntry[] = [];
    for (const release of list as unknown[]) {
      if (!release || typeof release !== 'object') continue;
      const { tag_name: tag, body, draft, published_at: publishedAt } = release as Record<string, unknown>;
      if (draft === true || typeof tag !== 'string' || (body !== null && body !== undefined && typeof body !== 'string')) continue;
      const version = tag.replace(/^v/i, '');
      if (tag !== `v${version}` || version.length > 128 || !VERSION.test(version)) continue;
      if (compareReleaseVersions(baseVersion(version), baseVersion(anchor)) >= 0) continue;
      const text = typeof body === 'string' ? body : '';
      if (text.length > 200_000) continue;
      entries.push({
        version,
        body: text,
        url: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`,
        publishedAt: typeof publishedAt === 'string' && !Number.isNaN(Date.parse(publishedAt)) ? publishedAt : null,
      });
    }
    entries.sort((a, b) => compareReleaseVersions(b.version, a.version));
    return { ok: true, entries, hasMore: list.length === RELEASE_HISTORY_PAGE_SIZE && page < MAX_HISTORY_PAGE };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Keep release selection tied to the installed version, including beta tags. */
export async function fetchVersionReleaseNotes(
  installedVersion: string, tag?: string, request: ReleaseRequest = fetch,
): Promise<ReleaseNotesResult> {
  const version = (tag?.trim() || installedVersion).replace(/^v/i, '');
  if (version.length > 128 || !VERSION.test(version)) {
    return { ok: false, error: 'Invalid release version' };
  }
  const normalized = `v${version}`;
  const url = `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(normalized)}`;
  try {
    const response = await request(
      `https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(normalized)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Monky-App' },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) return { ok: false, version, url, error: `HTTP ${response.status}` };
    const release: unknown = await response.json();
    if (!release || typeof release !== 'object' ||
        !('tag_name' in release) || release.tag_name !== normalized ||
        !('body' in release) || (release.body !== null && typeof release.body !== 'string')) {
      return { ok: false, version, url, error: 'Unexpected GitHub release response' };
    }
    const body = release.body ?? '';
    if (body.length > 200_000) {
      return { ok: false, version, url, error: 'Release notes are too large' };
    }
    return { ok: true, version, body, url };
  } catch (error) {
    return { ok: false, version, url, error: error instanceof Error ? error.message : String(error) };
  }
}
