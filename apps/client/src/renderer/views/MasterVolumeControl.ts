import { appEvents } from '../core/EventBus';
import { t } from '../i18n';
import { settingsStore } from '../stores/settingsStore';
import { html } from '../utils/html';
import { reportError } from '../utils/feedback';
import '../styles/mediaPopovers.css';

type Direction = 'input' | 'output';

const volumeFor = (direction: Direction): number =>
  direction === 'input' ? settingsStore.inputVolume : settingsStore.outputVolume;

export function renderMasterVolumeControl(direction: Direction, prefix = ''): string {
  const id = `slider-${prefix}${direction}-volume`;
  const volume = volumeFor(direction);
  return String(html`
    <div class="master-volume-control">
      <label for="${id}">
        <span class="material-symbols-outlined md-16" aria-hidden="true">${direction === 'input' ? 'mic' : 'volume_up'}</span>
        ${t(direction === 'input' ? 'settings.inputVolume' : 'settings.outputVolume')}
      </label>
      <div class="master-volume-row">
        <input id="${id}" class="sb-slider" type="range" min="0" max="200" step="1"
          value="${volume}" data-volume-direction="${direction}" aria-describedby="${id}-hint"
          aria-valuetext="${volume}%" style="--slider-progress: ${volume / 2}%;">
        <span id="${prefix}${direction}-volume-value" data-volume-value>${volume}%</span>
      </div>
      <div id="${id}-hint" class="master-volume-hint">${t(direction === 'input' ? 'settings.inputVolumeHint' : 'settings.outputVolumeHint')}</div>
    </div>`);
}

/** Settings and quick controls edit the same gain, without saving external updates again. */
export function bindMasterVolumeControls(root: HTMLElement): () => void {
  const controller = new AbortController();
  const sliders = [...root.querySelectorAll<HTMLInputElement>('input[data-volume-direction]')];
  const refresh = (): void => {
    for (const slider of sliders) {
      const direction = slider.dataset.volumeDirection;
      if (direction !== 'input' && direction !== 'output') continue;
      const volume = volumeFor(direction);
      slider.value = String(volume);
      slider.style.setProperty('--slider-progress', `${volume / 2}%`);
      slider.setAttribute('aria-valuetext', `${volume}%`);
      const value = slider.closest('.master-volume-control')?.querySelector('[data-volume-value]');
      if (value) value.textContent = `${volume}%`;
    }
  };
  for (const slider of sliders) {
    slider.addEventListener('input', () => {
      const volume = Number(slider.value);
      if (slider.dataset.volumeDirection === 'input') settingsStore.setInputVolume(volume, 'soon');
      else if (slider.dataset.volumeDirection === 'output') settingsStore.setOutputVolume(volume, 'soon');
    }, { signal: controller.signal });
    slider.addEventListener('change', () => {
      try { settingsStore.save(); }
      catch (error: unknown) { reportError(t('settings.volumeSaveFailed'), { error }); }
    }, { signal: controller.signal });
  }
  const offVolume = appEvents.on('master_volume.changed', refresh);
  const offSettings = appEvents.on('settings.updated', refresh);
  refresh();
  return () => {
    controller.abort();
    offVolume();
    offSettings();
  };
}
