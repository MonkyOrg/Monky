import fs from 'fs';
import type http from 'http';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Logger } from '../logger/Logger';
import { sendStatus } from './HttpRouter';

/** A file resolved by one of the storage services. */
export interface StoredFile {
  filePath: string;
  mimeType: string;
}

export interface ServeFileOptions {
  cacheControl: string;
  /** False forces a download, so only validated images and videos render in a browser (#11). */
  inline: boolean;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * How a download ends when the client goes away, which players do on every
 * seek. ERR_STREAM_UNABLE_TO_PIPE is the client gone before the first byte.
 */
const CLIENT_GONE = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_UNABLE_TO_PIPE', 'ECONNRESET', 'EPIPE']);

/**
 * Decodes the single path segment after `prefix`, or returns null when it
 * cannot name a stored file: malformed percent-encoding (whose URIError used
 * to escape the request listener and stop the server), an empty name, a dot
 * segment or a separator (S-WS-1). The storage services still confine the
 * name to their own folder.
 */
export function decodePathSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return segment === '' || segment === '.' || segment === '..' || /[\\/\0]/.test(segment) ? null : segment;
}

/**
 * Sends a stored file with the same rules on every route: HEAD, single byte
 * ranges, an exact Content-Length and `nosniff`.
 *
 * The file is opened and checked before any header goes out, so a folder or
 * a file deleted meanwhile is a 404 rather than a stream error nobody listens
 * to. `pipeline` then owns both ends: when the client aborts, the descriptor is
 * closed instead of staying open behind a paused stream (S-WS-1).
 */
export async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: StoredFile,
  options: ServeFileOptions,
): Promise<void> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file.filePath, 'r');
  } catch {
    sendStatus(res, 404);
    return;
  }
  try {
    await sendOpenFile(req, res, handle, file, options);
  } finally {
    // Every way out releases the descriptor here. A client gone before the
    // first byte used to leave it to the garbage collector: Node refuses to pipe
    // into a closed response and never touches the read stream (S-WS-1).
    await handle.close();
  }
}

async function sendOpenFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handle: fs.promises.FileHandle,
  file: StoredFile,
  options: ServeFileOptions,
): Promise<void> {
  let size: number;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Not a regular file.');
    size = stats.size;
  } catch {
    sendStatus(res, 404);
    return;
  }
  // The client may have left while the file was being opened.
  if (res.destroyed) return;

  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }

  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': file.mimeType,
    'Content-Length': String(range ? range.end - range.start + 1 : size),
    'Cache-Control': options.cacheControl,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  if (!options.inline) headers['Content-Disposition'] = 'attachment';
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);

  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const body = handle.createReadStream(range ?? {});
  try {
    await pipeline(body, res);
  } catch (error) {
    body.destroy();
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (!CLIENT_GONE.has(code)) {
      Logger.warn('NETWORK', `Could not send ${path.basename(file.filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * A single `bytes=` range, or null to send the whole file: no header, or a form
 * this server does not split (several ranges). A start past the end is
 * unsatisfiable.
 */
function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    // `bytes=-N` is the last N bytes, not the first.
    const length = Number(match[2]);
    return length > 0 && size > 0 ? { start: Math.max(0, size - length), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start < size && start <= end ? { start, end } : 'unsatisfiable';
}
