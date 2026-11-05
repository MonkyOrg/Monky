/** Image types a chat sticker (#356) may be, by lower-case file extension. */
export const STICKER_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
};

/**
 * Animated GIFs and WebPs are routinely a few megabytes, so the ceiling has to
 * be generous enough not to quietly swallow a normal sticker. The server
 * accepts far more; the tighter bound exists only because the renderer decodes
 * these as base64 data URLs, which costs ~33% on top of the file size.
 */
export const MAX_STICKER_BYTES = 8 * 1024 * 1024;
export const MAX_STICKERS_LISTED = 500;

export function stickerMimeType(extension: string): string | undefined {
  return Object.hasOwn(STICKER_MIME_TYPES, extension) ? STICKER_MIME_TYPES[extension] : undefined;
}
