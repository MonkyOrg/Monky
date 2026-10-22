import type { Role } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from './html';

/**
 * A member's role tags, highest in the hierarchy first. Past `limit`, the rest
 * collapse into a "+N" chip whose tooltip lists them, so a member with many
 * roles keeps a compact row.
 */
export function renderRoleTags(roles: readonly Role[], limit: number): string {
  if (!roles.length) return '';
  const ordered = [...roles].sort((a, b) => b.position - a.position);
  const visible = ordered.slice(0, limit);
  const hidden = ordered.slice(limit);
  const tag = (role: Role) => `<span class="member-role-tag"${role.color
    ? ` style="--role-color: ${escapeHtml(role.color)}"` : ''}>${escapeHtml(role.name)}</span>`;
  const more = hidden.length
    ? `<span class="member-role-more" tabindex="0" role="note" data-tooltip="${escapeHtml(hidden.map((role) => role.name).join('\n'))}"
        aria-label="${escapeHtml(t('roles.moreRolesAria', { count: hidden.length, names: hidden.map((role) => role.name).join(', ') }))}">+${hidden.length}</span>`
    : '';
  return `<div class="member-role-tags">${visible.map(tag).join('')}${more}</div>`;
}
