import { t } from '../i18n';
import { html, type SafeHtml } from '../utils/html';
import { captureShortcut, type ShortcutKeyCombo } from '../utils/keybind';
import { openModal } from '../utils/modalShell';

export interface ShortcutCaptureOptions {
  /** Prefix of the dialog's ids, kept per caller so their hooks never collide. */
  idPrefix: string;
  title: string;
  /** What the shortcut is for, in safe markup (it may bold a name). */
  prompt: SafeHtml;
  /** Capture stops when this element goes away, like the settings that opened it. */
  owner: HTMLElement;
  /** Receives the held combination once every key is released; the dialog is already closing. */
  onCaptured: (combo: ShortcutKeyCombo) => void;
  /** One more action next to Cancel, such as removing the current shortcut. */
  remove?: { label: string; onClick: () => void };
}

/**
 * The dialog that records a keyboard shortcut, for the app's actions and for
 * the soundboard: every key goes to the capture until the combination is
 * released or Esc cancels it. Returns a function that closes it.
 */
export function openShortcutCaptureDialog(options: ShortcutCaptureOptions): () => void {
  const id = options.idPrefix;
  let disposeCapture = (): void => {};
  const shell = openModal({
    card: html`
    <div class="modal-card" style="width: 380px; max-width: 90vw; text-align: center;" aria-labelledby="${id}-title">
      <div class="modal-header" style="justify-content: center; position: relative;">
        <div class="modal-title" style="display: flex; align-items: center; gap: 8px; font-size: 15px;">
          <span class="material-symbols-outlined" style="color: var(--accent-primary);" aria-hidden="true">keyboard</span>
          <span id="${id}-title">${options.title}</span>
        </div>
        <button type="button" id="${id}-modal-close" class="modal-close-btn" data-modal-close style="position: absolute; right: 16px; top: 16px;" aria-label="${t('common.close')}">&times;</button>
      </div>
      <div style="padding: 16px 20px 20px;">
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px; word-break: break-word;">
          ${options.prompt}
        </div>
        <div id="${id}-box" aria-live="polite" style="padding: 24px 16px; background: var(--bg-input); border: 2px dashed var(--accent-primary); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 0 16px rgba(88, 101, 242, 0.25);">
          <span class="material-symbols-outlined" style="font-size: 32px; color: var(--accent-primary); animation: pulse 1.5s infinite;" aria-hidden="true">keyboard</span>
          <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${t('soundboard.keybindWaiting')}</div>
          <div style="font-size: 11px; color: var(--text-muted);">${t('soundboard.keybindExamples')}</div>
        </div>
      </div>
      <div class="modal-footer" style="justify-content: ${options.remove ? 'space-between' : 'center'}; padding: 12px 20px;">
        ${options.remove ? html`<button type="button" id="${id}-btn-clear" class="btn btn-secondary" style="font-size: 12px; color: var(--danger);">${options.remove.label}</button>` : null}
        <button type="button" id="${id}-btn-cancel" class="btn btn-secondary" data-modal-close style="font-size: 12px;">${t('soundboard.cancelEsc')}</button>
      </div>
    </div>
  `,
    initialFocus: `#${id}-btn-cancel`,
    onClose: () => disposeCapture(),
  });
  const close = (): void => { shell.close('api'); };
  disposeCapture = captureShortcut(shell.element, shell.card.querySelector<HTMLElement>(`#${id}-box`), (combo) => {
    close();
    options.onCaptured(combo);
  }, close, options.owner);
  const remove = options.remove;
  if (remove) {
    shell.card.querySelector(`#${id}-btn-clear`)?.addEventListener('click', () => {
      close();
      remove.onClick();
    }, { signal: shell.signal });
  }
  return close;
}
