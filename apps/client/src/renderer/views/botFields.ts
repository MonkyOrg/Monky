import { LIMITS, type BotFormValues, type UserSummary } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { type BotInputField } from '../utils/botInputs';
import { t } from '../i18n';
import { choicesHaveAudio, renderAudioPreviewVolume, renderSelectionChoiceList } from '../utils/selectionChoices';
import type { NetworkClient } from '../core/NetworkClient';
import { communityImagePreview, uploadCommunityImage } from '../utils/communityImages';
import { pickAndCropImages, pickImages } from './ImageCropModal';
import { renderImageCarouselEditor, renderImageDropzone } from './ImageCarousel';

export interface BotFieldContext {
  prefix: string;
  disabled: boolean;
  nativeForm?: boolean;
  readOnly?: boolean;
  members?: Pick<UserSummary, 'id' | 'nickname'>[];
  volumeScope?: string;
  persistentSelection?: boolean;
  imageUpload?: { client: NetworkClient; channelId: string };
}

function listRows(field: BotInputField, value: BotFormValues[string] | undefined): string[] {
  if (Array.isArray(value) && value.length > 0) return value;
  const count = field.type === 'string-list' ? field.minItems ?? 1 : 1;
  return Array.from({ length: count }, () => '');
}

function constraints(field: BotInputField): string {
  const hints: string[] = [];
  if (field.type === 'integer') {
    if (field.min !== undefined) hints.push(t('botChat.minimum', { value: field.min }));
    if (field.max !== undefined) hints.push(t('botChat.maximum', { value: field.max }));
  } else if (field.type === 'text') {
    if (field.minLength !== undefined) hints.push(t('botChat.minLength', { value: field.minLength }));
    if (field.maxLength !== undefined) hints.push(t('botChat.maxLength', { value: field.maxLength }));
  } else if (field.type === 'string-list') {
    if (field.minItems !== undefined) hints.push(t('botChat.minItems', { value: field.minItems }));
    if (field.maxItems !== undefined) hints.push(t('botChat.maxItems', { value: field.maxItems }));
    if (field.maxLength !== undefined) hints.push(t('botChat.maxLength', { value: field.maxLength }));
  }
  return hints.map(escapeHtml).join(' · ');
}

export function renderBotField(field: BotInputField, values: BotFormValues, context: BotFieldContext): string {
  const id = escapeHtml(`${context.prefix}-${field.name}`);
  const name = escapeHtml(field.name);
  const value = values[field.name];
  const disabled = context.disabled ? 'disabled' : '';
  const placeholder = 'placeholder' in field ? field.placeholder : undefined;
  const common = `id="${id}" name="${name}" data-bot-input ${disabled} aria-required="${!!field.required}"`;
  let control: string;
  if (field.type === 'rating') {
    const selected = typeof value === 'number' ? value : 0;
    control = `<div class="native-form-rating" id="${id}" role="group" aria-label="${escapeHtml(field.label)}">
      ${Array.from({ length: 5 }, (_, index) => {
        const rating = index + 1;
        return `<button type="button" data-field-action="set-rating" data-rating-value="${rating}"
          aria-label="${escapeHtml(t('liveForm.ratingValue', { value: rating }))}"
          aria-pressed="${selected === rating}" ${disabled}>
          <span class="native-form-rating-number" aria-hidden="true">${rating}</span>
          <span class="material-symbols-outlined" aria-hidden="true">${selected >= rating ? 'star' : 'star_outline'}</span>
        </button>`;
      }).join('')}
    </div>`;
  } else if (field.type === 'boolean') {
    const state = typeof value === 'boolean'
      ? t(value ? 'botChat.switchOn' : 'botChat.switchOff')
      : t('botChat.skipped');
    control = `<div class="bot-switch-row">
      <label class="toggle-switch">
        <input type="checkbox" role="switch" ${common} ${value === true ? 'checked' : ''} aria-label="${escapeHtml(field.label)}">
        <span class="toggle-slider"></span>
      </label>
      <span class="bot-switch-value">${state}</span>
    </div>`;
  } else if (field.type === 'image-list') {
    const images = Array.isArray(value) ? value : [];
    const max = field.maxItems ?? LIMITS.MAX_LIVE_ACTION_IMAGES;
    const previews = images.map(ref => communityImagePreview(ref) ??
      'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=');
    control = `<div class="bot-image-inputs">
      ${images.length ? renderImageCarouselEditor(previews, {
        label: field.label,
        addLabel: t('botChat.addImage'),
        removeLabel: t('botChat.removeImage'),
        moveBackLabel: t('botChat.moveImageBack'),
        moveForwardLabel: t('botChat.moveImageForward'),
        disabled: context.disabled,
        addDisabled: images.length >= max,
        presentation: field.presentation ?? {},
      }) : renderImageDropzone(context.disabled || images.length >= max, field.presentation)}
    </div>`;
  } else if (field.type === 'select' && choicesHaveAudio(field.choices)) {
    control = `<div class="bot-field-choice-list" id="${id}" data-bot-choice-list="${name}" tabindex="-1" aria-label="${escapeHtml(field.label)}">
      ${renderSelectionChoiceList({
        choices: field.choices,
        selectedValue: typeof value === 'string' ? value : undefined,
        activeIndex: typeof value === 'string' ? undefined : 0,
        label: field.label,
        header: t('botChat.parameterChoices', { name: field.label }),
        idPrefix: `${id}-choice`,
        keyPrefix: `${context.prefix}:${field.name}`,
        volumeScope: context.volumeScope ?? context.prefix,
        showVolume: false,
        optionAttributes: (choice) => `data-bot-select-value="${escapeHtml(choice.value)}" data-bot-select-submit="${field.presentation === 'buttons' ? 'true' : 'false'}"`,
      })}
    </div>`;
  } else if (field.type === 'select' && field.presentation === 'buttons' && context.nativeForm) {
    control = `<div class="native-form-choice-list native-form-choice-list--single" id="${id}" role="group" aria-label="${escapeHtml(field.label)}">
      ${field.choices.map((choice) => `<button type="button" class="native-form-choice-option"
        data-bot-select-value="${escapeHtml(choice.value)}" aria-pressed="${choice.value === value}" ${disabled}>
        <span class="native-form-answer-marker" aria-hidden="true"></span>
        <span>${escapeHtml(choice.label)}</span>
      </button>`).join('')}
    </div>`;
  } else if (field.type === 'select' && field.presentation === 'buttons') {
    control = `<div class="bot-choice-buttons" id="${id}" role="group" aria-label="${escapeHtml(field.label)}">
      ${field.choices.map((choice) => `<button type="button" class="btn btn-secondary"
        data-bot-select-value="${escapeHtml(choice.value)}" ${disabled}${context.persistentSelection ? ` aria-pressed="${choice.value === value}"` : ''}>${escapeHtml(choice.label)}</button>`).join('')}
    </div>`;
  } else if (field.type === 'multi-select' && context.nativeForm) {
    const selected = Array.isArray(value) ? value : [];
    control = `<div class="native-form-choice-list native-form-choice-list--multiple" id="${id}" role="group" aria-label="${escapeHtml(field.label)}">
      ${field.choices.map(choice => `<button type="button" class="native-form-choice-option"
        data-field-action="toggle-choice" data-choice-value="${escapeHtml(choice.value)}"
        aria-pressed="${selected.includes(choice.value)}" ${disabled}>
        <span class="native-form-answer-marker" aria-hidden="true"></span>
        <span>${escapeHtml(choice.label)}</span>
      </button>`).join('')}
    </div>`;
  } else if (field.type === 'multi-select') {
    const selected = Array.isArray(value) ? value : [];
    control = `<div class="bot-choice-buttons" id="${id}" role="group" aria-label="${escapeHtml(field.label)}">
    ${field.choices.map(choice => `<button type="button" class="btn btn-secondary"
      data-field-action="toggle-choice" data-choice-value="${escapeHtml(choice.value)}"
      aria-pressed="${selected.includes(choice.value)}" ${disabled}>${escapeHtml(choice.label)}</button>`).join('')}
    </div>`;
  } else if (field.type === 'select' || field.type === 'user') {
    const choices = field.type === 'select'
      ? field.choices
      : (context.members ?? []).map((member) => ({ label: member.nickname, value: member.id }));
    control = `<select class="input-field" ${common}>
      <option value="">${escapeHtml(placeholder ?? t(field.type === 'user' ? 'botChat.chooseMember' : 'botChat.choose'))}</option>
      ${choices.map((choice) => `<option value="${escapeHtml(choice.value)}" ${choice.value === value ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}
    </select>`;
  } else if (field.type === 'string-list') {
    const rows = listRows(field, value);
    const min = field.minItems ?? 1;
    const max = field.maxItems ?? LIMITS.MAX_BOT_FORM_LIST_ITEMS;
    control = `<div class="bot-list-inputs">${rows.map((entry, index) => `
      <div class="bot-list-row">
        <input class="input-field" type="text" id="${id}-${index}" data-bot-input data-list-index="${index}"
          value="${escapeHtml(entry)}" maxlength="${field.maxLength ?? LIMITS.MAX_MESSAGE_LENGTH}"
          placeholder="${escapeHtml(placeholder ?? t('botChat.listPlaceholder'))}"
          aria-label="${escapeHtml(field.label)} ${index + 1}" ${disabled}>
        <button type="button" class="btn bot-field-icon" data-field-action="remove" data-list-index="${index}"
          aria-label="${escapeHtml(t('botChat.removeItem', { index: index + 1 }))}"
          ${context.disabled || rows.length <= min ? 'disabled' : ''}><span class="material-symbols-outlined md-18">remove</span></button>
      </div>`).join('')}
      <button type="button" class="btn btn-secondary bot-add-item" data-field-action="add"
        ${context.disabled || rows.length >= max ? 'disabled' : ''}>${t('botChat.addItem')}</button>
    </div>`;
  } else {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const prompt = placeholder ?? t(field.type === 'integer' ? 'botChat.integerPlaceholder' : 'botChat.textPlaceholder');
    control = field.type === 'text' && field.multiline
      ? `<textarea class="input-field bot-textarea" rows="2" ${common} maxlength="${field.maxLength ?? LIMITS.MAX_MESSAGE_LENGTH}"
          placeholder="${escapeHtml(prompt)}">
${escapeHtml(text)}</textarea>`
      : `<input class="input-field" type="${field.type === 'integer' ? 'number' : 'text'}" ${field.type === 'integer'
        ? `inputmode="numeric" step="1"${field.min !== undefined ? ` min="${field.min}"` : ''}${field.max !== undefined ? ` max="${field.max}"` : ''}`
        : ''}
          ${common} value="${escapeHtml(text)}" ${field.type === 'text' ? `maxlength="${field.maxLength ?? LIMITS.MAX_MESSAGE_LENGTH}"` : ''}
          placeholder="${escapeHtml(prompt)}">`;
  }
  const hint = constraints(field);
  const hasValue = value !== undefined && value !== null
    && (typeof value !== 'string' || value.trim().length > 0)
    && (!Array.isArray(value) || value.length > 0);
  return `<div class="bot-field${context.nativeForm ? ' native-form-question' : ''}" data-field-name="${name}" data-field-type="${field.type}">
    <div class="bot-field-heading">
      <label for="${field.type === 'string-list' ? `${id}-0` : id}">${escapeHtml(field.label)}</label>
      <span class="bot-field-requirement${field.required ? ' bot-field-requirement--required' : ''}">${t(field.required ? 'botChat.required' : 'botChat.optional')}</span>
      ${!field.required && !context.readOnly ? `<button type="button" class="bot-field-clear" data-field-action="clear"
        ${context.nativeForm && !hasValue ? 'hidden' : ''} ${disabled}>${t(context.nativeForm ? 'common.clear' : 'botChat.clear')}</button>` : ''}
    </div>
    ${field.description ? `<div class="bot-field-description">${escapeHtml(field.description)}</div>` : ''}
    ${control}
    ${hint ? `<div class="bot-field-description">${hint}</div>` : ''}
  </div>`;
}

export function renderBotFields(fields: BotInputField[], values: BotFormValues, context: BotFieldContext): string {
  const hasAudio = fields.some((field) => field.type === 'select' && choicesHaveAudio(field.choices));
  return `<div class="bot-fields${context.nativeForm ? ' native-form-fields' : ''}${context.readOnly ? ' native-form-fields--readonly' : ''}">${hasAudio ? renderAudioPreviewVolume(context.volumeScope ?? context.prefix) : ''}
    ${fields.map((field) => renderBotField(field, values, context)).join('')}</div>`;
}

export function readBotFieldChange(
  target: EventTarget | null,
  fields: BotInputField[],
  values: BotFormValues
): BotFormValues | null {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return null;
  if (!target.hasAttribute('data-bot-input')) return null;
  const root = target.closest<HTMLElement>('[data-field-name]');
  const field = fields.find((entry) => entry.name === root?.dataset.fieldName);
  if (!root || !field) return null;
  let value: BotFormValues[string];
  if (field.type === 'boolean' && target instanceof HTMLInputElement) {
    value = target.checked;
    const state = root.querySelector('.bot-switch-value');
    if (state) state.textContent = t(value ? 'botChat.switchOn' : 'botChat.switchOff');
  } else if (field.type === 'string-list') {
    value = [...root.querySelectorAll<HTMLInputElement>('[data-bot-input]')].map((input) => input.value);
  } else value = target.value;
  return { ...values, [field.name]: value };
}

export function applyBotFieldAction(
  button: HTMLButtonElement,
  fields: BotInputField[],
  values: BotFormValues,
  context: BotFieldContext
): BotFormValues | null {
  if (context.disabled) return null;
  const root = button.closest<HTMLElement>('[data-field-name]');
  const field = fields.find((entry) => entry.name === root?.dataset.fieldName);
  if (!root || !field) return null;
  const next = { ...values };
  if (button.dataset.fieldAction === 'clear' && !field.required) {
    delete next[field.name];
  } else if (field.type === 'rating' && button.dataset.fieldAction === 'set-rating') {
    const rating = Number(button.dataset.ratingValue);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
    next[field.name] = rating;
  } else if (field.type === 'multi-select' && button.dataset.fieldAction === 'toggle-choice') {
    const value = button.dataset.choiceValue;
    if (!value || !field.choices.some(choice => choice.value === value)) return null;
    const selected = Array.isArray(values[field.name]) ? [...values[field.name] as string[]] : [];
    next[field.name] = selected.includes(value)
      ? selected.filter(entry => entry !== value)
      : [...selected, value];
  } else if (field.type === 'string-list') {
    const rows = [...listRows(field, values[field.name])];
    if (button.dataset.fieldAction === 'add' && rows.length < (field.maxItems ?? LIMITS.MAX_BOT_FORM_LIST_ITEMS)) rows.push('');
    else if (button.dataset.fieldAction === 'remove' && rows.length > (field.minItems ?? 1)) {
      const index = Number(button.dataset.listIndex);
      if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null;
      rows.splice(index, 1);
    } else return null;
    next[field.name] = rows;
  } else if (field.type === 'image-list') {
    const images = Array.isArray(values[field.name]) ? [...values[field.name] as string[]] : [];
    const index = Number(button.dataset.listIndex ??
      button.closest<HTMLElement>('[data-image-carousel]')?.dataset.carouselIndex);
    const action = button.dataset.carouselEdit ?? button.dataset.fieldAction?.replace('image-', '');
    if (action === 'remove' && Number.isInteger(index) && index >= 0 && index < images.length) {
      images.splice(index, 1);
    } else if ((action === 'back' || action === 'forward') && Number.isInteger(index)) {
      const target = index + (action === 'back' ? -1 : 1);
      if (target < 0 || target >= images.length) return null;
      [images[index], images[target]] = [images[target], images[index]];
    } else return null;
    next[field.name] = images;
  } else return null;
  const parent = root.parentElement;
  root.outerHTML = renderBotField(field, next, context);
  if (field.type === 'multi-select' || field.type === 'rating') {
    const selector = field.type === 'multi-select'
      ? `[data-choice-value="${CSS.escape(button.dataset.choiceValue ?? '')}"]`
      : `[data-rating-value="${CSS.escape(button.dataset.ratingValue ?? '')}"]`;
    parent?.querySelector<HTMLElement>(
      `[data-field-name="${CSS.escape(field.name)}"] ${selector}`,
    )?.focus();
    return next;
  }
  const rows = field.type === 'string-list' ? listRows(field, next[field.name]) : [];
  const index = button.dataset.fieldAction === 'add' ? rows.length - 1 :
    Math.min(Number(button.dataset.listIndex ?? 0), Math.max(0, rows.length - 1));
  document.getElementById(`${context.prefix}-${field.name}${field.type === 'string-list' ? `-${index}` : ''}`)?.focus();
  return next;
}

export async function addBotFieldImage(
  button: HTMLButtonElement,
  fields: BotInputField[],
  values: BotFormValues,
  context: BotFieldContext,
  droppedImages?: string[],
): Promise<BotFormValues | null> {
  if (context.disabled || !context.imageUpload ||
      (button.dataset.carouselEdit ?? button.dataset.fieldAction?.replace('image-', '')) !== 'add') return null;
  const root = button.closest<HTMLElement>('[data-field-name]');
  const field = fields.find(entry => entry.name === root?.dataset.fieldName);
  if (!root || field?.type !== 'image-list') return null;
  const images = Array.isArray(values[field.name]) ? [...values[field.name] as string[]] : [];
  const remaining = (field.maxItems ?? LIMITS.MAX_LIVE_ACTION_IMAGES) - images.length;
  if (remaining <= 0) return null;
  const selected = droppedImages?.slice(0, remaining) ??
    (field.presentation?.fit === 'contain'
      ? await pickImages(button, remaining)
      : await pickAndCropImages(button, remaining, field.presentation?.format ?? 'banner'));
  if (selected.length === 0) return null;
  const uploaded = [];
  for (const data of selected) {
    uploaded.push(await uploadCommunityImage(context.imageUpload.client, context.imageUpload.channelId, data));
  }
  const next = { ...values, [field.name]: [...images, ...uploaded.map(image => image.ref)] };
  root.outerHTML = renderBotField(field, next, context);
  return next;
}
