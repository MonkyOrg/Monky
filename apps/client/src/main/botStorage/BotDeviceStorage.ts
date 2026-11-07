import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BOT_STORAGE_LIMITS, BotDeviceStorageEngine, BotDeviceStorageError, botDeviceStorageScopeIdentity,
  type BotDeviceStorageBackend, type BotDeviceStorageFile, type BotDeviceStorageScope,
} from '@monky/shared';
import { localToolDirectory, localToolStat, missingLocalToolFile, readLocalToolFile, removeLocalToolTree } from '../localExecution/localToolsStorage';

export { BotDeviceStorageError, isBotDeviceStorageScopeId } from '@monky/shared';

const INDEX = 'scope.json';
const OBJECTS = 'objects';
const INDEX_BYTES = 2 * 1024 * 1024;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Same tuple as the bot preferences of a person: server address, server, account and bot. */
export function botDeviceStorageScopeId(scope: BotDeviceStorageScope): string {
  return sha256Hex(botDeviceStorageScopeIdentity(scope));
}

/**
 * The desktop keeps each scope as a folder in its profile: `scope.json` and an
 * `objects` folder of files with random names. Files are written to a staging
 * copy, synced and renamed, so a reader sees the old file or the new one.
 */
class BotDeviceStorageFiles implements BotDeviceStorageBackend {
  private ready: Promise<void> | null = null;

  constructor(private root: string) {}

  scopeId(identity: string): string {
    return sha256Hex(identity);
  }

  randomId(): string {
    return randomUUID();
  }

  initialize(): Promise<void> {
    if (!this.ready) {
      const loading = (async () => {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        this.root = await fs.realpath(this.root);
        await localToolDirectory(this.root);
      })();
      this.ready = loading;
      loading.catch(() => { if (this.ready === loading) this.ready = null; });
    }
    return this.ready;
  }

  scopes(): Promise<string[]> {
    return fs.readdir(this.root);
  }

  async hasScope(scopeId: string): Promise<boolean> {
    return await localToolStat(path.join(this.root, scopeId)) !== null;
  }

  async readIndex(scopeId: string): Promise<unknown> {
    const directory = path.join(this.root, scopeId);
    if (!await localToolStat(directory)) return null;
    await localToolDirectory(directory);
    if (!await localToolStat(path.join(directory, INDEX))) {
      // The index is written last: without one, the first save stopped midway and nothing here was ever stored.
      await removeLocalToolTree(this.root, directory);
      return null;
    }
    const file = await readLocalToolFile(this.root, path.join(directory, INDEX), INDEX_BYTES, undefined, true);
    return JSON.parse(file.contents.toString('utf8'));
  }

  async writeIndex(scopeId: string, index: BotDeviceStorageFile): Promise<void> {
    const directory = path.join(this.root, scopeId);
    await localToolDirectory(path.join(directory, OBJECTS), true);
    await this.replaceFile(directory, `.${INDEX}-${randomUUID()}.tmp`, INDEX, JSON.stringify(index));
  }

  async removeUnreferenced(scopeId: string, referenced: ReadonlySet<string>): Promise<void> {
    const directory = path.join(this.root, scopeId);
    for (const name of await this.names(directory)) {
      if (name.startsWith(`.${INDEX}-`) && name.endsWith('.tmp')) await this.removeFile(path.join(directory, name));
    }
    for (const name of await this.names(path.join(directory, OBJECTS))) {
      if (!referenced.has(name)) await this.removeObject(scopeId, name);
    }
  }

  async writeObject(scopeId: string, file: string, bytes: Uint8Array): Promise<void> {
    const directory = path.join(this.root, scopeId, OBJECTS);
    await localToolDirectory(directory, true);
    await this.replaceFile(directory, `${file}.tmp`, file, bytes);
  }

  async readObject(scopeId: string, file: string): Promise<Uint8Array> {
    const read = await readLocalToolFile(this.root, path.join(this.root, scopeId, OBJECTS, file),
      BOT_STORAGE_LIMITS.objectBytes, undefined, true);
    return read.contents;
  }

  removeObject(scopeId: string, file: string): Promise<void> {
    return this.removeFile(path.join(this.root, scopeId, OBJECTS, file));
  }

  removeScope(scopeId: string): Promise<void> {
    return removeLocalToolTree(this.root, path.join(this.root, scopeId));
  }

  /** Readers see the old file or the new one, never a partial write; a failed attempt leaves nothing behind. */
  private async replaceFile(directory: string, staging: string, target: string, contents: string | Uint8Array): Promise<void> {
    const staged = path.join(directory, staging);
    const handle = await fs.open(staged, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(staged, path.join(directory, target));
    } catch (error) {
      await this.removeFile(staged);
      throw error;
    }
  }

  private async removeFile(filename: string): Promise<void> {
    try {
      await fs.unlink(filename);
    } catch (error) {
      if (!missingLocalToolFile(error)) console.warn('[Bot storage] Could not remove a file that is no longer used.', error);
    }
  }

  private async names(directory: string): Promise<string[]> {
    try {
      return await fs.readdir(directory);
    } catch (error) {
      if (missingLocalToolFile(error)) return [];
      throw error;
    }
  }
}

/** What bots keep on this computer through their miniapps, one folder per server, account and bot. */
export class BotDeviceStorage extends BotDeviceStorageEngine {
  constructor(root: string, changed: (scopeId: string) => void = () => undefined) {
    if (!path.isAbsolute(root)) throw new BotDeviceStorageError('invalid');
    super(new BotDeviceStorageFiles(root), changed);
  }
}