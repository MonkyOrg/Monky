import { v4 as uuidv4 } from 'uuid';
import { isDeepStrictEqual } from 'node:util';
import {
  AttachmentMeta,
  ChatMessage,
  LIMITS,
  ProtocolErrorCode,
  attachmentCaptionSchema,
  hasEveryoneMention,
  messageContentSchema,
  createMessageContentSchema,
  messageBlocksSchema,
  messageBlocksContent,
  type MessageBlock,
  type ResolvedMessageBlock,
  chatReactionSchema,
  type ChatReactionEventPayload,
  type MessageReaction,
  type UserSummary,
  type BotCommandContext,
  botCommandContextSchema,
  messageReferenceSchema,
  type MessageReply,
  botMessageLocalizationsSchema,
  botMessagePreviewLocalizations,
  type BotMessageLocalizations,
} from '@monky/shared';
import { BotRecord, MentionRecord, MessageRecord } from '../../domain/entities';
import {
  IChannelRepository,
  IMentionRepository,
  IMessageRepository,
  IServerRepository,
  IUserRepository,
} from '../../domain/repositories';
import { AvatarStorageService } from '../../infrastructure/security/AvatarStorageService';
import { RateLimiter } from '../../infrastructure/security/RateLimiter';
import { AttachmentService } from './AttachmentService';

export type BotMessageResult =
  | { success: true; message: ChatMessage }
  | { success: false; errorCode: ProtocolErrorCode; errorMessage: string };

export class ChatService {
  constructor(
    private messageRepo: IMessageRepository,
    private channelRepo: IChannelRepository,
    private userRepo: IUserRepository,
    private mentionRepo: IMentionRepository,
    private avatarStorage: AvatarStorageService,
    private rateLimiter: RateLimiter,
    private attachmentService: AttachmentService,
    private serverRepo: IServerRepository,
    /**
     * Whether a user may see a channel (#464). Injected as a callback so the
     * chat layer does not have to know about roles and permissions: mentions
     * must never ping people who cannot even see the private channel it was
     * written in.
     */
    private canUserAccessChannel: (userId: string, channelId: string) => Promise<boolean>,
    private canUserReadMessages: (userId: string) => Promise<boolean>
  ) {}

  public async sendBotMessage(
    bot: BotRecord,
    channelId: string,
    content: string,
    botCommand?: BotCommandContext,
    messageId?: string,
    canSend: () => boolean = () => true,
    accessUserId: string = bot.id,
    replyToMessageId?: string,
    localizations?: BotMessageLocalizations
  ): Promise<BotMessageResult> {
    const server = await this.serverRepo.getServer();
    const parsed = createMessageContentSchema(server?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH).safeParse(content);
    const variants = botMessageLocalizationsSchema.optional().safeParse(localizations);
    if (variants.success && variants.data && Object.values(variants.data).some(value =>
      value !== undefined && !createMessageContentSchema(server?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH).safeParse(value).success)) {
      return { success: false, errorCode: ProtocolErrorCode.MESSAGE_TOO_LONG, errorMessage: 'A tradução excede o limite de caracteres do servidor.' };
    }
    if (!parsed.success || !variants.success || typeof channelId !== 'string' || !channelId || channelId.length > 128 ||
        (messageId !== undefined && (!messageId || messageId.length > 128))) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Mensagem de bot inválida.' };
    }
    const channel = await this.channelRepo.findById(channelId);
    if (!channel || channel.type !== 'TEXT' || !(await this.canUserAccessChannel(accessUserId, channelId))) {
      return { success: false, errorCode: ProtocolErrorCode.CHANNEL_NOT_FOUND, errorMessage: 'Canal não encontrado.' };
    }
    if (!(await this.isValidReply(channelId, replyToMessageId))) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Mensagem de referência indisponível.' };
    }
    const existing = messageId ? await this.messageRepo.findById(messageId) : null;
    if (!canSend()) return { success: false, errorCode: ProtocolErrorCode.PERMISSION_DENIED, errorMessage: 'Publicação cancelada.' };
    if (existing) {
      if (!existing.botAuthor || existing.userId !== bot.id || existing.channelId !== channelId ||
          existing.content !== parsed.data || existing.deletedAt || existing.replyToMessageId !== replyToMessageId ||
          !isDeepStrictEqual(existing.localizations, variants.data)) {
        return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Identificador de mensagem já utilizado.' };
      }
      return { success: true, message: { ...this.botMessage(existing), reply: await this.resolveReply(existing) } };
    }
    if (!this.rateLimiter.checkLimit(bot.id)) {
      return { success: false, errorCode: ProtocolErrorCode.RATE_LIMITED, errorMessage: 'Aguarde antes de publicar novamente.' };
    }
    const record: MessageRecord = {
      id: messageId ?? uuidv4(), channelId, userId: bot.id, content: parsed.data, createdAt: Date.now(), isSystem: false,
      botAuthor: { id: bot.id, name: bot.name, avatarPath: bot.avatarPath, ownerUserId: bot.createdByUserId },
      botCommand: botCommand ? botCommandContextSchema.parse(botCommand) : undefined,
      replyToMessageId,
      localizations: variants.data,
    };
    const persisted = await this.messageRepo.createBotMessage(record);
    if (!persisted) {
      return { success: false, errorCode: ProtocolErrorCode.UNAUTHORIZED, errorMessage: 'Bot indisponível.' };
    }
    if (!persisted.botAuthor || persisted.userId !== bot.id || persisted.channelId !== channelId ||
        persisted.content !== parsed.data || persisted.deletedAt || persisted.replyToMessageId !== replyToMessageId ||
        !isDeepStrictEqual(persisted.localizations, variants.data)) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Identificador de mensagem já utilizado.' };
    }
    return { success: true, message: { ...this.botMessage(persisted), reply: await this.resolveReply(persisted) } };
  }

  private async isValidReply(channelId: string, messageId?: string, allowDeleted = false): Promise<boolean> {
    if (messageId === undefined) return true;
    if (!messageReferenceSchema.safeParse(messageId).success) return false;
    const original = await this.messageRepo.findById(messageId);
    return !!original && original.channelId === channelId && !original.isSystem && (allowDeleted || !original.deletedAt);
  }

  private async resolveBlocks(record: MessageRecord): Promise<ResolvedMessageBlock[] | undefined> {
    if (!record.blocks || record.deletedAt) return undefined;
    return Promise.all(record.blocks.map(async (block): Promise<ResolvedMessageBlock> => {
      if (block.type !== 'reply') return block;
      const reply = await this.resolveReply({ ...record, replyToMessageId: block.messageId });
      if (!reply) throw new Error('Missing resolved message reference');
      return { ...block, reply };
    }));
  }

  private async resolveReply(record: MessageRecord): Promise<MessageReply | undefined> {
    if (!record.replyToMessageId || record.deletedAt) return undefined;
    const original = await this.messageRepo.findById(record.replyToMessageId);
    // A dangling/cross-channel reference must never reveal any original data.
    if (!original || original.channelId !== record.channelId || original.deletedAt) {
      return { messageId: record.replyToMessageId, userNickname: '', content: '', deleted: true, hasAttachments: false };
    }
    const user = original.botAuthor ? null : await this.userRepo.findById(original.userId);
    const attachments = await this.attachmentService.getForMessages([original.id]);
    return {
      messageId: original.id,
      createdAt: original.createdAt,
      userNickname: original.botAuthor?.name ?? user?.nickname ?? 'Usuário Desconhecido',
      content: original.content.slice(0, 200),
      ...(original.botAuthor ? { isBot: true, localizations: botMessagePreviewLocalizations(original.localizations) } : {}),
      deleted: false,
      hasAttachments: (attachments.get(original.id)?.length ?? 0) > 0,
    };
  }

  private botMessage(record: MessageRecord): ChatMessage {
    const author = record.botAuthor;
    if (!author) throw new Error('Expected a persisted bot author.');
    return {
      id: record.id, channelId: record.channelId, userId: author.id, userNickname: author.name,
      userAvatarUrl: this.avatarStorage.getPublicUrl(author.avatarPath), content: record.content,
      localizations: record.localizations,
      createdAt: record.createdAt, isSystem: false, isBot: true, botCommand: record.botCommand,
      editedAt: record.editedAt, deletedAt: record.deletedAt,
    };
  }

  public async setReaction(
    actor: Pick<UserSummary, 'id' | 'nickname'>,
    payload: unknown,
    add: boolean,
    canReact: () => boolean = () => true
  ): Promise<
    | { success: true; event?: ChatReactionEventPayload }
    | { success: false; errorCode: ProtocolErrorCode; errorMessage: string }
  > {
    const userId = actor.id;
    const parsed = chatReactionSchema.safeParse(payload);
    if (!parsed.success) return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Reação inválida.' };
    if (!this.rateLimiter.checkLimit(userId)) {
      return { success: false, errorCode: ProtocolErrorCode.RATE_LIMITED, errorMessage: 'Aguarde antes de reagir novamente.' };
    }
    const { channelId, messageId, emoji } = parsed.data;
    const channel = await this.channelRepo.findById(channelId);
    if (!channel || channel.type !== 'TEXT' || !(await this.canUserAccessChannel(userId, channelId))) {
      return { success: false, errorCode: ProtocolErrorCode.CHANNEL_NOT_FOUND, errorMessage: 'Canal não encontrado.' };
    }
    const message = await this.messageRepo.findById(messageId);
    if (!message || message.channelId !== channelId || message.isSystem || message.deletedAt) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Essa mensagem não pode receber reações.' };
    }
    if (!canReact()) return { success: false, errorCode: ProtocolErrorCode.UNAUTHORIZED, errorMessage: 'Conexão encerrada.' };
    const result = await this.messageRepo.setReaction(messageId, userId, emoji, add);
    if (result === 'limit' || result === 'invalid') {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Reação indisponível ou limite de reações atingido.' };
    }
    return { success: true, event: result === 'changed' ? { ...parsed.data, userId, userNickname: actor.nickname } : undefined };
  }

  private async getReactions(messageIds: string[]): Promise<Map<string, MessageReaction[]>> {
    const result = new Map<string, MessageReaction[]>();
    for (const row of await this.messageRepo.listReactions(messageIds)) {
      let reactions = result.get(row.messageId);
      if (!reactions) { reactions = []; result.set(row.messageId, reactions); }
      let reaction = reactions.find((entry) => entry.emoji === row.emoji);
      if (!reaction) { reaction = { emoji: row.emoji, users: [] }; reactions.push(reaction); }
      reaction.users.push({ userId: row.userId, userNickname: row.userNickname });
    }
    return result;
  }

  public async sendMessage(
    userId: string,
    channelId: string,
    content: string,
    attachmentIds?: string[],
    replyToMessageId?: string,
    rawBlocks?: unknown,
    clientMessageId?: string,
  ): Promise<{
    success: boolean;
    errorCode?: ProtocolErrorCode;
    errorMessage?: string;
    message?: ChatMessage;
    mentionedUserIds?: string[];
    replayed?: boolean;
  }> {
    // Check rate limit
    if (!this.rateLimiter.checkLimit(userId)) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.RATE_LIMITED,
        errorMessage: 'Você está enviando mensagens muito rápido. Aguarde alguns segundos.',
      };
    }

    if (clientMessageId !== undefined && !messageReferenceSchema.safeParse(clientMessageId).success) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Identificador de mensagem inválido.' };
    }
    if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) ||
        attachmentIds.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE ||
        new Set(attachmentIds).size !== attachmentIds.length ||
        attachmentIds.some(id => !messageReferenceSchema.safeParse(id).success))) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Anexos inválidos.' };
    }
    const channel = await this.channelRepo.findById(channelId);
    if (!channel || channel.type !== 'TEXT' || !(await this.canUserAccessChannel(userId, channelId))) {
      return { success: false, errorCode: ProtocolErrorCode.CHANNEL_NOT_FOUND, errorMessage: 'Canal de texto não encontrado' };
    }
    const replay = async (existing: MessageRecord) => {
      if (existing.userId !== userId || existing.channelId !== channelId || existing.isSystem || existing.botAuthor) {
        return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Identificador de mensagem já utilizado.' };
      }
      const [message] = await this.loadHistory(channelId, 1, undefined, existing.id);
      return { success: true, message, replayed: true };
    };
    const existing = clientMessageId ? await this.messageRepo.findById(clientMessageId) : null;
    if (existing) return replay(existing);

    // Validate content. Attachment messages may carry an empty caption; plain
    // text messages must be non-empty (#11).
    const hasAttachments = !!(attachmentIds && attachmentIds.length > 0);
    const parsedBlocks = messageBlocksSchema.optional().safeParse(rawBlocks);
    if (!parsedBlocks.success) return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Blocos de mensagem inválidos.' };
    const blocks = parsedBlocks.data;
    if (blocks) {
      content = messageBlocksContent(blocks);
      replyToMessageId = blocks.find(block => block.type === 'reply')?.messageId;
      for (const block of blocks) {
        if (block.type === 'reply' && !(await this.isValidReply(channelId, block.messageId, true))) {
          return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Mensagem de referência indisponível.' };
        }
      }
    }
    const server = await this.serverRepo.getServer();
    const schema = createMessageContentSchema(server?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH, hasAttachments || !!blocks?.some(block => block.type === 'reply'));
    const parseResult = schema.safeParse(content ?? '');
    if (!parseResult.success) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.MESSAGE_TOO_LONG,
        errorMessage: parseResult.error.errors[0]?.message || 'Mensagem inválida',
      };
    }

    if (!(await this.isValidReply(channelId, replyToMessageId, !!blocks))) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Mensagem de referência indisponível.' };
    }

    const user = await this.userRepo.findById(userId);
    if (!user) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.UNAUTHORIZED,
        errorMessage: 'Usuário não autenticado',
      };
    }

    const now = Date.now();
    const messageRecord: MessageRecord = {
      id: clientMessageId ?? uuidv4(),
      channelId,
      userId: user.id,
      content: parseResult.data,
      blocks,
      replyToMessageId,
      createdAt: now,
      isSystem: false,
    };

    const mentions = await this.collectMentions(user.id, channelId, messageRecord);
    const committed = await this.messageRepo.createChatMessage(messageRecord, attachmentIds ?? [], mentions);
    if (!committed) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Anexo indisponível. Selecione o arquivo novamente.' };
    }
    if (!committed.created) return replay(committed.message);
    const attachments = (await this.attachmentService.getForMessages([messageRecord.id])).get(messageRecord.id) ?? [];

    const chatMessage: ChatMessage = {
      id: messageRecord.id,
      channelId: messageRecord.channelId,
      userId: user.id,
      userNickname: user.nickname,
      userAvatarUrl: this.avatarStorage.getPublicUrl(user.avatarPath),
      content: messageRecord.content,
      createdAt: messageRecord.createdAt,
      isSystem: false,
      attachments: attachments.length > 0 ? attachments : undefined,
      reply: await this.resolveReply(messageRecord),
      blocks: await this.resolveBlocks(messageRecord),
    };

    return {
      success: true,
      message: chatMessage,
      mentionedUserIds: mentions.map(mention => mention.userId),
    };
  }

  /**
   * Rewrites a message the caller wrote (#504).
   *
   * Only the author may edit, and only while the server allows it: editing
   * rewrites what other people already read, so it is a server-level decision
   * rather than a per-user one. System messages and already-deleted messages
   * are never editable.
   *
   * Mentions are deliberately *not* recomputed: pinging someone by editing a
   * message they already scrolled past would be a notification they cannot
   * trace back to anything they saw arrive.
   */
  public async editMessage(
    userId: string,
    channelId: string,
    messageId: string,
    content: string
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; message?: ChatMessage }> {
    const server = await this.serverRepo.getServer();
    if (server?.allowMessageEdit === false) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.PERMISSION_DENIED,
        errorMessage: 'A edição de mensagens está desabilitada neste servidor.',
      };
    }

    const existing = await this.messageRepo.findById(messageId);
    if (!existing || existing.channelId !== channelId) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: 'Mensagem não encontrada.',
      };
    }
    if (existing.isSystem || existing.deletedAt) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: 'Essa mensagem não pode ser editada.',
      };
    }
    if (existing.userId !== userId) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.PERMISSION_DENIED,
        errorMessage: 'Você só pode editar as suas próprias mensagens.',
      };
    }

    // An attachment message may end up with an empty caption; a plain text
    // message may not be emptied by an edit — that is what deleting is for.
    const attachments = (await this.attachmentService.getForMessages([messageId])).get(messageId) ?? [];
    const schema = createMessageContentSchema(server?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH, attachments.length > 0);
    const parseResult = schema.safeParse(content ?? '');
    if (!parseResult.success) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.MESSAGE_TOO_LONG,
        errorMessage: parseResult.error.errors[0]?.message || 'Mensagem inválida',
      };
    }

    const editedAt = Date.now();
    const blocks: MessageBlock[] | undefined = existing.blocks
      ? [...existing.blocks.filter(block => block.type === 'reply'), { type: 'text', text: parseResult.data }] : undefined;
    await this.messageRepo.updateContent(messageId, parseResult.data, editedAt, blocks);

    const user = await this.userRepo.findById(existing.userId);
    return {
      success: true,
      message: {
        id: existing.id,
        channelId: existing.channelId,
        userId: existing.userId,
        userNickname: existing.botAuthor?.name ?? user?.nickname ?? 'Usuário Desconhecido',
        userAvatarUrl: this.avatarStorage.getPublicUrl(existing.botAuthor?.avatarPath ?? user?.avatarPath),
        isBot: !!existing.botAuthor,
        botCommand: existing.botCommand,
        content: parseResult.data,
        createdAt: existing.createdAt,
        isSystem: false,
        attachments: attachments.length > 0 ? attachments : undefined,
        editedAt,
        deletedAt: null,
        reactions: (await this.getReactions([messageId])).get(messageId) ?? [],
        reply: await this.resolveReply(existing),
        blocks: await this.resolveBlocks({ ...existing, blocks }),
      },
    };
  }

  /**
   * Deletes a message (#504). The row survives with an empty content and a
   * `deletedAt` stamp so readers see a "message deleted" placeholder where it
   * was, instead of the conversation silently reshuffling around a gap.
   *
   * `canModerate` is resolved by the caller from the permission layer, so this
   * service stays unaware of roles: authors delete their own, moderators delete
   * anyone's.
   */
  public async deleteMessage(
    userId: string,
    channelId: string,
    messageId: string,
    canModerate: boolean
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; message?: ChatMessage }> {
    const existing = await this.messageRepo.findById(messageId);
    if (!existing || existing.channelId !== channelId) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: 'Mensagem não encontrada.',
      };
    }
    if (existing.isSystem) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: 'Mensagens do sistema não podem ser apagadas.',
      };
    }
    if (existing.userId !== userId && !canModerate) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.PERMISSION_DENIED,
        errorMessage: 'Você só pode apagar as suas próprias mensagens.',
      };
    }

    // Already deleted: report success so a double click (or two moderators at
    // once) settles on the same state instead of raising an error.
    const deletedAt = existing.deletedAt ?? Date.now();
    if (!existing.deletedAt) {
      await this.messageRepo.markDeleted(messageId, deletedAt);
    }

    const user = await this.userRepo.findById(existing.userId);
    return {
      success: true,
      message: {
        id: existing.id,
        channelId: existing.channelId,
        userId: existing.userId,
        userNickname: existing.botAuthor?.name ?? user?.nickname ?? 'Usuário Desconhecido',
        userAvatarUrl: this.avatarStorage.getPublicUrl(existing.botAuthor?.avatarPath ?? user?.avatarPath),
        isBot: !!existing.botAuthor,
        botCommand: existing.botCommand,
        content: '',
        createdAt: existing.createdAt,
        isSystem: false,
        editedAt: existing.editedAt ?? null,
        deletedAt,
      },
    };
  }

  /**
   * Detects @-mentions in a message and persists an unread mention row for every
   * mentioned user except the author (#14). Matching mirrors the client dropup:
   * a case-insensitive substring `@<nickname>` (nicknames may contain spaces, so
   * a token split is not reliable). Returns the list of mentioned user ids so the
   * caller can notify online users in real time.
   *
   * `@todos` / `@everyone` mentions everyone who can see the channel, when the
   * server allows it (#464).
   */
  private async collectMentions(
    authorId: string,
    channelId: string,
    message: MessageRecord
  ): Promise<MentionRecord[]> {
    const lowerContent = message.content.toLowerCase();
    if (!lowerContent.includes('@')) return [];

    const allUsers = await this.userRepo.listAll();
    const mentions: MentionRecord[] = [];

    let mentionsEveryone = hasEveryoneMention(message.content);
    if (mentionsEveryone) {
      const server = await this.serverRepo.getServer();
      if (server?.allowEveryoneMention === false) mentionsEveryone = false;
    }

    for (const candidate of allUsers) {
      if (candidate.id === authorId) continue;

      const nickname = candidate.nickname.trim().toLowerCase();
      if (!mentionsEveryone && !(nickname && lowerContent.includes('@' + nickname))) continue;
      if (!(await this.canUserReadMessages(candidate.id))
        || !(await this.canUserAccessChannel(candidate.id, channelId))) continue;

      const mention: MentionRecord = {
        id: uuidv4(),
        userId: candidate.id,
        channelId,
        messageId: message.id,
        createdAt: message.createdAt,
      };
      mentions.push(mention);
    }

    return mentions;
  }

  /** Clears unread mentions for a user in a channel when they open it (#14). */
  public async markMentionsRead(userId: string, channelId: string): Promise<void> {
    await this.mentionRepo.clearForUserChannel(userId, channelId);
  }

  public async loadHistory(
    channelId: string,
    limit: number = LIMITS.MAX_HISTORY_MESSAGES_INITIAL,
    beforeTimestamp?: number,
    aroundMessageId?: string
  ): Promise<ChatMessage[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(LIMITS.MAX_HISTORY_MESSAGES_INITIAL, Math.floor(limit)))
      : LIMITS.MAX_HISTORY_MESSAGES_INITIAL;
    const target = aroundMessageId ? await this.messageRepo.findById(aroundMessageId) : null;
    if (aroundMessageId && (!target || target.channelId !== channelId)) return [];
    const rawMessages = target
      ? [...(boundedLimit > 1 ? await this.messageRepo.listByChannel(channelId, boundedLimit - 1, target.createdAt) : []), target]
      : await this.messageRepo.listByChannel(channelId, boundedLimit, beforeTimestamp);
    const uniqueUserIds = [...new Set(rawMessages.map((m) => m.userId))];
    const users = await this.userRepo.findByIds(uniqueUserIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const attachmentsByMessage = await this.attachmentService.getForMessages(rawMessages.map((m) => m.id));
    const reactionsByMessage = await this.getReactions(rawMessages.filter((m) => !m.deletedAt && !m.isSystem).map((m) => m.id));

    return Promise.all(rawMessages.map(async (m) => {
      const user = userMap.get(m.userId);
      // A deleted message keeps its row but nothing of its content: its files
      // must not travel to clients either (#504).
      const attachments = m.deletedAt ? undefined : attachmentsByMessage.get(m.id);
      return {
        id: m.id,
        channelId: m.channelId,
        userId: m.userId,
        userNickname: m.botAuthor?.name ?? user?.nickname ?? 'Usuário Desconhecido',
        userAvatarUrl: this.avatarStorage.getPublicUrl(m.botAuthor?.avatarPath ?? user?.avatarPath),
        isBot: !!m.botAuthor,
        botCommand: m.botCommand,
        content: m.deletedAt ? '' : m.content,
        localizations: m.deletedAt ? undefined : m.localizations,
        createdAt: m.createdAt,
        isSystem: m.isSystem,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        editedAt: m.editedAt ?? null,
        deletedAt: m.deletedAt ?? null,
        reactions: reactionsByMessage.get(m.id) ?? [],
        reply: await this.resolveReply(m),
        blocks: await this.resolveBlocks(m),
      };
    }));
  }
}
