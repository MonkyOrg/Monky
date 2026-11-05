import type { PlatformCapabilities } from './api';

/** What only a browser tab does: the desktop declares these false. */
const BROWSER_ONLY: ReadonlySet<keyof PlatformCapabilities> = new Set(['documentPictureInPicture', 'browserScreenPicker']);

/**
 * Whether the platform running the app supports `capability` (#858). A bridge
 * that does not declare capabilities (tests, older mocks) is treated as the
 * desktop, which has them all except what only a browser does.
 */
export function platformSupports(capability: keyof PlatformCapabilities): boolean {
  const capabilities = typeof window === 'undefined' ? undefined : window.api?.capabilities;
  return capabilities ? capabilities[capability] : !BROWSER_ONLY.has(capability);
}

/**
 * The web looks exactly like the desktop (#858): every desktop feature stays in
 * place, locked and marked "Desktop", and activating it offers the download.
 * Only the desktop's own title bar and window buttons are hidden, since the
 * browser already draws them.
 */
const HIDDEN_WHEN_MISSING: ReadonlySet<keyof PlatformCapabilities> = new Set(['windowControls', ...BROWSER_ONLY]);

export type FeatureAvailability = 'available' | 'desktop-only' | 'hidden';

/** The one rule for a feature's controls: working, locked as desktop-only, or not shown. */
export function featureAvailability(capability: keyof PlatformCapabilities): FeatureAvailability {
  if (platformSupports(capability)) return 'available';
  return HIDDEN_WHEN_MISSING.has(capability) ? 'hidden' : 'desktop-only';
}
