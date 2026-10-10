import {
  MessageType, Permission, ProtocolErrorCode, serverAuditGetSchema,
  type ProtocolMessage, type ServerAuditPagePayload, type ServerErrorPayload, type UserSummary,
} from '@monky/shared';
import type { WebSocket } from 'ws';
import type { PermissionService } from '../../application/services/PermissionService';
import type { ServerAuditService } from '../../application/services/ServerAuditService';

export interface ServerAuditSession {
  ws: WebSocket;
  sessionId?: string;
  user?: UserSummary;
  isBot?: boolean;
}

interface ServerAuditHooks {
  isCurrent(session: ServerAuditSession): boolean;
  send(session: ServerAuditSession, message: ProtocolMessage<ServerAuditPagePayload | ServerErrorPayload>): void;
}

export class ServerAuditHandler {
  private closed = false;

  constructor(
    private readonly service: ServerAuditService,
    private readonly permissions: Pick<PermissionService, 'checkPermission' | 'getRoleAccessVersion'>,
    private readonly hooks: ServerAuditHooks,
  ) {}

  public async handle(session: ServerAuditSession, payload: unknown, requestId?: string): Promise<void> {
    const { user, sessionId, ws } = session;
    const userId = user?.id;
    const isCurrent = () => !this.closed && this.hooks.isCurrent(session)
      && session.ws === ws && session.user?.id === userId && session.sessionId === sessionId;
    const fail = (code: ProtocolErrorCode, message: string) => {
      if (isCurrent()) this.hooks.send(session, { type: MessageType.SERVER_ERROR, requestId, payload: { code, message } });
    };
    if (!isCurrent()) return;
    if (!user || !userId || !sessionId) {
      fail(ProtocolErrorCode.UNAUTHORIZED, 'Authenticate before opening the audit log.');
      return;
    }
    if (session.isBot || user.isBot) {
      fail(ProtocolErrorCode.PERMISSION_DENIED, 'Bots cannot view the audit log.');
      return;
    }
    const parsed = serverAuditGetSchema.safeParse(payload);
    if (!parsed.success || !requestId || requestId.length > 128) {
      fail(ProtocolErrorCode.BAD_REQUEST, 'Invalid audit log request.');
      return;
    }
    if (parsed.data.serverId !== this.service.serverId) {
      fail(ProtocolErrorCode.PERMISSION_DENIED, 'This audit log belongs to a different server.');
      return;
    }
    if (!this.service.allowRequest(userId)) {
      fail(ProtocolErrorCode.RATE_LIMITED, 'Wait a few seconds before refreshing the audit log.');
      return;
    }
    const roleVersion = this.permissions.getRoleAccessVersion();
    if (roleVersion === null) {
      fail(ProtocolErrorCode.PERMISSION_DENIED, 'Server permissions are changing. Open the audit log again.');
      return;
    }
    const allowed = await this.permissions.checkPermission(userId, Permission.VIEW_AUDIT_LOG);
    if (!isCurrent()) return;
    // Reading the page is synchronous, so nothing can revoke access between this check and the reply.
    if (!allowed || roleVersion !== this.permissions.getRoleAccessVersion() || session.isBot || session.user?.isBot) {
      fail(ProtocolErrorCode.PERMISSION_DENIED, 'You do not have permission to view the audit log.');
      return;
    }
    this.hooks.send(session, { type: MessageType.SERVER_AUDIT_PAGE, requestId, payload: this.service.list(parsed.data) });
  }

  public close(): void {
    this.closed = true;
  }
}
