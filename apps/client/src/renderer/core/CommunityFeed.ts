import {
  MessageType, communitySnapshotSchema, eventStartedSchema, type CommunitySnapshot,
} from '@monky/shared';
import type { NetworkClient } from './NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { appEvents } from './EventBus';

export interface CommunityStartNotice { title: string; serverName: string }

/** Session-owned snapshots and notifications also run for background servers. */
export class CommunityFeed {
  snapshot: CommunitySnapshot | null = null;
  error = false;
  private readonly listeners = new Set<() => void>();
  private readonly notified = new Set<string>();
  private readonly unbind: () => void;
  private disposed = false;
  private generation = 0;
  private loading = false;
  private reload = false;
  private eventRequest: string | null = null;

  requestOpenEvent(id: string): void {
    if (this.disposed) return;
    this.eventRequest = id;
    this.emit();
  }

  takeEventRequest(): string | null {
    const id = this.eventRequest;
    this.eventRequest = null;
    return id;
  }

  constructor(readonly client: NetworkClient, readonly server: ServerStore) {
    this.unbind = client.onEvent((event, value, requestId) => {
      if (event === 'network.connected') void this.load();
      if (event === 'network.status' && value !== 'CONNECTED') {
        this.generation++;
        this.snapshot = null;
        this.server.communityEventsEnabled = null;
        this.emit();
      }
      if (event === `message.${MessageType.COMMUNITY_SNAPSHOT}`) {
        if (requestId) return;
        const result = communitySnapshotSchema.safeParse(value);
        if (result.success) {
          this.generation++;
          this.snapshot = result.data;
          this.server.communityEventsEnabled = result.data.settings.eventsEnabled;
          this.error = false;
          this.emit();
        } else {
          console.warn('[Community] Invalid server snapshot.', result.error);
          this.error = true;
          this.emit();
        }
      }
      if (event === `message.${MessageType.EVENT_STARTED}`) {
        const result = eventStartedSchema.safeParse(value);
        if (!result.success) { console.warn('[Community] Invalid event notification.', result.error); return; }
        const notice = result.data.event;
        const key = `${notice.id}:${notice.startsAt}`;
        if (!notice.interested || this.notified.has(key)) return;
        this.notified.add(key);
        if (this.notified.size > 500) this.notified.delete(this.notified.values().next().value!);
        appEvents.emit<CommunityStartNotice>('community.event_started', {
          title: notice.title, serverName: server.serverDetails?.name ?? '',
        });
      }
      if ([MessageType.CHANNEL_DELETED, MessageType.CHANNEL_UPDATED, MessageType.CATEGORIES_UPDATED, MessageType.ROLES_LIST]
        .some((type) => event === `message.${type}`)) {
        this.generation++;
        this.snapshot = null;
        this.emit();
        void this.load();
      }
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
    appEvents.emit('community.updated');
  }

  async load(): Promise<void> {
    if (this.disposed || this.client.getStatus() !== 'CONNECTED') return;
    if (this.loading) { this.reload = true; return; }
    this.loading = true;
    const generation = this.generation;
    try {
      const result: unknown = await this.client.sendRequest(MessageType.COMMUNITY_GET, {});
      const parsed = communitySnapshotSchema.parse(result);
      if (this.disposed || generation !== this.generation) return;
      this.snapshot = parsed;
      this.server.communityEventsEnabled = parsed.settings.eventsEnabled;
      this.error = false;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      console.warn('[Community] Could not load server activity.', error);
      this.error = true;
    } finally {
      this.loading = false;
      if (!this.disposed) this.emit();
      if (this.reload) { this.reload = false; void this.load(); }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.unbind();
    this.listeners.clear();
    this.notified.clear();
    this.snapshot = null;
    this.server.communityEventsEnabled = null;
    this.eventRequest = null;
  }
}
