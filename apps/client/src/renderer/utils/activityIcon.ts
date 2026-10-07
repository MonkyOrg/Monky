import { LIMITS } from '@monky/shared';

/** Base64 of a JPEG always begins with the FF D8 FF magic, which encodes to `/9j/`. */
const JPEG_BASE64 = /^\/9j\/[A-Za-z0-9+/]*={0,2}$/;

/**
 * Rebuilds the data URI here instead of accepting one off the wire, the same
 * rule the `steam://` links follow: the prefix is ours, and only base64 of a
 * JPEG ever reaches an `<img src>`. The server validates this too — a renderer
 * that trusted it anyway would be one tampered peer away from rendering
 * whatever it was handed.
 */
export function activityIconSrc(iconBase64: string | undefined): string | null {
  if (!iconBase64 || iconBase64.length > LIMITS.MAX_ACTIVITY_ICON_LENGTH) return null;
  if (!JPEG_BASE64.test(iconBase64)) return null;
  return `data:image/jpeg;base64,${iconBase64}`;
}
