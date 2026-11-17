import { hasOwnedSurface, topModal } from '../../utils/surfaceMotion';

const HIDDEN = 'data-stage-chrome-hidden';
/** Inside the focused video, these act on their own; a tap anywhere else on it toggles the chrome. */
const CONTROLS = 'button, a, input, select, textarea, [role="button"], [role="slider"], .stage-card-controls, .stage-viewers, .stage-pip-placeholder';

/**
 * A phone on its side watching a focused video shows only the video: the header,
 * the call column and the tile overlays come back with a tap or a key and leave
 * again after a few seconds. The chrome only fades (the CSS keeps it in the
 * accessibility tree and reachable by keyboard), and it stays while keyboard
 * focus, a menu or a dialog still needs it.
 */
export class ImmersiveStageChrome {
  static HIDE_DELAY_MS = 3000;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Programmatic focus also matches :focus-visible in WebKit, so the last input decides. */
  private keyboard = false;

  constructor(private readonly layout: HTMLElement, signal: AbortSignal) {
    // Capture: a tap that only brings the chrome back must not also reach the card under it.
    layout.addEventListener('click', this.onClick, { capture: true, signal });
    layout.addEventListener('pointerdown', () => {
      this.keyboard = false;
      if (this.active && !this.hidden) this.schedule();
    }, { capture: true, signal });
    layout.addEventListener('keydown', () => {
      this.keyboard = true;
      this.reveal();
    }, { capture: true, signal });
    layout.addEventListener('focusin', () => { if (this.keyboard) this.reveal(); }, { signal });
    signal.addEventListener('abort', () => this.setActive(false));
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) this.reveal();
    else {
      clearTimeout(this.timer);
      this.layout.removeAttribute(HIDDEN);
    }
  }

  private get hidden(): boolean {
    return this.layout.hasAttribute(HIDDEN);
  }

  private reveal(): void {
    if (!this.active) return;
    this.layout.removeAttribute(HIDDEN);
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), ImmersiveStageChrome.HIDE_DELAY_MS);
  }

  private hide(): void {
    if (!this.active) return;
    clearTimeout(this.timer);
    // Without a focused video there is nothing behind the chrome to uncover.
    if (!this.layout.querySelector('.stage-focused-main') || topModal() || hasOwnedSurface(this.layout)
      || (this.keyboard && this.layout.contains(document.activeElement))) {
      this.schedule();
      return;
    }
    this.layout.setAttribute(HIDDEN, '');
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.active || !(event.target instanceof Element)) return;
    if (this.hidden) {
      event.preventDefault();
      event.stopPropagation();
      this.reveal();
      return;
    }
    const main = event.target.closest<HTMLElement>('.stage-focused-main');
    const control = event.target.closest(CONTROLS);
    // A zoomed screen pans under the finger; leaving it there would hide the chrome after every drag.
    if (main && !main.classList.contains('is-zoomed') && !(control && main.contains(control))) {
      event.stopPropagation();
      this.hide();
    } else this.schedule();
  };
}
