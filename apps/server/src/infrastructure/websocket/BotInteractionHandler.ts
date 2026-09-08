import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import {
  BotCommandMessagePayload,
  BotForm,
  ChannelSummary,
  CommandExecutionPayload,
  CommandFinishReason,
  CommandFinishedPayload,
  CommandInvokedPayload,
  CommandPromptReceivedPayload,
  CommandSubmitPayload,
  LIMITS,
  MessageType,
  Permission,
  ProtocolErrorCode,
  ProtocolMessage,
  UserSummary,
  canAccessChannel,
  commandCancelSchema,
  commandFinishSchema,
  commandInvokeSchema,
  commandPromptSchema,
  commandResponseSchema,
  commandSubmitSchema,
  hasPermission,
  validateBotFormValues,
  validateCommandOptions,
} from '@monky/shared';
import { ChannelAccessContext, ChannelService } from '../../application/services/ChannelService';
import { CommandRegistry } from '../../application/services/CommandRegistry';
import { UserService } from '../../application/services/UserService';

export interface BotInteractionSession {
  ws: WebSocket;
  user?: UserSummary;
  sessionId?: string;
  isBot?: boolean;
  botId?: string;
}

interface InteractionTransport {
  isCurrent(session: BotInteractionSession): boolean;
  findBot(botId: string): BotInteractionSession | undefined;
  send(ws: WebSocket, message: ProtocolMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcastToChannel(channelId: string, message: ProtocolMessage, canSend: () => boolean): Promise<void>;
}

interface Invocation {
  id: string;
  origin: BotInteractionSession;
  bot: BotInteractionSession;
  invokerId: string;
  invokerNickname: string;
  invokerAvatarUrl: string | null;
  botId: string;
  channelId: string;
  commandName: string;
  locale?: 'pt-BR' | 'en';
  expiresAt: number;
  timer: NodeJS.Timeout;
  pending?: { interactionId: string; form: BotForm };
  usedInteractionIds: Set<string>;
}

// A fixed invocation lifetime and a turn cap also bound the replay-id set.
const MAX_PROMPTS_PER_INVOCATION = 100;

export class BotInteractionHandler {
  private invocations = new Map<string, Invocation>();
  private byOrigin = new Map<WebSocket, Set<string>>();
  private closed = false;

  constructor(
    private transport: InteractionTransport,
    private channelService: ChannelService,
    private userService: UserService,
    private registry: CommandRegistry
  ) {}

  async invoke(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const user = session.user;
    if (!user || session.isBot) {
      this.error(session, ProtocolErrorCode.PERMISSION_DENIED, requestId);
      return;
    }
    const parsed = commandInvokeSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
      return;
    }
    const input = parsed.data;
    const accessError = await this.getAccessError(user.id, input.channelId);
    if (!this.transport.isCurrent(session) || this.closed) return;
    if (accessError) {
      this.error(session, accessError, requestId);
      return;
    }

    const bot = this.transport.findBot(input.botId);
    if (!bot?.user || !bot.isBot || bot.botId !== input.botId || !this.transport.isCurrent(bot)) {
      this.error(session, ProtocolErrorCode.BOT_OFFLINE, requestId);
      return;
    }
    const command = this.registry.find(input.botId, input.commandName);
    if (!command) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND, requestId);
      return;
    }
    const options = validateCommandOptions(command.options ?? [], input.options);
    if (!options.success) {
      this.error(session, ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
      return;
    }
    for (const option of command.options ?? []) {
      const value = options.values[option.name];
      if (option.type === 'user' && typeof value === 'string' && !(await this.userService.isMember(value))) {
        this.error(session, ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
        return;
      }
    }

    // Service calls can yield to a disconnect, replacement, or registry edit.
    if (!this.transport.isCurrent(session) || this.closed) return;
    if (!this.transport.isCurrent(bot)) {
      this.error(session, ProtocolErrorCode.BOT_OFFLINE, requestId);
      return;
    }
    if (this.registry.find(input.botId, input.commandName) !== command) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND, requestId);
      return;
    }
    if (
      this.invocations.size >= LIMITS.MAX_BOT_INVOCATIONS ||
      (this.byOrigin.get(session.ws)?.size ?? 0) >= LIMITS.MAX_BOT_INVOCATIONS_PER_SESSION
    ) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_BUSY, requestId);
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      const invocation = this.invocations.get(id);
      if (invocation) this.finish(invocation, 'expired');
    }, LIMITS.BOT_INTERACTION_TIMEOUT_MS);
    timer.unref();
    const invocation: Invocation = {
      id,
      origin: session,
      bot,
      invokerId: user.id,
      invokerNickname: user.nickname,
      invokerAvatarUrl: user.avatarUrl ?? null,
      botId: input.botId,
      channelId: input.channelId,
      commandName: input.commandName,
      locale: input.locale,
      expiresAt: Date.now() + LIMITS.BOT_INTERACTION_TIMEOUT_MS,
      timer,
      usedInteractionIds: new Set(),
    };
    this.invocations.set(id, invocation);
    const ids = this.byOrigin.get(session.ws) ?? new Set<string>();
    ids.add(id);
    this.byOrigin.set(session.ws, ids);

    const acknowledged: CommandInvokedPayload = {
      invocationId: id, channelId: input.channelId, botId: input.botId, commandName: input.commandName,
    };
    this.transport.send(session.ws, { type: MessageType.COMMAND_INVOKED, requestId, payload: acknowledged });
    const execution: CommandExecutionPayload = {
      ...input,
      options: options.values,
      invocationId: id,
      invokerId: user.id,
      invokerNickname: user.nickname,
    };
    this.transport.send(bot.ws, { type: MessageType.COMMAND_INVOKE, payload: execution });
  }

  async respond(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = commandResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'bot', requestId);
    if (!invocation || !(await this.authorize(invocation, session, requestId))) return;
    const botUser = invocation.bot.user;
    if (!botUser) return;

    const response: BotCommandMessagePayload = {
      invocationId: invocation.id,
      commandName: invocation.commandName,
      invokerId: invocation.invokerId,
      invokerNickname: invocation.invokerNickname,
      invokerAvatarUrl: invocation.invokerAvatarUrl,
      content: parsed.data.content,
      ephemeral: parsed.data.ephemeral !== false,
      messageId: randomUUID(),
      channelId: invocation.channelId,
      botId: invocation.botId,
      botName: botUser.nickname,
      botAvatarUrl: botUser.avatarUrl,
      createdAt: Date.now(),
    };
    const message: ProtocolMessage<BotCommandMessagePayload> = { type: MessageType.COMMAND_RESPONSE, payload: response };
    if (response.ephemeral) {
      this.transport.send(invocation.origin.ws, message);
    } else {
      await this.transport.broadcastToChannel(invocation.channelId, message, () => this.isActive(invocation));
    }
  }

  async prompt(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = commandPromptSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'bot', requestId);
    if (!invocation || !(await this.authorize(invocation, session, requestId))) return;
    const { interactionId, form } = parsed.data;
    if (invocation.pending || invocation.usedInteractionIds.has(interactionId)) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    if (invocation.usedInteractionIds.size >= MAX_PROMPTS_PER_INVOCATION) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_BUSY, requestId);
      return;
    }
    const botUser = invocation.bot.user;
    if (!botUser) return;
    invocation.usedInteractionIds.add(interactionId);
    invocation.pending = { interactionId, form };
    const received: CommandPromptReceivedPayload = {
      ...parsed.data,
      channelId: invocation.channelId,
      botId: invocation.botId,
      botName: botUser.nickname,
      botAvatarUrl: botUser.avatarUrl,
      expiresAt: invocation.expiresAt,
    };
    this.transport.send(invocation.origin.ws, { type: MessageType.COMMAND_PROMPT, payload: received });
  }

  async submit(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = commandSubmitSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'origin', requestId);
    if (!invocation || !(await this.authorize(invocation, session, requestId))) return;
    const pending = invocation.pending;
    if (!pending || pending.interactionId !== parsed.data.interactionId) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const validated = validateBotFormValues(pending.form, parsed.data.values);
    if (!validated.success) {
      this.error(session, ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
      return;
    }

    invocation.pending = undefined;
    const submitted: CommandSubmitPayload = {
      invocationId: invocation.id,
      interactionId: pending.interactionId,
      values: validated.values,
    };
    // Consume once and acknowledge before the bot can immediately ask the next
    // question. Neither forged nor invalid submissions consume the stored form.
    this.transport.send(session.ws, { type: MessageType.COMMAND_SUBMITTED, requestId, payload: submitted });
    this.transport.send(invocation.bot.ws, { type: MessageType.COMMAND_SUBMITTED, payload: submitted });
  }

  cancel(session: BotInteractionSession, payload: unknown, requestId?: string): void {
    const parsed = commandCancelSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'origin', requestId);
    if (invocation) this.finish(invocation, 'cancelled', session, requestId);
  }

  complete(session: BotInteractionSession, payload: unknown, requestId?: string): void {
    const parsed = commandFinishSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'bot', requestId);
    if (invocation) this.finish(invocation, parsed.data.failed ? 'failed' : 'completed', session, requestId);
  }

  disconnect(session: BotInteractionSession): void {
    for (const invocation of this.invocations.values()) {
      if (invocation.bot === session) this.finish(invocation, 'bot_disconnected');
      else if (invocation.origin === session) this.finish(invocation, 'caller_disconnected');
    }
  }

  deleteChannel(channelId: string): void {
    for (const invocation of this.invocations.values()) {
      if (invocation.channelId === channelId) this.finish(invocation, 'cancelled');
    }
  }

  reconcileAccess(
    channels: ReadonlyMap<string, ChannelSummary>,
    contexts: ReadonlyMap<string, ChannelAccessContext>
  ): void {
    for (const invocation of this.invocations.values()) {
      if (!this.isActive(invocation)) continue;
      const channel = channels.get(invocation.channelId);
      const context = contexts.get(invocation.invokerId);
      if (
        !channel || channel.type !== 'TEXT' || !context ||
        !hasPermission(context.permissions, Permission.SEND_MESSAGES) ||
        !canAccessChannel(channel, context.permissions, context.roleIds)
      ) {
        this.finish(invocation, 'cancelled');
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const invocation of this.invocations.values()) this.finish(invocation, 'failed');
  }

  private findOwned(
    session: BotInteractionSession,
    invocationId: string,
    endpoint: 'origin' | 'bot',
    requestId?: string
  ): Invocation | undefined {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_EXPIRED, requestId);
      return undefined;
    }
    if (invocation[endpoint] !== session || (endpoint === 'bot' && (!session.isBot || session.botId !== invocation.botId))) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return undefined;
    }
    if (!this.isActive(invocation)) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_EXPIRED, requestId);
      return undefined;
    }
    return invocation;
  }

  private isActive(invocation: Invocation): boolean {
    if (this.invocations.get(invocation.id) !== invocation) return false;
    if (Date.now() >= invocation.expiresAt) this.finish(invocation, 'expired');
    else if (!this.transport.isCurrent(invocation.bot)) this.finish(invocation, 'bot_disconnected');
    else if (!this.transport.isCurrent(invocation.origin)) this.finish(invocation, 'caller_disconnected');
    else return true;
    return false;
  }

  private async authorize(invocation: Invocation, requester: BotInteractionSession, requestId?: string): Promise<boolean> {
    const accessError = await this.getAccessError(invocation.invokerId, invocation.channelId);
    if (!this.isActive(invocation)) {
      this.error(requester, ProtocolErrorCode.BOT_INTERACTION_EXPIRED, requestId);
      return false;
    }
    if (accessError) {
      this.finish(invocation, 'cancelled');
      this.error(requester, accessError, requestId);
      return false;
    }
    return true;
  }

  private async getAccessError(userId: string, channelId: string): Promise<ProtocolErrorCode | undefined> {
    const [channel, context, isMember] = await Promise.all([
      this.channelService.getChannelSummary(channelId),
      this.channelService.getAccessContext(userId),
      this.userService.isMember(userId),
    ]);
    if (!isMember) return ProtocolErrorCode.UNAUTHORIZED;
    if (!hasPermission(context.permissions, Permission.SEND_MESSAGES)) return ProtocolErrorCode.PERMISSION_DENIED;
    if (!channel || channel.type !== 'TEXT' || !canAccessChannel(channel, context.permissions, context.roleIds)) {
      return ProtocolErrorCode.CHANNEL_NOT_FOUND;
    }
    return undefined;
  }

  private finish(
    invocation: Invocation,
    reason: CommandFinishReason,
    requester?: BotInteractionSession,
    requestId?: string
  ): void {
    if (!this.invocations.delete(invocation.id)) return;
    clearTimeout(invocation.timer);
    invocation.pending = undefined;
    invocation.usedInteractionIds.clear();
    const ids = this.byOrigin.get(invocation.origin.ws);
    ids?.delete(invocation.id);
    if (ids?.size === 0) this.byOrigin.delete(invocation.origin.ws);
    const payload: CommandFinishedPayload = { invocationId: invocation.id, channelId: invocation.channelId, reason };
    for (const endpoint of [invocation.origin, invocation.bot]) {
      this.transport.send(endpoint.ws, {
        type: MessageType.COMMAND_FINISHED,
        requestId: endpoint === requester ? requestId : undefined,
        payload,
      });
    }
  }

  private error(session: BotInteractionSession, code: ProtocolErrorCode, requestId?: string): void {
    this.transport.sendError(session.ws, code, 'Não foi possível processar a interação com o bot.', requestId);
  }
}
