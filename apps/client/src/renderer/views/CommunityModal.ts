import { t } from '../i18n';
import { html } from '../utils/html';
import { errorMessage, reportError } from '../utils/feedback';
import { openModal, type ModalShell } from '../utils/modalShell';

const openModals = new Map<HTMLElement, ModalShell>();

interface CommunityModalOptions {
  /** Closes at once when the visible server changes or its connection drops, as a draft for that server does. */
  closeWithSession?: boolean;
}

/**
 * The dialog of the community views: events, polls, forms, forum, search
 * filters, forwards and recent sounds. One opened from another closes with it.
 * Failures go to the shared toast; the content area is the view's to fill.
 */
export function openCommunityModal(title: string, options: CommunityModalOptions = {}) {
  const parent = [...openModals.values()].reverse()
    .find(modal => modal.element.isConnected && !modal.element.inert && !modal.element.hidden);
  let registered: HTMLElement | null = null;
  const shell = openModal({
    card: html`<section class="modal-card community-modal" aria-label="${title}">
      <header class="modal-header"><h2 class="modal-title">${title}</h2>
        <button class="btn btn-secondary" type="button" data-community-close data-modal-close aria-label="${t('common.close')}">×</button>
      </header><div data-community-content></div></section>`,
    initialFocus: '[data-community-close]',
    signal: parent?.signal,
    closeWithSession: options.closeWithSession,
    onClose: () => { if (registered) openModals.delete(registered); },
  });
  if (!shell.closed) {
    registered = shell.element;
    openModals.set(registered, shell);
  }
  const content = shell.card.querySelector<HTMLElement>('[data-community-content]')!;
  let dismissError: (() => void) | null = null;
  const fail = (message: string): void => {
    if (!shell.signal.aborted) dismissError = reportError(message);
  };
  const clearError = (): void => {
    dismissError?.();
    dismissError = null;
  };
  return {
    element: shell.element, card: shell.card, content, signal: shell.signal,
    close: (immediate = false): void => { shell.close('api', immediate); },
    /** Renames the dialog: its heading and the name assistive technology announces. */
    setTitle(text: string) {
      const heading = shell.card.querySelector<HTMLElement>('.modal-title');
      if (heading && heading.textContent !== text) heading.textContent = text;
      shell.card.setAttribute('aria-label', text);
    },
    fail,
    clearError,
    async run(operation: () => Promise<void>) {
      clearError();
      try { await operation(); }
      catch (failure) {
        console.warn('[Community] Action failed.', failure);
        fail(errorMessage(failure, t('community.actionFailed')));
      }
    },
  };
}

export type CommunityModal = ReturnType<typeof openCommunityModal>;
