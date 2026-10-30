import { StickerEntry, StickerSaveResult } from '@monky/shared';
import { settingsStore } from '../stores/settingsStore';

/**
 * Custom chat stickers (#356).
 *
 * Mirrors SoundboardService: the user points at a folder on their machine and we
 * list the image files in it. Only metadata is kept in memory — the bytes of a
 * sticker are read on demand and kept in a small LRU cache, so scrolling through
 * a folder with hundreds of animated GIFs does not balloon the renderer's
 * memory.
 */

/**
 * How many bytes of decoded sticker images stay in memory. The cache is bounded
 * by size rather than by entry count because a single animated GIF can be
 * several megabytes, and base64 adds ~33% on top. Re-reading an evicted entry is
 * a local file read, which is cheap.
 */
const MAX_CACHED_BYTES = 48 * 1024 * 1024;

interface CachedSticker {
  dataUrl: string;
  /** File size when it was read, so a replaced file can be told apart. */
  fileBytes: number;
}

class StickerService {
  private stickers: StickerEntry[] = [];
  private dataUrls = new Map<string, CachedSticker>();
  private cachedBytes = 0;
  private loadedFolder: string | null = null;
  /** Bumped on every load so a slow response can tell it has been superseded. */
  private loadToken = 0;
  /** The last listing failed, which is not the same as an empty folder. */
  private listingFailed = false;

  public getStickers(): StickerEntry[] {
    return this.stickers;
  }

  public hasFolder(): boolean {
    return Boolean(settingsStore.stickersFolderPath);
  }

  /**
   * Main refuses a folder this computer never confirmed (D4), for example one
   * restored from a backup. Reloading from a click lets Main ask the person.
   */
  public didListingFail(): boolean {
    return this.listingFailed;
  }

  /**
   * Reads the folder listing. `force` re-reads from disk even for the folder
   * already loaded — the picker does that every time it opens, because the user
   * can add or delete files while the app is running and a stale listing looks
   * exactly like the feature being broken.
   */
  public async loadStickers(force = false): Promise<StickerEntry[]> {
    const folder = settingsStore.stickersFolderPath;
    if (!folder) {
      this.reset();
      return [];
    }
    if (!force && this.loadedFolder === folder) return this.stickers;

    const sameFolder = this.loadedFolder === folder;
    const token = ++this.loadToken;

    let listed: StickerEntry[] = [];
    let failed = false;
    try {
      listed = (await window.api?.listStickers?.(folder)) ?? [];
    } catch (e) {
      failed = true;
      console.warn('Failed to list stickers:', e);
    }

    // A newer load started while this one was in flight, so its result is the
    // current truth. Without this guard a slow listing of the previous folder
    // could land last and leave the service describing a folder the user is no
    // longer looking at, making sticker clicks silently do nothing.
    if (token !== this.loadToken) return this.stickers;

    this.stickers = listed;
    this.listingFailed = failed;
    if (sameFolder) {
      this.dropStaleCache();
    } else {
      // Cached bytes belong to the previous folder, so they must not survive it.
      this.clearCache();
    }
    this.loadedFolder = folder;
    return this.stickers;
  }

  /**
   * Drops cached bytes for files that no longer exist or whose size changed, so
   * replacing a sticker on disk without renaming it still shows the new image.
   */
  private dropStaleCache(): void {
    const current = new Map(this.stickers.map((s) => [s.filePath, s.sizeBytes]));
    for (const [filePath, entry] of Array.from(this.dataUrls.entries())) {
      // Covers both cases at once: a deleted file yields `undefined`, and a file
      // replaced in place yields a different size.
      if (current.get(filePath) !== entry.fileBytes) this.evict(filePath);
    }
  }

  /** Returns the sticker image as a data URL, reading it from disk once. */
  public async getDataUrl(filePath: string): Promise<string | null> {
    const cached = this.dataUrls.get(filePath);
    if (cached) {
      // Re-inserting moves the entry to the end of the Map's insertion order,
      // which is what makes the eviction below least-recently-used.
      this.dataUrls.delete(filePath);
      this.dataUrls.set(filePath, cached);
      return cached.dataUrl;
    }
    try {
      const data = await window.api?.readSticker?.(filePath);
      if (!data) return null;
      // A concurrent read of the same file would otherwise be counted twice.
      this.evict(filePath);
      this.dataUrls.set(filePath, { dataUrl: data.dataUrl, fileBytes: data.sizeBytes });
      this.cachedBytes += data.dataUrl.length;
      this.evictUntilWithinBudget();
      return data.dataUrl;
    } catch (e) {
      console.warn('Failed to read sticker:', e);
      return null;
    }
  }

  private evict(filePath: string): void {
    const entry = this.dataUrls.get(filePath);
    if (entry === undefined) return;
    this.cachedBytes -= entry.dataUrl.length;
    this.dataUrls.delete(filePath);
  }

  private evictUntilWithinBudget(): void {
    while (this.cachedBytes > MAX_CACHED_BYTES) {
      const oldest = this.dataUrls.keys().next();
      if (oldest.done) return;
      this.evict(oldest.value);
    }
  }

  private clearCache(): void {
    this.dataUrls.clear();
    this.cachedBytes = 0;
  }

  /**
   * Saves a sticker somebody else sent into the local folder (#356 QA). The
   * bytes are fetched from the host that serves the attachment.
   */
  public async saveFromUrl(url: string, fileName: string): Promise<StickerSaveResult> {
    const folder = settingsStore.stickersFolderPath;
    if (!folder) return { ok: false, reason: 'no-folder' };
    if (!window.api?.saveSticker) return { ok: false, reason: 'write-failed' };

    try {
      const response = await fetch(url);
      if (!response.ok) return { ok: false, reason: 'write-failed' };
      const bytes = new Uint8Array(await response.arrayBuffer());
      const result = await window.api.saveSticker(folder, fileName, bytes);
      // The folder listing is now out of date, so force a re-read next time.
      if (result.ok) this.loadedFolder = null;
      return result;
    } catch (e) {
      console.warn('Failed to save sticker:', e);
      return { ok: false, reason: 'write-failed' };
    }
  }

  /** Materializes a sticker as a File so it can go through the upload pipeline. */
  public async toFile(sticker: StickerEntry): Promise<File | null> {
    const dataUrl = await this.getDataUrl(sticker.filePath);
    if (!dataUrl) return null;

    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return new File([bytes], sticker.fileName, { type: sticker.mimeType });
  }

  public reset(): void {
    this.stickers = [];
    this.listingFailed = false;
    this.clearCache();
    this.loadedFolder = null;
    // Invalidates any listing still in flight, which would otherwise resurrect
    // the folder that was just cleared.
    this.loadToken++;
  }
}

export const stickerService = new StickerService();
