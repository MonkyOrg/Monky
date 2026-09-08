import {
  LIMITS,
  botFormSchema,
  type BotForm,
  type BotFormValues,
  type ChatMessage,
  type ChatReactionEventPayload,
  type CommandFinishedPayload,
  type CommandFinishReason,
  type CommandInvokedPayload,
  type CommandPromptReceivedPayload,
  type CommandSubmitPayload,
  type SlashCommand,
} from '@monky/shared';
import { appEvents, EventBus } from '../core/EventBus';
import { createActiveProxy } from '../core/activeProxy';
import { initialBotInputValues, seedCommandInputs } from '../utils/botInputs';
import {
  commandKey, incrementCommandUsage, readCommandUsage, writeCommandUsage,
  type CommandUsage, type CommandUsageScope, type CommandUsageStorage,
} from '../utils/commandCatalog';

export interface CommandDraft {
  command: SlashCommand;
  values: BotFormValues;
  visibleOptionalNames: string[];
  pending: boolean;
  error?: string;
}

export interface BotFormState {
  interactionId: string;
  form: BotForm;
  values: BotFormValues;
  status: 'editing' | 'submitting' | 'submitted' | 'closed';
  error?: string;
}

export interface BotInvocation extends CommandInvokedPayload {
  botName: string;
  botAvatarUrl?: string | null;
  createdAt: number;
  expiresAt: number;
  status: 'active' | CommandFinishReason;
  cancelPending: boolean;
  error?: string;
  forms: BotFormState[];
  acknowledged: boolean;
  hasResponse: boolean;
}

export class ChatStore {
  /** See ServerStore.bus: background servers get a silent bus (#400). */
  public bus: EventBus = appEvents;
  // Map of channelId -> ChatMessage[]
  private messages: Map<string, ChatMessage[]> = new Map();
  // Text channels with an unread @-mention for the current user (#14).
  private mentionChannels: Set<string> = new Set();
  // Text channels with unread messages for the current user (#263).
  private unreadChannels: Set<string> = new Set();
  // Half-written messages, keyed by channelId (#478). They live in the store
  // instead of the view because the view is torn down and rebuilt whenever the
  // center area switches between chat and the voice stage.
  private drafts: Map<string, string> = new Map();
  private commands: SlashCommand[] = [];
  private commandDrafts: Map<string, CommandDraft> = new Map();
  private invocations: Map<string, BotInvocation> = new Map();
  private commandUsageScope: CommandUsageScope | null = null;
  private commandUsage: CommandUsage[] = [];
  // Maximum number of messages kept in memory per channel to bound memory usage.
  private static readonly MAX_MESSAGES_PER_CHANNEL = 250;
  private static readonly MAX_INVOCATIONS = 50;
  private static readonly MAX_FORMS_PER_INVOCATION = 20;

  constructor(private usageStorage?: CommandUsageStorage) {}

  public setCommandUsageScope(scope: CommandUsageScope): void {
    if (!scope.serverId || scope.serverId.length > 128 || !scope.callerId || scope.callerId.length > 128) return;
    if (this.commandUsageScope?.serverId === scope.serverId && this.commandUsageScope.callerId === scope.callerId) return;
    this.commandUsageScope = { serverId: scope.serverId, callerId: scope.callerId };
    this.commandUsage = readCommandUsage(this.commandUsageScope, this.usageStorage);
    this.bus.emit('chat.commands_updated');
  }

  public getCommandUsage(): CommandUsage[] {
    const combined = new Map(this.commandUsage.map((entry) => [
      commandKey({ botId: entry.botId, name: entry.commandName }), entry,
    ]));
    // Two host aliases may point to the same stable server. Read before an ACK
    // so one session cannot overwrite successful usage recorded by the other.
    for (const entry of this.commandUsageScope ? readCommandUsage(this.commandUsageScope, this.usageStorage) : []) {
      const key = commandKey({ botId: entry.botId, name: entry.commandName });
      const current = combined.get(key);
      if (!current || entry.count > current.count || (entry.count === current.count && entry.lastUsedAt > current.lastUsedAt)) combined.set(key, entry);
    }
    return [...combined.values()].map((entry) => ({ ...entry }));
  }

  public setHistory(channelId: string, msgs: ChatMessage[]): void {
    // History can arrive after a live response, and never contains private
    // messages. Preserve those rows without duplicating public bot results.
    const current = this.messages.get(channelId) ?? [];
    const newestHistory = msgs.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
    const merged = new Map(current
      .filter((message) => message.isBot || message.isEphemeral || message.createdAt > newestHistory)
      .map((message) => [message.id, message]));
    for (const message of msgs) {
      const previous = merged.get(message.id);
      merged.set(message.id, {
        ...message,
        ...(previous?.isBot && previous.userId === message.userId
          ? { isBot: true, botCommand: message.botCommand ?? previous.botCommand } : {}),
      });
    }
    const trimmed = [...merged.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-ChatStore.MAX_MESSAGES_PER_CHANNEL);
    this.messages.set(channelId, trimmed);
    for (const message of trimmed) this.recordBotResponse(message);
    this.bus.emit('chat.history_loaded', { channelId, messages: trimmed });
  }

  public addMessage(message: ChatMessage): void {
    this.recordBotResponse(message);
    let list = this.messages.get(message.channelId);
    if (!list) {
      list = [];
      this.messages.set(message.channelId, list);
    }
    if (list.some((m) => m.id === message.id)) {
      return;
    }
    list.push(message);
    // Keep only the most recent messages to prevent unbounded memory growth.
    if (list.length > ChatStore.MAX_MESSAGES_PER_CHANNEL) {
      list.splice(0, list.length - ChatStore.MAX_MESSAGES_PER_CHANNEL);
    }
    this.bus.emit('chat.message_added', message);
  }

  private recordBotResponse(message: ChatMessage): void {
    const invocation = message.isBot && message.botCommand
      ? this.invocations.get(message.botCommand.invocationId)
      : undefined;
    if (!invocation || invocation.hasResponse ||
        invocation.botId !== message.userId || invocation.channelId !== message.channelId) return;
    invocation.hasResponse = true;
    if (invocation.status === 'completed') this.notifyInvocation(invocation);
  }

  /**
   * Replaces a message already in the feed with its edited/deleted state (#504).
   * A message the client never loaded is ignored: it will arrive in its final
   * shape the next time the history is fetched.
   */
  public updateMessage(message: ChatMessage): void {
    const list = this.messages.get(message.channelId);
    if (!list) return;
    const index = list.findIndex((m) => m.id === message.id);
    if (index === -1) return;
    const previous = list[index];
    list[index] = {
      ...message,
      ...(previous.isBot && previous.userId === message.userId
        ? { isBot: true, botCommand: message.botCommand ?? previous.botCommand } : {}),
    };
    this.bus.emit('chat.message_updated', list[index]);
  }

  public getMessages(channelId: string): ChatMessage[] {
    return this.messages.get(channelId) || [];
  }

  public updateReaction(event: ChatReactionEventPayload, add: boolean): void {
    const message = this.messages.get(event.channelId)?.find((entry) => entry.id === event.messageId);
    if (!message || message.deletedAt || message.isSystem || message.isEphemeral) return;
    const reactions = message.reactions ?? (message.reactions = []);
    let reaction = reactions.find((entry) => entry.emoji === event.emoji);
    if (add) {
      if (!reaction) { reaction = { emoji: event.emoji, users: [] }; reactions.push(reaction); }
      if (!reaction.users.some((user) => user.userId === event.userId)) {
        reaction.users.push({ userId: event.userId, userNickname: event.userNickname });
      }
    } else if (reaction) {
      reaction.users = reaction.users.filter((user) => user.userId !== event.userId);
      if (reaction.users.length === 0) reactions.splice(reactions.indexOf(reaction), 1);
    }
    this.bus.emit('chat.reactions_updated', message);
  }

  /** Flag a text channel as having an unread @-mention (#14). */
  public markMention(channelId: string): void {
    if (this.mentionChannels.has(channelId)) return;
    this.mentionChannels.add(channelId);
    this.bus.emit('chat.mentions_updated');
  }

  /**
   * Replace the whole set of channels with unread @-mentions, e.g. when seeding
   * from ServerDetails on (re)connect so mentions received while offline show up
   * (#14).
   */
  public setMentions(channelIds: string[]): void {
    this.mentionChannels = new Set(channelIds);
    this.bus.emit('chat.mentions_updated');
  }

  /** Clear the unread @-mention flag for a channel (e.g. when opened). */
  public clearMention(channelId: string): void {
    if (!this.mentionChannels.delete(channelId)) return;
    this.bus.emit('chat.mentions_updated');
  }

  public hasMention(channelId: string): boolean {
    return this.mentionChannels.has(channelId);
  }

  /** Flag a text channel as having unread messages (#263). */
  public markUnread(channelId: string): void {
    if (this.unreadChannels.has(channelId)) return;
    this.unreadChannels.add(channelId);
    this.bus.emit('chat.unread_updated');
  }

  /** Clear the unread flag for a channel (opened or marked as read) (#263). */
  public clearUnread(channelId: string): void {
    if (!this.unreadChannels.delete(channelId)) return;
    this.bus.emit('chat.unread_updated');
  }

  public hasUnread(channelId: string): boolean {
    return this.unreadChannels.has(channelId);
  }

  /** Whether anything is unread anywhere, used by the server rail badge (#400). */
  public hasAnyUnread(): boolean {
    return this.unreadChannels.size > 0 || this.mentionChannels.size > 0;
  }

  /**
   * Whether any channel holds an unread @-mention. The rail badge separates it
   * from plain unread so a mention shows up in red instead of white (#479).
   */
  public hasAnyMention(): boolean {
    return this.mentionChannels.size > 0;
  }

  /**
   * Remembers what the user had typed but not sent in a channel, so leaving for
   * the voice stage or another channel doesn't throw the text away (#478).
   */
  public setDraft(channelId: string, text: string): void {
    if (text.length === 0) {
      this.drafts.delete(channelId);
      return;
    }
    this.drafts.set(channelId, text);
  }

  public getDraft(channelId: string): string {
    return this.drafts.get(channelId) || '';
  }

  public clearDraft(channelId: string): void {
    this.drafts.delete(channelId);
  }

  public setCommands(commands: SlashCommand[]): void {
    const previousCommands = this.commands;
    this.commands = commands;
    for (const [channelId, draft] of this.commandDrafts) {
      const current = commands.find((command) =>
        command.botId === draft.command.botId && command.name === draft.command.name);
      const wasAvailable = previousCommands.some((command) =>
        command.botId === draft.command.botId && command.name === draft.command.name);
      const changed = wasAvailable !== !!current ||
        (current !== undefined && JSON.stringify(current) !== JSON.stringify(draft.command));
      if (current) {
        draft.command = current;
        draft.visibleOptionalNames = draft.visibleOptionalNames.filter((name) =>
          current.options?.some((option) => option.name === name && !option.required));
        const values: BotFormValues = {};
        for (const option of current.options ?? []) {
          const value = draft.values[option.name];
          if (value !== undefined) values[option.name] = value;
        }
        draft.values = values;
      }
      if (changed) this.bus.emit('chat.command_draft_updated', { channelId });
    }
    this.bus.emit('chat.commands_updated');
  }

  public getCommands(): SlashCommand[] {
    return this.commands;
  }

  public isCommandAvailable(command: SlashCommand): boolean {
    return this.commands.some((entry) => entry.botId === command.botId && entry.name === command.name);
  }

  public selectCommand(channelId: string, command: SlashCommand, text = ''): void {
    if (this.commandDrafts.get(channelId)?.pending) return;
    const values = seedCommandInputs(command, text);
    const visibleOptionalNames = (command.options ?? [])
      .filter((option) => !option.required && values[option.name] !== undefined)
      .map((option) => option.name);
    this.commandDrafts.set(channelId, { command, values, visibleOptionalNames, pending: false });
    this.clearDraft(channelId);
    this.bus.emit('chat.command_draft_updated', { channelId });
  }

  public getCommandDraft(channelId: string): CommandDraft | undefined {
    return this.commandDrafts.get(channelId);
  }

  public setCommandValues(channelId: string, values: BotFormValues): void {
    const draft = this.commandDrafts.get(channelId);
    if (!draft || draft.pending) return;
    draft.values = values;
    draft.error = undefined;
  }

  public setCommandOptionVisible(channelId: string, name: string, visible: boolean): boolean {
    const draft = this.commandDrafts.get(channelId);
    if (!draft || draft.pending || !draft.command.options?.some((option) => option.name === name && !option.required)) return false;
    const names = new Set(draft.visibleOptionalNames);
    if (visible) names.add(name);
    else names.delete(name);
    draft.visibleOptionalNames = [...names];
    draft.error = undefined;
    this.bus.emit('chat.command_draft_updated', { channelId });
    return true;
  }

  public setCommandPending(channelId: string, draft: CommandDraft, pending: boolean, error?: string): boolean {
    if (this.commandDrafts.get(channelId) !== draft) return false;
    draft.pending = pending;
    draft.error = error;
    this.bus.emit('chat.command_draft_updated', { channelId });
    return true;
  }

  public clearCommand(channelId: string, expected?: CommandDraft): void {
    if (expected && this.commandDrafts.get(channelId) !== expected) return;
    this.commandDrafts.delete(channelId);
    this.bus.emit('chat.command_draft_updated', { channelId });
  }

  public acknowledgeCommand(payload: CommandInvokedPayload, command?: SlashCommand, now = Date.now()): BotInvocation {
    const invocation = this.ensureInvocation(payload, command, now);
    if (invocation.botId !== payload.botId || invocation.channelId !== payload.channelId) return invocation;
    invocation.commandName = payload.commandName;
    if (!invocation.acknowledged) {
      invocation.acknowledged = true;
      const known = this.commands.find((entry) => entry.botId === payload.botId && entry.name === payload.commandName);
      if (known && this.commandUsageScope) {
        this.commandUsage = incrementCommandUsage(this.getCommandUsage(), known, now);
        writeCommandUsage(this.commandUsageScope, this.commandUsage, this.usageStorage);
        this.bus.emit('chat.commands_updated');
      }
    }
    this.notifyInvocation(invocation);
    return invocation;
  }

  private ensureInvocation(payload: CommandInvokedPayload, command?: SlashCommand, now = Date.now()): BotInvocation {
    const existing = this.invocations.get(payload.invocationId);
    if (existing) return existing;
    const selected = command ?? this.commandDrafts.get(payload.channelId)?.command;
    const definition = selected?.botId === payload.botId && selected.name === payload.commandName
      ? selected
      : this.commands.find((entry) => entry.botId === payload.botId && entry.name === payload.commandName);
    const invocation: BotInvocation = {
      ...payload,
      botName: definition?.botName ?? payload.commandName,
      botAvatarUrl: definition?.botAvatarUrl,
      createdAt: now,
      expiresAt: now + LIMITS.BOT_INTERACTION_TIMEOUT_MS,
      status: 'active',
      cancelPending: false,
      forms: [],
      acknowledged: false,
      hasResponse: this.getMessages(payload.channelId).some((message) =>
        message.isBot && message.userId === payload.botId && message.botCommand?.invocationId === payload.invocationId),
    };
    this.invocations.set(payload.invocationId, invocation);
    this.pruneInvocations();
    this.notifyInvocation(invocation);
    return invocation;
  }

  public receivePrompt(payload: CommandPromptReceivedPayload): void {
    const parsed = botFormSchema.safeParse(payload.form);
    if (!parsed.success) return;
    const invocation = this.invocations.get(payload.invocationId) ?? this.ensureInvocation({
      invocationId: payload.invocationId,
      channelId: payload.channelId,
      botId: payload.botId,
      commandName: '',
    });
    if (invocation.status !== 'active' || invocation.channelId !== payload.channelId ||
        invocation.botId !== payload.botId || invocation.forms.some((form) => form.interactionId === payload.interactionId)) return;
    for (const form of invocation.forms) {
      if (form.status === 'editing' || form.status === 'submitting') form.status = 'closed';
    }
    invocation.botName = payload.botName;
    invocation.botAvatarUrl = payload.botAvatarUrl;
    invocation.expiresAt = payload.expiresAt;
    invocation.error = undefined;
    invocation.forms.push({
      interactionId: payload.interactionId,
      form: parsed.data,
      values: initialBotInputValues(parsed.data.fields),
      status: 'editing',
    });
    if (invocation.forms.length > ChatStore.MAX_FORMS_PER_INVOCATION) {
      invocation.forms.splice(0, invocation.forms.length - ChatStore.MAX_FORMS_PER_INVOCATION);
    }
    this.expireInvocations();
    this.notifyInvocation(invocation);
  }

  public getInvocations(channelId: string): BotInvocation[] {
    return [...this.invocations.values()].filter((invocation) => invocation.channelId === channelId);
  }

  public getInvocation(invocationId: string): BotInvocation | undefined {
    return this.invocations.get(invocationId);
  }

  public setFormValues(invocationId: string, interactionId: string, values: BotFormValues): void {
    const invocation = this.invocations.get(invocationId);
    const form = invocation?.forms.find((entry) => entry.interactionId === interactionId);
    if (invocation?.status !== 'active' || invocation.cancelPending || form?.status !== 'editing') return;
    form.values = values;
    form.error = undefined;
  }

  public beginFormSubmit(invocationId: string, interactionId: string): boolean {
    this.expireInvocations();
    const invocation = this.invocations.get(invocationId);
    const form = invocation?.forms.find((entry) => entry.interactionId === interactionId);
    if (invocation?.status !== 'active' || invocation.cancelPending || form?.status !== 'editing') return false;
    form.status = 'submitting';
    form.error = undefined;
    this.notifyInvocation(invocation);
    return true;
  }

  public failFormSubmit(invocationId: string, interactionId: string, error: string): void {
    const invocation = this.invocations.get(invocationId);
    const form = invocation?.forms.find((entry) => entry.interactionId === interactionId);
    if (invocation?.status !== 'active' || !form || form.status === 'submitted' || form.status === 'closed') return;
    form.status = 'editing';
    form.error = error;
    this.notifyInvocation(invocation);
  }

  public acknowledgeForm(payload: CommandSubmitPayload): void {
    const invocation = this.invocations.get(payload.invocationId);
    const form = invocation?.forms.find((entry) => entry.interactionId === payload.interactionId);
    if (!invocation || !form || (invocation.status !== 'active' && form.status !== 'submitted')) return;
    // Keep the consumed interaction ID for replay protection, not its input.
    form.values = {};
    form.status = 'submitted';
    form.error = undefined;
    this.notifyInvocation(invocation);
  }

  public setCancelPending(invocationId: string, pending: boolean, error?: string): boolean {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.status !== 'active' || (pending && invocation.cancelPending)) return false;
    invocation.cancelPending = pending;
    invocation.error = error;
    this.notifyInvocation(invocation);
    return true;
  }

  public finishInvocation(payload: CommandFinishedPayload): void {
    const invocation = this.invocations.get(payload.invocationId);
    if (!invocation || invocation.channelId !== payload.channelId || invocation.status !== 'active') return;
    invocation.status = payload.reason;
    invocation.cancelPending = false;
    invocation.error = undefined;
    for (const form of invocation.forms) {
      if (form.status !== 'submitted') form.status = 'closed';
      form.error = undefined;
    }
    this.notifyInvocation(invocation);
  }

  public finishBotInvocations(botId: string): void {
    this.setCommands(this.commands.filter((command) => command.botId !== botId));
    for (const invocation of this.invocations.values()) {
      if (invocation.botId === botId) this.finishInvocation({ ...invocation, reason: 'bot_disconnected' });
    }
  }

  public finishChannelInvocations(channelId: string): void {
    this.clearCommand(channelId);
    for (const invocation of this.getInvocations(channelId)) {
      this.finishInvocation({ ...invocation, reason: 'cancelled' });
    }
  }

  public finishAllInvocations(reason: CommandFinishReason): void {
    for (const invocation of this.invocations.values()) this.finishInvocation({ ...invocation, reason });
    for (const [channelId, draft] of this.commandDrafts) {
      this.setCommandPending(channelId, draft, false);
    }
  }

  public expireInvocations(now = Date.now()): void {
    for (const invocation of this.invocations.values()) {
      if (invocation.status === 'active' && invocation.expiresAt <= now) {
        this.finishInvocation({ ...invocation, reason: 'expired' });
      }
    }
  }

  private notifyInvocation(invocation: BotInvocation): void {
    this.bus.emit('chat.bot_interaction_updated', {
      channelId: invocation.channelId,
      invocationId: invocation.invocationId,
    });
  }

  private pruneInvocations(): void {
    for (const [id, invocation] of this.invocations) {
      if (this.invocations.size <= ChatStore.MAX_INVOCATIONS) break;
      if (invocation.status !== 'active') this.invocations.delete(id);
    }
  }

  public clear(): void {
    this.messages.clear();
    this.mentionChannels.clear();
    this.unreadChannels.clear();
    this.drafts.clear();
    this.commands = [];
    this.commandDrafts.clear();
    this.invocations.clear();
    this.commandUsageScope = null;
    this.commandUsage = [];
    this.bus.emit('chat.cleared');
  }
}

export function createChatStore(usageStorage?: CommandUsageStorage): ChatStore {
  return new ChatStore(usageStorage);
}

let activeChatStore = createChatStore();

export function setActiveChatStore(store: ChatStore): void {
  activeChatStore = store;
}

export function getActiveChatStore(): ChatStore {
  return activeChatStore;
}

export const chatStore = createActiveProxy<ChatStore>(() => activeChatStore);
