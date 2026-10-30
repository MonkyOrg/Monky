import type { WebSocket } from 'ws';
import {
  MessageType, Permission, ProtocolErrorCode, roleModelFor, rolesForModel,
  type MemberKickPayload, type RoleAssignPayload, type RoleCreatePayload, type RoleDeletePayload, type RoleModel,
  type RoleUpdatePayload, type ServerMessage,
} from '@monky/shared';
import type { AttachmentService } from '../../application/services/AttachmentService';
import type { PermissionService } from '../../application/services/PermissionService';
import type { RoleService } from '../../application/services/RoleService';
import { auditDiff, auditRef } from '../../application/services/ServerAuditService';
import { permissionChanges } from '../../application/services/serverAuditChanges';
import type { SignalingService } from '../../application/services/SignalingService';
import type { UserService } from '../../application/services/UserService';
import { Logger } from '../logger/Logger';
import type { AccessEpoch } from './access/AccessEpoch';
import type { ChannelVisibility } from './access/ChannelVisibility';
import type { AuditRecorder } from './AuditRecorder';
import type { ClientSession, SignedInSession } from './ClientSession';
import type { CommunityHandler } from './CommunityHandler';
import { route, type Route } from './routing/MessageRouter';
import type { ScreenAccessCoordinator } from './voice/ScreenAccessCoordinator';
import type { VoiceSessionHandler } from './voice/VoiceSessionHandler';

export interface RoleHost {
  readonly roles: RoleService;
  readonly permissions: PermissionService;
  readonly users: UserService;
  readonly attachments: AttachmentService;
  readonly signaling: SignalingService;
  readonly screens: Pick<ScreenAccessCoordinator, 'refreshScreenRoles'>;
  readonly voiceSessions: Pick<VoiceSessionHandler, 'endVoiceSession'>;
  readonly visibility: Pick<ChannelVisibility, 'reconcile'>;
  readonly community?: Pick<CommunityHandler, 'refresh'>;
  readonly epoch: AccessEpoch;
  readonly auditLog: AuditRecorder;
  sessionsOfUser(userId: string): ClientSession[];
  /** Disconnects every device of a person, pending reconnections included. */
  closeSessionsOfUser(userId: string): number;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcast(message: ServerMessage, ignoreWs?: WebSocket): void;
  publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void;
}

/**
 * Roles and who holds them, and expelling a member, which takes their roles
 * with them. RoleService checks MANAGE_ROLES itself; every change ends in the
 * same broadcast of the role state, which reconciles channel access (#384).
 */
export class RoleHandler {
  constructor(private readonly host: RoleHost) {}

  routes(): Route[] {
    return [
      route({ types: [MessageType.ROLE_CREATE], handle: ({ session, payload, requestId }) => this.create(session, payload as RoleCreatePayload, requestId) }),
      route({ types: [MessageType.ROLE_UPDATE], handle: ({ session, payload, requestId }) => this.update(session, payload as RoleUpdatePayload, requestId) }),
      route({ types: [MessageType.ROLE_DELETE], handle: ({ session, payload, requestId }) => this.delete(session, payload as RoleDeletePayload, requestId) }),
      route({
        types: [MessageType.ROLE_ASSIGN, MessageType.ROLE_UNASSIGN],
        handle: ({ session, type, payload, requestId }) =>
          this.assign(session, payload as RoleAssignPayload, type === MessageType.ROLE_ASSIGN, requestId),
      }),
      route({
        types: [MessageType.MEMBER_KICK], permission: Permission.KICK_MEMBERS,
        handle: ({ session, payload, requestId }) => this.kick(session, payload as MemberKickPayload, requestId),
      }),
    ];
  }

  /**
   * Tells everyone the roles, each in the model its app negotiated, and
   * reconciles channel access, since roles decide who sees a private channel.
   * `channelsChanged` resends every visible channel. Only deleting a role or a
   * member edits channel rows (rules naming them go with it); resending them on
   * any other role change, or on every sign-in, made every client redraw its
   * whole sidebar.
   */
  async broadcastState(requestId?: string, channelsChanged = false): Promise<void> {
    this.host.epoch.generation++;
    const state = await this.host.roles.getRoleState();
    await this.host.screens.refreshScreenRoles();
    const payload = {
      everyonePermissions: state.everyonePermissions,
      roles: state.roles,
      userRoles: state.userRoles,
    };
    const message: ServerMessage<MessageType.ROLES_LIST> = { type: MessageType.ROLES_LIST, requestId, payload };
    const byModel = new Map<RoleModel, ServerMessage<MessageType.ROLES_LIST>>();
    const messageFor = (model: RoleModel): ServerMessage<MessageType.ROLES_LIST> => {
      let variant = byModel.get(model);
      if (!variant) {
        variant = { ...message, payload: { ...payload, roles: rolesForModel(state.roles, state.everyonePermissions, model) } };
        byModel.set(model, variant);
      }
      return variant;
    };
    this.host.publish((session) => messageFor(roleModelFor(session.protocol?.features)));

    // Roles decide who may see a private channel, so any change to them can
    // grant or revoke access. Reconciling here covers every role mutation at
    // once — create, update, delete, assign and unassign all end up in this
    // method (#384).
    await this.host.visibility.reconcile(channelsChanged);
    await this.host.community?.refresh();
  }

  private async create(session: SignedInSession, payload: RoleCreatePayload, requestId?: string): Promise<void> {
    const result = await this.host.roles.createRole(session.user.id, payload, roleModelFor(session.protocol?.features));
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao criar cargo.', requestId);
      return;
    }
    if (result.role) {
      this.host.auditLog.record(session, 'role.create', {
        target: auditRef.role(result.role),
        changes: [
          ...(result.role.color ? [{ field: 'color', after: result.role.color }] : []),
          ...(result.role.isDefault ? [{ field: 'isDefault', after: true }] : []),
          ...permissionChanges(0, result.role.permissions),
        ],
      });
    }
    await this.broadcastState(requestId);
  }

  private async update(session: SignedInSession, payload: RoleUpdatePayload, requestId?: string): Promise<void> {
    const { auditLog } = this.host;
    const roleId = typeof payload?.roleId === 'string' ? payload.roleId : undefined;
    const before = auditLog.enabled && roleId ? await auditLog.role(roleId) : undefined;
    const result = await this.host.roles.updateRole(session.user.id, payload, roleModelFor(session.protocol?.features));
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao atualizar cargo.', requestId);
      return;
    }
    const after = before && roleId ? await auditLog.role(roleId) : undefined;
    if (before && after) {
      const changes = [
        ...auditDiff([
          ['name', before.name, after.name],
          ['color', before.color, after.color],
          ['isDefault', before.isDefault, after.isDefault],
        ]),
        ...permissionChanges(before.permissions, after.permissions),
      ];
      if (changes.length) auditLog.record(session, 'role.update', { target: auditRef.role(after), changes });
    }
    await this.broadcastState(requestId);
  }

  private async delete(session: SignedInSession, payload: RoleDeletePayload, requestId?: string): Promise<void> {
    const { auditLog } = this.host;
    const deleted = auditLog.enabled && typeof payload?.roleId === 'string' ? await auditLog.role(payload.roleId) : undefined;
    const result = await this.host.roles.deleteRole(session.user.id, payload.roleId);
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST, result.errorMessage || 'Erro ao excluir cargo.', requestId);
      return;
    }
    if (deleted) auditLog.record(session, 'role.delete', { target: auditRef.role(deleted) });
    await this.broadcastState(requestId, true);
  }

  private async assign(session: SignedInSession, payload: RoleAssignPayload, assign: boolean, requestId?: string): Promise<void> {
    const { auditLog } = this.host;
    const before = await auditLog.roleAssignment(payload);
    const result = assign
      ? await this.host.roles.assignRole(session.user.id, payload)
      : await this.host.roles.unassignRole(session.user.id, payload);
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || (assign ? 'Erro ao atribuir cargo.' : 'Erro ao remover cargo.'), requestId);
      return;
    }
    // Assigning a role someone already has, or removing one they lack, changes nothing and is not recorded.
    if (before?.role && before.held !== assign) {
      auditLog.record(session, assign ? 'role.assign' : 'role.unassign', {
        target: await auditLog.identity(payload.userId), related: { role: before.role },
      });
    }
    await this.broadcastState(requestId);
  }

  private async kick(session: SignedInSession, payload: MemberKickPayload, requestId?: string): Promise<void> {
    const targetUserId = payload?.targetUserId;
    if (!targetUserId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Usuário inválido.', requestId);
      return;
    }
    if (targetUserId === session.user.id) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Você não pode expulsar a si mesmo.', requestId);
      return;
    }
    if (await this.host.permissions.isOwner(targetUserId)) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'O dono do servidor não pode ser expulso.', requestId);
      return;
    }

    const result = await this.host.epoch.change(() => this.host.users.deleteMember(targetUserId));
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode ?? ProtocolErrorCode.BAD_REQUEST, result.errorMessage ?? 'Não foi possível expulsar o membro.', requestId);
      return;
    }
    this.host.auditLog.record(session, 'member.kick', { target: auditRef.user(targetUserId, result.nickname ?? targetUserId) });

    // Kicking removes the person, so every device they are signed in from has to
    // go — not just the most recent one (#309). Marked before any further await
    // so concurrent in-flight messages from them are dropped by the router.
    const targetSessions = this.host.sessionsOfUser(targetUserId);
    for (const targetSession of targetSessions) targetSession.replaced = true;

    // Invalidate any outstanding HTTP upload tokens the member still holds.
    this.host.attachments.revokeTokensForUser(targetUserId);

    // Remove the target from any voice channel they were in (one state per device).
    // The sessions were already marked as replaced above, which makes
    // handleDisconnect return early, so this is the last chance to reap what
    // they held in the SFU (#527).
    for (const previousVoice of this.host.signaling.getSessionsOfUser(targetUserId)) {
      this.host.voiceSessions.endVoiceSession(previousVoice.sessionId);
    }

    // Replaced sessions no longer receive broadcasts, so notify every kicked
    // device directly before closing it. Only the initiator needs the requestId.
    const kickedPayload = { userId: targetUserId, nickname: result.nickname ?? '' };
    this.host.send(session.ws, { type: MessageType.MEMBER_KICKED, requestId, payload: kickedPayload });
    for (const targetSession of targetSessions) {
      this.host.send(targetSession.ws, { type: MessageType.MEMBER_KICKED, payload: kickedPayload });
    }
    this.host.broadcast({ type: MessageType.MEMBER_KICKED, payload: kickedPayload }, session.ws);

    // Cancel pending reconnect-grace timers and forcefully disconnect every
    // live session of the kicked user.
    this.host.closeSessionsOfUser(targetUserId);

    // Role assignments were removed with the user, so refresh role state. Any
    // channel rule naming them went too, so channels are resent as well.
    await this.broadcastState(undefined, true);

    Logger.info('NETWORK', `User ${result.nickname} was kicked from the server by ${session.user.nickname}`);
  }
}
