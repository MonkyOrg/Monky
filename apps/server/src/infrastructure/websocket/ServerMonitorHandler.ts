import {
  MessageType, Permission, ProtocolErrorCode, serverMonitorGetSchema,
  type ProtocolMessage, type ServerErrorPayload, type ServerMonitorSnapshotPayload,
  type UserSummary,
} from '@monky/shared';
import type { WebSocket } from 'ws';
import type { PermissionService } from '../../application/services/PermissionService';
import type { ServerMonitorService } from '../../application/services/ServerMonitorService';

export interface ServerMonitorSession {
  ws: WebSocket;
  sessionId?: string;
  user?: UserSummary;
  isBot?: boolean;
}

interface ServerMonitorHooks {
  isCurrent(session: ServerMonitorSession): boolean;
  accessVersion(): number;
  send(
    session: ServerMonitorSession,
    message: ProtocolMessage<ServerMonitorSnapshotPayload | ServerErrorPayload>,
  ): void;
}

export class ServerMonitorHandler {
  private inFlight = new WeakSet<ServerMonitorSession>();
  private closed = false;

  constructor(
    private readonly service: ServerMonitorService,
    private readonly permissions: Pick<PermissionService, 'checkPermission' | 'getRoleAccessVersion'>,
    private readonly hooks: ServerMonitorHooks,
  ) {}

  public async handle(session: ServerMonitorSession, payload: unknown, requestId?: string): Promise<void> {
    const { user, sessionId, ws } = session;
    const userId = user?.id;
    const serverId = this.service.serverId;
    const isCurrent = () => !this.closed && this.hooks.isCurrent(session)
      && session.ws === ws && session.user?.id === userId && session.sessionId === sessionId
      && this.service.serverId === serverId;
    const fail = (code: ProtocolErrorCode, message: string) => {
      if (isCurrent()) this.hooks.send(session, {
        type: MessageType.SERVER_ERROR, requestId, payload: { code, message },
      });
    };
    if (!isCurrent()) return;
    if (!user || !userId || !sessionId) {
      fail(ProtocolErrorCode.UNAUTHORIZED, 'Authenticate before opening the server monitor.');
      return;
    }
    if (session.isBot || user.isBot) {
      fail(ProtocolErrorCode.PERMISSION_DENIED, 'Bots cannot view the server monitor.');
      return;
    }
    const parsed = serverMonitorGetSchema.safeParse(payload);
    if (!parsed.success || !requestId || requestId.length > 128) {
      fail(ProtocolErrorCode.BAD_REQUEST, 'Invalid server monitor request.');
      return;
    }
    const request = parsed.data;
    if (request.serverId !== serverId) {
      fail(ProtocolErrorCode.PERMISSION_DENIED, 'This monitor belongs to a different server.');
      return;
    }
    if (this.inFlight.has(session)) {
      fail(ProtocolErrorCode.RATE_LIMITED, 'A monitor request is already in progress.');
      return;
    }
    if (!this.service.allowRequest(userId)) {
      fail(ProtocolErrorCode.RATE_LIMITED, 'Wait a few seconds before refreshing the server monitor.');
      return;
    }
    this.inFlight.add(session);
    try {
      if (!(await this.permissions.checkPermission(userId, Permission.VIEW_SERVER_MONITOR))) {
        fail(ProtocolErrorCode.PERMISSION_DENIED, 'You do not have permission to view the server monitor.');
        return;
      }
      if (!isCurrent()) return;
      if (!this.service.acceptsCursor(request.cursor)) {
        fail(ProtocolErrorCode.BAD_REQUEST, 'Invalid server monitor cursor.');
        return;
      }
      const snapshot = await this.service.getSnapshot(request.cursor);
      if (!isCurrent()) return;
      if (snapshot.serverId !== serverId) throw new Error('The server monitor response binding changed.');
      const version = this.hooks.accessVersion();
      const roleVersion = this.permissions.getRoleAccessVersion();
      if (roleVersion === null) {
        fail(ProtocolErrorCode.PERMISSION_DENIED, 'Server permissions are changing. Open the monitor again.');
        return;
      }
      const allowed = await this.permissions.checkPermission(userId, Permission.VIEW_SERVER_MONITOR);
      if (!isCurrent()) return;
      if (!allowed || version !== this.hooks.accessVersion() || roleVersion !== this.permissions.getRoleAccessVersion()
        || session.isBot || session.user?.isBot) {
        fail(ProtocolErrorCode.PERMISSION_DENIED, 'Server monitor access changed. Open it again if you still have permission.');
        return;
      }
      this.hooks.send(session, {
        type: MessageType.SERVER_MONITOR_SNAPSHOT, requestId, payload: snapshot,
      });
    } finally {
      this.inFlight.delete(session);
    }
  }

  public close(): void {
    this.closed = true;
    this.inFlight = new WeakSet();
  }
}
