import type { NativeScreenVideoProfile, ScreenEncodingAvailability } from '@monky/shared';
import { settingsStore } from '../stores/settingsStore';
import { probeScreenEncoding } from '../core/screenEncoding';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { FPS_OPTIONS } from './settings/qualityOptions';
import { showInfoToast } from './CopyToast';

export class ScreenEncodingControls {
  private events: AbortController | null = null;
  private probe: AbortController | null = null;
  private container: HTMLElement | null = null;
  private availability: ScreenEncodingAvailability | null = null;
  private pending = false;
  private error = '';
  private selectionKey: string | null = null;
  private unbindSettings: (() => void) | null = null;
  private clearToast: (() => void) | null = null;

  constructor(private readonly profile: () => NativeScreenVideoProfile | null,
    private readonly changed: () => void = () => {},
    private readonly applyCompatibleProfile?: (profile: NativeScreenVideoProfile) => void,
    private readonly rejected?: () => void) {}

  static html(): string {
    return `<div class="form-group" data-settings-section="screen-encoding"
      data-settings-label="${escapeHtml(t('settings.screenEncodingSection'))}">
      <label>${t('settings.screenEncodingSection')}</label>
      <div class="input-mode-cards" role="group" aria-label="${escapeHtml(t('settings.screenEncodingStrategy'))}"
        aria-describedby="screen-codec-description">
        ${(['automatic', 'manual'] as const).map(strategy => `
        <button type="button" class="voice-mode-card input-mode-card" id="screen-encoding-${strategy}"
          aria-pressed="${settingsStore.screenEncodingStrategy === strategy}">
          <span class="input-mode-card-title">${t(strategy === 'automatic' ? 'settings.screenEncodingAutomatic' : 'settings.screenEncodingManual')}</span>
          <span class="input-mode-card-description">${t(strategy === 'automatic' ? 'settings.screenEncodingAutomaticDesc' : 'settings.screenEncodingManualDesc')}</span>
        </button>`).join('')}
      </div>
      <p id="screen-codec-description" class="audio-device-status">${t('settings.videoCodecDesc')}</p>
      <label>${t('settings.screenEncodingMethod')}</label>
      <div class="input-mode-cards" role="group" aria-label="${escapeHtml(t('settings.screenEncodingSection'))}"
        aria-describedby="screen-encoding-status screen-encoding-apply">
        <button type="button" class="voice-mode-card input-mode-card" id="screen-encoding-hardware"
          aria-pressed="${settingsStore.screenEncodingStrategy === 'manual' && settingsStore.screenEncodingMode === 'hardware'}" disabled>
          <span class="input-mode-card-title">${t('settings.screenEncodingHardware')}</span>
          <span class="input-mode-card-description">${t('settings.screenEncodingHardwareDesc')}</span>
        </button>
        <button type="button" class="voice-mode-card input-mode-card" id="screen-encoding-software"
          aria-pressed="${settingsStore.screenEncodingStrategy === 'manual' && settingsStore.screenEncodingMode === 'software'}"
          ${settingsStore.screenEncodingStrategy === 'automatic' ? 'disabled' : ''}>
          <span class="input-mode-card-title">${t('settings.screenEncodingSoftware')}</span>
          <span class="input-mode-card-description">${t('settings.screenEncodingSoftwareDesc')}</span>
        </button>
      </div>
      <div class="form-group" style="margin-top: 12px; margin-bottom: 0;">
        <label for="select-video-codec">${t('settings.videoCodecSection')}</label>
        <select id="select-video-codec" aria-describedby="screen-codec-description screen-encoding-status"
          ${settingsStore.screenEncodingStrategy === 'automatic' ? 'disabled' : ''}>
          <option value="h264" ${settingsStore.preferredScreenCodec === 'h264' ? 'selected' : ''}>${t('settings.codecH264')}</option>
          <option value="av1" ${settingsStore.preferredScreenCodec === 'av1' ? 'selected' : ''}>${t('settings.codecAv1')}</option>
        </select>
      </div>
      <p id="screen-encoding-status" class="audio-device-status" role="status" aria-live="polite">${t('common.loading')}</p>
      <p id="screen-encoding-apply" class="audio-device-status">${t('settings.screenEncodingApply')}</p>
    </div>`;
  }

  attach(container: HTMLElement): void {
    this.cleanup();
    this.container = container;
    this.events = new AbortController();
    this.unbindSettings = appEvents.on('settings.updated', () => { void this.refresh(); });
    for (const strategy of ['automatic', 'manual'] as const) {
      const button = container.querySelector<HTMLButtonElement>(`#screen-encoding-${strategy}`);
      button?.addEventListener('click', () => {
        if (settingsStore.screenEncodingStrategy === strategy) return;
        settingsStore.screenEncodingStrategy = strategy;
        settingsStore.save();
        void this.refresh();
      }, { signal: this.events.signal });
      this.keyboard(button, strategy === 'automatic' ? 'manual' : 'automatic', 'automatic', 'manual');
    }
    for (const mode of ['hardware', 'software'] as const) {
      const button = container.querySelector<HTMLButtonElement>(`#screen-encoding-${mode}`);
      button?.addEventListener('click', () => {
        if (button.disabled || settingsStore.screenEncodingStrategy !== 'manual' || settingsStore.screenEncodingMode === mode) return;
        settingsStore.screenEncodingMode = mode;
        settingsStore.save();
        this.changed();
        void this.refresh();
      }, { signal: this.events.signal });
      this.keyboard(button, mode === 'hardware' ? 'software' : 'hardware', 'hardware', 'software');
    }
    const codec = container.querySelector<HTMLSelectElement>('#select-video-codec');
    codec?.addEventListener('change', () => {
      if (settingsStore.screenEncodingStrategy !== 'manual' || !['h264', 'av1'].includes(codec.value)) {
        this.render();
        return;
      }
      if (codec.value === settingsStore.preferredScreenCodec) return;
      settingsStore.preferredScreenCodec = codec.value === 'av1' ? 'av1' : 'h264';
      settingsStore.save();
      void this.refresh();
    }, { signal: this.events.signal });
    void this.refresh();
  }

  private keyboard(button: HTMLButtonElement | null, other: string, first: string, last: string): void {
    button?.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        button.click();
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = this.container?.querySelector<HTMLButtonElement>(
          `#screen-encoding-${event.key === 'Home' ? first : event.key === 'End' ? last : other}`);
        if (next && !next.disabled) { next.focus(); next.click(); }
      }
    }, { signal: this.events?.signal });
  }

  private key(profile = this.profile()): string {
    const automatic = settingsStore.screenEncodingStrategy === 'automatic';
    return JSON.stringify([profile, settingsStore.screenEncodingStrategy,
      ...(automatic ? [] : [settingsStore.screenEncodingMode, settingsStore.preferredScreenCodec])]);
  }

  private accept(profile: NativeScreenVideoProfile, requested: NativeScreenVideoProfile,
    availability: ScreenEncodingAvailability): void {
    const probe = this.probe, container = this.container;
    const current = () => this.probe === probe && !probe?.signal.aborted
      && this.container === container && !!container?.isConnected;
    // Saving emits settings.updated synchronously; retain the confirmed probe.
    this.selectionKey = this.key(profile);
    try { this.applyCompatibleProfile?.(profile); }
    catch (error) {
      console.warn('[ScreenEncoding] Compatible profile could not be applied:', error);
      if (!current()) return;
      this.availability = null;
      this.error = t('settings.screenEncodingAdjustmentBlocked');
      this.rejected?.();
      this.selectionKey = this.key();
      this.clearToast = showInfoToast(this.error);
      return;
    }
    if (!current()) return;
    this.availability = availability;
    if (profile.fps !== requested.fps && availability.selection) {
      this.clearToast = showInfoToast(t('settings.screenEncodingFpsAdjusted', {
        codec: availability.selection.codec.toUpperCase(), mode: t(availability.selection.mode === 'hardware'
          ? 'settings.screenEncodingHardwareShort' : 'settings.screenEncodingSoftware'),
        previous: requested.fps, fps: profile.fps,
      }), 6000);
    }
  }

  async refresh(applyRequested = false): Promise<void> {
    const profile = this.profile();
    const automatic = settingsStore.screenEncodingStrategy === 'automatic';
    const mode = settingsStore.screenEncodingMode, codec = settingsStore.preferredScreenCodec;
    const key = this.key(profile);
    if (!this.container?.isConnected) return;
    if (key === this.selectionKey) {
      if (!applyRequested || this.pending) return;
      if (profile && this.availability?.selection && !this.error) {
        this.accept(profile, profile, this.availability);
        this.render();
        this.changed();
        return;
      }
    }
    this.selectionKey = key;
    this.probe?.abort();
    this.clearToast?.();
    this.clearToast = null;
    const probe = new AbortController();
    this.probe = probe;
    this.pending = true;
    this.error = '';
    this.availability = null;
    this.render();
    this.changed();
    const current = () => !probe.signal.aborted && this.probe === probe
      && !!this.container?.isConnected && this.key() === key;
    const verified = (availability: ScreenEncodingAvailability) => {
      if (availability.hardware.error) {
        if (automatic || mode !== 'software' || availability.selection?.mode !== 'software')
          throw new Error(availability.hardware.reason ?? 'Encoder verification failed.');
        console.warn('[ScreenEncoding] Optional hardware inspection failed; explicit software was verified:',
          availability.hardware.reason);
      }
      if (availability.selection && !automatic && (availability.selection.mode !== mode
        || availability.selection.codec !== codec || availability.fallback
        || (mode === 'hardware' && !availability.hardware.available)))
        throw new Error('Encoder verification changed the explicitly selected codec or encoding mode.');
      if (availability.selection && !availability.hardware.available && !availability.hardware.error)
        console.warn('[ScreenEncoding] Hardware unavailable; software was verified:', availability.hardware.reason);
      return availability;
    };
    try {
      if (!profile) throw new Error(t('screenShare.nativeProfileChangeBlocked'));
      const availability = await probeScreenEncoding(profile, probe.signal);
      if (!current()) return;
      this.availability = verified(availability);
      if (availability.selection) {
        this.accept(profile, profile, availability);
        return;
      }
      if (this.applyCompatibleProfile) {
        for (const fps of FPS_OPTIONS.filter(value => value < profile.fps).reverse()) {
          const candidate = { ...profile, fps };
          const result = await probeScreenEncoding(candidate, probe.signal);
          if (!current()) return;
          verified(result);
          if (!result.selection) continue;
          this.accept(candidate, profile, result);
          return;
        }
      }
      console.warn('[ScreenEncoding] No compatible frame rate for the requested profile:', {
        profile, mode, codec, reason: availability.reason ?? availability.hardware.reason,
      });
      this.error = t('settings.screenEncodingProfileUnavailable', {
        codec: codec.toUpperCase(), mode: t(mode === 'hardware'
          ? 'settings.screenEncodingHardwareShort' : 'settings.screenEncodingSoftware'),
      });
      this.rejected?.();
      this.selectionKey = this.key();
      this.clearToast = showInfoToast(this.error);
    } catch (error) {
      if (!current()) return;
      console.warn('[ScreenEncoding] Encoder verification failed:', error);
      this.availability = null;
      this.error = t('settings.screenEncodingProbeFailed');
      this.rejected?.();
      this.selectionKey = this.key();
      this.clearToast = showInfoToast(this.error);
    } finally {
      if (!probe.signal.aborted && this.probe === probe) {
        this.pending = false;
        this.render();
        this.changed();
      }
    }
  }

  get ready(): boolean { return !this.pending && this.availability?.selection !== null && !!this.availability; }

  private render(): void {
    const automatic = settingsStore.screenEncodingStrategy === 'automatic';
    const selection = this.availability?.selection;
    const selectedMode = automatic ? selection?.mode : settingsStore.screenEncodingMode;
    for (const strategy of ['automatic', 'manual'] as const)
      this.container?.querySelector(`#screen-encoding-${strategy}`)?.setAttribute('aria-pressed',
        String(settingsStore.screenEncodingStrategy === strategy));
    const hardware = this.container?.querySelector<HTMLButtonElement>('#screen-encoding-hardware');
    const software = this.container?.querySelector<HTMLButtonElement>('#screen-encoding-software');
    if (hardware) {
      hardware.disabled = automatic || this.pending;
      hardware.setAttribute('aria-pressed', String(selectedMode === 'hardware'));
      hardware.setAttribute('aria-describedby', 'screen-encoding-status');
    }
    if (software) {
      software.disabled = automatic;
      software.setAttribute('aria-pressed', String(selectedMode === 'software'));
    }
    const codec = this.container?.querySelector<HTMLSelectElement>('#select-video-codec');
    if (codec) {
      codec.disabled = automatic;
      codec.setAttribute('aria-readonly', String(automatic));
      codec.value = automatic ? selection?.codec ?? '' : settingsStore.preferredScreenCodec;
    }
    const status = this.container?.querySelector<HTMLElement>('#screen-encoding-status');
    if (status) {
      status.setAttribute('aria-busy', String(this.pending));
      status.textContent = this.pending ? t('common.loading') : this.error
        ? this.error
        : !selection ? t('settings.screenEncodingProfileUnavailable', {
          codec: settingsStore.preferredScreenCodec.toUpperCase(),
          mode: t(settingsStore.screenEncodingMode === 'hardware'
            ? 'settings.screenEncodingHardwareShort' : 'settings.screenEncodingSoftware'),
        })
        : !this.availability?.hardware.available
          ? t('settings.screenEncodingHardwareUnavailable')
          : t('settings.screenEncodingReady', { codec: selection.codec.toUpperCase() });
    }
  }

  cleanup(): void {
    this.clearToast?.();
    this.clearToast = null;
    this.unbindSettings?.();
    this.unbindSettings = null;
    this.selectionKey = null;
    this.events?.abort();
    this.probe?.abort();
    this.events = null;
    this.probe = null;
    this.container = null;
  }
}
