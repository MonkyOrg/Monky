import type { NativeScreenVideoProfile, ScreenEncodingAvailability } from '@monky/shared';
import { settingsStore } from '../stores/settingsStore';
import { probeScreenEncoding } from '../core/screenEncoding';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';

export class ScreenEncodingControls {
  private events: AbortController | null = null;
  private probe: AbortController | null = null;
  private container: HTMLElement | null = null;
  private availability: ScreenEncodingAvailability | null = null;
  private pending = false;
  private error = '';
  private selectionKey: string | null = null;
  private unbindSettings: (() => void) | null = null;

  constructor(private readonly profile: () => NativeScreenVideoProfile | null,
    private readonly changed: () => void = () => {}) {}

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

  async refresh(): Promise<void> {
    const profile = this.profile();
    const automatic = settingsStore.screenEncodingStrategy === 'automatic';
    const key = JSON.stringify([profile, settingsStore.screenEncodingStrategy,
      ...(automatic ? [] : [settingsStore.screenEncodingMode, settingsStore.preferredScreenCodec])]);
    if (!this.container || key === this.selectionKey) return;
    this.selectionKey = key;
    this.probe?.abort();
    const probe = new AbortController();
    this.probe = probe;
    this.pending = true;
    this.error = '';
    this.availability = null;
    this.render();
    this.changed();
    try {
      if (!profile) throw new Error(t('screenShare.nativeProfileChangeBlocked'));
      const availability = await probeScreenEncoding(profile, probe.signal);
      if (probe.signal.aborted || this.probe !== probe) return;
      this.availability = availability;
    } catch (error) {
      if (probe.signal.aborted || this.probe !== probe) return;
      this.error = error instanceof Error ? error.message : t('screenShare.nativeUnavailable');
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
      hardware.disabled = automatic || this.pending || !this.availability?.hardware.available;
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
        ? t('settings.screenEncodingError', { reason: this.error })
        : !selection ? t('settings.screenEncodingSelectionUnavailable', { reason: this.availability?.reason
          ?? this.availability?.hardware.reason ?? t('screenShare.nativeEncoderUnavailable') })
        : this.availability?.hardware.error
          ? t('settings.screenEncodingError', { reason: this.availability.hardware.reason ?? '' })
        : !this.availability?.hardware.available
          ? t('settings.screenEncodingUnavailable', { reason: this.availability?.hardware.reason ?? '' })
          : t('settings.screenEncodingReady', { codec: selection.codec.toUpperCase() });
    }
  }

  cleanup(): void {
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
