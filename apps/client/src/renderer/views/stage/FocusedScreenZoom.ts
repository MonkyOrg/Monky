const MAX_SCALE = 4;
const STEP = 0.25;

/**
 * Zoom and pan of the focused screen share (#271): scrolling zooms towards the
 * pointer, dragging pans the zoomed image and a double-click resets it. With the
 * focus area split in two (#253) there is no single target, so it waits until one
 * pane is left. The gestures stay on the focused card while it stays on the stage.
 */
export class FocusedScreenZoom {
  transform = { scale: 1, x: 0, y: 0 };
  private tileKey: string | null = null;
  /** The focused screen whose gestures are attached; kept while its card stays on the stage. */
  private binding: { main: HTMLElement; video: HTMLElement; controller: AbortController } | null = null;

  /** `onGestureEnd` hears a pan or reset end, whose trailing click must not reach the card. */
  constructor(private readonly onGestureEnd: () => void) {}

  /** While zoomed in, a click pans instead of leaving focus. */
  get zoomed(): boolean {
    return this.transform.scale > 1;
  }

  /** Follows the focused pane after a render: binds a new one, keeps one still on the stage. */
  attach(area: HTMLElement): void {
    // Zoom/pan targets a single pane; with the focus area split in two (#253)
    // there is no unambiguous target, so it stays disabled until one is left.
    const mains = area.querySelectorAll<HTMLElement>('.stage-focused-main');
    const main = mains.length === 1 ? mains[0] : null;
    const video = main?.querySelector<HTMLElement>('video.stage-video-element.screen-share:not(.screen-locked)') ?? null;
    const tileKey = main?.getAttribute('data-tile-key') ?? null;
    if (main && video && this.binding?.main === main && this.binding.video === video) return;
    this.release();

    if (!main || !video || !tileKey) {
      this.tileKey = null;
      this.transform = { scale: 1, x: 0, y: 0 };
      return;
    }

    if (this.tileKey !== tileKey) {
      this.tileKey = tileKey;
      this.transform = { scale: 1, x: 0, y: 0 };
    }
    const controller = new AbortController();
    const { signal } = controller;
    this.binding = { main, video, controller };

    const clampPan = () => {
      const rect = main.getBoundingClientRect();
      const maxX = (rect.width * (this.transform.scale - 1)) / 2;
      const maxY = (rect.height * (this.transform.scale - 1)) / 2;
      this.transform.x = Math.min(maxX, Math.max(-maxX, this.transform.x));
      this.transform.y = Math.min(maxY, Math.max(-maxY, this.transform.y));
    };

    const apply = () => {
      const { scale, x, y } = this.transform;
      video.style.transform = scale > 1 ? `translate(${x}px, ${y}px) scale(${scale})` : '';
      main.classList.toggle('is-zoomed', scale > 1);
    };

    apply();

    main.addEventListener('wheel', (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest('.stage-card-controls')) return;
      e.preventDefault();

      const previous = this.transform.scale;
      const next = Math.min(
        MAX_SCALE,
        Math.max(1, previous - Math.sign(e.deltaY) * STEP)
      );
      if (next === previous) return;

      // Keep the pixel under the cursor anchored while the scale changes.
      const rect = main.getBoundingClientRect();
      const cursorX = e.clientX - rect.left - rect.width / 2;
      const cursorY = e.clientY - rect.top - rect.height / 2;
      const anchorX = (cursorX - this.transform.x) / previous;
      const anchorY = (cursorY - this.transform.y) / previous;

      this.transform.scale = next;
      this.transform.x = cursorX - anchorX * next;
      this.transform.y = cursorY - anchorY * next;
      clampPan();
      apply();
    }, { passive: false, signal });

    let panning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panOriginX = 0;
    let panOriginY = 0;

    main.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || this.transform.scale <= 1) return;
      if ((e.target as HTMLElement).closest('.stage-card-controls')) return;
      panning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panOriginX = this.transform.x;
      panOriginY = this.transform.y;
      main.classList.add('is-panning');
      main.setPointerCapture(e.pointerId);
    }, { signal });

    main.addEventListener('pointermove', (e: PointerEvent) => {
      if (!panning) return;
      this.transform.x = panOriginX + (e.clientX - panStartX);
      this.transform.y = panOriginY + (e.clientY - panStartY);
      clampPan();
      apply();
    }, { signal });

    const endPan = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      main.classList.remove('is-panning');
      if (main.hasPointerCapture(e.pointerId)) main.releasePointerCapture(e.pointerId);
      // The pointer-up turns into a click that would otherwise leave focus mode.
      this.onGestureEnd();
    };

    main.addEventListener('pointerup', endPan, { signal });
    main.addEventListener('pointercancel', endPan, { signal });

    main.addEventListener('dblclick', (e: MouseEvent) => {
      if (this.transform.scale <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      this.transform = { scale: 1, x: 0, y: 0 };
      apply();
      this.onGestureEnd();
    }, { signal });
  }

  release(): void {
    const binding = this.binding;
    if (!binding) return;
    // A pane kept when focus splits in two outlives its zoom: it must not stay cropped without the
    // gestures that undo it. Rebinding the same screen applies the zoom again.
    binding.video.style.transform = '';
    binding.main.classList.remove('is-zoomed', 'is-panning');
    binding.controller.abort();
    this.binding = null;
  }
}
