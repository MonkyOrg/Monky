import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import {
  BotCommandMessagePayload,
  BotForm,
  BotSettingsContext,
  ChannelSummary,
  CommandAutocompleteExecutionPayload,
  CommandAutocompletePayload,
  CommandAutocompleteResultPayload,
  CommandAudioPreviewExecutionPayload,
  CommandAudioPreviewResult,
  CommandExecutionPayload,
  CommandFinishReason,
  CommandFinishedPayload,
  CommandInvokedPayload,
  CommandPromptReceivedPayload,
  CommandSubmitPayload,
  CommandSoundDownloadReceivedPayload,
  CommandSoundDownloadResultPayload,
  LIMITS,
  MessageType,
  Permission,
  ProtocolErrorCode,
  ProtocolMessage,
  SlashCommand,
  SoundDownloadResult,
  UserSummary,
  canAccessChannel,
  commandAutocompleteCancelSchema,
  commandAutocompleteResultSchema,
  commandAutocompleteSchema,
  commandAudioPreviewCancelSchema,
  commandAudioPreviewResultSchema,
  commandAudioPreviewSchema,
  commandCancelSchema,
  commandFinishSchema,
  commandInvokeSchema,
  commandPromptSchema,
  commandResponseSchema,
  commandRequestIdSchema,
  commandSoundDownloadResultSchema,
  commandSoundDownloadSchema,
  commandSubmitSchema,
  hasPermission,
  validateBotFormValues,
  validateCommandOptions,
  resolveBotSettingsValues,
  botVoiceContextRequestSchema,
  type BotVoiceContextResult,
  type LocalCapabilityId,
  type LocalPreviewReference,
  type LocalRequestContext,
  type LocalTaskCancellationCause,
} from '@monky/shared';
import { ChannelAccessContext, ChannelService } from '../../application/services/ChannelService';
import { CommandRegistry } from '../../application/services/CommandRegistry';
import { UserService } from '../../application/services/UserService';
import { RateLimiter } from '../security/RateLimiter';
import { Logger } from '../logger/Logger';
import { BotSettingsError, BotSettingsService } from '../../application/services/BotSettingsService';
import type { BotLocalContext } from '../../application/services/BotLocalExecutionService';

export interface BotInteractionSession {
  ws: WebSocket;
  user?: UserSummary;
  sessionId?: string;
  isBot?: boolean;
  botId?: string;
  botPublicKey?: string;
  botSettingsReady?: boolean;
}

export interface SelectorInvocationAuthorization {
  creatorUserId: string;
  isCurrent(): boolean;
}

export interface VoiceInvocationAuthorization extends SelectorInvocationAuthorization {
  originChannelId: string;
}

interface InteractionTransport {
  getVoiceChannelId?(sessionId: string): string | null;
  isCurrent(session: BotInteractionSession): boolean;
  findBot(botId: string): BotInteractionSession | undefined;
  send(ws: WebSocket, message: ProtocolMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcastToChannel(channelId: string, message: ProtocolMessage, canSend: () => boolean): Promise<void>;
  publishResponse(session: BotInteractionSession, response: BotCommandMessagePayload, canSend: () => boolean, requestId?: string): Promise<void>;
  localContextEnded?(context: Exclude<LocalRequestContext, { kind: 'source' }>, cause: LocalTaskCancellationCause): void;
  consumeLocalPreview?(
    bot: BotInteractionSession, origin: BotInteractionSession, contextId: string, requestId: string, result: LocalPreviewReference,
  ): Promise<boolean>;
}

interface Invocation {
  id: string;
  /** Original client correlation, distinct from the server-issued invocation ID. */
  requestId?: string;
  origin: BotInteractionSession;
  bot: BotInteractionSession;
  invokerId: string;
  invokerNickname: string;
  invokerAvatarUrl: string | null;
  botId: string;
  channelId: string;
  commandName: string;
  localCapabilities?: SlashCommand['localCapabilities'];
  voiceRequirement?: SlashCommand['voiceRequirement'];
  voiceChannelId?: string | null;
  locale?: 'pt-BR' | 'en';
  expiresAt: number;
  timer: NodeJS.Timeout;
  pending?: { interactionId: string; form: BotForm };
  usedInteractionIds: Set<string>;
  allowSoundDownload: boolean;
  soundDownloadUsed: boolean;
  soundDownload?: PendingSoundDownload;
}

interface PendingSoundDownload {
  id: string;
  requestId: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface Autocomplete {
  id: string;
  requestId: string;
  search: AutocompleteSearch;
  origin: BotInteractionSession;
  bot: BotInteractionSession;
  invokerId: string;
  channelId: string;
  command: SlashCommand;
  localCapabilities?: SlashCommand['localCapabilities'];
  voiceChannelId?: string | null;
  optionName: string;
  locale: 'pt-BR' | 'en';
  settings?: BotSettingsContext;
  completed: boolean;
  choices?: Map<string, string>;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface AutocompleteSearch {
  origin: BotInteractionSession;
  sessionId?: string;
  invokerId: string;
  key: string;
  bot: BotInteractionSession;
  command: SlashCommand;
  pages: Map<string, Autocomplete>;
  pending?: Autocomplete;
  preview?: AudioPreview;
}

interface AudioPreview {
  id: string;
  requestId: string;
  autocomplete: Autocomplete;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

// A fixed invocation lifetime and a turn cap also bound the replay-id set.
const MAX_PROMPTS_PER_INVOCATION = 100;

export class BotInteractionHandler {
  private invocations = new Map<string, Invocation>();
  private byOrigin = new Map<WebSocket, Set<string>>();
  private autocompletes = new Map<string, Autocomplete>();
  private autocompleteByOrigin = new Map<WebSocket, AutocompleteSearch>();
  private audioPreviews = new Map<string, AudioPreview>();
  private autocompleteLimiter = new RateLimiter();
  private closed = false;

  constructor(
    private transport: InteractionTransport,
    private channelService: ChannelService,
    private userService: UserService,
    private registry: CommandRegistry,
    private settings?: BotSettingsService
  ) {}

  async autocomplete(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const user = session.user;
    const invokerSessionId = session.sessionId;
    if (!user || !invokerSessionId || session.isBot) {
      this.error(session, ProtocolErrorCode.PERMISSION_DENIED, requestId);
      return;
    }
    if (this.closed || !this.transport.isCurrent(session)) return;
    const parsed = commandAutocompleteSchema.safeParse(payload);
    const correlation = commandRequestIdSchema.safeParse(requestId);
    if (!parsed.success || !correlation.success) {
      this.error(session, !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === 'userSettings')
        ? ProtocolErrorCode.BOT_SETTINGS_INVALID : ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
      return;
    }
    const input = parsed.data;
    const bot = this.transport.findBot(input.botId);
    const command = this.registry.find(input.botId, input.commandName);
    const voiceChannelId = command?.voiceRequirement && session.sessionId
      ? this.transport.getVoiceChannelId?.(session.sessionId) ?? undefined : undefined;
    const key = this.autocompleteSearchKey(input, voiceChannelId);
    let search = this.autocompleteByOrigin.get(session.ws);
    // Invalidate a changed search before throttling, but do not revoke earlier
    // pages when a continuation is merely rejected or its provider fails.
    if (search && ((input.page ?? 0) === 0 || search.origin !== session ||
        search.sessionId !== session.sessionId || search.invokerId !== user.id ||
        search.key !== key || search.bot !== bot || search.command !== command)) {
      this.cancelAutocompleteForOrigin(search.origin);
      search = undefined;
    }
    if (!this.autocompleteLimiter.checkLimit(user.id, 1, LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS)) {
      this.error(session, ProtocolErrorCode.RATE_LIMITED, requestId);
      return;
    }
    if (!bot?.user || !bot.isBot || bot.botId !== input.botId || !this.transport.isCurrent(bot)) {
      this.error(session, ProtocolErrorCode.BOT_OFFLINE, requestId);
      return;
    }
    if (!command) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND, requestId);
      return;
    }
    const option = command.options?.find((item) => item.name === input.optionName);
    const options = validateCommandOptions(command.options ?? [], input.options, { partial: true });
    if (!option?.autocomplete || option.type !== 'string' || !options.success ||
        Object.prototype.hasOwnProperty.call(input.options ?? {}, input.optionName)) {
      this.error(session, ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
      return;
    }
    if (search?.pages.has(correlation.data)) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    if (this.autocompletes.size - (search?.pending ? 1 : 0) >= LIMITS.MAX_BOT_AUTOCOMPLETE_REQUESTS) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_BUSY, requestId);
      return;
    }
    const voiceError = this.getVoiceAccessError(session, bot, command.voiceRequirement, voiceChannelId);
    if (voiceError) {
      this.cancelAutocompleteForOrigin(session);
      this.error(session, voiceError, requestId);
      return;
    }
    if (search?.pending) this.dropAutocomplete(search.pending, true);
    search ??= {
      origin: session, sessionId: session.sessionId, invokerId: user.id,
      key, bot, command, pages: new Map(),
    };
    const id = randomUUID();
    const timer = setTimeout(() => {
      const pending = this.autocompletes.get(id);
      if (pending) {
        void this.expireAutocomplete(pending).catch(() => this.failAutocomplete(pending, ProtocolErrorCode.INTERNAL_ERROR));
      }
    }, LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS);
    timer.unref();
    const pending: Autocomplete = {
      id, requestId: correlation.data, search, origin: session, bot, invokerId: user.id, completed: false,
      channelId: input.channelId, command, voiceChannelId, optionName: input.optionName, locale: input.locale ?? 'pt-BR', timer,
      localCapabilities: command.localCapabilities?.slice(),
      expiresAt: Date.now() + LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS,
    };
    this.autocompletes.set(id, pending);
    search.pages.set(pending.requestId, pending);
    search.pending = pending;
    this.autocompleteByOrigin.set(session.ws, search);
    try {
      for (const definition of command.options ?? []) {
        const value = options.values[definition.name];
        if (definition.type === 'user' && typeof value === 'string' && !(await this.userService.isMember(value))) {
          this.failAutocomplete(pending, ProtocolErrorCode.BOT_INVALID_OPTIONS);
          return;
        }
      }
      if (!(await this.authorizeAutocomplete(pending))) return;
      if (Date.now() >= pending.expiresAt) {
        this.finishAutocomplete(pending, { status: 'failed', reason: 'timeout' }, true);
        return;
      }
      const execution: CommandAutocompleteExecutionPayload = {
        botId: pending.command.botId, channelId: pending.channelId,
        invokerId: pending.invokerId, invokerSessionId, invokerNickname: user.nickname,
        invokerVoiceChannelId: this.transport.getVoiceChannelId?.(invokerSessionId) ?? null,
        commandName: input.commandName, optionName: input.optionName, query: input.query,
        options: options.values, locale: input.locale ?? 'pt-BR',
        ...(input.page !== undefined ? { page: input.page } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...this.settingsPayload(input.botId, input.userSettings),
      };
      pending.settings = execution.settings;
      this.transport.send(bot.ws, { type: MessageType.COMMAND_AUTOCOMPLETE, requestId: id, payload: execution });
    } catch (error) {
      this.failAutocomplete(pending, error instanceof BotSettingsError ? error.code : ProtocolErrorCode.INTERNAL_ERROR,
        error instanceof BotSettingsError ? error.message : undefined);
    }
  }

  async autocompleteResult(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const correlation = commandRequestIdSchema.safeParse(requestId);
    const pending = correlation.success ? this.autocompletes.get(correlation.data) : undefined;
    if (!pending) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_EXPIRED, requestId);
      return;
    }
    if (pending.bot !== session || !session.isBot || session.botId !== pending.command.botId) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    if (pending.completed) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const parsed = commandAutocompleteResultSchema.safeParse(payload);
    if (!(await this.authorizeAutocomplete(pending))) return;
    if (pending.completed) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const result: CommandAutocompleteResultPayload = Date.now() >= pending.expiresAt
      ? { status: 'failed', reason: 'timeout' }
      : parsed.success ? parsed.data : { status: 'failed', reason: 'invalid_response' };
    this.finishAutocomplete(pending, result, result.status === 'failed' && result.reason === 'timeout');
  }

  cancelAutocomplete(session: BotInteractionSession, payload: unknown, requestId?: string): void {
    const parsed = commandAutocompleteCancelSchema.safeParse(payload);
    if (!parsed.success || session.isBot || !session.user) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const search = this.autocompleteByOrigin.get(session.ws);
    const pending = search?.origin === session ? search.pages.get(parsed.data.requestId) : undefined;
    if (pending) this.dropAutocomplete(pending, true);
  }

  async audioPreview(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const user = session.user;
    const invokerSessionId = session.sessionId;
    if (!user || !invokerSessionId || session.isBot) {
      this.error(session, ProtocolErrorCode.PERMISSION_DENIED, requestId);
      return;
    }
    if (this.closed || !this.transport.isCurrent(session)) return;
    const parsed = commandAudioPreviewSchema.safeParse(payload);
    const correlation = commandRequestIdSchema.safeParse(requestId);
    if (!parsed.success || !correlation.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const input = parsed.data;
    const search = this.autocompleteByOrigin.get(session.ws);
    if (!search || search.origin !== session || ![...search.pages.values()].some((page) => page.choices)) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_EXPIRED, requestId);
      return;
    }
    const pending = search.pages.get(input.autocompleteRequestId);
    if (!pending?.choices) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const resourceId = pending.choices.get(input.resourceId);
    if (pending.requestId !== input.autocompleteRequestId || pending.command.botId !== input.botId ||
        pending.command.name !== input.commandName || pending.channelId !== input.channelId ||
        pending.optionName !== input.optionName || pending.invokerId !== user.id || resourceId === undefined ||
        search.preview?.requestId === correlation.data) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    if (search.preview) this.completeAudioPreview(search.preview, { status: 'failed', reason: 'expired' }, true);
    if (this.audioPreviews.size >= LIMITS.MAX_BOT_AUDIO_PREVIEW_REQUESTS) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_BUSY, requestId);
      return;
    }
    const id = randomUUID();
    const expiresAt = Math.min(pending.expiresAt, Date.now() + LIMITS.BOT_AUDIO_PREVIEW_TIMEOUT_MS);
    const timer = setTimeout(() => {
      this.completeAudioPreview(preview, { status: 'failed', reason: 'timeout' }, true);
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref();
    const preview: AudioPreview = { id, requestId: correlation.data, autocomplete: pending, expiresAt, timer };
    search.preview = preview;
    this.audioPreviews.set(id, preview);
    try {
      if (!(await this.authorizeAudioPreview(preview))) return;
      const execution: CommandAudioPreviewExecutionPayload = {
        botId: pending.command.botId, channelId: pending.channelId,
        invokerId: pending.invokerId, invokerSessionId, invokerNickname: user.nickname,
        invokerVoiceChannelId: this.transport.getVoiceChannelId?.(invokerSessionId) ?? null,
        commandName: pending.command.name, optionName: pending.optionName, resourceId,
        locale: pending.locale, ...(pending.settings ? { settings: pending.settings } : {}),
      };
      this.transport.send(pending.bot.ws, {
        type: MessageType.COMMAND_AUDIO_PREVIEW, requestId: id, payload: execution,
      });
    } catch (error) {
      Logger.error('BOT', 'Could not authorize an audio preview', error);
      this.completeAudioPreview(preview, { status: 'failed', reason: 'handler_failed' }, true);
    }
  }

  async audioPreviewResult(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const correlation = commandRequestIdSchema.safeParse(requestId);
    const preview = correlation.success ? this.audioPreviews.get(correlation.data) : undefined;
    if (!preview) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_EXPIRED, requestId);
      return;
    }
    if (preview.autocomplete.bot !== session || !session.isBot || session.botId !== preview.autocomplete.command.botId) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const parsed = commandAudioPreviewResultSchema.safeParse(payload);
    try {
      if (!(await this.authorizeAudioPreview(preview))) return;
      let result: CommandAudioPreviewResult = parsed.success ? parsed.data : { status: 'failed', reason: 'invalid_response' };
      if (result.status === 'local' && !(await this.transport.consumeLocalPreview?.(
        session, preview.autocomplete.origin, preview.id, preview.requestId, result,
      ))) {
        result = { status: 'failed', reason: 'invalid_response' };
      }
      this.completeAudioPreview(preview, result);
    } catch (error) {
      Logger.error('BOT', 'Could not deliver an audio preview', error);
      this.completeAudioPreview(preview, { status: 'failed', reason: 'handler_failed' }, true);
    }
  }

  cancelAudioPreview(session: BotInteractionSession, payload: unknown, requestId?: string): void {
    const parsed = commandAudioPreviewCancelSchema.safeParse(payload);
    if (!parsed.success || session.isBot || !session.user) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const search = this.autocompleteByOrigin.get(session.ws);
    if (search?.origin === session && search.preview?.requestId === parsed.data.requestId) {
      this.dropAudioPreview(search.preview, true);
    }
  }

  commandsChanged(botId: string): void {
    for (const pending of this.autocompletes.values()) {
      if (pending.command.botId === botId) this.failAutocomplete(pending, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND);
    }
  }

  settingsChanged(botId: string): void {
    for (const pending of this.autocompletes.values()) {
      if (pending.command.botId === botId) this.failAutocomplete(pending, ProtocolErrorCode.BOT_SETTINGS_CONFLICT);
    }
  }

  voiceChanged(): void {
    for (const pending of this.autocompletes.values()) {
      const error = this.getVoiceAccessError(
        pending.origin, pending.bot, pending.command.voiceRequirement, pending.voiceChannelId,
      );
      if (error) this.failAutocomplete(pending, error);
    }
    for (const invocation of this.invocations.values()) {
      const error = this.getVoiceAccessError(
        invocation.origin, invocation.bot, invocation.voiceRequirement, invocation.voiceChannelId,
      );
      if (!error) continue;
      if (this.transport.isCurrent(invocation.origin)) this.error(invocation.origin, error);
      this.finish(invocation, 'cancelled');
    }
  }

  async invoke(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const user = session.user;
    if (!user || session.isBot || !session.sessionId) {
      this.error(session, ProtocolErrorCode.PERMISSION_DENIED, requestId);
      return;
    }
    const parsed = commandInvokeSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, parsed.error.issues.some((issue) => issue.path[0] === 'userSettings')
        ? ProtocolErrorCode.BOT_SETTINGS_INVALID : ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
      return;
    }
    const input = parsed.data;
    const startingVoiceChannelId = this.transport.getVoiceChannelId?.(session.sessionId) ?? null;
    this.cancelAutocompleteForOrigin(session);
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
    const voiceChannelId = command.voiceRequirement ? startingVoiceChannelId : undefined;
    const voiceError = this.getVoiceAccessError(session, bot, command.voiceRequirement, voiceChannelId);
    if (voiceError) {
      this.error(session, voiceError, requestId);
      return;
    }
    if (command.downloadsSound && input.allowSoundDownload !== true) {
      this.error(session, ProtocolErrorCode.PERMISSION_DENIED, requestId);
      return;
    }
    if (!command.downloadsSound && input.allowSoundDownload === true) {
      this.error(session, ProtocolErrorCode.BOT_INVALID_OPTIONS, requestId);
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
    const currentAccessError = await this.getAccessError(user.id, input.channelId);
    if (!this.transport.isCurrent(session) || this.closed) return;
    if (currentAccessError) {
      this.error(session, currentAccessError, requestId);
      return;
    }
    if (!this.transport.isCurrent(bot)) {
      this.error(session, ProtocolErrorCode.BOT_OFFLINE, requestId);
      return;
    }
    if (this.registry.find(input.botId, input.commandName) !== command) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND, requestId);
      return;
    }
    const currentVoiceError = this.getVoiceAccessError(session, bot, command.voiceRequirement, voiceChannelId);
    if (currentVoiceError) {
      this.error(session, currentVoiceError, requestId);
      return;
    }
    if (
      this.invocations.size >= LIMITS.MAX_BOT_INVOCATIONS ||
      (this.byOrigin.get(session.ws)?.size ?? 0) >= LIMITS.MAX_BOT_INVOCATIONS_PER_SESSION
    ) {
      this.error(session, ProtocolErrorCode.BOT_COMMAND_BUSY, requestId);
      return;
    }

    let settings: { settings?: BotSettingsContext };
    try {
      settings = this.settingsPayload(input.botId, input.userSettings);
    } catch (error) {
      if (!(error instanceof BotSettingsError)) throw error;
      this.error(session, error.code, requestId, error.message);
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
      requestId,
      origin: session,
      bot,
      invokerId: user.id,
      invokerNickname: user.nickname,
      invokerAvatarUrl: user.avatarUrl ?? null,
      botId: input.botId,
      channelId: input.channelId,
      commandName: input.commandName,
      localCapabilities: command.localCapabilities?.slice(),
      voiceRequirement: command.voiceRequirement,
      voiceChannelId,
      locale: input.locale,
      expiresAt: Date.now() + LIMITS.BOT_INTERACTION_TIMEOUT_MS,
      timer,
      usedInteractionIds: new Set(),
      allowSoundDownload: command.downloadsSound === true && input.allowSoundDownload === true,
      soundDownloadUsed: false,
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
      commandName: input.commandName, botId: input.botId, channelId: input.channelId,
      locale: input.locale, allowSoundDownload: input.allowSoundDownload,
      options: options.values,
      invocationId: id,
      invokerId: user.id,
      invokerNickname: user.nickname,
      ...settings,
      invokerSessionId: session.sessionId,
      invokerVoiceChannelId: this.transport.getVoiceChannelId?.(session.sessionId) ?? null,
    };
    this.transport.send(bot.ws, { type: MessageType.COMMAND_INVOKE, payload: execution });
  }

  async getVoiceContext(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = botVoiceContextRequestSchema.safeParse(payload);
    if (!parsed.success || !commandRequestIdSchema.safeParse(requestId).success) {
      this.error(session, ProtocolErrorCode.BAD_REQUEST, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'bot', requestId);
    if (!invocation || !(await this.authorize(invocation, session, requestId))) return;
    const sessionId = invocation.origin.sessionId;
    if (!sessionId || !this.transport.getVoiceChannelId) {
      this.error(session, ProtocolErrorCode.INTERNAL_ERROR, requestId);
      return;
    }
    // No await between this read and send: a user's other device is never a
    // substitute for the exact human connection that started the invocation.
    const result: BotVoiceContextResult = {
      invocationId: invocation.id,
      voiceChannelId: this.transport.getVoiceChannelId(sessionId),
    };
    this.transport.send(session.ws, { type: MessageType.BOT_VOICE_CONTEXT_RESULT, requestId, payload: result });
  }

  async downloadSound(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = commandSoundDownloadSchema.safeParse(payload);
    const correlation = commandRequestIdSchema.safeParse(requestId);
    if (!parsed.success || !correlation.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'bot', requestId);
    if (!invocation || !(await this.authorize(invocation, session, requestId))) return;
    if (!invocation.allowSoundDownload) {
      this.error(session, ProtocolErrorCode.PERMISSION_DENIED, requestId);
      return;
    }
    if (invocation.soundDownloadUsed) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const botUser = invocation.bot.user;
    if (!botUser) return;
    const createdAt = Date.now();
    const expiresAt = Math.min(invocation.expiresAt, createdAt + LIMITS.BOT_SOUND_DOWNLOAD_TIMEOUT_MS);
    const downloadId = randomUUID();
    const timer = setTimeout(() => {
      const pending = invocation.soundDownload;
      if (pending?.id === downloadId) {
        void this.expireSoundDownload(invocation, pending).catch(() => this.finish(invocation, 'failed'));
      }
    }, expiresAt - createdAt);
    timer.unref();
    invocation.soundDownloadUsed = true;
    invocation.soundDownload = { id: downloadId, requestId: correlation.data, expiresAt, timer };
    const received: CommandSoundDownloadReceivedPayload = {
      ...parsed.data,
      downloadId,
      channelId: invocation.channelId,
      botId: invocation.botId,
      botName: botUser.nickname,
      botAvatarUrl: botUser.avatarUrl,
      commandName: invocation.commandName,
      invokerId: invocation.invokerId,
      invokerNickname: invocation.invokerNickname,
      invokerAvatarUrl: invocation.invokerAvatarUrl,
      createdAt,
      expiresAt,
    };
    this.transport.send(invocation.origin.ws, { type: MessageType.COMMAND_SOUND_DOWNLOAD, payload: received });
  }

  async downloadSoundResult(session: BotInteractionSession, payload: unknown, requestId?: string): Promise<void> {
    const parsed = commandSoundDownloadResultSchema.safeParse(payload);
    if (!parsed.success) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    const invocation = this.findOwned(session, parsed.data.invocationId, 'origin', requestId);
    if (!invocation || !(await this.authorize(invocation, session, requestId))) return;
    const pending = invocation.soundDownload;
    if (!pending || pending.id !== parsed.data.downloadId) {
      this.error(session, ProtocolErrorCode.BOT_INTERACTION_INVALID, requestId);
      return;
    }
    if (Date.now() >= pending.expiresAt) {
      this.cancelSoundDownload(invocation, pending);
      this.completeSoundDownload(invocation, pending, { status: 'failed', reason: 'timeout' }, requestId);
      return;
    }
    this.completeSoundDownload(invocation, pending, parsed.data.result, requestId);
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
      localizations: parsed.data.localizations,
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
      await this.transport.publishResponse(session, response, () => this.isActive(invocation), requestId);
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
    for (const pending of this.autocompletes.values()) {
      if (pending.bot === session) this.failAutocomplete(pending, ProtocolErrorCode.BOT_OFFLINE);
      else if (pending.origin === session) this.dropAutocomplete(pending, true);
    }
    for (const invocation of this.invocations.values()) {
      if (invocation.bot === session) this.finish(invocation, 'bot_disconnected');
      else if (invocation.origin === session) this.finish(invocation, 'caller_disconnected');
    }
  }

  deleteChannel(channelId: string): void {
    for (const pending of this.autocompletes.values()) {
      if (pending.channelId === channelId) this.failAutocomplete(pending, ProtocolErrorCode.CHANNEL_NOT_FOUND);
    }
    for (const invocation of this.invocations.values()) {
      if (invocation.channelId === channelId) this.finish(invocation, 'cancelled');
    }
  }

  reconcileAccess(
    channels: ReadonlyMap<string, ChannelSummary>,
    contexts: ReadonlyMap<string, ChannelAccessContext>
  ): void {
    const canContinue = (invokerId: string, channelId: string): boolean => {
      const channel = channels.get(channelId);
      const context = contexts.get(invokerId);
      return !!channel && channel.type === 'TEXT' && !!context &&
        channel.botCommandsEnabled &&
        hasPermission(context.permissions, Permission.USE_BOT_COMMANDS) &&
        hasPermission(context.permissions, Permission.SEND_MESSAGES) &&
        canAccessChannel(channel, context.permissions, context.roleIds);
    };
    for (const pending of this.autocompletes.values()) {
      if (!canContinue(pending.invokerId, pending.channelId)) {
        this.failAutocomplete(pending, ProtocolErrorCode.PERMISSION_DENIED);
      }
    }
    for (const invocation of this.invocations.values()) {
      if (!this.isActive(invocation)) continue;
      if (!canContinue(invocation.invokerId, invocation.channelId)) {
        this.finish(invocation, 'cancelled');
      }
    }
  }

  close(): void {
    this.closed = true;
    this.autocompleteLimiter.dispose();
    for (const pending of this.autocompletes.values()) this.dropAutocomplete(pending, true);
    for (const invocation of this.invocations.values()) this.finish(invocation, 'failed');
  }

  /** Shares the existing caller/channel authorizer without exposing invocation registries or native grants. */
  async authorizeLocalCaller(userId: string, channelId: string): Promise<boolean> {
    return !this.closed && !(await this.getAccessError(userId, channelId));
  }

  async authorizeLocalContext(
    session: BotInteractionSession, context: Exclude<LocalRequestContext, { kind: 'source' }>, capability: LocalCapabilityId,
  ): Promise<BotLocalContext<BotInteractionSession> | undefined> {
    if (!session.isBot || !session.botId || !session.botPublicKey || !this.transport.isCurrent(session)) return undefined;
    if (context.kind === 'invocation') {
      const invocation = this.invocations.get(context.invocationId);
      if (!invocation || invocation.bot !== session || invocation.botId !== session.botId ||
          !invocation.localCapabilities?.includes(capability) || !commandRequestIdSchema.safeParse(invocation.requestId).success ||
          !this.isActive(invocation)) return undefined;
      if (!(await this.authorizeSelector(session, invocation.id, invocation.channelId))) return undefined;
      const requestId = invocation.requestId;
      if (!requestId) return undefined;
      return {
        origin: invocation.origin, bot: session, requestId, invokerId: invocation.invokerId,
        originChannelId: invocation.channelId, commandName: invocation.commandName, capability,
        expiresAt: invocation.expiresAt,
        isCurrent: () => this.isActive(invocation) && invocation.origin.user?.id === invocation.invokerId &&
          invocation.bot === session && invocation.botId === session.botId,
      };
    }
    const preview = context.kind === 'audio-preview' ? this.audioPreviews.get(context.requestId) : undefined;
    const pending = context.kind === 'audio-preview' ? preview?.autocomplete : this.autocompletes.get(context.requestId);
    if (!pending || pending.bot !== session || pending.command.botId !== session.botId ||
        !pending.localCapabilities?.includes(capability) || (context.kind === 'autocomplete' && pending.choices)) return undefined;
    if (!(preview ? await this.authorizeAudioPreview(preview) : await this.authorizeAutocomplete(pending))) return undefined;
    const isCurrent = () => !this.closed && this.autocompletes.get(pending.id) === pending &&
      this.transport.isCurrent(pending.origin) && this.transport.isCurrent(session) &&
      pending.origin.user?.id === pending.invokerId && pending.bot === session && pending.command.botId === session.botId &&
      this.registry.find(pending.command.botId, pending.command.name) === pending.command &&
      (preview ? this.audioPreviews.get(preview.id) === preview && pending.search.preview === preview : !pending.choices) &&
      Date.now() < (preview?.expiresAt ?? pending.expiresAt);
    if (!isCurrent()) return undefined;
    return {
      origin: pending.origin, bot: session, requestId: preview?.requestId ?? pending.requestId,
      invokerId: pending.invokerId, originChannelId: pending.channelId, commandName: pending.command.name, capability,
      expiresAt: preview?.expiresAt ?? pending.expiresAt, isCurrent,
    };
  }

  async authorizeSelector(
    session: BotInteractionSession, invocationId: string, channelId: string
  ): Promise<SelectorInvocationAuthorization | undefined> {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.bot !== session || !session.isBot ||
        invocation.botId !== session.botId || invocation.channelId !== channelId || !this.isActive(invocation)) {
      return undefined;
    }
    if (await this.getAccessError(invocation.invokerId, channelId)) return undefined;
    if (!this.isActive(invocation)) return undefined;
    return { creatorUserId: invocation.invokerId, isCurrent: () => this.isActive(invocation) };
  }

  authorizeVoiceJoin(
    session: BotInteractionSession, invocationId: string, channelId: string,
  ): Promise<VoiceInvocationAuthorization | undefined> {
    return this.authorizeVoiceContext(session, invocationId, channelId, true);
  }

  authorizeVoiceScreen(
    session: BotInteractionSession, invocationId: string, channelId: string,
  ): Promise<VoiceInvocationAuthorization | undefined> {
    return this.authorizeVoiceContext(session, invocationId, channelId, false);
  }

  /** Retire pending prompts/work too, so a delayed continuation cannot recreate an ended miniapp. */
  endScreenInvocation(session: BotInteractionSession, invocationId: string): void {
    const invocation = this.invocations.get(invocationId);
    if (invocation?.bot === session && session.isBot && invocation.botId === session.botId) {
      this.finish(invocation, 'cancelled');
    }
  }

  private async authorizeVoiceContext(
    session: BotInteractionSession, invocationId: string, channelId: string, requireSpeak: boolean,
  ): Promise<VoiceInvocationAuthorization | undefined> {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.bot !== session || !session.isBot ||
        invocation.botId !== session.botId || !this.isActive(invocation)) return undefined;
    const originSessionId = invocation.origin.sessionId;
    if (!originSessionId || !this.transport.getVoiceChannelId) return undefined;
    if (await this.getAccessError(invocation.invokerId, invocation.channelId)) return undefined;
    const [channel, context] = await Promise.all([
      this.channelService.getChannelSummary(channelId),
      this.channelService.getAccessContext(invocation.invokerId),
    ]);
    if (!channel || channel.type !== 'VOICE' || (requireSpeak && !hasPermission(context.permissions, Permission.SPEAK)) ||
        !canAccessChannel(channel, context.permissions, context.roleIds)) return undefined;
    const isCurrent = () => this.isActive(invocation) &&
      this.transport.getVoiceChannelId?.(originSessionId) === channelId;
    return isCurrent() ? { creatorUserId: invocation.invokerId, originChannelId: invocation.channelId, isCurrent } : undefined;
  }

  private async authorizeAutocomplete(pending: Autocomplete): Promise<boolean> {
    const accessError = await this.getAccessError(pending.invokerId, pending.channelId);
    if (this.autocompletes.get(pending.id) !== pending) return false;
    if (this.closed || !this.transport.isCurrent(pending.origin)) {
      this.cancelAutocompleteForOrigin(pending.origin);
      return false;
    }
    if (pending.origin.user?.id !== pending.invokerId || pending.origin.sessionId !== pending.search.sessionId) {
      this.failAutocompleteSearch(pending.search, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
      return false;
    }
    if (pending.completed && Date.now() >= pending.expiresAt) {
      this.failAutocomplete(pending, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
      return false;
    }
    if (!this.transport.isCurrent(pending.bot)) {
      this.failAutocompleteSearch(pending.search, ProtocolErrorCode.BOT_OFFLINE);
      return false;
    }
    if (this.registry.find(pending.command.botId, pending.command.name) !== pending.command) {
      this.failAutocompleteSearch(pending.search, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND);
      return false;
    }
    const error = accessError ?? this.getVoiceAccessError(
      pending.origin, pending.bot, pending.command.voiceRequirement, pending.voiceChannelId,
    );
    if (error) {
      this.failAutocompleteSearch(pending.search, error);
      return false;
    }
    return true;
  }

  private async expireAutocomplete(pending: Autocomplete): Promise<void> {
    if (!pending.completed && await this.authorizeAutocomplete(pending)) {
      this.finishAutocomplete(pending, { status: 'failed', reason: 'timeout' }, true);
    }
  }

  private autocompleteSearchKey(input: CommandAutocompletePayload, voiceChannelId?: string | null): string {
    return JSON.stringify({
      botId: input.botId, commandName: input.commandName, channelId: input.channelId,
      optionName: input.optionName, query: input.query, options: input.options ?? {},
      locale: input.locale ?? 'pt-BR', userSettings: input.userSettings === undefined ? {} : input.userSettings,
      voiceChannelId,
    }, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
      }
      return value;
    });
  }

  private cancelAutocompleteForOrigin(session: BotInteractionSession): void {
    const search = this.autocompleteByOrigin.get(session.ws);
    if (search?.origin === session) {
      for (const pending of search.pages.values()) this.dropAutocomplete(pending, true);
    }
  }

  private dropAutocomplete(pending: Autocomplete, cancelBot: boolean, cause: LocalTaskCancellationCause = 'requested'): boolean {
    if (this.autocompletes.get(pending.id) !== pending) return false;
    this.autocompletes.delete(pending.id);
    this.transport.localContextEnded?.({ kind: 'autocomplete', requestId: pending.id }, cause);
    const search = pending.search;
    search.pages.delete(pending.requestId);
    if (search.pending === pending) search.pending = undefined;
    if (!search.pages.size && this.autocompleteByOrigin.get(pending.origin.ws) === search) {
      this.autocompleteByOrigin.delete(pending.origin.ws);
    }
    clearTimeout(pending.timer);
    if (search.preview?.autocomplete === pending) {
      this.completeAudioPreview(search.preview, { status: 'failed', reason: 'expired' }, true);
    }
    if (pending.choices && this.transport.isCurrent(pending.origin)) {
      this.transport.send(pending.origin.ws, {
        type: MessageType.COMMAND_AUTOCOMPLETE_CANCEL, payload: { requestId: pending.requestId },
      });
    }
    if (cancelBot) {
      this.transport.send(pending.bot.ws, {
        type: MessageType.COMMAND_AUTOCOMPLETE_CANCEL, payload: { requestId: pending.id },
      });
    }
    return true;
  }

  private failAutocomplete(pending: Autocomplete, code: ProtocolErrorCode, message?: string): void {
    if (this.dropAutocomplete(pending, true) && !pending.completed && this.transport.isCurrent(pending.origin)) {
      this.error(pending.origin, code, pending.requestId, message);
    }
  }

  private failAutocompleteSearch(search: AutocompleteSearch, code: ProtocolErrorCode): void {
    for (const pending of search.pages.values()) this.failAutocomplete(pending, code);
  }

  private finishAutocomplete(pending: Autocomplete, result: CommandAutocompleteResultPayload, cancelBot = false): void {
    if (this.autocompletes.get(pending.id) !== pending || pending.completed) return;
    pending.completed = true;
    if (pending.search.pending === pending) pending.search.pending = undefined;
    if (result.status === 'ok' && result.choices.some((choice) => choice.audio && 'resourceId' in choice.audio)) {
      this.transport.localContextEnded?.({ kind: 'autocomplete', requestId: pending.id }, 'requested');
      const resources = new Map<string, string>();
      result = { ...result, choices: result.choices.map((choice) => {
        if (!choice.audio || !('resourceId' in choice.audio)) return choice;
        const resourceId = randomUUID();
        resources.set(resourceId, choice.audio.resourceId);
        return { ...choice, audio: { ...choice.audio, resourceId } };
      }) };
      // Each page owns its tokens and fixed lease. Loading another page never
      // extends older leases or authorizes their resources under a new request.
      pending.choices = resources;
      clearTimeout(pending.timer);
      pending.expiresAt = Date.now() + LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS;
      pending.timer = setTimeout(() => this.dropAutocomplete(pending, true, 'expired'), LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS);
      pending.timer.unref();
    } else if (!this.dropAutocomplete(pending, cancelBot,
      result.status === 'failed' && result.reason === 'timeout' ? 'expired' : 'requested')) return;
    this.transport.send(pending.origin.ws, {
      type: MessageType.COMMAND_AUTOCOMPLETE_RESULT, requestId: pending.requestId, payload: result,
    });
  }

  private async authorizeAudioPreview(preview: AudioPreview): Promise<boolean> {
    if (!(await this.authorizeAutocomplete(preview.autocomplete)) ||
        this.audioPreviews.get(preview.id) !== preview || preview.autocomplete.search.preview !== preview) return false;
    if (Date.now() >= preview.expiresAt) {
      this.completeAudioPreview(preview, { status: 'failed', reason: 'timeout' }, true);
      return false;
    }
    return true;
  }

  private dropAudioPreview(preview: AudioPreview, cancelBot: boolean, cause: LocalTaskCancellationCause = 'requested'): boolean {
    if (this.audioPreviews.get(preview.id) !== preview) return false;
    this.audioPreviews.delete(preview.id);
    this.transport.localContextEnded?.({ kind: 'audio-preview', requestId: preview.id }, cause);
    clearTimeout(preview.timer);
    if (preview.autocomplete.search.preview === preview) preview.autocomplete.search.preview = undefined;
    if (cancelBot && this.transport.isCurrent(preview.autocomplete.bot)) {
      this.transport.send(preview.autocomplete.bot.ws, {
        type: MessageType.COMMAND_AUDIO_PREVIEW_CANCEL, payload: { requestId: preview.id },
      });
    }
    return true;
  }

  private completeAudioPreview(preview: AudioPreview, result: CommandAudioPreviewResult, cancelBot = false): void {
    const cause = result.status === 'failed' && (result.reason === 'timeout' || result.reason === 'expired') ? 'expired' : 'requested';
    if (!this.dropAudioPreview(preview, cancelBot, cause) || !this.transport.isCurrent(preview.autocomplete.origin)) return;
    this.transport.send(preview.autocomplete.origin.ws, {
      type: MessageType.COMMAND_AUDIO_PREVIEW_RESULT, requestId: preview.requestId, payload: result,
    });
  }

  private async expireSoundDownload(invocation: Invocation, pending: PendingSoundDownload): Promise<void> {
    if (invocation.soundDownload !== pending ||
        !(await this.authorize(invocation, invocation.bot, pending.requestId)) ||
        invocation.soundDownload !== pending) return;
    this.cancelSoundDownload(invocation, pending);
    this.completeSoundDownload(invocation, pending, { status: 'failed', reason: 'timeout' });
  }

  private cancelSoundDownload(invocation: Invocation, pending: PendingSoundDownload): void {
    this.transport.send(invocation.origin.ws, {
      type: MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL,
      payload: { invocationId: invocation.id, downloadId: pending.id },
    });
  }

  private completeSoundDownload(
    invocation: Invocation, pending: PendingSoundDownload, result: SoundDownloadResult, requestId?: string
  ): void {
    if (invocation.soundDownload !== pending) return;
    clearTimeout(pending.timer);
    invocation.soundDownload = undefined;
    const payload: CommandSoundDownloadResultPayload = {
      invocationId: invocation.id, downloadId: pending.id, result,
    };
    this.transport.send(invocation.origin.ws, { type: MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, requestId, payload });
    this.transport.send(invocation.bot.ws, {
      type: MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, requestId: pending.requestId, payload,
    });
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
    else if (this.getVoiceAccessError(invocation.origin, invocation.bot, invocation.voiceRequirement, invocation.voiceChannelId)) {
      this.finish(invocation, 'cancelled');
    }
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
    if (!channel.botCommandsEnabled || !hasPermission(context.permissions, Permission.USE_BOT_COMMANDS)) {
      return ProtocolErrorCode.PERMISSION_DENIED;
    }
    return undefined;
  }

  private getVoiceAccessError(
    origin: BotInteractionSession, bot: BotInteractionSession,
    requirement: SlashCommand['voiceRequirement'], voiceChannelId?: string | null,
  ): ProtocolErrorCode | undefined {
    if (!requirement) return undefined;
    if (!origin.sessionId || !this.transport.getVoiceChannelId) return ProtocolErrorCode.INTERNAL_ERROR;
    if (voiceChannelId === null) return ProtocolErrorCode.BOT_VOICE_REQUIRED;
    const currentChannelId = this.transport.getVoiceChannelId(origin.sessionId);
    if (!currentChannelId) return ProtocolErrorCode.BOT_VOICE_REQUIRED;
    if (requirement === 'same-bot-channel') {
      if (!bot.sessionId) return ProtocolErrorCode.INTERNAL_ERROR;
      const botChannelId = this.transport.getVoiceChannelId(bot.sessionId);
      if (botChannelId && botChannelId !== currentChannelId) return ProtocolErrorCode.BOT_VOICE_CHANNEL_MISMATCH;
    }
    // A pending command/search belongs to the room where it began, not a room
    // the same device happened to join while its provider was still working.
    if (voiceChannelId && voiceChannelId !== currentChannelId) return ProtocolErrorCode.BOT_INTERACTION_EXPIRED;
    return undefined;
  }

  private finish(
    invocation: Invocation,
    reason: CommandFinishReason,
    requester?: BotInteractionSession,
    requestId?: string
  ): void {
    if (!this.invocations.delete(invocation.id)) return;
    this.transport.localContextEnded?.({ kind: 'invocation', invocationId: invocation.id },
      reason === 'expired' ? 'expired' : reason === 'bot_disconnected' ? 'bot_disconnected' :
        reason === 'caller_disconnected' ? 'requester_disconnected' : 'requested');
    clearTimeout(invocation.timer);
    if (invocation.soundDownload) {
      clearTimeout(invocation.soundDownload.timer);
      this.cancelSoundDownload(invocation, invocation.soundDownload);
      invocation.soundDownload = undefined;
    }
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

  private settingsPayload(botId: string, input: unknown): { settings?: BotSettingsContext } {
    if (this.settings) {
      const settings = this.settings.context(botId, input);
      return settings ? { settings } : {};
    }
    if (!resolveBotSettingsValues(undefined, input).success) {
      throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, 'This bot declares no individual preferences.');
    }
    return {};
  }

  private error(session: BotInteractionSession, code: ProtocolErrorCode, requestId?: string, message?: string): void {
    this.transport.sendError(session.ws, code, message ?? 'Não foi possível processar a interação com o bot.', requestId);
  }
}
