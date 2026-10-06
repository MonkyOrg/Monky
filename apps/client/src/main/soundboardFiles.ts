import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  encodeSoundboardEdit, type SoundboardFileFailure, type SoundboardFileResult,
  type SoundboardSavedFile, type SoundboardEditorSource,
} from '@monky/shared';
import { isSoundFileName, isSoundAudio } from './soundAudioValidation';
import type { SoundboardDownloads } from './soundboardDownload';
import { supportsSoundboardEncoding, type SoundboardEncoder } from './soundboardEncoder';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
class FileError extends Error {
  constructor(readonly reason: SoundboardFileFailure) { super(reason); }
}
function failure(error: unknown): { status: 'failed'; reason: SoundboardFileFailure } {
  if (error instanceof FileError) return { status: 'failed', reason: error.reason };
  const code = record(error) ? error.code : undefined;
  return { status: 'failed', reason: code === 'ENOENT' ? 'missing' : code === 'EEXIST' ? 'exists'
    : ['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY'].includes(String(code)) ? 'locked' : 'io_failed' };
}

/** Only Main's natively confirmed folder is a write capability, never an arbitrary renderer path. */
export class SoundboardFiles {
  private busy = false;
  constructor(private readonly folders: Pick<SoundboardDownloads, 'availability'>, private readonly encoder?: SoundboardEncoder) {}

  private async source(input: unknown): Promise<{ folder: string; source: string; fileName: string; stat: Stats }> {
    if (!record(input) || typeof input.folder !== 'string' || !path.isAbsolute(input.folder) ||
        input.folder.length > 4096 || !isSoundFileName(input.fileName)) throw new FileError('invalid_request');
    if (await this.folders.availability(input.folder) !== 'ready') throw new FileError('no_folder');
    const folder = path.resolve(input.folder);
    if (!samePath(await fs.realpath(folder), folder) || (await fs.lstat(folder)).isSymbolicLink()) throw new FileError('no_folder');
    const source = path.join(folder, input.fileName);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        !samePath(await fs.realpath(source), source)) throw new FileError('invalid_request');
    return { folder, source, fileName: input.fileName, stat };
  }

  private async run<T>(operation: () => Promise<T>): Promise<SoundboardFileResult<T>> {
    if (this.busy) return { status: 'failed', reason: 'locked' };
    this.busy = true;
    try { return { status: 'ok', value: await operation() }; }
    catch (error: unknown) { return failure(error); }
    finally { this.busy = false; }
  }

  private async snapshot(input: unknown): Promise<{ bytes: Uint8Array; revision: string }> {
      const { source, stat } = await this.source(input);
      const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new FileError('invalid_request');
        const data = Buffer.alloc(stat.size);
        for (let offset = 0; offset < data.length;) {
          const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
          if (!bytesRead) throw new FileError('io_failed');
          offset += bytesRead;
        }
        const after = await handle.stat();
        const current = (await this.source(input)).stat;
        const identity = (value: typeof stat) => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.nlink].join(':');
        if (identity(opened) !== identity(after) || identity(after) !== identity(current)) throw new FileError('source_changed');
        return { bytes: data, revision: createHash('sha256').update(identity(after)).update(data).digest('hex') };
      } finally { await handle.close(); }
  }

  public read(input: unknown): Promise<SoundboardFileResult<Uint8Array>> {
    return this.run(async () => (await this.snapshot(input)).bytes);
  }

  public openEditor(input: unknown): Promise<SoundboardFileResult<SoundboardEditorSource>> {
    return this.run(async () => {
      const data = await this.snapshot(input);
      const fileName = record(input) && typeof input.fileName === 'string' ? input.fileName : '';
      const extension = path.extname(fileName).toLowerCase();
      const overwriteAvailable = extension === '.wav' ||
        (supportsSoundboardEncoding(extension) && !!await this.encoder?.available());
      return { ...data, overwriteAvailable };
    });
  }

  private encode(input: unknown): { bytes: Uint8Array; duration: number; channels: number } {
    if (!record(input) || !Array.isArray(input.channels) ||
        !input.channels.every((channel): channel is Float32Array => channel instanceof Float32Array) ||
        typeof input.sampleRate !== 'number' || typeof input.start !== 'number' || typeof input.end !== 'number' ||
        typeof input.fadeIn !== 'number' || typeof input.fadeOut !== 'number') throw new FileError('invalid_request');
    try {
      return { ...encodeSoundboardEdit(input.channels, input.sampleRate, {
        start: input.start, end: input.end, fadeIn: input.fadeIn, fadeOut: input.fadeOut,
      }), channels: input.channels.length };
    } catch (error: unknown) {
      throw new FileError(error instanceof RangeError && error.message === 'unsupported' ? 'unsupported'
        : error instanceof RangeError && error.message === 'too_large' ? 'too_large' : 'invalid_request');
    }
  }

  public overwrite(input: unknown): Promise<SoundboardFileResult<SoundboardSavedFile>> {
    return this.run(async () => {
      if (!record(input) || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) throw new FileError('invalid_request');
      const checked = await this.source(input);
      if ((await this.snapshot(input)).revision !== input.revision) throw new FileError('source_changed');
      let edited = this.encode(input);
      const extension = path.extname(checked.fileName).toLowerCase();
      if (extension !== '.wav' && (!this.encoder || !supportsSoundboardEncoding(extension) || !await this.encoder.available())) {
        throw new FileError('encoder_unavailable');
      }
      const staging = path.join(checked.folder, `.monky-edit-${randomUUID()}.part`);
      const output = await fs.open(staging, 'wx', checked.stat.mode & 0o777);
      let closed = false, published = false;
      try {
        if (extension !== '.wav' && this.encoder) {
          try { edited = { ...await this.encoder.encode(edited.bytes, extension, edited.duration, edited.channels), channels: edited.channels }; }
          catch (error: unknown) {
            console.error('[soundboard] Could not encode the replacement audio.', error);
            throw new FileError(error instanceof Error && error.message === 'encoder_unavailable' ? 'encoder_unavailable' : 'encode_failed');
          }
        }
        if (!Number.isFinite(edited.duration) || edited.duration <= 0 ||
            !isSoundAudio(Buffer.from(edited.bytes), checked.fileName)) throw new FileError('encode_failed');
        await output.writeFile(edited.bytes); await output.sync();
        const stageStat = await output.stat();
        await output.close(); closed = true;
        if ((await this.snapshot(input)).revision !== input.revision) throw new FileError('source_changed');
        const stageNow = await fs.lstat(staging);
        if (!stageNow.isFile() || stageNow.isSymbolicLink() || stageNow.nlink !== 1 ||
            stageNow.ino !== stageStat.ino || stageNow.dev !== stageStat.dev || stageNow.size !== edited.bytes.length) {
          throw new FileError('invalid_request');
        }
        // Same-directory rename replaces only after completed output and a fresh source revision check.
        await fs.rename(staging, checked.source);
        published = true;
        return { fileName: checked.fileName, filePath: checked.source, duration: edited.duration };
      } finally {
        if (!closed) await output.close();
        if (!published) {
          try { await fs.unlink(staging); }
          catch { throw new FileError('cleanup_failed'); }
        }
      }
    });
  }

  public rename(input: unknown): Promise<SoundboardFileResult<SoundboardSavedFile>> {
    return this.run(async () => {
      const checked = await this.source(input);
      if (!record(input) || !isSoundFileName(input.newFileName) ||
          path.extname(input.newFileName).toLowerCase() !== path.extname(checked.fileName).toLowerCase()) throw new FileError('invalid_request');
      const target = path.join(checked.folder, input.newFileName);
      // link is atomic and fails if the destination exists, unlike POSIX rename.
      try { await fs.link(checked.source, target); }
      catch (error: unknown) {
        if (!record(error) || !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(String(error.code))) throw error;
        await fs.copyFile(checked.source, target, constants.COPYFILE_EXCL);
      }
      try { await fs.unlink(checked.source); }
      catch (error: unknown) {
        await fs.unlink(target);
        throw error;
      }
      return { fileName: input.newFileName, filePath: target };
    });
  }

  public delete(input: unknown): Promise<SoundboardFileResult<null>> {
    return this.run(async () => {
      const { source } = await this.source(input);
      await fs.unlink(source);
      return null;
    });
  }

  public edit(input: unknown): Promise<SoundboardFileResult<SoundboardSavedFile>> {
    return this.run(async () => {
      const { folder } = await this.source(input);
      if (!record(input) || !isSoundFileName(input.newFileName) || path.extname(input.newFileName).toLowerCase() !== '.wav' ||
          !Array.isArray(input.channels) || !input.channels.every((channel): channel is Float32Array => channel instanceof Float32Array) ||
          typeof input.sampleRate !== 'number' || typeof input.start !== 'number' || typeof input.end !== 'number' ||
          typeof input.fadeIn !== 'number' || typeof input.fadeOut !== 'number') throw new FileError('invalid_request');
      let edited;
      try {
        edited = encodeSoundboardEdit(input.channels, input.sampleRate, {
          start: input.start, end: input.end, fadeIn: input.fadeIn, fadeOut: input.fadeOut,
        });
      } catch (error: unknown) {
        throw new FileError(error instanceof RangeError && error.message === 'unsupported' ? 'unsupported'
          : error instanceof RangeError && error.message === 'too_large' ? 'too_large' : 'invalid_request');
      }
      const target = path.join(folder, input.newFileName);
      const handle = await fs.open(target, 'wx');
      try {
        await handle.writeFile(edited.bytes);
        await handle.sync();
      } catch (error: unknown) {
        await handle.close();
        await fs.unlink(target);
        throw error;
      }
      await handle.close();
      return { fileName: input.newFileName, filePath: target, duration: edited.duration };
    });
  }
}
