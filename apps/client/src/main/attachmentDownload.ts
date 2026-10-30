import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const MAX_REDIRECTS = 5;
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

/**
 * Downloads a web URL (an attachment of a connected server, possibly on the
 * LAN) into `destPath` through a temporary file.
 *
 * Every hop, redirects included, must stay on http(s). The server picks where
 * a redirect points: a `Location` with another scheme, or one that is not a
 * URL at all, used to throw inside the response callback, which crashed the
 * main process and left the download waiting forever (E-MAIN-5).
 */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const tempPath = `${destPath}.downloading`;
  return await new Promise((resolve, reject) => {
    const requestDownload = (currentUrl: URL, redirects: number): void => {
      if (redirects > MAX_REDIRECTS) {
        reject(new Error('Too many redirects'));
        return;
      }
      if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
        reject(new Error(`Refused to download from a ${currentUrl.protocol} URL`));
        return;
      }

      const transport = currentUrl.protocol === 'https:' ? https : http;
      let request: http.ClientRequest;
      try {
        request = transport.get(currentUrl, { headers: { 'User-Agent': 'Monky-App' } }, (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            const locationHeader = response.headers.location;
            const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
            response.resume();
            if (!location) {
              reject(new Error(`HTTP ${status}`));
              return;
            }
            let next: URL;
            try {
              next = new URL(location, currentUrl);
            } catch {
              reject(new Error('The download redirected to an invalid address'));
              return;
            }
            requestDownload(next, redirects + 1);
            return;
          }

          if (status !== 200) {
            response.resume();
            reject(new Error(`HTTP ${status}`));
            return;
          }

          const file = fs.createWriteStream(tempPath);
          let settled = false;
          const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            file.destroy();
            fs.unlink(tempPath, () => reject(err));
          };

          response.on('aborted', () => fail(new Error('Download aborted')));
          response.on('error', fail);
          file.on('error', fail);
          file.on('finish', () => {
            if (settled) return;
            file.close(async (closeErr) => {
              if (closeErr) {
                fail(closeErr);
                return;
              }
              try {
                try {
                  await fs.promises.rm(destPath, { force: true });
                  await fs.promises.rename(tempPath, destPath);
                } catch {
                  // Fallback para cross-device ou locks temporários do Windows
                  await fs.promises.copyFile(tempPath, destPath);
                  await fs.promises.unlink(tempPath).catch(() => {});
                }
                settled = true;
                resolve();
              } catch (err: unknown) {
                fail(err instanceof Error ? err : new Error(String(err)));
              }
            });
          });
          response.pipe(file);
        });
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      request.setTimeout(IDLE_TIMEOUT_MS, () => {
        request.destroy(new Error('Download timeout'));
      });
      request.on('error', reject);
    };

    let initial: URL;
    try {
      initial = new URL(url);
    } catch {
      reject(new Error('Invalid download URL'));
      return;
    }
    requestDownload(initial, 0);
  });
}
