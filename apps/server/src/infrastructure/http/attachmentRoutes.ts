import fs from 'fs';
import type http from 'http';
import { ProtocolErrorCode } from '@monky/shared';
import type { AttachmentService } from '../../application/services/AttachmentService';
import type { AttachmentStorageService } from '../security/AttachmentStorageService';
import { Logger } from '../logger/Logger';
import { GET_OR_HEAD, sendJson, sendStatus, type HttpRoute } from './HttpRouter';
import { decodePathSegment, serveFile } from './serveFile';

/** An upload that sends nothing for this long is abandoned. */
const UPLOAD_IDLE_TIMEOUT_MS = 60_000;
/**
 * Past its idle allowance, an upload must keep this average pace. Any real link
 * is far faster; a client trickling bytes just often enough to dodge the idle
 * limit would otherwise hold its connection for good (S-WS-11).
 */
const UPLOAD_MIN_BYTES_PER_SECOND = 1024;
const DISK_FULL = new Set(['ENOSPC', 'EDQUOT']);

export interface AttachmentRouteOptions {
  attachments: AttachmentService;
  storage: AttachmentStorageService;
  /** Whether the member may still post files in the channel; asked again once the bytes are in. */
  canUpload: (userId: string, channelId: string) => Promise<boolean>;
  /** Replaces the idle allowance of an upload, which also delays its minimum pace, for tests. */
  uploadIdleTimeoutMs?: number;
}

/** Chat attachments (#11): the upload authorized by a token, and the download whose URL is the capability. */
export function attachmentRoutes(options: AttachmentRouteOptions): HttpRoute[] {
  return [
    {
      methods: ['POST'],
      path: '/attachments',
      handle: (req, res, target) => receiveUpload(req, res, target.query, options),
    },
    {
      methods: GET_OR_HEAD,
      path: '/attachments/',
      handle: async (req, res, target) => {
        const name = decodePathSegment(target.pathname, '/attachments/');
        const file = name === null ? null : options.storage.getFile(name);
        if (!file) {
          sendStatus(res, 404);
          return;
        }
        await serveFile(req, res, file, {
          // <img> and <video> send no credentials, so whoever holds the URL may
          // read the file; shared caches must not keep a copy of it.
          cacheControl: 'private, max-age=86400',
          inline: file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/'),
        });
      },
    },
  ];
}

/**
 * Streams an upload to a temp file and hands it to the attachment service. The
 * token is spent on arrival, access is checked before and after the bytes, and
 * there is no fixed deadline: a large file on a slow link goes on as long as
 * its bytes keep coming at a minimum pace (S-WS-11).
 */
async function receiveUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  query: URLSearchParams,
  options: AttachmentRouteOptions,
): Promise<void> {
  const { attachments, storage, canUpload } = options;
  const binding = attachments.consumeUploadToken(query.get('token'));
  if (!binding || !await canUpload(binding.userId, binding.channelId)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const originalName = (query.get('name') || 'arquivo').slice(0, 255);
  const maxFileBytes = await attachments.getMaxFileBytes();
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength && declaredLength > maxFileBytes) {
    sendJson(res, 413, { error: ProtocolErrorCode.ATTACHMENT_TOO_LARGE });
    return;
  }
  if (req.destroyed) return;

  const tempPath = storage.createTempPath();
  const out = fs.createWriteStream(tempPath);
  const idleTimeoutMs = options.uploadIdleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS;
  // Monotonic: a clock adjusted by NTP must not cut, or extend, an upload.
  const startedAt = performance.now();
  let received = 0;
  // Set once the answer is decided: the abort, or every byte safely on disk.
  let settled = false;

  const abort = (status: number, body: unknown): void => {
    if (settled) return;
    settled = true;
    req.setTimeout(0);
    // Removed after closing: until the stream opens it there is no file to remove.
    if (out.closed) storage.discardTemp(tempPath);
    else out.once('close', () => storage.discardTemp(tempPath));
    out.destroy();
    sendJson(res, status, body);
  };

  const finalize = async (): Promise<void> => {
    try {
      if (!await canUpload(binding.userId, binding.channelId)) {
        storage.discardTemp(tempPath);
        sendJson(res, 400, { error: ProtocolErrorCode.CHANNEL_NOT_FOUND });
        return;
      }
      const result = await attachments.finalizeUpload({
        tempPath, sizeBytes: received, userId: binding.userId, channelId: binding.channelId, originalName,
      });
      if (result.success && result.meta) {
        sendJson(res, 200, result.meta);
        return;
      }
      sendJson(res, failureStatus(result.errorCode), { error: result.errorCode, message: result.errorMessage });
    } catch (error) {
      storage.discardTemp(tempPath);
      Logger.error('ATTACHMENT', 'Could not store an attachment upload.', error);
      sendJson(res, 500, { error: ProtocolErrorCode.INTERNAL_ERROR });
    }
  };

  req.setTimeout(idleTimeoutMs, () => abort(408, { error: ProtocolErrorCode.BAD_REQUEST }));

  // Without this listener a full disk raised an unhandled 'error' and stopped the server (S-WS-1).
  out.on('error', (error: NodeJS.ErrnoException) => {
    Logger.error('ATTACHMENT', 'Could not write an attachment upload to disk.', error);
    if (DISK_FULL.has(error.code ?? '')) abort(507, { error: ProtocolErrorCode.STORAGE_FULL });
    else abort(500, { error: ProtocolErrorCode.INTERNAL_ERROR });
  });
  out.once('finish', () => {
    if (settled) return;
    settled = true;
    void finalize();
  });

  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    received += chunk.length;
    if (received > maxFileBytes) {
      abort(413, { error: ProtocolErrorCode.ATTACHMENT_TOO_LARGE });
      return;
    }
    if (performance.now() - startedAt > idleTimeoutMs + received * 1000 / UPLOAD_MIN_BYTES_PER_SECOND) {
      abort(408, { error: ProtocolErrorCode.BAD_REQUEST });
      return;
    }
    if (!out.write(chunk)) {
      req.pause();
      out.once('drain', () => req.resume());
    }
  });
  req.on('error', () => abort(400, { error: ProtocolErrorCode.BAD_REQUEST }));
  req.on('end', () => {
    if (settled) return;
    // Every byte arrived; what remains is ours, and the idle timer would cut the answer.
    req.setTimeout(0);
    out.end();
  });
}

function failureStatus(code: ProtocolErrorCode | undefined): number {
  if (code === ProtocolErrorCode.ATTACHMENT_TOO_LARGE) return 413;
  if (code === ProtocolErrorCode.STORAGE_FULL) return 507;
  return 400;
}
