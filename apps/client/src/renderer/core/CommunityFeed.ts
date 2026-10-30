import {
  MessageType, communitySnapshotSchema, eventStartedSchema, nativePollSchema, survivingNativePollSelection,
  type CommunitySnapshot, type NativePoll,
} from '@monky/shared';
import type { NetworkClient } from './NetworkClient';
import { accessSignature, type ServerStore } from '../stores/serverStore';
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
  /** Access the shown snapshot was fetched with (see `accessSignature`). */
  private access = '';
  private loading = false;
  private reload = false;
  private eventRequest: string | null = null;
  /** What the last `community.updated` announced; see `emit`. */
  private summary = '';

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
          this.snapshot = this.keepNewerPolls(result.data);
          this.access = accessSignature(this.server);
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
        appEvents.emit('community.event_started', {
          title: notice.title, serverName: server.serverDetails?.name ?? '',
        });
      }
      if (event === `message.${MessageType.POLL_UPDATED}`) {
        const result = nativePollSchema.safeParse(value);
        if (result.success) this.applyPoll(result.data);
      }
      if ([MessageType.CHANNEL_DELETED, MessageType.CHANNEL_UPDATED, MessageType.CATEGORIES_UPDATED, MessageType.ROLES_LIST]
        .some((type) => event === `message.${type}`)) {
        // Stores already applied the change. With the same access, the shown snapshot is still
        // the one the server would send (#842); lost access must clear what is shown at once.
        const access = accessSignature(this.server);
        if (this.snapshot !== null && access === this.access) return;
        this.access = access;
        this.generation++;
        this.snapshot = null;
        this.emit();
        void this.load();
      }
    });
  }

  /**
   * A vote changes one poll: the live-action banner and lists take it from here instead of
   * waiting for a whole snapshot. The broadcast carries no personal vote, so the one shown stays.
   */
  private applyPoll(poll: NativePoll): void {
    const snapshot = this.snapshot;
    const index = snapshot?.polls.findIndex(entry => entry.id === poll.id) ?? -1;
    if (!snapshot || index < 0 || poll.revision < snapshot.polls[index].revision) return;
    const shown = snapshot.polls[index];
    this.snapshot = { ...snapshot, polls: snapshot.polls.map(entry => entry !== shown ? entry : {
      ...poll, myVoteOptionIds: poll.myVoteOptionIds ?? survivingNativePollSelection(poll, shown.myVoteOptionIds),
    }) };
    this.emit();
  }

  /** A snapshot fetched before a vote arrived keeps the newer poll the vote brought. */
  private keepNewerPolls(next: CommunitySnapshot): CommunitySnapshot {
    const shown = new Map((this.snapshot?.polls ?? []).map(poll => [poll.id, poll]));
    return { ...next, polls: next.polls.map(poll => {
      const newer = shown.get(poll.id);
      return newer && newer.revision > poll.revision ? newer : poll;
    }) };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Views of this feed hear every snapshot through `subscribe`. The app-wide
   * `community.updated` reaches surfaces outside it — the server rail's call icon
   * and the poll wizard's live-action switch — for any connected server, so it is
   * only raised when what they read changes, never for each vote or response.
   */
  private emit(): void {
    for (const listener of this.listeners) listener();
    const summary = JSON.stringify([this.server.communityEventsEnabled, (this.snapshot?.events ?? [])
      .flatMap(event => event.status === 'active' && event.location.kind === 'voice' ? [event.location.channelId] : [])
      .sort()]);
    if (summary === this.summary) return;
    this.summary = summary;
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
      this.snapshot = this.keepNewerPolls(parsed);
      this.access = accessSignature(this.server);
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
