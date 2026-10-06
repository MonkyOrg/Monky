import {
  SOUNDBOARD_EDIT_SAMPLE_RATE,
  type SoundboardFileFailure, type SoundboardFileResult, type SoundboardSavedFile,
} from '@monky/shared';
import { favoritesStore } from '../stores/favoritesStore';
import { settingsStore } from '../stores/settingsStore';
import { soundboardService, type SoundItem } from './SoundboardService';
import { t } from '../i18n';

export class SoundboardLibraryError extends Error {}

export function soundboardFileValue<T>(result: SoundboardFileResult<T>): T {
  if (result.status === 'failed') throw new SoundboardLibraryError(soundboardFileMessage(result.reason));
  return result.value;
}

export function soundboardFileMessage(reason: SoundboardFileFailure): string {
  return t(`soundboard.fileError.${reason}`);
}

export function validateSoundboardName(name: string): string | undefined {
  return !name || name !== name.trim() || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) ||
    /[. ]$/.test(name) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:[. ]|$)/i.test(name) ||
    name.length > 110 || new TextEncoder().encode(name).length > 240
    ? t('soundboard.fileError.invalid_request') : undefined;
}

/** Filesystem success is not rolled back if a separate preference write fails. */
export async function finishSoundboardMutation(sound: SoundItem, saved: SoundboardSavedFile | null): Promise<boolean> {
  soundboardService.stopLocalFile(sound.name);
  let preferencesSaved = true;
  try { favoritesStore.moveSound(sound.filePath, saved?.filePath ?? null); }
  catch { preferencesSaved = false; }
  const newName = saved ? saved.fileName.slice(0, -sound.ext.length) : null;
  const shortcuts = settingsStore.soundboardShortcuts;
  if (shortcuts[sound.name] && !soundboardService.getSounds().some(item => item.filePath !== sound.filePath && item.name === sound.name)) {
    const next = { ...shortcuts };
    const shortcut = next[sound.name];
    delete next[sound.name];
    if (newName && !next[newName]) next[newName] = shortcut;
    settingsStore.soundboardShortcuts = next;
    try { settingsStore.save(); }
    catch { preferencesSaved = false; }
    await soundboardService.syncShortcuts();
  }
  await soundboardService.loadSounds();
  return preferencesSaved;
}

export async function decodeSoundboardEdit(bytes: Uint8Array, signal: AbortSignal): Promise<AudioBuffer> {
  signal.throwIfAborted();
  const buffer = new Uint8Array(bytes).buffer;
  const url = URL.createObjectURL(new Blob([buffer]));
  const audio = new Audio();
  audio.preload = 'metadata';
  try {
    // Inspect duration before expanding compressed data; no output device is opened.
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        audio.onloadedmetadata = null;
        audio.onerror = null;
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => done(new Error(t('common.cancel')));
      const timer = setTimeout(() => done(new SoundboardLibraryError(soundboardFileMessage('unsupported'))), 10_000);
      audio.onloadedmetadata = () => done(
        !Number.isFinite(audio.duration) || audio.duration <= 0
          ? new SoundboardLibraryError(soundboardFileMessage('unsupported')) : undefined,
      );
      audio.onerror = () => done(new SoundboardLibraryError(soundboardFileMessage('unsupported')));
      signal.addEventListener('abort', abort, { once: true });
      audio.src = url;
    });
  } finally {
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  }
  signal.throwIfAborted();
  let decoded: AudioBuffer;
  try {
    const context = new OfflineAudioContext(2, 1, SOUNDBOARD_EDIT_SAMPLE_RATE);
    decoded = await context.decodeAudioData(buffer);
  } catch { throw new SoundboardLibraryError(soundboardFileMessage('unsupported')); }
  signal.throwIfAborted();
  if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2 ||
      !Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new SoundboardLibraryError(soundboardFileMessage('unsupported'));
  return decoded;
}
