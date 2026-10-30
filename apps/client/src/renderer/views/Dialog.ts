import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { openModal } from '../utils/modalShell';
import { reportError } from '../utils/feedback';

type DialogVariant = 'info' | 'warning' | 'danger' | 'success';

interface AlertOptions {
  title?: string;
  message: string;
  okLabel?: string;
  variant?: DialogVariant;
}

interface ConfirmOptions {
  title?: string;
  message: string;
  /** A short remark below the message. */
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  /** Renders an opt-out switch above the buttons. */
  checkboxLabel?: string;
  checkboxHint?: string;
  signal?: AbortSignal;
  requireUserGesture?: boolean;
  focusCancel?: boolean;
}

interface DialogTextInput {
  label: string;
  value: string;
  suffix?: string;
  hint?: string;
  maxLength?: number;
  validate?: (value: string) => string | undefined;
}

export interface DialogChoice<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: string;
}

/** Mutually exclusive options shown as selectable cards, never as radio buttons. */
export interface DialogChoices<T extends string> {
  legend: string;
  description?: string;
  options: DialogChoice<T>[];
  selected: T;
}

let dialogId = 0;

const VARIANT_ICON: Record<DialogVariant, { icon: string; color: string }> = {
  info: { icon: 'info', color: 'var(--accent-primary)' },
  warning: { icon: 'warning', color: 'var(--warning)' },
  danger: { icon: 'error', color: 'var(--danger)' },
  success: { icon: 'check_circle', color: 'var(--success)' },
};

function buildDialog(params: {
  title: string;
  message: string;
  variant: DialogVariant;
  showCancel: boolean;
  confirmLabel: string;
  cancelLabel: string;
  confirmClass: string;
  checkboxLabel?: string;
  checkboxHint?: string;
  textInput?: DialogTextInput;
  textInputs?: DialogTextInput[];
  focusInput?: number;
  choices?: DialogChoices<string>;
  /** A short remark below the message, e.g. what was already decided elsewhere. */
  note?: string;
  signal?: AbortSignal;
  requireUserGesture?: boolean;
  focusCancel?: boolean;
  onResolve: (confirmed: boolean, checked: boolean, value: string, values: string[], choice: string | null) => void;
}): void {
  const fields = params.textInputs ?? (params.textInput ? [params.textInput] : []);
  if (params.signal?.aborted) {
    params.onResolve(false, false, fields[0]?.value ?? '', fields.map(field => field.value), params.choices?.selected ?? null);
    return;
  }
  const { icon, color } = VARIANT_ICON[params.variant];
  const inputId = `dialog-input-${++dialogId}`;
  let choice = params.choices?.selected ?? null;
  let confirmed = false;

  const shell = openModal({
    card: `
    <div class="modal-card dialog-card">
      <div class="modal-header">
        <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="material-symbols-outlined" style="color: ${color};" aria-hidden="true">${icon}</span>
          <span>${escapeHtml(params.title)}</span>
        </div>
      </div>
      ${params.message ? `<div class="dialog-message" style="white-space: pre-line;">${escapeHtml(params.message)}</div>` : ''}
      ${params.note ? `<p class="dialog-note">${escapeHtml(params.note)}</p>` : ''}
      ${params.choices ? `<div class="dialog-choices">
        <p class="dialog-choices-legend" id="${inputId}-choices">${escapeHtml(params.choices.legend)}</p>
        ${params.choices.description ? `<p class="dialog-option-hint" id="${inputId}-choices-hint">${escapeHtml(params.choices.description)}</p>` : ''}
        <div class="input-mode-cards" role="group" aria-labelledby="${inputId}-choices"
          ${params.choices.description ? `aria-describedby="${inputId}-choices-hint"` : ''}>
          ${params.choices.options.map((option) => `<button type="button" class="voice-mode-card input-mode-card"
            data-dialog-choice="${escapeHtml(option.value)}" aria-pressed="${option.value === choice}">
            <span class="input-mode-card-title">${option.icon ? `<span class="material-symbols-outlined md-18" aria-hidden="true">${escapeHtml(option.icon)}</span>` : ''}${escapeHtml(option.label)}</span>
            ${option.description ? `<span class="input-mode-card-description">${escapeHtml(option.description)}</span>` : ''}
          </button>`).join('')}
        </div>
      </div>` : ''}
      ${fields.map((field, index) => `<div class="dialog-text-field">
        <label for="${inputId}-${index}">${escapeHtml(field.label)}</label>
        <div class="dialog-text-input-row">
          <input class="input-field" type="text" id="${inputId}-${index}" data-dialog-input autocomplete="off" spellcheck="false"
            value="${escapeHtml(field.value)}" ${field.maxLength !== undefined ? `maxlength="${field.maxLength}"` : ''}
            ${field.hint ? `aria-describedby="${inputId}-${index}-hint"` : ''}>
          ${field.suffix ? `<span class="dialog-text-suffix" aria-hidden="true">${escapeHtml(field.suffix)}</span>` : ''}
        </div>
        ${field.hint ? `<small id="${inputId}-${index}-hint">${escapeHtml(field.hint)}</small>` : ''}
      </div>`).join('')}
      ${
        params.checkboxLabel
          ? `<div class="dialog-checkbox">
               <span>${escapeHtml(params.checkboxLabel)}</span>
               <label class="toggle-switch" aria-label="${escapeHtml(params.checkboxLabel)}">
                 <input type="checkbox" role="switch" data-action="remember">
                 <span class="toggle-slider"></span>
               </label>
             </div>`
          : ''
      }
      ${params.checkboxLabel && params.checkboxHint ? `<p class="dialog-option-hint">${escapeHtml(params.checkboxHint)}</p>` : ''}
      <div class="modal-footer">
        ${
          params.showCancel
            ? `<button type="button" class="btn btn-secondary" data-action="cancel" data-modal-close>${escapeHtml(params.cancelLabel)}</button>`
            : ''
        }
        <button type="button" class="btn ${params.confirmClass}" data-action="confirm">${escapeHtml(params.confirmLabel)}</button>
      </div>
    </div>
  `,
    signal: params.signal,
    initialFocus: false,
    onKeydown: (event) => onEnter(event),
    onClose: () => params.onResolve(confirmed, !!checkbox?.checked, inputs[0]?.value ?? '', inputs.map(field => field.value), choice),
  });
  const card = shell.card;
  const checkbox = card.querySelector<HTMLInputElement>('[data-action="remember"]');
  const inputs = [...card.querySelectorAll<HTMLInputElement>('[data-dialog-input]')];
  const input = inputs[params.focusInput ?? 0];
  const confirmButton = card.querySelector<HTMLButtonElement>('[data-action="confirm"]');
  const errors = new Map<HTMLInputElement, string>();
  /**
   * Typing only marks a refused value and holds confirmation back; the reason
   * goes to the shared toast when a value turns invalid and on every attempt to confirm.
   */
  const validateInput = (announce: 'changes' | 'first' | 'none'): boolean => {
    let reported = false;
    inputs.forEach((field, index) => {
      const error = fields[index].validate?.(field.value);
      const previous = errors.get(field);
      if (error) errors.set(field, error); else errors.delete(field);
      field.setAttribute('aria-invalid', String(!!error));
      const explain = announce === 'first' ? !reported : announce === 'changes' && error !== previous;
      if (error && explain) {
        // The mark above follows every edit, so the toast must not clear it on the next keystroke.
        reportError(error);
        if (announce === 'first') field.focus();
        reported = true;
      }
    });
    if (confirmButton) confirmButton.disabled = errors.size > 0;
    return errors.size === 0;
  };

  const settle = (value: boolean): void => {
    if (shell.closed) return;
    if (value && !validateInput('first')) return;
    confirmed = value;
    shell.close('button');
  };

  const choiceCards = [...card.querySelectorAll<HTMLButtonElement>('[data-dialog-choice]')];
  const select = (choiceCard: HTMLButtonElement): void => {
    choice = choiceCard.dataset.dialogChoice ?? choice;
    for (const other of choiceCards) other.setAttribute('aria-pressed', String(other === choiceCard));
  };
  for (const choiceCard of choiceCards) choiceCard.addEventListener('click', () => select(choiceCard), { signal: shell.signal });

  function onEnter(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (params.requireUserGesture && (!e.isTrusted || e.repeat)) return;
    if (e.target === checkbox) return;
    if (e.target instanceof HTMLButtonElement && choiceCards.includes(e.target)) {
      // Enter picks the focused card; confirming stays a separate, deliberate action.
      select(e.target);
      return;
    }
    if (e.target instanceof HTMLElement && e.target.dataset.action === 'cancel') {
      settle(false);
      return;
    }
    settle(true);
  }

  confirmButton?.addEventListener('click', (event) => {
    if (!params.requireUserGesture || event.isTrusted) settle(true);
  }, { signal: shell.signal });
  inputs.forEach(field => field.addEventListener('input', () => validateInput('changes'), { signal: shell.signal }));

  if (shell.closed) return;
  validateInput('none');
  if (params.focusCancel && params.showCancel) card.querySelector<HTMLElement>('[data-action="cancel"]')?.focus();
  else if (input) { input.focus(); input.select(); }
  else confirmButton?.focus();
}

/** Replacement for window.alert — resolves when the user dismisses the dialog. */
export function showAlert(options: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    buildDialog({
      title: options.title ?? t('dialog.alertTitle'),
      message: options.message,
      variant: options.variant ?? 'info',
      showCancel: false,
      confirmLabel: options.okLabel ?? t('common.ok'),
      cancelLabel: '',
      confirmClass: options.variant === 'danger' ? 'btn-danger' : 'btn-primary',
      onResolve: () => resolve(),
    });
  });
}

/** Replacement for window.confirm — resolves true (confirmed) or false (cancelled). */
export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    buildDialog({
      title: options.title ?? t('dialog.confirmTitle'),
      focusCancel: options.focusCancel,
      message: options.message,
      note: options.note,
      variant: options.variant ?? 'warning',
      showCancel: true,
      confirmLabel: options.confirmLabel ?? t('common.confirm'),
      cancelLabel: options.cancelLabel ?? t('common.cancel'),
      confirmClass: options.variant === 'danger' ? 'btn-danger' : 'btn-primary',
      signal: options.signal,
      requireUserGesture: options.requireUserGesture,
      onResolve: (confirmed) => resolve(confirmed),
    });
  });
}

/** Confirmation together with one of several mutually exclusive choices, shown as cards. */
export function showConfirmWithChoice<T extends string>(
  options: ConfirmOptions & { choices: DialogChoices<T> }
): Promise<{ confirmed: boolean; choice: T }> {
  const values = options.choices.options.map((option) => option.value);
  return new Promise((resolve) => {
    buildDialog({
      title: options.title ?? t('dialog.confirmTitle'),
      message: options.message,
      note: options.note,
      variant: options.variant ?? 'warning',
      showCancel: true,
      confirmLabel: options.confirmLabel ?? t('common.confirm'),
      cancelLabel: options.cancelLabel ?? t('common.cancel'),
      confirmClass: options.variant === 'danger' ? 'btn-danger' : 'btn-primary',
      choices: options.choices,
      signal: options.signal,
      requireUserGesture: options.requireUserGesture,
      focusCancel: options.focusCancel,
      onResolve: (confirmed, _checked, _value, _values, choice) => resolve({
        confirmed, choice: values.find((value) => value === choice) ?? options.choices.selected,
      }),
    });
  });
}

/**
 * Confirmation that also reports the state of an opt-out switch, so a prompt
 * can offer "não perguntar novamente" without a bespoke modal (#334).
 */
export function showConfirmWithOption(
  options: ConfirmOptions & { checkboxLabel: string }
): Promise<{ confirmed: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    buildDialog({
      title: options.title ?? t('dialog.confirmTitle'),
      message: options.message,
      variant: options.variant ?? 'warning',
      showCancel: true,
      confirmLabel: options.confirmLabel ?? t('common.confirm'),
      cancelLabel: options.cancelLabel ?? t('common.cancel'),
      confirmClass: options.variant === 'danger' ? 'btn-danger' : 'btn-primary',
      checkboxLabel: options.checkboxLabel,
      checkboxHint: options.checkboxHint,
      signal: options.signal,
      requireUserGesture: options.requireUserGesture,
      focusCancel: options.focusCancel,
      onResolve: (confirmed, checked) => resolve({ confirmed, checked }),
    });
  });
}

export function showConfirmWithText(
  options: ConfirmOptions & { textInput: DialogTextInput }
): Promise<{ confirmed: boolean; checked: boolean; value: string }> {
  return new Promise((resolve) => {
    buildDialog({
      title: options.title ?? t('dialog.confirmTitle'),
      message: options.message,
      variant: options.variant ?? 'warning',
      showCancel: true,
      confirmLabel: options.confirmLabel ?? t('common.confirm'),
      cancelLabel: options.cancelLabel ?? t('common.cancel'),
      confirmClass: options.variant === 'danger' ? 'btn-danger' : 'btn-primary',
      checkboxLabel: options.checkboxLabel,
      checkboxHint: options.checkboxHint,
      textInput: options.textInput,
      signal: options.signal,
      requireUserGesture: options.requireUserGesture,
      focusCancel: options.focusCancel,
      onResolve: (confirmed, checked, value) => resolve({ confirmed, checked, value }),
    });
  });
}

export function showTextForm(options: {
  title: string; fields: DialogTextInput[]; focusInput?: number; signal?: AbortSignal;
}): Promise<string[] | null> {
  return new Promise(resolve => buildDialog({
    title: options.title, message: '', variant: 'info', showCancel: true,
    confirmLabel: t('common.confirm'), cancelLabel: t('common.cancel'), confirmClass: 'btn-primary',
    textInputs: options.fields, focusInput: options.focusInput, signal: options.signal,
    onResolve: (confirmed, _checked, _value, values) => resolve(confirmed ? values : null),
  }));
}
