import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalExecutionError } from './errors';

const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 16;
const WINDOWS_RETRY_DELAYS = [50, 100, 200, 400, 800];

export async function retryLocalToolMutation(action: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { await action(); return; }
    catch (error) {
      const wait = WINDOWS_RETRY_DELAYS[attempt];
      if (process.platform !== 'win32' || wait === undefined || !(error instanceof Error) ||
        !('code' in error) || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(String(error.code))) throw error;
      await delay(wait, undefined, { signal });
    }
  }
}

export function missingLocalToolFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function localToolStorageError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    ['ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EIO', 'EROFS', 'EMFILE', 'ENFILE'].includes(String(error.code));
}

export function localToolUnsafeFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    ['EEXIST', 'ELOOP', 'EISDIR', 'ENOTDIR'].includes(String(error.code));
}

export function localToolPath(root: string, ...parts: string[]): string {
  const filename = path.resolve(root, ...parts);
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new LocalExecutionError('invalid_request');
  }
  return filename;
}

function samePath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? path.normalize(first).toLowerCase() === path.normalize(second).toLowerCase()
    : path.normalize(first) === path.normalize(second);
}

export async function localToolStat(filename: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (missingLocalToolFile(error)) return null;
    throw new LocalExecutionError('storage_failed', { cause: error });
  }
}

export async function localToolDirectory(directory: string, create = false): Promise<void> {
  const volume = path.parse(directory).root;
  if (!volume || !path.isAbsolute(directory)) throw new LocalExecutionError('invalid_request');
  let current = volume;
  for (const part of path.relative(volume, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat = await localToolStat(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
          throw new LocalExecutionError('storage_failed', { cause: error });
        }
      }
      stat = await localToolStat(current);
    }
    if (!stat) throw new LocalExecutionError('storage_failed');
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalExecutionError('integrity_failed');
  }
  if (!samePath(await fs.realpath(directory), directory)) throw new LocalExecutionError('integrity_failed');
}

function regularFile(stat: Stats, limit: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > limit) {
    throw new LocalExecutionError('integrity_failed');
  }
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size &&
    first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs && second.nlink === 1;
}

export function localToolFingerprint(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

export async function readLocalToolFile(
  root: string, filename: string, limit: number, signal?: AbortSignal, collect = false,
): Promise<{ sha256: string; size: number; contents: Buffer; fingerprint: string }> {
  localToolPath(root, filename);
  await localToolDirectory(path.dirname(filename));
  signal?.throwIfAborted();
  const before = await localToolStat(filename);
  if (!before) throw new LocalExecutionError('integrity_failed');
  regularFile(before, limit);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    regularFile(opened, limit);
    if (!sameFile(before, opened) || !samePath(await fs.realpath(filename), filename)) {
      throw new LocalExecutionError('integrity_failed');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit || size > opened.size) throw new LocalExecutionError('integrity_failed');
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (collect) chunks.push(Buffer.from(chunk));
    }
    signal?.throwIfAborted();
    const after = await localToolStat(filename);
    if (!after || !sameFile(opened, await handle.stat()) || !sameFile(opened, after) ||
        size !== opened.size || after.isSymbolicLink()) {
      throw new LocalExecutionError('integrity_failed');
    }
    return { sha256: digest.digest('hex'), size, contents: Buffer.concat(chunks), fingerprint: localToolFingerprint(opened) };
  } finally {
    await handle.close();
  }
}

export async function localToolTreeBytes(root: string, filename: string): Promise<number> {
  localToolPath(root, filename);
  await localToolDirectory(path.dirname(filename));
  let entries = 0;
  const visit = async (target: string, depth: number): Promise<number> => {
    if (++entries > MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) throw new LocalExecutionError('storage_failed');
    const stat = await localToolStat(target);
    if (!stat) return 0;
    // Inventory counts the link itself, never its potentially external target.
    if (stat.isSymbolicLink() || stat.isFile()) return stat.size;
    if (!stat.isDirectory()) throw new LocalExecutionError('integrity_failed');
    let names: string[];
    try {
      await localToolDirectory(target);
      names = await fs.readdir(target);
    } catch (error) {
      if (missingLocalToolFile(error) || !await localToolStat(target)) return 0;
      throw error;
    }
    let bytes = 0;
    for (const name of names) bytes += await visit(localToolPath(root, target, name), depth + 1);
    if (!Number.isSafeInteger(bytes)) throw new LocalExecutionError('storage_failed');
    return bytes;
  };
  return visit(filename, 0);
}

export async function removeLocalToolTree(root: string, filename: string): Promise<void> {
  localToolPath(root, filename);
  await localToolDirectory(path.dirname(filename));
  let entries = 0;
  const remove = async (target: string, depth: number): Promise<void> => {
    if (++entries > MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) throw new LocalExecutionError('storage_failed');
    const stat = await localToolStat(target);
    if (!stat) return;
    await localToolDirectory(path.dirname(target));
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await fs.unlink(target);
      return;
    }
    await localToolDirectory(target);
    for (const name of await fs.readdir(target)) await remove(localToolPath(root, target, name), depth + 1);
    await fs.rmdir(target);
  };
  try {
    await retryLocalToolMutation(async () => { entries = 0; await remove(filename, 0); });
  } catch (error) {
    throw new LocalExecutionError('storage_failed', { cause: error });
  }
}

export async function requireLocalToolSpace(root: string, bytes: number): Promise<void> {
  await localToolDirectory(root);
  const stat = await fs.statfs(root, { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(bytes)) throw new LocalExecutionError('storage_failed');
}
