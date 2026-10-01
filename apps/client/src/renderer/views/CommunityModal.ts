import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';

const openModals = new Map<HTMLElement, AbortController>();

export function openCommunityModal(title: string) {
  const previous = document.activeElement;
  const parent = [...openModals.keys()].reverse().find(modal => modal.isConnected && !modal.inert && !modal.hidden);
  const parentAbort = parent ? openModals.get(parent) : undefined;
  const abort = new AbortController();
  const element = document.createElement('div');
  element.className = 'modal-backdrop';
  element.dataset.communityModal = '';
  element.innerHTML = `<section class="modal-card community-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <header class="modal-header"><h2 class="modal-title">${escapeHtml(title)}</h2>
      <button class="btn btn-secondary" type="button" data-community-close aria-label="${escapeHtml(t('common.close'))}">×</button>
    </header><div data-community-content></div><p class="community-error" data-community-error role="alert" hidden></p></section>`;
  const content = element.querySelector<HTMLElement>('[data-community-content]')!;
  const error = element.querySelector<HTMLElement>('[data-community-error]')!;
  const close = (immediate = false): void => {
    if (abort.signal.aborted) {
      if (immediate) exitModal(element, true);
      return;
    }
    abort.abort();
    openModals.delete(element);
    exitModal(element, immediate);
    if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert], [hidden], [data-ui-closing]')) previous.focus();
  };
  if (parent) {
    parentAbort?.signal.addEventListener('abort', () => close(true), { once: true, signal: abort.signal });
  }
  element.querySelector('[data-community-close]')!.addEventListener('click', () => close(), { signal: abort.signal });
  element.addEventListener('mousedown', (event) => { if (event.target === element) close(); }, { signal: abort.signal });
  document.addEventListener('keydown', (event) => {
    if (!handlesModalKey(element, event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === 'Tab') {
      const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter((item) => !item.hidden && item.getClientRects().length);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (controls.length && (event.shiftKey ? index <= 0 : index < 0 || index === controls.length - 1)) {
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
  }, { capture: true, signal: abort.signal });
  openModals.set(element, abort);
  document.body.append(element);
  enterModal(element);
  element.querySelector<HTMLElement>('button')!.focus();
  return {
    element, content, close, signal: abort.signal,
    fail(message: string) { if (!abort.signal.aborted) { error.textContent = message; error.hidden = false; } },
    clearError() { error.textContent = ''; error.hidden = true; },
    async run(operation: () => Promise<void>) {
      error.hidden = true;
      try { await operation(); }
      catch (failure) {
        console.warn('[Community] Action failed.', failure);
        if (!abort.signal.aborted) {
          error.textContent = failure instanceof Error ? failure.message : t('community.actionFailed');
          error.hidden = false;
        }
      }
    },
  };
}
