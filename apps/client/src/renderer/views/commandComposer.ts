import { LIMITS, type BotFormValues, type UserSummary } from '@monky/shared';
import type { CommandDraft } from '../stores/chatStore';
import { t } from '../i18n';
import { getAvatarUrl } from '../utils/avatar';
import { escapeHtml } from '../utils/html';
import { visibleCommandFields, type BotInputField } from '../utils/botInputs';
import { optionalParameterLabel } from './commandCatalog';

export interface ParameterChoice {
  value: string;
  label: string;
  description?: string;
  avatarUrl?: string | null;
}

export function commandParameterChoices(field: BotInputField, members: UserSummary[]): ParameterChoice[] {
  if (field.type === 'select') return field.choices;
  if (field.type === 'user') return members.map((member) => ({
    value: member.id, label: member.nickname, avatarUrl: member.avatarUrl,
  }));
  return [];
}

export function commandParameterHint(field: BotInputField): string {
  const parts = [field.label];
  if (field.type === 'integer') {
    if (field.min !== undefined) parts.push(t('botChat.minimum', { value: field.min }));
    if (field.max !== undefined) parts.push(t('botChat.maximum', { value: field.max }));
  }
  parts.push(t(field.required ? 'botChat.required' : 'botChat.optional'));
  return parts.join(' · ');
}

function renderInlineField(field: BotInputField, values: BotFormValues, prefix: string, disabled: boolean, members: UserSummary[]): string {
  if (field.type === 'string-list') return '';
  const id = escapeHtml(`${prefix}-${field.name}`);
  const name = escapeHtml(field.name);
  const value = values[field.name];
  const attributes = `id="${id}" name="${name}" data-bot-input aria-label="${escapeHtml(`${field.name}: ${field.label}`)}" aria-required="${!!field.required}" ${disabled ? 'disabled' : ''}`;
  let control: string;
  if (field.type === 'boolean') {
    control = `<span class="bot-switch-row">
      <label class="toggle-switch toggle-switch-sm">
        <input type="checkbox" role="switch" ${attributes} ${value === true ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
      <span class="bot-switch-value">${t(typeof value === 'boolean' ? value ? 'botChat.switchOn' : 'botChat.switchOff' : 'botChat.skipped')}</span>
    </span>`;
  } else if (field.type === 'select' || field.type === 'user') {
    const selected = commandParameterChoices(field, members).find((choice) => choice.value === value);
    control = `<button type="button" class="bot-argument-choice" ${attributes} data-bot-choice="${name}"
      role="combobox" aria-haspopup="listbox" aria-expanded="false">
      <span>${escapeHtml(selected?.label ?? field.placeholder ?? t(field.type === 'user' ? 'botChat.chooseMember' : 'botChat.choose'))}</span>
      <span class="material-symbols-outlined md-16" aria-hidden="true">expand_more</span>
    </button>`;
  } else {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const placeholder = field.placeholder ?? t(field.type === 'integer' ? 'botChat.integerPlaceholder' : 'botChat.textPlaceholder');
    control = field.type === 'integer'
      ? `<input class="bot-argument-input bot-argument-number" type="text" inputmode="numeric" maxlength="30" ${attributes}
          value="${escapeHtml(text)}" placeholder="${escapeHtml(placeholder)}">`
      : `<textarea class="bot-argument-input bot-argument-text" rows="1" ${attributes}
          maxlength="${LIMITS.MAX_MESSAGE_LENGTH}" placeholder="${escapeHtml(placeholder)}">
${escapeHtml(text)}</textarea>`;
  }
  return `<div class="bot-inline-argument ${field.required ? 'required' : 'optional'}" data-field-name="${name}">
    <label class="bot-argument-name" for="${id}">${name}</label>
    ${control}
    ${!field.required ? `<button type="button" class="bot-remove-argument" data-remove-parameter="${name}"
      aria-label="${escapeHtml(t('botChat.removeParameter', { name: field.name }))}" title="${escapeHtml(t('botChat.removeParameter', { name: field.name }))}"
      ${disabled ? 'disabled' : ''}><span class="material-symbols-outlined md-14">close</span></button>` : ''}
  </div>`;
}

export function renderCompactCommand(draft: CommandDraft, channelId: string, members: UserSummary[], canSend: boolean, available: boolean): string {
  const fields = visibleCommandFields(draft.command, draft.visibleOptionalNames);
  const optionalCount = (draft.command.options ?? []).filter((option) =>
    !option.required && !draft.visibleOptionalNames.includes(option.name)).length;
  const disabled = draft.pending || !canSend;
  const hint = fields[0] ? commandParameterHint(fields[0]) : draft.command.description;
  return `<form class="bot-compact-command-form" data-command-form novalidate>
    <div class="bot-command-hint">
      <strong data-parameter-hint-name>${escapeHtml(fields[0]?.name ?? `/${draft.command.name}`)}</strong>
      <span data-parameter-hint-description>${escapeHtml(hint)}</span>
      <span class="bot-private-cue" title="${t('botChat.private')}"><span class="material-symbols-outlined md-14">lock</span><span>${t('botChat.private')}</span></span>
      <button type="button" class="bot-command-close" data-bot-action="cancel-command" title="${t('botChat.cancelCommand')}"
        aria-label="${t('botChat.cancelCommand')}" ${draft.pending ? 'disabled' : ''}><span class="material-symbols-outlined md-18">close</span></button>
    </div>
    <div class="bot-inline-command">
      <img class="bot-command-avatar" src="${escapeHtml(getAvatarUrl(draft.command.botAvatarUrl))}" alt=""
        title="${escapeHtml(t('botChat.commandFrom', { bot: draft.command.botName }))}" data-fallback="avatar">
      <span class="bot-command-token"><strong>/${escapeHtml(draft.command.name)}</strong><small>${escapeHtml(draft.command.botName)}</small></span>
      <div class="bot-command-arguments">
        ${fields.map((field) => renderInlineField(field, draft.values, `command-${channelId}`, disabled, members)).join('')}
        ${optionalCount ? `<button type="button" class="bot-add-parameters" data-bot-action="optional-parameters" aria-haspopup="listbox"
          aria-expanded="false" title="${t('botChat.addParameters')}" ${disabled ? 'disabled' : ''}>${optionalParameterLabel(optionalCount)}</button>` : ''}
      </div>
      <button type="submit" class="btn btn-primary bot-command-run" ${disabled || !available ? 'disabled' : ''}
        title="${t(draft.pending ? 'botChat.invoking' : 'botChat.execute')}" aria-label="${t(draft.pending ? 'botChat.invoking' : 'botChat.execute')}">
        <span class="material-symbols-outlined md-18">${draft.pending ? 'hourglass_empty' : 'send'}</span>
      </button>
    </div>
    <p class="bot-error" role="alert" ${draft.error || !available ? '' : 'hidden'}>${escapeHtml(draft.error ?? (!available ? t('botChat.commandUnavailable') : ''))}</p>
    <div class="bot-parameter-menu" id="bot-parameter-options" hidden></div>
  </form>`;
}

export function renderParameterChoices(choices: ParameterChoice[], activeIndex: number, label: string): string {
  return `<div role="listbox" aria-label="${escapeHtml(label)}">
    ${choices.map((choice, index) => `<button type="button" class="bot-parameter-option ${index === activeIndex ? 'active' : ''}"
      id="bot-parameter-option-${index}" role="option" aria-selected="${index === activeIndex}" data-parameter-option="${index}">
      ${choice.avatarUrl ? `<img src="${escapeHtml(getAvatarUrl(choice.avatarUrl))}" alt="" data-fallback="avatar">` : ''}
      <span><strong>${escapeHtml(choice.label)}</strong>${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ''}</span>
    </button>`).join('')}
  </div>`;
}
