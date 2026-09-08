import { escapeHtml } from '../../../utils/html';
import { getAvatarUrl } from '../../../utils/avatar';
import { serverStore } from '../../../stores/serverStore';
import { t } from '../../../i18n';
import { LIMITS } from '@monky/shared';
import logoUrl from '../../../assets/Logo.png';
import {
  renderWhatPassesWhereTableHtml,
  renderCapacityEstimatorHtml,
  attachCapacityEstimatorEvents,
} from '../../../utils/voiceModeInfo';

export class ServerGeneralTab {
  /**
   * Registered members, which is what the cap counts (#403).
   *
   * `members` holds one entry per live connection, so it would double-count a
   * person signed in from two devices (#309); `knownMembers` is the persisted
   * list and is only absent when talking to a server that predates it.
   */
  private getMemberCount(): number {
    const s = serverStore.serverDetails;
    if (!s) return 0;
    if (s.knownMembers) return s.knownMembers.length;
    return new Set(s.members.map((m) => m.id)).size;
  }

  public renderHtml(pendingIconBase64?: string | null): string {
    const s = serverStore.serverDetails;
    if (!s) return '';

    const memberCount = this.getMemberCount();
    const hasLimit = (s.maxUsers ?? LIMITS.MAX_USERS_UNLIMITED) > LIMITS.MAX_USERS_UNLIMITED;
    // The field starts from a sensible number even when the limit is off, so
    // turning the switch on never shows an empty or invalid box.
    const limitValue = hasLimit ? s.maxUsers : Math.max(memberCount, LIMITS.MAX_USERS_DEFAULT);

    // Escaped like any other server-controlled string: it arrives over the wire
    // and is interpolated into HTML. A server that predates the field, or one
    // running from an untagged checkout, sends nothing and is labelled as such
    // instead of showing an empty row (#559).
    const serverVersion = s.version
      ? escapeHtml(s.version)
      : t('serverSettings.infoVersionUnknown');

    const iconSrc = pendingIconBase64 !== undefined
      ? (pendingIconBase64 ? getAvatarUrl(pendingIconBase64) : logoUrl)
      : (s.iconUrl ? getAvatarUrl(s.iconUrl) : logoUrl);

    return `
      <div style="display: flex; gap: 16px; align-items: center; padding: 14px; background: var(--bg-card); border-radius: var(--radius-md); margin-bottom: 16px; border: 1px solid var(--border-color);">
        <div id="server-icon-wrapper" class="settings-avatar-wrapper" style="border-radius: 12px; width: 64px; height: 64px; flex-shrink: 0;" title="${t('serverSettings.iconTitle')}">
          <img id="server-icon-preview" class="settings-avatar-img" style="border-radius: 10px; width: 64px; height: 64px; object-fit: cover;" src="${iconSrc}" alt="${t('serverSettings.iconAlt')}">
          <div class="settings-avatar-overlay" style="border-radius: 10px;">
            <span class="material-symbols-outlined md-20">photo_camera</span>
          </div>
        </div>
        <div style="flex: 1; min-width: 0;">
          <div class="form-group" style="margin-bottom: 0;">
            <label style="margin-bottom: 4px;">${t('serverSettings.nameLabel')}</label>
            <div class="input-with-emoji-container">
              <input id="input-server-name" type="text" value="${escapeHtml(s.name)}" required minlength="2" maxlength="50" style="padding-right: 36px;">
              <button type="button" id="btn-emoji-server-name" class="btn-input-emoji" title="${t('chat.emojiPickerTitle')}">
                <span class="material-symbols-outlined md-18">sentiment_satisfied</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px; margin-bottom: 16px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div>
            <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px;">${t('serverSettings.memberLimitLabel')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${t('serverSettings.memberLimitDesc')}</div>
          </div>
          <label class="toggle-switch">
            <input id="checkbox-limit-members" type="checkbox" ${hasLimit ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div id="max-users-group" class="form-group" style="margin-top: 12px; margin-bottom: 0;" ${hasLimit ? '' : 'hidden'}>
          <label style="margin-bottom: 4px;">${t('serverSettings.memberLimitValueLabel')}</label>
          <input id="input-max-users" type="number" min="1" step="1" value="${limitValue}">
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
            ${t('serverSettings.memberLimitHint', { count: memberCount })}
          </div>
        </div>
      </div>

      <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px; margin-bottom: 16px;">
        <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">hub</span>
          <span>${t('serverSettings.voiceModeLabel')}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">
          ${t('serverSettings.voiceModeDesc')}
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;" id="server-voice-mode-cards">
          <div class="voice-mode-card ${(s.voiceMode || 'p2p') === 'p2p' ? 'selected' : ''}" data-mode="p2p" style="padding: 12px 14px; border: 1.5px solid ${(s.voiceMode || 'p2p') === 'p2p' ? 'var(--accent-primary)' : 'var(--border-color)'}; background: ${(s.voiceMode || 'p2p') === 'p2p' ? 'rgba(88, 101, 242, 0.1)' : 'var(--bg-card-secondary)'}; border-radius: var(--radius-md); cursor: pointer; transition: all 0.15s ease;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
              <span class="material-symbols-outlined md-18" style="color: ${(s.voiceMode || 'p2p') === 'p2p' ? 'var(--accent-primary)' : 'var(--text-muted)'};">wifi_tethering</span>
              <span style="font-size: 13px; font-weight: 600; color: var(--text-primary);">${t('serverSettings.voiceModeP2pTitle')}</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); line-height: 1.4;">${t('serverSettings.voiceModeP2pDesc')}</div>
          </div>
          <div class="voice-mode-card ${s.voiceMode === 'sfu' ? 'selected' : ''}" data-mode="sfu" style="padding: 12px 14px; border: 1.5px solid ${s.voiceMode === 'sfu' ? 'var(--accent-primary)' : 'var(--border-color)'}; background: ${s.voiceMode === 'sfu' ? 'rgba(88, 101, 242, 0.1)' : 'var(--bg-card-secondary)'}; border-radius: var(--radius-md); cursor: pointer; transition: all 0.15s ease;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
              <span class="material-symbols-outlined md-18" style="color: ${s.voiceMode === 'sfu' ? 'var(--accent-primary)' : 'var(--text-muted)'};">hub</span>
              <span style="font-size: 13px; font-weight: 600; color: var(--text-primary);">${t('serverSettings.voiceModeSfuTitle')}</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); line-height: 1.4;">${t('serverSettings.voiceModeSfuDesc')}</div>
          </div>
        </div>
        <input type="hidden" id="input-server-voice-mode" value="${s.voiceMode || 'p2p'}" />

        ${renderWhatPassesWhereTableHtml()}
        ${renderCapacityEstimatorHtml('general')}
      </div>

      <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
        <div style="font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">info</span>
          <span>${t('serverSettings.generalInfo')}</span>
        </div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; font-size: 12px; color: var(--text-secondary);">
          <div><strong>${t('serverSettings.infoChannels')}:</strong> ${s.channels.length}</div>
          <div><strong>${t('serverSettings.infoMembers')}:</strong> ${memberCount}</div>
          <div style="grid-column: span 2;"><strong>${t('serverSettings.infoVersion')}:</strong> ${serverVersion}</div>
          <div style="grid-column: span 2; font-size: 11px; color: var(--text-muted); word-break: break-all;"><strong>${t('serverSettings.infoId')}:</strong> ${s.id}</div>
        </div>
      </div>
    `;
  }

  /**
   * Shows the number box only while the limit is switched on (#403), and hands
   * back a detach function so the modal does not leak the listener on close.
   */
  public attach(root: HTMLElement): () => void {
    const toggle = root.querySelector('#checkbox-limit-members') as HTMLInputElement | null;
    const group = root.querySelector('#max-users-group') as HTMLElement | null;

    const sync = () => {
      if (toggle && group) group.hidden = !toggle.checked;
    };
    if (toggle && group) {
      toggle.addEventListener('change', sync);
      sync();
    }

    const voiceCards = root.querySelectorAll('#server-voice-mode-cards .voice-mode-card');
    const hiddenVoiceMode = root.querySelector('#input-server-voice-mode') as HTMLInputElement | null;

    const cardCleanups: Array<() => void> = [];
    voiceCards.forEach((card) => {
      const listener = () => {
        const mode = (card as HTMLElement).dataset.mode;
        if (!mode) return;
        if (hiddenVoiceMode) hiddenVoiceMode.value = mode;

        voiceCards.forEach((c) => {
          const isSelected = (c as HTMLElement).dataset.mode === mode;
          c.classList.toggle('selected', isSelected);
          (c as HTMLElement).style.borderColor = isSelected ? 'var(--accent-primary)' : 'var(--border-color)';
          (c as HTMLElement).style.background = isSelected ? 'rgba(88, 101, 242, 0.1)' : 'var(--bg-card-secondary)';
          const icon = c.querySelector('.material-symbols-outlined') as HTMLElement | null;
          if (icon) icon.style.color = isSelected ? 'var(--accent-primary)' : 'var(--text-muted)';
        });
      };
      card.addEventListener('click', listener);
      cardCleanups.push(() => card.removeEventListener('click', listener));
    });

    // Specs come from the machine running the server, which is usually not this
    // one — an admin configuring a VPS from their desktop was being shown their
    // own hardware (#515).
    const cleanupCapacity = attachCapacityEstimatorEvents(
      root,
      'general',
      serverStore.serverDetails?.hostSpecs ?? null
    );

    return () => {
      if (toggle && group) toggle.removeEventListener('change', sync);
      cardCleanups.forEach((cleanup) => cleanup());
      cleanupCapacity();
    };
  }
}
