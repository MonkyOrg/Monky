import type { ClientLogCategory } from '@monky/shared';
import { clientLog } from '../core/ClientLogService';
import { t } from '../i18n';
import { showCopyToast, showErrorToast } from '../views/CopyToast';

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface ReportOptions {
  /** The control the failure is about: marked invalid until it is edited again. */
  field?: HTMLElement | null;
  /** Moves the focus to `field`, for a form that refused to go through. */
  focus?: boolean;
  /** Writes the cause to the client log, under this category. */
  log?: ClientLogCategory;
  error?: unknown;
}

const clearOnEdit = new WeakSet<HTMLElement>();

/** The message an error carries for a person, or `fallback` when it has none worth showing. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** Marks a control invalid for assistive technology until the next edit. */
export function markFieldInvalid(field: HTMLElement): void {
  field.setAttribute('aria-invalid', 'true');
  if (clearOnEdit.has(field)) return;
  clearOnEdit.add(field);
  const clear = (): void => clearFieldError(field);
  field.addEventListener('input', clear);
  field.addEventListener('change', clear);
}

export function clearFieldError(field: HTMLElement): void {
  field.removeAttribute('aria-invalid');
}

/**
 * The one way an operation reports a failure (#490): the shared alert toast,
 * never a message left in the layout. The control involved is marked so a
 * screen reader finds it, and the cause can go to the client log. Returns a
 * function that takes the toast down, for a failure the person already fixed.
 */
export function reportError(message: string, options: ReportOptions = {}): () => void {
  if (options.log) {
    clientLog.warn(options.log, message, options.error === undefined ? undefined : {
      error: options.error instanceof Error ? options.error.message : String(options.error),
    });
  }
  const field = options.field;
  if (field) {
    markFieldInvalid(field);
    if (options.focus) field.focus({ preventScroll: true });
  }
  return showErrorToast(message);
}

/** Copies `text` and confirms it in a toast; a refused clipboard is reported the same way. */
export async function copyText(text: string, messages: { copied: string; failed: string }): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    showCopyToast(messages.copied);
    return true;
  } catch (error: unknown) {
    reportError(messages.failed, { log: 'APP', error });
    return false;
  }
}

/** Opens a link in the system browser; the app never opens windows, so a failure is reported, not retried. */
export async function openExternalUrl(url: string, failed: string): Promise<boolean> {
  try {
    if (!window.api?.openExternal) throw new Error('External navigation bridge unavailable');
    if (!(await window.api.openExternal(url)).success) throw new Error('The system refused to open the link');
    return true;
  } catch (error: unknown) {
    reportError(failed, { log: 'APP', error });
    return false;
  }
}

function isFormControl(element: Element): element is FormControl {
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
}

function fieldName(control: FormControl): string {
  const label = control.labels?.[0]?.textContent?.trim()
    || control.getAttribute('aria-label')?.trim()
    || control.getAttribute('placeholder')?.trim();
  return label || t('validation.thisField');
}

/** Explains a refused value in the app's language, unlike the browser's balloon. */
export function validationMessage(control: FormControl): string {
  const validity = control.validity;
  const field = fieldName(control);
  if (validity.customError) return control.validationMessage;
  if (validity.valueMissing) return t('validation.required', { field });
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    if (validity.tooShort) return t('validation.tooShort', { field, min: control.minLength });
    if (validity.tooLong) return t('validation.tooLong', { field, max: control.maxLength });
  }
  if (control instanceof HTMLInputElement) {
    if (validity.rangeUnderflow) return t('validation.tooLow', { field, min: control.min });
    if (validity.rangeOverflow) return t('validation.tooHigh', { field, max: control.max });
  }
  return t('validation.invalid', { field });
}

/**
 * Checks a form with the app's own feedback. The first refused control is
 * marked, focused and explained in a toast; returns whether the form is valid.
 */
export function validateForm(form: HTMLFormElement): boolean {
  const invalid = [...form.elements].find((element): element is FormControl =>
    isFormControl(element) && !element.disabled && !element.checkValidity());
  if (!invalid) return true;
  reportError(validationMessage(invalid), { field: invalid, focus: true });
  return false;
}

/**
 * Replaces the browser's validation balloon of a form: it is in the system's
 * language and outside the theme. A refused submit never reaches the form's
 * own submit handlers.
 */
export function useAppValidation(form: HTMLFormElement, signal: AbortSignal): void {
  form.noValidate = true;
  form.addEventListener('submit', (event) => {
    if (validateForm(form)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal });
}
