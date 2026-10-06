import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { LIMITS } from '@monky/shared';
import { Logger } from '../logger/Logger';

export interface AvatarValidationResult {
  isValid: boolean;
  error?: string;
  mimeType?: string;
  extension?: string;
  buffer?: Buffer;
}

export class AvatarStorageService {
  private avatarsDir: string;

  constructor(baseDataDir: string) {
    this.avatarsDir = path.join(baseDataDir, 'avatars');
    if (!fs.existsSync(this.avatarsDir)) {
      fs.mkdirSync(this.avatarsDir, { recursive: true });
    }
  }

  /**
   * Validates size and magic bytes of the uploaded avatar image
   */
  public validateAvatarBuffer(buffer: Buffer): AvatarValidationResult {
    if (buffer.length > LIMITS.MAX_AVATAR_SIZE) {
      return {
        isValid: false,
        error: `Tamanho da imagem excede o limite de 5MB (${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      };
    }

    if (buffer.length < 12) {
      return { isValid: false, error: 'Arquivo corrompido ou formato inválido' };
    }

    // Check PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { isValid: true, mimeType: 'image/png', extension: 'png', buffer };
    }

    // Check JPEG magic bytes: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { isValid: true, mimeType: 'image/jpeg', extension: 'jpg', buffer };
    }

    // Check WebP magic bytes: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { isValid: true, mimeType: 'image/webp', extension: 'webp', buffer };
    }

    return {
      isValid: false,
      error: 'Formato não suportado. Utilize apenas arquivos PNG, JPEG ou WebP válidos.',
    };
  }

  /**
   * Saves validated buffer safely without path traversal
   */
  public async saveAvatar(buffer: Buffer, extension: string, prefix = ''): Promise<string> {
    if (prefix && !/^[a-z0-9-]+$/.test(prefix)) throw new Error('Invalid image prefix.');
    const filename = `${prefix}${uuidv4()}.${extension}`;
    const filePath = path.join(this.avatarsDir, filename);

    // Ensure within directory
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.avatarsDir))) {
      throw new Error('Path traversal attempt detected');
    }

    fs.writeFileSync(filePath, buffer);
    Logger.info('SECURITY', `Avatar saved safely as ${filename}`);
    return filename;
  }

  /**
   * Returns the public HTTP path for an avatar (served by the server's HTTP
   * endpoint), instead of embedding the full image as a base64 data URL. This
   * keeps WebSocket payloads (UserSummary, ChatMessage) tiny — clients fetch the
   * image once over HTTP and let the browser cache it.
   */
  public getPublicUrl(filename: string | null | undefined): string | null {
    if (!filename) return null;
    return `/avatars/${path.basename(filename)}`;
  }

  /**
   * Resolves an avatar filename to an on-disk file for the HTTP handler,
   * guarding against path traversal. Returns null if the file does not exist.
   */
  public getAvatarFile(filename: string): { filePath: string; mimeType: string } | null {
    if (!filename) return null;
    const safeFilename = path.basename(filename);
    const filePath = path.join(this.avatarsDir, safeFilename);

    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.avatarsDir))) {
      return null;
    }
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const ext = path.extname(safeFilename).toLowerCase().replace('.', '');
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { filePath, mimeType };
  }

  /**
   * Removes an old avatar file
   */
  public deleteAvatar(filename: string): void {
    if (!filename) return;
    const safeFilename = path.basename(filename);
    const filePath = path.join(this.avatarsDir, safeFilename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        Logger.warn('SECURITY', `Could not delete old avatar: ${filename}`);
      }
    }
  }

  public renameAvatar(filename: string, prefix: string): string {
    if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error('Invalid image prefix.');
    const source = this.getAvatarFile(filename);
    if (!source) throw new Error('Image asset not found.');
    const extension = path.extname(filename);
    const next = `${prefix}${uuidv4()}${extension}`;
    fs.renameSync(source.filePath, path.join(this.avatarsDir, next));
    return next;
  }

  public deleteAvatarsWithPrefix(prefix: string): void {
    if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error('Invalid image prefix.');
    for (const filename of fs.readdirSync(this.avatarsDir)) {
      if (filename.startsWith(prefix)) this.deleteAvatar(filename);
    }
  }
}
