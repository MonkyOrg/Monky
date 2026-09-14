import {
  MessageType, Permission, SERVER_MONITOR_LIMITS, serverMonitorSnapshotSchema,
  type LogEntry, type ServerDetails, type ServerMonitorGetPayload, type ServerMonitorStats, type ServerStats, type UserSummary,
} from '@monky/shared';
import type { ElectronApi } from '../../preload/preload';
import type { NetworkClient } from './NetworkClient';

export type ServerMonitorFailure =
  | 'permissionDenied' | 'disconnected' | 'serverChanged'
  | 'localStopped' | 'localUnavailable' | 'invalidResponse';

export class ServerMonitorError extends Error {
  constructor(public readonly reason: ServerMonitorFailure) {
    super(reason);
    this.name = 'ServerMonitorError';
  }
}

export interface MonitorUpdate {
  stats: ServerMonitorStats;
  entries: LogEntry[];
  replaceLogs: boolean;
  dropped: number;
}

export interface ServerMonitorSource {
  assertCurrent(): void;
  read(): Promise<MonitorUpdate>;
  watch?(invalidate: (error: ServerMonitorError) => void): void;
  dispose(): void;
}

/** One feed per opening. The next poll starts only after the previous one settles. */
export class ServerMonitorFeed {
  private stopped = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: ServerMonitorSource,
    private readonly updated: (update: MonitorUpdate) => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  public async start(): Promise<void> {
    if (this.started) throw new Error('This server monitor feed has already started.');
    this.started = true;
    if (this.stopped) return;
    try {
      this.source.watch?.((error) => this.fail(error));
    } catch (error) {
      this.fail(error);
      return;
    }
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    this.timer = null;
    let update: MonitorUpdate;
    try {
      this.source.assertCurrent();
      update = await this.source.read();
      if (this.stopped) return;
      this.source.assertCurrent();
    } catch (error) {
      if (!this.stopped) this.fail(error);
      return;
    }
    this.updated(update);
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.poll(), SERVER_MONITOR_LIMITS.POLL_INTERVAL_MS);
    }
  }

  public revalidate(): void {
    if (this.stopped) return;
    try {
      this.source.assertCurrent();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stop();
    this.failed(error);
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.source.dispose();
  }
}

type RemoteClient = Pick<NetworkClient, 'getStatus' | 'getConnectionId' | 'cancelRequest'> & {
  sendRequest(
    type: MessageType.SERVER_MONITOR_GET, payload: ServerMonitorGetPayload,
    requestId: string, timeoutMs: number,
  ): Promise<unknown>;
};
interface RemoteStore {
  readonly serverDetails: Pick<ServerDetails, 'id'> | null;
  readonly currentUser: Pick<UserSummary, 'id' | 'sessionId' | 'isBot'> | null;
  hasPermission(permission: Permission): boolean;
}

export class RemoteServerMonitorSource implements ServerMonitorSource {
  private readonly connectionId: string;
  private readonly serverId: string;
  private readonly userId: string;
  private readonly sessionId: string | undefined;
  private cursor: number | undefined;
  private requestId: string | null = null;
  private disposed = false;

  constructor(
    private readonly client: RemoteClient,
    private readonly store: RemoteStore,
    private readonly isActive: () => boolean,
  ) {
    this.connectionId = client.getConnectionId();
    this.serverId = store.serverDetails?.id ?? '';
    this.userId = store.currentUser?.id ?? '';
    this.sessionId = store.currentUser?.sessionId;
  }

  public assertCurrent(): void {
    if (this.disposed) throw new DOMException('Monitor closed', 'AbortError');
    if (!this.isActive() || !this.serverId || this.store.serverDetails?.id !== this.serverId) {
      throw new ServerMonitorError('serverChanged');
    }
    if (this.client.getStatus() !== 'CONNECTED' || this.client.getConnectionId() !== this.connectionId
      || !this.userId || !this.sessionId || this.store.currentUser?.id !== this.userId
      || this.store.currentUser.sessionId !== this.sessionId) {
      throw new ServerMonitorError('disconnected');
    }
    if (this.store.currentUser.isBot || !this.store.hasPermission(Permission.VIEW_SERVER_MONITOR)) {
      throw new ServerMonitorError('permissionDenied');
    }
  }

  public async read(): Promise<MonitorUpdate> {
    this.assertCurrent();
    if (this.requestId) throw new Error('A server monitor request is already in progress.');
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    const cursor = this.cursor;
    const payload: ServerMonitorGetPayload = { serverId: this.serverId, cursor };
    try {
      const result = await this.client.sendRequest(
        MessageType.SERVER_MONITOR_GET, payload, requestId, SERVER_MONITOR_LIMITS.REQUEST_TIMEOUT_MS,
      );
      this.assertCurrent();
      const parsed = serverMonitorSnapshotSchema.safeParse(result);
      if (!parsed.success || parsed.data.serverId !== this.serverId
        || (cursor !== undefined && (parsed.data.cursor < cursor
          || parsed.data.entries.some((entry) => entry.sequence <= cursor)))) {
        throw new ServerMonitorError('invalidResponse');
      }
      this.cursor = parsed.data.cursor;
      return {
        stats: parsed.data.stats, entries: parsed.data.entries,
        dropped: parsed.data.dropped, replaceLogs: cursor === undefined,
      };
    } finally {
      if (this.requestId === requestId) {
        this.requestId = null;
        // Retire timeouts and completed requests too: late frames must not
        // escape into unrelated global message handlers after this view ends.
        this.client.cancelRequest(requestId);
      }
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.requestId) this.client.cancelRequest(this.requestId);
    this.requestId = null;
  }
}

export type LocalMonitorApi = Pick<ElectronApi,
  'hostServerStatus' | 'hostServerStats' | 'hostServerLogs' | 'onHostServerLog' | 'onHostServerStatusChanged'
>;
type LocalStatus = Awaited<ReturnType<LocalMonitorApi['hostServerStatus']>>;

function sameHost(first: LocalStatus, second: LocalStatus): boolean {
  return first.isRunning && second.isRunning && first.serverId === second.serverId && first.port === second.port;
}

function entryKey(entry: LogEntry): string {
  return JSON.stringify([entry.timestamp, entry.level, entry.category, entry.message]);
}

function mergeLocalHistory(history: LogEntry[], buffered: LogEntry[]): LogEntry[] {
  const counts = new Map<string, number>();
  for (const entry of history) {
    const key = entryKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result = [...history];
  for (const entry of buffered) {
    const key = entryKey(entry);
    const remaining = counts.get(key) ?? 0;
    if (remaining) counts.set(key, remaining - 1);
    else result.push(entry);
  }
  return result.slice(-SERVER_MONITOR_LIMITS.HISTORY_ENTRIES);
}

export class LocalServerMonitorSource implements ServerMonitorSource {
  private expected: LocalStatus | null = null;
  private expectedStats: Pick<ServerStats, 'startedAt' | 'dataDir'> | null = null;
  private invalidated = false;
  private disposed = false;
  private statusVersion = 0;
  private initialized = false;
  private pendingEntries: LogEntry[] = [];
  private dropped = 0;
  private cleanup: Array<() => void> = [];

  constructor(private readonly api: LocalMonitorApi | undefined) {}

  public assertCurrent(): void {
    if (this.disposed) throw new DOMException('Monitor closed', 'AbortError');
    if (!this.api) throw new ServerMonitorError('localUnavailable');
    if (this.invalidated) throw new ServerMonitorError('localStopped');
  }

  public watch(invalidate: (error: ServerMonitorError) => void): void {
    this.assertCurrent();
    const api = this.api;
    if (!api) throw new ServerMonitorError('localUnavailable');
    this.cleanup.push(api.onHostServerLog((entry) => {
      if (this.disposed || this.invalidated) return;
      this.pendingEntries.push(entry);
      const excess = this.pendingEntries.length - SERVER_MONITOR_LIMITS.HISTORY_ENTRIES;
      if (excess > 0) {
        this.pendingEntries.splice(0, excess);
        this.dropped += excess;
      }
    }));
    this.cleanup.push(api.onHostServerStatusChanged((status) => {
      if (this.disposed) return;
      this.statusVersion++;
      if (!status.isRunning || (this.expected && !sameHost(this.expected, status))) {
        this.invalidated = true;
        invalidate(new ServerMonitorError('localStopped'));
      }
    }));
  }

  public async read(): Promise<MonitorUpdate> {
    this.assertCurrent();
    const api = this.api;
    if (!api) throw new ServerMonitorError('localUnavailable');
    const version = this.statusVersion;
    const before = await api.hostServerStatus();
    this.assertCurrent();
    if (!before.isRunning || version !== this.statusVersion || (this.expected && !sameHost(this.expected, before))) {
      throw new ServerMonitorError('localStopped');
    }
    this.expected ??= { ...before };
    const initial = !this.initialized;
    const [stats, history] = await Promise.all([
      api.hostServerStats(), initial ? api.hostServerLogs() : Promise.resolve([]),
    ]);
    this.assertCurrent();
    const after = await api.hostServerStatus();
    this.assertCurrent();
    if (!stats || !sameHost(before, after) || version !== this.statusVersion
      || (this.expectedStats && (stats.startedAt !== this.expectedStats.startedAt || stats.dataDir !== this.expectedStats.dataDir))) {
      throw new ServerMonitorError('localStopped');
    }
    this.expectedStats ??= { startedAt: stats.startedAt, dataDir: stats.dataDir };
    const buffered = this.pendingEntries.splice(0);
    const entries = initial
      ? mergeLocalHistory(history.slice(-SERVER_MONITOR_LIMITS.HISTORY_ENTRIES), buffered)
      : buffered;
    const dropped = this.dropped;
    this.dropped = 0;
    this.initialized = true;
    return { stats, entries, dropped, replaceLogs: initial };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.pendingEntries = [];
  }
}
