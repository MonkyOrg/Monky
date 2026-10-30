import type { Role } from '@monky/shared';
import { isHexColor } from './colors';
import { html } from './html';

/**
 * Shared markup for a role pick option: a dot with the role color, the role
 * name and a styled checkbox, used by every place where roles are assigned to
 * a member (#275). Only a hex color reaches the style, so a server cannot
 * smuggle other CSS through it.
 */
export function renderRoleOption(role: Role, assigned: boolean): string {
  return html`
    <span class="role-option">
      <span class="role-option-dot"${isHexColor(role.color) ? html` style="--role-color: ${role.color};"` : ''}></span>
      <span class="role-option-name">${role.name}</span>
      <span class="role-option-check${assigned ? ' checked' : ''}">
        <span class="material-symbols-outlined">check</span>
      </span>
    </span>
  `.toString();
}
