import { AttachmentKind } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';

/** The only attachment address a server produces: `/attachments/<uuid>.<ext>` (#11). */
const ATTACHMENT_PATH = /^\/attachments\/[A-Za-z0-9._-]+$/;

/**
 * Resolves an attachment path served by the host (e.g. "/attachments/<file>")
 * against `baseUrl`, mirroring resolveAvatarUrl (#11). Returns an empty string
 * when there is no url (evicted), no connection, or the value is not one of the
 * server's own attachment paths: a hostile server cannot point the chat, the
 * forward or the sticker download at another address, a local file or markup.
 */
export function resolveAttachmentUrl(url: string | null | undefined, baseUrl: string): string {
  if (!url || !baseUrl || !ATTACHMENT_PATH.test(url)) return '';
  return `${baseUrl}${url}`;
}

/** Attachment address on the server on screen; see `resolveAttachmentUrl`. */
export function getAttachmentUrl(url?: string | null): string {
  return resolveAttachmentUrl(url, networkClient.getHttpBaseUrl());
}

/** Human-readable file size, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  const rounded = value >= 100 || i === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/** Material Symbols icon name for a non-previewable attachment chip. */
export function fileIconName(kind: AttachmentKind, mimeType: string, name: string): string {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'movie';
  const lower = (name || '').toLowerCase();
  if (mimeType.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/.test(lower)) return 'audio_file';
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) return 'picture_as_pdf';
  if (/\.(zip|rar|7z|tar|gz|bz2)$/.test(lower)) return 'folder_zip';
  if (/\.(doc|docx|odt|rtf)$/.test(lower)) return 'description';
  if (/\.(xls|xlsx|ods|csv)$/.test(lower)) return 'table_chart';
  if (/\.(ppt|pptx|odp)$/.test(lower)) return 'slideshow';
  if (/\.(js|ts|tsx|jsx|py|java|c|cpp|cs|go|rs|rb|php|html|css|json|xml|sh)$/.test(lower)) return 'code';
  return 'draft';
}
