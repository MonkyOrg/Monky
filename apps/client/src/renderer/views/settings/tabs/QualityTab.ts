import { QUALITY_PRESETS, QualityPresetType, QualityProfile } from '@monky/shared';
import { settingsStore } from '../../../stores/settingsStore';
import { webRtcManager } from '../../../core/WebRtcManager';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import {
  ASPECT_RATIO_GROUPS,
  AUDIO_BITRATE_OPTIONS,
  AspectRatioGroup,
  CUSTOM_OPTION,
  FPS_OPTIONS,
  VIDEO_BITRATE_OPTIONS,
  aspectRatioGroup,
  aspectRatioIdFor,
  closestResolution,
  formatResolution,
} from '../qualityOptions';

export class QualityTab {
  public renderHtml(): string {
    return `
      <!-- Quality Preset -->
      <div class="form-group">
        <label data-settings-section="quality-preset" data-settings-label="${escapeHtml(t('settings.qualitySection'))}" style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">speed</span>
          ${t('settings.qualitySection')}
          <span class="material-symbols-outlined md-16" style="color: var(--text-muted); cursor: help;" title="${t('settings.qualityHelp')}">help</span>
        </label>
        <select id="select-preset">
          <option value="ECONOMIC" ${settingsStore.qualityPreset === 'ECONOMIC' ? 'selected' : ''}>${t('settings.presetEconomic')}</option>
          <option value="NORMAL" ${settingsStore.qualityPreset === 'NORMAL' ? 'selected' : ''}>${t('settings.presetNormal')}</option>
          <option value="HIGH" ${settingsStore.qualityPreset === 'HIGH' ? 'selected' : ''}>${t('settings.presetHigh')}</option>
          <option value="GAMING" ${settingsStore.qualityPreset === 'GAMING' ? 'selected' : ''}>${t('settings.presetGaming')}</option>
          <option value="ULTRA" ${settingsStore.qualityPreset === 'ULTRA' ? 'selected' : ''}>${t('settings.presetUltra')}</option>
          <option value="CUSTOM" ${settingsStore.qualityPreset === 'CUSTOM' ? 'selected' : ''}>${t('settings.presetCustom')}</option>
        </select>
        <div id="preset-details" style="margin-top: 8px; padding: 10px 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          ${this.getPresetDetailsHtml(settingsStore.qualityPreset)}
        </div>
        <small style="display: block; margin-top: 6px; color: var(--text-muted); font-size: 11px;">
          ${t('settings.qualityFootnote')}
        </small>
        <small style="display: block; margin-top: 4px; color: var(--accent-primary); font-size: 11px;">
          <span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">bolt</span>
          ${t('settings.qualityInstantApply')}
        </small>
      </div>

      <!-- Preferred Video Codec -->
      <div data-settings-section="video-codec" data-settings-label="${escapeHtml(t('settings.videoCodecSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;" for="select-video-codec">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">movie</span>
          ${t('settings.videoCodecSection')}
          <span class="material-symbols-outlined md-16" style="color: var(--text-muted); cursor: help;" title="${t('settings.videoCodecHelp')}">help</span>
        </label>
        <select id="select-video-codec">
          <option value="auto" ${settingsStore.preferredVideoCodec === 'auto' ? 'selected' : ''}>${t('settings.codecAuto')}</option>
          <option value="av1" ${settingsStore.preferredVideoCodec === 'av1' ? 'selected' : ''}>${t('settings.codecAv1')}</option>
          <option value="vp9" ${settingsStore.preferredVideoCodec === 'vp9' ? 'selected' : ''}>${t('settings.codecVp9')}</option>
          <option value="vp8" ${settingsStore.preferredVideoCodec === 'vp8' ? 'selected' : ''}>${t('settings.codecVp8')}</option>
          <option value="h264" ${settingsStore.preferredVideoCodec === 'h264' ? 'selected' : ''}>${t('settings.codecH264')}</option>
        </select>
        <small style="display: block; margin-top: 6px; color: var(--text-muted); font-size: 11px;">
          ${t('settings.videoCodecDesc')}
        </small>
      </div>
    `;
  }

  public getPresetDetailsHtml(preset: QualityPresetType): string {
    const p: QualityProfile = preset === 'CUSTOM' ? settingsStore.customProfile : QUALITY_PRESETS[preset];
    const totalMbps = Math.round((p.audioBitrateKbps + p.cameraBitrateKbps + p.screenBitrateKbps) / 100) / 10;

    if (preset === 'CUSTOM') {
      return `
        <div style="font-size: 12px;">
          <div class="quality-custom-block" data-settings-section="custom-audio" data-settings-label="${escapeHtml(t('settings.audio'))}">
            <div class="quality-custom-title">
              <span class="material-symbols-outlined" style="font-size: 16px; color: var(--accent-primary);">mic</span>
              <strong style="color: var(--text-secondary);">${t('settings.audio')}</strong>
            </div>
            ${this.renderNumberChoice('audioBitrate', t('settings.bitrate'), AUDIO_BITRATE_OPTIONS, p.audioBitrateKbps, 'kbps')}
          </div>
          <div class="quality-custom-block" data-settings-section="custom-camera" data-settings-label="${escapeHtml(t('settings.cameraShort'))}">
            <div class="quality-custom-title">
              <span class="material-symbols-outlined" style="font-size: 16px; color: var(--accent-primary);">videocam</span>
              <strong style="color: var(--text-secondary);">${t('settings.cameraShort')}</strong>
            </div>
            ${this.renderMediaFields('camera', p.cameraWidth, p.cameraHeight, p.cameraFps, p.cameraBitrateKbps)}
          </div>
          <div class="quality-custom-block" data-settings-section="custom-screen" data-settings-label="${escapeHtml(t('settings.screen'))}">
            <div class="quality-custom-title">
              <span class="material-symbols-outlined" style="font-size: 16px; color: var(--accent-primary);">screen_share</span>
              <strong style="color: var(--text-secondary);">${t('settings.screen')}</strong>
            </div>
            ${this.renderMediaFields('screen', p.screenWidth, p.screenHeight, p.screenFps, p.screenBitrateKbps)}
          </div>
          <div style="display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 11px;">
            <span class="material-symbols-outlined" style="font-size: 16px;">speed</span>
            ${t('settings.maxBandwidth', { value: totalMbps })}
          </div>
        </div>
        <p style="margin: 8px 0 0; font-size: 11px; color: var(--text-muted);">
          ${t('settings.bitrateCeilingNote')}
        </p>
      `;
    }

    const row = (icon: string, label: string, value: string) => `
      <div style="display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">
        <span class="material-symbols-outlined" style="font-size: 16px; color: var(--accent-primary); flex-shrink: 0;">${icon}</span>
        <span style="color: var(--text-secondary); min-width: 70px;">${label}</span>
        <span style="color: var(--text-primary); font-weight: 500;">${value}</span>
      </div>`;

    return `
      <div style="font-size: 12px; line-height: 1.5;">
        ${row('mic', t('settings.audio'), `${p.audioBitrateKbps} kbps`)}
        ${row('videocam', t('settings.cameraShort'), `${p.cameraWidth}×${p.cameraHeight} &nbsp;│&nbsp; ${p.cameraFps} fps &nbsp;│&nbsp; ${p.cameraBitrateKbps} kbps`)}
        ${row('screen_share', t('settings.screen'), `${p.screenWidth}×${p.screenHeight} &nbsp;│&nbsp; ${p.screenFps} fps &nbsp;│&nbsp; ${p.screenBitrateKbps} kbps`)}
        ${row('speed', t('settings.maxBandwidthLabel'), `~${totalMbps} Mbps`)}
      </div>
      <p style="margin: 8px 0 0; font-size: 11px; color: var(--text-muted);">
        ${t('settings.bitrateCeilingNote')}
      </p>
    `;
  }

  /**
   * A dropdown of common values plus a "custom" entry that reveals the plain
   * number box the tab used to show for everything (#476).
   *
   * The free-form box sits on its own row instead of beside the dropdown so
   * every row keeps the same three columns and nothing shifts sideways when a
   * field is switched to custom.
   */
  private renderNumberChoice(id: string, label: string, options: number[], value: number, unit: string): string {
    const isKnown = options.includes(value);
    return `
      <div class="quality-custom-row">
        <label class="quality-custom-label" for="q-select-${id}">${label}</label>
        <select id="q-select-${id}" class="quality-custom-control">
          ${options.map((option) => `<option value="${option}" ${option === value ? 'selected' : ''}>${option}${unit ? ` ${unit}` : ''}</option>`).join('')}
          <option value="${CUSTOM_OPTION}" ${isKnown ? '' : 'selected'}>${t('settings.optionCustom')}</option>
        </select>
        <span class="quality-custom-unit"></span>
      </div>
      <div class="quality-custom-row" id="q-custom-${id}" ${isKnown ? 'hidden' : ''}>
        <span class="quality-custom-label"></span>
        <input id="custom-${id}" type="number" min="1" value="${value}" class="quality-custom-control">
        <span class="quality-custom-unit">${unit}</span>
      </div>
    `;
  }

  /** Resolution (with aspect-ratio picker), FPS and bitrate of one media kind (#476). */
  private renderMediaFields(kind: 'camera' | 'screen', width: number, height: number, fps: number, bitrate: number): string {
    const aspectId = aspectRatioIdFor(width, height);
    const group = aspectRatioGroup(aspectId);
    const isKnownResolution = group.resolutions.some((r) => r.width === width && r.height === height);

    return `
      <div class="quality-custom-row">
        <label class="quality-custom-label" for="q-aspect-${kind}">${t('settings.aspectRatio')}</label>
        <select id="q-aspect-${kind}" class="quality-custom-control">
          ${ASPECT_RATIO_GROUPS.map((item) => `<option value="${item.id}" ${item.id === aspectId ? 'selected' : ''}>${item.label}</option>`).join('')}
        </select>
        <span class="quality-custom-unit"></span>
      </div>
      <div class="quality-custom-row">
        <label class="quality-custom-label" for="q-res-${kind}">${t('settings.resolution')}</label>
        <select id="q-res-${kind}" class="quality-custom-control">
          ${this.renderResolutionOptions(group, width, height)}
        </select>
        <span class="quality-custom-unit"></span>
      </div>
      <div class="quality-custom-row" id="q-res-${kind}-custom" ${isKnownResolution ? 'hidden' : ''}>
        <span class="quality-custom-label"></span>
        <div class="quality-custom-pair">
          <input id="custom-${kind}Width" type="number" min="1" value="${width}" title="${t('settings.width')}" aria-label="${t('settings.width')}">
          <span class="quality-custom-times">×</span>
          <input id="custom-${kind}Height" type="number" min="1" value="${height}" title="${t('settings.height')}" aria-label="${t('settings.height')}">
        </div>
        <span class="quality-custom-unit">px</span>
      </div>
      ${this.renderNumberChoice(`${kind}Fps`, 'FPS', FPS_OPTIONS, fps, 'fps')}
      ${this.renderNumberChoice(`${kind}Bitrate`, t('settings.bitrate'), VIDEO_BITRATE_OPTIONS, bitrate, 'kbps')}
    `;
  }

  private renderResolutionOptions(group: AspectRatioGroup, width: number, height: number): string {
    const isKnown = group.resolutions.some((r) => r.width === width && r.height === height);
    return `
      ${group.resolutions.map((option) => `<option value="${option.width}x${option.height}" ${option.width === width && option.height === height ? 'selected' : ''}>${formatResolution(option)}</option>`).join('')}
      <option value="${CUSTOM_OPTION}" ${isKnown ? '' : 'selected'}>${t('settings.optionCustom')}</option>
    `;
  }

  public attachEvents(container: HTMLElement): void {
    const selectPreset = container.querySelector<HTMLSelectElement>('#select-preset');
    const presetDetails = container.querySelector<HTMLElement>('#preset-details');

    selectPreset?.addEventListener('change', () => {
      const val = selectPreset.value as QualityPresetType;
      settingsStore.qualityPreset = val;
      settingsStore.save();
      webRtcManager.setQualityPreset(val);
      if (presetDetails) {
        presetDetails.innerHTML = this.getPresetDetailsHtml(val);
        if (val === 'CUSTOM') {
          this.attachCustomProfileListeners(container);
        }
      }
    });

    const selectCodec = container.querySelector<HTMLSelectElement>('#select-video-codec');
    selectCodec?.addEventListener('change', () => {
      const val = selectCodec.value as any;
      settingsStore.preferredVideoCodec = val;
      settingsStore.save();
      void webRtcManager.reapplyCodecPreferences();
    });

    if (settingsStore.qualityPreset === 'CUSTOM') {
      this.attachCustomProfileListeners(container);
    }
  }

  private attachCustomProfileListeners(container: HTMLElement): void {
    const apply = () => {
      settingsStore.save();
      webRtcManager.setQualityPreset('CUSTOM');
    };

    const setValue = <K extends keyof QualityProfile>(key: K, value: number) => {
      if (typeof settingsStore.customProfile[key] !== 'number') return;
      (settingsStore.customProfile[key] as number) = value;
    };

    // The free-form number box behind each "custom" entry.
    const bindInput = <K extends keyof QualityProfile>(id: string, key: K) => {
      const input = container.querySelector<HTMLInputElement>(`#custom-${id}`);
      input?.addEventListener('change', () => {
        const val = parseInt(input.value, 10);
        if (isNaN(val) || val <= 0) return;
        setValue(key, val);
        apply();
      });
    };

    // The dropdown of common values. Picking "custom" only reveals the box —
    // the stored value stays untouched until the user actually types one (#476).
    const bindSelect = <K extends keyof QualityProfile>(id: string, key: K) => {
      const select = container.querySelector<HTMLSelectElement>(`#q-select-${id}`);
      const customRow = container.querySelector<HTMLElement>(`#q-custom-${id}`);
      const input = container.querySelector<HTMLInputElement>(`#custom-${id}`);
      select?.addEventListener('change', () => {
        if (select.value === CUSTOM_OPTION) {
          if (customRow) customRow.hidden = false;
          input?.focus();
          return;
        }
        if (customRow) customRow.hidden = true;
        const val = parseInt(select.value, 10);
        if (isNaN(val) || val <= 0) return;
        setValue(key, val);
        apply();
      });
    };

    const bindResolution = (kind: 'camera' | 'screen') => {
      const widthKey = (kind === 'camera' ? 'cameraWidth' : 'screenWidth') as keyof QualityProfile;
      const heightKey = (kind === 'camera' ? 'cameraHeight' : 'screenHeight') as keyof QualityProfile;
      const aspectSelect = container.querySelector<HTMLSelectElement>(`#q-aspect-${kind}`);
      const resSelect = container.querySelector<HTMLSelectElement>(`#q-res-${kind}`);
      const customRow = container.querySelector<HTMLElement>(`#q-res-${kind}-custom`);

      resSelect?.addEventListener('change', () => {
        if (resSelect.value === CUSTOM_OPTION) {
          if (customRow) customRow.hidden = false;
          return;
        }
        if (customRow) customRow.hidden = true;
        const [width, height] = resSelect.value.split('x').map((part) => parseInt(part, 10));
        if (isNaN(width) || isNaN(height)) return;
        setValue(widthKey, width);
        setValue(heightKey, height);
        apply();
      });

      aspectSelect?.addEventListener('change', () => {
        const group = aspectRatioGroup(aspectSelect.value);
        // Switching the aspect ratio snaps to the entry closest in height, so
        // the user keeps roughly the same quality instead of being thrown to
        // the top of the new list.
        const currentHeight = settingsStore.customProfile[heightKey] as number;
        const target = closestResolution(group, currentHeight);
        if (resSelect) {
          resSelect.innerHTML = this.renderResolutionOptions(group, target.width, target.height);
        }
        if (customRow) customRow.hidden = true;
        setValue(widthKey, target.width);
        setValue(heightKey, target.height);
        apply();
      });
    };

    bindSelect('audioBitrate', 'audioBitrateKbps');
    bindInput('audioBitrate', 'audioBitrateKbps');
    bindSelect('cameraFps', 'cameraFps');
    bindInput('cameraFps', 'cameraFps');
    bindSelect('cameraBitrate', 'cameraBitrateKbps');
    bindInput('cameraBitrate', 'cameraBitrateKbps');
    bindSelect('screenFps', 'screenFps');
    bindInput('screenFps', 'screenFps');
    bindSelect('screenBitrate', 'screenBitrateKbps');
    bindInput('screenBitrate', 'screenBitrateKbps');
    bindInput('cameraWidth', 'cameraWidth');
    bindInput('cameraHeight', 'cameraHeight');
    bindInput('screenWidth', 'screenWidth');
    bindInput('screenHeight', 'screenHeight');
    bindResolution('camera');
    bindResolution('screen');
  }
}
