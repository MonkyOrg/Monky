import {
  MessageType, Permission, ProtocolErrorCode, SERVER_AUDIT_LIMITS, serverAuditPageSchema,
  type ServerAuditGetPayload, type ServerAuditPagePayload, type ServerDetails, type UserSummary,
} from '@monky/shared';
import { ProtocolRequestError, type NetworkClient } from './NetworkClient';
import { BoundRequests, SessionBinding, type SessionBindingFailure } from './sessionBinding';

export type ServerAuditFailure = SessionBindingFailure | 'permissionDenied' | 'updateRequired' | 'unavailable' | 'invalidResponse';

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
  private readonly binding: SessionBinding;
  private readonly requests: BoundRequests;
  private disposed = false;

  constructor(
    private readonly client: AuditClient,
    private readonly store: ServerAuditStore,
    isActive: () => boolean,
  ) {
    this.binding = new SessionBinding(client, store, isActive);
    this.requests = new BoundRequests(client);
  }

  public get server(): string {
    return this.binding.serverId;
  }

  public assertCurrent(): void {
    if (this.disposed) throw new DOMException('Audit log closed', 'AbortError');
    const lost = this.binding.failure();
    if (lost) throw new ServerAuditError(lost);
    if (!this.store.serverDetails?.protocol?.features.includes('server-audit')) throw new ServerAuditError('updateRequired');
    if (this.store.currentUser?.isBot || !this.store.hasPermission(Permission.VIEW_AUDIT_LOG)) {
      throw new ServerAuditError('permissionDenied');
    }
  }

  public async read(query: ServerAuditQuery = {}): Promise<ServerAuditPagePayload> {
    this.assertCurrent();
    const result = await this.requests.send(async (requestId) => {
      try {
        return await this.client.sendRequest(
          MessageType.SERVER_AUDIT_GET, { ...query, serverId: this.binding.serverId }, requestId, SERVER_AUDIT_LIMITS.REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof ProtocolRequestError) {
          if (error.code === ProtocolErrorCode.PERMISSION_DENIED || error.code === ProtocolErrorCode.UNAUTHORIZED) {
            throw new ServerAuditError('permissionDenied');
          }
          if (error.code === ProtocolErrorCode.FEATURE_REQUIRES_UPDATE) throw new ServerAuditError('updateRequired');
          if (error.code === ProtocolErrorCode.FEATURE_UNAVAILABLE) throw new ServerAuditError('unavailable');
        }
        throw error;
      }
    });
    this.assertCurrent();
    const parsed = serverAuditPageSchema.safeParse(result);
    const { before, after } = query;
    if (!parsed.success || parsed.data.serverId !== this.binding.serverId
      || parsed.data.entries.some((entry) => (before !== undefined && entry.id >= before) || (after !== undefined && entry.id <= after))) {
      throw new ServerAuditError('invalidResponse');
    }
    return parsed.data;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requests.cancel();
  }
}
