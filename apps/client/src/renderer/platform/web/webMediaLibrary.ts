import {
  LIMITS, MAX_STICKERS_LISTED, MAX_STICKER_BYTES, SOUND_AUDIO_MIME_TYPES, STICKER_MIME_TYPES, encodeSoundboardEdit,
  fileNameExtension, isSoundboardAudioExtension, soundDownloadFileNameSchema, stickerMimeType,
  type SoundboardEditInput, type SoundboardEditorSource, type SoundboardFileFailure, type SoundboardFileInput,
  type SoundboardFileResult, type SoundboardOverwriteInput, type SoundboardRenameInput, type SoundboardSavedFile,
  type SoundboardSoundData, type SoundboardSoundEntry, type StickerData, type StickerEntry, type StickerSaveResult,
} from '@monky/shared';
import { t } from '../../i18n';
import { bytesToBase64, pickFiles } from './webFiles';
import { readRecord, readRecordsWithPrefix, writeRecord, writeRecords } from './webStorage';

/**
 * Soundboard sounds and stickers on the web. Chrome and Edge use a real folder
 * through the File System Access API, like the desktop. Other browsers keep the
 * files the user adds in IndexedDB, and "choose folder" adds files there.
 *
 * Folder values are opaque to the rest of the app:
 * - `web-folder:<kind>:<id>/<name>`: the directory handle saved for that kind;
 *   picking another folder changes the id, so stale values stop resolving.
 * - `web-storage:<kind>`: the files kept in the browser.
 * A file path is `<folder>/<file name>`; file names never contain a slash.
 */
type MediaKind = 'soundboard' | 'stickers';

const DIRECTORY_FOLDER = 'web-folder:';
const STORAGE_FOLDER = 'web-storage:';
/** Keeps a runaway selection out of the browser's storage; above both read limits. */
const MAX_STORED_FILE_BYTES = 16 * 1024 * 1024;

interface FolderFile {
  size: number;
  modified: number;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
}

interface MediaFolder {
  list(accept: (name: string) => boolean): Promise<Array<{ name: string; size: number }>>;
  read(name: string): Promise<FolderFile | null>;
  /** False when a file with this name already exists. */
  create(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<boolean>;
  replace(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  remove(name: string): Promise<void>;
}

class FileError extends Error {
  constructor(readonly reason: SoundboardFileFailure) { super(reason); }
}

export function supportsDirectoryPicker(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function directoryFolder(directory: FileSystemDirectoryHandle): MediaFolder {
  const fileHandle = async (name: string): Promise<FileSystemFileHandle | null> => {
    try {
      return await directory.getFileHandle(name);
    } catch (error: unknown) {
      if (isNotFound(error) || error instanceof TypeError) return null;
      throw error;
    }
  };
  const write = async (handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<void> => {
    // The browser writes to a swap file and only replaces the original on close.
    const stream = await handle.createWritable();
    try {
      await stream.write(bytes);
      await stream.close();
    } catch (error: unknown) {
      await stream.abort().catch(() => {});
      throw error;
    }
  };
  return {
    async list(accept) {
      const entries: Array<{ name: string; size: number }> = [];
      for await (const entry of directory.values()) {
        if (entry.kind !== 'file' || !accept(entry.name)) continue;
        entries.push({ name: entry.name, size: (await entry.getFile()).size });
      }
      return entries;
    },
    async read(name) {
      const handle = await fileHandle(name);
      if (!handle) return null;
      const file = await handle.getFile();
      return { size: file.size, modified: file.lastModified, bytes: async () => new Uint8Array(await file.arrayBuffer()) };
    },
    async create(name, bytes) {
      if (await fileHandle(name)) return false;
      await write(await directory.getFileHandle(name, { create: true }), bytes);
      return true;
    },
    async replace(name, bytes) {
      const handle = await fileHandle(name);
      if (!handle) throw new FileError('missing');
      await write(handle, bytes);
    },
    async remove(name) {
      await directory.removeEntry(name);
    },
  };
}

interface StoredMeta { size: number; modified: number }

function isStoredMeta(value: unknown): value is StoredMeta {
  return typeof value === 'object' && value !== null && 'size' in value && typeof value.size === 'number' &&
    'modified' in value && typeof value.modified === 'number';
}

/** Metadata and contents are separate records, so listing never loads the files. */
function storageFolder(kind: MediaKind): MediaFolder {
  const meta = `media:${kind}:meta:`;
  const data = `media:${kind}:data:`;
  const put = (name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> => writeRecords(new Map<string, unknown>([
    [meta + name, { size: bytes.byteLength, modified: Date.now() } satisfies StoredMeta],
    [data + name, bytes.slice().buffer],
  ]), []);
  return {
    async list(accept) {
      const records = await readRecordsWithPrefix(meta);
      return [...records].flatMap(([key, value]) => {
        const name = key.slice(meta.length);
        return isStoredMeta(value) && accept(name) ? [{ name, size: value.size }] : [];
      });
    },
    async read(name) {
      const stored = await readRecord(meta + name);
      if (!isStoredMeta(stored)) return null;
      return {
        size: stored.size,
        modified: stored.modified,
        bytes: async () => {
          const contents = await readRecord(data + name);
          if (!(contents instanceof ArrayBuffer)) throw new FileError('missing');
          return new Uint8Array(contents);
        },
      };
    },
    async create(name, bytes) {
      if (isStoredMeta(await readRecord(meta + name))) return false;
      await put(name, bytes);
      return true;
    },
    async replace(name, bytes) {
      if (!isStoredMeta(await readRecord(meta + name))) throw new FileError('missing');
      await put(name, bytes);
    },
    async remove(name) {
      if (!isStoredMeta(await readRecord(meta + name))) throw new FileError('missing');
      await writeRecords(new Map(), [meta + name, data + name]);
    },
  };
}

interface SavedDirectory { id: string; handle: FileSystemDirectoryHandle }

function isSavedDirectory(value: unknown): value is SavedDirectory {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' &&
    'handle' in value && typeof FileSystemDirectoryHandle === 'function' && value.handle instanceof FileSystemDirectoryHandle;
}

const directoryRecord = (kind: MediaKind): string => `media-folder:${kind}`;
const storageFolderValue = (kind: MediaKind): string => `${STORAGE_FOLDER}${kind}`;

/** Thrown when the saved folder needs the user's permission again (Chromium asks once per session). */
class FolderPermissionError extends Error {
  constructor() { super('This folder needs permission again: use refresh or choose it again.'); }
}

/** The folder behind a value, or null when it no longer exists. */
async function openFolder(kind: MediaKind, folder: string, userAction: boolean): Promise<MediaFolder | null> {
  if (folder === storageFolderValue(kind)) return storageFolder(kind);
  const prefix = `${DIRECTORY_FOLDER}${kind}:`;
  if (!folder.startsWith(prefix)) return null;
  const id = folder.slice(prefix.length).split('/', 1)[0];
  const saved = await readRecord(directoryRecord(kind));
  if (!isSavedDirectory(saved) || saved.id !== id) return null;
  const descriptor: FileSystemPermissionDescriptor = { mode: 'readwrite' };
  if (await saved.handle.queryPermission?.(descriptor) !== 'granted' &&
      (!userAction || await saved.handle.requestPermission?.(descriptor) !== 'granted')) throw new FolderPermissionError();
  return directoryFolder(saved.handle);
}

function locate(filePath: unknown): { folder: string; fileName: string } | null {
  if (typeof filePath !== 'string') return null;
  const slash = filePath.lastIndexOf('/');
  return slash > 0 ? { folder: filePath.slice(0, slash), fileName: filePath.slice(slash + 1) } : null;
}

const isSoundName = (name: string): boolean => soundDownloadFileNameSchema.safeParse(name).success;
const isStickerName = (name: string): boolean => name.length > 0 && name.length <= 255 && !name.startsWith('.') &&
  !/[/\\\x00-\x1f\x7f]/.test(name) && stickerMimeType(fileNameExtension(name)) !== undefined;

/** Saves under the name, or "name (1).ext" onwards when it is taken. */
async function createUnique(folder: MediaFolder, fileName: string, bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const extension = fileNameExtension(fileName);
  const base = fileName.slice(0, fileName.length - extension.length);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? fileName : `${base} (${attempt})${extension}`;
    if (await folder.create(candidate, bytes)) return candidate;
  }
  return null;
}

async function chooseFolder(kind: MediaKind): Promise<string | null> {
  const picker = window.showDirectoryPicker;
  if (picker) {
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker.call(window, { id: `monky-${kind}`, mode: 'readwrite' });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
    const id = crypto.randomUUID();
    await writeRecord(directoryRecord(kind), { id, handle } satisfies SavedDirectory);
    return `${DIRECTORY_FOLDER}${kind}:${id}/${handle.name}`;
  }
  const accepted = kind === 'soundboard' ? Object.keys(SOUND_AUDIO_MIME_TYPES) : Object.keys(STICKER_MIME_TYPES);
  const files = await pickFiles({ accept: accepted.join(','), multiple: true });
  if (!files.length) return null;
  const folder = storageFolder(kind);
  const acceptsName = kind === 'soundboard' ? isSoundName : isStickerName;
  for (const file of files) {
    if (!acceptsName(file.name) || file.size > MAX_STORED_FILE_BYTES) {
      console.warn(`[media] Skipped "${file.name}": unsupported name, type or size.`);
      continue;
    }
    await createUnique(folder, file.name, new Uint8Array(await file.arrayBuffer()));
  }
  return storageFolderValue(kind);
}

async function soundRevision(file: FolderFile, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stamp = new TextEncoder().encode(`${file.modified}:${file.size}:`);
  const input = new Uint8Array(stamp.byteLength + bytes.byteLength);
  input.set(stamp);
  input.set(bytes, stamp.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function failure(error: unknown): { status: 'failed'; reason: SoundboardFileFailure } {
  if (error instanceof FileError) return { status: 'failed', reason: error.reason };
  if (error instanceof FolderPermissionError) return { status: 'failed', reason: 'no_folder' };
  if (isNotFound(error)) return { status: 'failed', reason: 'missing' };
  if (error instanceof DOMException && (error.name === 'NoModificationAllowedError' || error.name === 'NotAllowedError')) {
    return { status: 'failed', reason: 'locked' };
  }
  return { status: 'failed', reason: 'io_failed' };
}

function encodeEdit(input: SoundboardEditInput | SoundboardOverwriteInput): { bytes: Uint8Array<ArrayBuffer>; duration: number } {
  try {
    const edited = encodeSoundboardEdit(input.channels, input.sampleRate, {
      start: input.start, end: input.end, fadeIn: input.fadeIn, fadeOut: input.fadeOut,
    });
    return { bytes: new Uint8Array(edited.bytes), duration: edited.duration };
  } catch (error: unknown) {
    throw new FileError(error instanceof RangeError && error.message === 'unsupported' ? 'unsupported'
      : error instanceof RangeError && error.message === 'too_large' ? 'too_large' : 'invalid_request');
  }
}

/** The soundboard and sticker members of the web platform bridge. */
export function createWebMediaLibrary() {
  let busy = false;
  const run = async <T>(operation: () => Promise<T>): Promise<SoundboardFileResult<T>> => {
    if (busy) return { status: 'failed', reason: 'locked' };
    busy = true;
    try { return { status: 'ok', value: await operation() }; }
    catch (error: unknown) { return failure(error); }
    finally { busy = false; }
  };
  const soundSource = async (input: SoundboardFileInput) => {
    if (!isSoundName(input.fileName)) throw new FileError('invalid_request');
    const folder = await openFolder('soundboard', input.folder, navigator.userActivation.isActive);
    if (!folder) throw new FileError('no_folder');
    const file = await folder.read(input.fileName);
    if (!file) throw new FileError('missing');
    return { folder, file };
  };
  const snapshot = async (input: SoundboardFileInput) => {
    const { folder, file } = await soundSource(input);
    const bytes = await file.bytes();
    return { folder, bytes, revision: await soundRevision(file, bytes) };
  };
  const saved = (input: SoundboardFileInput, fileName: string, duration?: number): SoundboardSavedFile =>
    ({ fileName, filePath: `${input.folder}/${fileName}`, ...(duration === undefined ? {} : { duration }) });

  return {
    describeMediaFolder(folder: string): string {
      if (folder.startsWith(STORAGE_FOLDER)) return t('media.browserStorage');
      if (!folder.startsWith(DIRECTORY_FOLDER)) return folder;
      const slash = folder.indexOf('/');
      return slash < 0 ? folder : folder.slice(slash + 1);
    },
    selectSoundboardFolder: () => chooseFolder('soundboard'),
    selectStickersFolder: () => chooseFolder('stickers'),
    // Without a folder picker the browser's storage is the only place sounds can be.
    getDefaultSoundboardFolder: (): Promise<string | null> =>
      Promise.resolve(supportsDirectoryPicker() ? null : storageFolderValue('soundboard')),
    getDefaultStickersFolder: (): Promise<string | null> =>
      Promise.resolve(supportsDirectoryPicker() ? null : storageFolderValue('stickers')),

    async listSoundboardSounds(folderPath: string): Promise<SoundboardSoundEntry[]> {
      const folder = await openFolder('soundboard', folderPath, navigator.userActivation.isActive);
      if (!folder) return [];
      const entries = await folder.list((name) => isSoundboardAudioExtension(fileNameExtension(name)));
      return entries.map(({ name, size }) => {
        const ext = fileNameExtension(name);
        return { name: name.slice(0, name.length - ext.length), fileName: name, filePath: `${folderPath}/${name}`, sizeBytes: size, ext };
      }).sort((a, b) => a.name.localeCompare(b.name));
    },
    async readSoundboardSound(filePath: string): Promise<SoundboardSoundData | null> {
      const located = locate(filePath);
      const ext = located ? fileNameExtension(located.fileName) : '';
      if (!located || !isSoundboardAudioExtension(ext)) return null;
      try {
        const folder = await openFolder('soundboard', located.folder, navigator.userActivation.isActive);
        const file = folder ? await folder.read(located.fileName) : null;
        if (!file || file.size > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) return null;
        const base64 = bytesToBase64(await file.bytes());
        const mimeType = SOUND_AUDIO_MIME_TYPES[ext][0];
        return {
          fileName: located.fileName, soundName: located.fileName.slice(0, located.fileName.length - ext.length),
          mimeType, base64, dataUrl: `data:${mimeType};base64,${base64}`, sizeBytes: file.size,
        };
      } catch (error: unknown) {
        console.warn('Error reading sound file:', error);
        return null;
      }
    },
    readSoundboardEdit: (input: SoundboardFileInput): Promise<SoundboardFileResult<Uint8Array>> =>
      run(async () => (await snapshot(input)).bytes),
    openSoundboardEditor: (input: SoundboardFileInput): Promise<SoundboardFileResult<SoundboardEditorSource>> =>
      run(async () => {
        const { bytes, revision } = await snapshot(input);
        // Re-encoding mp3/ogg/aac needs FFmpeg, which only the desktop has.
        return { bytes, revision, overwriteAvailable: fileNameExtension(input.fileName) === '.wav' };
      }),
    overwriteSoundboardAudio: (input: SoundboardOverwriteInput): Promise<SoundboardFileResult<SoundboardSavedFile>> =>
      run(async () => {
        if ((await snapshot(input)).revision !== input.revision) throw new FileError('source_changed');
        if (fileNameExtension(input.fileName) !== '.wav') throw new FileError('encoder_unavailable');
        const edited = encodeEdit(input);
        const current = await snapshot(input);
        if (current.revision !== input.revision) throw new FileError('source_changed');
        await current.folder.replace(input.fileName, edited.bytes);
        return saved(input, input.fileName, edited.duration);
      }),
    renameSoundboardFile: (input: SoundboardRenameInput): Promise<SoundboardFileResult<SoundboardSavedFile>> =>
      run(async () => {
        const { folder, file } = await soundSource(input);
        if (!isSoundName(input.newFileName) || fileNameExtension(input.newFileName) !== fileNameExtension(input.fileName)) {
          throw new FileError('invalid_request');
        }
        if (!await folder.create(input.newFileName, await file.bytes())) throw new FileError('exists');
        try {
          await folder.remove(input.fileName);
        } catch (error: unknown) {
          await folder.remove(input.newFileName);
          throw error;
        }
        return saved(input, input.newFileName);
      }),
    deleteSoundboardFile: (input: SoundboardFileInput): Promise<SoundboardFileResult<null>> =>
      run(async () => {
        const { folder } = await soundSource(input);
        await folder.remove(input.fileName);
        return null;
      }),
    saveSoundboardEdit: (input: SoundboardEditInput): Promise<SoundboardFileResult<SoundboardSavedFile>> =>
      run(async () => {
        const { folder } = await soundSource(input);
        if (!isSoundName(input.newFileName) || fileNameExtension(input.newFileName) !== '.wav') throw new FileError('invalid_request');
        const edited = encodeEdit(input);
        if (!await folder.create(input.newFileName, edited.bytes)) throw new FileError('exists');
        return saved(input, input.newFileName, edited.duration);
      }),

    async listStickers(folderPath: string): Promise<StickerEntry[]> {
      const folder = await openFolder('stickers', folderPath, navigator.userActivation.isActive);
      if (!folder) return [];
      const entries = (await folder.list(isStickerName)).slice(0, MAX_STICKERS_LISTED);
      return entries.flatMap(({ name, size }) => {
        const ext = fileNameExtension(name);
        const mimeType = stickerMimeType(ext);
        return mimeType ? [{
          name: name.slice(0, name.length - ext.length), fileName: name, filePath: `${folderPath}/${name}`,
          sizeBytes: size, ext, mimeType, tooLarge: size > MAX_STICKER_BYTES,
        }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name));
    },
    async readSticker(filePath: string): Promise<StickerData | null> {
      const located = locate(filePath);
      const mimeType = located ? stickerMimeType(fileNameExtension(located.fileName)) : undefined;
      if (!located || !mimeType) return null;
      try {
        const folder = await openFolder('stickers', located.folder, navigator.userActivation.isActive);
        const file = folder ? await folder.read(located.fileName) : null;
        if (!file || file.size > MAX_STICKER_BYTES) return null;
        return {
          fileName: located.fileName, mimeType, sizeBytes: file.size,
          dataUrl: `data:${mimeType};base64,${bytesToBase64(await file.bytes())}`,
        };
      } catch (error: unknown) {
        console.warn('Error reading sticker file:', error);
        return null;
      }
    },
    async saveSticker(folderPath: string, fileName: string, bytes: Uint8Array): Promise<StickerSaveResult> {
      let folder: MediaFolder | null;
      try {
        folder = await openFolder('stickers', folderPath, navigator.userActivation.isActive);
      } catch {
        folder = null;
      }
      if (!folder) return { ok: false, reason: 'no-folder' };
      // Only the base name is trusted, as on the desktop.
      const safeName = fileName.split(/[/\\]/).pop() ?? '';
      if (!isStickerName(safeName)) return { ok: false, reason: 'bad-extension' };
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_STICKER_BYTES) return { ok: false, reason: 'too-large' };
      try {
        const savedName = await createUnique(folder, safeName, new Uint8Array(bytes));
        return savedName ? { ok: true, fileName: savedName } : { ok: false, reason: 'write-failed' };
      } catch (error: unknown) {
        console.warn('Error saving sticker file:', error);
        return { ok: false, reason: 'write-failed' };
      }
    },
  };
}
