import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';

/**
 * Form fields shared by the create and edit channel modals (#384).
 *
 * They live here so both dialogs stay in sync: a channel created private and one
 * edited into privacy must offer exactly the same choices, and the Admin role is
 * deliberately absent from the list in both because administrators already reach
 * every channel through ADMINISTRATOR.
 */

export interface ChannelPrivacySelection {
  isPrivate: boolean;
  allowedRoleIds: string[];
}

export function renderChannelBotCommandsField(enabled: boolean, type: 'TEXT' | 'VOICE'): string {
  return `<div class="form-group" id="channel-bot-commands-group" ${type === 'VOICE' ? 'hidden' : ''}>
    <div class="channel-privacy-row">
      <div class="channel-privacy-info">
        <span class="channel-privacy-title">${t('channelModal.botCommandsLabel')}</span>
        <span class="channel-privacy-desc">${t('channelModal.botCommandsHint')}</span>
      </div>
      <label class="toggle-switch" aria-label="${t('channelModal.botCommandsLabel')}">
        <input type="checkbox" id="input-channel-bot-commands" ${enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
  </div>`;
}

export function readChannelBotCommandsField(root: HTMLElement): boolean {
  return root.querySelector<HTMLInputElement>('#input-channel-bot-commands')?.checked ?? true;
}

export function attachChannelBotCommandsField(root: HTMLElement): () => void {
  const group = root.querySelector<HTMLElement>('#channel-bot-commands-group');
  const inputs = root.querySelectorAll<HTMLInputElement>('input[name="channel-type"]');
  const sync = () => {
    if (group) group.hidden = root.querySelector<HTMLInputElement>('input[name="channel-type"]:checked')?.value === 'VOICE';
  };
  inputs.forEach((input) => input.addEventListener('change', sync));
  return () => inputs.forEach((input) => input.removeEventListener('change', sync));
}

export function renderChannelPrivacyFields(selection: ChannelPrivacySelection): string {
  const roles = serverStore.getVisibleRoles();
  const selected = new Set(selection.allowedRoleIds);

  const roleList = roles.length
    ? roles
        .map(
          (role) => `
            <label class="channel-role-option">
              <span class="channel-role-dot" style="background: ${escapeHtml(role.color || 'var(--text-muted)')};"></span>
              <span class="channel-role-name">${escapeHtml(role.name)}</span>
              <span class="toggle-switch">
                <input type="checkbox" class="channel-role-checkbox" value="${escapeHtml(role.id)}" ${
                  selected.has(role.id) ? 'checked' : ''
                }>
                <span class="toggle-slider"></span>
              </span>
            </label>`
        )
        .join('')
    : `<div class="channel-role-empty">${t('channelModal.noRoles')}</div>`;

  return `
    <div class="form-group">
      <div class="channel-privacy-row">
        <div class="channel-privacy-info">
          <span class="channel-privacy-title">
            <span class="material-symbols-outlined md-16">lock</span>
            ${t('channelModal.privateLabel')}
          </span>
          <span class="channel-privacy-desc">${t('channelModal.privateHint')}</span>
        </div>
        <label class="toggle-switch" aria-label="${t('channelModal.privateLabel')}">
          <input type="checkbox" id="input-channel-private" ${selection.isPrivate ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="form-group channel-roles-group" id="channel-roles-group" ${selection.isPrivate ? '' : 'hidden'}>
      <label>${t('channelModal.allowedRolesLabel')}</label>
      <div class="channel-role-list">${roleList}</div>
      <div class="channel-privacy-hint">${t('channelModal.allowedRolesHint')}</div>
    </div>
  `;
}

/** Shows or hides the role picker as the privacy switch is toggled. */
export function attachChannelPrivacyFields(root: HTMLElement): () => void {
  const toggle = root.querySelector('#input-channel-private') as HTMLInputElement | null;
  const rolesGroup = root.querySelector('#channel-roles-group') as HTMLElement | null;
  if (!toggle || !rolesGroup) return () => {};

  const sync = () => {
    rolesGroup.hidden = !toggle.checked;
  };
  toggle.addEventListener('change', sync);
  sync();

  // Returned so the caller can detach on close and avoid leaking the listener.
  return () => toggle.removeEventListener('change', sync);
}

export function readChannelPrivacyFields(root: HTMLElement): ChannelPrivacySelection {
  const toggle = root.querySelector('#input-channel-private') as HTMLInputElement | null;
  const isPrivate = !!toggle?.checked;
  if (!isPrivate) return { isPrivate: false, allowedRoleIds: [] };

  const checked = Array.from(
    root.querySelectorAll('.channel-role-checkbox:checked')
  ) as HTMLInputElement[];

  return { isPrivate: true, allowedRoleIds: checked.map((input) => input.value) };
}

/**
 * The channel type picker, one option per row (#384).
 *
 * The radio input itself is visually hidden and the whole row becomes the
 * control, which frees room for a title and a line explaining what each type is
 * actually for — a bare radio next to a single word did not.
 */
export function renderChannelTypeFields(defaultType: 'TEXT' | 'VOICE'): string {
  const option = (
    value: 'TEXT' | 'VOICE',
    icon: string,
    iconColor: string,
    title: string,
    description: string
  ) => `
    <label class="channel-type-option">
      <input type="radio" name="channel-type" value="${value}" ${defaultType === value ? 'checked' : ''}>
      <span class="material-symbols-outlined md-20 channel-type-icon" style="color: ${iconColor};">${icon}</span>
      <span class="channel-type-text">
        <span class="channel-type-title">${title}</span>
        <span class="channel-type-desc">${description}</span>
      </span>
      <span class="material-symbols-outlined md-18 channel-type-check">check_circle</span>
    </label>`;

  return `
    <div class="form-group">
      <label>${t('channelModal.typeLabel')}</label>
      <div class="channel-type-options">
        ${option('TEXT', 'tag', 'var(--text-muted)', t('channelModal.typeText'), t('channelModal.typeTextDesc'))}
        ${option('VOICE', 'volume_up', 'var(--success)', t('channelModal.typeVoice'), t('channelModal.typeVoiceDesc'))}
      </div>
    </div>
  `;
}
