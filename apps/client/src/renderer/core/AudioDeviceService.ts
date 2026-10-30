import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { t } from '../i18n';
import { applyAudioDevice } from './applyAudioDevice';
import { audioProcessor } from './AudioProcessor';
import { routeAudioOutputs } from './audioOutputRouting';
import {
  AUDIO_OUTPUT_CATEGORIES, copyAudioOutputPreferences, resolveAudioOutput,
  type AudioOutputPreferences, type NoiseSuppressionMode,
} from '../utils/audioPreferences';

export type AudioDeviceKind = 'input' | 'output';
/** Moves the call to another microphone (applyAudioDevice in production). */
export type AudioDeviceApplier = (kind: 'input', deviceId: string, signal?: AbortSignal) => Promise<void>;

let applyLiveDevice: AudioDeviceApplier | null = null;
let selecting = false;

/** Override the production microphone switch for isolated renderer fixtures. */
export function registerAudioDeviceApplier(apply: AudioDeviceApplier): () => void {
  applyLiveDevice = apply;
  return () => { if (applyLiveDevice === apply) applyLiveDevice = null; };
}

export function selectedAudioDevice(kind: AudioDeviceKind): string {
  return kind === 'input' ? settingsStore.selectedMicrophoneId : settingsStore.selectedSpeakerId;
}

export function populateAudioDeviceSelect(
  select: HTMLSelectElement,
  kind: AudioDeviceKind,
  devices: MediaDeviceInfo[],
  selected = selectedAudioDevice(kind),
): string {
  const available = devices.filter((device) => device.kind === (kind === 'input' ? 'audioinput' : 'audiooutput'));
  select.replaceChildren(new Option(t('audioDevices.systemDefault'), ''));
  for (const [index, device] of available.entries()) {
    if (!device.deviceId || device.deviceId === 'default') continue;
    select.add(new Option(device.label || `${t(kind === 'input' ? 'settings.microphone' : 'settings.outputDevice')} ${index + 1}`, device.deviceId));
  }
  // Older settings saved Chromium's "default" alias rather than the empty sink ID.
  const normalized = selected === 'default' ? '' : selected;
  const missing = normalized !== '' && !Array.from(select.options).some((option) => option.value === normalized);
  if (missing) {
    const unavailable = new Option(t('audioDevices.unavailableDevice'), normalized);
    unavailable.disabled = true;
    select.add(unavailable);
  }
  select.value = normalized;
  return missing ? t('audioDevices.unavailableDevice')
    : available.length === 0 ? t(kind === 'input' ? 'settings.noMicDetected' : 'audioDevices.noOutputDetected') : '';
}

export function audioDeviceError(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return t('audioDevices.permissionDenied');
  }
  if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) {
    return t('audioDevices.unavailableDevice');
  }
  return t('audioDevices.selectionFailed');
}

export async function selectAudioDevice(kind: AudioDeviceKind, deviceId: string, signal?: AbortSignal): Promise<void> {
  if (kind === 'output') {
    const next = copyAudioOutputPreferences(settingsStore);
    next.selectedSpeakerId = deviceId;
    await selectOutputs(next, [deviceId], signal);
    return;
  }
  if (selecting) throw new Error('Audio device selection already in progress');
  if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
  selecting = true;
  const previous = settingsStore.selectedMicrophoneId;
  let applied = false;
  try {
    if (!voiceStore.currentVoiceChannelId) {
      // Validate before persisting; never attach this local permission probe to a call.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false,
      });
      stream.getTracks().forEach((track) => track.stop());
    }
    if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
    await (applyLiveDevice ?? applyAudioDevice)('input', deviceId, signal);
    applied = true;
    if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
    settingsStore.selectedMicrophoneId = deviceId;
    settingsStore.save();
  } catch (error) {
    settingsStore.selectedMicrophoneId = previous;
    if (applied) {
      try {
        await (applyLiveDevice ?? applyAudioDevice)('input', previous);
      } catch (rollbackError) {
        console.error('[AudioDevices] Could not restore the previous device:', rollbackError);
      }
    }
    throw error;
  } finally {
    selecting = false;
  }
}

export async function selectAudioOutputPreferences(next: AudioOutputPreferences, signal?: AbortSignal): Promise<void> {
  const devices = new Set(AUDIO_OUTPUT_CATEGORIES.map((category) => resolveAudioOutput(next, category)));
  devices.add(next.selectedSpeakerId);
  await selectOutputs(next, devices, signal);
}

/** Checks that each device opens, moves every player to them and saves; any failure leaves everything as it was. */
async function selectOutputs(next: AudioOutputPreferences, devices: Iterable<string>, signal?: AbortSignal): Promise<void> {
  if (selecting) throw new Error('Audio device selection already in progress');
  if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
  selecting = true;
  try {
    const probe = new Audio();
    if (typeof probe.setSinkId !== 'function') throw new Error('Output selection unavailable');
    for (const deviceId of devices) {
      await probe.setSinkId(deviceId);
      if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
    }
    await routeAudioOutputs(next, { signal, commit: () => saveOutputPreferences(next) });
  } finally {
    selecting = false;
  }
}

function saveOutputPreferences(next: AudioOutputPreferences): void {
  const previous = copyAudioOutputPreferences(settingsStore);
  const assign = (preferences: AudioOutputPreferences) => {
    settingsStore.selectedSpeakerId = preferences.selectedSpeakerId;
    settingsStore.advancedAudioOutputs = preferences.advancedAudioOutputs;
    settingsStore.audioOutputDevices = { ...preferences.audioOutputDevices };
  };
  assign(next);
  try {
    settingsStore.save();
  } catch (error) {
    assign(previous);
    throw error;
  }
}

export async function selectNoiseSuppression(mode: NoiseSuppressionMode, signal?: AbortSignal): Promise<void> {
  if (selecting) throw new Error('Audio device selection already in progress');
  if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
  selecting = true;
  const previous = settingsStore.noiseSuppressionMode;
  const previousLastMode = settingsStore.lastNoiseSuppressionMode;
  let applied = false;
  try {
    await audioProcessor.setNoiseSuppression(mode, signal);
    applied = true;
    if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
    settingsStore.noiseSuppressionMode = mode;
    if (mode !== 'off') settingsStore.lastNoiseSuppressionMode = mode;
    settingsStore.save();
  } catch (error) {
    settingsStore.noiseSuppressionMode = previous;
    settingsStore.lastNoiseSuppressionMode = previousLastMode;
    if (applied) await audioProcessor.setNoiseSuppression(previous);
    throw error;
  } finally {
    selecting = false;
  }
}
