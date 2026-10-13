import path from 'path';
import type { NativeWindowInfo } from '@monky/screen-audio';

export interface ListedWindow {
  id: string;
  window: Pick<NativeWindowInfo, 'processPath' | 'isVisible' | 'isIconic' | 'isCloaked' | 'isToolWindow'>;
}

/**
 * Source ids of the windows that belong to the game (#763): the ones whose
 * executable lives under one of its install folders.
 *
 * Compared case-insensitively with normalized separators, because Windows paths
 * are, and Steam writes library paths with either slash. The folder is matched
 * with a trailing separator so `Game` never claims `Game Tools`.
 */
export function gameWindowIds(windows: readonly ListedWindow[], gameFolders: readonly string[]): string[] {
  const folders = gameFolders.map(folder => normalize(folder).replace(/\\+$/, '') + '\\');
  if (folders.length === 0) return [];
  return windows.filter(({ window }) => {
    if (window.isCloaked || window.isToolWindow || (!window.isVisible && !window.isIconic)) return false;
    const executable = normalize(window.processPath);
    return folders.some(folder => executable.startsWith(folder));
  }).map(({ id }) => id);
}

function normalize(value: string): string {
  return path.win32.normalize(value.replace(/\//g, '\\')).toLowerCase();
}
