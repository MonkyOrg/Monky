import type { ReleaseNotesResult } from '@monky/shared';

const REPOSITORY = 'MonkyOrg/Monky';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;

/** Keep release selection tied to the installed version, including beta tags. */
export async function fetchVersionReleaseNotes(installedVersion: string, tag?: string): Promise<ReleaseNotesResult> {
  const version = (tag?.trim() || installedVersion).replace(/^v/i, '');
  if (version.length > 128 || !VERSION.test(version)) {
    return { ok: false, error: 'Invalid release version' };
  }
  const normalized = `v${version}`;
  const url = `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(normalized)}`;
  try {
    const response = await fetch(
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
