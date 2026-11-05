import { SCREEN_SHARE_LIMITS } from '@monky/shared';
import { voiceStore } from '../../stores/voiceStore';
import { t } from '../../i18n';
import { showConfirm } from '../Dialog';

/** The call in which adding screens past the comfortable amount was already confirmed. */
let confirmedFor: string | null = null;

/**
 * Past SCREEN_SHARE_LIMITS.comfortable each screen costs another capture, encoder and upload, so adding one
 * more asks first, once per call. Closing the picker (`signal`) dismisses the question.
 */
export async function confirmExtraScreen(limit: number, signal: AbortSignal | undefined): Promise<boolean> {
  const count = voiceStore.screenShareIds.length;
  const callKey = `${voiceStore.voiceSessionKey ?? ''}\n${voiceStore.currentVoiceChannelId ?? ''}`;
  if (count < SCREEN_SHARE_LIMITS.comfortable || confirmedFor === callKey) return true;
  const confirmed = await showConfirm({
    title: t('screenShare.extraScreensTitle'),
    message: t('screenShare.extraScreensMessage', { count: String(count), max: String(limit) }),
    confirmLabel: t('screenShare.extraScreensConfirm'),
    variant: 'warning',
    signal,
  });
  if (confirmed) confirmedFor = callKey;
  return confirmed;
}
