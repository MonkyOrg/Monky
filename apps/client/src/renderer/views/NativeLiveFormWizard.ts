import {
  LIMITS,
  MessageType,
  Permission,
  nativeLiveFormCreateSchema,
  type NativeLiveFormCreate,
  type NativeLiveFormField,
} from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { initialBotInputValues } from '../utils/botInputs';
import { openCommunityModal, type CommunityModal } from './CommunityModal';
import { renderBotFields } from './botFields';
import { ResourceAudiencePicker } from './ResourceAudiencePicker';
import { mountWizard } from './community/wizardShell';
import {
  durationMinutes, isDurationUnit, longestDuration, renderDurationUnit, renderNumberControl, stepNumberControl,
  type DurationUnit,
} from './community/durationField';

type DraftType =
  | 'short_text'
  | 'long_text'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'multi_select'
  | 'dropdown'
  | 'rating';
interface DraftField {
  id: string;
  label: string;
  type: DraftType;
  required: boolean;
  choices: string[];
}

const DRAFT_TYPES: readonly DraftType[] = ['short_text', 'long_text', 'integer', 'boolean', 'select', 'multi_select', 'dropdown', 'rating'];

function isDraftType(value: string | undefined): value is DraftType {
  return DRAFT_TYPES.some(type => type === value);
}

export function openNativeLiveFormWizard(
  client: NetworkClient,
  server: ServerStore,
  channelId: string,
): CommunityModal | undefined {
  if (!server.hasPermission(Permission.EMIT_LIVE_ACTIONS, channelId) ||
      !server.serverDetails?.protocol?.features.includes('native-live-forms')) return;
  const modal = openCommunityModal(t('liveForm.create'), { closeWithSession: true });
  modal.card.classList.add('event-wizard', 'native-poll-wizard', 'native-live-form-wizard');
  let title = '';
  let description = '';
  let duration = '24';
  let unit: DurationUnit = 'hours';
  let anonymous = false;
  let nextField = 2;
  let fields: DraftField[] = [{
    id: 'field_1',
    label: '',
    type: 'short_text',
    required: true,
    choices: [t('liveForm.defaultChoice', { number: 1 }), t('liveForm.defaultChoice', { number: 2 })],
  }];
  let pending = false;
  const audience = new ResourceAudiencePicker(server, 'live-form-audience');
  const fieldSelector = (id: string, control: string) => `[data-live-form-field="${CSS.escape(id)}"] ${control}`;

  const normalizedFields = (): NativeLiveFormField[] => fields.map((field) => {
    const common = { name: field.id, label: field.label.trim(), required: field.required };
    if (field.type === 'short_text') return { ...common, type: 'text', multiline: false, maxLength: 500 };
    if (field.type === 'long_text') return { ...common, type: 'text', multiline: true, maxLength: 4000 };
    if (field.type === 'integer') return { ...common, type: 'integer' };
    if (field.type === 'boolean') return { ...common, type: 'boolean' };
    if (field.type === 'rating') return { ...common, type: 'rating' };
    const choices = field.choices.map((label, index) => ({ value: `choice_${index + 1}`, label: label.trim() }));
    if (field.type === 'select') return {
      ...common,
      type: 'select',
      presentation: 'buttons',
      choices,
    };
    if (field.type === 'dropdown') return { ...common, type: 'select', presentation: 'dropdown', choices };
    return { ...common, type: 'multi-select', choices };
  });
  const payload = (): NativeLiveFormCreate => ({
    channelId,
    durationMinutes: durationMinutes(duration, unit),
    form: {
      title: title.trim(),
      description: description.trim() || undefined,
      fields: normalizedFields(),
      submitLabel: t('liveForm.submit'),
      anonymous,
    },
    audience: audience.value(),
  });
  const detailsValid = () => {
    const minutes = durationMinutes(duration, unit);
    return title.trim().length >= 1 && title.trim().length <= 100 && description.length <= 1000 &&
      Number.isInteger(minutes) && minutes >= 1 && minutes <= 43_200 && audience.isValid();
  };
  const fieldsValid = () => fields.length >= 1 && fields.length <= LIMITS.MAX_BOT_FORM_FIELDS &&
    fields.every(field => field.label.trim().length >= 1 && field.label.trim().length <= 100 &&
      (!['select', 'multi_select', 'dropdown'].includes(field.type) || (field.choices.length >= 2 &&
        field.choices.length <= LIMITS.MAX_BOT_FORM_CHOICES &&
        field.choices.every(choice => choice.trim().length >= 1 && choice.trim().length <= 80) &&
        new Set(field.choices.map(choice => choice.trim().toLocaleLowerCase())).size === field.choices.length)));

  const detailsStep = () => `<section class="native-poll-step" data-live-form-step="0">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">description</span>
      <div><h2 tabindex="-1">${t('liveForm.step.details')}</h2><p>${t('liveForm.detailsHint')}</p></div></div>
    <label>${t('liveForm.title')} <span class="required-indicator">*</span>
      <input class="input-field" data-live-form-title maxlength="100" value="${escapeHtml(title)}"
        placeholder="${escapeHtml(t('liveForm.titlePlaceholder'))}" ${pending ? 'disabled' : ''}></label>
    <label>${t('liveForm.description')}
      <textarea class="input-field bot-textarea" data-live-form-description maxlength="1000"
        placeholder="${escapeHtml(t('liveForm.descriptionPlaceholder'))}" ${pending ? 'disabled' : ''}>${escapeHtml(description)}</textarea>
    </label>
    <div class="native-poll-settings-grid">
      <label>${t('liveForm.duration')}${renderNumberControl({
        hook: 'live-form-duration', value: duration, min: 1, max: longestDuration(unit),
        label: t('liveForm.duration'), disabled: pending,
      })}</label>
      ${renderDurationUnit('live-form-unit', unit)}
    </div>
    <div class="bot-permission-row native-live-form-anonymous-row">
      <div><label for="native-live-form-anonymous">${t('liveForm.anonymous')}</label>
        <p class="bot-settings-description">${t('liveForm.anonymousHint')}</p></div>
      <label class="toggle-switch"><input id="native-live-form-anonymous" data-live-form-anonymous
        type="checkbox" role="switch" ${anonymous ? 'checked' : ''} ${pending ? 'disabled' : ''}>
        <span class="toggle-slider"></span></label>
    </div>
    ${audience.render(pending)}
  </section>`;

  const fieldCard = (field: DraftField, index: number) => `<article class="native-live-form-field" data-live-form-field="${escapeHtml(field.id)}">
    <header><strong>${t('liveForm.fieldNumber', { number: index + 1 })}</strong>
      <button type="button" class="btn bot-field-icon native-live-form-remove-button" data-live-form-remove-field="${escapeHtml(field.id)}"
        aria-label="${escapeHtml(t('liveForm.removeField'))}" ${fields.length <= 1 ? 'disabled' : ''}>
        <span class="material-symbols-outlined md-18">delete</span></button></header>
    <div class="native-live-form-field-grid">
      <label>${t('liveForm.fieldLabel')}<input class="input-field" data-live-form-field-label maxlength="100"
        value="${escapeHtml(field.label)}" placeholder="${escapeHtml(t('liveForm.fieldLabelPlaceholder'))}"></label>
      <label>${t('liveForm.fieldType')}<select class="input-field" data-live-form-field-type>
        ${DRAFT_TYPES.map(type =>
          `<option value="${type}" ${field.type === type ? 'selected' : ''}>${t(`liveForm.fieldType.${type}`)}</option>`).join('')}
      </select></label>
    </div>
    ${['select', 'multi_select', 'dropdown'].includes(field.type) ? `<fieldset
      class="native-poll-option-editor native-live-form-choice-editor native-live-form-choice-editor--${field.type === 'select' ? 'single' : field.type === 'dropdown' ? 'dropdown' : 'multiple'}">
      <legend>${t('liveForm.choices')}</legend>
      ${field.choices.map((choice, choiceIndex) => `
        <div class="native-live-form-choice-row">
          <span class="native-live-form-choice-marker" aria-hidden="true">${field.type === 'dropdown' ? choiceIndex + 1 : ''}</span>
          <input class="input-field" type="text" data-live-form-field-choice="${choiceIndex}"
            value="${escapeHtml(choice)}" maxlength="80"
            placeholder="${escapeHtml(t('poll.optionPlaceholder'))}"
            aria-label="${escapeHtml(t('poll.optionNumber', { number: choiceIndex + 1 }))}">
          <button class="btn bot-field-icon native-live-form-remove-button" type="button" data-live-form-remove-choice="${choiceIndex}"
            aria-label="${escapeHtml(t('poll.removeOption', { number: choiceIndex + 1 }))}"
            ${field.choices.length <= 2 ? 'disabled' : ''}>
            <span class="material-symbols-outlined md-18">delete</span>
          </button>
        </div>`).join('')}
      <button class="native-live-form-add-choice" type="button" data-live-form-add-choice
        ${field.choices.length >= LIMITS.MAX_BOT_FORM_CHOICES ? 'disabled' : ''}>
        <span class="native-live-form-choice-marker" aria-hidden="true">${field.type === 'dropdown' ? field.choices.length + 1 : ''}</span>
        <span>${t('poll.addOption')}</span>
      </button>
    </fieldset>` : ''}
    <div class="bot-permission-row native-live-form-required-row">
      <div><label for="required-${escapeHtml(field.id)}">${t('liveForm.required')}</label>
        <p class="bot-settings-description">${t('liveForm.requiredHint')}</p></div>
      <label class="toggle-switch"><input id="required-${escapeHtml(field.id)}" data-live-form-field-required
        type="checkbox" role="switch" ${field.required ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
  </article>`;

  const fieldsStep = () => `<section class="native-poll-step" data-live-form-step="1">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">format_list_bulleted</span>
      <div><h2 tabindex="-1">${t('liveForm.step.fields')}</h2><p>${t('liveForm.fieldsHint')}</p></div></div>
    <div class="native-live-form-fields">${fields.map(fieldCard).join('')}</div>
    <button type="button" class="btn btn-secondary native-live-form-add-field" data-live-form-add-field
      ${fields.length >= LIMITS.MAX_BOT_FORM_FIELDS ? 'disabled' : ''}>
      <span class="material-symbols-outlined md-18">add</span>${t('liveForm.addField')}</button>
  </section>`;

  const previewStep = () => {
    const form = payload().form;
    return `<section class="native-poll-step native-live-form-preview" data-live-form-step="2">
      <div class="native-poll-step-heading"><span class="material-symbols-outlined">preview</span>
        <div><h2 tabindex="-1">${t('liveForm.step.preview')}</h2><p>${t('liveForm.previewHint')}</p></div></div>
      <div class="native-live-form-preview-card">
        <h3>${escapeHtml(form.title)}</h3>
        ${form.description ? `<p>${escapeHtml(form.description)}</p>` : ''}
        ${form.anonymous ? `<p class="native-live-form-anonymous-notice">
          <span class="material-symbols-outlined md-18">visibility_off</span>${t('liveForm.anonymousNotice')}</p>` : ''}
        ${renderBotFields(form.fields, initialBotInputValues(form.fields), {
          prefix: 'native-live-form-preview',
          disabled: true,
          nativeForm: true,
        })}
      </div>
    </section>`;
  };

  const wizard = mountWizard(modal, {
    name: 'live-form',
    label: t('liveForm.steps'),
    stepperClass: 'native-poll-stepper',
    viewportClass: 'native-poll-step-viewport',
    steps: [
      { label: t('liveForm.step.details'), render: detailsStep },
      { label: t('liveForm.step.fields'), render: fieldsStep },
      { label: t('liveForm.step.preview'), render: previewStep },
    ],
    itemKeys: ['data-live-form-field'],
    submitLabel: () => t('liveForm.publish'),
    capture: () => capture(),
    ready: step => step === 0 ? detailsValid() : step === 1 ? fieldsValid()
      : nativeLiveFormCreateSchema.safeParse(payload()).success,
    pending: () => pending,
    submit: () => submit(),
    drawn: () => audience.sync(viewport),
  });
  const { viewport } = wizard;

  const capture = () => {
    if (wizard.step === 0) {
      title = viewport.querySelector<HTMLInputElement>('[data-live-form-title]')?.value ?? title;
      description = viewport.querySelector<HTMLTextAreaElement>('[data-live-form-description]')?.value ?? description;
      duration = viewport.querySelector<HTMLInputElement>('[data-live-form-duration]')?.value ?? duration;
      const chosen = viewport.querySelector<HTMLSelectElement>('[data-live-form-unit]')?.value;
      if (isDurationUnit(chosen)) unit = chosen;
      anonymous = viewport.querySelector<HTMLInputElement>('[data-live-form-anonymous]')?.checked ?? anonymous;
      return;
    }
    if (wizard.step !== 1) return;
    fields = [...viewport.querySelectorAll<HTMLElement>('[data-live-form-field]')].flatMap((element) => {
      const previous = fields.find(field => field.id === element.dataset.liveFormField);
      if (!previous) return [];
      const choiceInputs = [...element.querySelectorAll<HTMLInputElement>('[data-live-form-field-choice]')];
      const type = element.querySelector<HTMLSelectElement>('[data-live-form-field-type]')?.value;
      return [{
        id: previous.id,
        label: element.querySelector<HTMLInputElement>('[data-live-form-field-label]')?.value ?? previous.label,
        type: isDraftType(type) ? type : previous.type,
        required: element.querySelector<HTMLInputElement>('[data-live-form-field-required]')?.checked ?? previous.required,
        choices: choiceInputs.length > 0 ? choiceInputs.map(input => input.value) : previous.choices,
      }];
    });
  };
  const syncValidity = () => {
    capture();
    const durationInput = viewport.querySelector<HTMLInputElement>('[data-live-form-duration]');
    if (durationInput) durationInput.max = String(longestDuration(unit));
    wizard.sync();
  };
  const submit = () => {
    if (pending) return;
    const parsed = nativeLiveFormCreateSchema.safeParse(payload());
    if (!parsed.success) { modal.fail(t('liveForm.invalid')); return; }
    pending = true;
    wizard.sync();
    void modal.run(async () => {
      try {
        await client.sendRequest(MessageType.NATIVE_FORM_CREATE, parsed.data);
        if (!modal.signal.aborted) modal.close();
      } catch (error) {
        pending = false;
        if (!modal.signal.aborted) wizard.sync();
        throw error;
      }
    });
  };

  audience.bind(viewport, modal.signal, syncValidity);
  viewport.addEventListener('input', syncValidity, { signal: modal.signal });
  viewport.addEventListener('change', event => {
    syncValidity();
    // A field of another type has other controls; focus and scroll stay on its type.
    const type = event.target instanceof Element ? event.target.closest('[data-live-form-field-type]') : null;
    const id = type?.closest<HTMLElement>('[data-live-form-field]')?.dataset.liveFormField;
    if (id) wizard.redraw(fieldSelector(id, '[data-live-form-field-type]'));
  }, { signal: modal.signal });
  viewport.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-live-form-add-field]') && fields.length < LIMITS.MAX_BOT_FORM_FIELDS) {
      capture();
      const id = `field_${nextField++}`;
      fields.push({
        id,
        label: '',
        type: 'short_text',
        required: true,
        choices: [t('liveForm.defaultChoice', { number: 1 }), t('liveForm.defaultChoice', { number: 2 })],
      });
      wizard.redraw(fieldSelector(id, '[data-live-form-field-label]'));
      return;
    }
    const removeId = target?.closest<HTMLElement>('[data-live-form-remove-field]')?.dataset.liveFormRemoveField;
    if (removeId && fields.length > 1) {
      capture();
      fields = fields.filter(field => field.id !== removeId);
      wizard.redraw();
      return;
    }
    const addChoice = target?.closest<HTMLButtonElement>('[data-live-form-add-choice]');
    if (addChoice) {
      capture();
      const id = addChoice.closest<HTMLElement>('[data-live-form-field]')?.dataset.liveFormField;
      const field = fields.find(candidate => candidate.id === id);
      if (!field || field.choices.length >= LIMITS.MAX_BOT_FORM_CHOICES) return;
      field.choices.push('');
      wizard.redraw(fieldSelector(field.id, `[data-live-form-field-choice="${field.choices.length - 1}"]`));
      return;
    }
    const removeChoice = target?.closest<HTMLButtonElement>('[data-live-form-remove-choice]');
    if (removeChoice) {
      capture();
      const id = removeChoice.closest<HTMLElement>('[data-live-form-field]')?.dataset.liveFormField;
      const field = fields.find(candidate => candidate.id === id);
      const index = Number(removeChoice.dataset.liveFormRemoveChoice);
      if (!field || field.choices.length <= 2 || !Number.isInteger(index) ||
          index < 0 || index >= field.choices.length) return;
      field.choices.splice(index, 1);
      wizard.redraw(fieldSelector(field.id, `[data-live-form-field-choice="${Math.min(index, field.choices.length - 1)}"]`));
      return;
    }
    stepNumberControl(target);
  }, { signal: modal.signal });
  wizard.start();
  return modal;
}
