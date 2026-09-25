import type { DesktopSource, DesktopSourcePreview, DesktopSourcePreviewsRequest } from '@monky/shared';

const CACHE_TTL_MS = 10_000;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 256;

export class DesktopSourcePreviews {
  private readonly cache = new Map<string, { preview: DesktopSourcePreview; expires: number; bytes: number }>();
  private readonly pending = new Map<DesktopSource['type'], Promise<DesktopSource[]>>();
  private bytes = 0;
  private generation = 0;

  constructor(private readonly load: (type: DesktopSource['type']) => Promise<DesktopSource[]>,
    private readonly now: () => number = Date.now) {}

  clear(): void {
    this.cache.clear();
    this.bytes = 0;
    this.generation++;
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
    const cached = request.sourceIds.map(id => this.cached(id));
    if (cached.every((preview): preview is DesktopSourcePreview => preview !== undefined)) return cached;
    let work = this.pending.get(request.type);
    if (!work) {
      const generation = this.generation;
      work = this.load(request.type).then(sources => {
        if (generation === this.generation)
          for (const source of sources) if (source.type === request.type) this.remember(source);
        return sources;
      });
      this.pending.set(request.type, work);
      const retire = (): void => { if (this.pending.get(request.type) === work) this.pending.delete(request.type); };
      void work.then(retire, retire);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sources = await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Desktop source preview loading timed out.')), 15_000);
      })]);
      const byId = new Map(sources.filter(source => source.type === request.type).map(source => [source.id, source]));
      return request.sourceIds.flatMap(id => {
        const source = byId.get(id);
        return source ? [{ id, thumbnailDataUrl: source.thumbnailDataUrl, appIconDataUrl: source.appIconDataUrl }] : [];
      });
    } finally { clearTimeout(timer); }
  }
}
