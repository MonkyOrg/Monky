import {
  LIMITS,
  MessageType,
  Permission,
  botSettingsListResponseSchema,
  type BotFormValues,
  type CommandFinishedPayload,
  type CommandInvokedPayload,
  type CommandInvokePayload,
  type CommandSubmitPayload,
  type CommandAutocompletePayload,
  type CommandAutocompleteResultPayload,
} from '@monky/shared';
import { v4 as uuidv4 } from 'uuid';
import { appEvents } from '../core/EventBus';
import { type NetworkClient } from '../core/NetworkClient';
import { getActiveChatStore, type BotInvocation, type ChatStore } from '../stores/chatStore';
import { type ServerStore } from '../stores/serverStore';
import { getLanguage, t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';
import { getAvatarUrl } from '../utils/avatar';
import {
  botInputError,
  botRequestError,
  commandInputFields,
  commandValuesFromInputs,
  autocompleteCommandOptions,
  formValuesFromInputs,
  visibleCommandFields,
  visibleCommandValues,
  type BotInputField,
} from '../utils/botInputs';
import { applyBotFieldAction, readBotFieldChange, renderBotFields, type BotFieldContext } from './botFields';
import {
  commandParameterChoices, commandParameterHint, commandParameterError, renderCompactCommand, renderParameterChoices,
  type ParameterChoice,
} from './commandComposer';
import { CommandAutocomplete, type AutocompleteState } from '../utils/commandAutocomplete';
import { settingsStore } from '../stores/settingsStore';
import { localSoundDownloads } from '../core/LocalSoundDownloadService';
import { soundDownloadText } from '../utils/soundDownloadText';
import { audioPreviewService } from '../core/AudioPreviewService';
import { commandPreviewVolumeScope } from '../utils/selectionChoices';
import { botPreferenceScopeFor, botUserSettingsPayload } from '../utils/botSettingsContext';
import { botSettingsMenuItem } from './BotSettingsModal';
import { contextMenu } from './ContextMenu';
import { currentEventOrigin } from '../core/sessionRouting';

const FINISH_KEYS: Record<Exclude<BotInvocation['status'], 'active'>, TranslationKey> = {
  completed: 'botChat.completed',
  cancelled: 'botChat.cancelled',
  expired: 'botChat.expired',
  bot_disconnected: 'botChat.botDisconnected',
  caller_disconnected: 'botChat.callerDisconnected',
  failed: 'botChat.failed',
};

export function renderBotIdentity(name: string, avatarUrl?: string | null): string {
  return `<div class="bot-chat-identity">
    <img class="chat-author-avatar" src="${escapeHtml(getAvatarUrl(avatarUrl))}" alt="" data-fallback="avatar">
    <span class="chat-author-name">${escapeHtml(name)}</span>
    <span class="member-badge-bot">${t('botChat.badge')}</span>
    <span class="bot-private-cue"><span class="material-symbols-outlined md-14" aria-hidden="true">lock</span>${t('botChat.private')}</span>
  </div>`;
}

export function renderBotInvocation(invocation: BotInvocation, canSend = true, serverId?: string): string {
  const visibleForms = invocation.forms.filter((state) => state.status !== 'submitted');
  // The attributed reply already represents a completed text-only command.
  if (invocation.status === 'completed' && visibleForms.length === 0 && invocation.hasResponse && !invocation.soundDownload) return '';
  const active = invocation.status === 'active';
  const volumeScope = commandPreviewVolumeScope(serverId, invocation.botId, invocation.commandName);
  const forms = visibleForms.map((state) => {
    const editable = active && !invocation.cancelPending && state.status === 'editing' && canSend;
    const buttonsOnly = state.form.fields.length === 1 &&
      state.form.fields[0].type === 'select' && state.form.fields[0].presentation === 'buttons';
    return `<form class="bot-inline-form" data-interaction-id="${escapeHtml(state.interactionId)}" novalidate>
      <h3>${escapeHtml(state.form.title)}</h3>
      ${state.form.description ? `<p class="bot-field-description">${escapeHtml(state.form.description)}</p>` : ''}
      ${renderBotFields(state.form.fields, state.values, { prefix: `${invocation.invocationId}-${state.interactionId}`, disabled: !editable, volumeScope })}
      <p class="bot-error" role="alert" ${state.error ? '' : 'hidden'}>${escapeHtml(state.error)}</p>
      ${state.status === 'submitted' ? `<p class="bot-status">${t('botChat.submitted')}</p>` :
        state.status === 'closed' || !active ? `<p class="bot-status">${t('botChat.stepClosed')}</p>` :
          buttonsOnly ? '' : `<button type="submit" class="btn btn-primary" ${!editable ? 'disabled' : ''}>
            ${escapeHtml(state.status === 'submitting' ? t('botChat.submitting') : state.form.submitLabel ?? t('botChat.submit'))}
          </button>`}
    </form>`;
  }).join('');
  const download = invocation.soundDownload;
  const downloadConfirming = download?.phase === 'confirming' && !download.result;
  const waiting = active && !download && !invocation.forms.some((form) => form.status === 'editing' || form.status === 'submitting');
  return `<section class="bot-interaction-card" data-invocation-id="${escapeHtml(invocation.invocationId)}">
    ${renderBotIdentity(invocation.botName, invocation.botAvatarUrl)}
    ${invocation.commandName ? `<div class="bot-command-name">/${escapeHtml(invocation.commandName)}</div>` : ''}
    ${forms}
    ${download ? `<div class="bot-sound-download">
      <strong>${escapeHtml(download.title)}</strong><small>${escapeHtml(download.fileName)}</small>
      ${!download.result && !downloadConfirming ? `<progress ${download.totalBytes ? `value="${download.receivedBytes}" max="${download.totalBytes}"` : ''}></progress>` : ''}
      <p class="bot-status" role="status">${escapeHtml(downloadConfirming ? t('botChat.downloadConfirmationPending') :
        download.result ? soundDownloadText(download.result) :
        t('botChat.downloadProgress', { received: Math.round(download.receivedBytes / 1024),
          total: download.totalBytes ? `${Math.round(download.totalBytes / 1024)} KiB` : t('botChat.downloadUnknownSize') }))}</p>
    </div>` : ''}
    ${waiting ? `<p class="bot-status" role="status">${t('botChat.waiting')}</p>` : ''}
    ${invocation.status !== 'active' && !download ? `<p class="bot-status" role="status">${t(FINISH_KEYS[invocation.status])}</p>` : ''}
    <p class="bot-error" role="alert" ${invocation.error ? '' : 'hidden'}>${escapeHtml(invocation.error)}</p>
    ${active ? `<button type="button" class="btn btn-secondary bot-cancel-interaction" data-bot-action="cancel-invocation"
      ${invocation.cancelPending ? 'disabled' : ''}>${t(invocation.cancelPending ? 'botChat.cancelling' : 'botChat.cancelInvocation')}</button>` : ''}
  </section>`;
}

interface FieldBinding {
  fields: BotInputField[];
  values: BotFormValues;
  context: BotFieldContext;
  save: (values: BotFormValues) => void;
}

type ParameterMenu =
  | { kind: 'optional'; activeIndex: number }
  | { kind: 'choices' | 'autocomplete'; fieldName: string; activeIndex: number };

/**
 * DOM listeners belong to this channel view; drafts and forms belong to its
 * captured session. A late acknowledgement never writes through active proxies.
 */
export class BotChatView {
  private unbind: Array<() => void> = [];
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private parameterMenu: ParameterMenu | null = null;
  private menuChoices: ParameterChoice[] = [];
  private focusedParameter: string | null = null;
  private suppressChoiceFocus = false;
  private autocomplete: CommandAutocomplete;
  private autocompleteField: string | null = null;
  private composing = false;
  private deferredRender = false;
  private submitGesture = false;
  private settingsRevisions = new Map<string, string>();

  constructor(
    private store: ChatStore,
    private client: NetworkClient,
    private server: ServerStore,
    private channelId: string,
    private composer: HTMLElement,
    private feed: HTMLElement,
    private onComposerChanged: () => void,
    private onInvocationChanged: (invocation: BotInvocation) => void
  ) {
    this.autocomplete = new CommandAutocomplete(client, (query, signal) => this.queryAutocomplete(query, signal),
      (state) => this.renderAutocomplete(state));
    if (server.serverDetails && server.currentUser) {
      store.setCommandUsageScope({ serverId: server.serverDetails.id, callerId: server.currentUser.id });
    }
    for (const root of [composer, feed]) {
      root.addEventListener('input', this.onInput);
      root.addEventListener('change', this.onInput);
      root.addEventListener('click', this.onClick);
      root.addEventListener('contextmenu', this.onContextMenu);
      root.addEventListener('submit', this.onSubmit);
      root.addEventListener('keydown', this.onKeyDown);
      root.addEventListener('focusin', this.onFocus);
      root.addEventListener('focusout', this.onBlur);
      root.addEventListener('compositionstart', this.onCompositionStart);
      root.addEventListener('compositionend', this.onCompositionEnd);
      this.unbind.push(audioPreviewService.bind(root));
      this.unbind.push(() => {
        root.removeEventListener('input', this.onInput);
        root.removeEventListener('change', this.onInput);
        root.removeEventListener('click', this.onClick);
        root.removeEventListener('contextmenu', this.onContextMenu);
        root.removeEventListener('submit', this.onSubmit);
        root.removeEventListener('keydown', this.onKeyDown);
        root.removeEventListener('focusin', this.onFocus);
        root.removeEventListener('focusout', this.onBlur);
        root.removeEventListener('compositionstart', this.onCompositionStart);
        root.removeEventListener('compositionend', this.onCompositionEnd);
      });
    }
    const closeOutsideMenu = (event: PointerEvent) => {
      if (event.target instanceof Node && !this.composer.contains(event.target)) this.closeParameterMenu();
    };
    document.addEventListener('pointerdown', closeOutsideMenu);
    this.unbind.push(() => document.removeEventListener('pointerdown', closeOutsideMenu));
    this.unbind.push(
      appEvents.on('chat.command_draft_updated', ({ channelId }: { channelId: string }) => {
        if (this.isCurrent() && channelId === this.channelId) this.renderComposer();
      }),
      appEvents.on('chat.bot_interaction_updated', (event: { channelId: string; invocationId: string }) => {
        if (!this.isCurrent() || event.channelId !== this.channelId) return;
        const invocation = this.store.getInvocation(event.invocationId);
        if (invocation) this.onInvocationChanged(invocation);
        audioPreviewService.prune(this.feed);
        this.scheduleExpiry();
      }),
      appEvents.on('server.roles_updated', () => this.refreshPermissions()),
      appEvents.on('network.status', () => {
        if (this.isCurrent() && this.client.getStatus() !== 'CONNECTED') {
          this.closeParameterMenu();
          this.renderComposer();
        }
      }),
      appEvents.on('server.updated', () => this.refreshPermissions()),
      appEvents.on('server.members_updated', () => this.refreshMembers()),
      appEvents.on('user.updated', () => this.refreshMembers()),
      appEvents.on('bot.preferences_updated', ({ scope, customChanged }: { scope: string; customChanged: boolean }) => {
        const draft = this.store.getCommandDraft(this.channelId);
        if (!customChanged || !this.isCurrent() || !this.canSend() || !draft ||
            scope !== botPreferenceScopeFor(this.client, this.server, draft.command.botId)) return;
        this.invalidateAutocomplete();
      }),
      appEvents.on('message.BOT_SETTINGS_LIST_RESPONSE', (payload: unknown) => {
        const origin = currentEventOrigin();
        if (!this.isCurrent() || (origin !== null && origin !== this.client.sessionKey)) return;
        const parsed = botSettingsListResponseSchema.safeParse(payload);
        if (!parsed.success) { console.warn('[Bot settings] Invalid settings catalog.'); return; }
        const next = new Map(parsed.data.bots.map((bot) => [bot.botId, `${bot.schemaRevision}:${bot.revision}`]));
        const botId = this.store.getCommandDraft(this.channelId)?.command.botId;
        const changed = botId !== undefined && this.settingsRevisions.get(botId) !== next.get(botId);
        this.settingsRevisions = next;
        if (changed) this.invalidateAutocomplete();
      })
    );
    this.store.expireInvocations();
    this.renderComposer();
    this.scheduleExpiry();
  }

  private isCurrent(): boolean {
    return !this.destroyed && getActiveChatStore() === this.store;
  }

  private invalidateAutocomplete(): void {
    const field = this.autocompleteField;
    this.closeParameterMenu();
    if (field) this.openAutocomplete(field);
  }

  private onContextMenu = (event: MouseEvent): void => {
    if (!this.isCurrent() || !(event.target instanceof Element) ||
        !event.target.closest('.bot-chat-identity .chat-author-avatar, .bot-chat-identity .chat-author-name')) return;
    const card = event.target.closest<HTMLElement>('[data-invocation-id]');
    const invocation = this.store.getInvocation(card?.dataset.invocationId ?? '');
    if (!invocation || invocation.channelId !== this.channelId) return;
    event.preventDefault();
    contextMenu.open(event.clientX, event.clientY, [botSettingsMenuItem(invocation.botId, this.client, this.server)]);
  };

  private canSend(): boolean {
    const channel = this.server.serverDetails?.channels.find((candidate) => candidate.id === this.channelId);
    return channel?.type === 'TEXT' && channel.botCommandsEnabled &&
      this.server.hasPermission(Permission.USE_BOT_COMMANDS) &&
      this.server.hasPermission(Permission.SEND_MESSAGES) && this.client.getStatus() === 'CONNECTED';
  }

  public renderComposer(): void {
    if (this.composing) { this.deferredRender = true; return; }
    this.deferredRender = false;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.composer.contains(active) ? active : null;
    const focusId = focused?.id;
    const focusAction = focused?.dataset.botAction;
    const removeParameter = focused?.dataset.removeParameter;
    const focusedMenu = !!focused?.closest('#bot-parameter-options');
    const menu = this.parameterMenu ? { ...this.parameterMenu } : null;
    const activeChoice = menu ? this.menuChoices[menu.activeIndex]?.value : undefined;
    const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? {
        start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection,
        scrollTop: focused.scrollTop, scrollLeft: focused.scrollLeft,
      } : undefined;
    this.closeParameterMenu();
    const draft = this.store.getCommandDraft(this.channelId);
    this.composer.hidden = !draft;
    if (!draft) {
      this.composer.innerHTML = '';
      this.onComposerChanged();
      return;
    }
    const available = this.store.isCommandAvailable(draft.command);
    this.composer.innerHTML = renderCompactCommand(
      draft, this.channelId, this.server.getHumanMembersInDisplayOrder(), this.canSend(), available
    );
    this.onComposerChanged();
    if (menu?.kind === 'autocomplete') this.openAutocomplete(menu.fieldName);
    else if (menu) this.openParameterMenu(menu, activeChoice);
    if (focused) {
      const next = focusedMenu
        ? this.composer.querySelector<HTMLElement>('[data-parameter-option][aria-selected="true"]')
        : [...this.composer.querySelectorAll<HTMLElement>('[id], [data-bot-action], [data-remove-parameter]')].find((element) =>
          (focusId && element.id === focusId) || (focusAction && element.dataset.botAction === focusAction) ||
          (removeParameter && element.dataset.removeParameter === removeParameter));
      this.suppressChoiceFocus = true;
      next?.focus({ preventScroll: true });
      this.suppressChoiceFocus = false;
      if (selection && selection.start !== null && selection.end !== null &&
          (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && next.type !== 'checkbox') {
        next.setSelectionRange(selection.start, selection.end, selection.direction ?? 'none');
        next.scrollTop = selection.scrollTop;
        next.scrollLeft = selection.scrollLeft;
      }
    }
    this.updateParameterHint();
  }

  public focusComposer(): void {
    const first = this.composer.querySelector<HTMLElement>('[data-bot-input]:not(:disabled)');
    const name = first?.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
    if (name) this.focusParameter(name);
    else this.composer.querySelector<HTMLElement>('button[type="submit"]:not(:disabled)')?.focus();
  }

  private refreshPermissions(): void {
    if (!this.isCurrent()) return;
    this.renderComposer();
    for (const invocation of this.store.getInvocations(this.channelId)) this.onInvocationChanged(invocation);
    audioPreviewService.prune(this.feed);
  }

  private refreshMembers(): void {
    if (this.isCurrent() && this.store.getCommandDraft(this.channelId)?.command.options?.some((field) => field.type === 'user')) {
      this.renderComposer();
    }
  }

  private fieldBinding(target: HTMLElement): FieldBinding | undefined {
    if (this.composer.contains(target)) {
      const draft = this.store.getCommandDraft(this.channelId);
      if (!draft) return;
      return {
        fields: visibleCommandFields(draft.command, draft.visibleOptionalNames),
        values: draft.values,
        context: { prefix: `command-${this.channelId}`, disabled: draft.pending || !this.canSend(), members: this.server.getHumanMembersInDisplayOrder() },
        save: (values) => this.store.setCommandValues(this.channelId, values),
      };
    }
    const invocation = this.store.getInvocation(target.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId ?? '');
    const interactionId = target.closest<HTMLElement>('[data-interaction-id]')?.dataset.interactionId;
    const form = invocation?.forms.find((state) => state.interactionId === interactionId);
    if (!invocation || invocation.channelId !== this.channelId || !form) return;
    return {
      fields: form.form.fields,
      values: form.values,
      context: {
        prefix: `${invocation.invocationId}-${form.interactionId}`,
        disabled: !this.canSend() || invocation.status !== 'active' || invocation.cancelPending || form.status !== 'editing',
        volumeScope: commandPreviewVolumeScope(this.server.serverDetails?.id, invocation.botId, invocation.commandName),
      },
      save: (values) => this.store.setFormValues(invocation.invocationId, form.interactionId, values),
    };
  }

  private onFocus = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (!this.composer.contains(event.target)) {
      this.closeParameterMenu();
      this.updateParameterHint();
      return;
    }
    const name = event.target.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
    if (name) {
      this.focusedParameter = name;
      if (event.target.dataset.botChoice && !this.suppressChoiceFocus) {
        this.openParameterMenu({ kind: 'choices', fieldName: name, activeIndex: 0 });
      } else if (event.target.dataset.botAutocomplete && !this.suppressChoiceFocus) {
        this.openAutocomplete(name);
      } else if (!event.target.dataset.botChoice && !event.target.dataset.botAutocomplete) this.closeParameterMenu();
    } else if (!event.target.closest('#bot-parameter-options') && event.target.dataset.botAction !== 'optional-parameters') {
      this.closeParameterMenu();
    }
    this.updateParameterHint();
  };

  private onBlur = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.composer.contains(event.target) || !this.isCurrent()) return;
    const field = event.target.closest<HTMLElement>('[data-field-name]');
    if (field?.dataset.fieldName && !(event.relatedTarget instanceof Node && field.contains(event.relatedTarget))) {
      this.store.touchCommandField(this.channelId, field.dataset.fieldName);
      this.updateParameterValidation();
    }
    queueMicrotask(() => { if (!this.destroyed && this.isCurrent()) this.updateParameterHint(); });
  };

  private updateParameterHint(): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft) return;
    const fields = visibleCommandFields(draft.command, draft.visibleOptionalNames);
    const field = fields.find((entry) => entry.name === this.focusedParameter) ?? fields[0];
    this.focusedParameter = field?.name ?? null;
    const label = this.composer.querySelector<HTMLElement>('[data-parameter-hint-name]');
    const description = this.composer.querySelector<HTMLElement>('[data-parameter-hint-description]');
    if (label) label.textContent = field?.name ?? `/${draft.command.name}`;
    if (description) {
      description.textContent = field ? commandParameterHint(field) : draft.command.description;
      description.title = description.textContent;
    }
    const active = document.activeElement;
    const activeName = active instanceof HTMLElement && this.composer.contains(active)
      ? active.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName ??
        (active.closest('[data-parameter-option]') && this.parameterMenu?.kind !== 'optional' ? this.parameterMenu?.fieldName : undefined)
      : undefined;
    this.composer.querySelectorAll<HTMLElement>('[data-field-name]').forEach((element) => {
      element.classList.toggle('focused', element.dataset.fieldName === activeName);
    });
  }

  private updateParameterValidation(): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft) return;
    const members = this.server.getHumanMembersInDisplayOrder();
    for (const field of visibleCommandFields(draft.command, draft.visibleOptionalNames)) {
      const element = [...this.composer.querySelectorAll<HTMLElement>('[data-field-name]')]
        .find((entry) => entry.dataset.fieldName === field.name);
      if (!element) continue;
      const error = commandParameterError(draft, field, members);
      element.classList.toggle('invalid', !!error);
      if (error) element.setAttribute('title', error);
      else element.removeAttribute('title');
      const input = element.querySelector<HTMLElement>('[data-bot-input]');
      if (error) input?.setAttribute('aria-invalid', 'true');
      else input?.removeAttribute('aria-invalid');
    }
  }

  private updateCommandSubmitState(): void {
    const draft = this.store.getCommandDraft(this.channelId);
    const button = this.composer.querySelector<HTMLButtonElement>('.bot-command-run');
    if (!draft || !button) return;
    const canExecute = commandValuesFromInputs(
      draft.command,
      visibleCommandValues(draft.command, draft.values, draft.visibleOptionalNames),
      this.server.getHumanMembersInDisplayOrder(),
      draft.autocomplete,
      draft.visibleOptionalNames
    ).success;
    button.disabled = draft.pending || !this.canSend() || !this.store.isCommandAvailable(draft.command) || !canExecute;
  }

  private updateArgumentMeasure(input: HTMLInputElement | HTMLTextAreaElement): void {
    const measure = input.closest('.bot-argument-size')?.querySelector<HTMLElement>('[data-argument-measure-value]');
    if (measure) measure.textContent = input.value;
  }

  private parameterChoices(): ParameterChoice[] {
    const draft = this.store.getCommandDraft(this.channelId);
    const menu = this.parameterMenu;
    if (!draft || !menu) return [];
    if (menu.kind === 'optional') return (draft.command.options ?? [])
      .filter((option) => !option.required && !draft.visibleOptionalNames.includes(option.name))
      .map((option) => ({ value: option.name, label: option.name, description: option.description }));
    const field = commandInputFields(draft.command).find((entry) => entry.name === menu.fieldName);
    return field ? commandParameterChoices(field, this.server.getHumanMembersInDisplayOrder()) : [];
  }

  private parameterMenuTrigger(): HTMLElement | null {
    const menu = this.parameterMenu;
    if (menu?.kind === 'optional') return this.composer.querySelector('[data-bot-action="optional-parameters"]');
    if (menu?.kind === 'choices') return [...this.composer.querySelectorAll<HTMLElement>('[data-bot-choice]')]
      .find((element) => element.dataset.botChoice === menu.fieldName) ?? null;
    if (menu?.kind === 'autocomplete') return [...this.composer.querySelectorAll<HTMLElement>('[data-bot-autocomplete]')]
      .find((element) => element.dataset.botAutocomplete === menu.fieldName) ?? null;
    return null;
  }

  private openParameterMenu(menu: ParameterMenu, activeValue?: string): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || !this.canSend()) return;
    this.closeParameterMenu();
    this.parameterMenu = menu;
    const trigger = this.parameterMenuTrigger();
    const choices = this.parameterChoices();
    if (!trigger || choices.length === 0) {
      this.closeParameterMenu();
      return;
    }
    this.menuChoices = choices;
    if (activeValue !== undefined) {
      menu.activeIndex = Math.max(0, choices.findIndex((choice) => choice.value === activeValue));
    } else if (menu.kind === 'choices') {
      menu.activeIndex = Math.max(0, choices.findIndex((choice) => choice.value === draft.values[menu.fieldName]));
    }
    const element = this.composer.querySelector<HTMLElement>('#bot-parameter-options');
    if (!element) return;
    element.hidden = false;
    element.innerHTML = renderParameterChoices(choices, menu.activeIndex,
      menu.kind === 'optional' ? t('botChat.addParameters') : t('botChat.parameterChoices', { name: menu.fieldName }),
      this.parameterChoiceScope(menu.kind === 'optional' ? 'optional' : menu.fieldName),
      commandPreviewVolumeScope(this.server.serverDetails?.id, draft.command.botId, draft.command.name));
    element.style.left = '';
    trigger?.setAttribute('aria-expanded', 'true');
    trigger?.setAttribute('aria-controls', 'bot-parameter-options');
    element.querySelectorAll<HTMLElement>('[data-parameter-option]').forEach((option) => {
      option.addEventListener('mouseenter', () => this.setParameterMenuActive(Number(option.dataset.parameterOption), false));
    });
    this.setParameterMenuActive(menu.activeIndex);
  }

  private setParameterMenuActive(index: number, scroll = true): void {
    if (!this.parameterMenu || index < 0 || index >= this.menuChoices.length) return;
    this.parameterMenu.activeIndex = index;
    this.composer.querySelectorAll<HTMLElement>('[data-parameter-option]').forEach((option) => {
      const active = Number(option.dataset.parameterOption) === index;
      option.classList.toggle('active', active);
      option.setAttribute('aria-selected', String(active));
      option.tabIndex = active ? 0 : -1;
      if (active && scroll) option.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    this.parameterMenuTrigger()?.setAttribute('aria-activedescendant', `bot-parameter-option-${index}`);
  }

  private parameterChoiceScope(fieldName: string): string {
    const command = this.store.getCommandDraft(this.channelId)?.command;
    return JSON.stringify([this.server.serverDetails?.id, command?.botId, command?.name, fieldName]);
  }

  private closeParameterMenu(restoreFocus = false): void {
    const trigger = this.parameterMenuTrigger();
    this.autocomplete.close();
    this.autocompleteField = null;
    this.parameterMenu = null;
    this.menuChoices = [];
    audioPreviewService.release(this.composer);
    const element = this.composer.querySelector<HTMLElement>('#bot-parameter-options');
    if (element) { element.hidden = true; element.innerHTML = ''; }
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.removeAttribute('aria-controls');
    trigger?.removeAttribute('aria-activedescendant');
    if (restoreFocus) {
      this.suppressChoiceFocus = true;
      trigger?.focus();
      this.suppressChoiceFocus = false;
    }
  }

  private focusParameter(name: string, offerChoices = true): void {
    const field = [...this.composer.querySelectorAll<HTMLElement>('[data-field-name]')]
      .find((element) => element.dataset.fieldName === name);
    const input = field?.querySelector<HTMLElement>('[data-bot-input]');
    this.focusedParameter = name;
    this.suppressChoiceFocus = true;
    input?.focus();
    this.suppressChoiceFocus = false;
    this.updateParameterHint();
    if (offerChoices && input?.dataset.botChoice) {
      this.openParameterMenu({ kind: 'choices', fieldName: name, activeIndex: 0 });
    } else if (offerChoices && input?.dataset.botAutocomplete) this.openAutocomplete(name);
  }

  private selectParameterMenuOption(index: number, userGesture = false): void {
    const menu = this.parameterMenu;
    const choice = this.menuChoices[index];
    const draft = this.store.getCommandDraft(this.channelId);
    if (!menu || !choice || !draft || draft.pending) return;
    this.closeParameterMenu();
    if (menu.kind === 'optional') {
      if (this.store.setCommandOptionVisible(this.channelId, choice.value, true)) this.focusParameter(choice.value);
    } else {
      if (menu.kind === 'autocomplete') this.store.selectCommandChoice(this.channelId, menu.fieldName, choice);
      else this.store.setCommandValues(this.channelId, { ...draft.values, [menu.fieldName]: choice.value });
      this.renderComposer();
      this.focusParameter(menu.fieldName, false);
      const hasOptionalParameters = (draft.command.options ?? []).some((option) => !option.required);
      if (menu.kind === 'autocomplete' && !hasOptionalParameters && commandValuesFromInputs(draft.command,
        visibleCommandValues(draft.command, draft.values, draft.visibleOptionalNames),
        this.server.getHumanMembersInDisplayOrder(), draft.autocomplete, draft.visibleOptionalNames).success) void this.invoke(userGesture);
    }
  }

  private handleParameterArrowRight(event: KeyboardEvent): boolean {
    if (event.key !== 'ArrowRight' || this.parameterMenu || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
        !(event.target instanceof HTMLElement) || !this.composer.contains(event.target)) return false;
    const fieldRoot = event.target.closest<HTMLElement>('[data-field-name]');
    if (!fieldRoot) return false;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      if (event.target instanceof HTMLInputElement && event.target.type === 'range') return false;
      if (event.target.type !== 'checkbox' && (event.target.selectionStart === null || event.target.selectionEnd === null ||
          event.target.selectionStart !== event.target.selectionEnd || event.target.selectionEnd !== event.target.value.length)) return false;
    } else if (!(event.target instanceof HTMLButtonElement)) return false;
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending) return false;
    const fields = visibleCommandFields(draft.command, draft.visibleOptionalNames);
    const index = fields.findIndex((field) => field.name === fieldRoot.dataset.fieldName);
    if (index < 0) return false;
    const next = fields[index + 1];
    if (next) {
      event.preventDefault();
      this.focusParameter(next.name);
      return true;
    }
    const optionalCount = (draft.command.options ?? []).filter((option) =>
      !option.required && !draft.visibleOptionalNames.includes(option.name)).length;
    if (optionalCount > 0) {
      const trigger = this.composer.querySelector<HTMLElement>('[data-bot-action="optional-parameters"]');
      event.preventDefault();
      this.suppressChoiceFocus = true;
      trigger?.focus();
      this.suppressChoiceFocus = false;
      this.openParameterMenu({ kind: 'optional', activeIndex: 0 });
      return true;
    }
    return false;
  }

  private handleParameterMenuKey(event: KeyboardEvent): boolean {
    if (!(event.target instanceof HTMLElement)) return false;
    if (audioPreviewService.ownsEventTarget(event.target)) return false;
    const menu = this.parameterMenu;
    if (menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const choices = this.menuChoices;
        if (choices.length) this.setParameterMenuActive((menu.activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
        return true;
      }
      if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        if (this.menuChoices[menu.activeIndex]) this.selectParameterMenuOption(menu.activeIndex, event.isTrusted);
        else if (event.key === 'Enter' && menu.kind === 'autocomplete') {
          const submit = this.composer.querySelector<HTMLButtonElement>('.bot-command-run');
          if (submit && !submit.disabled) {
            this.closeParameterMenu();
            void this.invoke(event.isTrusted);
          }
        }
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeParameterMenu(true);
        return true;
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.target.dataset.botAutocomplete) {
        event.preventDefault();
        this.openAutocomplete(event.target.dataset.botAutocomplete);
        return true;
      }
      const fieldName = event.target.dataset.botChoice;
      if (fieldName || event.target.dataset.botAction === 'optional-parameters') {
        event.preventDefault();
        this.openParameterMenu(fieldName
          ? { kind: 'choices', fieldName, activeIndex: 0 } : { kind: 'optional', activeIndex: 0 });
        return true;
      }
    }
    return false;
  }

  private openAutocomplete(name: string): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || !this.canSend() || !this.store.isCommandAvailable(draft.command) ||
        !draft.command.options?.some((option) => option.name === name && option.autocomplete)) return;
    if (this.autocompleteField !== name) {
      this.closeParameterMenu();
      this.autocompleteField = name;
    }
    this.autocomplete.setQuery(draft.autocomplete[name]?.query ?? '');
    if (!draft.autocomplete[name]?.query) this.renderAutocomplete({ status: 'idle', query: '', choices: [] });
  }

  private async queryAutocomplete(query: string, signal: AbortSignal): Promise<CommandAutocompleteResultPayload> {
    const draft = this.store.getCommandDraft(this.channelId);
    const optionName = this.autocompleteField;
    if (!draft || !optionName || draft.pending || !this.isCurrent() || !this.canSend()) {
      throw new DOMException('Autocomplete closed', 'AbortError');
    }
    const requestId = uuidv4();
    const connectionId = this.client.getConnectionId();
    const payload: CommandAutocompletePayload = {
      botId: draft.command.botId, commandName: draft.command.name, channelId: this.channelId, optionName, query,
      options: autocompleteCommandOptions(draft.command, optionName,
        visibleCommandValues(draft.command, draft.values, draft.visibleOptionalNames),
        this.server.getHumanMembersInDisplayOrder(), draft.autocomplete),
      locale: getLanguage(),
      ...botUserSettingsPayload(this.client, this.server, draft.command.botId),
    };
    const response = this.client.sendRequest<CommandAutocompleteResultPayload>(
      MessageType.COMMAND_AUTOCOMPLETE, payload, requestId, LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS
    );
    const cancel = () => {
      if (this.client.cancelRequest(requestId) && this.client.getStatus() === 'CONNECTED' &&
          this.client.getConnectionId() === connectionId) {
        this.client.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId });
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try { return await response; } finally { signal.removeEventListener('abort', cancel); }
  }

  private renderAutocomplete(state: AutocompleteState): void {
    const fieldName = this.autocompleteField;
    const draft = this.store.getCommandDraft(this.channelId);
    if (!fieldName || !draft || !this.isCurrent() || this.composing || draft.pending ||
        (draft.autocomplete[fieldName]?.query ?? '') !== state.query) return;
    this.parameterMenu = { kind: 'autocomplete', fieldName, activeIndex: state.choices.length ? 0 : -1 };
    this.menuChoices = state.choices;
    const trigger = this.parameterMenuTrigger();
    const menu = this.composer.querySelector<HTMLElement>('#bot-parameter-options');
    if (!trigger || !menu) return;
    const keys = {
      idle: 'botChat.autocompleteHint', loading: 'botChat.autocompleteLoading',
      empty: 'botChat.autocompleteEmpty', failed: 'botChat.autocompleteError', ready: 'botChat.parameterChoices',
    } as const;
    menu.hidden = false;
    menu.innerHTML = state.choices.length
      ? renderParameterChoices(state.choices, 0, t('botChat.parameterChoices', { name: fieldName }), this.parameterChoiceScope(fieldName),
        commandPreviewVolumeScope(this.server.serverDetails?.id, draft.command.botId, draft.command.name))
      : `<p class="bot-autocomplete-status" role="status" aria-live="polite">${escapeHtml(
        state.status === 'failed' && state.error ? state.error : t(keys[state.status]))}</p>`;
    menu.setAttribute('aria-busy', String(state.status === 'loading'));
    menu.style.left = '';
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'bot-parameter-options');
    trigger.removeAttribute('aria-activedescendant');
    menu.querySelectorAll<HTMLElement>('[data-parameter-option]').forEach((option) => {
      option.addEventListener('mouseenter', () => this.setParameterMenuActive(Number(option.dataset.parameterOption), false));
    });
    if (state.choices.length) this.setParameterMenuActive(0);
  }

  private onCompositionStart = (event: CompositionEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.composer.contains(event.target)) return;
    this.composing = true;
    this.closeParameterMenu();
  };

  private onCompositionEnd = (event: CompositionEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.composer.contains(event.target)) return;
    this.composing = false;
    const name = event.target.dataset.botAutocomplete;
    if (name && event.target instanceof HTMLInputElement) this.store.setCommandQuery(this.channelId, name, event.target.value);
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) this.updateArgumentMeasure(event.target);
    this.updateParameterValidation();
    this.updateCommandSubmitState();
    if (this.deferredRender) this.renderComposer();
    if (name) this.openAutocomplete(name);
  };

  private onInput = (event: Event): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (audioPreviewService.ownsEventTarget(event.target)) return;
    const binding = this.fieldBinding(event.target);
    if (!binding || binding.context.disabled) return;
    if (event.target instanceof HTMLInputElement && event.target.dataset.botAutocomplete) {
      const name = event.target.dataset.botAutocomplete;
      if (event instanceof InputEvent && event.isComposing) {
        this.composing = true;
        this.closeParameterMenu();
      }
      this.store.setCommandQuery(this.channelId, name, event.target.value);
      this.updateArgumentMeasure(event.target);
      this.updateParameterValidation();
      const error = event.target.closest('form')?.querySelector<HTMLElement>('.bot-error');
      if (error) { error.textContent = ''; error.hidden = true; }
      this.updateCommandSubmitState();
      if (!this.composing) this.openAutocomplete(name);
      return;
    }
    const values = readBotFieldChange(event.target, binding.fields, binding.values);
    if (!values) return;
    binding.save(values);
    if (this.composer.contains(event.target)) {
      this.updateCommandSubmitState();
      this.updateParameterValidation();
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) this.updateArgumentMeasure(event.target);
    } else event.target.removeAttribute('aria-invalid');
    const error = event.target.closest('form')?.querySelector<HTMLElement>('.bot-error');
    if (error) { error.textContent = ''; error.hidden = true; }
  };

  private onClick = (event: Event): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (event.defaultPrevented || audioPreviewService.ownsEventTarget(event.target)) return;
    const parameterOption = event.target.closest<HTMLElement>('[data-parameter-option]');
    if (parameterOption && this.composer.contains(parameterOption)) {
      event.preventDefault();
      this.selectParameterMenuOption(Number(parameterOption.dataset.parameterOption), event.isTrusted);
      return;
    }
    const customSelect = event.target.closest<HTMLElement>('[data-bot-select-value]');
    if (customSelect && !(customSelect instanceof HTMLButtonElement)) {
      event.preventDefault();
      this.chooseBotSelectValue(customSelect);
      return;
    }
    const button = event.target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.type === 'submit' && this.composer.contains(button)) {
      this.submitGesture = event.isTrusted;
      queueMicrotask(() => { this.submitGesture = false; });
    }
    if (button.dataset.botChoice) {
      this.openParameterMenu({ kind: 'choices', fieldName: button.dataset.botChoice, activeIndex: 0 });
    } else if (button.dataset.removeParameter) {
      this.store.setCommandOptionVisible(this.channelId, button.dataset.removeParameter, false);
      this.focusComposer();
    } else if (button.dataset.botAction === 'optional-parameters') {
      if (this.parameterMenu?.kind === 'optional') this.closeParameterMenu();
      else this.openParameterMenu({ kind: 'optional', activeIndex: 0 });
    } else if (button.dataset.botSelectValue !== undefined) {
      this.chooseBotSelectValue(button);
    } else if (button.dataset.fieldAction) {
      const binding = this.fieldBinding(button);
      if (!binding) return;
      const error = button.closest('form')?.querySelector<HTMLElement>('.bot-error');
      const values = applyBotFieldAction(button, binding.fields, binding.values, binding.context);
      if (values) {
        binding.save(values);
        if (error) { error.textContent = ''; error.hidden = true; }
      }
    } else if (button.dataset.botAction === 'cancel-command') this.cancelCommand();
    else if (button.dataset.botAction === 'cancel-invocation') {
      const id = button.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId;
      if (id) void this.cancelInvocation(id);
    }
  };

  private onSubmit = (event: Event): void => {
    if (!(event.target instanceof HTMLFormElement) || !this.isCurrent()) return;
    const form = event.target;
    if (form.hasAttribute('data-command-form')) {
      event.preventDefault();
      const gesture = this.submitGesture;
      this.submitGesture = false;
      void this.invoke(gesture);
    } else if (form.dataset.interactionId) {
      event.preventDefault();
      const id = form.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId;
      if (id) void this.submitForm(id, form.dataset.interactionId);
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (audioPreviewService.ownsEventTarget(event.target)) return;
    if (event.isComposing || this.composing || event.keyCode === 229) return;
    if (this.handleBotSelectKey(event)) return;
    const inComposer = this.composer.contains(event.target);
    const card = event.target.closest<HTMLElement>('[data-invocation-id]');
    if (!inComposer && !card) return;
    if (inComposer && this.handleParameterArrowRight(event)) return;
    if (inComposer && this.handleParameterMenuKey(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (inComposer) this.cancelCommand();
      else {
        const id = card?.dataset.invocationId;
        if (id) void this.cancelInvocation(id);
      }
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
      !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLSelectElement) &&
      !(event.target instanceof HTMLInputElement && event.target.type === 'checkbox')) {
      if (event.target instanceof HTMLTextAreaElement && !inComposer && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (inComposer) void this.invoke(event.isTrusted);
      else event.target.closest('form')?.requestSubmit();
    }
  };

  private chooseBotSelectValue(element: HTMLElement): void {
    const value = element.dataset.botSelectValue;
    const binding = this.fieldBinding(element);
    const root = element.closest<HTMLElement>('[data-field-name]');
    const field = binding?.fields.find((entry) => entry.name === root?.dataset.fieldName);
    if (value === undefined || !binding || binding.context.disabled || field?.type !== 'select' ||
        !field.choices.some((choice) => choice.value === value)) return;
    binding.save({ ...binding.values, [field.name]: value });
    root?.querySelectorAll<HTMLElement>('[data-bot-select-value]').forEach((choice) => {
      const selected = choice.dataset.botSelectValue === value;
      choice.classList.toggle('active', selected);
      choice.setAttribute('aria-selected', String(selected));
      choice.tabIndex = selected ? 0 : -1;
    });
    if (element.dataset.botSelectSubmit === 'true' || field.presentation === 'buttons') {
      element.closest('form')?.requestSubmit();
    }
  }

  private handleBotSelectKey(event: KeyboardEvent): boolean {
    const option = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-bot-select-value]')
      : null;
    if (!option) return false;
    const options = [...(option.parentElement?.querySelectorAll<HTMLElement>('[data-bot-select-value]') ?? [])];
    const index = options.indexOf(option);
    if (index < 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = (index + ((event.key === 'ArrowDown' || event.key === 'ArrowRight') ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
      return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.chooseBotSelectValue(option);
      return true;
    }
    return false;
  }

  private cancelCommand(): void {
    if (this.store.getCommandDraft(this.channelId)?.pending) return;
    this.store.clearCommand(this.channelId);
  }

  public async invoke(userGesture = false): Promise<void> {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || !this.canSend()) return;
    const command = draft.command;
    if (!this.store.isCommandAvailable(command)) {
      this.store.setCommandPending(this.channelId, draft, false, t('botChat.commandUnavailable'));
      return;
    }
    const result = commandValuesFromInputs(
      command, visibleCommandValues(command, draft.values, draft.visibleOptionalNames), this.server.getHumanMembersInDisplayOrder(),
      draft.autocomplete, draft.visibleOptionalNames
    );
    if (!result.success) {
      this.store.touchCommandField(this.channelId, result.field);
      this.store.setCommandPending(this.channelId, draft, false, botInputError(commandInputFields(command), result.field, result.reason));
      this.focusInvalidField(`command-${this.channelId}`, result.field);
      return;
    }
    const payload: CommandInvokePayload = {
      commandName: command.name,
      botId: command.botId,
      channelId: this.channelId,
      options: result.values,
      locale: getLanguage(),
    };
    const connectionId = this.client.getConnectionId();
    const folder = settingsStore.soundboardFolderPath;
    if (command.downloadsSound && (!userGesture || !draft.downloadConsent)) {
      this.store.setCommandPending(this.channelId, draft, false, t('botChat.downloadNeedsGesture'));
      return;
    }
    this.store.setCommandPending(this.channelId, draft, true);
    try {
      if (command.downloadsSound) {
        const availability = await window.api?.soundDownloadAvailability?.(folder);
        if (availability !== 'ready') {
          this.store.setCommandPending(this.channelId, draft, false,
            t(availability === 'unavailable' ? 'botChat.downloadWriteFailed'
              : availability === 'confirmation_required' ? 'botChat.downloadFolderNeedsConfirmation' : 'botChat.downloadFolderRequired'));
          return;
        }
        payload.allowSoundDownload = true;
      }
      if (this.store.getCommandDraft(this.channelId) !== draft || !draft.pending ||
          this.client.getConnectionId() !== connectionId || !this.canSend()) return;
      const ack = await this.client.sendRequest<CommandInvokedPayload>(MessageType.COMMAND_INVOKE,
        { ...payload, ...botUserSettingsPayload(this.client, this.server, command.botId) });
      if (this.store.getCommandDraft(this.channelId) !== draft || !draft.pending) return;
      if (!ack || typeof ack.invocationId !== 'string' || !ack.invocationId || ack.invocationId.length > 128 ||
          ack.botId !== command.botId || ack.commandName !== command.name || ack.channelId !== this.channelId ||
          this.client.getConnectionId() !== connectionId || this.client.getStatus() !== 'CONNECTED') {
        this.store.setCommandPending(this.channelId, draft, false, t('botChat.requestFailed'));
        return;
      }
      this.store.acknowledgeCommand(ack, command);
      if (command.downloadsSound) localSoundDownloads.authorize(this.client, this.store, this.server, command, ack, connectionId, folder, userGesture);
      this.store.clearCommand(this.channelId, draft);
    } catch (error) {
      if (draft.pending) this.store.setCommandPending(this.channelId, draft, false, botRequestError(error));
    }
  }

  private async submitForm(invocationId: string, interactionId: string): Promise<void> {
    const invocation = this.store.getInvocation(invocationId);
    const form = invocation?.forms.find((state) => state.interactionId === interactionId);
    if (!invocation || !form || form.status !== 'editing' || !this.canSend()) return;
    const result = formValuesFromInputs(form.form, form.values);
    if (!result.success) {
      this.store.failFormSubmit(invocationId, interactionId, botInputError(form.form.fields, result.field, result.reason));
      this.focusInvalidField(`${invocationId}-${interactionId}`, result.field);
      return;
    }
    if (!this.store.beginFormSubmit(invocationId, interactionId)) return;
    const payload: CommandSubmitPayload = { invocationId, interactionId, values: result.values };
    try {
      const ack = await this.client.sendRequest<CommandSubmitPayload>(MessageType.COMMAND_SUBMIT, payload);
      if (this.store.getInvocation(invocationId) === invocation) this.store.acknowledgeForm(ack);
    } catch (error) {
      if (this.store.getInvocation(invocationId) === invocation) {
        this.store.failFormSubmit(invocationId, interactionId, botRequestError(error));
      }
    }
  }

  private async cancelInvocation(invocationId: string): Promise<void> {
    const invocation = this.store.getInvocation(invocationId);
    if (!invocation || !this.store.setCancelPending(invocationId, true)) return;
    localSoundDownloads.cancelInvocation(this.client, invocationId);
    try {
      const ack = await this.client.sendRequest<CommandFinishedPayload>(MessageType.COMMAND_CANCEL, { invocationId });
      if (this.store.getInvocation(invocationId) === invocation) this.store.finishInvocation(ack);
    } catch (error) {
      if (this.store.getInvocation(invocationId) === invocation) {
        this.store.setCancelPending(invocationId, false, botRequestError(error));
      }
    }
  }

  private focusInvalidField(prefix: string, name: string): void {
    if (!this.isCurrent()) return;
    const field = [...this.composer.querySelectorAll<HTMLElement>('[id]'), ...this.feed.querySelectorAll<HTMLElement>('[id]')]
      .find((element) => element.id === `${prefix}-${name}` || element.id === `${prefix}-${name}-0`);
    field?.setAttribute('aria-invalid', 'true');
    field?.focus();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.destroyed) return;
    const next = this.store.getInvocations(this.channelId)
      .filter((invocation) => invocation.status === 'active')
      .reduce((time, invocation) => Math.min(time, invocation.expiresAt), Infinity);
    if (!Number.isFinite(next)) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.store.expireInvocations();
      this.scheduleExpiry();
    }, Math.max(1, next - Date.now()));
  }

  public destroy(): void {
    this.closeParameterMenu();
    this.destroyed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const unbind of this.unbind) unbind();
    this.unbind = [];
  }
}
