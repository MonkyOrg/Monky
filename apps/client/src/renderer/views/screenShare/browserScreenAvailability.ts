import type { NativeScreenCapabilities } from '@monky/shared';
import type { TranslationKey } from '../../i18n';

/**
 * Why this tab cannot start a screen share (#Android web): the device has no capture API
 * (`platform`, typical on Android Chrome), or this browser cannot encode for Monky.
 */
export function browserScreenUnavailableKey(
  reason: NativeScreenCapabilities['reason'] | undefined,
): TranslationKey {
  return reason === 'platform' ? 'screenShare.deviceUnavailable' : 'screenShare.browserUnavailable';
}
