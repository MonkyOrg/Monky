import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LIMITS,
  type SoundDownloadResult,
  type SoundboardDownloadAvailability,
  type SoundboardDownloadPermit, type SoundboardDownloadProgress,
} from '@monky/shared';
import { isSoundFileName } from './soundAudioValidation';
import { fetchSoundAudio, nativeSoundTransport, SoundDownloadError, soundDownloadUrl, type SoundDownloadTransport } from './audioFetch';
export { nativeSoundTransport, SoundDownloadError, soundDownloadUrl, isPublicSoundAddress, type SoundDownloadTransport } from './audioFetch';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function errno(error: unknown, code: string): boolean { return record(error) && error.code === code; }
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

interface Grant {
  owner: number;
  connectionId: string;
  invocationId: string;
  folder: string;
  expiresAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  used: boolean;
  downloadId?: string;
}

type CheckedFolder =
  | { availability: 'ready'; folder: string; generation: number }
  | { availability: Exclude<SoundboardDownloadAvailability, 'ready'> };

export class SoundboardDownloads {
  private confirmedFolder: string | null = null;
  private folderGeneration = 0;
  private loaded: Promise<void> | null = null;
  private loadFailed = false;
  private grants = new Map<string, Grant>();
  private targets = new Set<string>();
  private ownerGeneration = new Map<number, number>();

  constructor(private configFile: string, private transport: SoundDownloadTransport = nativeSoundTransport) {}

  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      try {
        const text = await fs.readFile(this.configFile, 'utf8');
        const saved: unknown = text.length <= 16384 ? JSON.parse(text) : null;
        if (record(saved) && typeof saved.folder === 'string' && path.isAbsolute(saved.folder)) this.confirmedFolder = saved.folder;
        else this.loadFailed = true;
      } catch (error) {
        if (!errno(error, 'ENOENT')) this.loadFailed = true;
      }
    })();
  }

  public async confirmFolder(folder: string): Promise<string> {
    await this.load();
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(canonical)).isDirectory()) throw new SoundDownloadError('no_folder');
    const staging = `${this.configFile}.${randomUUID()}.writing`;
    let created = false;
    try {
      const handle = await fs.open(staging, 'wx');
      created = true;
      try { await handle.writeFile(JSON.stringify({ folder: canonical })); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(staging, this.configFile);
      created = false;
      this.confirmedFolder = canonical;
      this.folderGeneration++;
      this.loadFailed = false;
      return canonical;
    } finally {
      if (created) await fs.unlink(staging);
    }
  }

  public async availability(configuredFolder: unknown): Promise<SoundboardDownloadAvailability> {
    return (await this.checkFolder(configuredFolder)).availability;
  }

  private async checkFolder(configuredFolder: unknown): Promise<CheckedFolder> {
    await this.load();
    if (typeof configuredFolder !== 'string' || !configuredFolder || !path.isAbsolute(configuredFolder)) return { availability: 'no_folder' };
    if (this.loadFailed) return { availability: 'unavailable' };
    const folder = this.confirmedFolder;
    const generation = this.folderGeneration;
    if (!folder) return { availability: 'confirmation_required' };
    try {
      if (!samePath(await fs.realpath(configuredFolder), folder)) return { availability: 'confirmation_required' };
      if (!samePath(await fs.realpath(folder), folder) || !(await fs.lstat(folder)).isDirectory()) return { availability: 'no_folder' };
      await fs.access(folder, constants.W_OK);
      return generation === this.folderGeneration
        ? { availability: 'ready', folder, generation } : { availability: 'confirmation_required' };
    } catch (error) {
      return { availability: errno(error, 'ENOENT') || errno(error, 'ENOTDIR') ? 'no_folder' : 'unavailable' };
    }
  }

  public async authorize(owner: number, input: unknown): Promise<SoundboardDownloadPermit> {
    if (!record(input) || !id(input.connectionId) || !id(input.invocationId) ||
        typeof input.configuredFolder !== 'string' || input.configuredFolder.length > 4096 ||
        typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now() ||
        this.grants.size >= 64) return { status: 'failed', reason: 'invalid_request' };
    const generation = this.ownerGeneration.get(owner) ?? 0;
    const checked = await this.checkFolder(input.configuredFolder);
    if (checked.availability !== 'ready' || checked.generation !== this.folderGeneration) {
      return { status: 'failed', reason: 'no_folder' };
    }
    if ((this.ownerGeneration.get(owner) ?? 0) !== generation || this.grants.size >= 64) {
      return { status: 'failed', reason: 'invalid_request' };
    }
    const token = randomUUID();
    const expiresAt = Math.min(input.expiresAt, Date.now() + LIMITS.BOT_INTERACTION_TIMEOUT_MS);
    const grant: Grant = {
      owner, connectionId: input.connectionId, invocationId: input.invocationId, folder: checked.folder,
      expiresAt, controller: new AbortController(), used: false,
      timer: setTimeout(() => this.revoke(token, new SoundDownloadError('timeout')), Math.max(1, expiresAt - Date.now())),
    };
    this.grants.set(token, grant);
    return { status: 'authorized', token };
  }

  private revoke(token: string, reason?: SoundDownloadError): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    clearTimeout(grant.timer);
    grant.controller.abort(reason);
    this.grants.delete(token);
  }

  public cancel(owner: number, key: unknown): boolean {
    if (!record(key) || !id(key.connectionId) || !id(key.invocationId) ||
        (key.downloadId !== undefined && !id(key.downloadId))) return false;
    let cancelled = false;
    for (const [token, grant] of this.grants) {
      if (grant.owner === owner && grant.connectionId === key.connectionId && grant.invocationId === key.invocationId &&
          (key.downloadId === undefined || grant.downloadId === key.downloadId)) {
        this.revoke(token);
        cancelled = true;
      }
    }
    return cancelled;
  }

  public cancelOwner(owner: number): void {
    this.ownerGeneration.set(owner, (this.ownerGeneration.get(owner) ?? 0) + 1);
    for (const [token, grant] of this.grants) if (grant.owner === owner) this.revoke(token);
  }

  public async download(owner: number, input: unknown, progress: (event: SoundboardDownloadProgress) => void): Promise<SoundDownloadResult> {
    if (!record(input) || !id(input.token) || !id(input.connectionId) || !id(input.invocationId) || !id(input.downloadId) ||
        typeof input.url !== 'string' || input.url.length > 2048 || typeof input.fileName !== 'string' ||
        typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100 ||
        typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt)) return { status: 'failed', reason: 'invalid_request' };
    const grant = this.grants.get(input.token);
    if (!grant || grant.owner !== owner || grant.used || grant.connectionId !== input.connectionId ||
        grant.invocationId !== input.invocationId) return { status: 'failed', reason: 'invalid_request' };
    grant.used = true;
    grant.downloadId = input.downloadId;
    if (input.expiresAt <= Date.now() || grant.expiresAt <= Date.now()) {
      this.revoke(input.token);
      return { status: 'failed', reason: 'timeout' };
    }
    clearTimeout(grant.timer);
    const token = input.token;
    const expiresAt = Math.min(input.expiresAt, grant.expiresAt, Date.now() + LIMITS.BOT_SOUND_DOWNLOAD_TIMEOUT_MS);
    grant.timer = setTimeout(() => this.revoke(token, new SoundDownloadError('timeout')),
      Math.max(1, expiresAt - Date.now()));
    const key = { connectionId: input.connectionId, invocationId: input.invocationId, downloadId: input.downloadId };
    let target: string | undefined;
    let targetKey: string | undefined;
    let staging: string | undefined;
    const signal = grant.controller.signal;
    try {
      if (!isSoundFileName(input.fileName)) throw new SoundDownloadError('invalid_file_name');
      soundDownloadUrl(input.url);
      if (!samePath(await fs.realpath(grant.folder), grant.folder) || !(await fs.lstat(grant.folder)).isDirectory()) {
        throw new SoundDownloadError('no_folder');
      }
      signal.throwIfAborted();
      target = path.join(grant.folder, input.fileName);
      try {
        await fs.lstat(target);
        return { status: 'exists' };
      } catch (error) { if (!errno(error, 'ENOENT')) throw new SoundDownloadError('write_failed'); }
      const candidateKey = process.platform === 'win32' ? target.toLowerCase() : target;
      if (this.targets.has(candidateKey)) throw new SoundDownloadError('write_failed');
      this.targets.add(candidateKey);
      targetKey = candidateKey;
      const { bytes } = await fetchSoundAudio(
        { url: input.url, fileName: input.fileName }, signal, this.transport,
        (receivedBytes, totalBytes) => progress({ ...key, receivedBytes, totalBytes })
      );
      signal.throwIfAborted();
      if (!samePath(await fs.realpath(grant.folder), grant.folder)) throw new SoundDownloadError('no_folder');
      const candidate = path.join(grant.folder, `.monky-sound-${randomUUID()}.part`);
      const handle = await fs.open(candidate, 'wx');
      staging = candidate;
      try { await handle.writeFile(bytes, { signal }); await handle.sync(); } finally { await handle.close(); }
      signal.throwIfAborted();
      // Prefer atomic publication. Other volumes use an exclusive final copy,
      // never rename/copy modes that can overwrite a file created concurrently.
      try {
        try { await fs.link(staging, target); } catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].some((code) => errno(error, code))) throw error;
          signal.throwIfAborted();
          await fs.copyFile(staging, target, constants.COPYFILE_EXCL);
        }
      } catch (error) {
        if (errno(error, 'EEXIST')) return { status: 'exists' };
        throw new SoundDownloadError('write_failed');
      }
      return { status: 'downloaded' };
    } catch (error) {
      if (signal.aborted) return signal.reason instanceof SoundDownloadError
        ? { status: 'failed', reason: signal.reason.reason } : { status: 'cancelled' };
      return { status: 'failed', reason: error instanceof SoundDownloadError ? error.reason :
        record(error) && typeof error.code === 'string' && /^(EACCES|EPERM|ENOSPC|EROFS|EIO|ENOENT|ENOTDIR)$/.test(error.code)
          ? 'write_failed' : 'network_error' };
    } finally {
      clearTimeout(grant.timer);
      this.grants.delete(input.token);
      if (targetKey) this.targets.delete(targetKey);
      if (staging) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await fs.unlink(staging); break; } catch (error) {
            if (errno(error, 'ENOENT')) break;
            if (attempt < 2 && ['EPERM', 'EACCES', 'EBUSY'].some((code) => errno(error, code))) {
              await new Promise<void>((resolve) => setTimeout(resolve, 25));
              continue;
            }
            // Cleanup must not turn an already-persisted file into a failed download.
            console.warn('[Soundboard] Could not remove the download staging file:', error);
            break;
          }
        }
      }
    }
  }
}
