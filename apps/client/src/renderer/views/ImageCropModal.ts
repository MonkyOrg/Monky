import { t } from '../i18n';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { escapeHtml } from '../utils/html';
import { withButtonLoading } from '../utils/buttonLoading';
import { renderLoadingError } from '../utils/loadingSkeleton';
import type { BotCarouselFormat } from '@monky/shared';

/** Side of the square crop preview, in CSS pixels. */
const VIEWPORT_PX = 320;
/** Side of the exported image, in pixels. */
const OUTPUT_PX = 512;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

interface CropState {
  zoom: number;
  x: number;
  y: number;
}

interface CropEntry {
  original: string;
  source: string;
  state: CropState;
  prepared: boolean;
}

export interface CroppedImage {
  original: string;
  cropped: string;
}

export type ImageCropShape = 'avatar' | BotCarouselFormat;

function loadImage(dataUrl: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:/i.test(dataUrl)) image.crossOrigin = 'anonymous';
    const cleanup = () => {
      image.onload = image.onerror = null;
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      image.removeAttribute('src');
      reject(new DOMException('Image loading cancelled', 'AbortError'));
    };
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('Could not load the selected image.')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else image.src = dataUrl;
  });
}

/**
 * Square crop dialog with zoom and drag, used before an image becomes a profile
 * or server picture. Resolves with a `${OUTPUT_PX}x${OUTPUT_PX}` PNG data URL,
 * or `null` when the user cancels (#255).
 */
export function openImageCropperBatch(
  dataUrls: string[],
  shape: ImageCropShape = 'avatar',
): Promise<string[] | null> {
  if (dataUrls.length === 0) return Promise.resolve([]);
  const ratios: Record<BotCarouselFormat, number> = { banner: 5 / 2, landscape: 4 / 3, square: 1, portrait: 4 / 5 };
  const isMedia = shape !== 'avatar';
  const ratio = isMedia ? ratios[shape] : 1;
  const viewportWidth = isMedia ? Math.min(430, window.innerWidth - 80) : VIEWPORT_PX;
  const viewportHeight = isMedia ? 350 : viewportWidth;
  const cropWidth = isMedia && ratio < 1 ? viewportHeight * ratio : viewportWidth;
  const cropHeight = isMedia && ratio < 1 ? viewportHeight : viewportWidth / ratio;
  const cropLeft = (viewportWidth - cropWidth) / 2;
  const cropTop = (viewportHeight - cropHeight) / 2;
  const outputWidth = isMedia ? Math.round((ratio >= 1 ? 1000 : 1000 * ratio)) : OUTPUT_PX;
  const outputHeight = isMedia ? Math.round((ratio >= 1 ? 1000 / ratio : 1000)) : OUTPUT_PX;
  return new Promise((resolve) => {
    const entries: CropEntry[] = dataUrls.map(original => ({
      original,
      source: original,
      state: { zoom: 1, x: 0, y: 0 },
      prepared: false,
    }));
    let index = 0;
    let image: HTMLImageElement | null = null;
    let source = entries[0].source;
    let baseScale = 1;
    const loading = new AbortController();
    let state = entries[0].state;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card crop-modal-card ${isMedia ? 'crop-banner-card' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('crop.title'))}">
        <div class="modal-header">
          <div class="modal-title">${t('crop.title')}</div>
          <span class="crop-counter" ${entries.length > 1 ? '' : 'hidden'}></span>
          <button type="button" class="modal-close-btn" data-action="close" aria-label="${t('common.close')}">&times;</button>
        </div>
        <div class="crop-hint">${isMedia ? t('crop.mediaHint', { width: outputWidth, height: outputHeight }) : t('crop.hint')}</div>
        <div class="crop-viewport" aria-busy="true" style="width: ${viewportWidth}px; height: ${viewportHeight}px;">
          <img class="crop-image" alt="" draggable="false">
          <div class="crop-mask" ${isMedia
            ? `style="border-radius:0; left:${cropLeft}px; top:${cropTop}px; width:${cropWidth}px; height:${cropHeight}px; right:auto; bottom:auto;"`
            : ''}></div>
          <div class="crop-loading skeleton" role="status" aria-label="${escapeHtml(t('common.loading'))}"></div>
        </div>
        <div class="crop-zoom-row">
          <span class="material-symbols-outlined md-18">zoom_out</span>
          <input class="crop-zoom-slider" type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" disabled>
          <span class="material-symbols-outlined md-18">zoom_in</span>
          <button type="button" class="btn btn-secondary" data-action="rotate" aria-label="${t('crop.rotate')}" disabled><span class="material-symbols-outlined md-20">rotate_right</span></button>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary crop-reset" data-action="reset" disabled>${t('crop.reset')}</button>
          <button type="button" class="btn btn-secondary" data-action="previous" hidden>${t('community.previous')}</button>
          <button type="button" class="btn btn-secondary" data-action="cancel">${t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" data-action="confirm" disabled>${t('crop.confirm')}</button>
        </div>
      </div>
    `;

    const imageEl = backdrop.querySelector('.crop-image') as HTMLImageElement;
    const viewport = backdrop.querySelector('.crop-viewport') as HTMLElement;
    const slider = backdrop.querySelector('.crop-zoom-slider') as HTMLInputElement;
    const placeholder = backdrop.querySelector<HTMLElement>('.crop-loading')!;
    const confirm = backdrop.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
    const previous = backdrop.querySelector<HTMLButtonElement>('[data-action="previous"]')!;
    const reset = backdrop.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
    const rotate = backdrop.querySelector<HTMLButtonElement>('[data-action="rotate"]')!;
    const counter = backdrop.querySelector<HTMLElement>('.crop-counter')!;

    const displayedWidth = () => (image?.naturalWidth ?? 0) * baseScale * state.zoom;
    const displayedHeight = () => (image?.naturalHeight ?? 0) * baseScale * state.zoom;

    const clamp = () => {
      const minX = cropWidth - displayedWidth();
      const minY = cropHeight - displayedHeight();
      state.x = Math.min(0, Math.max(minX, state.x));
      state.y = Math.min(0, Math.max(minY, state.y));
    };

    const apply = () => {
      clamp();
      imageEl.style.width = `${displayedWidth()}px`;
      imageEl.style.height = `${displayedHeight()}px`;
      imageEl.style.transform = `translate(${state.x + cropLeft}px, ${state.y + cropTop}px)`;
    };

    const setZoom = (nextZoom: number, anchorX: number, anchorY: number) => {
      if (!image) return;
      const previous = state.zoom;
      const zoom = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
      if (zoom === previous) return;
      // Keep whatever sits under the anchor point in place while zooming.
      state.x = anchorX - ((anchorX - state.x) / previous) * zoom;
      state.y = anchorY - ((anchorY - state.y) / previous) * zoom;
      state.zoom = zoom;
      slider.value = String(zoom);
      apply();
    };

    let settled = false;
    const settle = (result: string[] | null) => {
      if (settled) return;
      settled = true;
      loading.abort();
      image?.removeAttribute('src');
      imageEl.removeAttribute('src');
      image = null;
      document.removeEventListener('keydown', onKeyDown, true);
      exitModal(backdrop);
      resolve(result);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!handlesModalKey(backdrop, e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // Otherwise the modal that opened the cropper would close as well.
        e.stopPropagation();
        settle(null);
      }
    };

    const exportCrop = (entryImage: HTMLImageElement, entryState: CropState): string | null => {
      const canvas = document.createElement('canvas');
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error('[ImageCrop] Canvas is unavailable.');
        placeholder.hidden = false;
        placeholder.innerHTML = renderLoadingError(t('crop.loadFailed'));
        return null;
      }
      const entryBaseScale = Math.max(cropWidth / entryImage.naturalWidth, cropHeight / entryImage.naturalHeight);
      const scale = entryBaseScale * entryState.zoom;
      const sourceSize = cropWidth / scale;
      ctx.drawImage(
        entryImage,
        -entryState.x / scale,
        -entryState.y / scale,
        sourceSize,
        cropHeight / scale,
        0,
        0,
        outputWidth,
        outputHeight
      );
      return canvas.toDataURL('image/png');
    };

    const exportAll = async () => {
      slider.disabled = confirm.disabled = previous.disabled = reset.disabled = rotate.disabled = true;
      viewport.setAttribute('aria-busy', 'true');
      placeholder.hidden = false;
      placeholder.classList.add('skeleton');
      placeholder.innerHTML = '';
      try {
        const results: string[] = [];
        for (const entry of entries) {
          const loaded = await loadImage(entry.source, loading.signal);
          const cropped = exportCrop(loaded, entry.state);
          loaded.removeAttribute('src');
          if (!cropped) return;
          results.push(cropped);
        }
        settle(results);
      } catch (error: unknown) {
        if (settled) return;
        console.warn('[ImageCrop] Could not export selected images', error);
        placeholder.classList.remove('skeleton');
        placeholder.innerHTML = renderLoadingError(t('crop.loadFailed'));
        confirm.disabled = previous.disabled = reset.disabled = rotate.disabled = false;
      } finally {
        if (!settled) viewport.setAttribute('aria-busy', 'false');
      }
    };

    slider.addEventListener('input', () => {
      setZoom(Number(slider.value), cropWidth / 2, cropHeight / 2);
    });

    viewport.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      setZoom(
        state.zoom - Math.sign(e.deltaY) * ZOOM_STEP,
        e.clientX - rect.left - cropLeft,
        e.clientY - rect.top - cropTop
      );
    }, { passive: false });

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    viewport.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || !image) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      originX = state.x;
      originY = state.y;
      viewport.classList.add('is-dragging');
      viewport.setPointerCapture(e.pointerId);
    });

    viewport.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      state.x = originX + (e.clientX - startX);
      state.y = originY + (e.clientY - startY);
      apply();
    });

    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      viewport.classList.remove('is-dragging');
      if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    viewport.addEventListener('dblclick', () => {
      if (!image) return;
      state.zoom = 1;
      slider.value = '1';
      state.x = (cropWidth - displayedWidth()) / 2;
      state.y = (cropHeight - displayedHeight()) / 2;
      apply();
    });

    backdrop.querySelector('[data-action="cancel"]')?.addEventListener('click', () => settle(null));
    backdrop.querySelector('[data-action="close"]')?.addEventListener('click', () => settle(null));
    reset.addEventListener('click', () => {
      const entry = entries[index];
      source = entry.original;
      entry.source = source;
      entry.prepared = false;
      void prepare();
    });
    rotate.addEventListener('click', () => {
      if (!image) return;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalHeight;
      canvas.height = image.naturalWidth;
      const context = canvas.getContext('2d');
      if (!context) {
        console.error('[ImageCrop] Canvas is unavailable for rotation.');
        placeholder.hidden = false;
        placeholder.innerHTML = renderLoadingError(t('crop.loadFailed'));
        return;
      }
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(Math.PI / 2);
      context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
      source = canvas.toDataURL('image/png');
      entries[index].source = source;
      entries[index].prepared = false;
      void prepare();
    });
    previous.addEventListener('click', () => {
      if (index <= 0) return;
      index--;
      source = entries[index].source;
      state = entries[index].state;
      void prepare();
    });
    confirm.addEventListener('click', () => {
      if (index < entries.length - 1) {
        index++;
        source = entries[index].source;
        state = entries[index].state;
        void prepare();
        return;
      }
      void exportAll();
    });
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) settle(null);
    });
    document.addEventListener('keydown', onKeyDown, true);

    document.body.appendChild(backdrop);
    enterModal(backdrop);
    const prepare = async (): Promise<void> => {
      const entry = entries[index];
      slider.disabled = confirm.disabled = reset.disabled = rotate.disabled = true;
      previous.disabled = true;
      counter.textContent = t('community.imagePosition', { current: index + 1, total: entries.length });
      previous.hidden = entries.length < 2;
      confirm.textContent = t(index < entries.length - 1 ? 'community.next' : 'crop.confirm');
      placeholder.hidden = false;
      placeholder.classList.add('skeleton');
      placeholder.innerHTML = '';
      placeholder.setAttribute('role', 'status');
      placeholder.setAttribute('aria-label', t('common.loading'));
      viewport.setAttribute('aria-busy', 'true');
      try {
        const loaded = await loadImage(source, loading.signal);
        if (settled) return;
        if (loaded.naturalWidth <= 0 || loaded.naturalHeight <= 0) throw new Error('Invalid image dimensions');
        image?.removeAttribute('src');
        image = loaded;
        baseScale = Math.max(cropWidth / image.naturalWidth, cropHeight / image.naturalHeight);
        imageEl.src = source;
        if (!entry.prepared) {
          state.zoom = 1;
          state.x = (cropWidth - displayedWidth()) / 2;
          state.y = (cropHeight - displayedHeight()) / 2;
          entry.prepared = true;
        }
        slider.value = String(state.zoom);
        apply();
        placeholder.hidden = true;
        slider.disabled = confirm.disabled = reset.disabled = rotate.disabled = false;
        previous.disabled = index === 0;
      } catch (error: unknown) {
        if (settled) return;
        console.warn('[ImageCrop] Could not prepare the selected image', error);
        placeholder.classList.remove('skeleton');
        placeholder.setAttribute('role', 'presentation');
        placeholder.removeAttribute('aria-label');
        placeholder.innerHTML = renderLoadingError(t('crop.loadFailed'));
        placeholder.querySelector('[data-loading-retry]')?.addEventListener('click', () => { void prepare(); });
        previous.disabled = index === 0;
      } finally {
        if (!settled) viewport.setAttribute('aria-busy', 'false');
      }
    };
    void prepare();
  });
}

export async function openImageCropper(
  dataUrl: string,
  shape: ImageCropShape = 'avatar',
): Promise<string | null> {
  const result = await openImageCropperBatch([dataUrl], shape);
  return result?.[0] ?? null;
}

/**
 * Opens the image picker and lets the user frame the result before it is used
 * as a picture. Returns `null` when the picker or the crop is cancelled (#255).
 */
export async function pickAndCropImage(
  trigger: HTMLElement,
  shape: ImageCropShape = 'avatar',
): Promise<string | null> {
  if (!window.api?.selectImageDialog) return null;
  return (await withButtonLoading(trigger, async () => {
    const file = await window.api.selectImageDialog();
    if (!file?.base64) return null;
    return openImageCropper(file.base64, shape);
  })) ?? null;
}

export async function pickAndCropImages(
  trigger: HTMLElement,
  maxFiles: number,
  shape: ImageCropShape = 'avatar',
): Promise<string[]> {
  return (await pickAndCropImageEntries(trigger, maxFiles, shape)).map(image => image.cropped);
}

export async function pickAndCropImageEntries(
  trigger: HTMLElement,
  maxFiles: number,
  shape: ImageCropShape = 'avatar',
): Promise<CroppedImage[]> {
  if (!window.api?.selectImagesDialog || maxFiles < 1) return [];
  return (await withButtonLoading(trigger, async () => {
    const files = await window.api.selectImagesDialog(maxFiles);
    const originals = files.map(file => file.base64).filter((base64): base64 is string => !!base64);
    const cropped = await openImageCropperBatch(originals, shape);
    return cropped?.map((image, index) => ({ original: originals[index], cropped: image })) ?? [];
  })) ?? [];
}

function readImageFile(file: File): Promise<string | null> {
  if (!/^image\/(?:png|jpeg|webp)$/i.test(file.type)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(typeof reader.result === 'string' ? reader.result : null), { once: true });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Could not read image.')), { once: true });
    reader.readAsDataURL(file);
  });
}

export async function pickImages(trigger: HTMLElement, maxFiles: number): Promise<string[]> {
  if (!window.api?.selectImagesDialog || maxFiles < 1) return [];
  return (await withButtonLoading(trigger, async () =>
    (await window.api.selectImagesDialog(maxFiles))
      .map(file => file.base64)
      .filter((base64): base64 is string => !!base64))) ?? [];
}

export async function readDroppedImages(files: Iterable<File>, maxFiles: number): Promise<string[]> {
  const images: string[] = [];
  for (const file of [...files].slice(0, Math.max(0, maxFiles))) {
    const data = await readImageFile(file);
    if (data) images.push(data);
  }
  return images;
}

export async function cropDroppedImages(
  files: Iterable<File>,
  maxFiles: number,
  shape: ImageCropShape = 'avatar',
): Promise<string[]> {
  return (await cropDroppedImageEntries(files, maxFiles, shape)).map(image => image.cropped);
}

export async function cropDroppedImageEntries(
  files: Iterable<File>,
  maxFiles: number,
  shape: ImageCropShape = 'avatar',
): Promise<CroppedImage[]> {
  const selected = [...files].slice(0, Math.max(0, maxFiles));
  const originals: string[] = [];
  for (const file of selected) {
    const data = await readImageFile(file);
    if (data) originals.push(data);
  }
  const cropped = await openImageCropperBatch(originals, shape);
  return cropped?.map((image, index) => ({ original: originals[index], cropped: image })) ?? [];
}
