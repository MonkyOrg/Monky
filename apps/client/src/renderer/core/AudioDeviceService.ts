import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { t } from '../i18n';
import { applyAudioDevice } from './applyAudioDevice';

export type AudioDeviceKind = 'input' | 'output';
export type AudioDeviceApplier = (kind: AudioDeviceKind, deviceId: string, signal?: AbortSignal) => Promise<void>;

let applyLiveDevice: AudioDeviceApplier | null = null;
let selecting = false;

/** Override the production switch path for isolated renderer fixtures. */
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
): string {
  const available = devices.filter((device) => device.kind === (kind === 'input' ? 'audioinput' : 'audiooutput'));
  const selected = selectedAudioDevice(kind);
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
  if (selecting) throw new Error('Audio device selection already in progress');
  if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
  selecting = true;
  try {
    if (kind === 'input' && !voiceStore.currentVoiceChannelId) {
      // Validate before persisting; never attach this local permission probe to a call.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false,
      });
      stream.getTracks().forEach((track) => track.stop());
    } else if (kind === 'output') {
      const probe = new Audio();
      if (typeof probe.setSinkId !== 'function') throw new Error('Output selection unavailable');
      await probe.setSinkId(deviceId);
    }
    if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
    await (applyLiveDevice ?? applyAudioDevice)(kind, deviceId, signal);
    if (signal?.aborted) throw new DOMException('Selection cancelled', 'AbortError');
    if (kind === 'input') settingsStore.selectedMicrophoneId = deviceId;
    else settingsStore.selectedSpeakerId = deviceId;
    settingsStore.save();
  } finally {
    selecting = false;
  }
}
