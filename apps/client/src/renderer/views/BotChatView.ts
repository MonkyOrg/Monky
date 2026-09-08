import {
  MessageType,
  Permission,
  type BotFormValues,
  type CommandFinishedPayload,
  type CommandInvokedPayload,
  type CommandInvokePayload,
  type CommandSubmitPayload,
} from '@monky/shared';
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
  formValuesFromInputs,
  visibleCommandFields,
  visibleCommandValues,
  type BotInputField,
} from '../utils/botInputs';
import { applyBotFieldAction, readBotFieldChange, renderBotFields, type BotFieldContext } from './botFields';
import {
  commandParameterChoices, commandParameterHint, renderCompactCommand, renderParameterChoices,
  type ParameterChoice,
} from './commandComposer';

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

export function renderBotInvocation(invocation: BotInvocation, canSend = true): string {
  const visibleForms = invocation.forms.filter((state) => state.status !== 'submitted');
  // The attributed reply already represents a completed text-only command.
  if (invocation.status === 'completed' && visibleForms.length === 0 && invocation.hasResponse) return '';
  const active = invocation.status === 'active';
  const forms = visibleForms.map((state) => {
    const editable = active && !invocation.cancelPending && state.status === 'editing' && canSend;
    const buttonsOnly = state.form.fields.length === 1 &&
      state.form.fields[0].type === 'select' && state.form.fields[0].presentation === 'buttons';
    return `<form class="bot-inline-form" data-interaction-id="${escapeHtml(state.interactionId)}" novalidate>
      <h3>${escapeHtml(state.form.title)}</h3>
      ${state.form.description ? `<p class="bot-field-description">${escapeHtml(state.form.description)}</p>` : ''}
      ${renderBotFields(state.form.fields, state.values, { prefix: `${invocation.invocationId}-${state.interactionId}`, disabled: !editable })}
      <p class="bot-error" role="alert" ${state.error ? '' : 'hidden'}>${escapeHtml(state.error)}</p>
      ${state.status === 'submitted' ? `<p class="bot-status">${t('botChat.submitted')}</p>` :
        state.status === 'closed' || !active ? `<p class="bot-status">${t('botChat.stepClosed')}</p>` :
          buttonsOnly ? '' : `<button type="submit" class="btn btn-primary" ${!editable ? 'disabled' : ''}>
            ${escapeHtml(state.status === 'submitting' ? t('botChat.submitting') : state.form.submitLabel ?? t('botChat.submit'))}
          </button>`}
    </form>`;
  }).join('');
  const waiting = active && !invocation.forms.some((form) => form.status === 'editing' || form.status === 'submitting');
  return `<section class="bot-interaction-card" data-invocation-id="${escapeHtml(invocation.invocationId)}">
    ${renderBotIdentity(invocation.botName, invocation.botAvatarUrl)}
    ${invocation.commandName ? `<div class="bot-command-name">/${escapeHtml(invocation.commandName)}</div>` : ''}
    ${forms}
    ${waiting ? `<p class="bot-status" role="status">${t('botChat.waiting')}</p>` : ''}
    ${invocation.status !== 'active' ? `<p class="bot-status" role="status">${t(FINISH_KEYS[invocation.status])}</p>` : ''}
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
  | { kind: 'choices'; fieldName: string; activeIndex: number };

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
    if (server.serverDetails && server.currentUser) {
      store.setCommandUsageScope({ serverId: server.serverDetails.id, callerId: server.currentUser.id });
    }
    for (const root of [composer, feed]) {
      root.addEventListener('input', this.onInput);
      root.addEventListener('change', this.onInput);
      root.addEventListener('click', this.onClick);
      root.addEventListener('submit', this.onSubmit);
      root.addEventListener('keydown', this.onKeyDown);
      root.addEventListener('focusin', this.onFocus);
      this.unbind.push(() => {
        root.removeEventListener('input', this.onInput);
        root.removeEventListener('change', this.onInput);
        root.removeEventListener('click', this.onClick);
        root.removeEventListener('submit', this.onSubmit);
        root.removeEventListener('keydown', this.onKeyDown);
        root.removeEventListener('focusin', this.onFocus);
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
        this.scheduleExpiry();
      }),
      appEvents.on('server.roles_updated', () => this.refreshPermissions()),
      appEvents.on('server.updated', () => this.refreshPermissions()),
      appEvents.on('server.members_updated', () => this.refreshMembers()),
      appEvents.on('user.updated', () => this.refreshMembers())
    );
    this.store.expireInvocations();
    this.renderComposer();
    this.scheduleExpiry();
  }

  private isCurrent(): boolean {
    return !this.destroyed && getActiveChatStore() === this.store;
  }

  private canSend(): boolean {
    const channel = this.server.serverDetails?.channels.find((candidate) => candidate.id === this.channelId);
    return channel?.type === 'TEXT' && channel.botCommandsEnabled &&
      this.server.hasPermission(Permission.USE_BOT_COMMANDS) &&
      this.server.hasPermission(Permission.SEND_MESSAGES) && this.client.getStatus() === 'CONNECTED';
  }

  public renderComposer(): void {
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
    this.composer.querySelectorAll<HTMLTextAreaElement>('.bot-argument-text').forEach((input) => this.resizeArgument(input));
    this.updateParameterHint();
    if (menu) this.openParameterMenu(menu, activeChoice);
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
      context: { prefix: `${invocation.invocationId}-${form.interactionId}`, disabled: !this.canSend() || invocation.status !== 'active' || invocation.cancelPending || form.status !== 'editing' },
      save: (values) => this.store.setFormValues(invocation.invocationId, form.interactionId, values),
    };
  }

  private onFocus = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (!this.composer.contains(event.target)) {
      this.closeParameterMenu();
      return;
    }
    const name = event.target.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
    if (name) {
      this.focusedParameter = name;
      this.updateParameterHint();
      if (event.target.dataset.botChoice && !this.suppressChoiceFocus) {
        this.openParameterMenu({ kind: 'choices', fieldName: name, activeIndex: 0 });
      } else if (!event.target.dataset.botChoice) this.closeParameterMenu();
    } else if (!event.target.closest('#bot-parameter-options') && event.target.dataset.botAction !== 'optional-parameters') {
      this.closeParameterMenu();
    }
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
    this.composer.querySelectorAll<HTMLElement>('[data-field-name]').forEach((element) => {
      element.classList.toggle('focused', element.dataset.fieldName === field?.name);
    });
  }

  private resizeArgument(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 72)}px`;
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
      menu.kind === 'optional' ? t('botChat.addParameters') : t('botChat.parameterChoices', { name: menu.fieldName }));
    const bounds = this.composer.getBoundingClientRect();
    const anchor = trigger?.getBoundingClientRect();
    element.style.left = `${Math.max(0, Math.min((anchor?.left ?? bounds.left) - bounds.left, bounds.width - 320))}px`;
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
      if (active && scroll) option.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    this.parameterMenuTrigger()?.setAttribute('aria-activedescendant', `bot-parameter-option-${index}`);
  }

  private closeParameterMenu(restoreFocus = false): void {
    const trigger = this.parameterMenuTrigger();
    this.parameterMenu = null;
    this.menuChoices = [];
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
    this.updateParameterHint();
    this.suppressChoiceFocus = true;
    input?.focus();
    this.suppressChoiceFocus = false;
    if (offerChoices && input?.dataset.botChoice) {
      this.openParameterMenu({ kind: 'choices', fieldName: name, activeIndex: 0 });
    }
  }

  private selectParameterMenuOption(index: number): void {
    const menu = this.parameterMenu;
    const choice = this.menuChoices[index];
    const draft = this.store.getCommandDraft(this.channelId);
    if (!menu || !choice || !draft || draft.pending) return;
    this.closeParameterMenu();
    if (menu.kind === 'optional') {
      if (this.store.setCommandOptionVisible(this.channelId, choice.value, true)) this.focusParameter(choice.value);
    } else {
      this.store.setCommandValues(this.channelId, { ...draft.values, [menu.fieldName]: choice.value });
      this.renderComposer();
      this.focusParameter(menu.fieldName, false);
    }
  }

  private handleParameterMenuKey(event: KeyboardEvent): boolean {
    if (!(event.target instanceof HTMLElement)) return false;
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
        this.selectParameterMenuOption(menu.activeIndex);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeParameterMenu(true);
        return true;
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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

  private onInput = (event: Event): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    const binding = this.fieldBinding(event.target);
    if (!binding || binding.context.disabled) return;
    const values = readBotFieldChange(event.target, binding.fields, binding.values);
    if (!values) return;
    binding.save(values);
    if (event.target instanceof HTMLTextAreaElement && this.composer.contains(event.target)) this.resizeArgument(event.target);
    event.target.removeAttribute('aria-invalid');
    const error = event.target.closest('form')?.querySelector<HTMLElement>('.bot-error');
    if (error) { error.textContent = ''; error.hidden = true; }
  };

  private onClick = (event: Event): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.dataset.parameterOption !== undefined) {
      this.selectParameterMenuOption(Number(button.dataset.parameterOption));
    } else if (button.dataset.botChoice) {
      this.openParameterMenu({ kind: 'choices', fieldName: button.dataset.botChoice, activeIndex: 0 });
    } else if (button.dataset.removeParameter) {
      this.store.setCommandOptionVisible(this.channelId, button.dataset.removeParameter, false);
      this.focusComposer();
    } else if (button.dataset.botAction === 'optional-parameters') {
      if (this.parameterMenu?.kind === 'optional') this.closeParameterMenu();
      else this.openParameterMenu({ kind: 'optional', activeIndex: 0 });
    } else if (button.dataset.botSelectValue !== undefined) {
      const binding = this.fieldBinding(button);
      const fieldName = button.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
      const field = binding?.fields.find((entry) => entry.name === fieldName);
      if (!binding || binding.context.disabled || field?.type !== 'select' ||
          field.presentation !== 'buttons' ||
          !field.choices.some((choice) => choice.value === button.dataset.botSelectValue)) return;
      binding.save({ ...binding.values, [field.name]: button.dataset.botSelectValue });
      button.closest('form')?.requestSubmit();
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
      void this.invoke();
    } else if (form.dataset.interactionId) {
      event.preventDefault();
      const id = form.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId;
      if (id) void this.submitForm(id, form.dataset.interactionId);
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    const inComposer = this.composer.contains(event.target);
    const card = event.target.closest<HTMLElement>('[data-invocation-id]');
    if (!inComposer && !card) return;
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
      event.target.closest('form')?.requestSubmit();
    }
  };

  private cancelCommand(): void {
    if (this.store.getCommandDraft(this.channelId)?.pending) return;
    this.store.clearCommand(this.channelId);
  }

  public async invoke(): Promise<void> {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || !this.canSend()) return;
    const command = draft.command;
    if (!this.store.isCommandAvailable(command)) {
      this.store.setCommandPending(this.channelId, draft, false, t('botChat.commandUnavailable'));
      return;
    }
    const result = commandValuesFromInputs(
      command, visibleCommandValues(command, draft.values, draft.visibleOptionalNames), this.server.getHumanMembersInDisplayOrder()
    );
    if (!result.success) {
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
    this.store.setCommandPending(this.channelId, draft, true);
    try {
      const ack = await this.client.sendRequest<CommandInvokedPayload>(MessageType.COMMAND_INVOKE, payload);
      if (this.store.getCommandDraft(this.channelId) !== draft || !draft.pending) return;
      this.store.acknowledgeCommand(ack, command);
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
