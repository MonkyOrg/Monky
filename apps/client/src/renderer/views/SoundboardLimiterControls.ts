import { appEvents } from '../core/EventBus';
import { clientLog } from '../core/ClientLogService';
import { soundboardService } from '../core/SoundboardService';
import { settingsStore } from '../stores/settingsStore';
import { getLanguage, t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { showAlert } from './Dialog';

function intensityPosition(value: number): number {
  return (Math.min(10, Math.max(1, value)) - 1) / 9 * 100;
}

export function renderSoundboardLimiterControls(
  prefix: 'soundboard' | 'soundboard-modal',
  toggleLabel = t('settings.soundboardLimiter'),
): string {
  const enabled = settingsStore.soundboardLimiterEnabled;
  return `
    <div class="sb-limiter-controls">
      <div class="sb-limiter-heading">
        <label for="checkbox-${prefix}-limiter">${escapeHtml(toggleLabel)}</label>
        <label class="toggle-switch">
          <input id="checkbox-${prefix}-limiter" data-limiter-toggle type="checkbox" role="switch"
            aria-controls="${prefix}-limiter-details" aria-describedby="${prefix}-limiter-description" ${enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div id="${prefix}-limiter-details" class="sb-limiter-details${enabled ? ' is-expanded' : ''}"
        data-limiter-details aria-hidden="${!enabled}" ${enabled ? '' : 'inert'}>
        <div class="sb-limiter-details-clip">
          <div class="sb-limiter-details-content">
            <p id="${prefix}-limiter-description" class="sb-limiter-description">${escapeHtml(t('settings.soundboardLimiterDesc'))}</p>
            <div class="sb-limiter-heading">
              <label for="slider-${prefix}-ceiling">${t('settings.soundboardCeiling')}</label>
              <span id="${prefix}-ceiling-value" class="sb-limiter-value" data-limiter-value>${settingsStore.soundboardLoudnessLimit} / 10</span>
            </div>
            <div class="sb-limiter-track" data-limiter-track
              style="--limit-position: ${intensityPosition(settingsStore.soundboardLoudnessLimit)}%;">
              <div class="sb-limiter-bands" aria-hidden="true"></div>
              <span class="sb-limiter-meter" data-limiter-meter role="meter" hidden
                aria-label="${escapeHtml(t('soundboard.intensityLabel'))}" aria-valuemin="0" aria-valuemax="10" aria-valuenow="0"></span>
              <input id="slider-${prefix}-ceiling" data-limiter-ceiling class="sb-slider sb-limiter-ceiling" type="range" min="1" max="10" step="1"
                value="${settingsStore.soundboardLoudnessLimit}" ${enabled ? '' : 'disabled'} aria-describedby="${prefix}-limiter-description"
                aria-valuetext="${escapeHtml(t('settings.soundboardLimitLevel', { level: settingsStore.soundboardLoudnessLimit }))}">
            </div>
            <div class="sb-limiter-reading">
              <span data-limiter-current>${t('soundboard.intensityIdle')}</span>
              <span data-limiter-status></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function bindSoundboardLimiterControls(container: HTMLElement): () => void {
  const controls = container.querySelector<HTMLElement>('.sb-limiter-controls');
  const toggle = controls?.querySelector<HTMLInputElement>('[data-limiter-toggle]');
  const details = controls?.querySelector<HTMLElement>('[data-limiter-details]');
  const ceiling = controls?.querySelector<HTMLInputElement>('[data-limiter-ceiling]');
  const valueLabel = controls?.querySelector<HTMLElement>('[data-limiter-value]');
  const track = controls?.querySelector<HTMLElement>('[data-limiter-track]');
  const meter = controls?.querySelector<HTMLElement>('[data-limiter-meter]');
  const currentLabel = controls?.querySelector<HTMLElement>('[data-limiter-current]');
  const statusLabel = controls?.querySelector<HTMLElement>('[data-limiter-status]');
  if (!controls || !toggle || !details || !ceiling || !valueLabel || !track || !meter || !currentLabel || !statusLabel) {
    throw new Error('Soundboard limiter controls are missing');
  }
  let disposed = false;
  let busy = false;
  let intensity = soundboardService.getIntensity();
  const format = new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const mounted = () => !disposed && controls.isConnected;
  const syncIntensity = () => {
    if (!mounted()) return;
    meter.hidden = intensity === null;
    if (intensity === null) {
      currentLabel.textContent = t('soundboard.intensityIdle');
      statusLabel.textContent = settingsStore.soundboardLimiterEnabled ? '' : t('soundboard.limiterInactive');
      delete controls.dataset.intensityState;
      return;
    }
    const limit = settingsStore.soundboardLoudnessLimit;
    const state = intensity > limit ? 'above' : intensity >= limit - 1 ? 'near' : 'below';
    const status = state === 'above' ? t('soundboard.intensityAbove')
      : state === 'near' ? t('soundboard.intensityNear') : t('soundboard.intensityBelow');
    const value = format.format(intensity);
    controls.dataset.intensityState = state;
    track.style.setProperty('--sound-position', String(intensityPosition(intensity) / 100));
    meter.setAttribute('aria-valuenow', String(Math.min(10, intensity)));
    meter.setAttribute('aria-valuetext', `${t('soundboard.intensityCurrent', { value })}. ${status}`);
    currentLabel.textContent = t('soundboard.intensityCurrent', { value });
    statusLabel.textContent = settingsStore.soundboardLimiterEnabled ? status : t('soundboard.limiterInactive');
  };
  const sync = () => {
    if (!mounted()) return;
    const enabled = settingsStore.soundboardLimiterEnabled;
    toggle.checked = enabled;
    toggle.disabled = busy;
    if (!enabled && details.contains(document.activeElement) && !toggle.disabled) toggle.focus({ preventScroll: true });
    details.inert = !enabled;
    details.setAttribute('aria-hidden', String(!enabled));
    details.classList.toggle('is-expanded', enabled);
    controls.setAttribute('aria-busy', String(busy));
    const value = settingsStore.soundboardLoudnessLimit;
    if (ceiling.value !== String(value)) ceiling.value = String(value);
    ceiling.disabled = busy || !enabled;
    ceiling.setAttribute('aria-valuetext', t('settings.soundboardLimitLevel', { level: value }));
    track.style.setProperty('--limit-position', `${intensityPosition(value)}%`);
    valueLabel.textContent = `${value} / 10`;
    syncIntensity();
  };
  const notify = async (error: unknown, message: string) => {
    clientLog.warn('AUDIO', 'Could not configure the soundboard limiter', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (mounted()) await showAlert({ message, variant: 'danger' });
  };
  const restoreFocus = (control: HTMLInputElement, wasFocused: boolean) => {
    if (mounted() && wasFocused && document.activeElement === document.body && !control.disabled) {
      control.focus({ preventScroll: true });
    }
  };
  const changeEnabled = async () => {
    if (busy || !mounted()) return;
    const requested = toggle.checked;
    const wasFocused = document.activeElement === toggle;
    let previous: boolean | undefined;
    busy = true;
    sync();
    try {
      if (requested) await soundboardService.prepareLimiter();
      if (!mounted()) return;
      previous = settingsStore.soundboardLimiterEnabled;
      settingsStore.soundboardLimiterEnabled = requested;
      settingsStore.save();
    } catch (error: unknown) {
      if (previous !== undefined) settingsStore.soundboardLimiterEnabled = previous;
      sync();
      await notify(error, t(previous === undefined ? 'soundboard.limiterUnavailable' : 'soundboard.limiterSaveFailed'));
    } finally {
      busy = false;
      sync();
      restoreFocus(toggle, wasFocused);
    }
  };
  const changeCeiling = async () => {
    if (busy || !mounted() || ceiling.disabled) return;
    const value = Number(ceiling.value);
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      clientLog.warn('AUDIO', 'Invalid soundboard limiter ceiling');
      sync();
      return;
    }
    const previous = settingsStore.soundboardLoudnessLimit;
    const wasFocused = document.activeElement === ceiling;
    try {
      settingsStore.soundboardLoudnessLimit = value;
      settingsStore.save();
    } catch (error: unknown) {
      settingsStore.soundboardLoudnessLimit = previous;
      busy = true;
      sync();
      await notify(error, t('soundboard.limiterSaveFailed'));
    } finally {
      busy = false;
      sync();
      restoreFocus(ceiling, wasFocused);
    }
  };
  toggle.addEventListener('change', changeEnabled);
  ceiling.addEventListener('input', changeCeiling);
  const unsubscribe = appEvents.on('settings.updated', sync);
  const unsubscribeIntensity = appEvents.on<number | null>('soundboard.intensity', value => {
    intensity = value;
    syncIntensity();
  });
  sync();
  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeIntensity();
    toggle.removeEventListener('change', changeEnabled);
    ceiling.removeEventListener('input', changeCeiling);
  };
}
