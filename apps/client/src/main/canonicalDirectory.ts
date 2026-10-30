import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Whether two absolute paths name the same entry; Windows compares them case-insensitively. */
export function samePath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? path.normalize(first).toLowerCase() === path.normalize(second).toLowerCase()
    : path.normalize(first) === path.normalize(second);
}

/**
 * The path the filesystem reports for a folder Monky owns, created first when asked.
 *
 * Every later "is this still our folder?" check compares `realpath()` with a path built from this
 * anchor, and the native capture helper refuses any redirected component. A junction or symbolic link
 * the user placed above the profile (AppData moved to another drive, a `--user-data-dir` reached
 * through a link) is the user's own layout, so it is resolved once here instead of failing every
 * check below it. Links from the anchor down are still refused by those checks.
 */
export async function canonicalDirectory(directory: string, create = false): Promise<string> {
  if (create) await mkdir(directory, { recursive: true });
  return realpath(directory);
}
