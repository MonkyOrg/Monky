import path from 'node:path';
import type { WebPreferences } from 'electron';

/** Preloads bundled into a single file each by `scripts/buildPreloads.mjs`. */
export type BundledPreload = 'preload' | 'overlayPreload' | 'crashRecoveryPreload' | 'localPreparationDialog';

/**
 * Every Monky window with a preload runs in the operating system sandbox, with
 * the page isolated from the preload and no Node in either (#826). The bundled
 * preload needs nothing but `electron`, so no window has a reason to opt out.
 */
export function isolatedWebPreferences(preload: BundledPreload, options: WebPreferences = {}): WebPreferences {
  return {
    ...options,
    preload: path.join(__dirname, '..', 'preload', `${preload}.cjs`),
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
  };
}
