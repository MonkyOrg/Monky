import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger/Logger';

export type AttachmentKindDetected = 'image' | 'video' | 'file';

export interface AttachmentClassification {
  kind: AttachmentKindDetected;
  mimeType: string;
  extension: string;
  // image/video are validated by magic bytes and may be previewed inline; every
  // other file is served as a forced download (Content-Disposition: attachment).
  previewable: boolean;
}

/**
 * Stores chat attachments on the host's disk and serves them over HTTP, mirroring
 * AvatarStorageService (#11). Uploads are streamed to a temp file first, so the
 * whole binary never needs to sit in memory; only the first bytes are read to
 * classify the file. The type is decided by magic bytes — never by the
 * client-declared mime — so a file that gets an inline preview is guaranteed to
 * really be an image/video (avoids serving HTML/SVG/JS that would run in a
 * browser context).
 */
export class AttachmentStorageService {
  private attachmentsDir: string;
  private tmpDir: string;

  constructor(baseDataDir: string) {
    this.attachmentsDir = path.join(baseDataDir, 'attachments');
    this.tmpDir = path.join(this.attachmentsDir, 'tmp');
    if (!fs.existsSync(this.attachmentsDir)) {
      fs.mkdirSync(this.attachmentsDir, { recursive: true });
    }
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
    this.cleanupTempDir();
  }

  /** Returns a fresh temp path to stream an incoming upload into. */
  public createTempPath(): string {
    return path.join(this.tmpDir, `${uuidv4()}.part`);
  }

  /** Best-effort removal of a temp file (e.g. after an aborted/failed upload). */
  public discardTemp(tempPath: string): void {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  }

  /** Removes any leftover temp files from a previous crash on startup. */
  private cleanupTempDir(): void {
    try {
      for (const f of fs.readdirSync(this.tmpDir)) {
        try {
          fs.unlinkSync(path.join(this.tmpDir, f));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** Reads the leading bytes of a file to classify it by magic number. */
  public classifyFile(filePath: string, originalName: string): AttachmentClassification {
    let head = Buffer.alloc(0);
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(16);
        const bytes = fs.readSync(fd, buf, 0, 16, 0);
        head = buf.subarray(0, bytes);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* fall through to 'file' */
    }
    return this.classifyHead(head, originalName);
  }

  /** Classifies from the first bytes of the file. Public for unit testing. */
  public classifyHead(b: Buffer, originalName: string): AttachmentClassification {
    // PNG
    if (
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
    ) {
      return { kind: 'image', mimeType: 'image/png', extension: 'png', previewable: true };
    }
    // JPEG
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      return { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg', previewable: true };
    }
    // GIF (GIF87a / GIF89a)
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
      return { kind: 'image', mimeType: 'image/gif', extension: 'gif', previewable: true };
    }
    // RIFF containers: WEBP (image) or AVI (video)
    const isRIFF = b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
    if (isRIFF) {
      if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        return { kind: 'image', mimeType: 'image/webp', extension: 'webp', previewable: true };
      }
      if (b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49 && b[11] === 0x20) {
        return { kind: 'video', mimeType: 'video/x-msvideo', extension: 'avi', previewable: true };
      }
      if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) {
        return { kind: 'file', mimeType: 'audio/wav', extension: 'wav', previewable: true };
      }
    }
    // MP4 / MOV / M4V: 'ftyp' box at offset 4
    if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      return { kind: 'video', mimeType: 'video/mp4', extension: 'mp4', previewable: true };
    }
    // WebM / Matroska (EBML header)
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      return { kind: 'video', mimeType: 'video/webm', extension: 'webm', previewable: true };
    }
    // Anything else: an arbitrary file, always served as a forced download.
    const ext = this.safeExtension(originalName) || 'bin';
    return { kind: 'file', mimeType: 'application/octet-stream', extension: ext, previewable: false };
  }

  /** Extracts a short, safe extension from a user-provided filename. */
  private safeExtension(originalName: string): string {
    const raw = path.extname(originalName || '').replace('.', '').toLowerCase();
    const cleaned = raw.replace(/[^a-z0-9]/g, '');
    return cleaned.slice(0, 8);
  }

  /**
   * Moves a completed temp upload to its final `<uuid>.<ext>` location and returns
   * the on-disk filename, guarding against path traversal.
   */
  public finalizeFromTemp(tempPath: string, extension: string): string {
    const filename = `${uuidv4()}.${extension}`;
    const filePath = path.join(this.attachmentsDir, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.attachmentsDir))) {
      throw new Error('Path traversal attempt detected');
    }
    fs.renameSync(tempPath, filePath);
    Logger.info('SECURITY', `Attachment stored safely as ${filename}`);
    return filename;
  }

  /** Public HTTP path served by the host for an attachment. */
  public getPublicUrl(filename: string | null | undefined): string | null {
    if (!filename) return null;
    return `/attachments/${path.basename(filename)}`;
  }

  /**
   * Resolves an attachment filename to an on-disk file for the HTTP handler,
   * guarding against path traversal. Returns null if it does not exist.
   */
  public getFile(filename: string): { filePath: string; size: number; mimeType: string } | null {
    if (!filename) return null;
    const safeFilename = path.basename(filename);
    const filePath = path.join(this.attachmentsDir, safeFilename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.attachmentsDir))) {
      return null;
    }
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const stat = fs.statSync(filePath);
    return { filePath, size: stat.size, mimeType: this.mimeForExtension(safeFilename) };
  }

  private mimeForExtension(filename: string): string {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'mp4':
      case 'm4v':
        return 'video/mp4';
      case 'webm':
        return 'video/webm';
      case 'avi':
        return 'video/x-msvideo';
      default:
        return 'application/octet-stream';
    }
  }

  /** Removes an attachment file from disk (best-effort). */
  public delete(filename: string | null | undefined): void {
    if (!filename) return;
    const safeFilename = path.basename(filename);
    const filePath = path.join(this.attachmentsDir, safeFilename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        Logger.warn('SECURITY', `Could not delete attachment: ${filename}`);
      }
    }
  }

  /** Lists all files currently on disk (for orphan reconciliation on startup). */
  public listDiskFilenames(): string[] {
    try {
      return fs
        .readdirSync(this.attachmentsDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}
