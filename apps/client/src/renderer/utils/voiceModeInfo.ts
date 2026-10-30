import { CapacityEstimator, CapacityEstimate, HostSpecs, type VoiceMode } from '@monky/shared';
import { t } from '../i18n';
import { renderChoiceCards } from './formControls';
import type { SafeHtml } from './html';

/** The P2P or SFU choice: the same cards when a server is created and in its settings. */
export function renderVoiceModeCards(id: string, selected: VoiceMode): SafeHtml {
  return renderChoiceCards({
    id, label: t('serverSettings.voiceModeLabel'), attribute: 'data-mode', selected,
    choices: [
      { value: 'p2p', icon: 'wifi_tethering', title: t('serverSettings.voiceModeP2pTitle'), description: t('serverSettings.voiceModeP2pDesc') },
      { value: 'sfu', icon: 'hub', title: t('serverSettings.voiceModeSfuTitle'), description: t('serverSettings.voiceModeSfuDesc') },
    ],
  });
}

export function renderWhatPassesWhereTableHtml(): string {
  return `
    <details style="font-size: 11px; color: var(--text-muted); cursor: pointer; margin-top: 10px;">
      <summary style="font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">
        ${t('serverSettings.whatPassesWhereTitle')}
      </summary>
      <div style="overflow-x: auto; background: var(--bg-tertiary); border-radius: var(--radius-sm); border: 1px solid var(--border-color); padding: 6px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-primary);">
              <th style="padding: 6px 8px; font-weight: 600;">${t('voiceMode.tableDataCol')}</th>
              <th style="padding: 6px 8px; font-weight: 600;">${t('voiceMode.tableP2pCol')}</th>
              <th style="padding: 6px 8px; font-weight: 600;">${t('voiceMode.tableSfuCol')}</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">🎤 ${t('voiceMode.rowAudio')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.directPeers')}</td>
              <td style="padding: 6px 8px; color: var(--accent-primary); font-weight: 500;">${t('voiceMode.viaServer')}</td>
            </tr>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">📹 ${t('voiceMode.rowVideo')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.directPeers')}</td>
              <td style="padding: 6px 8px; color: var(--accent-primary); font-weight: 500;">${t('voiceMode.viaServer')}</td>
            </tr>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">🖥️ ${t('voiceMode.rowScreen')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.directPeers')}</td>
              <td style="padding: 6px 8px; color: var(--accent-primary); font-weight: 500;">${t('voiceMode.viaServer')}</td>
            </tr>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">💬 ${t('voiceMode.rowChat')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.viaServer')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.viaServer')}</td>
            </tr>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">📎 ${t('voiceMode.rowAttachments')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.storedServer')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.storedServer')}</td>
            </tr>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">🔗 ${t('voiceMode.rowSignaling')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.viaServer')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.viaServer')}</td>
            </tr>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">👤 ${t('voiceMode.rowProfiles')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.storedServer')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.storedServer')}</td>
            </tr>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">⚙️ ${t('voiceMode.rowConfig')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.storedServer')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.storedServer')}</td>
            </tr>
            <tr>
              <td style="padding: 6px 8px; font-weight: 500; color: var(--text-secondary);">🟢 ${t('voiceMode.rowPresence')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.viaServer')}</td>
              <td style="padding: 6px 8px; color: var(--text-muted);">${t('voiceMode.viaServer')}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  `;
}

export function renderCapacityEstimatorHtml(prefix = 'general'): string {
  return `
    <div id="${prefix}-capacity-container" style="background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px; margin-top: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-primary);">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">speed</span>
          <span>${t('capacity.title')}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted);">
          <span>${t('capacity.uploadSpeed')}:</span>
          <select id="${prefix}-select-capacity-upload" style="background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;">
            <option value="50">50 Mbps</option>
            <option value="100" selected>100 Mbps</option>
            <option value="300">300 Mbps</option>
            <option value="500">500 Mbps</option>
            <option value="1000">1 Gbps</option>
          </select>
        </div>
      </div>

      <div id="${prefix}-capacity-result" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px; text-align: center;">
        <!-- Filled dynamically -->
      </div>

      <div id="${prefix}-capacity-summary" style="font-size: 11px; color: var(--text-muted); line-height: 1.4; padding-top: 4px; border-top: 1px dashed var(--border-color);">
        <!-- Filled dynamically -->
      </div>
    </div>
  `;
}

/**
 * @param hostSpecs CPU and RAM reported by the server that will run the SFU.
 *   Falls back to `navigator` only when the server did not send them, which
 *   describes the local machine and is therefore right just while hosting
 *   locally — and even then RAM is capped at 8 GB by the Device Memory
 *   spec, so the reading is flagged as approximate (#515).
 */
export function attachCapacityEstimatorEvents(
  root: HTMLElement,
  prefix = 'general',
  hostSpecs?: HostSpecs | null
): () => void {
  const select = root.querySelector(`#${prefix}-select-capacity-upload`) as HTMLSelectElement | null;
  const resultContainer = root.querySelector(`#${prefix}-capacity-result`) as HTMLElement | null;
  const summaryContainer = root.querySelector(`#${prefix}-capacity-summary`) as HTMLElement | null;

  if (!select || !resultContainer || !summaryContainer) {
    return () => {};
  }

  const fromServer = Boolean(hostSpecs);
  const cores =
    hostSpecs?.cpuCores ??
    (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
  const ramGb =
    hostSpecs?.ramTotalGb ??
    (typeof navigator !== 'undefined' && (navigator as any).deviceMemory ? (navigator as any).deviceMemory : 8);

  const update = () => {
    const uploadMbps = parseInt(select.value, 10) || 100;
    const est: CapacityEstimate = CapacityEstimator.estimate(uploadMbps, cores, ramGb);

    resultContainer.innerHTML = `
      <div style="background: var(--bg-card); padding: 8px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
        <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 2px;">🎙️ ${t('capacity.voiceUsers')}</div>
        <div style="font-size: 14px; font-weight: 700; color: var(--text-primary);">~${est.maxAudioParticipants}</div>
        <div style="font-size: 9px; color: var(--text-muted);">${t('capacity.usersUnit')}</div>
      </div>

      <div style="background: var(--bg-card); padding: 8px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
        <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 2px;">🖥️ ${t('capacity.screenUsers')}</div>
        <div style="font-size: 14px; font-weight: 700; color: var(--accent-primary);">~${est.maxScreenShareParticipants}</div>
        <div style="font-size: 9px; color: var(--text-muted);">${t('capacity.viewersUnit')}</div>
      </div>

      <div style="background: var(--bg-card); padding: 8px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
        <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 2px;">🛡️ ${t('capacity.recommendedMax')}</div>
        <div style="font-size: 14px; font-weight: 700; color: var(--success, #23a55a);">~${est.recommendedMaxUsers}</div>
        <div style="font-size: 9px; color: var(--text-muted);">${t('capacity.usersUnit')}</div>
      </div>
    `;

    summaryContainer.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
        <span style="font-weight: 600; color: var(--text-secondary);">
          ${t('capacity.specs', { cores: String(cores), ram: String(ramGb) })}
        </span>
      </div>
      <div>${t('capacity.summary', {
        cores: String(cores),
        ram: String(ramGb),
        upload: String(uploadMbps),
        screen: String(est.maxScreenShareParticipants),
        voice: String(est.maxAudioParticipants),
      })}</div>
      <div style="margin-top: 4px; font-style: italic;">
        ${fromServer ? t('capacity.sourceServer') : t('capacity.sourceLocalApprox')}
      </div>
    `;
  };

  select.addEventListener('change', update);
  update();

  return () => {
    select.removeEventListener('change', update);
  };
}
