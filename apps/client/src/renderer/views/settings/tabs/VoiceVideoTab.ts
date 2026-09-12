import { settingsStore } from '../../../stores/settingsStore';
import { audioProcessor } from '../../../core/AudioProcessor';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { bindPttIndicators, renderPttIndicator } from '../../PttIndicator';
import { bindMicrophoneLevelMeter } from '../../../core/MicrophoneLevelMeter';
import { audioDeviceError, populateAudioDeviceSelect, selectAudioDevice, selectedAudioDevice } from '../../../core/AudioDeviceService';
import { MicrophoneTest } from '../../../core/MicrophoneTest';
import { NoiseSuppressionControl } from '../NoiseSuppressionControl';
import { AudioOutputControls } from '../AudioOutputControls';
import { CameraEffectsControl } from '../CameraEffectsControl';
import { populateCameraDeviceSelect } from '../CameraDeviceSelection';
import { appEvents } from '../../../core/EventBus';

export class VoiceVideoTab {
  private unbindVadMeter: (() => void) | null = null;
  private unbindPttCapture: (() => void) | null = null;
  private unbindPttInput: (() => void) | null = null;
  private isRecordingPtt = false;
  private cancelPttRecording: (() => void) | null = null;
  private unbindInputMode: Array<() => void> = [];
  private microphoneTest: MicrophoneTest | null = null;
  private noiseSuppressionControl = new NoiseSuppressionControl();
  private audioOutputControls = new AudioOutputControls();
  private cameraEffectsControl = new CameraEffectsControl();

  public renderHtml(): string {
    return `
      <!-- Device Header with Refresh Button -->
      <div data-settings-section="input-devices" data-settings-label="${escapeHtml(t('settings.devicesSection'))}" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.5px;">
          ${t('settings.devicesSection')}
        </span>
        <button id="btn-refresh-devices" class="btn btn-secondary" style="font-size: 11px; padding: 3px 8px; height: 26px;" title="${t('settings.refreshDevicesTitle')}">
          <span class="material-symbols-outlined md-14" style="margin-right: 4px;">refresh</span>
          ${t('settings.refreshDevices')}
        </button>
      </div>

      <!-- Audio Inputs -->
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">mic</span>
          ${t('settings.microphone')}
        </label>
        <select id="select-mic">
          <option value="">${t('settings.loadingMics')}</option>
        </select>
        <div id="mic-device-status" class="audio-device-status" role="status"></div>
      </div>

      <div class="form-group">
        <div class="microphone-test-row">
          <button id="btn-microphone-test" type="button" class="btn btn-secondary microphone-test-button" aria-pressed="false" aria-controls="microphone-test-meter" aria-describedby="microphone-test-hint microphone-test-status">
            ${t('settings.microphoneTestStart')}
          </button>
          <div id="microphone-test-meter" class="vad-meter microphone-test-meter" role="meter" aria-label="${t('settings.vadMeterTitle')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="vad-meter-fill"></div>
          </div>
        </div>
        <div id="microphone-test-hint" class="audio-device-status">${t('settings.microphoneTestHint')}</div>
        <div id="microphone-test-status" class="audio-device-status" role="status"></div>
      </div>

      <!-- Input Mode Selector (#186) -->
      <div data-settings-section="input-mode" data-settings-label="${escapeHtml(t('settings.inputMode'))}" class="form-group" style="margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">keyboard_voice</span>
          ${t('settings.inputMode')}
        </label>
        <div class="input-mode-cards" role="group" aria-label="${t('settings.inputMode')}">
          <button type="button" class="voice-mode-card input-mode-card" id="mode-card-vad" aria-pressed="${settingsStore.inputMode === 'voice_activity'}">
            <span class="input-mode-card-title"><span class="material-symbols-outlined md-18" aria-hidden="true">graphic_eq</span>${t('settings.inputModeVad')}</span>
            <span class="input-mode-card-description">${t('settings.inputModeVadDesc')}</span>
          </button>
          <button type="button" class="voice-mode-card input-mode-card" id="mode-card-ptt" aria-pressed="${settingsStore.inputMode === 'push_to_talk'}">
            <span class="input-mode-card-title"><span class="material-symbols-outlined md-18" aria-hidden="true">keyboard</span>${t('settings.inputModePtt')}</span>
            <span class="input-mode-card-description">${t('settings.inputModePttDesc')}</span>
          </button>
        </div>
      </div>

      <!-- VAD Sensitivity Container -->
      <div id="container-vad-settings" data-settings-section="sensitivity" data-settings-label="${escapeHtml(t('settings.vadLabel'))}" class="form-group" style="display: ${settingsStore.inputMode === 'voice_activity' ? 'block' : 'none'};">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">tune</span>
          ${t('settings.vadLabel')}
        </label>
        <div style="display: flex; align-items: center; gap: 12px;">
          <input id="slider-vad" class="sb-slider" type="range" min="0" max="160" value="${settingsStore.vadSensitivity}" style="--slider-progress: ${(Math.min(160, Math.max(0, settingsStore.vadSensitivity)) / 160) * 100}%; flex: 1;">
        </div>
        <div id="vad-meter" class="vad-meter" title="${t('settings.vadMeterTitle')}">
          <div id="vad-meter-fill" class="vad-meter-fill"></div>
          <div id="vad-meter-threshold" class="vad-meter-threshold"></div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.vadHint')}</div>
      </div>

      <!-- PTT Configuration Container (#186) -->
      <div id="container-ptt-settings" data-settings-section="push-to-talk" data-settings-label="${escapeHtml(t('settings.inputModePtt'))}" style="display: ${settingsStore.inputMode === 'push_to_talk' ? 'block' : 'none'}; margin-bottom: 14px;">
        ${renderPttIndicator()}
        <!-- Shortcut Key Card -->
        <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: 10px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; font-weight: 600;">
                <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">keyboard</span>
                ${t('settings.pttShortcut')}
              </label>
              <div id="ptt-key-desc" style="font-size: 11px; color: var(--text-muted);">
                ${t('settings.pttRecordShortcut')}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span id="ptt-key-badge" style="font-family: monospace; font-size: 12px; font-weight: 700; background: var(--bg-modifier-selected, rgba(255,255,255,0.08)); padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border-color); color: var(--text-primary); min-width: 48px; text-align: center;">
                ${settingsStore.pttKey?.display || 'V'}
              </span>
              <button id="btn-record-ptt-key" class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px; height: 28px;">
                ${t('settings.pttRecordShortcut')}
              </button>
            </div>
          </div>
        </div>

        <!-- Release Delay Slider -->
        <div class="form-group" style="margin-bottom: 10px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 0;">
              <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">timer</span>
              ${t('settings.pttReleaseDelay')}
            </label>
            <span id="ptt-delay-value" style="font-size: 11px; font-weight: 700; color: var(--accent-primary);">
              ${settingsStore.pttReleaseDelay} ms
            </span>
          </div>
          <input id="slider-ptt-delay" class="sb-slider" type="range" min="0" max="2000" step="50" value="${settingsStore.pttReleaseDelay}" style="--slider-progress: ${(Math.min(2000, Math.max(0, settingsStore.pttReleaseDelay)) / 2000) * 100}%; width: 100%;">
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
            ${t('settings.pttReleaseDelayDesc')}
          </div>
        </div>

        <!-- Sound Cue Toggle -->
        <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-ptt-sound">
                <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">volume_up</span>
                ${t('settings.pttSoundCue')}
              </label>
              <div style="font-size: 11px; color: var(--text-muted);">
                ${t('settings.pttSoundCueDesc')}
              </div>
            </div>
            <label class="toggle-switch" aria-label="${t('settings.pttSoundCue')}">
              <input id="checkbox-ptt-sound" type="checkbox" ${settingsStore.pttSoundCue ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      ${this.noiseSuppressionControl.renderHtml()}

      <!-- Audio Outputs -->
      <div class="form-group" id="group-speaker" data-settings-section="output-device" data-settings-label="${escapeHtml(t('audioOutputs.general'))}">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">headphones</span>
          ${t('audioOutputs.general')}
        </label>
        <select id="select-speaker">
          <option value="">${t('settings.loadingOutputs')}</option>
        </select>
        <div id="speaker-device-status" class="audio-device-status" role="status"></div>
      </div>
      ${this.audioOutputControls.renderHtml()}

      <!-- Camera Inputs -->
      <div class="form-group" id="group-camera" data-settings-section="camera" data-settings-label="${escapeHtml(t('settings.camera'))}" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">videocam</span>
          ${t('settings.camera')}
        </label>
        <select id="select-cam">
          <option value="">${t('settings.loadingCameras')}</option>
        </select>
        <div id="camera-device-status" class="audio-device-status" role="status"></div>
        ${this.cameraEffectsControl.renderHtml()}
      </div>

      <!-- Screen Share -->
      <div data-settings-section="screen-share" data-settings-label="${escapeHtml(t('settings.screenShareSection'))}" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <span style="font-size: 13px; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
            <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">screen_share</span>
            ${t('settings.screenShareSection')}
          </span>
        </div>

        <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: 12px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-screen-telemetry">
                <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">monitoring</span>
                ${t('settings.telemetryLabel')}
              </label>
              <div style="font-size: 11px; color: var(--text-muted);">
                ${t('settings.telemetryDesc')}
              </div>
            </div>
            <label class="toggle-switch" aria-label="${t('settings.telemetryLabel')}">
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
        </div>
      </div>
    `;
  }

  public attachEvents(container: HTMLElement): void {
    this.unbindInputMode.forEach((off) => off());
    this.unbindInputMode = [bindPttIndicators(container)];
    const testButton = container.querySelector<HTMLButtonElement>('#btn-microphone-test');
    const testMeter = container.querySelector<HTMLElement>('#microphone-test-meter');
    const testStatus = container.querySelector<HTMLElement>('#microphone-test-status');
    if (testButton && testMeter) {
      const microphoneTest = new MicrophoneTest(testMeter, (state) => {
        const active = state.status === 'starting' || state.status === 'playing';
        testButton.textContent = t(active ? 'settings.microphoneTestStop' : 'settings.microphoneTestStart');
        testButton.setAttribute('aria-pressed', String(active));
        if (!testStatus) return;
        if (state.status === 'error') {
          testStatus.textContent = state.error instanceof DOMException
            ? audioDeviceError(state.error) : t('settings.microphoneTestFailed');
        } else if (state.status === 'starting') testStatus.textContent = t('settings.microphoneTestStarting');
        else if (state.status === 'playing') testStatus.textContent = t('settings.microphoneTestPlaying');
        else if (state.reason === 'device-changed') testStatus.textContent = t('settings.microphoneTestDeviceChanged');
        else if (state.reason === 'disconnected') testStatus.textContent = t('settings.microphoneTestDisconnected');
        else testStatus.textContent = '';
      });
      this.microphoneTest = microphoneTest;
      const toggleTest = () => microphoneTest.toggle();
      testButton.addEventListener('click', toggleTest);
      this.unbindInputMode.push(() => {
        testButton.removeEventListener('click', toggleTest);
        microphoneTest.destroy();
        if (this.microphoneTest === microphoneTest) this.microphoneTest = null;
      });
    }
    const selectMic = container.querySelector<HTMLSelectElement>('#select-mic');
    const selectSpeaker = container.querySelector<HTMLSelectElement>('#select-speaker');
    const selectCam = container.querySelector<HTMLSelectElement>('#select-cam');
    const sliderVad = container.querySelector<HTMLInputElement>('#slider-vad');
    this.noiseSuppressionControl.attachEvents(container);
    this.audioOutputControls.attachEvents(container);
    this.cameraEffectsControl.attachEvents(container);
    const btnRefreshDevices = container.querySelector<HTMLButtonElement>('#btn-refresh-devices');
    const checkboxScreenTelemetry = container.querySelector<HTMLInputElement>('#checkbox-screen-telemetry');
    const selectScreenTelemetryPos = container.querySelector<HTMLSelectElement>('#select-screen-telemetry-position');
    const selectScreenTelemetryMode = container.querySelector<HTMLSelectElement>('#select-screen-telemetry-mode');

    // Input mode cards keep the same persisted modes without native radios.
    const containerVad = container.querySelector<HTMLElement>('#container-vad-settings');
    const containerPtt = container.querySelector<HTMLElement>('#container-ptt-settings');
    const modeCardVad = container.querySelector<HTMLElement>('#mode-card-vad');
    const modeCardPtt = container.querySelector<HTMLElement>('#mode-card-ptt');

    for (const [mode, card] of [['voice_activity', modeCardVad], ['push_to_talk', modeCardPtt]] as const) {
      const selectMode = () => {
        if (settingsStore.inputMode === mode) return;
        settingsStore.inputMode = mode;
        settingsStore.save();
        if (containerVad) containerVad.style.display = mode === 'voice_activity' ? 'block' : 'none';
        if (containerPtt) containerPtt.style.display = mode === 'push_to_talk' ? 'block' : 'none';
        modeCardVad?.setAttribute('aria-pressed', String(mode === 'voice_activity'));
        modeCardPtt?.setAttribute('aria-pressed', String(mode === 'push_to_talk'));
      };
      card?.addEventListener('click', selectMode);
      this.unbindInputMode.push(() => card?.removeEventListener('click', selectMode));
    }

    // PTT Release Delay Slider
    const sliderPttDelay = container.querySelector<HTMLInputElement>('#slider-ptt-delay');
    const pttDelayValue = container.querySelector<HTMLElement>('#ptt-delay-value');
    sliderPttDelay?.addEventListener('input', () => {
      const val = parseInt(sliderPttDelay.value, 10);
      sliderPttDelay.style.setProperty('--slider-progress', `${(Math.min(2000, Math.max(0, val)) / 2000) * 100}%`);
      if (pttDelayValue) pttDelayValue.textContent = `${val} ms`;
      settingsStore.pttReleaseDelay = val;
      settingsStore.save();
    });

    // PTT Sound Cue Checkbox
    const checkboxPttSound = container.querySelector<HTMLInputElement>('#checkbox-ptt-sound');
    checkboxPttSound?.addEventListener('change', () => {
      settingsStore.pttSoundCue = checkboxPttSound.checked;
      settingsStore.save();
    });

    // PTT Record Key Button
    const btnRecordPtt = container.querySelector<HTMLButtonElement>('#btn-record-ptt-key');
    const pttBadge = container.querySelector<HTMLElement>('#ptt-key-badge');
    const pttDesc = container.querySelector<HTMLElement>('#ptt-key-desc');

    const stopPttRecording = (waitForKeyUp = false) => {
      this.isRecordingPtt = false;
      if (!waitForKeyUp) this.unbindPttInput?.();
      if (this.unbindPttCapture) {
        this.unbindPttCapture();
        this.unbindPttCapture = null;
      }
      if (window.api?.stopPttCapture) {
        void window.api.stopPttCapture().catch((error) => {
          console.warn('[VoiceVideoTab] Could not stop PTT capture:', error);
        });
      }
      if (btnRecordPtt) {
        btnRecordPtt.textContent = t('settings.pttRecordShortcut');
        btnRecordPtt.classList.remove('btn-primary');
      }
      if (pttDesc) {
        pttDesc.textContent = t('settings.pttRecordShortcut');
      }
      if (pttBadge) {
        pttBadge.textContent = settingsStore.pttKey?.display || 'V';
      }
    };
    this.cancelPttRecording = stopPttRecording;

    btnRecordPtt?.addEventListener('click', () => {
      if (this.isRecordingPtt) {
        stopPttRecording();
        return;
      }

      this.isRecordingPtt = true;
      btnRecordPtt.textContent = t('settings.pttRecordingPrompt');
      btnRecordPtt.classList.add('btn-primary');
      if (pttDesc) {
        pttDesc.textContent = t('settings.pttRecordingPrompt');
      }

      const failed = (error?: unknown) => {
        console.warn('[VoiceVideoTab] Native PTT capture unavailable:', error);
        stopPttRecording();
        if (pttDesc) pttDesc.textContent = t('keybinds.hookUnavailable');
      };
      if (!window.api?.startPttCapture || !window.api?.onPttCaptured) {
        failed();
        return;
      }

      this.unbindPttInput?.();
      let keyDownSeen = false;
      let keyReleased = false;
      const blockInput = (event: KeyboardEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'keydown') keyDownSeen = true;
        else {
          keyReleased = keyDownSeen;
          if (!this.isRecordingPtt) unblockInput();
        }
      };
      const unblockInput = () => {
        window.removeEventListener('keydown', blockInput, true);
        window.removeEventListener('keyup', blockInput, true);
        window.removeEventListener('blur', unblockInput);
        if (this.unbindPttInput === unblockInput) this.unbindPttInput = null;
      };
      this.unbindPttInput = unblockInput;
      window.addEventListener('keydown', blockInput, true);
      window.addEventListener('keyup', blockInput, true);
      window.addEventListener('blur', unblockInput);

      // DOM codes (KeyM) are not native codes (M + keyCode); let the worker
      // finish capture instead of overwriting its result with a faster DOM event.
      const unbind = window.api.onPttCaptured((binding) => {
        if (!this.isRecordingPtt || this.unbindPttCapture !== unbind) return;
        settingsStore.pttKey = binding;
        settingsStore.save();
        // Keep Space/Enter from also activating the focused record button.
        stopPttRecording(binding.keyType === 'keyboard' && !keyReleased && document.hasFocus());
      });
      this.unbindPttCapture = unbind;
      void window.api.startPttCapture().then((ok) => {
        if (!ok && this.unbindPttCapture === unbind) failed();
      }).catch((error) => {
        if (this.unbindPttCapture === unbind) failed(error);
      });
    });

    const selectionAbort = new AbortController();
    this.unbindInputMode.push(() => selectionAbort.abort());
    this.unbindInputMode.push(appEvents.on('settings.updated', () => {
      if (!selectCam || selectCam.value === settingsStore.selectedCameraId) return;
      if (Array.from(selectCam.options).some((option) => option.value === settingsStore.selectedCameraId)) {
        selectCam.value = settingsStore.selectedCameraId;
        const status = container.querySelector<HTMLElement>('#camera-device-status');
        if (status) status.textContent = selectCam.selectedOptions[0]?.disabled ? t('audioDevices.unavailableDevice') : '';
      } else void this.refreshDevices(container);
    }));
    let displayedSpeaker = selectedAudioDevice('output');
    this.unbindInputMode.push(appEvents.on('settings.updated', () => {
      const speaker = selectedAudioDevice('output');
      if (!selectSpeaker || speaker === displayedSpeaker) return;
      displayedSpeaker = speaker;
      const value = speaker === 'default' ? '' : speaker;
      if (Array.from(selectSpeaker.options).some((option) => option.value === value)) selectSpeaker.value = value;
      else void this.refreshDevices(container);
      const status = container.querySelector<HTMLElement>('#speaker-device-status');
      if (status) status.textContent = '';
    }));
    for (const [kind, select, statusId] of [
      ['input', selectMic, '#mic-device-status'],
      ['output', selectSpeaker, '#speaker-device-status'],
    ] as const) {
      const change = async () => {
        if (!select) return;
        this.microphoneTest?.stop('device-changed');
        const status = container.querySelector<HTMLElement>(statusId);
        select.disabled = true;
        if (status) status.textContent = '';
        try {
          await selectAudioDevice(kind, select.value, selectionAbort.signal);
        } catch (error) {
          select.value = selectedAudioDevice(kind) === 'default' ? '' : selectedAudioDevice(kind);
          if (status && !selectionAbort.signal.aborted) status.textContent = audioDeviceError(error);
        } finally {
          if (!selectionAbort.signal.aborted) select.disabled = false;
        }
      };
      select?.addEventListener('change', change);
      this.unbindInputMode.push(() => select?.removeEventListener('change', change));
    }
    const onDevices = () => { void this.refreshDevices(container); };
    navigator.mediaDevices?.addEventListener('devicechange', onDevices);
    this.unbindInputMode.push(() => navigator.mediaDevices?.removeEventListener('devicechange', onDevices));

    const changeCamera = async () => {
      if (!selectCam) return;
      const status = container.querySelector<HTMLElement>('#camera-device-status');
      selectCam.disabled = true;
      if (status) status.textContent = '';
      try {
        await this.cameraEffectsControl.changeDevice(selectCam.value);
      } finally {
        if (!selectionAbort.signal.aborted) {
          selectCam.value = settingsStore.selectedCameraId;
          selectCam.disabled = false;
        }
      }
    };
    selectCam?.addEventListener('change', changeCamera);
    this.unbindInputMode.push(() => selectCam?.removeEventListener('change', changeCamera));

    sliderVad?.addEventListener('input', () => {
      const val = parseInt(sliderVad.value, 10);
      sliderVad.style.setProperty('--slider-progress', `${(Math.min(160, Math.max(0, val)) / 160) * 100}%`);
      settingsStore.vadSensitivity = val;
      settingsStore.save();
      audioProcessor.setVadThreshold(val);
      this.updateVadThresholdLine(container, val);
    });

    btnRefreshDevices?.addEventListener('click', async () => {
      await this.refreshDevices(container);
    });

    checkboxScreenTelemetry?.addEventListener('change', () => {
      settingsStore.screenShareTelemetryEnabled = checkboxScreenTelemetry.checked;
      settingsStore.save();
    });

    selectScreenTelemetryPos?.addEventListener('change', () => {
      settingsStore.screenShareTelemetryPosition = selectScreenTelemetryPos.value as any;
      settingsStore.save();
    });

    selectScreenTelemetryMode?.addEventListener('change', () => {
      settingsStore.screenShareTelemetryMode = selectScreenTelemetryMode.value as any;
      settingsStore.save();
    });

    this.updateVadThresholdLine(container, settingsStore.vadSensitivity);
  }

  public async refreshDevices(container: HTMLElement): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const selectMic = container.querySelector<HTMLSelectElement>('#select-mic');
      const selectSpeaker = container.querySelector<HTMLSelectElement>('#select-speaker');
      const selectCam = container.querySelector<HTMLSelectElement>('#select-cam');

      this.audioOutputControls.refreshDevices(devices);

      if (selectMic) {
        const message = populateAudioDeviceSelect(selectMic, 'input', devices);
        const status = container.querySelector<HTMLElement>('#mic-device-status');
        if (status) status.textContent = message;
      }

      if (selectSpeaker) {
        const message = populateAudioDeviceSelect(selectSpeaker, 'output', devices);
        const status = container.querySelector<HTMLElement>('#speaker-device-status');
        if (status) status.textContent = message;
      }

      if (selectCam) {
        const message = populateCameraDeviceSelect(selectCam, devices);
        const status = container.querySelector<HTMLElement>('#camera-device-status');
        if (status) status.textContent = message;
      }
    } catch (e) {
      console.warn('[VoiceVideoTab] Error enumerating devices:', e);
      for (const id of ['#mic-device-status', '#speaker-device-status', '#camera-device-status']) {
        const status = container.querySelector<HTMLElement>(id);
        if (status) status.textContent = audioDeviceError(e);
      }
    }
  }

  private updateVadThresholdLine(container: HTMLElement, threshold: number): void {
    const line = container.querySelector<HTMLElement>('#vad-meter-threshold');
    if (line) {
      const pct = Math.min(100, Math.max(0, (threshold / 160) * 100));
      line.style.left = `${pct}%`;
    }
  }

  public startVadMeter(container: HTMLElement): void {
    this.stopVadMeter();
    const meter = container.querySelector<HTMLElement>('#vad-meter');
    if (!meter) return;
    meter.setAttribute('aria-label', t('settings.vadMeterTitle'));
    this.unbindVadMeter = bindMicrophoneLevelMeter(meter, (error) => {
      const status = container.querySelector<HTMLElement>('#mic-device-status');
      if (status) status.textContent = error ? audioDeviceError(error) : '';
    });
  }

  public stopVadMeter(): void {
    this.unbindVadMeter?.();
    this.unbindVadMeter = null;
  }

  public stopCameraPreview(_container?: HTMLElement): void {
    this.cameraEffectsControl.stopPreview();
  }

  public activateCameraPreview(): void {
    this.cameraEffectsControl.activate();
  }

  public deactivate(): void {
    this.microphoneTest?.stop();
    this.unbindPttInput?.();
    if (this.isRecordingPtt) this.cancelPttRecording?.();
    this.stopVadMeter();
    this.cameraEffectsControl.deactivate();
  }

  public cleanup(): void {
    this.deactivate();
    this.noiseSuppressionControl.cleanup();
    this.audioOutputControls.cleanup();
    this.cameraEffectsControl.cleanup();
    this.unbindInputMode.forEach((off) => off());
    this.unbindInputMode = [];
    this.cancelPttRecording = null;
  }
}
