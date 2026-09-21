import { QUALITY_PRESETS, QualityPresetType, QualityProfile } from '@monky/shared';
import { settingsStore } from '../../../stores/settingsStore';
import { webRtcManager } from '../../../core/WebRtcManager';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { showAlert } from '../../Dialog';
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
  private eventController: AbortController | null = null;
  private customProfileController: AbortController | null = null;

  private codecSelection(): string {
    const codec = settingsStore.preferredVideoCodec;
    return codec === 'auto' || codec === 'h264' || codec === 'av1' ? codec : '';
  }

  private settingsError(error: unknown): void {
    console.warn('[QualityTab] Could not apply screen sharing settings:', error);
    void showAlert({ variant: 'danger', message: error instanceof Error ? error.message : t('screenShare.nativeProfileChangeBlocked') });
  }

  public renderHtml(): string {
    const unavailableCodec = settingsStore.preferredVideoCodec !== 'auto' && settingsStore.preferredVideoCodec !== 'h264';
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
        <select id="select-video-codec" aria-describedby="screen-codec-description screen-codec-preference-notice">
          ${this.codecSelection() === '' ? `<option value="" disabled selected>${escapeHtml(t('settings.codecSelectAvailable'))}</option>` : ''}
          <option value="auto" ${settingsStore.preferredVideoCodec === 'auto' ? 'selected' : ''}>${t('settings.codecAuto')}</option>
          <option value="h264" ${settingsStore.preferredVideoCodec === 'h264' ? 'selected' : ''}>${t('settings.codecH264')}</option>
          <option value="av1" disabled ${settingsStore.preferredVideoCodec === 'av1' ? 'selected' : ''}>${t('settings.codecAv1')} · ${t('screenShare.comingSoon')}</option>
        </select>
        <small id="screen-codec-description" style="display: block; margin-top: 6px; color: var(--text-muted); font-size: 11px;">
          ${t('settings.videoCodecDesc')}
        </small>
        <p id="screen-codec-preference-notice" role="status" ${unavailableCodec ? '' : 'hidden'}>${unavailableCodec
          ? escapeHtml(t('settings.codecPreferenceUnavailable', { codec: settingsStore.preferredVideoCodec.toUpperCase() })) : ''}</p>
      </div>

      <div data-settings-section="screen-preview" data-settings-label="${escapeHtml(t('settings.screenPreviewSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div>
            <label for="checkbox-screen-preview-focus" style="cursor: pointer;">${t('settings.screenPreviewPauseLabel')}</label>
            <small id="screen-preview-focus-description" style="display: block; color: var(--text-muted);">${t('settings.screenPreviewPauseDesc')}</small>
          </div>
          <label class="toggle-switch" aria-label="${escapeHtml(t('settings.screenPreviewPauseLabel'))}">
            <input id="checkbox-screen-preview-focus" type="checkbox" aria-describedby="screen-preview-focus-description" ${settingsStore.screenSharePreviewPauseWhenUnfocused ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div data-settings-section="video-telemetry" data-settings-label="${escapeHtml(t('settings.telemetrySection'))}" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 13px; font-weight: 700; color: var(--text-primary);">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);" aria-hidden="true">monitoring</span>
          ${t('settings.telemetrySection')}
        </div>
        <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: 12px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label style="margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-screen-telemetry">${t('settings.telemetryLabel')}</label>
              <div style="font-size: 11px; color: var(--text-muted);">${t('settings.telemetryDesc')}</div>
            </div>
            <label class="toggle-switch" aria-label="${escapeHtml(t('settings.telemetryLabel'))}">
              <input id="checkbox-screen-telemetry" type="checkbox" ${settingsStore.screenShareTelemetryEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="form-group" style="margin-bottom: 12px;">
          <label for="select-screen-telemetry-position">${t('settings.telemetryPosition')}</label>
          <select id="select-screen-telemetry-position">
            <option value="top-right" ${settingsStore.screenShareTelemetryPosition === 'top-right' ? 'selected' : ''}>${t('settings.positionTopRight')}</option>
            <option value="top-left" ${settingsStore.screenShareTelemetryPosition === 'top-left' ? 'selected' : ''}>${t('settings.positionTopLeft')}</option>
            <option value="bottom-right" ${settingsStore.screenShareTelemetryPosition === 'bottom-right' ? 'selected' : ''}>${t('settings.positionBottomRight')}</option>
            <option value="bottom-left" ${settingsStore.screenShareTelemetryPosition === 'bottom-left' ? 'selected' : ''}>${t('settings.positionBottomLeft')}</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label for="select-screen-telemetry-mode">${t('settings.telemetryMode')}</label>
          <select id="select-screen-telemetry-mode">
            <option value="simple" ${settingsStore.screenShareTelemetryMode === 'simple' ? 'selected' : ''}>${t('settings.telemetryModeSimple')}</option>
            <option value="complete" ${settingsStore.screenShareTelemetryMode === 'complete' ? 'selected' : ''}>${t('settings.telemetryModeComplete')}</option>
          </select>
          <small style="display: block; margin-top: 6px; color: var(--text-muted);">${t('settings.telemetryHelp')}</small>
        </div>
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
            ${this.renderNumberChoice('audioBitrate', t('settings.bitrate'), AUDIO_BITRATE_OPTIONS, p.audioBitrateKbps, 'kbps', 'audio')}
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
  private renderNumberChoice(
    id: string, label: string, options: number[], value: number, unit: string,
    bitrateHelp?: 'audio' | 'camera' | 'screen',
  ): string {
    const isKnown = options.includes(value);
    const mediaLabel = bitrateHelp === 'audio' ? t('settings.audio')
      : bitrateHelp === 'camera' ? t('settings.cameraShort') : t('settings.screen');
    const help = bitrateHelp ? `
      <button type="button" class="quality-bitrate-help" data-bitrate-help="${bitrateHelp}"
        aria-label="${escapeHtml(t('settings.bitrateHelpLabel', { media: mediaLabel }))}"
        data-tooltip="${escapeHtml(t(bitrateHelp === 'audio' ? 'settings.audioBitrateHelp' : 'settings.videoBitrateHelp'))}">
        <span class="material-symbols-outlined md-16" aria-hidden="true">help</span>
      </button>` : '';
    return `
      <div class="quality-custom-row">
        <div class="quality-custom-label quality-label-with-help">
          <label for="q-select-${id}">${label}</label>
          ${help}
        </div>
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
      ${this.renderNumberChoice(`${kind}Bitrate`, t('settings.bitrate'), VIDEO_BITRATE_OPTIONS, bitrate, 'kbps', kind)}
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
    this.cleanup();
    this.eventController = new AbortController();
    const options = { signal: this.eventController.signal };
    const selectPreset = container.querySelector<HTMLSelectElement>('#select-preset');
    const presetDetails = container.querySelector<HTMLElement>('#preset-details');
    const checkboxPreviewFocus = container.querySelector<HTMLInputElement>('#checkbox-screen-preview-focus');
    const checkboxScreenTelemetry = container.querySelector<HTMLInputElement>('#checkbox-screen-telemetry');
    const selectScreenTelemetryPos = container.querySelector<HTMLSelectElement>('#select-screen-telemetry-position');
    const selectScreenTelemetryMode = container.querySelector<HTMLSelectElement>('#select-screen-telemetry-mode');

    checkboxPreviewFocus?.addEventListener('change', () => {
      settingsStore.screenSharePreviewPauseWhenUnfocused = checkboxPreviewFocus.checked;
      settingsStore.save();
    }, options);
    checkboxScreenTelemetry?.addEventListener('change', () => {
      settingsStore.screenShareTelemetryEnabled = checkboxScreenTelemetry.checked;
      settingsStore.save();
    }, options);
    selectScreenTelemetryPos?.addEventListener('change', () => {
      const position = selectScreenTelemetryPos.value;
      if (position === 'top-right' || position === 'top-left' || position === 'bottom-right' || position === 'bottom-left') {
        settingsStore.screenShareTelemetryPosition = position;
        settingsStore.save();
      } else {
        console.warn('[QualityTab] Invalid telemetry position:', position);
      }
    }, options);
    selectScreenTelemetryMode?.addEventListener('change', () => {
      const mode = selectScreenTelemetryMode.value;
      if (mode === 'simple' || mode === 'complete') {
        settingsStore.screenShareTelemetryMode = mode;
        settingsStore.save();
      } else {
        console.warn('[QualityTab] Invalid telemetry mode:', mode);
      }
    }, options);

    selectPreset?.addEventListener('change', () => {
      const choices: QualityPresetType[] = ['ECONOMIC', 'NORMAL', 'HIGH', 'GAMING', 'ULTRA', 'CUSTOM'];
      const val = choices.find(choice => choice === selectPreset.value);
      if (!val) {
        console.warn('[QualityTab] Invalid quality preset:', selectPreset.value);
        selectPreset.value = settingsStore.qualityPreset;
        return;
      }
      try { webRtcManager.assertScreenSharingSettings(val === 'CUSTOM' ? settingsStore.customProfile : QUALITY_PRESETS[val]); }
      catch (error) { selectPreset.value = settingsStore.qualityPreset; this.settingsError(error); return; }
      settingsStore.qualityPreset = val;
      settingsStore.save();
      webRtcManager.setQualityPreset(val);
      this.customProfileController?.abort();
      this.customProfileController = null;
      if (presetDetails) {
        presetDetails.innerHTML = this.getPresetDetailsHtml(val);
        if (val === 'CUSTOM') {
          this.attachCustomProfileListeners(container);
        }
      }
    }, options);

    const selectCodec = container.querySelector<HTMLSelectElement>('#select-video-codec');
    selectCodec?.addEventListener('change', () => {
      const val = (['auto', 'h264'] as const).find(choice => choice === selectCodec.value);
      if (!val) {
        console.warn('[QualityTab] Invalid video codec:', selectCodec.value);
        selectCodec.value = this.codecSelection();
        this.settingsError(new Error(t('screenShare.codecsSoon')));
        return;
      }
      const profile = settingsStore.qualityPreset === 'CUSTOM' ? settingsStore.customProfile : QUALITY_PRESETS[settingsStore.qualityPreset];
      try { webRtcManager.assertScreenSharingSettings(profile, val); }
      catch (error) { selectCodec.value = this.codecSelection(); this.settingsError(error); return; }
      settingsStore.preferredVideoCodec = val;
      settingsStore.save();
      selectCodec.querySelector('option[value=""]')?.remove();
      const notice = container.querySelector<HTMLElement>('#screen-codec-preference-notice');
      if (notice) { notice.hidden = true; notice.textContent = ''; }
      void webRtcManager.reapplyCodecPreferences().catch(error => {
        if (!options.signal.aborted) this.settingsError(error);
      });
    }, options);

    if (settingsStore.qualityPreset === 'CUSTOM') {
      this.attachCustomProfileListeners(container);
    }
  }

  private attachCustomProfileListeners(container: HTMLElement): void {
    this.customProfileController?.abort();
    this.customProfileController = new AbortController();
    const options = { signal: this.customProfileController.signal };
    let previousProfile = { ...settingsStore.customProfile };
    const apply = () => {
      try { webRtcManager.assertScreenSharingSettings(settingsStore.customProfile); }
      catch (error) {
        settingsStore.customProfile = { ...previousProfile };
        const details = container.querySelector<HTMLElement>('#preset-details');
        if (details) {
          details.innerHTML = this.getPresetDetailsHtml('CUSTOM');
          this.attachCustomProfileListeners(container);
        }
        this.settingsError(error);
        return;
      }
      settingsStore.save();
      webRtcManager.setQualityPreset('CUSTOM');
      previousProfile = { ...settingsStore.customProfile };
    };

    const setValue = <K extends keyof QualityProfile>(key: K, value: number) => {
      if (typeof settingsStore.customProfile[key] !== 'number') return;
      settingsStore.customProfile = { ...settingsStore.customProfile, [key]: value };
    };

    // The free-form number box behind each "custom" entry.
    const bindInput = <K extends keyof QualityProfile>(id: string, key: K) => {
      const input = container.querySelector<HTMLInputElement>(`#custom-${id}`);
      input?.addEventListener('change', () => {
        const val = parseInt(input.value, 10);
        if (isNaN(val) || val <= 0) return;
        setValue(key, val);
        apply();
      }, options);
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
      }, options);
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
      }, options);

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
      }, options);
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

  public cleanup(): void {
    this.eventController?.abort();
    this.eventController = null;
    this.customProfileController?.abort();
    this.customProfileController = null;
  }
}
