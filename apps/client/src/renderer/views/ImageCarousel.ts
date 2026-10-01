import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import {
  resolveBotCarouselPresentation,
  type BotCarouselPresentation,
} from '@monky/shared';

function source(url: string, baseUrl: string): string {
  return /^(?:data:|blob:|https?:)/.test(url) ? url : `${baseUrl}${url}`;
}

function renderCarousel(
  urls: string[],
  baseUrl: string,
  label: string,
  className = '',
  editorControls = '',
  initialIndex = 0,
  presentation?: BotCarouselPresentation,
): string {
  if (urls.length === 0) return '';
  const selectedIndex = Math.min(urls.length - 1, Math.max(0, initialIndex));
  const images = urls.map((url, index) => `<img class="image-carousel-slide" src="${escapeHtml(source(url, baseUrl))}"
    alt="${escapeHtml(t('community.imagePosition', { current: index + 1, total: urls.length }))}" loading="lazy">`).join('');
  const presentationClass = presentation ? imageCarouselPresentationClass(presentation) : '';
  return `<section class="image-carousel${className ? ` ${className}` : ''}${presentationClass ? ` ${presentationClass}` : ''}" data-image-carousel data-carousel-index="${selectedIndex}"
    aria-label="${escapeHtml(label)}">
    <div class="image-carousel-track"${selectedIndex > 0 ? ` style="transform:translateX(${-100 * selectedIndex}%)"` : ''}>${images}</div>
    ${editorControls}
    ${urls.length > 1 ? `<button type="button" class="image-carousel-arrow image-carousel-arrow--previous"
      data-carousel-move="-1" aria-label="${escapeHtml(t('community.previous'))}"><span class="material-symbols-outlined">chevron_left</span></button>
      <button type="button" class="image-carousel-arrow image-carousel-arrow--next"
      data-carousel-move="1" aria-label="${escapeHtml(t('community.next'))}"><span class="material-symbols-outlined">chevron_right</span></button>
      <div class="image-carousel-dots" role="group" aria-label="${escapeHtml(label)}">${urls.map((_, index) =>
        `<button type="button" class="image-carousel-dot${index === selectedIndex ? ' is-active' : ''}" data-carousel-index="${index}"
          aria-label="${escapeHtml(t('community.imagePosition', { current: index + 1, total: urls.length }))}"
          aria-current="${index === selectedIndex ? 'true' : 'false'}"></button>`).join('')}</div>` : ''}
  </section>`;
}

export function imageCarouselPresentationClass(presentation?: BotCarouselPresentation): string {
  const resolved = resolveBotCarouselPresentation(presentation);
  return `image-carousel--format-${resolved.format} image-carousel--fit-${resolved.fit} image-carousel--size-${resolved.size}`;
}

export function renderImageCarousel(
  urls: string[],
  baseUrl = '',
  label = t('community.images'),
  presentation?: BotCarouselPresentation,
): string {
  return renderCarousel(urls, baseUrl, label, '', '', 0, presentation);
}

export function renderImageDropzone(disabled = false, presentation?: BotCarouselPresentation): string {
  const presentationClass = imageCarouselPresentationClass(presentation);
  return `<button type="button" class="image-carousel-dropzone ${presentationClass}" data-carousel-dropzone data-carousel-edit="add"
    ${disabled ? 'disabled' : ''}>
    <span class="material-symbols-outlined">add_photo_alternate</span>
    <strong>${escapeHtml(t('community.imageDropTitle'))}</strong>
    <span>${escapeHtml(t('community.imageDropHint'))}</span>
  </button>`;
}

interface ImageCarouselEditorOptions {
  label: string;
  addLabel: string;
  removeLabel: string;
  moveBackLabel: string;
  moveForwardLabel: string;
  adjustLabel?: string;
  disabled?: boolean;
  addDisabled?: boolean;
  initialIndex?: number;
  presentation?: BotCarouselPresentation;
}

export function renderImageCarouselEditor(
  urls: string[],
  options: ImageCarouselEditorOptions,
): string {
  if (urls.length === 0) return '';
  const disabled = options.disabled ? 'disabled' : '';
  const controls = `<div class="image-carousel-editor-toolbar">
    <button type="button" class="image-carousel-editor-add" data-carousel-edit="add"
      ${options.disabled || options.addDisabled ? 'disabled' : ''}>
      <span class="material-symbols-outlined md-18">add_photo_alternate</span>${escapeHtml(options.addLabel)}</button>
    <div class="image-carousel-editor-actions">
      ${options.adjustLabel ? `<button type="button" data-carousel-edit="adjust"
        aria-label="${escapeHtml(options.adjustLabel)}" ${disabled}>
        <span class="material-symbols-outlined md-18">crop_free</span></button>` : ''}
      <button type="button" data-carousel-edit="back" data-carousel-edit-disabled="${!!options.disabled}"
        aria-label="${escapeHtml(options.moveBackLabel)}" ${options.disabled || !options.initialIndex ? 'disabled' : ''}>
        <span class="material-symbols-outlined md-18">arrow_back</span></button>
      <button type="button" data-carousel-edit="forward" data-carousel-edit-disabled="${!!options.disabled}"
        aria-label="${escapeHtml(options.moveForwardLabel)}"
        ${options.disabled || (options.initialIndex ?? 0) >= urls.length - 1 ? 'disabled' : ''}>
        <span class="material-symbols-outlined md-18">arrow_forward</span></button>
      <button type="button" data-carousel-edit="remove" aria-label="${escapeHtml(options.removeLabel)}" ${disabled}>
        <span class="material-symbols-outlined md-18">delete</span></button>
    </div>
  </div>`;
  return renderCarousel(
    urls, '', options.label, 'image-carousel--editor', controls, options.initialIndex, options.presentation,
  );
}

export function imageCarouselNavigationButton(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof Element
    ? target.closest<HTMLButtonElement>('button[data-carousel-move],button[data-carousel-index]:not([data-carousel-edit])')
    : null;
}

export function moveImageCarousel(button: HTMLButtonElement): boolean {
  const carousel = button.closest<HTMLElement>('[data-image-carousel]');
  const movement = Number(button.dataset.carouselMove);
  const requested = Number(button.dataset.carouselIndex);
  if (!carousel || (!Number.isInteger(movement) && !Number.isInteger(requested))) return false;
  const slides = [...carousel.querySelectorAll<HTMLElement>('.image-carousel-slide')];
  if (slides.length < 2) return false;
  const current = Number(carousel.dataset.carouselIndex ?? 0);
  const index = Number.isInteger(requested)
    ? Math.min(slides.length - 1, Math.max(0, requested))
    : (current + movement + slides.length) % slides.length;
  carousel.dataset.carouselIndex = String(index);
  const track = carousel.querySelector<HTMLElement>('.image-carousel-track');
  if (track) track.style.transform = `translateX(${-100 * index}%)`;
  [...carousel.querySelectorAll<HTMLElement>('.image-carousel-dot')].forEach((dot, dotIndex) => {
    dot.classList.toggle('is-active', dotIndex === index);
    dot.setAttribute('aria-current', dotIndex === index ? 'true' : 'false');
  });
  for (const action of ['back', 'forward'] as const) {
    const control = carousel.querySelector<HTMLButtonElement>(`[data-carousel-edit="${action}"]`);
    if (control && control.dataset.carouselEditDisabled !== 'true') {
      control.disabled = action === 'back' ? index === 0 : index === slides.length - 1;
    }
  }
  return true;
}
