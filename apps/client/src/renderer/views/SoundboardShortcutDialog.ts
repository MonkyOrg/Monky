import { t } from '../i18n';
import { html, type SafeHtml } from '../utils/html';
import { type ShortcutKeyCombo } from '../utils/keybind';
import { clientLog } from '../core/ClientLogService';
import { soundboardService } from '../core/SoundboardService';
import { assignSoundShortcut, findSoundShortcutConflicts, removeSoundShortcut } from '../core/soundboardShortcuts';
import { showConfirm } from './Dialog';
import { showErrorToast } from './CopyToast';
import { openShortcutCaptureDialog } from './ShortcutCaptureDialog';

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
  const captured = async (combo: ShortcutKeyCombo) => {
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
  return openShortcutCaptureDialog({
    idPrefix: 'sb-keybind',
    title: t('soundboard.keybindTitle'),
    prompt: prompt(soundName),
    owner,
    onCaptured: (combo) => { void captured(combo); },
    remove: { label: t('soundboard.removeShortcutButton'), onClick: () => { void clearSoundShortcut(soundName, onChange); } },
  });
}
