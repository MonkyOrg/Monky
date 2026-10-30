import {
  decodeScreenShareFailure, errorChain, nativeErrorCodes, screenShareFailureCategory,
  type ScreenEncodingAvailability, type ScreenShareFailureCategory,
} from '@monky/shared';
import { clientLog } from '../core/ClientLogService';
import { t, type TranslationKey } from '../i18n';

/** A screen-sharing failure the renderer already explained to the person, in the app's language. */
export class ScreenShareUserError extends Error {
  override readonly name = 'ScreenShareUserError';
}

/** What the person was doing when the failure happened. */
export type ScreenShareFailureAction = 'start' | 'stop' | 'game-start' | 'game-stop';

const ACTIONS: Readonly<Record<ScreenShareFailureAction, TranslationKey>> = {
  start: 'screenShare.startFailed',
  stop: 'screenShare.stopFailed',
  'game-start': 'gameShare.failed',
  'game-stop': 'gameShare.stopFailed',
};

const CATEGORIES: Readonly<Record<ScreenShareFailureCategory, TranslationKey>> = {
  game: 'screenShare.gameCaptureUnavailable',
  permission: 'screenShare.failure.permission',
  'source-lost': 'screenShare.failure.source-lost',
  files: 'screenShare.failure.files',
  encoder: 'screenShare.failure.encoder',
  quality: 'screenShare.failure.quality',
  capacity: 'screenShare.nativeFailure.capacity-exceeded',
  interrupted: 'screenShare.failure.interrupted',
  unexpected: 'screenShare.failure.unexpected',
};

const IPC_REJECTION = /^Error invoking remote method '/;

/**
 * The message a screen-sharing failure shows (#490): what happened and what the person can do, never the
 * technical text. A message the app already wrote for the person is kept; native codes Main sent along an
 * IPC rejection pick a category; anything else reads as unexpected. The technical detail Main logged stays
 * in its log, and what only the renderer knows goes to the client log here.
 */
export function screenShareFailureMessage(error: unknown, action: ScreenShareFailureAction): string {
  const chain = errorChain(error);
  const codes = new Set<string>(nativeErrorCodes(error));
  let reason: string | null = null;
  for (const current of chain) {
    if (current instanceof ScreenShareUserError) { reason = current.message; break; }
    const detail = current instanceof Error ? decodeScreenShareFailure(current.message) : null;
    if (!detail) continue;
    if (detail.notice) { reason = detail.notice; break; }
    for (const code of detail.codes) codes.add(code);
  }
  const category = screenShareFailureCategory([...codes]);
  clientLog.warn('SCREEN_SHARE', `Screen share ${action} failed`, {
    category: reason === null ? category : 'explained', codes: [...codes],
    // Main already logged what crossed the IPC, keeping only allowlisted fields of its messages.
    errors: chain.slice(0, 4).map(current => current instanceof Error
      ? { name: current.name, ...(IPC_REJECTION.test(current.message) ? {} : { message: current.message.slice(0, 300) }) }
      : { name: typeof current }),
  });
  return t(ACTIONS[action], { reason: reason ?? t(CATEGORIES[category]) });
}

/**
 * The notice of an automatic share that fell back to software encoding. Main logs each refused hardware candidate
 * (its codes and allowlisted native measurements); only an encoder or quality refusal is explained here, as its
 * category reads.
 */
export function screenEncodingFallbackMessage(hardware: ScreenEncodingAvailability['hardware']): string {
  const category = screenShareFailureCategory(hardware.codes ?? []);
  clientLog.info('SCREEN_SHARE', 'Hardware screen encoding unavailable; software selected', {
    category, codes: [...hardware.codes ?? []],
  });
  return t('screenShare.encodingFallback', {
    reason: category === 'encoder' || category === 'quality' ? t(CATEGORIES[category]) : '',
  }).trim();
}
