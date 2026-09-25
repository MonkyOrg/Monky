import { escapeHtml } from '../utils/html';
import { t } from '../i18n';

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
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  /** Renders an opt-out switch above the buttons. */
  checkboxLabel?: string;
  checkboxHint?: string;
  signal?: AbortSignal;
  requireUserGesture?: boolean;
}

interface DialogTextInput {
  label: string;
  value: string;
  suffix?: string;
  hint?: string;
  maxLength?: number;
  validate?: (value: string) => string | undefined;
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
  signal?: AbortSignal;
  requireUserGesture?: boolean;
  onResolve: (confirmed: boolean, checked: boolean, value: string, values: string[]) => void;
}): void {
  const fields = params.textInputs ?? (params.textInput ? [params.textInput] : []);
  if (params.signal?.aborted) {
    params.onResolve(false, false, fields[0]?.value ?? '', fields.map(field => field.value));
    return;
  }
  const { icon, color } = VARIANT_ICON[params.variant];
  const previousFocus = document.activeElement;
  const inputId = `dialog-input-${++dialogId}`;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card dialog-card" role="dialog" aria-modal="true">
      <div class="modal-header">
        <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="material-symbols-outlined" style="color: ${color};">${icon}</span>
          <span>${escapeHtml(params.title)}</span>
        </div>
      </div>
      ${params.message ? `<div class="dialog-message" style="white-space: pre-line;">${escapeHtml(params.message)}</div>` : ''}
      ${fields.map((field, index) => `<div class="dialog-text-field">
        <label for="${inputId}-${index}">${escapeHtml(field.label)}</label>
        <div class="dialog-text-input-row">
          <input class="input-field" type="text" id="${inputId}-${index}" data-dialog-input autocomplete="off" spellcheck="false"
            value="${escapeHtml(field.value)}" ${field.maxLength !== undefined ? `maxlength="${field.maxLength}"` : ''}
            aria-describedby="${inputId}-${index}-hint ${inputId}-${index}-error">
          ${field.suffix ? `<span class="dialog-text-suffix" aria-hidden="true">${escapeHtml(field.suffix)}</span>` : ''}
        </div>
        <small id="${inputId}-${index}-hint">${escapeHtml(field.hint ?? '')}</small>
        <p class="dialog-input-error" id="${inputId}-${index}-error" data-dialog-input-error role="alert" hidden></p>
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
            ? `<button type="button" class="btn btn-secondary" data-action="cancel">${escapeHtml(params.cancelLabel)}</button>`
            : ''
        }
        <button type="button" class="btn ${params.confirmClass}" data-action="confirm">${escapeHtml(params.confirmLabel)}</button>
      </div>
    </div>
  `;

  const checkbox = backdrop.querySelector('[data-action="remember"]') as HTMLInputElement | null;
  const inputs = [...backdrop.querySelectorAll<HTMLInputElement>('[data-dialog-input]')];
  const errors = [...backdrop.querySelectorAll<HTMLElement>('[data-dialog-input-error]')];
  const input = inputs[params.focusInput ?? 0];
  const confirmButton = backdrop.querySelector<HTMLButtonElement>('[data-action="confirm"]');
  const validateInput = (): boolean => {
    let valid = true;
    inputs.forEach((field, index) => {
      const error = fields[index].validate?.(field.value);
      errors[index].textContent = error ?? '';
      errors[index].hidden = !error;
      field.setAttribute('aria-invalid', String(!!error));
      if (error) valid = false;
    });
    if (confirmButton) confirmButton.disabled = !valid;
    return valid;
  };

  let settled = false;
  const settle = (confirmed: boolean): void => {
    if (settled) return;
    if (confirmed && !validateInput()) { inputs.find(field => field.getAttribute('aria-invalid') === 'true')?.focus(); return; }
    settled = true;
    const checked = !!checkbox?.checked;
    document.removeEventListener('keydown', onKeyDown, true);
    params.signal?.removeEventListener('abort', onAbort);
    backdrop.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !document.querySelector('.modal-backdrop')) {
      previousFocus.focus();
    }
    params.onResolve(confirmed, checked, inputs[0]?.value ?? '', inputs.map(field => field.value));
  };

  const onAbort = (): void => settle(false);
  const onKeyDown = (e: KeyboardEvent): void => {
    const backdrops = document.querySelectorAll('.modal-backdrop');
    if (backdrops[backdrops.length - 1] !== backdrop) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      settle(false);
    } else if (e.key === 'Enter') {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (params.requireUserGesture && (!e.isTrusted || e.repeat || e.isComposing || e.keyCode === 229)) return;
      if (e.target === checkbox) return;
      if (e.target instanceof HTMLElement && e.target.dataset.action === 'cancel') {
        settle(false);
        return;
      }
      settle(true);
    } else if (e.key === 'Tab') {
      const controls = [...backdrop.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  confirmButton?.addEventListener('click', (event) => {
    if (!params.requireUserGesture || event.isTrusted) settle(true);
  });
  backdrop.querySelector('[data-action="cancel"]')?.addEventListener('click', () => settle(false));
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) settle(false);
  });
  document.addEventListener('keydown', onKeyDown, true);
  params.signal?.addEventListener('abort', onAbort, { once: true });
  inputs.forEach(field => field.addEventListener('input', validateInput));

  document.body.appendChild(backdrop);
  if (params.signal?.aborted) { settle(false); return; }
  validateInput();
  if (input) { input.focus(); input.select(); }
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
      message: options.message,
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
