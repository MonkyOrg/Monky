/**
 * Shared helpers to give visual feedback on buttons while an async action runs
 * (#48). The loading state is driven purely by the `data-loading` attribute and
 * the `disabled` attribute, so it survives other handlers that rewrite the
 * button's innerHTML or className (e.g. icon/state updates). The spinner itself
 * is drawn via CSS (`button[data-loading="1"]::after`).
 */

export function setButtonLoading(btn: HTMLElement | null, loading: boolean): void {
  if (!btn) return;
  const el = btn as HTMLButtonElement;

  if (loading) {
    if (el.dataset.loading === '1') return;
    el.dataset.loadingWasDisabled = String(el.hasAttribute('disabled'));
    el.dataset.loading = '1';
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('disabled', 'true');
  } else {
    const wasDisabled = el.dataset.loadingWasDisabled === 'true';
    delete el.dataset.loading;
    delete el.dataset.loadingWasDisabled;
    el.removeAttribute('aria-busy');
    if (!wasDisabled) el.removeAttribute('disabled');
  }
}

export function isButtonLoading(btn: HTMLElement | null): boolean {
  return !!btn && (btn as HTMLButtonElement).dataset.loading === '1';
}

/**
 * Wraps an async action that opens a modal, showing a loading state on the
 * triggering button until the modal is actually open (i.e. until the promise
 * resolves) (#48).
 */
export async function withButtonLoading<T>(
  btn: HTMLElement | null,
  action: () => T | Promise<T>
): Promise<T | undefined> {
  if (!btn || isButtonLoading(btn)) return undefined;
  setButtonLoading(btn, true);
  try {
    return await action();
  } finally {
    setButtonLoading(btn, false);
  }
}

/**
 * Opens a browser-backed native file picker and keeps its visible trigger busy
 * until Chromium reports selection/cancellation or the app regains focus.
 */
export function openFileInputPicker(input: HTMLInputElement | null, trigger: HTMLElement | null): void {
  if (!input || !trigger || isButtonLoading(trigger)) return;
  setButtonLoading(trigger, true);
  let settled = false;
  let focusTimer: number | null = null;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (focusTimer !== null) window.clearTimeout(focusTimer);
    input.removeEventListener('change', settle);
    input.removeEventListener('cancel', settle);
    window.removeEventListener('focus', onFocus);
    setButtonLoading(trigger, false);
  };
  const onFocus = () => {
    focusTimer = window.setTimeout(settle, 0);
  };
  input.addEventListener('change', settle, { once: true });
  input.addEventListener('cancel', settle, { once: true });
  window.addEventListener('focus', onFocus, { once: true });
  try {
    input.click();
  } catch (error) {
    settle();
    throw error;
  }
}
