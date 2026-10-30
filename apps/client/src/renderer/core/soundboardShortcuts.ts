import { settingsStore } from '../stores/settingsStore';
import { soundboardService } from './SoundboardService';
import { findShortcutConflicts, type ShortcutKeyCombo } from '../utils/keybind';

/**
 * The one place that changes the soundboard's shortcuts, for the soundboard and the
 * settings alike: every change is saved and then registered with the global hook,
 * which fires every sound bound to the keys pressed.
 */

/** The other sounds already bound to these keys. */
export function findSoundShortcutConflicts(accelerator: string, soundName: string): string[] {
  return findShortcutConflicts(settingsStore.soundboardShortcuts, accelerator, soundName);
}

/** Binds the keys to a sound, taking them from the sounds in `replacing` when the user agreed to it. */
export async function assignSoundShortcut(soundName: string, combo: ShortcutKeyCombo, replacing: readonly string[] = []): Promise<void> {
  const next = { ...settingsStore.soundboardShortcuts };
  for (const name of replacing) delete next[name];
  next[soundName] = combo;
  await save(next, true);
}

export async function removeSoundShortcut(soundName: string): Promise<void> {
  const next = { ...settingsStore.soundboardShortcuts };
  if (!next[soundName]) return;
  delete next[soundName];
  await save(next, true);
}

/**
 * A sound's file was renamed (`newName`) or deleted (null): its shortcut follows or
 * goes away. The file already changed, so a failed save keeps the change for this
 * session; the result says whether it was saved.
 */
export async function moveSoundShortcut(soundName: string, newName: string | null): Promise<boolean> {
  const next = { ...settingsStore.soundboardShortcuts };
  const shortcut = next[soundName];
  if (!shortcut) return true;
  delete next[soundName];
  if (newName && !next[newName]) next[newName] = shortcut;
  return save(next, false);
}

/** A change refused by storage is undone, or kept for this session when `revert` is false. */
async function save(next: typeof settingsStore.soundboardShortcuts, revert: boolean): Promise<boolean> {
  const previous = settingsStore.soundboardShortcuts;
  settingsStore.soundboardShortcuts = next;
  let saved = true;
  try {
    settingsStore.save();
  } catch (error: unknown) {
    if (revert) {
      settingsStore.soundboardShortcuts = previous;
      throw error;
    }
    saved = false;
  }
  await soundboardService.syncShortcuts();
  return saved;
}
