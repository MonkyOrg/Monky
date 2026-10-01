import { cancelSurfaceMotion, hideWithMotion, motionDuration, reducedMotion, showWithMotion, type SurfaceKind } from './surfaceMotion';

const expansions = new Map<HTMLElement, () => void>();
let preference: MediaQueryList | undefined;

export function cancelVisibilityMotion(element: HTMLElement): void {
  expansions.get(element)?.();
  cancelSurfaceMotion(element);
}

/** Data refreshes must not restart an already-visible panel's entrance. */
export function setSurfaceVisible(
  element: HTMLElement, visible: boolean, kind: SurfaceKind = 'panel', display?: string, onHidden?: () => void,
): void {
  const closing = element.hasAttribute('data-ui-closing');
  const wasVisible = !element.hidden && element.style.display !== 'none' && !closing;
  if (visible === wasVisible) return;
  const style = getComputedStyle(element);
  const from = {
    height: element.hidden || element.style.display === 'none' ? '0px' : `${element.getBoundingClientRect().height}px`,
    paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
    marginTop: style.marginTop, marginBottom: style.marginBottom,
  };
  expansions.get(element)?.();
  if (visible) {
    if (display !== undefined || element.style.display === 'none') element.style.display = display ?? '';
    showWithMotion(element, kind);
  } else if (!closing) hideWithMotion(element, kind, onHidden);
  if (kind !== 'panel' || reducedMotion() || !element.isConnected || element.hidden) return;
  if (!preference) {
    preference = matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', () => {
      if (preference?.matches) for (const finish of [...expansions.values()]) finish();
    });
  }
  const overflow = element.style.overflow;
  element.style.overflow = 'hidden';
  const natural = getComputedStyle(element);
  const expanded = { height: `${element.getBoundingClientRect().height}px`, paddingTop: natural.paddingTop,
    paddingBottom: natural.paddingBottom, marginTop: natural.marginTop, marginBottom: natural.marginBottom };
  const collapsed = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' };
  const animation = element.animate([
    from.height === '0px' ? collapsed : from, visible ? expanded : collapsed,
  ], { duration: motionDuration('panel'), easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' });
  const finish = () => {
    if (expansions.get(element) !== finish) return;
    expansions.delete(element);
    animation.cancel();
    element.style.overflow = overflow;
  };
  expansions.set(element, finish);
  void animation.finished.then(finish, finish);
}
