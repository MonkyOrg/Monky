import { videoService } from '../../core/VideoService';
import { settingsStore } from '../../stores/settingsStore';
import { t } from '../../i18n';
import { cameraEffectErrorMessage } from '../../utils/cameraEffectErrors';

export class CameraPreferenceError extends Error {
  public constructor(cause: unknown) {
    super('Camera device preference could not be saved', { cause });
  }
}

export function cameraDeviceSelectionError(error: unknown): string {
  return error instanceof CameraPreferenceError ? t('cameraEffects.deviceSaveFailed') : cameraEffectErrorMessage(error);
}

export function populateCameraDeviceSelect(select: HTMLSelectElement, devices: readonly MediaDeviceInfo[]): string {
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  select.replaceChildren(new Option(t('audioDevices.systemDefault'), ''));
  for (const [index, device] of cameras.entries()) {
    if (device.deviceId && device.deviceId !== 'default') {
      select.add(new Option(device.label || `${t('settings.camera')} ${index + 1}`, device.deviceId));
    }
  }
  const selected = settingsStore.selectedCameraId;
  const missing = selected !== '' && !Array.from(select.options).some((option) => option.value === selected);
  if (missing) {
    const option = new Option(t('audioDevices.unavailableDevice'), selected);
    option.disabled = true;
    select.add(option);
  }
  select.value = selected;
  return missing ? t('audioDevices.unavailableDevice') : cameras.length ? '' : t('settings.noCameraDetected');
}

export async function selectCameraDevice(deviceId: string): Promise<void> {
  const previous = settingsStore.selectedCameraId;
  settingsStore.selectedCameraId = deviceId;
  try {
    settingsStore.save();
  } catch (error) {
    settingsStore.selectedCameraId = previous;
    throw new CameraPreferenceError(error);
  }
  await videoService.setCameraDevice(deviceId);
}
