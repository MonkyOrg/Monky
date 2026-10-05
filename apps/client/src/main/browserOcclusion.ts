import path from 'node:path';
import type { BrowserOcclusionEngine } from '@monky/shared';

/**
 * Browsers on Windows stop painting a window that other windows fully cover
 * (native window occlusion), so a capture of it freezes until it is uncovered.
 */
const BROWSER_OCCLUSION_ENGINES = new Map<string, BrowserOcclusionEngine>([
  ...['chrome.exe', 'msedge.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'chromium.exe', 'yandex.exe', 'arc.exe']
    .map(name => [name, 'chromium'] as const),
  ...['firefox.exe', 'librewolf.exe', 'waterfox.exe', 'floorp.exe', 'zen.exe', 'mullvadbrowser.exe']
    .map(name => [name, 'firefox'] as const),
]);

export function browserOcclusionEngine(processPath: string | null | undefined): BrowserOcclusionEngine | null {
  if (typeof processPath !== 'string') return null;
  return BROWSER_OCCLUSION_ENGINES.get(path.win32.basename(processPath).toLowerCase()) ?? null;
}
