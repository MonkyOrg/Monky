/**
 * Whether the page runs on WebKit: Safari, and every browser on the iPhone and iPad, which all use WebKit
 * whatever their name. Chromium browsers also say AppleWebKit, so their own token tells them apart.
 */
export function runsOnWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent;
  return /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent);
}
