import {
  MessageType, Permission, ProtocolErrorCode, SERVER_AUDIT_LIMITS, serverAuditPageSchema,
  type ServerAuditGetPayload, type ServerAuditPagePayload, type ServerDetails, type UserSummary,
} from '@monky/shared';
import { ProtocolRequestError, type NetworkClient } from './NetworkClient';

export type ServerAuditFailure = 'permissionDenied' | 'disconnected' | 'serverChanged' | 'updateRequired' | 'invalidResponse';

export class ServerAuditError extends Error {
  constructor(public readonly reason: ServerAuditFailure) {
    super(reason);
    this.name = 'ServerAuditError';
  }
}

/** Revoking access, losing the connection or switching servers ends the view; anything else can be retried. */
export function endsServerAudit(error: unknown): boolean {
  return error instanceof ServerAuditError && error.reason !== 'invalidResponse';
}

type AuditClient = Pick<NetworkClient, 'getStatus' | 'getConnectionId' | 'cancelRequest'> & {
  sendRequest(type: MessageType.SERVER_AUDIT_GET, payload: ServerAuditGetPayload, requestId: string, timeoutMs: number): Promise<unknown>;
};

export interface ServerAuditStore {
  readonly serverDetails: Pick<ServerDetails, 'id' | 'protocol'> | null;
  readonly currentUser: Pick<UserSummary, 'id' | 'sessionId' | 'isBot'> | null;
  hasPermission(permission: Permission): boolean;
}

/** Whether the menu may offer the audit log: a connected human with the permission, on a server that has it. */
export function canOpenServerAudit(store: ServerAuditStore, connected: boolean): boolean {
  return connected && !!store.currentUser && !store.currentUser.isBot
    && store.serverDetails?.protocol?.features.includes('server-audit') === true
    && store.hasPermission(Permission.VIEW_AUDIT_LOG);
}

export type ServerAuditQuery = Omit<ServerAuditGetPayload, 'serverId'>;

/** Reads pages for one server, connection and member; any change makes it refuse instead of mixing logs. */
export class ServerAuditSource {
  private readonly connectionId: string;
  private readonly serverId: string;
  private readonly userId: string;
  private readonly sessionId: string | undefined;
  private readonly pending = new Set<string>();
  private disposed = false;

  constructor(
    private readonly client: AuditClient,
    private readonly store: ServerAuditStore,
    private readonly isActive: () => boolean,
  ) {
    this.connectionId = client.getConnectionId();
    this.serverId = store.serverDetails?.id ?? '';
    this.userId = store.currentUser?.id ?? '';
    this.sessionId = store.currentUser?.sessionId;
  }

  public get server(): string {
    return this.serverId;
  }

  public assertCurrent(): void {
    if (this.disposed) throw new DOMException('Audit log closed', 'AbortError');
    if (!this.isActive() || !this.serverId || this.store.serverDetails?.id !== this.serverId) {
      throw new ServerAuditError('serverChanged');
    }
    if (this.client.getStatus() !== 'CONNECTED' || this.client.getConnectionId() !== this.connectionId
      || !this.userId || !this.sessionId || this.store.currentUser?.id !== this.userId
      || this.store.currentUser.sessionId !== this.sessionId) {
      throw new ServerAuditError('disconnected');
    }
    if (!this.store.serverDetails?.protocol?.features.includes('server-audit')) throw new ServerAuditError('updateRequired');
    if (this.store.currentUser.isBot || !this.store.hasPermission(Permission.VIEW_AUDIT_LOG)) {
      throw new ServerAuditError('permissionDenied');
    }
  }

  public async read(query: ServerAuditQuery = {}): Promise<ServerAuditPagePayload> {
    this.assertCurrent();
    const requestId = crypto.randomUUID();
    this.pending.add(requestId);
    try {
      let result: unknown;
      try {
        result = await this.client.sendRequest(
          MessageType.SERVER_AUDIT_GET, { ...query, serverId: this.serverId }, requestId, SERVER_AUDIT_LIMITS.REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof ProtocolRequestError) {
          if (error.code === ProtocolErrorCode.PERMISSION_DENIED || error.code === ProtocolErrorCode.UNAUTHORIZED) {
            throw new ServerAuditError('permissionDenied');
          }
          if (error.code === ProtocolErrorCode.FEATURE_REQUIRES_UPDATE) throw new ServerAuditError('updateRequired');
        }
        throw error;
      }
      this.assertCurrent();
      const parsed = serverAuditPageSchema.safeParse(result);
      const { before, after } = query;
      if (!parsed.success || parsed.data.serverId !== this.serverId
        || parsed.data.entries.some((entry) => (before !== undefined && entry.id >= before) || (after !== undefined && entry.id <= after))) {
        throw new ServerAuditError('invalidResponse');
      }
      return parsed.data;
    } finally {
      if (this.pending.delete(requestId)) this.client.cancelRequest(requestId);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const requestId of this.pending) this.client.cancelRequest(requestId);
    this.pending.clear();
  }
}
