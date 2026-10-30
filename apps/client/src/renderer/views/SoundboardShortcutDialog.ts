import { t } from '../i18n';
import { html, type SafeHtml } from '../utils/html';
import { enterModal, exitModal } from '../utils/modalSurface';
import { enableBackdropClose } from '../utils/modal';
import { captureShortcut, type ShortcutKeyCombo } from '../utils/keybind';
import { clientLog } from '../core/ClientLogService';
import { soundboardService } from '../core/SoundboardService';
import { assignSoundShortcut, findSoundShortcutConflicts, removeSoundShortcut } from '../core/soundboardShortcuts';
import { showConfirm } from './Dialog';
import { showErrorToast } from './CopyToast';

/** The localized prompt with the sound's name in bold. */
function prompt(soundName: string): SafeHtml {
  const [before = '', after = ''] = t('soundboard.keybindPrompt', { sound: '\u0000' }).split('\u0000');
  return html`${before}<strong style="color: var(--text-primary);">${soundName}</strong>${after}`;
}

/** Runs a change of the shortcuts and refreshes the list; a refused save is explained in a toast. */
async function changeShortcuts(update: () => Promise<void>, onChange: () => void): Promise<void> {
  try {
    await update();
    onChange();
  } catch (error: unknown) {
    clientLog.warn('AUDIO', 'Could not save a soundboard shortcut', {
      error: error instanceof Error ? error.message : String(error),
    });
    showErrorToast(t('soundboard.shortcutSaveFailed'));
  }
}

/** The remove button next to a sound's shortcut, in the soundboard and in the settings. */
export function clearSoundShortcut(soundName: string, onChange: () => void): Promise<void> {
  return changeShortcuts(() => removeSoundShortcut(soundName), onChange);
}

/**
 * Sets one sound's shortcut, from the soundboard and from the settings: captures a
 * held combination, asks before taking it from another sound and can remove the
 * current one. `onChange` runs once the shortcuts changed; capture stops when
 * `owner` goes away. Returns a function that closes the dialog.
 */
export function openSoundShortcutDialog(soundName: string, owner: HTMLElement, onChange: () => void): () => void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.style.zIndex = '10002';
  backdrop.innerHTML = html`
    <div class="modal-card" style="width: 380px; max-width: 90vw; text-align: center;" role="dialog" aria-modal="true" aria-labelledby="sb-keybind-title">
      <div class="modal-header" style="justify-content: center; position: relative;">
        <div class="modal-title" style="display: flex; align-items: center; gap: 8px; font-size: 15px;">
          <span class="material-symbols-outlined" style="color: var(--accent-primary);" aria-hidden="true">keyboard</span>
          <span id="sb-keybind-title">${t('soundboard.keybindTitle')}</span>
        </div>
        <button type="button" id="sb-keybind-modal-close" class="modal-close-btn" style="position: absolute; right: 16px; top: 16px;" aria-label="${t('common.close')}">&times;</button>
      </div>
      <div style="padding: 16px 20px 20px;">
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px; word-break: break-word;">
          ${prompt(soundName)}
        </div>
        <div id="sb-keybind-box" style="padding: 24px 16px; background: var(--bg-input); border: 2px dashed var(--accent-primary); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 0 16px rgba(88, 101, 242, 0.25);">
          <span class="material-symbols-outlined" style="font-size: 32px; color: var(--accent-primary); animation: pulse 1.5s infinite;" aria-hidden="true">keyboard</span>
          <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${t('soundboard.keybindWaiting')}</div>
          <div style="font-size: 11px; color: var(--text-muted);">${t('soundboard.keybindExamples')}</div>
        </div>
      </div>
      <div class="modal-footer" style="justify-content: space-between; padding: 12px 20px;">
        <button type="button" id="sb-keybind-btn-clear" class="btn btn-secondary" style="font-size: 12px; color: var(--danger);">${t('soundboard.removeShortcutButton')}</button>
        <button type="button" id="sb-keybind-btn-cancel" class="btn btn-secondary" style="font-size: 12px;">${t('soundboard.cancelEsc')}</button>
      </div>
    </div>
  `.toString();
  document.body.appendChild(backdrop);
  enterModal(backdrop);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    disposeCapture();
    exitModal(backdrop);
  };
  const captured = async (combo: ShortcutKeyCombo) => {
    close();
    const conflicts = findSoundShortcutConflicts(combo.accelerator, soundName);
    if (conflicts.length && !await showConfirm({
      title: t('soundboard.shortcutInUseTitle'),
      message: t('soundboard.shortcutInUseMessage', { combo: combo.display, sound: conflicts.join(', ') }),
      confirmLabel: t('soundboard.replace'),
      cancelLabel: t('common.cancel'),
      variant: 'warning',
    })) {
      await soundboardService.syncShortcuts();
      return;
    }
    await changeShortcuts(() => assignSoundShortcut(soundName, combo, conflicts), onChange);
  };
  const disposeCapture = captureShortcut(backdrop, backdrop.querySelector<HTMLElement>('#sb-keybind-box'),
    (combo) => { void captured(combo); }, close, owner);
  backdrop.querySelector('#sb-keybind-modal-close')?.addEventListener('click', close);
  backdrop.querySelector('#sb-keybind-btn-cancel')?.addEventListener('click', close);
  backdrop.querySelector('#sb-keybind-btn-clear')?.addEventListener('click', () => {
    close();
    void clearSoundShortcut(soundName, onChange);
  });
  enableBackdropClose(backdrop, close);
  return close;
}
