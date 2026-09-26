import { QUALITY_PRESETS, QualityPresetType, QualityProfile, NATIVE_SCREEN_VIDEO_LIMITS, type NativeScreenVideoProfile } from '@monky/shared';
import { settingsStore } from '../../../stores/settingsStore';
import { webRtcManager } from '../../../core/WebRtcManager';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import {
  CUSTOM_QUALITY_FIELDS, customQualityBounds, normalizeCustomQualityProfile, type QualityNumberKey,
} from '../../../utils/qualityProfileLimits';
import { showAlert } from '../../Dialog';
import { showInfoToast } from '../../CopyToast';
import { ScreenEncodingControls } from '../../ScreenEncodingControls';
import { nativeScreenProfile } from '../../../core/webrtc/NativeScreenController';
import {
  ASPECT_RATIO_GROUPS,
  AUDIO_BITRATE_OPTIONS,
  AspectRatioGroup,
  CUSTOM_OPTION,
  FPS_OPTIONS,
  SCREEN_BITRATE_OPTIONS,
  aspectRatioGroup,
  aspectRatioIdFor,
  closestResolution,
  formatResolution,
} from '../qualityOptions';

export class QualityTab {
  private eventController: AbortController | null = null;
  private customProfileController: AbortController | null = null;
  private clearQualityToast: (() => void) | null = null;
  private container: HTMLElement | null = null;
  private requestedQuality: { preset: QualityPresetType; profile: QualityProfile } | null = null;
  private appliedEncoding = '';
  private readonly encoding = new ScreenEncodingControls(() => nativeScreenProfile(this.qualityProfile()),
    undefined, profile => this.applyCompatibleProfile(profile), () => this.rejectQualityRequest());

  private qualityProfile(): QualityProfile {
    return this.requestedQuality?.profile ?? (settingsStore.qualityPreset === 'CUSTOM'
      ? settingsStore.customProfile : QUALITY_PRESETS[settingsStore.qualityPreset]);
  }

  private encodingKey(): string {
    return JSON.stringify([settingsStore.screenEncodingStrategy,
      settingsStore.screenEncodingMode, settingsStore.preferredScreenCodec]);
  }

  private requestQualityChanges(preset: QualityPresetType, profile: QualityProfile): void {
    this.requestedQuality = { preset, profile };
    void this.encoding.refresh(true);
  }

  private renderQualityDetails(): void {
    const container = this.container;
    if (!container) return;
    const preset = this.requestedQuality?.preset ?? settingsStore.qualityPreset;
    const select = container.querySelector<HTMLSelectElement>('#select-preset');
    if (select) select.value = preset;
    const details = container.querySelector<HTMLElement>('#preset-details');
    this.customProfileController?.abort();
    this.customProfileController = null;
    if (details) {
      const focused = document.activeElement;
      const focusId = focused instanceof HTMLElement && details.contains(focused) ? focused.id : '';
      details.innerHTML = this.getPresetDetailsHtml(preset);
      if (preset === 'CUSTOM') this.attachCustomProfileListeners(container);
      if (focusId) details.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`)?.focus();
    }
  }

  private rejectQualityRequest(): void {
    if (!this.requestedQuality) return;
    this.requestedQuality = null;
    this.renderQualityDetails();
  }

  private commitQualityChanges(preset: QualityPresetType, customProfile?: QualityProfile, persist = true): void {
    const previousPreset = settingsStore.qualityPreset, previousCustom = settingsStore.customProfile;
    const profile = preset === 'CUSTOM' ? customProfile ?? previousCustom : QUALITY_PRESETS[preset];
    webRtcManager.assertScreenSharingSettings(profile);
    settingsStore.qualityPreset = preset;
    if (customProfile) settingsStore.customProfile = customProfile;
    try { webRtcManager.setQualityPreset(preset); }
    catch (error) {
      settingsStore.qualityPreset = previousPreset;
      settingsStore.customProfile = previousCustom;
      throw error;
    }
    if (persist) settingsStore.save();
    void this.encoding.refresh();
  }

  private applyCompatibleProfile(profile: NativeScreenVideoProfile): void {
    if (!this.container || this.eventController?.signal.aborted) throw new Error('Quality settings were closed.');
    const previous = this.qualityProfile();
    const adjusted = previous.screenFps !== profile.fps;
    if (!this.requestedQuality && !adjusted && this.appliedEncoding === this.encodingKey()) return;
    const preset = adjusted ? 'CUSTOM' : this.requestedQuality?.preset ?? settingsStore.qualityPreset;
    const persist = !!this.requestedQuality || adjusted;
    const encoding = this.encodingKey();
    this.requestedQuality = null;
    try {
      this.commitQualityChanges(preset, preset === 'CUSTOM' ? { ...previous, screenFps: profile.fps } : undefined, persist);
      this.appliedEncoding = encoding;
    } catch (error) {
      this.renderQualityDetails();
      throw error;
    }
    if (adjusted) this.renderQualityDetails();
  }

  private settingsError(error: unknown): void {
    console.warn('[QualityTab] Could not apply screen sharing settings:', error);
    const safeMessages = [t('screenShare.nativeProfileChangeBlocked'), t('screenShare.nativeCodecChangeBlocked')];
    const message = error instanceof Error && safeMessages.includes(error.message)
      ? error.message : t('settings.screenEncodingAdjustmentBlocked');
    void showAlert({ variant: 'danger', message });
  }

  public renderHtml(): string {
    return `
      ${ScreenEncodingControls.html()}
      <div data-settings-section="screen-receiver" data-settings-label="${escapeHtml(t('settings.screenReceiverSection'))}" class="form-group">
        <label>${t('settings.screenReceiverSection')}</label>
        <div class="input-mode-cards" role="group" aria-label="${escapeHtml(t('settings.screenReceiverSection'))}" aria-describedby="screen-receiver-warning screen-receiver-apply">
          <button type="button" class="voice-mode-card input-mode-card" id="screen-receiver-native"
            aria-pressed="${settingsStore.getScreenShareReceiver() === 'native'}" ${settingsStore.nativeScreenReceiverComingSoon ? 'disabled' : ''}>
            <span class="input-mode-card-title">${t('settings.screenReceiverNative')}${settingsStore.nativeScreenReceiverComingSoon ? ` · ${t('screenShare.comingSoon')}` : ''}</span>
            <span class="input-mode-card-description">${t(settingsStore.nativeScreenReceiverComingSoon ? 'settings.screenReceiverMac' : 'settings.screenReceiverNativeDesc')}</span>
          </button>
          <button type="button" class="voice-mode-card input-mode-card" id="screen-receiver-chromium"
            aria-pressed="${settingsStore.getScreenShareReceiver() === 'chromium'}">
            <span class="input-mode-card-title">Chromium</span>
            <span class="input-mode-card-description">${t('settings.screenReceiverChromiumDesc')}</span>
          </button>
        </div>
        <p id="screen-receiver-warning" class="audio-device-status" role="note" style="color: var(--warning);">${t('settings.screenReceiverWarning')}</p>
        <p id="screen-receiver-apply" class="audio-device-status">${t('settings.screenReceiverApply')}</p>
      </div>

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
    const p: QualityProfile = this.requestedQuality?.preset === preset ? this.requestedQuality.profile
      : preset === 'CUSTOM' ? settingsStore.customProfile : QUALITY_PRESETS[preset];
    const totalMbps = Math.round((p.audioBitrateKbps + p.cameraBitrateKbps + p.screenBitrateKbps) / 100) / 10;

    if (preset === 'CUSTOM') {
      return `
        <div style="font-size: 12px;">
          <div class="quality-custom-block" data-settings-section="custom-audio" data-settings-label="${escapeHtml(t('settings.audio'))}">
            <div class="quality-custom-title">
              <span class="material-symbols-outlined" style="font-size: 16px; color: var(--accent-primary);">mic</span>
              <strong style="color: var(--text-secondary);">${t('settings.audio')}</strong>
            </div>
            ${this.renderNumberChoice('audioBitrateKbps', t('settings.bitrate'), AUDIO_BITRATE_OPTIONS, p.audioBitrateKbps, 'kbps', 'audio')}
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
    key: QualityNumberKey, label: string, options: number[], value: number, unit: string,
    bitrateHelp?: 'audio' | 'camera' | 'screen',
  ): string {
    const id = key.replace('Kbps', '');
    const { min, max, step } = customQualityBounds(key, this.qualityProfile());
    options = options.filter(option => option >= min && option <= max);
    const isKnown = options.includes(value);
    const mediaLabel = bitrateHelp === 'audio' ? t('settings.audio')
      : key.startsWith('camera') ? t('settings.cameraShort') : t('settings.screen');
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
        <input id="custom-${id}" type="number" inputmode="numeric" min="${min}" max="${max}" step="${step}"
          value="${value}" class="quality-custom-control" aria-label="${escapeHtml(`${mediaLabel} · ${label} (${unit})`)}">
        <span class="quality-custom-unit">${unit}</span>
      </div>
    `;
  }

  /** Resolution (with aspect-ratio picker), FPS and bitrate of one media kind (#476). */
  private renderMediaFields(kind: 'camera' | 'screen', width: number, height: number, fps: number, bitrate: number): string {
    const aspectId = aspectRatioIdFor(width, height);
    const group = this.mediaResolutionGroup(aspectId);
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
          <input id="custom-${kind}Width" type="number" inputmode="numeric" min="${kind === 'screen' ? 4 : 1}" max="${NATIVE_SCREEN_VIDEO_LIMITS.width}" step="1" value="${width}" title="${t('settings.width')}" aria-label="${t('settings.width')}">
          <span class="quality-custom-times">×</span>
          <input id="custom-${kind}Height" type="number" inputmode="numeric" min="${kind === 'screen' ? 2 : 1}" max="${NATIVE_SCREEN_VIDEO_LIMITS.height}" step="1" value="${height}" title="${t('settings.height')}" aria-label="${t('settings.height')}">
        </div>
        <span class="quality-custom-unit">px</span>
      </div>
      ${this.renderNumberChoice(`${kind}Fps`, 'FPS', FPS_OPTIONS, fps, 'fps')}
      ${this.renderNumberChoice(`${kind}BitrateKbps`, t('settings.bitrate'), SCREEN_BITRATE_OPTIONS, bitrate, 'kbps', kind)}
      ${kind === 'screen' ? `<p class="quality-custom-help">${escapeHtml(t('settings.screen4kLimits'))}</p>` : ''}
    `;
  }

  private mediaResolutionGroup(id: string): AspectRatioGroup {
    const group = aspectRatioGroup(id);
    return { ...group, resolutions: group.resolutions.filter(option =>
      option.width <= NATIVE_SCREEN_VIDEO_LIMITS.width && option.height <= NATIVE_SCREEN_VIDEO_LIMITS.height) };
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
    this.container = container;
    this.appliedEncoding = this.encodingKey();
    this.encoding.attach(container);
    const options = { signal: this.eventController.signal };
    const nativeReceiver = container.querySelector<HTMLButtonElement>('#screen-receiver-native');
    const chromiumReceiver = container.querySelector<HTMLButtonElement>('#screen-receiver-chromium');
    for (const receiver of ['native', 'chromium'] as const) {
      const button = receiver === 'native' ? nativeReceiver : chromiumReceiver;
      button?.addEventListener('click', () => {
        if (button.disabled) return;
        try {
          settingsStore.setScreenShareReceiver(receiver);
          nativeReceiver?.setAttribute('aria-pressed', String(settingsStore.getScreenShareReceiver() === 'native'));
          chromiumReceiver?.setAttribute('aria-pressed', String(settingsStore.getScreenShareReceiver() === 'chromium'));
        } catch (error) { this.settingsError(error); }
      }, options);
    }
    const selectPreset = container.querySelector<HTMLSelectElement>('#select-preset');
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
      this.requestQualityChanges(val, val === 'CUSTOM' ? settingsStore.customProfile : QUALITY_PRESETS[val]);
      this.clearQualityToast?.();
      this.clearQualityToast = null;
      this.renderQualityDetails();
    }, options);

    if (settingsStore.qualityPreset === 'CUSTOM') {
      this.attachCustomProfileListeners(container);
    }
  }

  private attachCustomProfileListeners(container: HTMLElement): void {
    this.customProfileController?.abort();
    this.customProfileController = new AbortController();
    const options = { signal: this.customProfileController.signal };
    let editedProfile = { ...this.qualityProfile() };
    const notify = (key: 'settings.qualityValueAdjusted' | 'settings.qualityValueInvalid' | null) => {
      this.clearQualityToast?.();
      this.clearQualityToast = key ? showInfoToast(t(key)) : null;
    };
    const syncInputs = () => {
      const profile = this.qualityProfile();
      for (const key of CUSTOM_QUALITY_FIELDS) {
        const id = key.replace('Kbps', '');
        const input = container.querySelector<HTMLInputElement>(`#custom-${id}`);
        const { min, max, step } = customQualityBounds(key, profile);
        if (input) {
          input.min = String(min);
          input.max = String(max);
          input.step = String(step);
          input.value = String(profile[key]);
        }
        if (key === 'cameraFps' || key === 'screenFps') {
          const select = container.querySelector<HTMLSelectElement>(`#q-select-${id}`);
          if (!select) continue;
          const custom = select.value === CUSTOM_OPTION;
          const value = profile[key];
          select.innerHTML = FPS_OPTIONS.filter(fps => fps <= max).map(fps =>
            `<option value="${fps}">${fps} fps</option>`).join('')
            + `<option value="${CUSTOM_OPTION}">${escapeHtml(t('settings.optionCustom'))}</option>`;
          select.value = custom || !FPS_OPTIONS.includes(value) ? CUSTOM_OPTION : String(value);
          const row = container.querySelector<HTMLElement>(`#q-custom-${id}`);
          if (row) row.hidden = select.value !== CUSTOM_OPTION;
        }
      }
    };
    const apply = () => {
      const requested = editedProfile;
      const normalized = normalizeCustomQualityProfile(requested);
      const adjusted = CUSTOM_QUALITY_FIELDS.some(key => normalized[key] !== requested[key]);
      editedProfile = normalized;
      notify(adjusted ? 'settings.qualityValueAdjusted' : null);
      this.requestQualityChanges('CUSTOM', normalized);
      syncInputs();
    };

    const setValue = (key: QualityNumberKey, value: number) => {
      editedProfile = { ...editedProfile, [key]: value };
    };

    // The free-form number box behind each "custom" entry.
    const bindInput = (id: string, key: QualityNumberKey) => {
      const input = container.querySelector<HTMLInputElement>(`#custom-${id}`);
      input?.addEventListener('change', () => {
        const val = input.valueAsNumber;
        if (!Number.isFinite(val)) {
          syncInputs();
          notify('settings.qualityValueInvalid');
          return;
        }
        setValue(key, val);
        apply();
      }, options);
    };

    // The dropdown of common values. Picking "custom" only reveals the box —
    // the stored value stays untouched until the user actually types one (#476).
    const bindSelect = (id: string, key: QualityNumberKey) => {
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
        const val = Number(select.value);
        if (!Number.isFinite(val) || val <= 0) {
          syncInputs();
          notify('settings.qualityValueInvalid');
          return;
        }
        setValue(key, val);
        apply();
      }, options);
    };

    const bindResolution = (kind: 'camera' | 'screen') => {
      const widthKey = kind === 'camera' ? 'cameraWidth' : 'screenWidth';
      const heightKey = kind === 'camera' ? 'cameraHeight' : 'screenHeight';
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
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          notify('settings.qualityValueInvalid');
          return;
        }
        setValue(widthKey, width);
        setValue(heightKey, height);
        apply();
      }, options);

      aspectSelect?.addEventListener('change', () => {
        const group = this.mediaResolutionGroup(aspectSelect.value);
        // Switching the aspect ratio snaps to the entry closest in height, so
        // the user keeps roughly the same quality instead of being thrown to
        // the top of the new list.
        const currentHeight = this.qualityProfile()[heightKey];
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
    this.requestedQuality = null;
    this.container = null;
    this.encoding.cleanup();
    this.clearQualityToast?.();
    this.clearQualityToast = null;
    this.eventController?.abort();
    this.eventController = null;
    this.customProfileController?.abort();
    this.customProfileController = null;
  }
}
