import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpGetError, httpGet } from './net/httpGet';

const IDLE_TIMEOUT_MS = 30_000;

export function sanitizeDownloadFileName(fileName: string): string {
  const baseName = path.basename((fileName || '').trim()) || 'download';
  const sanitized = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return sanitized || 'download';
}

/**
 * Name offered by the save dialog: the one the renderer knows, otherwise the
 * last segment of the URL. A malformed escape in that segment is kept as typed
 * instead of failing the whole download.
 */
export function suggestedDownloadName(url: URL, fileName: unknown): string {
  if (typeof fileName === 'string' && fileName.trim()) return sanitizeDownloadFileName(fileName);
  const segment = path.posix.basename(url.pathname) || 'download';
  try {
    return sanitizeDownloadFileName(decodeURIComponent(segment));
  } catch {
    return sanitizeDownloadFileName(segment);
  }
}

/** The messages the download toast has always shown. */
function downloadError(error: unknown): unknown {
  if (error instanceof HttpGetError) {
    switch (error.failure) {
      case 'refused': return new Error(`Refused to download from a ${error.url.protocol} URL`);
      case 'redirects': return new Error('Too many redirects');
      case 'invalid-redirect': return new Error('The download redirected to an invalid address');
      case 'timeout': return new Error('Download timeout');
    }
  }
  // Node's error for a body whose connection closed before all of it arrived.
  if (error instanceof Error && error.message === 'aborted' && 'code' in error && error.code === 'ECONNRESET') {
    return new Error('Download aborted');
  }
  return error;
}

/**
 * Downloads a web URL (an attachment of a connected server, possibly on the
 * LAN) into `destPath` through a temporary file. Any http(s) host is allowed,
 * because the attachment comes from the server the user chose to join, but
 * every hop must stay on http(s) (see `httpGet`). The download fails once the
 * connection stays silent for `idleTimeoutMs`, before or during the body.
 */
export async function downloadToFile(url: string, destPath: string, idleTimeoutMs = IDLE_TIMEOUT_MS): Promise<void> {
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw new Error('Invalid download URL');
  }
  const tempPath = `${destPath}.downloading`;
  try {
    const response = await httpGet(address, {
      allows: () => true, headers: { 'User-Agent': 'Monky-App' }, idleTimeoutMs,
    });
    if (response.status !== 200) {
      response.body.resume();
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(response.body, fs.createWriteStream(tempPath));
    try {
      await fs.promises.rm(destPath, { force: true });
      await fs.promises.rename(tempPath, destPath);
    } catch {
      // Fallback para cross-device ou locks temporários do Windows
      await fs.promises.copyFile(tempPath, destPath);
    }
  } catch (error) {
    throw downloadError(error);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
