import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  downloadManagedToolAsset,
  findManagedNodeAsset,
  findManagedToolAsset,
  managedFfmpegArchiveEntry,
  managedNodeArtifact,
  ManagedToolDownloadError,
  MANAGED_NODE_VERSION,
  MANAGED_TOOL_MAX_DOWNLOAD,
  type ManagedToolAsset,
  type ManagedToolRepository,
} from '@monky/bot-sdk';
import {
  LOCAL_CAPABILITY_TOOLS,
  LOCAL_TOOL_IDS,
  localToolIdSchema,
  localToolReceiptSchema,
  type LocalExecutionFailure,
  type LocalCapabilityId,
  type LocalToolId,
  type LocalToolInfo,
  type LocalToolProgress,
  type LocalToolReceipt,
} from '@monky/shared';
import { LocalExecutionError, localFailure } from './errors';
import {
  localToolDirectory,
  localToolFingerprint,
  localToolPath,
  localToolStat,
  localToolStorageError,
  localToolTreeBytes,
  localToolUnsafeFileError,
  readLocalToolFile,
  removeLocalToolTree,
  retryLocalToolMutation,
  requireLocalToolSpace,
} from './localToolsStorage';
import {
  checkToolExtraction,
  extractLocalTool,
  localToolExtractionSupport,
  type LocalToolArchive,
  type ToolExtractionSupport,
} from './toolExtraction';

export interface LocalToolPaths {
  node: string;
  ytDlp: string;
  ffmpeg: string;
}

export interface LocalToolPreparationInfo {
  tools: Array<{ info: LocalToolInfo; maximumAdditionalBytes: number }>;
  maximumCacheBytes: number;
}

export interface LocalToolsOptions {
  root: string;
  onChanged?: () => void;
  probe: (tool: LocalToolId, paths: LocalToolPaths, signal: AbortSignal) => Promise<string>;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface LocalTaskCacheOwner {
  /** An exit code alone does not confirm that native descendants are gone. */
  confirmNativeClosed(): void;
}

export const LOCAL_TASK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const LOCAL_TOOLS_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const MAX_TASK_CACHES = LOCAL_TOOLS_CACHE_MAX_BYTES / LOCAL_TASK_CACHE_MAX_BYTES;
const RECEIPT_LIMIT = 16 * 1024;
const PREPARATION_TIMEOUT = 10 * 60_000;
// Allow the SDK's 30-second yt-dlp cold start and FFmpeg's sequential checks to finish cleanup.
const PROBE_TIMEOUT: Readonly<Record<LocalToolId, number>> = { node: 10_000, 'yt-dlp': 35_000, ffmpeg: 35_000 };
const PROGRESS_INTERVAL = 200;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const STAGING_NAME = new RegExp(`^\\.stage-(?:node|yt-dlp|ffmpeg)-${UUID}$`);

interface Recipe {
  name: string;
  repository: ManagedToolRepository | null;
  member: string | null;
  format: LocalToolArchive | null;
}

interface Preparation {
  controller: AbortController;
  result: Promise<LocalToolPaths>;
  waiters: Set<symbol>;
  settled: boolean;
}

interface CacheOwner {
  close: () => Promise<void>;
  confirmed: boolean;
  closing: Promise<void> | null;
}

function emptyTool(id: LocalToolId): LocalToolInfo {
  return { id, status: 'absent', version: null, sizeBytes: 0, sourceUrl: null, requiredBy: [], progress: null, failure: null };
}

function supportedTarget(platform: NodeJS.Platform, arch: string): boolean {
  return ['win32', 'linux', 'darwin'].includes(platform) && ['x64', 'arm64'].includes(arch);
}

function recipe(tool: LocalToolId, platform: NodeJS.Platform, arch: string): Recipe {
  if (!supportedTarget(platform, arch)) {
    throw new LocalExecutionError('unsupported_platform');
  }
  if (tool === 'node') {
    const artifact = managedNodeArtifact(platform, arch);
    return { name: artifact.name, member: artifact.entry, repository: null, format: artifact.entry ? 'tar.gz' : null };
  }
  if (tool === 'yt-dlp') {
    const name = platform === 'win32' ? arch === 'x64' ? 'yt-dlp.exe' : 'yt-dlp_arm64.exe'
      : platform === 'linux' ? arch === 'x64' ? 'yt-dlp_linux' : 'yt-dlp_linux_aarch64' : 'yt-dlp_macos';
    return { name, repository: 'yt-dlp/yt-dlp', member: null, format: null };
  }
  if (platform === 'darwin') {
    return { name: `ffmpeg-darwin-${arch}`, repository: 'eugeneware/ffmpeg-static', member: null, format: null };
  }
  const format = platform === 'win32' ? 'zip' : 'tar.xz';
  const name = `ffmpeg-master-latest-${platform === 'win32' ? 'win' : 'linux'}${arch === 'x64' ? '64' : 'arm64'}-gpl.${format}`;
  return { name, repository: 'yt-dlp/FFmpeg-Builds', member: managedFfmpegArchiveEntry(name), format };
}

function toolError(error: unknown, fallback: LocalExecutionFailure, signal?: AbortSignal): LocalExecutionError {
  if (error instanceof LocalExecutionError && error.reason === 'storage_failed') return error;
  if (error instanceof ManagedToolDownloadError) {
    if (['downloadOrigin', 'downloadMismatch', 'downloadTooLarge', 'checksumMissing', 'checksumAmbiguous',
      'metadataInvalid', 'assetInvalid', 'releaseInvalid'].includes(error.code)) fallback = 'integrity_failed';
    else if (error.code === 'downloadWriteFailed') fallback = 'storage_failed';
    else if (error.code === 'archiveUnsupported') fallback = 'unsupported_platform';
    else fallback = 'provider_unavailable';
  } else if (localToolStorageError(error)) {
    return new LocalExecutionError('storage_failed', { cause: error });
  } else if (localToolUnsafeFileError(error)) {
    fallback = 'integrity_failed';
  }
  return new LocalExecutionError(localFailure(error, fallback, signal), { cause: error });
}

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) throw toolError(signal.reason, 'cancelled', signal);
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(toolError(signal.reason, 'cancelled', signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

async function joinPreparation(preparation: Preparation | null): Promise<void> {
  if (!preparation) return;
  const [result] = await Promise.allSettled([preparation.result]);
  // Installation failures reach their consumers; failed cleanup must also stop maintenance.
  if (result.status === 'rejected' && result.reason instanceof LocalExecutionError && result.reason.reason === 'storage_failed') {
    throw result.reason;
  }
}

export class LocalTools {
  private readonly root: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly onChanged: () => void;
  private readonly probe: LocalToolsOptions['probe'];
  private readonly tools: Record<LocalToolId, LocalToolInfo> = {
    node: emptyTool('node'), 'yt-dlp': emptyTool('yt-dlp'), ffmpeg: emptyTool('ffmpeg'),
  };
  private readonly revisions: Record<LocalToolId, number> = { node: 0, 'yt-dlp': 0, ffmpeg: 0 };
  private readonly receipts = new Map<LocalToolId, {
    receipt: LocalToolReceipt; sha256: string; fingerprint: string; artifactFingerprint: string | null;
  }>();
  private readonly invalid = new Set<LocalToolId>();
  private readonly verifiedGenerations = new Map<LocalToolId, string>();
  private readonly caches = new Set<string>();
  private readonly cacheOperations = new Set<Promise<unknown>>();
  private readonly cacheRemovals = new Map<string, Promise<void>>();
  private readonly cacheOwners = new Map<string, CacheOwner>();
  private readonly lifetime = new AbortController();
  private cacheTail: Promise<unknown> | null = null;
  private initialization: Promise<void> | null = null;
  private initializationFailed = false;
  private support: ToolExtractionSupport | null = null;
  private preparation: Preparation | null = null;
  private maintenance: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private cleanupFailure: LocalExecutionError | null = null;
  private readonly failedCleanups = new Set<string>();
  private generation = 0;
  private closed = false;

  constructor(options: LocalToolsOptions) {
    if (typeof options.root !== 'string' || !path.isAbsolute(options.root) || /[\0\r\n]/.test(options.root) ||
        typeof options.probe !== 'function' || options.onChanged !== undefined && typeof options.onChanged !== 'function') {
      throw new LocalExecutionError('invalid_request');
    }
    this.root = path.resolve(options.root);
    if (this.root === path.parse(this.root).root) throw new LocalExecutionError('invalid_request');
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.onChanged = options.onChanged ?? (() => undefined);
    this.probe = options.probe;
  }

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(new LocalExecutionError('executor_unavailable'));
    if (!this.initialization || this.initializationFailed) {
      this.initializationFailed = false;
      const loading = this.load();
      this.initialization = loading;
      void loading.catch(() => { if (this.initialization === loading) this.initializationFailed = true; });
    }
    return this.initialization;
  }

  preparationInfo(capability: LocalCapabilityId): LocalToolPreparationInfo {
    this.assertOpen();
    return {
      tools: LOCAL_CAPABILITY_TOOLS[capability].map((id) => ({
        info: { ...this.tools[id], requiredBy: [], progress: this.tools[id].progress ? { ...this.tools[id].progress } : null },
        maximumAdditionalBytes: this.tools[id].status === 'ready' ? 0
          : MANAGED_TOOL_MAX_DOWNLOAD * (recipe(id, this.platform, this.arch).member ? 2 : 1) + RECEIPT_LIMIT,
      })),
      maximumCacheBytes: LOCAL_TOOLS_CACHE_MAX_BYTES,
    };
  }

  /** Read-only, integrity-checked reuse; never prepares/downloads tools implicitly. */
  async readyExecutable(tool: LocalToolId): Promise<string | null> {
    if (!localToolIdSchema.safeParse(tool).success) throw new LocalExecutionError('invalid_request');
    await this.initialize();
    this.assertAvailable(this.lifetime.signal, this.generation);
    if (this.tools[tool].status === 'installing' || this.tools[tool].status === 'removing') return null;
    const info = await this.inspect(tool, this.lifetime.signal, true);
    this.assertAvailable(this.lifetime.signal, this.generation);
    return info.status === 'ready' ? localToolPath(this.root, 'tools', tool, this.executableName(tool)) : null;
  }

  async snapshot(): Promise<{ supported: boolean; tools: LocalToolInfo[]; toolsBytes: number; cacheBytes: number }> {
    try {
      await this.initialize();
      this.assertOpen();
      this.support = await localToolExtractionSupport(this.platform, this.arch);
      await this.refresh(this.lifetime.signal);
      // Tree walks share the filesystem queue with deletion. Windows can return
      // EPERM, not ENOENT, for a directory that our cleanup is currently removing.
      return await this.queueCacheOperation(async () => {
        this.assertOpen();
        const toolsBytes = await localToolTreeBytes(this.root, this.toolsDirectory());
        const cacheBytes = await localToolTreeBytes(this.root, this.cacheDirectory());
        await localToolDirectory(this.toolsDirectory());
        await localToolDirectory(this.cacheDirectory());
        this.assertOpen();
        return {
          supported: this.support !== null,
          tools: LOCAL_TOOL_IDS.map((tool) => ({
            ...this.tools[tool], requiredBy: [], progress: this.tools[tool].progress ? { ...this.tools[tool].progress } : null,
          })),
          toolsBytes, cacheBytes,
        };
      });
    } catch (error) {
      throw toolError(error, 'storage_failed', this.lifetime.signal);
    }
  }

  async prepare(signal: AbortSignal, retryCleanup = false): Promise<LocalToolPaths> {
    const generation = this.generation;
    if (retryCleanup && this.cleanupFailure) await this.retryFailedCleanup(signal, generation);
    this.assertAvailable(signal, generation);
    if (this.preparation?.controller.signal.aborted) {
      await waitWithSignal(joinPreparation(this.preparation), signal);
      this.assertAvailable(signal, generation);
    }
    let preparation = this.preparation;
    if (!preparation) {
      const controller = new AbortController();
      const result = this.prepareTools(controller, generation);
      preparation = { controller, result, waiters: new Set(), settled: false };
      this.preparation = preparation;
      const current = preparation;
      const finish = (): void => {
        current.settled = true;
        if (this.preparation === current) this.preparation = null;
      };
      result.then(finish, finish);
    }
    const waiter = Symbol();
    preparation.waiters.add(waiter);
    try {
      return { ...await waitWithSignal(preparation.result, signal) };
    } finally {
      preparation.waiters.delete(waiter);
      if (!preparation.waiters.size && !preparation.settled) {
        preparation.controller.abort(new LocalExecutionError('cancelled'));
        await joinPreparation(preparation);
      }
    }
  }

  remove(tool: LocalToolId): Promise<void> {
    if (!localToolIdSchema.safeParse(tool).success) return Promise.reject(new LocalExecutionError('invalid_request'));
    return this.maintain(async () => {
      this.update(tool, { ...this.tools[tool], status: 'removing', progress: null, failure: null });
      this.assertNativeOwnersClosed();
      await removeLocalToolTree(this.root, this.toolDirectory(tool));
      this.receipts.delete(tool);
      this.verifiedGenerations.delete(tool);
      this.invalid.delete(tool);
      this.update(tool, emptyTool(tool));
    }, tool);
  }

  clearCache(): Promise<void> {
    return this.maintain(async () => {
      this.assertNativeOwnersClosed();
      await localToolDirectory(this.cacheDirectory());
      const directories = new Set([
        ...this.caches,
        ...(await fs.readdir(this.cacheDirectory())).map((name) => localToolPath(this.root, 'cache', name)),
      ]);
      for (const directory of directories) await this.removeCacheDirectory(directory);
      this.notify();
    });
  }

  async allocateTaskCache(): Promise<string> {
    const generation = this.generation;
    this.assertAvailable(this.lifetime.signal, generation);
    const directory = localToolPath(this.root, 'cache', `task-${randomUUID()}`);
    return this.queueCacheOperation(() => this.allocateCache(directory, generation));
  }

  /** Register before native startup; close must confirm closure and release this exact cache. */
  registerTaskCacheOwner(directory: string, close: () => Promise<void>): LocalTaskCacheOwner {
    this.assertAvailable(this.lifetime.signal, this.generation);
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !this.caches.has(directory) ||
        this.cacheRemovals.has(directory) || this.cacheOwners.has(directory) || typeof close !== 'function') {
      throw new LocalExecutionError('invalid_request');
    }
    const owner: CacheOwner = { close, confirmed: false, closing: null };
    this.cacheOwners.set(directory, owner);
    return {
      confirmNativeClosed: () => {
        if (this.cacheOwners.get(directory) !== owner || !this.caches.has(directory)) {
          throw new LocalExecutionError('invalid_request');
        }
        owner.confirmed = true;
      },
    };
  }

  removeTaskCache(directory: string): Promise<void> {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      return Promise.reject(new LocalExecutionError('invalid_request'));
    }
    const existing = this.cacheRemovals.get(directory);
    if (existing) return existing;
    if (!this.caches.has(directory)) return Promise.reject(new LocalExecutionError('invalid_request'));
    try {
      this.assertCacheOwnerClosed(directory);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.queueCacheOperation(() => this.deleteCache(directory));
    this.cacheRemovals.set(directory, operation);
    const finish = (): void => {
      if (this.cacheRemovals.get(directory) === operation) this.cacheRemovals.delete(directory);
    };
    operation.then(finish, finish);
    return operation;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (!this.closed) {
      this.closed = true;
      this.generation++;
      this.lifetime.abort(new LocalExecutionError('executor_unavailable'));
      this.preparation?.controller.abort(new LocalExecutionError('executor_unavailable'));
    }
    const disposal = this.close();
    this.disposal = disposal;
    disposal.then(undefined, () => {
      if (this.disposal === disposal) this.disposal = null;
    });
    return disposal;
  }

  private toolsDirectory(): string { return localToolPath(this.root, 'tools'); }
  private cacheDirectory(): string { return localToolPath(this.root, 'cache'); }
  private toolDirectory(tool: LocalToolId): string { return localToolPath(this.root, 'tools', tool); }
  private executableName(tool: LocalToolId): string { return `${tool}${this.platform === 'win32' ? '.exe' : ''}`; }

  private paths(): LocalToolPaths {
    return {
      node: localToolPath(this.root, 'tools', 'node', this.executableName('node')),
      ytDlp: localToolPath(this.root, 'tools', 'yt-dlp', this.executableName('yt-dlp')),
      ffmpeg: localToolPath(this.root, 'tools', 'ffmpeg', this.executableName('ffmpeg')),
    };
  }

  private withCandidate(tool: LocalToolId, candidate: string): LocalToolPaths {
    const paths = this.paths();
    if (tool === 'node') paths.node = candidate;
    else if (tool === 'yt-dlp') paths.ytDlp = candidate;
    else paths.ffmpeg = candidate;
    return paths;
  }

  private assertOpen(): void {
    if (this.closed) throw new LocalExecutionError('executor_unavailable');
  }

  private assertAvailable(signal: AbortSignal, generation: number): void {
    this.assertOpen();
    assertSignal(signal);
    if (generation !== this.generation) throw new LocalExecutionError('cancelled');
    if (this.maintenance) throw new LocalExecutionError('busy');
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  private notify(): void {
    if (!this.closed) this.onChanged();
  }

  private update(tool: LocalToolId, info: LocalToolInfo, notify = true): void {
    this.revisions[tool]++;
    this.tools[tool] = info;
    if (notify) this.notify();
  }

  private async load(): Promise<void> {
    const signal = new AbortController().signal;
    try {
      await localToolDirectory(path.dirname(this.root));
      await localToolDirectory(this.root, true);
      await localToolDirectory(this.toolsDirectory(), true);
      await localToolDirectory(this.cacheDirectory(), true);
      this.support = await localToolExtractionSupport(this.platform, this.arch);
      await this.cleanStages();
      await this.refresh(signal);
    } catch (error) {
      throw toolError(error, 'storage_failed');
    }
  }

  private async cleanStages(): Promise<void> {
    this.assertNativeOwnersClosed();
    await localToolDirectory(this.toolsDirectory());
    for (const name of await fs.readdir(this.toolsDirectory())) {
      if (STAGING_NAME.test(name)) await removeLocalToolTree(this.root, localToolPath(this.root, 'tools', name));
    }
  }

  private async refresh(signal: AbortSignal): Promise<void> {
    await localToolDirectory(this.toolsDirectory());
    await localToolDirectory(this.cacheDirectory());
    for (const tool of LOCAL_TOOL_IDS) {
      if (this.tools[tool].status === 'installing' || this.tools[tool].status === 'removing') continue;
      const revision = this.revisions[tool];
      try {
        const info = await this.inspect(tool, signal);
        if (revision === this.revisions[tool]) this.update(tool, info, false);
      } catch (error) {
        // An owned removal/publication can invalidate an older inventory read.
        if (revision === this.revisions[tool]) throw error;
        assertSignal(signal);
      }
    }
  }

  private async inspect(tool: LocalToolId, signal: AbortSignal, forceHash = false): Promise<LocalToolInfo> {
    const revision = this.revisions[tool];
    const directory = this.toolDirectory(tool);
    const sizeBytes = await localToolTreeBytes(this.root, directory);
    const invalid = (): LocalToolInfo => {
      if (revision === this.revisions[tool]) {
        this.invalid.add(tool);
        this.receipts.delete(tool);
        this.verifiedGenerations.delete(tool);
      }
      return { ...emptyTool(tool), status: 'invalid', sizeBytes, failure: 'integrity_failed' };
    };
    if (this.invalid.has(tool)) return invalid();
    if (!await localToolStat(directory)) {
      if (revision === this.revisions[tool]) this.receipts.delete(tool);
      return this.tools[tool].status === 'failed' ? { ...this.tools[tool], sizeBytes: 0 } : emptyTool(tool);
    }
    try {
      await localToolDirectory(directory);
      const names = await fs.readdir(directory);
      const executable = this.executableName(tool);
      if (!supportedTarget(this.platform, this.arch)) throw new LocalExecutionError('integrity_failed');
      const expected = recipe(tool, this.platform, this.arch);
      if (names.length !== (expected.member ? 3 : 2) || !names.includes(executable) || !names.includes('receipt.json') ||
          expected.member && !names.includes('artifact')) {
        throw new LocalExecutionError('integrity_failed');
      }
      const stored = await readLocalToolFile(this.root, localToolPath(this.root, directory, 'receipt.json'), RECEIPT_LIMIT, signal, true);
      const value: unknown = JSON.parse(stored.contents.toString('utf8'));
      const parsed = localToolReceiptSchema.safeParse(value);
      if (!parsed.success || !this.validReceipt(tool, parsed.data)) throw new LocalExecutionError('integrity_failed');
      const previous = this.receipts.get(tool);
      if (previous && previous.sha256 !== stored.sha256) throw new LocalExecutionError('integrity_failed');
      const filename = localToolPath(this.root, directory, executable);
      const stat = await localToolStat(filename);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          stat.size !== parsed.data.sizeBytes || this.platform !== 'win32' && (stat.mode & 0o100) === 0) {
        throw new LocalExecutionError('integrity_failed');
      }
      let fingerprint = localToolFingerprint(stat);
      if (forceHash || !previous || previous.fingerprint !== fingerprint) {
        const file = await readLocalToolFile(this.root, filename, MANAGED_TOOL_MAX_DOWNLOAD, signal);
        if (file.sha256 !== parsed.data.executableSha256 || file.size !== parsed.data.sizeBytes) {
          throw new LocalExecutionError('integrity_failed');
        }
        fingerprint = file.fingerprint;
      }
      let artifactFingerprint: string | null = null;
      if (expected.member) {
        const archive = localToolPath(this.root, directory, 'artifact');
        const artifactStat = await localToolStat(archive);
        if (!artifactStat || !artifactStat.isFile() || artifactStat.isSymbolicLink() || artifactStat.nlink !== 1 ||
            artifactStat.size <= 0 || artifactStat.size > MANAGED_TOOL_MAX_DOWNLOAD) throw new LocalExecutionError('integrity_failed');
        artifactFingerprint = localToolFingerprint(artifactStat);
        if (!previous || previous.artifactFingerprint !== artifactFingerprint) {
          const artifact = await readLocalToolFile(this.root, archive, MANAGED_TOOL_MAX_DOWNLOAD, signal);
          if (artifact.sha256 !== parsed.data.artifactSha256) throw new LocalExecutionError('integrity_failed');
          artifactFingerprint = artifact.fingerprint;
        }
      }
      if (revision === this.revisions[tool]) {
        this.receipts.set(tool, { receipt: parsed.data, sha256: stored.sha256, fingerprint, artifactFingerprint });
      }
      return { ...emptyTool(tool), status: 'ready', version: parsed.data.version, sourceUrl: parsed.data.sourceUrl, sizeBytes };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof LocalExecutionError && error.reason === 'integrity_failed') return invalid();
      throw error;
    }
  }

  private validReceipt(tool: LocalToolId, receipt: LocalToolReceipt): boolean {
    if (receipt.id !== tool || receipt.sizeBytes <= 0 || receipt.sizeBytes > MANAGED_TOOL_MAX_DOWNLOAD ||
        receipt.installedAt > Date.now() + 60_000 ||
        receipt.version !== receipt.version.trim() || /[\x00-\x1f\x7f]/.test(receipt.version)) return false;
    if (!supportedTarget(this.platform, this.arch)) return false;
    const expected = recipe(tool, this.platform, this.arch);
    if (receipt.artifactName !== expected.name || !expected.member && receipt.artifactSha256 !== receipt.executableSha256) return false;
    if (tool === 'node') {
      return receipt.sourceUrl === `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/${expected.name}`;
    }
    const prefix = `https://github.com/${expected.repository}/releases/download/`;
    if (!receipt.sourceUrl.startsWith(prefix)) return false;
    const suffix = receipt.sourceUrl.slice(prefix.length);
    const separator = suffix.indexOf('/');
    return separator > 0 && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(suffix.slice(0, separator)) &&
      suffix.slice(separator + 1) === expected.name;
  }

  private async prepareTools(controller: AbortController, generation: number): Promise<LocalToolPaths> {
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new LocalExecutionError('timeout')), PREPARATION_TIMEOUT);
    try {
      this.assertAvailable(signal, generation);
      await this.initialize();
      this.assertAvailable(signal, generation);
      this.support = await localToolExtractionSupport(this.platform, this.arch);
      this.assertAvailable(signal, generation);
      const support = this.support;
      if (!support) throw new LocalExecutionError('unsupported_platform');
      await this.refresh(signal);
      this.assertAvailable(signal, generation);
      if (LOCAL_TOOL_IDS.some((tool) => this.tools[tool].status === 'invalid')) throw new LocalExecutionError('integrity_failed');
      const implementation = await checkToolExtraction(support, signal);
      for (const tool of LOCAL_TOOL_IDS) {
        this.assertAvailable(signal, generation);
        if (this.tools[tool].status === 'ready') {
          const expected = this.receipts.get(tool)?.receipt.version;
          try {
            let info = await this.inspect(tool, signal, true);
            if (info.status !== 'ready') throw new LocalExecutionError('integrity_failed');
            this.assertAvailable(signal, generation);
            // Integrity is still rehashed on every use. A native version probe
            // is needed only once per unchanged generation in this process.
            if (this.verifiedGenerations.get(tool) !== this.receiptGeneration(tool)) {
              const version = await this.check(tool, this.paths(), signal);
              this.assertAvailable(signal, generation);
              info = await this.inspect(tool, signal);
              if (info.status !== 'ready' || version !== expected) throw new LocalExecutionError('integrity_failed');
              this.verifiedGenerations.set(tool, this.receiptGeneration(tool));
            }
            this.assertAvailable(signal, generation);
            this.update(tool, info);
          } catch (error) {
            if (!signal.aborted) {
              this.invalid.add(tool);
              this.verifiedGenerations.delete(tool);
              this.update(tool, { ...this.tools[tool], status: 'invalid', failure: localFailure(error, 'tool_install_failed'), progress: null });
            }
            throw error;
          }
        } else {
          await this.install(tool, support, implementation, signal, generation);
        }
      }
      this.assertAvailable(signal, generation);
      return this.paths();
    } catch (error) {
      throw toolError(error, 'tool_install_failed', signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private receiptGeneration(tool: LocalToolId): string {
    const receipt = this.receipts.get(tool);
    if (!receipt) throw new LocalExecutionError('integrity_failed');
    return JSON.stringify([receipt.sha256, receipt.fingerprint, receipt.artifactFingerprint]);
  }

  private async check(tool: LocalToolId, paths: LocalToolPaths, signal: AbortSignal): Promise<string> {
    assertSignal(signal);
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new LocalExecutionError('timeout')), PROBE_TIMEOUT[tool]);
    try {
      const version = (await this.probe(tool, { ...paths }, controller.signal)).trim();
      assertSignal(controller.signal);
      if (!version || version.length > 128 || /[\x00-\x1f\x7f]/.test(version)) throw new LocalExecutionError('tool_install_failed');
      return version;
    } catch (error) {
      throw toolError(error, 'tool_install_failed', controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private async install(
    tool: LocalToolId, support: ToolExtractionSupport, implementation: 'gnu' | 'bsd',
    signal: AbortSignal, generation: number,
  ): Promise<void> {
    const expected = recipe(tool, this.platform, this.arch);
    const stage = localToolPath(this.root, 'tools', `.stage-${tool}-${randomUUID()}`);
    const target = this.toolDirectory(tool);
    let created = false;
    let published = false;
    let committed = false;
    let lastProgress = 0;
    const progress = (value: LocalToolProgress, force = true): void => {
      this.assertAvailable(signal, generation);
      const notify = force || Date.now() - lastProgress >= PROGRESS_INTERVAL;
      if (notify) lastProgress = Date.now();
      this.update(tool, { ...this.tools[tool], progress: value }, notify);
    };
    this.update(tool, { ...emptyTool(tool), status: 'installing' });
    try {
      progress({ stage: 'resolving', downloadedBytes: 0, totalBytes: null });
      const asset: ManagedToolAsset = expected.repository
        ? await findManagedToolAsset(expected.repository, expected.name, signal)
        : await findManagedNodeAsset(this.platform, this.arch, signal);
      this.assertAvailable(signal, generation);
      await requireLocalToolSpace(this.root, asset.size + (expected.member ? MANAGED_TOOL_MAX_DOWNLOAD : 0) + LOCAL_TASK_CACHE_MAX_BYTES);
      await localToolDirectory(this.toolsDirectory());
      this.assertAvailable(signal, generation);
      await fs.mkdir(stage, { mode: 0o700 });
      created = true;
      const candidate = localToolPath(this.root, stage, this.executableName(tool));
      const download = expected.member ? localToolPath(this.root, stage, 'artifact') : candidate;
      this.update(tool, { ...this.tools[tool], sourceUrl: asset.url });
      await localToolDirectory(stage);
      this.assertAvailable(signal, generation);
      await downloadManagedToolAsset(asset, download, signal, {
        onProgress: (update) => progress({
          stage: 'downloading', downloadedBytes: update.receivedBytes, totalBytes: update.totalBytes,
        }, update.done === true),
        onVerify: () => progress({ stage: 'verifying', downloadedBytes: asset.size, totalBytes: asset.size }),
      });
      this.assertAvailable(signal, generation);
      const artifact = await readLocalToolFile(this.root, download, MANAGED_TOOL_MAX_DOWNLOAD, signal);
      if (artifact.sha256 !== asset.sha256 || artifact.size !== asset.size) throw new LocalExecutionError('integrity_failed');
      if (expected.member && expected.format) {
        // Retaining the checked archive makes its receipt digest verifiable offline after restart.
        progress({ stage: 'extracting', downloadedBytes: asset.size, totalBytes: asset.size });
        await localToolDirectory(stage);
        await extractLocalTool({
          support, implementation, archive: download, format: expected.format, member: expected.member,
          destination: candidate, maxBytes: MANAGED_TOOL_MAX_DOWNLOAD, signal,
        });
      }
      const before = await readLocalToolFile(this.root, candidate, MANAGED_TOOL_MAX_DOWNLOAD, signal);
      await fs.chmod(candidate, 0o700);
      progress({ stage: 'checking', downloadedBytes: asset.size, totalBytes: asset.size });
      const version = await this.check(tool, this.withCandidate(tool, candidate), signal);
      this.assertAvailable(signal, generation);
      const after = await readLocalToolFile(this.root, candidate, MANAGED_TOOL_MAX_DOWNLOAD, signal);
      if (before.sha256 !== after.sha256 || before.size !== after.size) throw new LocalExecutionError('integrity_failed');
      const receipt: LocalToolReceipt = {
        id: tool, version, artifactName: asset.name, artifactSha256: asset.sha256,
        executableSha256: after.sha256, sourceUrl: asset.url, sizeBytes: after.size, installedAt: Date.now(),
      };
      if (!localToolReceiptSchema.safeParse(receipt).success || !this.validReceipt(tool, receipt)) {
        throw new LocalExecutionError('integrity_failed');
      }
      const contents = `${JSON.stringify(receipt)}\n`;
      await localToolDirectory(stage);
      this.assertAvailable(signal, generation);
      const output = await fs.open(localToolPath(this.root, stage, 'receipt.json'), 'wx', 0o600);
      try {
        await output.writeFile(contents, 'utf8');
        await output.sync();
      } finally {
        await output.close();
      }
      await this.queueCacheOperation(async () => {
        await retryLocalToolMutation(async () => {
          await localToolDirectory(stage);
          if (await localToolStat(target)) throw new LocalExecutionError('integrity_failed');
          this.assertAvailable(signal, generation);
          await fs.rename(stage, target);
        }, signal);
        published = true;
        this.assertAvailable(signal, generation);
        const info = await this.inspect(tool, signal);
        if (info.status !== 'ready') throw new LocalExecutionError('integrity_failed');
        this.assertAvailable(signal, generation);
        committed = true;
        this.verifiedGenerations.set(tool, this.receiptGeneration(tool));
        this.update(tool, info);
      });
    } catch (error) {
      const failure = toolError(error, 'tool_install_failed', signal);
      if (this.tools[tool].status === 'installing') {
        const cancelled = failure.reason === 'cancelled' || failure.reason === 'executor_unavailable';
        this.update(tool, { ...emptyTool(tool), status: cancelled ? 'absent' : 'failed', failure: cancelled ? null : failure.reason });
      }
      throw failure;
    } finally {
      try {
        if (created && !committed) await this.queueCacheOperation(async () => {
          await this.cleanup(published ? target : stage);
          if (published) this.receipts.delete(tool);
        });
      } catch (error) {
        if (this.tools[tool].status !== 'removing') {
          this.update(tool, { ...emptyTool(tool), status: 'failed', failure: localFailure(error, 'storage_failed') });
        }
        throw error;
      } finally {
        if (created && !committed) this.notify();
      }
    }
  }

  private async cleanup(directory: string): Promise<void> {
    try {
      if (path.dirname(directory) === this.toolsDirectory()) this.assertNativeOwnersClosed();
      else this.assertCacheOwnerClosed(directory);
      await removeLocalToolTree(this.root, directory);
      this.failedCleanups.delete(directory);
      if (!this.failedCleanups.size) this.cleanupFailure = null;
    } catch (error) {
      this.failedCleanups.add(directory);
      this.cleanupFailure = toolError(error, 'storage_failed');
      throw this.cleanupFailure;
    }
  }

  private retryFailedCleanup(signal: AbortSignal, generation: number): Promise<void> {
    return this.queueCacheOperation(async () => {
      this.assertOpen();
      assertSignal(signal);
      if (generation !== this.generation) throw new LocalExecutionError('cancelled');
      if (this.preparation || this.maintenance) throw new LocalExecutionError('busy');
      // Retry is an explicit dialog action. It may clean retained files, never
      // bypass an unconfirmed native owner or silently replace invalid tools.
      this.assertNativeOwnersClosed();
      await this.cleanFailedFiles(signal);
    });
  }

  private async cleanFailedFiles(signal?: AbortSignal): Promise<void> {
    for (const directory of this.failedCleanups) {
      if (signal) assertSignal(signal);
      await this.cleanup(directory);
      if (path.dirname(directory) === this.cacheDirectory()) {
        this.caches.delete(directory);
        this.cacheOwners.delete(directory);
      }
    }
  }

  private maintain(action: () => Promise<void>, tool?: LocalToolId): Promise<void> {
    try {
      this.assertOpen();
      if (this.maintenance) throw new LocalExecutionError('busy');
    } catch (error) {
      return Promise.reject(error);
    }
    this.generation++;
    const preparation = this.preparation;
    const cacheOperations = [...this.cacheOperations];
    const operation = (async (): Promise<void> => {
      try {
        await this.initialize();
        const drained = await Promise.allSettled([
          joinPreparation(preparation), this.joinCacheOperations(cacheOperations), this.drainCacheOwners(),
        ]);
        this.assertNativeOwnersClosed();
        for (const result of drained) {
          if (result.status === 'rejected') throw result.reason;
        }
        // Probe cleanup may use the cache queue while preparation is draining.
        await this.queueCacheOperation(async () => {
          this.assertNativeOwnersClosed();
          await this.cleanStages();
          await this.cleanFailedFiles();
          await action();
        });
      } catch (error) {
        const failure = toolError(error, 'storage_failed');
        if (tool) this.update(tool, { ...this.tools[tool], status: 'failed', failure: failure.reason, progress: null });
        throw failure;
      }
    })();
    this.maintenance = operation;
    preparation?.controller.abort(new LocalExecutionError('cancelled'));
    if (tool) this.update(tool, { ...this.tools[tool], status: 'removing', progress: null, failure: null });
    const finish = (): void => { if (this.maintenance === operation) this.maintenance = null; };
    operation.then(finish, finish);
    return operation;
  }

  private assertCacheOwnerClosed(directory: string): void {
    const owner = this.cacheOwners.get(directory);
    if (owner && !owner.confirmed) {
      throw new LocalExecutionError('worker_failed', {
        cause: new Error('The native cache owner has not confirmed closure.'),
      });
    }
  }

  private assertNativeOwnersClosed(): void {
    for (const directory of this.cacheOwners.keys()) this.assertCacheOwnerClosed(directory);
  }

  private closeCacheOwner(owner: CacheOwner): Promise<void> {
    if (owner.closing) return owner.closing;
    const closing = Promise.resolve().then(owner.close);
    owner.closing = closing;
    const finish = (): void => { if (owner.closing === closing) owner.closing = null; };
    closing.then(finish, finish);
    return closing;
  }

  private async drainCacheOwners(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.cacheOwners.values()].map((owner) => this.closeCacheOwner(owner)),
    );
    this.assertNativeOwnersClosed();
    for (const result of results) {
      if (result.status === 'rejected') throw toolError(result.reason, 'worker_failed');
    }
  }

  private queueCacheOperation<T>(action: () => Promise<T>): Promise<T> {
    // Join only filesystem work, never a preparation/maintenance promise that may need this queue.
    // Each caller receives its own failure; a failed predecessor must not prevent later cleanup.
    const operation = Promise.allSettled(this.cacheTail ? [this.cacheTail] : []).then(action);
    this.cacheTail = operation;
    this.trackCacheOperation(operation);
    const finish = (): void => {
      if (this.cacheTail === operation) this.cacheTail = null;
    };
    operation.then(finish, finish);
    return operation;
  }

  private trackCacheOperation(operation: Promise<unknown>): void {
    this.cacheOperations.add(operation);
    const finish = (): void => { this.cacheOperations.delete(operation); };
    operation.then(finish, finish);
  }

  private async joinCacheOperations(operations: Promise<unknown>[] = [...this.cacheOperations]): Promise<void> {
    const results = await Promise.allSettled(operations);
    for (const result of results) {
      if (result.status === 'rejected' && result.reason instanceof LocalExecutionError && result.reason.reason === 'storage_failed') {
        throw result.reason;
      }
    }
  }

  private async allocateCache(directory: string, generation: number): Promise<string> {
    let created = false;
    try {
      this.assertAvailable(this.lifetime.signal, generation);
      await this.initialize();
      this.assertAvailable(this.lifetime.signal, generation);
      if (this.caches.size >= MAX_TASK_CACHES) throw new LocalExecutionError('storage_failed');
      this.caches.add(directory);
      await localToolDirectory(this.cacheDirectory());
      const entries = await fs.readdir(this.cacheDirectory());
      let staleCount = 0;
      let staleBytes = 0;
      let activeBytes = 0;
      for (const entry of entries) {
        const child = localToolPath(this.root, 'cache', entry);
        const bytes = await localToolTreeBytes(this.root, child);
        if (this.caches.has(child)) {
          if (bytes > LOCAL_TASK_CACHE_MAX_BYTES) throw new LocalExecutionError('storage_failed');
          activeBytes += bytes;
        } else {
          staleCount++;
          staleBytes += bytes;
        }
      }
      const reservedBytes = this.caches.size * LOCAL_TASK_CACHE_MAX_BYTES;
      if (staleCount + this.caches.size > MAX_TASK_CACHES || staleBytes + reservedBytes > LOCAL_TOOLS_CACHE_MAX_BYTES) {
        throw new LocalExecutionError('storage_failed');
      }
      await requireLocalToolSpace(this.root, Math.max(LOCAL_TASK_CACHE_MAX_BYTES, reservedBytes - activeBytes));
      this.assertAvailable(this.lifetime.signal, generation);
      await fs.mkdir(directory, { mode: 0o700 });
      created = true;
      this.assertAvailable(this.lifetime.signal, generation);
      this.notify();
      this.assertAvailable(this.lifetime.signal, generation);
      return directory;
    } catch (error) {
      if (created) await this.cleanup(directory);
      this.caches.delete(directory);
      throw toolError(error, 'storage_failed');
    }
  }

  private async deleteCache(directory: string): Promise<void> {
    try {
      // Ownership was checked when queued; an earlier serialized sweep may have released it.
      if (!this.caches.has(directory)) return;
      await this.removeCacheDirectory(directory);
      this.notify();
    } catch (error) {
      throw toolError(error, 'storage_failed');
    }
  }

  private async removeCacheDirectory(directory: string): Promise<void> {
    this.assertCacheOwnerClosed(directory);
    await removeLocalToolTree(this.root, directory);
    this.caches.delete(directory);
    this.cacheOwners.delete(directory);
  }

  private async close(): Promise<void> {
    const pending: Promise<unknown>[] = [
      joinPreparation(this.preparation), this.joinCacheOperations(), this.drainCacheOwners(),
    ];
    if (this.initialization) pending.push(this.initialization);
    if (this.maintenance) pending.push(this.maintenance);
    const results = await Promise.allSettled(pending);
    this.assertNativeOwnersClosed();
    for (const result of results) {
      if (result.status === 'rejected') throw toolError(result.reason, 'storage_failed');
    }
    const [sweep] = await Promise.allSettled([this.queueCacheOperation(async () => {
      this.assertNativeOwnersClosed();
      if (this.cleanupFailure) {
        const [result] = await Promise.allSettled([this.cleanFailedFiles()]);
        results.push(result);
      }
      for (const directory of this.caches) {
        const [result] = await Promise.allSettled([this.removeCacheDirectory(directory)]);
        results.push(result);
      }
    })]);
    results.push(sweep);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw toolError(failure.reason, 'storage_failed');
  }
}
