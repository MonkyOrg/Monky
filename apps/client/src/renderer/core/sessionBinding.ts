import type { ServerDetails, UserSummary } from '@monky/shared';
import type { NetworkClient } from './NetworkClient';

/** Why a view of a server's data stopped: another server is on screen, or the connection or the member changed. */
export type SessionBindingFailure = 'serverChanged' | 'disconnected';

export interface BoundStore {
  readonly serverDetails: Pick<ServerDetails, 'id'> | null;
  readonly currentUser: Pick<UserSummary, 'id' | 'sessionId' | 'isBot'> | null;
}

/**
 * The server, connection and member a view was opened for (#490). Data of that
 * server never mixes with another's: once any of them changes, the view stops
 * instead of reading on through whatever is current.
 */
export class SessionBinding {
  readonly serverId: string;
  private readonly connectionId: string;
  private readonly userId: string;
  private readonly sessionId: string | undefined;

  constructor(
    private readonly client: Pick<NetworkClient, 'getStatus' | 'getConnectionId'>,
    private readonly store: BoundStore,
    /** Whether the view's server is still the one on screen. */
    private readonly isActive: () => boolean,
  ) {
    this.connectionId = client.getConnectionId();
    this.serverId = store.serverDetails?.id ?? '';
    this.userId = store.currentUser?.id ?? '';
    this.sessionId = store.currentUser?.sessionId;
  }

  /** Why the view must stop, or null while its server, connection and member are the same. */
  failure(): SessionBindingFailure | null {
    if (!this.isActive() || !this.serverId || this.store.serverDetails?.id !== this.serverId) return 'serverChanged';
    const user = this.store.currentUser;
    if (this.client.getStatus() !== 'CONNECTED' || this.client.getConnectionId() !== this.connectionId
      || !this.userId || !this.sessionId || user?.id !== this.userId || user.sessionId !== this.sessionId) {
      return 'disconnected';
    }
    return null;
  }
}

/**
 * The requests of one bound view. Each is retired once it settles, so a late or
 * duplicate frame never reaches an unrelated handler, and `cancel` retires the
 * ones still out when the view closes.
 */
export class BoundRequests {
  private readonly pending = new Set<string>();

  constructor(private readonly client: Pick<NetworkClient, 'cancelRequest'>) {}

  get size(): number {
    return this.pending.size;
  }

  async send<T>(request: (requestId: string) => Promise<T>): Promise<T> {
    const requestId = crypto.randomUUID();
    this.pending.add(requestId);
    try {
      return await request(requestId);
    } finally {
      if (this.pending.delete(requestId)) this.client.cancelRequest(requestId);
    }
  }

  cancel(): void {
    for (const requestId of this.pending) this.client.cancelRequest(requestId);
    this.pending.clear();
  }
}
