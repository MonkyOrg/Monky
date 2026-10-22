import type { CustomStatus } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from './html';

type PresenceUser = { brb?: boolean; invisible?: boolean; customStatus?: CustomStatus } | undefined;

/** The custom status shown for a person, unless they are invisible (custom-status). */
export function visibleCustomStatus(user: PresenceUser): CustomStatus | null {
  return user?.customStatus && !user.invisible && !user.brb ? user.customStatus : null;
}

/** Inline style that paints a status dot in the person's own colour. */
export function customStatusDotStyle(status: CustomStatus): string {
  return `--status-color: ${escapeHtml(status.color)}`;
}

/** The status in words: its emoji and text, or the tag when there is no text. */
export function customStatusLabel(status: CustomStatus): string {
  return [status.emoji, status.text ?? status.tag].filter(Boolean).join(' ') || t('customStatus.title');
}

/**
 * What sits next to a name: the yellow BRB tag while "Volto já" (user-brb), or
 * the emoji and tag of a custom status, each only when the person chose to
 * show it (custom-status). The status text is its tooltip.
 */
export function renderPresenceTag(user: PresenceUser): string {
  if (user?.brb && !user.invisible) {
    return `<span class="presence-brb-tag" title="${escapeHtml(t('main.statusBrb'))}">${escapeHtml(t('main.brbTag'))}</span>`;
  }
  const status = visibleCustomStatus(user);
  if (!status) return '';
  const emoji = status.showEmoji && status.emoji ? `<span class="presence-custom-emoji">${escapeHtml(status.emoji)}</span>` : '';
  const tag = status.showTag && status.tag ? `<span class="presence-custom-tag">${escapeHtml(status.tag)}</span>` : '';
  if (!emoji && !tag) return '';
  const label = status.text ?? [status.emoji, status.tag].filter(Boolean).join(' ');
  return `<span class="presence-custom" style="${customStatusDotStyle(status)}" role="img"
    aria-label="${escapeHtml(t('customStatus.aria', { status: label }))}"${status.text ? ` data-tooltip="${escapeHtml(status.text)}"` : ''}>${emoji}${tag}</span>`;
}
