type ScreenShareModule = typeof import('@monky/screen-share');

let screenShare: ScreenShareModule | null = null;

/**
 * The native screen package (capture, transport, publication, thumbnails), loaded by the first handler that
 * needs it rather than when Main starts: most sessions never share or watch a screen (#851). Listing and
 * resolving sources only validate targets, through `@monky/screen-share/target`.
 */
export function screenShareModule(): ScreenShareModule {
  const loaded: ScreenShareModule = screenShare ?? require('@monky/screen-share');
  screenShare = loaded;
  return loaded;
}
