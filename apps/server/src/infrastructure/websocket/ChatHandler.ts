import type { WebSocket } from 'ws';
import {
  LIMITS, MessageType, Permission, ProtocolErrorCode, chatHistoryRequestSchema, chatMentionsReadSchema, chatReactionSchema,
  type BotCommandMessagePayload, type ChatDeletePayload,   type ChatEditPayload, type ChatHistoryPayload,
  type ChatMessage, type ChatReactionPayload, type ChatRequestUploadTokenPayload, type ChatRestorePayload, type ChatSendPayload,
  type ServerMessage,
} from '@monky/shared';
import type { AttachmentService } from '../../application/services/AttachmentService';
import type { BotService } from '../../application/services/BotService';
import type { ChatService } from '../../application/services/ChatService';
import type { NativePollService } from '../../application/services/NativePollService';
import type { PermissionService } from '../../application/services/PermissionService';
import { auditRef } from '../../application/services/ServerAuditService';
import type { Authorizer } from './access/Authorizer';
import type { AuditRecorder } from './AuditRecorder';
import type { BotInteractionSession } from './BotInteractionHandler';
import type { ClientSession, SignedInSession } from './ClientSession';
import type { CommunityHandler } from './CommunityHandler';
import { channelIdOf, route, type Route } from './routing/MessageRouter';

export interface ChatHost {
  readonly chat: ChatService;
  readonly botService?: BotService;
  readonly permissions: PermissionService;
  readonly attachments: AttachmentService;
  readonly pollService?: NativePollService;
  readonly community?: Pick<CommunityHandler, 'refresh'>;
  readonly authorizer: Pick<Authorizer, 'authorizeChannel'>;
  readonly auditLog: AuditRecorder;
  isCurrentSession(session: BotInteractionSession): boolean;
  /** True while access did not move since, and the connection is still the current one. */
  captureChannelOperation(session: ClientSession): () => boolean;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcastToChannel(channelId: string, message: ServerMessage, ignoreWs?: WebSocket, canSend?: () => boolean): Promise<void>;
}

/**
 * Messages in a channel: sending, reacting, editing, deleting and restoring
 * them, reading history, clearing mentions and the token to upload files.
 * Payloads not checked here are checked by ChatService, which answers each
 * field with its own refusal.
 */
export class ChatHandler {
  constructor(private readonly host: ChatHost) {}

  routes(): Route[] {
    return [
      route({
        types: [MessageType.CHAT_REACTION_ADD, MessageType.CHAT_REACTION_REMOVE],
        schema: { type: chatReactionSchema, message: 'Reação inválida.' },
        channel: { id: (reaction) => reaction.channelId, permissions: [Permission.SEND_MESSAGES] },
        handle: ({ session, type, payload, requestId }) => this.react(session, payload, type === MessageType.CHAT_REACTION_ADD, requestId),
      }),
      route({
        types: [MessageType.CHAT_SEND], channel: { id: channelIdOf, permissions: [Permission.SEND_MESSAGES] },
        handle: ({ session, payload, requestId }) => this.sendMessage(session, payload as ChatSendPayload, requestId),
      }),
      route({
        types: [MessageType.CHAT_LOAD_HISTORY], channel: { id: channelIdOf, permissions: [Permission.READ_MESSAGES] },
        handle: ({ session, payload, requestId }) => this.history(session, payload, requestId),
      }),
      route({
        types: [MessageType.CHAT_EDIT], channel: { id: channelIdOf, permissions: [Permission.SEND_MESSAGES] },
        handle: ({ session, payload, requestId }) => this.edit(session, payload as ChatEditPayload, requestId),
      }),
      route({
        types: [MessageType.CHAT_DELETE], channel: { id: channelIdOf },
        handle: ({ session, payload, requestId }) => this.delete(session, payload as ChatDeletePayload, requestId),
      }),
      route({
        types: [MessageType.CHAT_RESTORE],
        unavailable: { when: (session) => !session.protocol?.features.includes('message-delete-undo'), message: 'Atualize para desfazer exclusões.' },
        channel: { id: channelIdOf },
        handle: ({ session, payload, requestId }) => this.restore(session, payload as ChatRestorePayload, requestId),
      }),
      route({
        types: [MessageType.CHAT_MENTIONS_READ], schema: { type: chatMentionsReadSchema, message: 'Canal inválido.' },
        handle: ({ session, payload }) => this.host.chat.markMentionsRead(session.user.id, payload.channelId),
      }),
      route({
        types: [MessageType.CHAT_REQUEST_UPLOAD_TOKEN],
        channel: { id: channelIdOf, permissions: [Permission.ATTACH_FILES, Permission.SEND_MESSAGES] },
        handle: ({ session, payload, requestId }) => this.uploadToken(session, payload as ChatRequestUploadTokenPayload, requestId),
      }),
    ];
  }

  /** A command's answer posted by its bot, as the live event the invoker's client is waiting for. */
  async publishBotResponse(
    session: BotInteractionSession,
    response: BotCommandMessagePayload,
    canSend: () => boolean,
    requestId?: string
  ): Promise<void> {
    const bot = session.botId ? await this.host.botService?.findById(session.botId) : null;
    if (!bot || !canSend() || !this.host.isCurrentSession(session)) return;
    const result = await this.host.chat.sendBotMessage(bot, response.channelId, response.content, {
      invocationId: response.invocationId, commandName: response.commandName,
      invokerId: response.invokerId, invokerNickname: response.invokerNickname,
      invokerAvatarUrl: response.invokerAvatarUrl,
    }, response.messageId, () => canSend() && this.host.isCurrentSession(session), response.invokerId, undefined, response.localizations);
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    // Keep the existing live event to avoid duplicate client rows; history
    // returns the same persisted ID and the same authenticated attribution.
    await this.host.broadcastToChannel(response.channelId, {
      type: MessageType.COMMAND_RESPONSE,
      payload: { ...response, createdAt: result.message.createdAt },
    }, undefined, canSend);
  }

  private async react(session: SignedInSession, reaction: ChatReactionPayload, add: boolean, requestId?: string): Promise<void> {
    if (!this.host.isCurrentSession(session)) return;
    const result = await this.host.chat.setReaction(session.user, reaction, add, this.host.captureChannelOperation(session));
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
    } else if (result.event) {
      await this.host.broadcastToChannel(reaction.channelId, {
        type: add ? MessageType.CHAT_REACTION_ADDED : MessageType.CHAT_REACTION_REMOVED,
        requestId,
        payload: result.event,
      });
    }
  }

  private async sendMessage(session: SignedInSession, payload: ChatSendPayload, requestId?: string): Promise<void> {
    const canSend = this.host.captureChannelOperation(session);

    const bot = session.isBot && session.botId ? await this.host.botService?.findById(session.botId) : undefined;
    if (payload.clientMessageId !== undefined && (session.isBot || !session.protocol?.features.includes('chat-delivery'))) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Confirmação de envio exige um cliente compatível atualizado.', requestId);
      return;
    }
    if (payload.blocks !== undefined && (bot || !session.protocol?.features.includes('chat-blocks'))) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, 'Blocos de mensagem exigem um cliente compatível atualizado.', requestId);
      return;
    }
    if (session.isBot && (!bot || !this.host.isCurrentSession(session))) {
      this.host.sendError(session.ws, ProtocolErrorCode.UNAUTHORIZED, 'Bot indisponível.', requestId);
      return;
    }
    if (bot && payload.attachmentIds?.length) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bots devem enviar mensagens de texto.', requestId);
      return;
    }
    if (!bot && payload.localizations !== undefined) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Somente bots podem fornecer traduções de mensagens.', requestId);
      return;
    }
    const result = bot
      ? await this.host.chat.sendBotMessage(bot, payload.channelId, payload.content, undefined, undefined, canSend, bot.id, payload.replyToMessageId, payload.localizations)
      : await this.host.chat.sendMessage(
      session.user.id,
      payload.channelId,
      payload.content,
      payload.attachmentIds,
      payload.replyToMessageId,
      payload.blocks,
      payload.clientMessageId,
      canSend,
      // Peers without message-forward never asked for the badge; their field is ignored.
      session.protocol?.features.includes('message-forward') ? payload.forward : undefined,
    );
    if (!result.success) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao enviar mensagem',
        requestId
      );
      return;
    }
    if (!result.message) {
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, 'Mensagem não foi persistida.', requestId);
      return;
    }

    // Writers (including approved bots) may lack history access, but still need their own acknowledgement.
    if (this.host.isCurrentSession(session)) this.host.send(session.ws, { type: MessageType.CHAT_MESSAGE, requestId, payload: result.message });
    if ('replayed' in result && result.replayed) return;
    // Broadcast message to everyone allowed into this channel (#384).
    await this.host.broadcastToChannel(result.message.channelId, {
      type: MessageType.CHAT_MESSAGE,
      requestId,
      payload: result.message,
    }, session.ws);
  }

  private async edit(session: SignedInSession, payload: ChatEditPayload, requestId?: string): Promise<void> {
    if (!payload?.messageId || !payload?.channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem inválida', requestId);
      return;
    }

    const result = await this.host.chat.editMessage(
      session.user.id,
      payload.channelId,
      payload.messageId,
      payload.content,
      this.host.captureChannelOperation(session),
    );
    if (!result.success || !result.message) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao editar mensagem',
        requestId
      );
      return;
    }

    await this.broadcastMessageUpdated(result.message, requestId);
  }

  private async delete(session: SignedInSession, payload: ChatDeletePayload, requestId?: string): Promise<void> {
    if (!payload?.messageId || !payload?.channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Mensagem inválida', requestId);
      return;
    }

    // Moderators clean up after anyone; everybody else only after themselves.
    const canModerate = await this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_SERVER);

    const result = await this.host.chat.deleteMessage(
      session.user.id,
      payload.channelId,
      payload.messageId,
      canModerate
    );
    if (!result.success || !result.message) {
      this.host.sendError(
        session.ws,
        result.errorCode || ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao apagar mensagem',
        requestId
      );
      return;
    }

    await this.broadcastMessageUpdated(result.message, requestId);
    if (this.host.auditLog.enabled && result.message.userId !== session.user.id) {
      this.host.auditLog.record(session, 'message.delete', {
        target: auditRef.member({ id: result.message.userId, nickname: result.message.userNickname, isBot: result.message.isBot }),
        related: { channel: await this.host.auditLog.channel(result.message.channelId) },
      });
    }
    const polls = this.host.pollService;
    const poll = polls?.repository.findByMessageId(payload.messageId);
    if (polls && poll) {
      await this.host.broadcastToChannel(poll.channelId, {
        type: MessageType.POLL_UPDATED,
        payload: polls.publicPoll(poll),
      });
      await this.host.community?.refresh();
    }
  }

  /** Sends the new state of an edited/deleted message to the channel (#504). */
  private async restore(session: SignedInSession, payload: ChatRestorePayload, requestId?: string): Promise<void> {
    if (!payload) return;
    const canModerate = await this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_SERVER);
    if (!this.host.isCurrentSession(session)) return;
    const result = await this.host.chat.restoreMessage(session.user.id, payload.channelId, payload.messageId,
      payload.deletedAt, payload.revision, canModerate);
    if (!result.success) {
      this.host.sendError(session.ws, result.errorCode, result.errorMessage, requestId);
      return;
    }
    await this.broadcastMessageUpdated(result.message, requestId);
    if (this.host.auditLog.enabled && result.message.userId !== session.user.id) {
      this.host.auditLog.record(session, 'message.restore', {
        target: auditRef.member({ id: result.message.userId, nickname: result.message.userNickname, isBot: result.message.isBot }),
        related: { channel: await this.host.auditLog.channel(result.message.channelId) },
      });
    }
  }

  private async broadcastMessageUpdated(message: ChatMessage, requestId?: string): Promise<void> {
    // The message was loaded for the actor: its poll must not carry their vote or revealed audience to everyone.
    const polls = this.host.pollService;
    const poll = message.poll && polls ? polls.repository.findById(message.poll.id) : undefined;
    await this.host.broadcastToChannel(message.channelId, {
      type: MessageType.CHAT_MESSAGE_UPDATED,
      requestId,
      payload: { message: poll && polls ? { ...message, poll: polls.publicPoll(poll) } : message },
    });
  }

  /** The route checked READ_MESSAGES before the page is read; it is checked again before the page goes out. */
  private async history(session: SignedInSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = chatHistoryRequestSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Histórico inválido.', requestId);
      return;
    }
    const messages = await this.host.chat.loadHistory(
      parsed.data.channelId,
      parsed.data.limit || LIMITS.MAX_HISTORY_MESSAGES_INITIAL,
      parsed.data.beforeTimestamp,
      parsed.data.aroundMessageId,
      session.user.id,
    );

    const historyPayload: ChatHistoryPayload = {
      aroundMessageId: parsed.data.aroundMessageId,
      channelId: parsed.data.channelId,
      messages,
    };

    if (!(await this.host.authorizer.authorizeChannel(session, parsed.data.channelId, [Permission.READ_MESSAGES], requestId))) return;
    this.host.send(session.ws, {
      type: MessageType.CHAT_HISTORY,
      requestId,
      payload: historyPayload,
    });
  }

  private uploadToken(session: SignedInSession, payload: ChatRequestUploadTokenPayload, requestId?: string): void {
    const issued = this.host.attachments.issueUploadToken(session.user.id, payload.channelId);
    if (!issued) {
      this.host.sendError(
        session.ws,
        ProtocolErrorCode.RATE_LIMITED,
        'Muitos envios em pouco tempo. Aguarde alguns segundos.',
        requestId
      );
      return;
    }
    this.host.send(session.ws, {
      type: MessageType.CHAT_UPLOAD_TOKEN,
      requestId,
      payload: { token: issued.token, expiresAt: issued.expiresAt },
    });
  }
}
