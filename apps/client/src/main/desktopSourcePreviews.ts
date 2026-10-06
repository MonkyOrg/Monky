import type { DesktopSource, DesktopSourcePreview, DesktopSourcePreviewsRequest } from '@monky/shared';

const CACHE_TTL_MS = 10_000;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 256;

export class DesktopSourcePreviews {
  private readonly cache = new Map<string, { preview: DesktopSourcePreview; expires: number; bytes: number }>();
  private readonly pending = new Map<DesktopSource['type'], {
    work: Promise<DesktopSource[]>; ids: ReadonlySet<string>; abort: AbortController;
  }>();
  private bytes = 0;
  private generation = 0;
  private disposed = false;

  constructor(private readonly load: (type: DesktopSource['type'], sourceIds: readonly string[], signal: AbortSignal) => Promise<DesktopSource[]>,
    private readonly now: () => number = Date.now) {}

  clear(): void {
    this.cache.clear();
    this.bytes = 0;
    this.generation++;
    for (const pending of this.pending.values()) pending.abort.abort();
  }

  async cancel(): Promise<void> {
    this.clear();
    await Promise.allSettled([...this.pending.values()].map(pending => pending.work));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
  }

  cached(id: string): DesktopSourcePreview | undefined {
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.cache.delete(id);
      this.bytes -= entry.bytes;
      return undefined;
    }
    return { ...entry.preview };
  }

  private remember(source: DesktopSource): void {
    if (!source.thumbnailDataUrl) return;
    const preview = { id: source.id, thumbnailDataUrl: source.thumbnailDataUrl, appIconDataUrl: source.appIconDataUrl };
    const bytes = 2 * (preview.id.length + preview.thumbnailDataUrl.length + (preview.appIconDataUrl?.length ?? 0));
    const previous = this.cache.get(preview.id);
    if (previous) { this.cache.delete(preview.id); this.bytes -= previous.bytes; }
    if (bytes > CACHE_MAX_BYTES) return;
    while (this.cache.size && (this.cache.size >= CACHE_MAX_ENTRIES || this.bytes + bytes > CACHE_MAX_BYTES)) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(preview.id, { preview, expires: this.now() + CACHE_TTL_MS, bytes });
    this.bytes += bytes;
  }

  async get(request: DesktopSourcePreviewsRequest): Promise<DesktopSourcePreview[]> {
    if (this.disposed) throw new DOMException('Desktop previews are shutting down.', 'AbortError');
    const cached = request.sourceIds.map(id => this.cached(id));
    if (cached.every((preview): preview is DesktopSourcePreview => preview !== undefined)) return cached;
    let pending = this.pending.get(request.type);
    if (pending?.abort.signal.aborted) {
      // The cancelled caller still receives its error. A new request waits for
      // its original capture owner to finish before retrying.
      await Promise.allSettled([pending.work]);
      return this.get(request);
    }
    if (!pending) {
      const generation = this.generation;
      const abort = new AbortController();
      const ids = request.sourceIds.filter((_, index) => !cached[index]);
      const work = this.load(request.type, ids, abort.signal).then(sources => {
        if (generation === this.generation)
          for (const source of sources) if (source.type === request.type) this.remember(source);
        return sources;
      });
      pending = { work, ids: new Set(ids), abort };
      this.pending.set(request.type, pending);
      const retire = (): void => { if (this.pending.get(request.type)?.work === work) this.pending.delete(request.type); };
      void work.then(retire, retire);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const active = pending;
      const sources = await Promise.race([active.work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          active.abort.abort();
          reject(new Error('Desktop source preview loading timed out.'));
        }, 15_000);
      })]);
      const byId = new Map(sources.filter(source => source.type === request.type).map(source => [source.id, source]));
      if (request.sourceIds.some((id, index) => !cached[index] && !byId.has(id) && !active.ids.has(id)))
        return this.get(request);
      return request.sourceIds.flatMap(id => {
        const previous = this.cached(id);
        if (previous) return [previous];
        const source = byId.get(id);
        return source ? [{ id, thumbnailDataUrl: source.thumbnailDataUrl, appIconDataUrl: source.appIconDataUrl }] : [];
      });
    } finally { clearTimeout(timer); }
  }
}
