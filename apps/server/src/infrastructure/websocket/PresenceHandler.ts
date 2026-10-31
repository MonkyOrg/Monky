import type { WebSocket } from 'ws';
import {
  MessageType, ProtocolErrorCode, userChangeNicknameSchema, userUpdateActivitySchema, userUpdateAvatarSchema, userUpdateBrbSchema, userUpdateCustomStatusSchema,
  type CustomStatus, type ServerMessage, type UserChangeNicknamePayload, type UserSummary, type UserUpdateAvatarPayload,
  type UserUpdateVisibilityPayload,
} from '@monky/shared';
import type { UserService } from '../../application/services/UserService';
import { Logger } from '../logger/Logger';
import type { AuditRecorder } from './AuditRecorder';
import type { ClientSession, SignedInSession } from './ClientSession';
import { route, type Route } from './routing/MessageRouter';
import { userForRecipient } from './userProjection';

export interface PresenceHost {
  readonly users: UserService;
  readonly auditLog: AuditRecorder;
  sessionsOfUser(userId: string): ClientSession[];
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void;
}

/**
 * How a person appears to everyone else: nickname and avatar, "aparecer
 * offline", the game they play, "Volto já" and a custom status. A person may
 * be signed in from several devices (#309): each change reaches all of them.
 */
export class PresenceHandler {
  constructor(private readonly host: PresenceHost) {}

  routes(): Route[] {
    return [
      route({
        types: [MessageType.USER_CHANGE_NICKNAME], schema: { type: userChangeNicknameSchema, message: 'Apelido inválido.' },
        handle: ({ session, payload, requestId }) => this.changeNickname(session, payload, requestId),
      }),
      route({
        types: [MessageType.USER_UPDATE_AVATAR], schema: { type: userUpdateAvatarSchema, message: 'Avatar inválido.' },
        handle: ({ session, payload, requestId }) => this.updateAvatar(session, payload, requestId),
      }),
      route({
        types: [MessageType.USER_UPDATE_VISIBILITY],
        handle: ({ session, payload, requestId }) => this.setVisibility(session, payload as UserUpdateVisibilityPayload, requestId),
      }),
      route({ types: [MessageType.USER_UPDATE_ACTIVITY], handle: ({ session, payload, requestId }) => this.updateActivity(session, payload, requestId) }),
      route({ types: [MessageType.USER_UPDATE_BRB], handle: ({ session, payload, requestId }) => this.updateBrb(session, payload, requestId) }),
      route({
        types: [MessageType.USER_UPDATE_CUSTOM_STATUS],
        handle: ({ session, payload, requestId }) => this.updateCustomStatus(session, payload, requestId),
      }),
    ];
  }

  /** "Aparecer offline" on or off, for every device of the person at once (#561). */
  setVisibility(session: ClientSession, payload: UserUpdateVisibilityPayload, requestId?: string): void {
    if (!session.user || !session.sessionId) return;
    if (session.isBot || !payload || typeof payload.appearOffline !== 'boolean') {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Visibilidade inválida.', requestId);
      return;
    }
    const nowInvisible = payload.appearOffline;
    const userSessions = this.host.sessionsOfUser(session.user.id);
    const changed = userSessions.some((other) => !!other.invisible !== nowInvisible);

    // Propagate to all sessions of the same user so multi-device is consistent.
    for (const s of userSessions) {
      s.invisible = nowInvisible;
      if (s.user) s.user.invisible = nowInvisible;
    }

    this.broadcastUserUpdate(session.user, requestId);
    if (changed && !nowInvisible) {
      // Tell everyone else the user joined (for each device session).
      for (const s of userSessions) {
        if (!s.user) continue;
        // Same delivery rules as broadcast(), but the game is per recipient.
        const user: UserSummary = { ...s.user, invisible: undefined };
        this.host.publish((recipient) => ({
          type: MessageType.USER_JOINED,
          payload: { user: userForRecipient(recipient, user) },
        }), s.ws);
      }
    }

    Logger.info('NETWORK', `User ${session.user.nickname} is now ${nowInvisible ? 'invisible' : 'visible'}.`);
  }

  applyBrb(session: ClientSession, brb: boolean, requestId?: string): void {
    if (!session.user) return;
    // Every device carries it, or a later broadcast from another one (a
    // nickname change, say) would bring back a stale status.
    for (const target of this.host.sessionsOfUser(session.user.id)) {
      // "Volto já" replaces a custom status: the person picked one of the two.
      if (target.user) target.user = { ...target.user, brb: brb || undefined, ...(brb ? { customStatus: undefined } : {}) };
    }
    this.broadcastUserUpdate(session.user, requestId);
  }

  applyCustomStatus(session: ClientSession, customStatus: CustomStatus | null, requestId?: string): void {
    if (!session.user) return;
    for (const target of this.host.sessionsOfUser(session.user.id)) {
      if (target.user) {
        target.user = { ...target.user, customStatus: customStatus ?? undefined, ...(customStatus ? { brb: undefined } : {}) };
      }
    }
    this.broadcastUserUpdate(session.user, requestId);
  }

  private async changeNickname(session: SignedInSession, payload: UserChangeNicknamePayload, requestId?: string): Promise<void> {
    const previousNickname = session.user.nickname;
    const result = await this.host.users.changeNickname(session.user.id, payload.newNickname);
    if (!result.success || !result.updatedUser) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.NICKNAME_INVALID,
        result.errorMessage || 'Erro ao alterar nickname',
        requestId
      );
      return;
    }

    if (previousNickname !== result.updatedUser.nickname) {
      this.host.auditLog.record(session, 'member.nickname', {
        changes: [{ field: 'nickname', before: previousNickname, after: result.updatedUser.nickname }],
      });
    }
    this.applyUserUpdate(result.updatedUser);
    this.broadcastUserUpdate(session.user, requestId);
  }

  private async updateAvatar(session: SignedInSession, payload: UserUpdateAvatarPayload, requestId?: string): Promise<void> {
    const result = await this.host.users.updateAvatar(session.user.id, payload.avatarBase64);
    if (!result.success || !result.updatedUser) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.AVATAR_INVALID_TYPE,
        result.errorMessage || 'Erro ao atualizar avatar',
        requestId
      );
      return;
    }

    this.applyUserUpdate(result.updatedUser);
    this.broadcastUserUpdate(session.user, requestId);
  }

  /**
   * Publishes what this person is playing, or clears it (#675).
   *
   * Clearing matters as much as setting: when the settings toggle goes off the
   * client sends `null`, and without that the last game would stay frozen on
   * everyone else's card forever.
   */
  private updateActivity(session: SignedInSession, payload: unknown, requestId?: string): void {
    if (session.isBot) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED,
        'Bots não publicam atividade de jogo.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('game-activity')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Mostrar o jogo exige um cliente e servidor atualizados.', requestId);
      return;
    }
    const parsed = userUpdateActivitySchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Atividade inválida.', requestId);
      return;
    }

    const { activity } = parsed.data;
    // Applied to every device of this person: otherwise a later broadcast from
    // another session (a nickname change, say) would carry a stale activity.
    for (const target of this.host.sessionsOfUser(session.user.id)) {
      if (target.user) target.user = { ...target.user, activity };
    }
    this.broadcastUserUpdate(session.user, requestId);
  }

  /** "Volto já" on or off (user-brb), for every device of the person at once. */
  private updateBrb(session: SignedInSession, payload: unknown, requestId?: string): void {
    if (session.isBot) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots não usam o status Volto já.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('user-brb')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'O status Volto já exige um cliente e servidor atualizados.', requestId);
      return;
    }
    const parsed = userUpdateBrbSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Status inválido.', requestId);
      return;
    }
    this.applyBrb(session, parsed.data.brb, requestId);
  }

  /** The person's own status (custom-status), for every device at once; null clears it. */
  private updateCustomStatus(session: SignedInSession, payload: unknown, requestId?: string): void {
    if (session.isBot) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots não usam status personalizado.', requestId);
      return;
    }
    if (!session.protocol?.features.includes('custom-status')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'O status personalizado exige um cliente e servidor atualizados.', requestId);
      return;
    }
    const parsed = userUpdateCustomStatusSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Status personalizado inválido.', requestId);
      return;
    }
    this.applyCustomStatus(session, parsed.data.customStatus, requestId);
  }

  /** Presence updates must not masquerade as a physical disconnect from voice. */
  private broadcastUserUpdate(user: UserSummary, requestId?: string): void {
    const invisible = this.host.sessionsOfUser(user.id).some((session) => session.invisible);
    const publicUser: UserSummary = {
      ...user,
      invisible: undefined,
      // Hiding has to hide the game too, or "aparecer offline" leaks what the
      // person is doing while claiming they are offline (#675).
      ...(invisible
        ? { status: 'DISCONNECTED', sessionId: undefined, connectedAt: undefined, activity: undefined, brb: undefined, customStatus: undefined }
        : {}),
    };
    const messages = new Map<UserSummary, ServerMessage<MessageType.USER_UPDATED>>();
    this.host.publish((recipient) => {
      const shown = recipient.user.id === user.id ? recipient.user : userForRecipient(recipient, publicUser);
      let message = messages.get(shown);
      if (!message) {
        message = { type: MessageType.USER_UPDATED, requestId, payload: { user: shown } };
        messages.set(shown, message);
      }
      return message;
    });
  }

  /**
   * Refreshes the cached summary on every live session of that person, keeping
   * the per-connection fields the service layer knows nothing about (#309).
   */
  private applyUserUpdate(updatedUser: UserSummary): void {
    for (const target of this.host.sessionsOfUser(updatedUser.id)) {
      target.user = {
        ...updatedUser,
        sessionId: target.sessionId,
        connectedAt: target.user?.connectedAt,
        invisible: target.invisible,
        // The service only knows the stored profile, so the live presence is carried over.
        activity: target.user?.activity,
        brb: target.user?.brb,
        customStatus: target.user?.customStatus,
      };
    }
  }
}
