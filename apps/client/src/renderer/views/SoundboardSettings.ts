import { appEvents } from '../core/EventBus';
import { soundboardService } from '../core/SoundboardService';
import { t } from '../i18n';
import { settingsStore } from '../stores/settingsStore';
import { escapeHtml } from '../utils/html';
import { revealWhenUnfolded } from '../utils/surfaceVisibility';
import { bindSoundboardLimiterControls, renderSoundboardLimiterControls } from './SoundboardLimiterControls';

/**
 * The soundboard's volume, in the soundboard and in the settings: every step is
 * heard at once and the value is saved where the slider stops.
 */
export function bindSoundboardVolumeSlider(slider: HTMLInputElement | null, label: Element | null): void {
  slider?.addEventListener('input', () => {
    const value = parseInt(slider.value, 10);
    slider.style.setProperty('--slider-progress', `${value}%`);
    if (label) label.textContent = `${value}%`;
    settingsStore.soundboardVolume = value;
    soundboardService.applyVolume();
    settingsStore.saveSoon();
  });
  slider?.addEventListener('change', () => settingsStore.save());
}

export function renderSoundboardSettings(): string {
  return `
    <section id="sb-settings-section" class="sb-settings-section" role="region"
      aria-labelledby="sb-settings-title" aria-describedby="sb-settings-description" aria-hidden="true" inert>
      <div class="sb-settings-clip">
        <div class="sb-settings-content">
          <h3 id="sb-settings-title" class="sb-settings-title">${escapeHtml(t('soundboard.limiterTitle'))}</h3>
          <p id="sb-settings-description" class="sb-settings-description">${escapeHtml(t('soundboard.limiterHint'))}</p>
          ${renderSoundboardLimiterControls('soundboard-modal', t('soundboard.enableLimiter'))}
        </div>
      </div>
    </section>
  `;
}

export interface SoundboardSettingsBinding {
  /** Closes the quick settings when they are open; true when that used up the gesture. */
  collapse(): boolean;
  unbind(): void;
}

export function bindSoundboardSettings(root: HTMLElement): SoundboardSettingsBinding {
  const trigger = root.querySelector<HTMLButtonElement>('#sb-btn-settings');
  const section = root.querySelector<HTMLElement>('#sb-settings-section');
  if (!trigger || !section) throw new Error('Soundboard settings controls are missing');
  let expanded = false;
  let unbindControls: (() => void) | null = null;
  const sync = () => {
    const enabled = settingsStore.soundboardLimiterEnabled;
    const state = enabled ? t('settings.soundboardLimitLevel', { level: settingsStore.soundboardLoudnessLimit })
      : t('soundboard.limiterInactive');
    trigger.title = `${t('soundboard.quickSettings')}: ${state}`;
    trigger.setAttribute('aria-label', trigger.title);
  };
  const setExpanded = (value: boolean) => {
    if (value === expanded) return;
    expanded = value;
    if (expanded) {
      unbindControls = bindSoundboardLimiterControls(section);
    } else {
      unbindControls?.();
      unbindControls = null;
      if (section.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    }
    trigger.setAttribute('aria-expanded', String(expanded));
    section.inert = !expanded;
    section.setAttribute('aria-hidden', String(!expanded));
    section.classList.toggle('is-expanded', expanded);
    if (expanded) {
      section.querySelector<HTMLInputElement>('[data-limiter-toggle]')?.focus({ preventScroll: true });
      revealWhenUnfolded(section);
    }
  };
  const toggle = () => setExpanded(!expanded);
  const collapse = (): boolean => {
    if (!expanded) return false;
    setExpanded(false);
    trigger.focus({ preventScroll: true });
    return true;
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !collapse()) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const offSettings = appEvents.on('settings.updated', sync);
  const offConnection = appEvents.on('network.disconnected', () => setExpanded(false));
  trigger.addEventListener('click', toggle);
  root.addEventListener('keydown', keydown);
  sync();
  return {
    collapse,
    unbind: () => {
      unbindControls?.();
      offSettings();
      offConnection();
      trigger.removeEventListener('click', toggle);
      root.removeEventListener('keydown', keydown);
    },
  };
}
