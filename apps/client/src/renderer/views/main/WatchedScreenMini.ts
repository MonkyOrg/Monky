import { animateEnter, removeWithMotion } from '../../utils/surfaceMotion';
import { t } from '../../i18n';

export interface WatchedScreen {
  stream: MediaStream | null;
  name: string;
}

export interface WatchedScreenMiniHost {
  /** The layout the thumbnail floats over. */
  readonly layout: HTMLElement;
  openStage(): void;
  stopWatching(): void;
}

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const MARGIN = 8;
/** Below this the finger is tapping, not dragging. */
const DRAG_THRESHOLD = 6;

/**
 * The screen being watched, floating over a conversation on a phone, where the
 * "you are watching" notice would take a whole row from the chat. Tapping it
 * goes back to the stage, the ✕ stops watching, and it can be dragged to any
 * corner between the header and the composer.
 */
export class WatchedScreenMini {
  private element: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private lifetime: AbortController | null = null;
  // Kept across appearances: where the person last put it is where it returns.
  private corner: Corner = 'top-right';

  constructor(private readonly host: WatchedScreenMiniHost) {}

  public sync(screen: WatchedScreen | null): void {
    if (!screen) {
      this.remove();
      return;
    }
    if (!this.element?.isConnected) this.create();
    const element = this.element!;
    const video = this.video!;
    if (video.srcObject !== screen.stream) {
      video.srcObject = screen.stream;
      element.toggleAttribute('data-waiting', !screen.stream);
      if (screen.stream) void video.play().catch(() => undefined);
    }
    const label = element.querySelector<HTMLElement>('.watched-screen-mini-name')!;
    if (label.textContent !== screen.name) label.textContent = screen.name;
  }

  public destroy(): void {
    this.remove();
  }

  private create(): void {
    this.remove();
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const element = document.createElement('div');
    element.className = 'watched-screen-mini';
    element.dataset.corner = this.corner;
    element.innerHTML = `
      <video class="watched-screen-mini-video" autoplay playsinline muted></video>
      <span class="material-symbols-outlined watched-screen-mini-waiting" aria-hidden="true">screen_share</span>
      <span class="watched-screen-mini-name"></span>
      <button type="button" class="watched-screen-mini-open"></button>
      <button type="button" class="watched-screen-mini-close">
        <span class="material-symbols-outlined md-18" aria-hidden="true">close</span>
      </button>
    `;
    const video = element.querySelector('video')!;
    // iOS Safari only plays inline, muted video without a gesture; the call's audio has its own element.
    video.muted = true;
    video.playsInline = true;
    const open = element.querySelector<HTMLButtonElement>('.watched-screen-mini-open')!;
    const close = element.querySelector<HTMLButtonElement>('.watched-screen-mini-close')!;
    open.setAttribute('aria-label', t('main.screenShareBackToStage'));
    close.setAttribute('aria-label', t('stage.stopWatching'));
    close.title = t('stage.stopWatching');
    this.host.layout.append(element);
    this.element = element;
    this.video = video;
    this.lifetime = lifetime;

    video.addEventListener('resize', () => {
      if (video.videoWidth && video.videoHeight) {
        element.style.setProperty('--watched-screen-aspect', String(video.videoWidth / video.videoHeight));
        this.place();
      }
    }, { signal });
    close.addEventListener('click', () => this.host.stopWatching(), { signal });
    let dragged = false;
    open.addEventListener('click', event => {
      if (dragged) {
        event.preventDefault();
        dragged = false;
        return;
      }
      this.host.openStage();
    }, { signal });
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || close.contains(event.target as Node)) return;
      dragged = false;
      const startX = event.clientX;
      const startY = event.clientY;
      const start = element.getBoundingClientRect();
      const pointer = event.pointerId;
      const drag = new AbortController();
      const dragSignal = AbortSignal.any([signal, drag.signal]);
      const end = (cancelled: boolean) => {
        drag.abort();
        // Measured before the snap transition is back on: a flick moves and lifts in one frame,
        // and the transition would start from where the previous frame left it.
        if (dragged && !cancelled) this.corner = this.nearestCorner();
        element.removeAttribute('data-dragging');
        this.place();
      };
      window.addEventListener('pointermove', move => {
        if (move.pointerId !== pointer) return;
        const dx = move.clientX - startX;
        const dy = move.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!dragged) {
          dragged = true;
          element.setAttribute('data-dragging', '');
          try { element.setPointerCapture(pointer); } catch { /* the pointer already ended */ }
        }
        const bounds = this.bounds();
        element.style.left = `${clamp(start.left + dx, bounds.left, bounds.right - start.width)}px`;
        element.style.top = `${clamp(start.top + dy, bounds.top, bounds.bottom - start.height)}px`;
      }, { signal: dragSignal });
      window.addEventListener('pointerup', up => { if (up.pointerId === pointer) end(false); }, { signal: dragSignal });
      window.addEventListener('pointercancel', up => { if (up.pointerId === pointer) end(true); }, { signal: dragSignal });
    }, { signal });

    // The composer grows, the keyboard opens and the phone turns: the corner keeps its place.
    const observer = new ResizeObserver(() => this.place());
    observer.observe(this.host.layout);
    const composer = this.composer();
    if (composer) observer.observe(composer);
    signal.addEventListener('abort', () => observer.disconnect());
    window.visualViewport?.addEventListener('resize', () => this.place(), { signal });

    this.place();
    animateEnter(element, 'popover');
  }

  private remove(): void {
    const element = this.element;
    this.lifetime?.abort();
    this.lifetime = null;
    this.element = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    if (element?.isConnected) removeWithMotion(element, 'popover');
  }

  private composer(): HTMLElement | null {
    return this.host.layout.querySelector<HTMLElement>('#compact-content-panel .chat-input-container');
  }

  /** Where it may float: the conversation, between its header and its composer. */
  private bounds(): { left: number; top: number; right: number; bottom: number } {
    const panel = this.host.layout.querySelector<HTMLElement>('#compact-content-panel') ?? this.host.layout;
    const area = panel.getBoundingClientRect();
    const header = panel.querySelector<HTMLElement>('.content-header')?.getBoundingClientRect();
    const composer = this.composer()?.getBoundingClientRect();
    const viewportBottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
    const bottom = Math.min(composer?.height ? composer.top : area.bottom, viewportBottom);
    return {
      left: area.left + MARGIN,
      top: (header?.height ? header.bottom : area.top) + MARGIN,
      right: area.right - MARGIN,
      bottom: bottom - MARGIN,
    };
  }

  private nearestCorner(): Corner {
    const element = this.element!;
    const rect = element.getBoundingClientRect();
    const bounds = this.bounds();
    const vertical = rect.top + rect.height / 2 < (bounds.top + bounds.bottom) / 2 ? 'top' : 'bottom';
    const horizontal = rect.left + rect.width / 2 < (bounds.left + bounds.right) / 2 ? 'left' : 'right';
    return `${vertical}-${horizontal}`;
  }

  private place(): void {
    const element = this.element;
    if (!element || element.hasAttribute('data-dragging')) return;
    element.dataset.corner = this.corner;
    const bounds = this.bounds();
    const { width, height } = element.getBoundingClientRect();
    const left = this.corner.endsWith('left') ? bounds.left : bounds.right - width;
    const top = this.corner.startsWith('top') ? bounds.top : bounds.bottom - height;
    element.style.left = `${Math.max(bounds.left, left)}px`;
    element.style.top = `${Math.max(bounds.top, top)}px`;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
