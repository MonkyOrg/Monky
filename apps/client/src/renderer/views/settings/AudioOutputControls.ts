import { audioDeviceError, populateAudioDeviceSelect, selectAudioOutputPreferences } from '../../core/AudioDeviceService';
import { settingsStore } from '../../stores/settingsStore';
import { appEvents } from '../../core/EventBus';
import { t, type TranslationKey } from '../../i18n';
import {
  AUDIO_OUTPUT_CATEGORIES, copyAudioOutputPreferences, type AudioOutputCategory, type AudioOutputPreferences,
} from '../../utils/audioPreferences';

const labels: Record<AudioOutputCategory, TranslationKey> = {
  voice: 'audioOutputs.voice',
  screen: 'audioOutputs.screen',
  media: 'audioOutputs.media',
};

export class AudioOutputControls {
  private container: HTMLElement | null = null;
  private unbind: Array<() => void> = [];
  private busy = false;
  private devices: MediaDeviceInfo[] | null = null;

  public renderHtml(): string {
    return `
      <div class="form-group">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <label for="toggle-advanced-audio-outputs">${t('audioOutputs.advanced')}</label>
          <label class="toggle-switch" aria-label="${t('audioOutputs.advanced')}">
            <input id="toggle-advanced-audio-outputs" type="checkbox" aria-controls="advanced-audio-outputs" ${settingsStore.advancedAudioOutputs ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="audio-device-status">${t('audioOutputs.advancedHint')}</div>
        <div id="advanced-audio-outputs" ${settingsStore.advancedAudioOutputs ? '' : 'hidden'}>
          ${AUDIO_OUTPUT_CATEGORIES.map((category) => `
            <div class="form-group" style="margin-top:10px;">
              <label for="select-audio-output-${category}">${t(labels[category])}</label>
              <select id="select-audio-output-${category}" data-output-category="${category}" aria-describedby="audio-output-${category}-status">
                <option value="inherit">${t('audioOutputs.inherit')}</option>
              </select>
              <div id="audio-output-${category}-status" class="audio-device-status" role="status"></div>
            </div>
          `).join('')}
        </div>
        <div id="advanced-audio-output-status" class="audio-device-status" role="status"></div>
        <button id="reset-audio-outputs" type="button" class="btn btn-secondary" style="margin-top:8px;font-size:12px;"
          title="${t('audioOutputs.resetAllHint')}" hidden>${t('audioOutputs.resetAll')}</button>
      </div>
    `;
  }

  public attachEvents(container: HTMLElement): void {
    this.cleanup();
    this.container = container;
    const toggle = container.querySelector<HTMLInputElement>('#toggle-advanced-audio-outputs');
    const panel = container.querySelector<HTMLElement>('#advanced-audio-outputs');
    const status = container.querySelector<HTMLElement>('#advanced-audio-output-status');
    const reset = container.querySelector<HTMLButtonElement>('#reset-audio-outputs');
    if (!toggle || !panel || !status || !reset) throw new Error('Advanced audio output controls are missing');
    const abort = new AbortController();
    let displayed = copyAudioOutputPreferences(settingsStore);
    const sync = () => {
      toggle.checked = settingsStore.advancedAudioOutputs;
      toggle.disabled = this.busy;
      panel.hidden = !settingsStore.advancedAudioOutputs;
      reset.hidden = !AUDIO_OUTPUT_CATEGORIES.some((category) => settingsStore.audioOutputDevices[category] !== null);
      reset.disabled = this.busy;
      for (const category of AUDIO_OUTPUT_CATEGORIES) {
        const select = container.querySelector<HTMLSelectElement>(`#select-audio-output-${category}`);
        if (select) {
          select.value = settingsStore.audioOutputDevices[category] ?? 'inherit';
          select.disabled = this.busy;
        }
      }
    };
    const apply = async (next: AudioOutputPreferences) => {
      this.busy = true;
      sync();
      status.textContent = t('audioOutputs.applying');
      try {
        await selectAudioOutputPreferences(next, abort.signal);
        status.textContent = '';
      } catch (error) {
        if (!abort.signal.aborted) {
          console.error('[AudioOutputs] Could not apply output preferences:', error);
          status.textContent = audioDeviceError(error);
        }
      } finally {
        this.busy = false;
        if (!abort.signal.aborted) sync();
      }
    };
    const toggleAdvanced = () => {
      const next = copyAudioOutputPreferences(settingsStore);
      next.advancedAudioOutputs = toggle.checked;
      void apply(next);
    };
    toggle.addEventListener('change', toggleAdvanced);
    const resetAll = () => {
      void apply({
        selectedSpeakerId: '',
        advancedAudioOutputs: false,
        audioOutputDevices: { voice: null, screen: null, media: null },
      });
    };
    reset.addEventListener('click', resetAll);
    this.unbind.push(
      () => abort.abort(),
      () => toggle.removeEventListener('change', toggleAdvanced),
      () => reset.removeEventListener('click', resetAll),
      appEvents.on('settings.updated', () => {
        const next = copyAudioOutputPreferences(settingsStore);
        if (next.selectedSpeakerId === displayed.selectedSpeakerId &&
          next.advancedAudioOutputs === displayed.advancedAudioOutputs &&
          AUDIO_OUTPUT_CATEGORIES.every((category) => next.audioOutputDevices[category] === displayed.audioOutputDevices[category])) return;
        displayed = next;
        sync();
        if (this.devices) this.refreshDevices(this.devices);
      }),
    );
    for (const category of AUDIO_OUTPUT_CATEGORIES) {
      const select = container.querySelector<HTMLSelectElement>(`#select-audio-output-${category}`);
      if (!select) throw new Error(`Missing ${category} audio output selector`);
      const change = () => {
        const next = copyAudioOutputPreferences(settingsStore);
        next.audioOutputDevices[category] = select.value === 'inherit' ? null : select.value;
        void apply(next);
      };
      select.addEventListener('change', change);
      this.unbind.push(() => select.removeEventListener('change', change));
    }
    sync();
  }

  public refreshDevices(devices: MediaDeviceInfo[]): void {
    this.devices = [...devices];
    for (const category of AUDIO_OUTPUT_CATEGORIES) {
      const select = this.container?.querySelector<HTMLSelectElement>(`#select-audio-output-${category}`);
      if (!select) continue;
      const selected = settingsStore.audioOutputDevices[category];
      const message = populateAudioDeviceSelect(select, 'output', devices, selected ?? '');
      select.prepend(new Option(t('audioOutputs.inherit'), 'inherit'));
      select.value = selected ?? 'inherit';
      select.disabled = this.busy;
      const status = this.container?.querySelector<HTMLElement>(`#audio-output-${category}-status`);
      if (status) status.textContent = message;
    }
  }

  public cleanup(): void {
    this.unbind.forEach((off) => off());
    this.unbind = [];
    this.container = null;
    this.busy = false;
    this.devices = null;
  }
}
