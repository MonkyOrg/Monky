import type { WebSocket } from 'ws';
import { Permission, ProtocolErrorCode, hasPermission } from '@monky/shared';
import type { ChannelService } from '../../../application/services/ChannelService';
import type { PermissionService } from '../../../application/services/PermissionService';
import type { ClientSession } from '../ClientSession';

const PERMISSION_DENIED = 'Você não tem permissão para executar esta ação.';
const CHANNEL_NOT_FOUND = 'Canal não encontrado';

/** Who asks: the connection a refusal is answered on, and who it speaks for. */
export type Requester = Pick<ClientSession, 'ws' | 'user' | 'isBot'>;

export interface AuthorizerHost {
  readonly channels: ChannelService;
  readonly permissions: PermissionService;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
}

/**
 * Whether a member or bot may do something, answering the refusal itself when
 * not. Every check of the WebSocket layer comes down to these.
 */
export class Authorizer {
  constructor(private readonly host: AuthorizerHost) {}

  /**
   * A permission held on the server, or inside a channel when one is named.
   * Managing channels and moving members are always judged on the server.
   */
  async requirePermission(session: Requester, permission: Permission, requestId?: string, channelId?: string): Promise<boolean> {
    if (!session.user) return false;
    const serverLevelOnly = permission === Permission.MANAGE_CHANNELS || permission === Permission.MOVE_MEMBERS;
    if (channelId && !serverLevelOnly && !await this.requireChannelAccess(session, channelId, requestId)) return false;
    const allowed = channelId && !serverLevelOnly
      ? await this.host.channels.canUserAccessChannel(session.user.id, channelId, permission)
      : session.isBot
      ? hasPermission((await this.host.channels.getAccessContext(session.user.id)).permissions, permission)
      : await this.host.permissions.checkPermission(session.user.id, permission);
    if (allowed) return true;
    this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, PERMISSION_DENIED, requestId);
    return false;
  }

  /**
   * Guards an action targeting a channel the caller may not be allowed into.
   *
   * The refusal deliberately reuses CHANNEL_NOT_FOUND: answering "you lack
   * access" would confirm that a private channel with that id exists, which is
   * exactly what hiding it is meant to prevent (#384).
   */
  async requireChannelAccess(session: Requester, channelId: string | undefined, requestId?: string): Promise<boolean> {
    if (!session.user) return false;
    if (channelId && (await this.host.channels.canUserAccessChannel(session.user.id, channelId))) return true;

    this.host.sendError(session.ws, ProtocolErrorCode.CHANNEL_NOT_FOUND, CHANNEL_NOT_FOUND, requestId);
    return false;
  }

  /**
   * Access to a channel and every permission given inside it, from a single
   * read of the channel and of the member (S-WS-5). The answers, and their
   * order, are those of `requirePermission` in the channel for each permission
   * followed by `requireChannelAccess`: the channel refused as CHANNEL_NOT_FOUND
   * (#384) first, then a permission it lacks.
   */
  async authorizeChannel(
    session: Requester, channelId: unknown, permissions: readonly Permission[], requestId?: string,
  ): Promise<boolean> {
    if (!session.user) return false;
    const scope = this.host.channels.accessScope();
    const channel = typeof channelId === 'string' && channelId ? await scope.channel(channelId) : null;
    const context = channel ? await scope.context(session.user.id) : undefined;
    if (!channel || !context || !this.host.channels.allows(channel, context)) {
      this.host.sendError(session.ws, ProtocolErrorCode.CHANNEL_NOT_FOUND, CHANNEL_NOT_FOUND, requestId);
      return false;
    }
    if (permissions.every((permission) => this.host.channels.allows(channel, context, permission))) return true;
    this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, PERMISSION_DENIED, requestId);
    return false;
  }

  /** Managing channels inside a category: one that is not named is refused as unavailable. */
  async requireCategoryManagement(session: Requester, categoryId: string, requestId?: string): Promise<boolean> {
    if (session.user && categoryId) return this.requirePermission(session, Permission.MANAGE_CHANNELS, requestId);
    this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Categoria indisponível.', requestId);
    return false;
  }
}
