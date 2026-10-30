export function fitOverlayCards(width: number, height: number, count: number, layout: string, preserveAspectRatio = true, aspectRatio = 16 / 9) {
  if (width <= 0 || height <= 0 || count < 1) return { columns: 1, width: 0, height: 0 };
  const { columns, rows } = arrangeOverlayCards({ width: 0, height: 0 }, count, layout);
  const cellWidth = Math.max(0, (width - (columns - 1) * 6) / columns);
  const cellHeight = Math.max(0, (height - (rows - 1) * 6) / rows);
  const cardWidth = preserveAspectRatio ? Math.min(cellWidth, cellHeight * aspectRatio) : cellWidth;
  return { columns, width: cardWidth, height: preserveAspectRatio ? cardWidth / aspectRatio : cellHeight };
}

export function arrangeOverlayCards(size: { width: number; height: number }, count: number, layout: string) {
  const columns = layout === 'vertical' ? 1 : layout === 'horizontal' ? Math.max(1, count) : Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  return { columns, rows, width: columns * size.width + (columns - 1) * 6,
    height: rows * size.height + Math.max(0, rows - 1) * 6 };
}

/** RTCResolutionRestriction: the encoder scales a larger frame down to fit it, keeping the aspect ratio. */
export interface FrameRestriction {
  maxWidth: number;
  maxHeight: number;
}

/**
 * The largest frame worth sending to an overlay card. A card shows at most its
 * own size in device pixels, so a bigger frame is only encoded, decoded and
 * then scaled down again on screen (R-MEDIA-2). `contain` shows the whole frame
 * inside the card; `cover` crops it to fill the card, so the frame must cover
 * the card in both directions, which depends on the source's aspect ratio.
 * While that is unknown, a square on the card's longer side covers it for
 * frames from square up to the card's own proportion.
 */
export function overlayFrameRestriction(
  card: { width: number; height: number },
  pixelRatio: number,
  fit: 'contain' | 'cover',
  source?: { width?: number; height?: number },
): FrameRestriction {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const width = Math.max(1, card.width * ratio), height = Math.max(1, card.height * ratio);
  if (fit === 'contain') return { maxWidth: Math.ceil(width), maxHeight: Math.ceil(height) };
  const aspect = source?.width && source.height ? source.width / source.height : 0;
  if (!aspect) {
    const side = Math.ceil(Math.max(width, height));
    return { maxWidth: side, maxHeight: side };
  }
  return aspect >= width / height
    ? { maxWidth: Math.ceil(height * aspect), maxHeight: Math.ceil(height) }
    : { maxWidth: Math.ceil(width), maxHeight: Math.ceil(width / aspect) };
}
