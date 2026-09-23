import { selectNoiseSuppression } from '../../core/AudioDeviceService';
import { appEvents } from '../../core/EventBus';
import { settingsStore } from '../../stores/settingsStore';
import { t, type TranslationKey } from '../../i18n';
import { NOISE_SUPPRESSION_MODES, isNoiseSuppressionMode, type NoiseSuppressionMode } from '../../utils/audioPreferences';
import { escapeHtml } from '../../utils/html';

const labels: Record<NoiseSuppressionMode, TranslationKey> = {
  rnnoise: 'audioNoise.rnnoise',
  speex: 'audioNoise.speex',
  gtcrn: 'audioNoise.gtcrn',
  browser: 'audioNoise.browser',
  off: 'audioNoise.off',
};
const descriptions: Record<NoiseSuppressionMode, TranslationKey> = {
  rnnoise: 'audioNoise.rnnoiseDescription',
  speex: 'audioNoise.speexDescription',
  gtcrn: 'audioNoise.gtcrnDescription',
  browser: 'audioNoise.browserDescription',
  off: 'audioNoise.offDescription',
};

export function noiseSuppressionToggleTitle(mode: NoiseSuppressionMode): string {
  return mode === 'off' ? t('audioNoise.quickEnable') : t('audioNoise.quickDisable', { mode: t(labels[mode]) });
}

export class NoiseSuppressionControl {
  private unbind: Array<() => void> = [];

  public constructor(
    private readonly prefix = '',
    private readonly presentation: 'select' | 'cards' = 'select',
  ) {}

  private id(name: string): string {
    return this.prefix ? `${this.prefix}-${name}` : name;
  }

  public renderHtml(): string {
    const title = escapeHtml(t('audioNoise.title'));
    const descriptionIds = ['noise-suppression-description', 'noise-suppression-hint', 'noise-suppression-status']
      .map((id) => this.id(id)).join(' ');
    return `
      <div id="${this.id('noise-suppression-control')}" class="form-group noise-suppression-control" data-settings-section="noise-suppression" data-settings-label="${title}">
        ${this.presentation === 'select' ? `
          <label for="${this.id('select-noise-suppression')}">${t('audioNoise.title')}</label>
          <select id="${this.id('select-noise-suppression')}" aria-describedby="${descriptionIds}">
            ${NOISE_SUPPRESSION_MODES.map((mode) => `<option value="${mode}" ${settingsStore.noiseSuppressionMode === mode ? 'selected' : ''}>${t(labels[mode])}</option>`).join('')}
          </select>
        ` : `
          <h3 class="media-popover-title">${t('audioNoise.title')}</h3>
          <div class="noise-suppression-options" role="listbox" aria-label="${title}" aria-describedby="${descriptionIds}">
            ${NOISE_SUPPRESSION_MODES.map((mode) => `<button type="button" class="audio-device-option" data-noise-mode="${mode}" role="option"
              aria-selected="${settingsStore.noiseSuppressionMode === mode}" tabindex="${settingsStore.noiseSuppressionMode === mode ? 0 : -1}">
              <span>${t(labels[mode])}</span><span class="material-symbols-outlined md-16" aria-hidden="true">${settingsStore.noiseSuppressionMode === mode ? 'check' : ''}</span>
            </button>`).join('')}
          </div>
        `}
        <div id="${this.id('noise-suppression-description')}" class="audio-device-status">${t(descriptions[settingsStore.noiseSuppressionMode])}</div>
        <div id="${this.id('noise-suppression-hint')}" class="audio-device-status">${t('audioNoise.compareHint')}</div>
        <div id="${this.id('noise-suppression-status')}" class="audio-device-status" role="status"></div>
      </div>
    `;
  }

  public attachEvents(container: HTMLElement): void {
    this.cleanup();
    const root = container.querySelector<HTMLElement>(`#${CSS.escape(this.id('noise-suppression-control'))}`);
    const select = root?.querySelector<HTMLSelectElement>('select');
    const description = root?.querySelector<HTMLElement>(`#${CSS.escape(this.id('noise-suppression-description'))}`);
    const status = root?.querySelector<HTMLElement>(`#${CSS.escape(this.id('noise-suppression-status'))}`);
    if (!root || !description || !status) throw new Error('Noise suppression controls are missing');
    const cards = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-noise-mode]'));
    const abort = new AbortController();
    let busy = false;
    let search = '';
    let lastSearch = 0;
    const refresh = () => {
      const mode = settingsStore.noiseSuppressionMode;
      if (select) {
        select.disabled = busy;
        select.value = mode;
      }
      description.textContent = t(descriptions[mode]);
      for (const card of cards) {
        const selected = card.dataset.noiseMode === mode;
        card.disabled = busy;
        card.tabIndex = selected ? 0 : -1;
        card.setAttribute('aria-selected', String(selected));
        const icon = card.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = selected ? 'check' : '';
      }
    };
    const change = async (value: unknown) => {
      if (busy) return;
      busy = true;
      refresh();
      status.textContent = t('audioNoise.applying');
      try {
        if (!isNoiseSuppressionMode(value)) throw new Error('Invalid noise suppression mode');
        await selectNoiseSuppression(value, abort.signal);
        if (abort.signal.aborted) return;
        status.textContent = '';
      } catch (error) {
        if (!abort.signal.aborted) {
          console.error('[NoiseSuppression] Could not apply the selected engine:', error);
          status.textContent = t('audioNoise.selectionFailed');
        }
      } finally {
        busy = false;
        if (!abort.signal.aborted) {
          refresh();
          if (document.activeElement === document.body) {
            cards.find((card) => card.dataset.noiseMode === settingsStore.noiseSuppressionMode)?.focus();
          }
        }
      }
    };
    const onSelect = () => { void change(select?.value); };
    select?.addEventListener('change', onSelect);
    for (const card of cards) {
      const choose = () => { void change(card.dataset.noiseMode); };
      card.addEventListener('click', choose);
      this.unbind.push(() => card.removeEventListener('click', choose));
    }
    const keyboard = (event: KeyboardEvent) => {
      const available = cards.filter((card) => !card.disabled);
      const index = available.findIndex((card) => card === document.activeElement);
      if (index < 0 || !available.length) return;
      let next: HTMLButtonElement | undefined;
      if (event.key === 'ArrowDown') next = available[(index + 1) % available.length];
      else if (event.key === 'ArrowUp') next = available[(index + available.length - 1) % available.length];
      else if (event.key === 'Home') next = available[0];
      else if (event.key === 'End') next = available[available.length - 1];
      else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        search = performance.now() - lastSearch < 600 ? search + event.key : event.key;
        lastSearch = performance.now();
        next = available.find((card) => card.textContent?.trim().toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
      }
      if (next) {
        event.preventDefault();
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      }
    };
    root.addEventListener('keydown', keyboard);
    this.unbind.push(
      () => abort.abort(),
      () => select?.removeEventListener('change', onSelect),
      () => root.removeEventListener('keydown', keyboard),
      appEvents.on('settings.updated', refresh),
      appEvents.on('audio.processing_error', () => { status.textContent = t('audioNoise.processingFailed'); }),
    );
    refresh();
  }

  public cleanup(): void {
    this.unbind.forEach((off) => off());
    this.unbind = [];
  }
}
