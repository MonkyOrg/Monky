import {
  EVENT_HISTORY_PAGE_SIZE, MessageType, communitySnapshotSchema, eventHistoryResultSchema,
  type EventHistoryCursor, type EventHistoryRequest, type EventHistoryResult, type ServerEventPublic,
} from '@monky/shared';
import type { CommunityFeed } from './CommunityFeed';
import { t } from '../i18n';
import { reportError } from '../utils/feedback';

/** Owns only the history the person has read, not the pushed current events. */
export class EventHistory {
  static readonly REFRESH_INTERVAL_MS = 1000;
  static readonly REQUEST_INTERVAL_MS = 400;
  entries: ServerEventPublic[] = [];
  enabled = false;
  loading = false;
  failed = false;
  more = false;
  private cursor: EventHistoryCursor | null = null;
  private generation = 0;
  private requestId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseWait: (() => void) | undefined;
  private refreshPending = false;
  private headPending = false;
  private busy = false;
  private fetchedAt = -Infinity;
  private requestedAt = -Infinity;

  constructor(
    private readonly feed: CommunityFeed,
    private readonly signal: AbortSignal,
    private readonly changed: () => void,
    private readonly forgetEvent: (id: string) => void,
  ) {
    signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  get paginated(): boolean {
    return this.feed.server.serverDetails?.protocol?.features.includes('event-history-cursor') === true;
  }

  start(): void {
    this.stop();
    if (this.signal.aborted) return;
    this.enabled = true;
    this.more = true;
    void this.loadMore();
  }

  stop(): void {
    this.generation++;
    this.enabled = false;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.waitTimer);
    this.refreshTimer = this.waitTimer = undefined;
    this.releaseWait?.();
    this.releaseWait = undefined;
    if (this.requestId) this.feed.client.cancelRequest(this.requestId);
    this.requestId = null;
    this.refreshPending = this.headPending = this.busy = this.loading = this.failed = this.more = false;
    this.cursor = null;
    this.entries = [];
  }

  forget(id: string): void {
    this.entries = this.entries.filter(event => event.id !== id);
  }

  private merge(events: readonly ServerEventPublic[]): void {
    const current = new Set(this.feed.snapshot?.events.map(event => event.id));
    this.entries = [...new Map([...this.entries, ...events].map(event => [event.id, event])).values()]
      .filter(event => !current.has(event.id) && (event.status === 'ended' || event.status === 'cancelled'))
      .sort((a, b) => b.startsAt - a.startsAt || a.id.localeCompare(b.id));
  }

  private async request(input: EventHistoryRequest, generation: number): Promise<EventHistoryResult | null> {
    const delay = Math.max(0, this.requestedAt + EventHistory.REQUEST_INTERVAL_MS - performance.now());
    if (delay) await new Promise<void>(resolve => {
      this.releaseWait = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = undefined;
        this.releaseWait = undefined;
        resolve();
      }, delay);
    });
    if (this.signal.aborted || generation !== this.generation) return null;
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.requestedAt = performance.now();
    try {
      const response: unknown = this.paginated
        ? await this.feed.client.sendRequest(MessageType.EVENT_HISTORY_GET, input, requestId)
        : await this.feed.client.sendRequest(MessageType.COMMUNITY_GET, { includeEnded: true }, requestId);
      if (this.signal.aborted || generation !== this.generation) return null;
      return this.paginated ? eventHistoryResultSchema.parse(response)
        : { events: communitySnapshotSchema.parse(response).events, nextCursor: null };
    } finally { if (this.requestId === requestId) this.requestId = null; }
  }

  async loadMore(): Promise<void> {
    if (!this.enabled || this.busy || !this.more || this.signal.aborted) return;
    const generation = this.generation;
    this.busy = this.loading = true;
    this.failed = false;
    this.changed();
    try {
      const result = await this.request({ ...(this.cursor ? { after: this.cursor } : {}), limit: EVENT_HISTORY_PAGE_SIZE }, generation);
      if (!result) return;
      this.merge(result.events);
      this.cursor = result.nextCursor;
      this.more = result.nextCursor !== null;
      this.fetchedAt = performance.now();
    } catch (error) {
      if (generation !== this.generation || this.signal.aborted) return;
      this.failed = true;
      reportError(t('community.historyLoadError'), { log: 'NETWORK', error });
    } finally { this.finish(generation); }
  }

  /** A pushed snapshot revalidates only loaded ids; an event leaving it may have just ended. */
  scheduleRefresh(head = false): void {
    if (!this.enabled || this.signal.aborted) return;
    this.refreshPending = true;
    this.headPending ||= head;
    if (this.busy || this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, Math.max(0, this.fetchedAt + EventHistory.REFRESH_INTERVAL_MS - performance.now()));
  }

  private async refresh(): Promise<void> {
    const generation = this.generation;
    const head = this.headPending;
    this.refreshPending = this.headPending = false;
    this.busy = true;
    this.fetchedAt = performance.now();
    try {
      const ids = this.entries.map(event => event.id);
      if (!this.paginated) {
        const result = await this.request({}, generation);
        if (!result) return;
        const listed = new Set(result.events.map(event => event.id));
        for (const id of ids) if (!listed.has(id)) this.forgetEvent(id);
        this.entries = [];
        this.merge(result.events);
      } else {
        for (let offset = 0; offset < ids.length; offset += EVENT_HISTORY_PAGE_SIZE) {
          const batch = ids.slice(offset, offset + EVENT_HISTORY_PAGE_SIZE);
          const result = await this.request({ ids: batch }, generation);
          if (!result) return;
          const listed = new Set(result.events.map(event => event.id));
          for (const id of batch) if (!listed.has(id)) this.forgetEvent(id);
          this.merge(result.events);
          this.changed();
        }
        if (head || !ids.length) {
          const result = await this.request({ limit: EVENT_HISTORY_PAGE_SIZE }, generation);
          if (!result) return;
          const empty = !this.entries.length;
          this.merge(result.events);
          // A refresh of the head does not rewind the cursor of pages already read.
          if (empty) this.cursor = result.nextCursor;
          this.more = empty ? result.nextCursor !== null : this.more || result.nextCursor !== null;
        }
      }
      this.failed = false;
    } catch (error) {
      if (generation !== this.generation || this.signal.aborted) return;
      reportError(t('community.historyLoadError'), { log: 'NETWORK', error });
    } finally { this.finish(generation); }
  }

  private finish(generation: number): void {
    if (generation !== this.generation || this.signal.aborted) return;
    this.busy = this.loading = false;
    this.changed();
    if (this.refreshPending) this.scheduleRefresh();
  }
}
