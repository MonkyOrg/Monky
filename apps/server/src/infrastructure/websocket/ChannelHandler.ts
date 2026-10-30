import type { WebSocket } from 'ws';
import {
  MessageType, Permission, ProtocolErrorCode, canAccessChannel,
  type CategoryCreatePayload, type CategoryDeletePayload, type CategoryReorderPayload, type CategoryUpdatePayload,
  type ChannelCreatePayload, type ChannelDeletePayload, type ChannelReorderPayload, type ChannelSummary, type ChannelUpdatePayload,
  type ServerMessage,
} from '@monky/shared';
import type { BotLocalExecutionService } from '../../application/services/BotLocalExecutionService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { CommunityService } from '../../application/services/CommunityService';
import { auditRef } from '../../application/services/ServerAuditService';
import { categoryChanges, channelChanges, channelCreationChanges } from '../../application/services/serverAuditChanges';
import type { SignalingService } from '../../application/services/SignalingService';
import type { SfuManager } from '../sfu/SfuManager';
import type { AccessEpoch } from './access/AccessEpoch';
import type { Authorizer } from './access/Authorizer';
import type { ChannelVisibility } from './access/ChannelVisibility';
import type { AuditRecorder, ChannelTree } from './AuditRecorder';
import type { BotInteractionHandler, BotInteractionSession } from './BotInteractionHandler';
import type { ClientSession, SignedInSession } from './ClientSession';
import type { Outbox } from './Outbox';
import { route, type Route } from './routing/MessageRouter';
import type { SfuSignalingHandler } from './voice/SfuSignalingHandler';
import type { VoiceSessionHandler } from './voice/VoiceSessionHandler';

type CategoryOperation = 'create' | 'update' | 'delete' | 'reorder';
type CategoryPayload = CategoryCreatePayload | CategoryUpdatePayload | CategoryDeletePayload | CategoryReorderPayload;

export interface ChannelHost {
  readonly channels: ChannelService;
  readonly communityService?: CommunityService;
  readonly signaling: SignalingService;
  readonly sfu: SfuManager;
  readonly sfuSignaling: Pick<SfuSignalingHandler, 'notifyProducersClosed'>;
  readonly botInteractions: Pick<BotInteractionHandler, 'deleteChannel'>;
  readonly botLocalExecution: Pick<BotLocalExecutionService<BotInteractionSession>, 'deleteChannel'>;
  readonly voiceSessions: Pick<VoiceSessionHandler, 'endVoiceSession'>;
  readonly visibility: Pick<ChannelVisibility, 'reconcile'>;
  readonly epoch: AccessEpoch;
  readonly authorizer: Pick<Authorizer, 'requirePermission' | 'requireCategoryManagement'>;
  readonly auditLog: AuditRecorder;
  readonly outbox: Pick<Outbox, 'channelAudience'>;
  isCurrentSession(session: ClientSession): boolean;
  captureChannelOperation(session: ClientSession): () => boolean;
  /** Bot settings name channels, so every change to the list reaches who manages bots. */
  broadcastBotSettings(changedBotId?: string): Promise<void>;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void;
}

/**
 * Channels and categories: creating, editing, reordering and deleting them.
 * The author gets the answer it awaits; everyone else who may see the change
 * learns it from the reconciliation of channel visibility (#384).
 */
export class ChannelHandler {
  constructor(private readonly host: ChannelHost) {}

  routes(): Route[] {
    const manage = Permission.MANAGE_CHANNELS;
    return [
      route({
        types: [MessageType.CHANNEL_CREATE], permission: manage,
        handle: ({ session, payload, requestId }) => this.create(session, payload as ChannelCreatePayload, requestId),
      }),
      route({
        types: [MessageType.CHANNEL_UPDATE], permission: manage,
        handle: ({ session, payload, requestId }) => this.update(session, payload as ChannelUpdatePayload, requestId),
      }),
      route({
        types: [MessageType.CHANNEL_DELETE], permission: manage,
        handle: ({ session, payload, requestId }) => this.delete(session, payload as ChannelDeletePayload, requestId),
      }),
      route({
        types: [MessageType.CHANNEL_REORDER], permission: manage,
        handle: ({ session, payload, requestId }) => this.reorder(session, payload as ChannelReorderPayload, requestId),
      }),
      route({
        types: [MessageType.CATEGORY_CREATE], permission: manage,
        handle: ({ session, payload, requestId }) => this.mutateCategory(session, 'create', payload as CategoryCreatePayload, requestId),
      }),
      route({
        types: [MessageType.CATEGORY_REORDER], permission: manage,
        handle: ({ session, payload, requestId }) => this.mutateCategory(session, 'reorder', payload as CategoryReorderPayload, requestId),
      }),
      // A category that is not named is answered as unavailable before the permission is checked.
      route({
        types: [MessageType.CATEGORY_UPDATE, MessageType.CATEGORY_DELETE],
        handle: async ({ session, type, payload, requestId }) => {
          const category = payload as CategoryUpdatePayload | CategoryDeletePayload;
          if (!(await this.host.authorizer.requireCategoryManagement(session, category?.categoryId, requestId))) return;
          await this.mutateCategory(session, type === MessageType.CATEGORY_UPDATE ? 'update' : 'delete', category, requestId);
        },
      }),
    ];
  }

  /**
   * CHANNEL_UPDATED only makes sense for clients that already have the channel
   * and keep access to it. Those who just gained or lost it are served by the
   * reconciliation, which sends them a CREATED or a DELETED instead (#384).
   */
  async publishUpdate(channel: ChannelSummary, skip?: WebSocket): Promise<void> {
    const message: ServerMessage<MessageType.CHANNEL_UPDATED> = { type: MessageType.CHANNEL_UPDATED, payload: { channel } };
    const audience = await this.host.outbox.channelAudience(channel);
    this.host.publish((peer) => peer.visibleChannelIds?.has(channel.id) && audience.has(peer.user.id) ? message : undefined, skip);

    await this.host.visibility.reconcile();
  }

  /** What a removed channel leaves behind: bot state tied to it, anyone still in its voice room and its SFU router. */
  releaseDeleted(channelId: string): void {
    this.host.botLocalExecution.deleteChannel(channelId);
    this.host.botInteractions.deleteChannel(channelId);

    // If it was a voice channel, disconnect any participants still in it so they
    // are not stranded in a "ghost" channel after it has been removed.
    for (const participant of this.host.signaling.getParticipantsInChannel(channelId)) {
      this.host.voiceSessions.endVoiceSession(participant.sessionId);
    }
    // Nothing else would ever close the room's router: the channel is gone.
    const { sfu } = this.host;
    if (sfu) this.host.sfuSignaling.notifyProducersClosed(channelId, sfu.closeChannel(channelId).closedProducerIds);
  }

  private async create(session: SignedInSession, payload: ChannelCreatePayload, requestId?: string): Promise<void> {
    const result = await this.host.channels.createChannel(payload);
    if (!result.success || !result.channel) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao criar canal',
        requestId
      );
      return;
    }

    // The author gets the correlated reply first — the client awaits it by
    // requestId — and is marked as already knowing the channel so the
    // reconciliation below does not send it twice. Everyone else allowed in
    // learns about it through that same reconciliation (#384).
    this.host.send(session.ws, {
      type: MessageType.CHANNEL_CREATED,
      requestId,
      payload: { channel: result.channel },
    });
    session.visibleChannelIds?.add(result.channel.id);
    if (this.host.auditLog.enabled) {
      this.host.auditLog.record(session, 'channel.create', {
        target: auditRef.channel(result.channel),
        changes: channelCreationChanges(result.channel, await this.host.auditLog.names()),
      });
    }

    await this.host.visibility.reconcile();
    await this.host.broadcastBotSettings();
  }

  private async mutateCategory(
    session: SignedInSession, operation: CategoryOperation, payload: CategoryPayload, requestId?: string,
  ): Promise<void> {
    const before = this.host.auditLog.enabled ? await this.host.auditLog.channelTree() : undefined;
    const result = await this.host.epoch.change(() => this.host.channels.mutateCategory(operation, payload, session.user.id));
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode ?? ProtocolErrorCode.BAD_REQUEST, result.errorMessage ?? 'Categoria inválida', requestId);
      return;
    }
    if (before) await this.auditCategoryMutation(session, operation, payload, before);
    await this.host.visibility.reconcile(true);
    if (!this.host.isCurrentSession(session)) return;
    const canDeliver = this.host.captureChannelOperation(session);
    const [categories, channels, context] = await Promise.all([
      this.host.channels.listCategories(), this.host.channels.listChannels(),
      this.host.channels.getAccessContext(session.user.id),
    ]);
    if (!canDeliver()) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Access changed.', requestId);
      return;
    }
    const visibleCategories = categories.filter(category =>
      canAccessChannel(category, context.permissions, context.roleIds, context.isBot, context.userId) ||
      channels.some(channel => channel.categoryId === category.id &&
        canAccessChannel(this.host.channels.rulesFor(channel, context), context.permissions, context.roleIds, context.isBot, context.userId)));
    // The author always gets the answer it awaits; later lists are compared with it.
    session.categoriesKey = JSON.stringify(visibleCategories);
    this.host.send(session.ws, {
      type: MessageType.CATEGORIES_UPDATED,
      requestId,
      payload: { categories: visibleCategories },
    });
  }

  private async auditCategoryMutation(
    session: SignedInSession, operation: CategoryOperation, payload: CategoryPayload, before: ChannelTree,
  ): Promise<void> {
    const { auditLog } = this.host;
    const after = await auditLog.channelTree();
    if (operation === 'reorder') {
      auditLog.recordTreeMoves(session, before, after);
      return;
    }
    const known = new Set(before.categories.map((category) => category.id));
    const id = operation === 'create'
      ? after.categories.filter((category) => !known.has(category.id)).at(-1)?.id
      : 'categoryId' in payload ? payload.categoryId : undefined;
    const previous = before.categories.find((category) => category.id === id);
    const next = after.categories.find((category) => category.id === id);
    if (operation === 'delete') {
      if (previous) auditLog.record(session, 'category.delete', { target: auditRef.category(previous) });
      return;
    }
    if (!next) return;
    if (operation === 'create') {
      auditLog.record(session, 'category.create', {
        target: auditRef.category(next), changes: next.isPrivate ? [{ field: 'private', after: true }] : [],
      });
      return;
    }
    if (!previous) return;
    const changes = categoryChanges(previous, next, await auditLog.names(previous, next));
    if (changes.length) auditLog.record(session, 'category.update', { target: auditRef.category(next), changes });
  }

  private async update(session: SignedInSession, payload: ChannelUpdatePayload, requestId?: string): Promise<void> {
    const before = payload?.channelId ? await this.host.channels.getChannelSummary(payload.channelId) : null;
    if (payload?.categoryId !== undefined) {
      if (before && payload.categoryId !== (before.categoryId ?? null)) {
        if (payload.categoryId
          ? !(await this.host.authorizer.requireCategoryManagement(session, payload.categoryId, requestId))
          : !(await this.host.authorizer.requirePermission(session, Permission.MANAGE_CHANNELS, requestId))) return;
      }
    }
    const result = await this.host.epoch.change(() => this.host.channels.updateChannel(payload));
    if (!result.success || !result.channel) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao atualizar canal',
        requestId
      );
      return;
    }

    const channel = result.channel;
    if (this.host.auditLog.enabled && before) {
      const changes = channelChanges(before, channel, await this.host.auditLog.names(before, channel));
      if (changes.length) this.host.auditLog.record(session, 'channel.update', { target: auditRef.channel(channel), changes });
    }
    this.host.send(session.ws, {
      type: MessageType.CHANNEL_UPDATED,
      requestId,
      payload: { channel },
    });
    await this.publishUpdate(channel, session.ws);
  }

  /**
   * Applies a new channel order and tells everyone (#471).
   *
   * Each recipient only gets the positions of the channels they can already
   * see: sending the whole list would leak the existence of private channels
   * they have no access to.
   */
  private async reorder(session: SignedInSession, payload: ChannelReorderPayload, requestId?: string): Promise<void> {
    const before = this.host.auditLog.enabled ? await this.host.auditLog.channelTree() : undefined;
    const result = await this.host.channels.reorderChannels(payload, session.user.id);
    if (!result.success || !result.positions) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao reordenar canais',
        requestId
      );
      return;
    }
    if (before) this.host.auditLog.recordTreeMoves(session, before, await this.host.auditLog.channelTree());
    // Categories share the root with loose channels: when they move, everyone
    // receives their new positions before the channel positions land.
    if (result.categoriesChanged) await this.host.visibility.reconcile();

    const positions = result.positions;
    const visibleTo = (peer: ClientSession) =>
      positions.filter((p) => peer.visibleChannelIds?.has(p.channelId));

    this.host.send(session.ws, {
      type: MessageType.CHANNELS_REORDERED,
      requestId,
      payload: { positions: visibleTo(session) },
    });

    this.host.publish((peer) => {
      const mine = visibleTo(peer);
      return mine.length === 0 ? undefined : { type: MessageType.CHANNELS_REORDERED, payload: { positions: mine } };
    }, session.ws);
  }

  private async delete(session: SignedInSession, payload: ChannelDeletePayload, requestId?: string): Promise<void> {
    const cleanupCommunityMedia = this.host.communityService?.prepareChannelDeletion(payload.channelId);
    const deleted = this.host.auditLog.enabled ? await this.host.channels.getChannelSummary(payload.channelId) : null;
    const result = await this.host.epoch.change(() => this.host.channels.deleteChannel(payload.channelId));
    if (!result.success) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.CHANNEL_NOT_FOUND,
        result.errorMessage || 'Erro ao deletar canal',
        requestId
      );
      return;
    }
    cleanupCommunityMedia?.();
    if (deleted) this.host.auditLog.record(session, 'channel.delete', { target: auditRef.channel(deleted) });
    this.releaseDeleted(payload.channelId);

    this.host.send(session.ws, {
      type: MessageType.CHANNEL_DELETED,
      requestId,
      payload: { channelId: payload.channelId },
    });
    session.visibleChannelIds?.delete(payload.channelId);

    // Everyone else who could see it is told by the reconciliation, which no
    // longer finds the channel and therefore removes it from their list (#384).
    await this.host.visibility.reconcile();
  }
}
