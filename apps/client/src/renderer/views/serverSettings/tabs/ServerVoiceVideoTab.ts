import { serverStore } from '../../../stores/serverStore';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

/**
 * Why the relay toggle is unusable on this server, or null when it works.
 *
 * An absent `turnAvailability` means the server is older than the relay
 * feature: it silently ignores the field, so saving would appear to do nothing
 * at all. That case gets its own message instead of being lumped in with an
 * unsupported host (#429).
 *
 * A missing coturn is *not* blocking when the server can install it by itself
 * — switching the relay on is what triggers the installation (#431).
 */
function turnBlockedReason(): string | null {
  // Checked before host support: in SFU mode the server already forwards every
  // stream, so a second relay is pointless no matter what the host can run.
  // The server refuses the combination too, and a toggle that reports success
  // while being rejected would be worse than one that is visibly off (#515).
  if (serverStore.serverDetails?.voiceMode === 'sfu') {
    return t('serverSettings.turnBlockedBySfu');
  }
  const availability = serverStore.serverDetails?.turnAvailability;
  if (!availability) return t('serverSettings.turnUnknownSupport');
  if (availability.supported) return null;
  if (availability.reason === 'not-installed') {
    return availability.autoInstallable ? null : t('serverSettings.turnNotInstalled');
  }
  return t('serverSettings.turnUnsupportedPlatform');
}

/** Heads-up shown when switching the relay on will install coturn first. */
function turnInstallNotice(): string | null {
  const availability = serverStore.serverDetails?.turnAvailability;
  if (!availability || availability.supported) return null;
  return availability.reason === 'not-installed' && availability.autoInstallable
    ? t('serverSettings.turnWillInstall')
    : null;
}

export class ServerVoiceVideoTab {
  public renderHtml(): string {
    const s = serverStore.serverDetails;
    if (!s) return '';

    const turnBlocked = turnBlockedReason();
    const turnNotice = turnBlocked ? null : turnInstallNotice();

    return `
      <div data-settings-section="soundboard" data-settings-label="${escapeHtml(t('serverSettings.allowSoundboard'))}" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-card); padding: 12px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        <div>
          <label for="checkbox-allow-soundboard" style="font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 2px;">
            <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">music_note</span>
            <span>${t('serverSettings.allowSoundboard')}</span>
          </label>
          <div style="font-size: 11px; color: var(--text-muted);">
            ${t('serverSettings.allowSoundboardDesc')}
          </div>
        </div>
        <label class="toggle-switch" aria-label="${t('serverSettings.allowSoundboard')}">
          <input id="checkbox-allow-soundboard" type="checkbox" ${s.allowSoundboard !== false ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div data-settings-section="turn-relay" data-settings-label="${escapeHtml(t('serverSettings.turnEnabled'))}" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-card); padding: 12px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 10px; ${turnBlocked ? 'opacity: 0.6;' : ''}">
        <div>
          <label for="checkbox-turn-enabled" style="font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; cursor: ${turnBlocked ? 'not-allowed' : 'pointer'}; margin-bottom: 2px;">
            <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">swap_horiz</span>
            <span>${t('serverSettings.turnEnabled')}</span>
          </label>
          <div style="font-size: 11px; color: var(--text-muted);">
            ${t('serverSettings.turnEnabledDesc')}
          </div>
          ${turnBlocked ? `<div style="font-size: 11px; color: var(--warning); margin-top: 4px; display: flex; align-items: center; gap: 4px;">
            <span class="material-symbols-outlined md-14">info</span>
            <span>${turnBlocked}</span>
          </div>` : ''}
          ${turnNotice ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; display: flex; align-items: center; gap: 4px;">
            <span class="material-symbols-outlined md-14">download</span>
            <span>${turnNotice}</span>
          </div>` : ''}
        </div>
        <label class="toggle-switch" aria-label="${t('serverSettings.turnEnabled')}"${turnBlocked ? ` title="${turnBlocked}"` : ''}>
          <input id="checkbox-turn-enabled" type="checkbox" ${s.turnEnabled ? 'checked' : ''}${turnBlocked ? ' disabled' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
  }
}
