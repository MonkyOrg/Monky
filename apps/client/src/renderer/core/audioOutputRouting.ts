import { appEvents } from './EventBus';
import { settingsChanged, settingsStore, type SettingsUpdate } from '../stores/settingsStore';
import {
  copyAudioOutputPreferences, normalizeAudioOutputId, resolveAudioOutput,
  type AudioOutputCategory, type AudioOutputPreferences,
} from '../utils/audioPreferences';

/** Where a sound plays: one of the advanced output categories, or the general output (alerts, soundboard). */
export type AudioOutputRoute = AudioOutputCategory | 'general';

/**
 * Moves a set of players to the devices `effectiveAudioOutput` answers when it
 * runs. A rejection means a device refused, which undoes a selection in progress.
 */
export type AudioOutputConsumer = () => Promise<void>;

export interface AudioOutputSelection {
  signal?: AbortSignal;
  /** Saves the preferences once every player moved; throwing undoes the whole selection. */
  commit?: () => void;
}

const consumers = new Set<AudioOutputConsumer>();
/** The preferences a selection is moving the players to, until they are saved or undone. */
let candidate: AudioOutputPreferences | null = null;
let unfollowSaves: (() => void) | null = null;

/**
 * The device a route plays on right now: the preferences being selected while a
 * selection runs, the saved ones otherwise. Players read it whenever they route,
 * so one that starts in the middle of a selection already joins the new device.
 */
export function effectiveAudioOutput(route: AudioOutputRoute): string {
  const preferences = candidate ?? settingsStore;
  return route === 'general' ? normalizeAudioOutputId(preferences.selectedSpeakerId) : resolveAudioOutput(preferences, route);
}

/** Players follow every change of output from registration until the returned function is called. */
export function registerAudioOutputConsumer(apply: AudioOutputConsumer): () => void {
  consumers.add(apply);
  unfollowSaves ??= appEvents.on('settings.updated', followSavedOutputs);
  return () => {
    consumers.delete(apply);
    if (consumers.size) return;
    unfollowSaves?.();
    unfollowSaves = null;
  };
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Audio output selection was cancelled', 'AbortError');
}

/**
 * Moves every player to `next`, one consumer at a time, then runs `commit`. When
 * a device refuses, the selection is cancelled or `commit` throws, every player
 * returns to the saved preferences and the error is rethrown.
 */
export async function routeAudioOutputs(next: AudioOutputPreferences, { signal, commit }: AudioOutputSelection = {}): Promise<void> {
  if (candidate) throw new Error('Audio output selection already in progress');
  throwIfCancelled(signal);
  const previous = copyAudioOutputPreferences(settingsStore);
  candidate = copyAudioOutputPreferences(next);
  try {
    for (const apply of [...consumers]) {
      await apply();
      throwIfCancelled(signal);
    }
    commit?.();
  } catch (error) {
    // Some players may already be on the new devices when a later one refuses.
    candidate = previous;
    const restored = await Promise.allSettled([...consumers].map((apply) => apply()));
    if (restored.some((result) => result.status === 'rejected')) {
      console.error('[AudioOutputs] Some playback devices could not be restored', restored);
    }
    throw error;
  } finally {
    candidate = null;
  }
}

/** Outputs saved outside a selection, such as by another window: every player follows them. */
function followSavedOutputs(update: SettingsUpdate | undefined): void {
  if (candidate || !settingsChanged(update, 'selectedSpeakerId', 'advancedAudioOutputs', 'audioOutputDevices')) return;
  void Promise.allSettled([...consumers].map((apply) => apply())).then((results) => {
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) console.warn('[AudioOutputs] Some players could not follow the saved outputs', failures);
  });
}
