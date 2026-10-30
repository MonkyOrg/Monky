import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_TASK_CACHE_MAX_BYTES, LOCAL_TOOLS_CACHE_MAX_BYTES } from './LocalTools';
import { LOCAL_TOOL_TREE_LIMITS, localToolDirectory, missingLocalToolFile } from './localToolsStorage';
import { LocalExecutionError } from './errors';
import { workerError } from './workerProtocol';

/**
 * The budget of the task caches that workers are writing to. LocalTools allocates each cache within its
 * quota and owns the directory: it deletes it once the worker confirms its descendants are gone, or keeps
 * it until the next start when that confirmation can no longer come. In between, a lease measures every
 * running cache under the same root, so that no task outgrows its own budget (counting what Main still
 * buffers for it) and the running tasks together stay within the cache folder's.
 */
export const TASK_CACHE_SCAN = {
  /** Pause between two measurements of a root that still has running caches. */
  pollMs: 500,
  /** One measurement of a root fails beyond this. */
  deadlineMs: 5000,
} as const;

export interface TaskCacheLease {
  readonly directory: string;
  /** Task output Main holds outside the directory (a preview, a frame batch being handed off). */
  bufferedBytes: number;
  /** The first budget or storage failure found for this cache. */
  readonly failure: LocalExecutionError | undefined;
  /** Hears that failure as soon as a scan finds it, so a running worker can stop at once. */
  onFailure?: (error: LocalExecutionError) => void;
  /** Measures the root now, or joins the measurement in progress. */
  check(): Promise<void>;
  /** Stops measuring this cache once the measurement in progress ends. */
  release(): Promise<void>;
}

const pools = new Map<string, CachePool>();

class Lease implements TaskCacheLease {
  bufferedBytes = 0;
  failure: LocalExecutionError | undefined;
  onFailure?: (error: LocalExecutionError) => void;

  constructor(readonly directory: string, private readonly pool: CachePool) {}

  check(): Promise<void> { return this.pool.check(); }
  release(): Promise<void> { return this.pool.release(this); }

  fail(error: LocalExecutionError): void {
    this.failure ??= error;
    this.onFailure?.(this.failure);
  }
}

class CachePool {
  readonly leases = new Map<string, Lease>();
  private scanning: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly root: string) {}

  check(): Promise<void> {
    if (this.scanning) return this.scanning;
    const scan = this.scan();
    this.scanning = scan;
    void scan.then(
      () => this.schedule(),
      error => {
        for (const lease of this.leases.values()) lease.fail(workerError(error, 'storage_failed'));
        this.schedule();
      },
    );
    return scan;
  }

  private schedule(): void {
    this.scanning = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (!this.leases.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // check() reports errors to the owners; its failure promise remains observed there.
      void this.check();
    }, TASK_CACHE_SCAN.pollMs);
  }

  private async scan(): Promise<void> {
    const deadline = performance.now() + TASK_CACHE_SCAN.deadlineMs;
    const leases = [...this.leases.values()];
    const requiredDirectories = new Set(leases.map(lease => lease.directory));
    let entries = 0;
    const sizes = new Map<string, number>();
    const visit = async (filename: string, depth: number, required = false): Promise<number> => {
      if (++entries > LOCAL_TOOL_TREE_LIMITS.entries || depth > LOCAL_TOOL_TREE_LIMITS.depth || performance.now() > deadline) {
        throw new LocalExecutionError('storage_failed');
      }
      let stat: Stats;
      try { stat = await fs.lstat(filename); }
      catch (error) {
        if (!required && missingLocalToolFile(error)) return 0;
        throw workerError(error, 'storage_failed');
      }
      if (stat.isSymbolicLink() || required && !stat.isDirectory()) throw new LocalExecutionError('storage_failed');
      if (stat.isFile()) return stat.size;
      if (!stat.isDirectory()) throw new LocalExecutionError('storage_failed');
      let bytes = 0;
      try {
        for await (const entry of await fs.opendir(filename)) {
          bytes += await visit(path.join(filename, entry.name), depth + 1);
          if (!Number.isSafeInteger(bytes) || bytes > LOCAL_TOOLS_CACHE_MAX_BYTES) throw new LocalExecutionError('storage_failed');
        }
      } catch (error) {
        if (!required && missingLocalToolFile(error)) return 0;
        throw error;
      }
      return bytes;
    };
    await localToolDirectory(this.root);
    let total = 0;
    for await (const entry of await fs.opendir(this.root)) {
      const directory = path.join(this.root, entry.name);
      const bytes = await visit(directory, 0, requiredDirectories.has(directory));
      sizes.set(directory, bytes);
      total += bytes;
      if (!Number.isSafeInteger(total) || total > LOCAL_TOOLS_CACHE_MAX_BYTES) throw new LocalExecutionError('storage_failed');
    }
    // Extractor descendants may disappear, but the cache root and each scanned lease must survive the walk.
    await localToolDirectory(this.root);
    for (const lease of leases) {
      await localToolDirectory(lease.directory);
      const size = sizes.get(lease.directory);
      if (size === undefined || size + lease.bufferedBytes > LOCAL_TASK_CACHE_MAX_BYTES) {
        lease.fail(new LocalExecutionError('storage_failed'));
      }
      total += lease.bufferedBytes;
    }
    if (total > LOCAL_TOOLS_CACHE_MAX_BYTES || performance.now() > deadline) throw new LocalExecutionError('storage_failed');
  }

  async release(lease: Lease): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try { await this.scanning; }
    finally {
      this.leases.delete(lease.directory);
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      if (this.leases.size) this.schedule();
      else pools.delete(this.root);
    }
  }
}

/** Only a task cache LocalTools allocated (`cache/task-<uuid>`) may be leased, written to or deleted. */
export function assertTaskCacheDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || !/^task-[a-f0-9-]{36}$/.test(path.basename(directory)) ||
      path.basename(path.dirname(directory)) !== 'cache' || directory !== path.resolve(directory) ||
      /[\0\r\n]/.test(directory)) throw new LocalExecutionError('storage_failed');
}

export function leaseTaskCache(directory: string): TaskCacheLease {
  assertTaskCacheDirectory(directory);
  const root = path.dirname(directory);
  let pool = pools.get(root);
  if (!pool) { pool = new CachePool(root); pools.set(root, pool); }
  if (pool.leases.has(directory) ||
      (pool.leases.size + 1) * LOCAL_TASK_CACHE_MAX_BYTES > LOCAL_TOOLS_CACHE_MAX_BYTES) {
    throw new LocalExecutionError('storage_failed');
  }
  const lease = new Lease(directory, pool);
  pool.leases.set(directory, lease);
  return lease;
}
