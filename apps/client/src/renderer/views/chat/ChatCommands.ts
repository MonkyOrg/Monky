import { getCommandPresentation, Permission } from '@monky/shared';
import type { BotLocale, CommandPresentation, SlashCommand } from '@monky/shared';
import { appEvents } from '../../core/EventBus';
import { getActiveNetworkClient } from '../../core/NetworkClient';
import { getLanguage, t } from '../../i18n';
import { translateProtocolError } from '../../i18n/protocolErrors';
import { chatStore, getActiveChatStore } from '../../stores/chatStore';
import { getActiveServerStore, serverStore } from '../../stores/serverStore';
import { settingsStore } from '../../stores/settingsStore';
import { formatCommandContext, parseTypedCommand } from '../../utils/botInputs';
import { botLocaleFor } from '../../utils/botLocale';
import { commandVoiceError } from '../../utils/botVoice';
import { filterCommands, findCommandsByInputName, groupCommands, type CommandGroup } from '../../utils/commandCatalog';
import { escapeHtml } from '../../utils/html';
import { reportError } from '../../utils/feedback';
import { smoothScrollIntoView } from '../../utils/scroll';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import { BotChatView } from '../BotChatView';
import { botSettingsModal } from '../BotSettingsModal';
import { renderCommandCatalog, renderEmptyCommandCatalog } from '../commandCatalog';
import { showErrorToast, showInfoToast } from '../CopyToast';
import type { MarkdownInput } from '../MarkdownInput';
import { PublicSelectorView } from '../PublicSelectorView';
import type { ChatContext } from './chatContext';

const COMBOBOX_ATTRIBUTES = ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-activedescendant'];

/**
 * Bot commands in a channel (#569): the /-command autocomplete of the
 * composer, picking a command (with the checks a sound download needs), the
 * notice explaining why one cannot run, and the command composer and public
 * selectors that bots add to the conversation.
 */
export class ChatCommands {
  private active = false;
  private matches: SlashCommand[] = [];
  private groups: CommandGroup[] = [];
  private activeIndex = 0;
  private query = '';
  private botChat: BotChatView | null = null;
  private publicSelectors: PublicSelectorView | null = null;
  /** Bumped whenever a pending command choice must be abandoned (an edit, a rebuilt composer). */
  private selection = 0;
  /** The command whose voice requirement the toast explains; the toast goes once the call meets it. */
  private voiceNoticeCommand: SlashCommand | null = null;
  /** Takes down the toast about the last command picked, once what it says no longer applies. */
  private dismissNotice: (() => void) | null = null;
  public readonly locale = (command: SlashCommand): BotLocale => botLocaleFor(this.ctx.client, this.ctx.server, command.botId);

  constructor(private readonly ctx: ChatContext) {}

  public get isOpen(): boolean {
    return this.active;
  }

  public presentation(botId: string, commandName: string): CommandPresentation {
    const command = this.ctx.store.getCommands().find((entry) => entry.botId === botId && entry.name === commandName);
    return getCommandPresentation(command ?? { name: commandName }, botLocaleFor(this.ctx.client, this.ctx.server, botId));
  }

  public voiceDeniedReason(command: Pick<SlashCommand, 'botId' | 'voiceRequirement'>): string | undefined {
    const error = commandVoiceError(command, getActiveNetworkClient(), getActiveServerStore());
    return error ? translateProtocolError(error) : undefined;
  }

  public deniedReason(command?: SlashCommand): string | undefined {
    const channelId = this.ctx.channelId;
    const channel = serverStore.serverDetails?.channels.find((candidate) => candidate.id === channelId);
    if (!channel || (channel.type !== 'TEXT' && channel.type !== 'VOICE') || !channel.botCommandsEnabled) {
      return t('botChat.commandsDisabledInChannel');
    }
    if (!serverStore.hasPermission(Permission.USE_BOT_COMMANDS, channelId)) return t('botChat.commandsPermissionDenied');
    if (channel.forumLocked) return t('forum.lockedPlaceholder');
    if (channel.forumClosed) return t('forum.closedPlaceholder');
    if (!serverStore.hasPermission(Permission.SEND_MESSAGES, channelId)) return t('chat.sendPermissionDenied');
    return command ? this.voiceDeniedReason(command) : undefined;
  }

  /** Commands and invocation cards already on screen follow the language and nicknames of their bots. */
  public refreshAttribution(): void {
    const channelId = this.ctx.channelId;
    if (!channelId) return;
    const feed = this.ctx.container.querySelector<HTMLElement>('#chat-messages-feed');
    if (!feed) return;
    const messages = new Map(this.ctx.store.getMessages(channelId).map((message) => [message.id, message]));
    for (const label of feed.querySelectorAll<HTMLElement>('[data-command-context-label]')) {
      const row = label.closest<HTMLElement>('[data-message-id]');
      const message = messages.get(row?.dataset.messageId ?? '');
      if (message?.botCommand) label.textContent = formatCommandContext(message.botCommand,
        this.presentation(message.userId, message.botCommand.commandName));
    }
    for (const card of feed.querySelectorAll<HTMLElement>('[data-invocation-id]')) {
      const invocation = this.ctx.store.getInvocation(card.dataset.invocationId ?? '');
      const label = card.querySelector<HTMLElement>('.bot-command-name');
      if (invocation && label) label.textContent = `/${this.presentation(invocation.botId, invocation.commandName).displayName}`;
    }
  }

  public update(input: MarkdownInput): void {
    const channelId = this.ctx.channelId;
    if (this.ctx.composer.messageEdit || (channelId && chatStore.getCommandDraft(channelId))) {
      this.close();
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.substring(0, caret);
    // A command token is a "/" at the very start of the message, followed by
    // the partial command name typed so far (no spaces in the name).
    const match = before.match(/^\/([a-z0-9_-]*)$/i);
    if (!match) {
      this.close();
      return;
    }
    if (this.deniedReason()) {
      this.groups = [];
      this.matches = [];
      this.active = true;
      this.render();
      return;
    }
    const query = match[1].toLowerCase();
    const all = chatStore.getCommands();
    const matches = query ? filterCommands(all, query, this.locale) : all;
    const previous = query === this.query ? this.matches[this.activeIndex] : undefined;
    const retained = previous && matches.find((command) => command.botId === previous.botId && command.name === previous.name);
    const exact = findCommandsByInputName(matches, query, this.locale);
    const preferred = retained ?? (exact.length === 1 ? exact[0] : undefined);
    this.query = query;
    this.groups = groupCommands(matches, chatStore.getCommandUsage(), getLanguage(), query.length === 0, this.locale);
    this.matches = this.groups.flatMap((group) => group.commands);
    this.active = true;
    this.activeIndex = Math.max(0, this.matches.findIndex((command) =>
      preferred !== undefined && command.botId === preferred.botId && command.name === preferred.name));
    this.render();
  }

  /** Typed text names more than one bot's command: the dropup asks which one. */
  public showAmbiguous(commands: SlashCommand[], input: MarkdownInput): void {
    this.showNotice(t('botChat.commandAmbiguous'));
    this.groups = groupCommands(commands, [], getLanguage(), false, this.locale);
    this.matches = this.groups.flatMap((group) => group.commands);
    this.activeIndex = 0;
    this.active = true;
    this.render();
    input.focus();
  }

  public render(): void {
    if (!this.ctx.composer.isCurrent() || this.ctx.composer.messageEdit) {
      this.close();
      return;
    }
    const el = this.ctx.container.querySelector<HTMLElement>('#command-dropup');
    if (!el) return;
    const denied = this.deniedReason();
    if (denied) {
      const input = this.ctx.container.querySelector('#chat-message-input');
      for (const attribute of COMBOBOX_ATTRIBUTES) input?.removeAttribute(attribute);
      el.innerHTML = `<div class="command-empty-frequency" role="status">${escapeHtml(denied)}</div>`;
      setSurfaceVisible(el, true, 'popover', 'block');
      return;
    }
    el.innerHTML = renderCommandCatalog(
      this.groups, this.activeIndex,
      (command) => this.voiceDeniedReason(command),
      this.locale,
      this.groups.length === 0
        ? renderEmptyCommandCatalog(this.ctx.store.getCommandBots(), this.query.length > 0 && this.ctx.store.getCommands().length > 0)
        : undefined,
    );
    setSurfaceVisible(el, true, 'popover', 'block');
    const input = this.ctx.container.querySelector<MarkdownInput>('#chat-message-input');
    el.querySelectorAll<HTMLButtonElement>('[data-command-bot-configure]').forEach(button => {
      button.addEventListener('click', () => {
        const botId = button.dataset.commandBotConfigure;
        if (!botId || !this.ctx.composer.isCurrent()) return;
        this.close();
        input?.focus();
        void botSettingsModal.open(botId);
      });
    });
    if (this.groups.length === 0) {
      for (const attribute of COMBOBOX_ATTRIBUTES) input?.removeAttribute(attribute);
      return;
    }
    input?.setAttribute('role', 'combobox');
    input?.setAttribute('aria-expanded', 'true');
    input?.setAttribute('aria-controls', 'command-list-options');
    input?.setAttribute('aria-autocomplete', 'list');
    el.querySelectorAll<HTMLElement>('[data-cmd-index]').forEach((item) => {
      item.addEventListener('mouseenter', () => {
        this.setActive(Number(item.dataset.cmdIndex), false);
      });
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', (event) => this.apply(Number(item.dataset.cmdIndex), event.isTrusted));
    });
    const groupButtons = [...el.querySelectorAll<HTMLButtonElement>('[data-command-group]')];
    groupButtons.forEach((button, index) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const section = [...el.querySelectorAll<HTMLElement>('[data-command-section]')]
          .find((element) => element.dataset.commandSection === button.dataset.commandGroup);
        if (section) smoothScrollIntoView(section, { block: 'start', inline: 'nearest' });
        const first = section?.querySelector<HTMLElement>('[data-cmd-index]');
        if (first) this.setActive(Number(first.dataset.cmdIndex), false);
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          const next = groupButtons[(index + offset + groupButtons.length) % groupButtons.length];
          next?.focus();
          next?.click();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.close();
          input?.focus();
        }
      });
    });
    this.setActive(this.activeIndex, false);
  }

  /** While the dropup is open, the keyboard drives it. Returns whether the key was taken. */
  public handleKey(event: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    // An open dropup without commands (a denial, nothing found) keeps Enter from sending the text.
    if (this.matches.length === 0) return true;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.setActive((this.activeIndex + 1) % this.matches.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.setActive((this.activeIndex - 1 + this.matches.length) % this.matches.length);
      return true;
    }
    const selectWithSpace = event.key === ' ' && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey) || selectWithSpace) {
      event.preventDefault();
      this.apply(this.activeIndex, event.isTrusted, !selectWithSpace);
      return true;
    }
    return false;
  }

  public select(command: SlashCommand, text = '', userGesture = false, autoInvoke = true): void {
    if (!this.ctx.composer.isCurrent() || this.ctx.composer.messageEdit) return;
    this.selection++;
    const denied = this.deniedReason(command);
    if (denied) {
      this.showNotice(denied);
      this.voiceNoticeCommand = command;
      return;
    }
    if (command.downloadsSound) {
      void this.prepareDownload(command, text, userGesture, autoInvoke);
      return;
    }
    this.activate(command, text, userGesture, false, autoInvoke);
  }

  /** Abandons a command choice still being prepared, e.g. a sound download check. */
  public cancelSelection(): void {
    this.selection++;
  }

  public close(): void {
    this.active = false;
    this.matches = [];
    this.groups = [];
    this.activeIndex = 0;
    this.query = '';
    const input = this.ctx.container.querySelector('#chat-message-input');
    for (const attribute of COMBOBOX_ATTRIBUTES) input?.removeAttribute(attribute);
    const el = this.ctx.container.querySelector<HTMLElement>('#command-dropup');
    if (el) {
      setSurfaceVisible(el, false, 'popover', undefined, () => el.replaceChildren());
    }
  }

  /**
   * Why a command did not run goes to the alert toast (#490), never to a line
   * left in the composer; an empty message takes the explanation down.
   */
  public showNotice(message: string): void {
    this.voiceNoticeCommand = null;
    this.dismissNotice?.();
    this.dismissNotice = message ? reportError(message) : null;
  }

  /** Something worth knowing about the command just picked, in the neutral toast. */
  public showInfo(message: string): void {
    this.voiceNoticeCommand = null;
    this.dismissNotice?.();
    this.dismissNotice = showInfoToast(message);
  }

  /** Moves focus to the command composer of the command being filled in. */
  public focusComposer(): void {
    this.botChat?.focusComposer();
  }

  public renderComposer(): void {
    this.botChat?.renderComposer();
  }

  /** The dropup closes when focus or a click goes anywhere but the composer and the dropup itself. */
  public bindDropup(input: MarkdownInput | null): () => void {
    const commandDropup = this.ctx.container.querySelector<HTMLElement>('#command-dropup');
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && (input?.contains(event.relatedTarget) || commandDropup?.contains(event.relatedTarget))) return;
      this.close();
    };
    const onOutside = (event: PointerEvent) => {
      if (this.active && event.target instanceof Node && !input?.contains(event.target) && !commandDropup?.contains(event.target)) this.close();
    };
    commandDropup?.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onOutside);
    return () => {
      commandDropup?.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onOutside);
    };
  }

  /** Keeps the dropup and the voice notice in step with the call, the language and the bots' preferences. */
  public subscribe(input: MarkdownInput | null): Array<() => void> {
    const refreshLocale = () => {
      if (!this.ctx.composer.owns(input)) return;
      if (input && this.active && !this.ctx.composer.messageEdit) this.update(input);
      this.refreshAttribution();
    };
    const updateVoiceCommands = () => {
      if (this.active) this.render();
      // The explanation leaves once the call meets the command's requirement.
      const command = this.voiceNoticeCommand;
      if (command && !this.voiceDeniedReason(command)) this.showNotice('');
    };
    return [
      appEvents.on('voice.channel_changed', updateVoiceCommands),
      appEvents.on('participants.updated', updateVoiceCommands),
      appEvents.on('session.voice_context_updated', updateVoiceCommands),
      appEvents.on('i18n.language_changed', refreshLocale),
      appEvents.on('bot.preferences_updated', refreshLocale),
    ];
  }

  /** The bots' command catalog changed. */
  public commandsUpdated(input: MarkdownInput | null): void {
    if (!this.ctx.composer.owns(input)) return;
    if (input && !chatStore.getCommandDraft(this.ctx.channelId ?? '')) this.update(input);
    this.refreshAttribution();
  }

  /**
   * The command composer and the public selectors of the channel on screen.
   * Created after the view's own listeners, so theirs run after the view's.
   */
  public mount(input: MarkdownInput | null): void {
    const ctx = this.ctx;
    const composer = ctx.container.querySelector<HTMLElement>('#chat-command-composer');
    const messagesFeed = ctx.container.querySelector<HTMLElement>('#chat-messages-feed');
    const channelId = ctx.channelId;
    if (!composer || !messagesFeed || !channelId) return;
    this.publicSelectors = new PublicSelectorView(
      messagesFeed, getActiveNetworkClient(), getActiveServerStore(), channelId
    );
    const store = getActiveChatStore();
    let wasSelected = false;
    this.botChat = new BotChatView(
      store, getActiveNetworkClient(), getActiveServerStore(), channelId, composer, messagesFeed,
      () => {
        if (!ctx.composer.owns(input) || ctx.channelId !== channelId) return;
        const selected = !!store.getCommandDraft(channelId);
        ctx.composer.commandDraftChanged(input, selected, wasSelected);
        wasSelected = selected;
        ctx.feed.followEnd();
      },
      (invocation) => ctx.feed.renderInvocationCard(invocation)
    );
  }

  public unmount(): void {
    this.selection++;
    this.publicSelectors?.destroy();
    this.publicSelectors = null;
    this.botChat?.destroy();
    this.botChat = null;
    this.close();
  }

  private setActive(index: number, scroll = true): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.matches.length) return;
    this.activeIndex = index;
    const dropup = this.ctx.container.querySelector<HTMLElement>('#command-dropup');
    let active: HTMLElement | undefined;
    dropup?.querySelectorAll<HTMLElement>('[data-cmd-index]').forEach((row) => {
      const selected = Number(row.dataset.cmdIndex) === index;
      row.classList.toggle('active', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected) active = row;
    });
    const groupId = active?.closest<HTMLElement>('[data-command-section]')?.dataset.commandSection;
    dropup?.querySelectorAll<HTMLButtonElement>('[data-command-group]').forEach((button) => {
      button.classList.toggle('active', button.dataset.commandGroup === groupId);
    });
    this.ctx.container.querySelector('#chat-message-input')?.setAttribute('aria-activedescendant', `command-option-${index}`);
    if (scroll && active) smoothScrollIntoView(active, { block: 'nearest', inline: 'nearest' });
  }

  private apply(index: number, userGesture = false, autoInvoke = true): void {
    if (!this.ctx.composer.isCurrent() || this.ctx.composer.messageEdit) return;
    const denied = this.deniedReason();
    if (denied) {
      this.showNotice(denied);
      this.render();
      return;
    }
    const input = this.ctx.container.querySelector<MarkdownInput>('#chat-message-input');
    const cmd = this.matches[index];
    if (!input || !cmd) {
      this.close();
      return;
    }
    const typed = parseTypedCommand(input.value, chatStore.getCommands(), this.locale);
    this.select(cmd, typed.kind === 'command' || typed.kind === 'ambiguous' ? typed.text : '', userGesture, autoInvoke);
  }

  private async prepareDownload(command: SlashCommand, text: string, userGesture: boolean, autoInvoke: boolean): Promise<void> {
    const store = getActiveChatStore();
    const client = getActiveNetworkClient();
    const connectionId = client.getConnectionId();
    const channelId = this.ctx.channelId;
    const view = this.botChat;
    const selection = this.selection;
    const sourceText = this.ctx.container.querySelector<MarkdownInput>('#chat-message-input')?.value;
    const current = () => view !== null && this.botChat === view && this.ctx.channelId === channelId &&
      getActiveChatStore() === store && client.getConnectionId() === connectionId &&
      !this.ctx.composer.messageEdit && selection === this.selection && client.getStatus() === 'CONNECTED' &&
      this.ctx.container.querySelector<MarkdownInput>('#chat-message-input')?.value === sourceText;
    if (!window.api?.soundDownloadAvailability) {
      this.showNotice(t('botChat.downloadDesktopOnly'));
      return;
    }
    if (!settingsStore.soundboardFolderPath) {
      this.close();
      this.showNotice(t('botChat.downloadFolderRequired'));
      return;
    }
    try {
      const availability = await window.api.soundDownloadAvailability(settingsStore.soundboardFolderPath);
      if (!current()) return;
      if (availability === 'ready') {
        this.activate(command, text, userGesture, true, autoInvoke);
        return;
      }
      this.close();
      this.showNotice(t(availability === 'unavailable' ? 'botChat.downloadWriteFailed'
        : availability === 'confirmation_required' ? 'botChat.downloadFolderNeedsConfirmation' : 'botChat.downloadFolderRequired'));
    } catch {
      if (current()) this.showNotice(t('botChat.downloadWriteFailed'));
    }
  }

  private activate(command: SlashCommand, text: string, userGesture: boolean, downloadConsent: boolean, autoInvoke: boolean): void {
    const channelId = this.ctx.channelId;
    if (!this.ctx.composer.isCurrent() || this.ctx.composer.messageEdit || !channelId) return;
    if (this.deniedReason(command) || !chatStore.isCommandAvailable(command)) {
      this.showNotice(this.deniedReason(command) ?? t('botChat.commandUnavailable'));
      return;
    }
    this.showNotice('');
    this.ctx.mentions.close();
    this.close();
    this.ctx.composer.closeEmojiPicker();
    chatStore.selectCommand(channelId, command, text, downloadConsent);
    const draft = chatStore.getCommandDraft(channelId);
    if (draft && !command.options?.length && text.trim()) {
      chatStore.setCommandPending(channelId, draft, false, t('botChat.unexpectedText'));
      showErrorToast(t('botChat.unexpectedText'));
    }
    void this.botChat?.activateCommand(userGesture, autoInvoke);
  }
}
