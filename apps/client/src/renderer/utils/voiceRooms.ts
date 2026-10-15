import { LIMITS, type ChannelSummary, type ServerDetails } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from './html';

/**
 * The AFK voice room of a server that negotiated `afk-channel`. Its id is
 * known even when the room itself is not listed for this member, because idle
 * members are moved there whether or not they could find it themselves.
 */
export function afkChannelIdOf(details: ServerDetails | null | undefined): string | null {
  return details?.protocol?.features.includes('afk-channel') ? details.afkChannelId ?? null : null;
}

/** The user limit shown next to a voice room, or null when it has none or the server predates it. */
export function voiceUserLimitOf(details: ServerDetails | null | undefined, channel: ChannelSummary): number | null {
  if (!details?.protocol?.features.includes('voice-user-limit') || channel.type !== 'VOICE') return null;
  if (channel.id === afkChannelIdOf(details)) return null;
  const limit = channel.maxParticipants ?? LIMITS.VOICE_USER_LIMIT_NONE;
  return limit > LIMITS.VOICE_USER_LIMIT_NONE ? limit : null;
}

/**
 * Reads the user limit typed in the channel settings: blank means no limit
 * (0), a whole number from 1 to LIMITS.VOICE_USER_LIMIT_MAX is a limit, and
 * anything else is null so the form can refuse it.
 */
export function parseVoiceUserLimitInput(raw: string): number | null {
  const value = raw.trim();
  if (value === '') return LIMITS.VOICE_USER_LIMIT_NONE;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= LIMITS.VOICE_USER_LIMIT_MAX ? limit : null;
}

/**
 * The "00 | 06" badge beside a limited voice room. Above the limit, the count
 * turns red. It has no tooltip: hovering the row trades it for the row's buttons.
 */
export function renderVoiceUserLimitBadge(count: number, limit: number): string {
  const over = count > limit;
  const label = escapeHtml(t(over ? 'main.voiceUserLimitExceeded' : 'main.voiceUserLimit', { count, limit }));
  const digits = (value: number) => String(value).padStart(2, '0');
  return `<span class="voice-user-limit${over ? ' voice-user-limit--over' : ''}" role="img" aria-label="${label}">`
    + `<span class="voice-user-limit-count" aria-hidden="true">${digits(count)}</span>`
    + `<span class="voice-user-limit-max" aria-hidden="true">${digits(limit)}</span></span>`;
}

export interface IdleSnapshot {
  /** Seconds since the last keyboard or mouse input anywhere in the system. */
  idleSeconds: number;
  /** Milliseconds since this member last spoke, or since they entered the room. */
  msSinceSpeech: number;
  timeoutSeconds: number;
  /** Sharing a screen or with the camera on. */
  broadcasting: boolean;
  /** Watching someone's screen share. */
  watching: boolean;
}

/**
 * Inactive means neither touching the keyboard or mouse nor speaking for the
 * whole timeout. Broadcasting or watching a stream counts as being present:
 * moving such a member would end what they are sharing or watching.
 */
export function isIdleInCall(snapshot: IdleSnapshot): boolean {
  const timeoutMs = snapshot.timeoutSeconds * 1000;
  return !snapshot.broadcasting && !snapshot.watching
    && snapshot.idleSeconds * 1000 >= timeoutMs && snapshot.msSinceSpeech >= timeoutMs;
}
