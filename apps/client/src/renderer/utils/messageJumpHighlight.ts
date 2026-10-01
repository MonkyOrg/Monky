import { motionDuration, reducedMotion } from './surfaceMotion';

export function highlightMessageJump(row: HTMLElement): Animation | null {
  for (const marker of row.querySelectorAll<HTMLElement>(':scope > .chat-message-jump-highlight')) {
    marker.getAnimations().forEach(animation => animation.cancel());
    marker.remove();
  }
  if (reducedMotion() || !row.isConnected) return null;
  const marker = document.createElement('span');
  marker.className = 'chat-message-jump-highlight';
  marker.setAttribute('aria-hidden', 'true');
  row.append(marker);
  const duration = Math.max(900, motionDuration('view') * 6);
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--motion-easing').trim()
    || 'cubic-bezier(0.2, 0, 0, 1)';
  const animation = marker.animate([
    { opacity: 0 },
    { opacity: 1, offset: .14 },
    { opacity: .72, offset: .58 },
    { opacity: 0 },
  ], { duration, easing, fill: 'both' });
  const cleanup = () => marker.remove();
  void animation.finished.then(cleanup, cleanup);
  return animation;
}
