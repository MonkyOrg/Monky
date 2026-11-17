import { tTouch } from '../../i18n';
import { showInfoToast } from '../CopyToast';

let shown = false;

/**
 * On a phone the focus badge would cover the video, so its hint shows once per
 * session as a toast. On its side a tap shows the controls instead, and the
 * header's grid button is the way back, so there is nothing to explain.
 */
export function announceCompactFocus(container: HTMLElement): void {
  const layout = container.closest('.main-layout[data-compact]');
  if (shown || !layout || layout.hasAttribute('data-compact-immersive')) return;
  shown = true;
  showInfoToast(tTouch('stage.focusMode'));
}
