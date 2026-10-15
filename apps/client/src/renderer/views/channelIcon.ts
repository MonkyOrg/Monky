import type { ChannelType } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';

const GLYPHS: Record<ChannelType, string> = { TEXT: 'tag', VOICE: 'volume_up', FORUM: 'forum' };

// A small padlock drawn in the icon's own color; the glyph below it is masked
// where the padlock sits, so the two never touch on any row background.
const LOCK = `<svg class="channel-icon-lock" viewBox="0 0 8 9" aria-hidden="true" focusable="false">
  <path d="M2.2 4V2.8a1.8 1.8 0 0 1 3.6 0V4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  <rect x="0.8" y="3.9" width="6.4" height="4.6" rx="1.1" fill="currentColor"/>
</svg>`;

/**
 * The glyph that opens a channel row in the sidebar. A private channel wears a
 * padlock on the corner of its own glyph, as on Discord, rather than a second
 * icon after the name. The AFK room is drawn as a moon.
 */
export function renderChannelIcon(
  type: ChannelType, { isPrivate = false, afk = false, color }: { isPrivate?: boolean; afk?: boolean; color?: string } = {},
): string {
  const glyph = afk ? 'bedtime' : GLYPHS[type];
  const style = color ? ` style="color: ${color};"` : '';
  const label = escapeHtml([afk ? t('afk.channelBadge') : '', isPrivate ? t('main.privateChannelBadge') : '']
    .filter(Boolean).join(' · '));
  const described = label ? ` role="img" aria-label="${label}" title="${label}"` : ' aria-hidden="true"';
  if (!isPrivate) return `<span class="material-symbols-outlined md-16 channel-icon"${style}${described}>${glyph}</span>`;
  return `<span class="channel-icon channel-icon--private"${style}${described}>`
    + `<span class="material-symbols-outlined md-16 channel-icon-glyph" aria-hidden="true">${glyph}</span>${LOCK}</span>`;
}

/** Turns a row's icon into the spinner shown while joining; the next render restores it. */
export function showChannelIconLoading(icon: HTMLElement): void {
  icon.replaceChildren();
  icon.removeAttribute('role');
  icon.removeAttribute('aria-label');
  icon.removeAttribute('title');
  icon.setAttribute('aria-hidden', 'true');
  icon.className = 'material-symbols-outlined md-16 channel-icon channel-loading';
  icon.textContent = 'progress_activity';
}
