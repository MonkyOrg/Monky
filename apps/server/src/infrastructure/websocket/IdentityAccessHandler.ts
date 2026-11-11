import type { WebSocket } from 'ws';
import {
  MessageType, Permission, ProtocolErrorCode, identityBanHistoryRequestSchema, identityBanSchema, identitySessionDisconnectSchema, identityUnbanSchema,
  type IdentityBanRequest, type ServerMessage,
} from '@monky/shared';
import type { AuthService } from '../../application/services/AuthService';
import type { UserService } from '../../application/services/UserService';
import type { PermissionService } from '../../application/services/PermissionService';
import type { AttachmentService } from '../../application/services/AttachmentService';
import { identityBanNotice } from '../../domain/identityAccess';
import type { AccessEpoch } from './access/AccessEpoch';
import type { ClientSession, SignedInSession } from './ClientSession';
import type { RoleHandler } from './RoleHandler';
import type { VoiceSessionHandler } from './voice/VoiceSessionHandler';
import { route, type Route } from './routing/MessageRouter';
import type { AuditRecorder } from './AuditRecorder';
import { auditRef } from '../../application/services/ServerAuditService';

export interface IdentityAccessHost {
  readonly auth: AuthService;
  readonly users: UserService;
  readonly permissions: PermissionService;
  readonly attachments: AttachmentService;
  readonly epoch: AccessEpoch;
  readonly auditLog: AuditRecorder;
  readonly roleAdmin: Pick<RoleHandler, 'broadcastState'>;
  readonly voiceSessions: Pick<VoiceSessionHandler, 'endVoiceSession'>;
  sessionsOfUser(userId: string): ClientSession[];
  isCurrentSession(session: ClientSession): boolean;
  disconnectSession(session: ClientSession): void;
  closeSessionsOfUser(userId: string): number;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcast(message: ServerMessage, ignoreWs?: WebSocket): void;
}

/** Personal sessions never reveal another identity's device ids; bans are server administration. */
export class IdentityAccessHandler {
  constructor(private readonly host: IdentityAccessHost) {}

  routes(): Route[] {
    const feature = (name: string) => ({
      when: (session: ClientSession) => !session.protocol?.features.includes(name),
      message: 'Atualize o Monky para usar este recurso.',
    });
    const storage = { available: () => !!this.host.auth?.identityAccess, message: 'Moderação de identidade indisponível.' };
    return [
      route({ types: [MessageType.IDENTITY_SESSIONS_GET], unavailable: feature('identity-sessions'),
        handle: ({ session, requestId }) => this.sessions(session, requestId) }),
      route({ types: [MessageType.IDENTITY_SESSION_DISCONNECT], unavailable: feature('identity-sessions'),
        schema: { type: identitySessionDisconnectSchema, message: 'Sessão inválida.' },
        handle: ({ session, payload, requestId }) => {
          const target = this.host.sessionsOfUser(session.user.id).find(s => s.sessionId === payload.sessionId);
          if (!target || target.isBot) {
            this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Sessão não está mais conectada.', requestId);
            return;
          }
          const message: ServerMessage<MessageType.IDENTITY_SESSION_DISCONNECTED> = {
            type: MessageType.IDENTITY_SESSION_DISCONNECTED, requestId, payload: { sessionId: payload.sessionId },
          };
          this.host.send(session.ws, message);
          this.host.send(target.ws, { ...message, requestId: undefined });
          this.host.disconnectSession(target);
        } }),
      route({ types: [MessageType.IDENTITY_BAN], unavailable: feature('identity-bans'), service: storage,
        schema: { type: identityBanSchema, message: 'Informe identidade, justificativa e duração válidas.' },
        permission: Permission.MANAGE_SERVER,
        handle: ({ session, payload, requestId }) => this.ban(session, payload, requestId) }),
      route({ types: [MessageType.IDENTITY_BANS_GET], unavailable: feature('identity-bans'), service: storage,
        permission: Permission.MANAGE_SERVER, handle: ({ session, requestId }) => this.bans(session, requestId) }),
      route({ types: [MessageType.IDENTITY_BAN_HISTORY_GET], unavailable: feature('identity-ban-history'), service: storage,
        schema: { type: identityBanHistoryRequestSchema, message: 'Consulta de banimentos inválida.' },
        permission: Permission.MANAGE_SERVER, handle: ({ session, payload, requestId }) => {
          if (!this.host.isCurrentSession(session)) return;
          this.host.send(session.ws, { type: MessageType.IDENTITY_BAN_HISTORY, requestId,
            payload: this.host.auth.identityAccess!.history(payload) });
        } }),
      route({ types: [MessageType.IDENTITY_UNBAN], unavailable: feature('identity-bans'), service: storage,
        schema: { type: identityUnbanSchema, message: 'Identidade inválida.' }, permission: Permission.MANAGE_SERVER,
        handle: async ({ session, payload, requestId }) => {
          const epoch = this.host.epoch.channels();
          const allowed = await this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_SERVER);
          if (!this.host.isCurrentSession(session)) return;
          if (!allowed || epoch === null || epoch !== this.host.epoch.channels()) {
            this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'As permissões mudaram. Tente novamente.', requestId);
            return;
          }
          const ban = this.host.auth.identityAccess!.ban(payload.publicKey);
          let revoked = false;
          await this.host.epoch.change(async () => {
            if (!this.host.isCurrentSession(session)) return;
            revoked = this.host.auth.identityAccess!.unban(payload.publicKey,
              { id: session.user.id, nickname: session.user.nickname }, payload.banId);
          });
          if (!this.host.isCurrentSession(session)) return;
          if (!revoked) {
            this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'O banimento mudou ou não está mais disponível. Atualize a lista.', requestId);
            return;
          }
          if (ban) this.host.auditLog.record(session, 'member.unban', { target: auditRef.user(ban.publicKey, ban.nickname) });
          await this.host.roleAdmin.broadcastState();
          const replyEpoch = this.host.epoch.channels();
          const mayRead = await this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_SERVER);
          if (!this.host.isCurrentSession(session)) return;
          if (!mayRead || replyEpoch === null || replyEpoch !== this.host.epoch.channels()) {
            this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'As permissões mudaram. Atualize a lista.', requestId);
            return;
          }
          this.bans(session, requestId);
        } }),
    ];
  }

  private sessions(session: SignedInSession, requestId?: string): void {
    this.host.send(session.ws, { type: MessageType.IDENTITY_SESSIONS, requestId, payload: {
      sessions: this.host.sessionsOfUser(session.user.id)
        .filter(s => !s.isBot && !!s.sessionId && this.host.isCurrentSession(s))
        .map(s => ({
          sessionId: s.sessionId!, deviceId: s.sessionId!.slice(`${session.user.id}:`.length),
          connectedAt: s.user?.connectedAt ?? 0, current: s === session,
        })),
    } });
  }

  private bans(session: SignedInSession, requestId?: string): void {
    if (!this.host.isCurrentSession(session)) return;
    const bans = this.host.auth.identityAccess!.bans().filter(b => b.expiresAt === null || b.expiresAt > Date.now());
    this.host.send(session.ws, { type: MessageType.IDENTITY_BANS, requestId, payload: { bans } });
  }

  private async ban(session: SignedInSession, input: IdentityBanRequest, requestId?: string): Promise<void> {
    const epoch = this.host.epoch.channels();
    const target = await this.host.users.member(input.targetUserId);
    const owner = await this.host.permissions.isOwner(input.targetUserId);
    if (!this.host.isCurrentSession(session)) return;
    if (epoch === null || epoch !== this.host.epoch.channels()) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'As permissões mudaram. Tente novamente.', requestId);
      return;
    }
    if (!target?.publicKey || owner || target.id === session.user.id) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Não é possível banir esta identidade.', requestId);
      return;
    }
    const now = Date.now();
    const ban = { publicKey: target.publicKey, nickname: target.nickname, reason: input.reason,
      showReason: input.showReason, createdAt: now,
      expiresAt: input.durationSeconds === null ? null : now + input.durationSeconds * 1000 };
    await this.host.epoch.change(async () => {
      this.host.auth.identityAccess!.saveBan(ban, { id: session.user.id, nickname: session.user.nickname });
      this.host.auditLog.record(session, 'member.ban', { target: auditRef.user(target.id, target.nickname) });
      const targets = this.host.sessionsOfUser(target.id);
      for (const peer of targets) peer.replaced = true;
      this.host.attachments.revokeTokensForUser(target.id);
      for (const peer of targets) {
        if (peer.sessionId) this.host.voiceSessions.endVoiceSession(peer.sessionId);
        if (peer.protocol?.features.includes('identity-bans')) {
          this.host.send(peer.ws, { type: MessageType.IDENTITY_BANNED, payload: identityBanNotice(ban) });
        } else {
          this.host.send(peer.ws, { type: MessageType.MEMBER_KICKED, payload: { userId: target.id, nickname: target.nickname } });
        }
      }
      this.host.closeSessionsOfUser(target.id);
      this.host.broadcast({ type: MessageType.MEMBER_KICKED, payload: { userId: target.id, nickname: target.nickname } });
    });
    await this.host.roleAdmin.broadcastState();
    this.bans(session, requestId);
  }
}
