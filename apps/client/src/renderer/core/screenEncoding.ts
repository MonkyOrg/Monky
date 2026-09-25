import type { NativeScreenVideoProfile, ScreenEncodingAvailability } from '@monky/shared';
import { settingsStore } from '../stores/settingsStore';
import { t } from '../i18n';
import { showInfoToast } from '../views/CopyToast';

export async function probeScreenEncoding(
  video: NativeScreenVideoProfile, signal: AbortSignal,
): Promise<ScreenEncodingAvailability> {
  signal.throwIfAborted();
  if (typeof window.api?.nativeScreenCommand !== 'function') throw new Error(t('screenShare.nativeUnavailable'));
  const probeId = crypto.randomUUID();
  const cancel = () => {
    void window.api.nativeScreenCommand({ action: 'cancel-encoding-probe', probeId }).catch(error => {
      console.warn('[ScreenEncoding] Probe cancellation failed:', error);
    });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await window.api.nativeScreenCommand({
      action: 'probe-encoding', probeId, video,
      encodingMode: settingsStore.screenEncodingMode, codec: settingsStore.preferredScreenCodec,
      encodingStrategy: settingsStore.screenEncodingStrategy,
    });
    signal.throwIfAborted();
    if (result.kind !== 'encoding') throw new Error('Invalid screen encoder discovery response.');
    return result.availability;
  } finally { signal.removeEventListener('abort', cancel); }
}

export function acceptScreenEncoding(availability: ScreenEncodingAvailability | undefined): void {
  if (!availability?.fallback || availability.selection?.mode !== 'software') return;
  showInfoToast(t('screenShare.encodingFallback', { reason: availability.hardware.reason ?? '' }));
}
