import { initialImageState } from './imageFallback';

/**
 * A picture painted over its initial, as the server rail draws servers: the
 * letter shows until the image loads and stays when it fails (`imageFallback`
 * removes the broken image). `url` must already be resolved by `resolveImageUrl`.
 */
export function initialPicture(url: string | null, initial: string): HTMLSpanElement {
  const picture = document.createElement('span');
  picture.className = 'initial-picture';
  picture.setAttribute('aria-hidden', 'true');
  const letter = document.createElement('span');
  letter.className = 'initial-picture-letter';
  letter.dataset.fallbackInitialSlot = '';
  letter.textContent = initial;
  picture.append(letter);
  const state = url ? initialImageState(url) : 'failed';
  if (url && state !== 'failed') {
    const image = document.createElement('img');
    image.className = 'initial-picture-image';
    image.alt = '';
    image.draggable = false;
    image.dataset.fallback = 'initial';
    image.dataset.fallbackInitial = initial;
    if (state === 'loaded') image.dataset.loaded = '1';
    image.src = url;
    picture.append(image);
  }
  return picture;
}
