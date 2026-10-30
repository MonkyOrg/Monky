import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { LIMITS, ProtocolErrorCode } from '@monky/shared';
import { Logger } from '../logger/Logger';

export interface AvatarValidationResult {
  isValid: boolean;
  error?: string;
  mimeType?: string;
  extension?: string;
  buffer?: Buffer;
}

/** An uploaded image whose bytes were checked, ready to be stored. */
export interface DecodedImage {
  ok: true;
  buffer: Buffer;
  extension: string;
  mimeType: string;
  /**
   * The type a `data:` prefix announced, if any. Older desktop apps named it
   * after the file picked, so only bots are held to it (BotService).
   */
  declaredType?: string;
}

export interface ImageRefusal {
  ok: false;
  code: ProtocolErrorCode.AVATAR_INVALID_TYPE | ProtocolErrorCode.AVATAR_TOO_LARGE;
  message: string;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function tooLarge(bytes: number): string {
  return `Tamanho da imagem excede o limite de 5MB (${(bytes / (1024 * 1024)).toFixed(2)}MB)`;
}

function invalidImage(message = 'Formato de imagem inválido. Utilize PNG, JPEG ou WebP.'): ImageRefusal {
  return { ok: false, code: ProtocolErrorCode.AVATAR_INVALID_TYPE, message };
}

/** Where a stored image is served from; reads nothing, so pure mappings can use it. */
export function publicImageUrl(filename: string | null | undefined): string | null {
  return filename ? `/avatars/${path.basename(filename)}` : null;
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
        error: tooLarge(buffer.length),
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
   * Reads an uploaded image (raw base64 or a PNG, JPEG or WebP data URL) the
   * same way for every way in: avatars, the server icon, community images and
   * bot avatars (S-APP-9). The base64 must be canonical, and the size is
   * checked before anything is decoded.
   */
  public decodeImage(input: string): DecodedImage | ImageRefusal {
    let encoded = input;
    let declaredType: string | undefined;
    if (input.startsWith('data:')) {
      const match = DATA_URL.exec(input);
      if (!match) return invalidImage();
      declaredType = match[1];
      encoded = match[2];
    }
    if (!encoded || encoded.length % 4 !== 0 || !BASE64.test(encoded)) return invalidImage();
    const bytes = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (bytes > LIMITS.MAX_AVATAR_SIZE) return { ok: false, code: ProtocolErrorCode.AVATAR_TOO_LARGE, message: tooLarge(bytes) };
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.toString('base64') !== encoded) return invalidImage();
    const validation = this.validateAvatarBuffer(buffer);
    if (!validation.isValid || !validation.extension || !validation.mimeType) return invalidImage(validation.error);
    return { ok: true, buffer, extension: validation.extension, mimeType: validation.mimeType, ...(declaredType ? { declaredType } : {}) };
  }

  /**
   * Stores `image`, then lets `commit` record its name, and only then removes
   * `previous`. When the commit fails the new file goes and the previous one
   * stays, so a failed write never leaves anyone pointing at a deleted image.
   */
  public async replaceImage(
    previous: string | null | undefined, image: DecodedImage, commit: (filename: string) => Promise<void> | void,
  ): Promise<string> {
    const filename = await this.saveAvatar(image.buffer, image.extension);
    try {
      await commit(filename);
    } catch (error) {
      this.deleteAvatar(filename);
      throw error;
    }
    if (previous && previous !== filename) this.deleteAvatar(previous);
    return filename;
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
    return publicImageUrl(filename);
  }

  /**
   * Resolves an avatar filename to an on-disk file for the HTTP handler,
   * guarding against path traversal. Returns null unless it is a regular file:
   * `/avatars/.` named the folder itself, and serving it crashed the server
   * (S-WS-1).
   */
  public getAvatarFile(filename: string): { filePath: string; mimeType: string } | null {
    if (!filename) return null;
    const safeFilename = path.basename(filename);
    const filePath = path.join(this.avatarsDir, safeFilename);

    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.avatarsDir))) {
      return null;
    }
    if (!isRegularFile(filePath)) {
      return null;
    }

    const ext = path.extname(safeFilename).toLowerCase().replace('.', '');
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { filePath, mimeType };
  }

  /** Whether a stored avatar already holds exactly these bytes, so saving them again can be skipped. */
  public hasContent(filename: string, buffer: Buffer): boolean {
    const file = this.getAvatarFile(filename);
    if (!file) return false;
    try {
      return fs.statSync(file.filePath).size === buffer.length && fs.readFileSync(file.filePath).equals(buffer);
    } catch {
      return false;
    }
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

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
