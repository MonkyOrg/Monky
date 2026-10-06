import type { NativeScreenVideoProfile, ScreenEncodingAvailability, ScreenEncodingMode, ScreenCodec } from '@monky/shared';
import { settingsStore } from '../stores/settingsStore';
import { probeScreenEncoding, type ScreenEncodingPreferences } from '../core/screenEncoding';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { FPS_OPTIONS } from './settings/qualityOptions';
import { showInfoToast } from './CopyToast';

type CheckedProfile = {
  profile: NativeScreenVideoProfile;
  availability: ScreenEncodingAvailability;
};
type CheckedEncoding = CheckedProfile | { error: string };

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
  private requested: ScreenEncodingPreferences | null = null;
  private pendingSaved = '';
  private committing = false;
  private choices = new Map<string, CheckedEncoding>();
  private choicesProfile = '';
  private checkingChoices = false;

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
          <span id="screen-encoding-hardware-choice" class="input-mode-card-description"></span>
        </button>
        <button type="button" class="voice-mode-card input-mode-card" id="screen-encoding-software"
          aria-pressed="${settingsStore.screenEncodingStrategy === 'manual' && settingsStore.screenEncodingMode === 'software'}"
          ${settingsStore.screenEncodingStrategy === 'automatic' ? 'disabled' : ''}>
          <span class="input-mode-card-title">${t('settings.screenEncodingSoftware')}</span>
          <span class="input-mode-card-description">${t('settings.screenEncodingSoftwareDesc')}</span>
          <span id="screen-encoding-software-choice" class="input-mode-card-description"></span>
        </button>
      </div>
      <div class="form-group" style="margin-top: 12px; margin-bottom: 0;">
        <label for="select-video-codec">${t('settings.videoCodecSection')}</label>
        <select id="select-video-codec" aria-describedby="screen-codec-description screen-encoding-status screen-encoding-choices"
          ${settingsStore.screenEncodingStrategy === 'automatic' ? 'disabled' : ''}>
          <option value="h264" ${settingsStore.preferredScreenCodec === 'h264' ? 'selected' : ''}>${t('settings.codecH264')}</option>
          <option value="av1" ${settingsStore.preferredScreenCodec === 'av1' ? 'selected' : ''}>${t('settings.codecAv1')}</option>
        </select>
      </div>
      <p id="screen-encoding-status" class="audio-device-status" role="status" aria-live="polite">${t('common.loading')}</p>
      <p id="screen-encoding-choices" class="audio-device-status" role="status" aria-live="polite"></p>
      <p id="screen-encoding-apply" class="audio-device-status">${t('settings.screenEncodingApply')}</p>
    </div>`;
  }

  attach(container: HTMLElement): void {
    this.cleanup();
    this.container = container;
    this.events = new AbortController();
    this.unbindSettings = appEvents.on('settings.updated', () => {
      if (!this.committing && JSON.stringify(this.savedPreferences()) !== this.pendingSaved) {
        this.requested = null;
        this.selectionKey = null;
      }
      void this.refresh();
    });
    for (const strategy of ['automatic', 'manual'] as const) {
      const button = container.querySelector<HTMLButtonElement>(`#screen-encoding-${strategy}`);
      button?.addEventListener('click', () => {
        if (this.preferences().encodingStrategy === strategy) return;
        this.requested = { ...this.savedPreferences(), encodingStrategy: strategy };
        void this.refresh();
      }, { signal: this.events.signal });
      this.keyboard(button, strategy === 'automatic' ? 'manual' : 'automatic', 'automatic', 'manual');
    }
    for (const mode of ['hardware', 'software'] as const) {
      const button = container.querySelector<HTMLButtonElement>(`#screen-encoding-${mode}`);
      button?.addEventListener('click', () => {
        if (button.disabled || this.preferences().encodingStrategy !== 'manual') return;
        this.requested = { ...this.preferences(), encodingMode: mode, codec: this.modeCodec(mode) };
        void this.refresh();
      }, { signal: this.events.signal });
      this.keyboard(button, mode === 'hardware' ? 'software' : 'hardware', 'hardware', 'software');
    }
    const codec = container.querySelector<HTMLSelectElement>('#select-video-codec');
    codec?.addEventListener('change', () => {
      if (this.preferences().encodingStrategy !== 'manual' || !['h264', 'av1'].includes(codec.value)
        || codec.querySelector<HTMLOptionElement>(`option[value="${codec.value}"]`)?.disabled) {
        this.render();
        return;
      }
      this.requested = { ...this.preferences(), codec: codec.value === 'av1' ? 'av1' : 'h264' };
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

  private savedPreferences(): ScreenEncodingPreferences {
    return { encodingStrategy: settingsStore.screenEncodingStrategy,
      encodingMode: settingsStore.screenEncodingMode, codec: settingsStore.preferredScreenCodec };
  }

  private preferences(): ScreenEncodingPreferences { return this.requested ?? this.savedPreferences(); }

  private key(profile = this.profile(), preferences = this.preferences()): string {
    return JSON.stringify([profile, preferences.encodingStrategy,
      ...(preferences.encodingStrategy === 'automatic' ? [] : [preferences.encodingMode, preferences.codec])]);
  }

  private choice(mode: ScreenEncodingMode, codec: ScreenCodec): CheckedEncoding | undefined {
    return this.choices.get(`${mode}:${codec}`);
  }

  private modeCodec(mode: ScreenEncodingMode): ScreenCodec {
    const codec = this.preferences().codec, choice = this.choice(mode, codec);
    const other = codec === 'av1' ? 'h264' : 'av1', alternative = this.choice(mode, other);
    return choice && ('error' in choice || !choice.availability.selection)
      && alternative && !('error' in alternative) && alternative.availability.selection ? other : codec;
  }

  private choiceText(mode: ScreenEncodingMode, codec: ScreenCodec, choice?: CheckedEncoding): string {
    if (!choice && (this.pending || this.checkingChoices)) return t('common.loading');
    if (!choice || 'error' in choice) return t('settings.screenEncodingChoiceRetry', { codec: codec.toUpperCase() });
    return choice.availability.selection
      ? t('settings.screenEncodingChoiceReady', { codec: codec.toUpperCase(), fps: choice.profile.fps })
      : t('settings.screenEncodingProfileUnavailable', { codec: codec.toUpperCase(),
        mode: t(mode === 'hardware' ? 'settings.screenEncodingHardwareShort' : 'settings.screenEncodingSoftware') });
  }

  private async check(profile: NativeScreenVideoProfile, preferences: ScreenEncodingPreferences,
    signal: AbortSignal): Promise<CheckedProfile> {
    const rates = [profile.fps, ...(this.applyCompatibleProfile
      ? FPS_OPTIONS.filter(value => value < profile.fps).reverse() : [])];
    for (const fps of rates) {
      const candidate = { ...profile, fps };
      const availability = await probeScreenEncoding(candidate, signal, preferences);
      signal.throwIfAborted();
      const { selection } = availability;
      if (availability.hardware.error && (preferences.encodingStrategy === 'automatic'
        || preferences.encodingMode !== 'software' || selection?.mode !== 'software'))
        throw new Error(availability.hardware.reason ?? 'Encoder verification failed.');
      if (selection && preferences.encodingStrategy === 'manual' && (selection.mode !== preferences.encodingMode
        || selection.codec !== preferences.codec || availability.fallback
        || (selection.mode === 'hardware' && !availability.hardware.available)))
        throw new Error('Encoder verification changed the explicitly selected codec or encoding mode.');
      if (selection && !availability.hardware.available)
        console.warn('[ScreenEncoding] Hardware unavailable; software was verified:', availability.hardware.reason);
      if (selection || fps === rates[rates.length - 1])
        return { profile: candidate, availability };
    }
    throw new Error('No frame rate was checked.');
  }

  private accept(profile: NativeScreenVideoProfile, requested: NativeScreenVideoProfile,
    availability: ScreenEncodingAvailability): void {
    const probe = this.probe, container = this.container;
    const current = () => this.probe === probe && !probe?.signal.aborted
      && this.container === container && !!container?.isConnected;
    const previous = this.savedPreferences(), preferences = this.preferences();
    this.committing = true;
    try {
      settingsStore.screenEncodingStrategy = preferences.encodingStrategy;
      settingsStore.screenEncodingMode = preferences.encodingMode;
      settingsStore.preferredScreenCodec = preferences.codec;
      this.applyCompatibleProfile?.(profile);
      this.requested = null;
      if (JSON.stringify(previous) !== JSON.stringify(preferences)) settingsStore.save();
      this.selectionKey = this.key();
    }
    catch (error) {
      settingsStore.screenEncodingStrategy = previous.encodingStrategy;
      settingsStore.screenEncodingMode = previous.encodingMode;
      settingsStore.preferredScreenCodec = previous.codec;
      this.requested = null;
      console.warn('[ScreenEncoding] Compatible profile could not be applied:', error);
      if (!current()) return;
      this.availability = null;
      this.error = t('settings.screenEncodingAdjustmentBlocked');
      this.rejected?.();
      this.selectionKey = this.key();
      this.clearToast = showInfoToast(this.error);
      return;
    }
    finally { this.committing = false; }
    if (!current()) return;
    this.availability = availability;
    const acceptedProfile = JSON.stringify(this.profile());
    if (acceptedProfile === JSON.stringify(profile) && preferences.encodingStrategy === 'manual') {
      if (this.choicesProfile !== acceptedProfile) this.choices.clear();
      this.choicesProfile = acceptedProfile;
      this.choices.set(`${preferences.encodingMode}:${preferences.codec}`, { profile, availability });
    }
    if (profile.fps !== requested.fps && availability.selection) {
      this.clearToast = showInfoToast(t('settings.screenEncodingFpsAdjusted', {
        codec: availability.selection.codec.toUpperCase(), mode: t(availability.selection.mode === 'hardware'
          ? 'settings.screenEncodingHardwareShort' : 'settings.screenEncodingSoftware'),
        previous: requested.fps, fps: profile.fps,
      }), 6000);
    }
  }

  async refresh(applyRequested = false): Promise<void> {
    if (this.committing) return;
    const profile = this.profile();
    const preferences = { ...this.preferences() }, saved = JSON.stringify(this.savedPreferences());
    this.pendingSaved = saved;
    const automatic = preferences.encodingStrategy === 'automatic';
    const mode = preferences.encodingMode, codec = preferences.codec;
    const key = this.key(profile);
    if (!this.container?.isConnected) return;
    if (key === this.selectionKey) {
      if ((!applyRequested && !this.requested) || this.pending) return;
      if (!this.requested && profile && this.availability?.selection && !this.error) {
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
    this.checkingChoices = false;
    this.error = '';
    this.availability = null;
    if (this.choicesProfile !== JSON.stringify(profile)) {
      this.choices.clear();
      this.choicesProfile = JSON.stringify(profile);
    }
    this.render();
    this.changed();
    const current = () => !probe.signal.aborted && this.probe === probe
      && !!this.container?.isConnected && this.key() === key && JSON.stringify(this.savedPreferences()) === saved;
    let checkedCurrent = false;
    try {
      if (!profile) throw new Error(t('screenShare.nativeProfileChangeBlocked'));
      const checked = await this.check(profile, preferences, probe.signal);
      if (!current()) return;
      checkedCurrent = true;
      const { availability } = checked;
      if (!automatic) this.choices.set(`${mode}:${codec}`, checked);
      this.availability = availability;
      if (availability.selection) {
        this.accept(checked.profile, profile, availability);
        return;
      }
      console.warn('[ScreenEncoding] No compatible frame rate for the requested profile:', {
        profile, mode, codec, reason: availability.reason ?? availability.hardware.reason,
      });
      this.error = t('settings.screenEncodingProfileUnavailable', {
        codec: codec.toUpperCase(), mode: t(mode === 'hardware'
          ? 'settings.screenEncodingHardwareShort' : 'settings.screenEncodingSoftware'),
      });
      this.requested = !automatic && this.savedPreferences().encodingStrategy === 'automatic' ? preferences : null;
      this.rejected?.();
      this.selectionKey = this.key();
      this.clearToast = showInfoToast(this.error);
    } catch (error) {
      if (!current()) return;
      checkedCurrent = true;
      console.warn('[ScreenEncoding] Encoder verification failed:', error);
      this.availability = null;
      this.error = t('settings.screenEncodingProbeFailed');
      if (!automatic) this.choices.set(`${mode}:${codec}`, { error: this.error });
      this.requested = !automatic && this.savedPreferences().encodingStrategy === 'automatic' ? preferences : null;
      this.rejected?.();
      this.selectionKey = this.key();
      this.clearToast = showInfoToast(this.error);
    } finally {
      if (!probe.signal.aborted && this.probe === probe) {
        this.pending = false;
        this.render();
        this.changed();
        if (checkedCurrent && this.preferences().encodingStrategy === 'manual')
          await this.discoverChoices(probe);
      }
    }
  }

  private async discoverChoices(probe: AbortController): Promise<void> {
    const profile = this.profile();
    if (!profile) return;
    const profileKey = JSON.stringify(profile), key = this.key(profile), saved = JSON.stringify(this.savedPreferences());
    if (this.choicesProfile !== profileKey) {
      this.choices.clear();
      this.choicesProfile = profileKey;
    }
    const current = () => !probe.signal.aborted && this.probe === probe && !!this.container?.isConnected
      && JSON.stringify(this.profile()) === profileKey && this.key() === key
      && JSON.stringify(this.savedPreferences()) === saved;
    this.checkingChoices = true;
    this.render();
    try {
      for (const mode of ['hardware', 'software'] as const) {
        for (const codec of ['h264', 'av1'] as const) {
          if (!current()) return;
          if (this.choice(mode, codec)) continue;
          let result: CheckedEncoding;
          try { result = await this.check(profile, { encodingStrategy: 'manual', encodingMode: mode, codec }, probe.signal); }
          catch (error) {
            if (!current()) return;
            console.warn('[ScreenEncoding] Alternative encoder verification failed:', error);
            result = { error: t('settings.screenEncodingProbeFailed') };
          }
          if (!current()) return;
          this.choices.set(`${mode}:${codec}`, result);
          this.render();
        }
      }
    } finally {
      if (current()) { this.checkingChoices = false; this.render(); }
    }
  }

  get ready(): boolean { return !this.pending && this.availability?.selection !== null && !!this.availability; }

  private render(): void {
    const preferences = this.preferences();
    const automatic = preferences.encodingStrategy === 'automatic';
    const selection = this.availability?.selection;
    const selectedMode = automatic ? selection?.mode : preferences.encodingMode;
    for (const strategy of ['automatic', 'manual'] as const)
      this.container?.querySelector(`#screen-encoding-${strategy}`)?.setAttribute('aria-pressed',
        String(preferences.encodingStrategy === strategy));
    const hardware = this.container?.querySelector<HTMLButtonElement>('#screen-encoding-hardware');
    const software = this.container?.querySelector<HTMLButtonElement>('#screen-encoding-software');
    if (hardware) {
      const choice = this.choice('hardware', this.modeCodec('hardware'));
      hardware.disabled = automatic || !!choice && !('error' in choice) && !choice.availability.selection;
      hardware.setAttribute('aria-pressed', String(selectedMode === 'hardware'));
      hardware.setAttribute('aria-describedby', 'screen-encoding-status');
    }
    if (software) {
      const choice = this.choice('software', this.modeCodec('software'));
      software.disabled = automatic || !!choice && !('error' in choice) && !choice.availability.selection;
      software.setAttribute('aria-pressed', String(selectedMode === 'software'));
    }
    const codec = this.container?.querySelector<HTMLSelectElement>('#select-video-codec');
    if (codec) {
      codec.disabled = automatic;
      codec.setAttribute('aria-readonly', String(automatic));
      for (const value of ['h264', 'av1'] as const) {
        const option = codec.querySelector<HTMLOptionElement>(`option[value="${value}"]`);
        if (!option) continue;
        const choice = this.choice(preferences.encodingMode, value);
        option.disabled = !automatic && !!choice && !('error' in choice) && !choice.availability.selection;
        const label = t(value === 'av1' ? 'settings.codecAv1' : 'settings.codecH264');
        const explanation = automatic ? '' : this.choiceText(preferences.encodingMode, value, choice);
        option.textContent = !automatic && (!choice || 'error' in choice || !choice.availability.selection)
          ? `${label} — ${!choice && (this.pending || this.checkingChoices) ? t('common.loading') : !choice || 'error' in choice
            ? t('settings.screenEncodingRetry') : t('screenShare.unavailable')}` : label;
        option.title = explanation;
      }
      codec.value = automatic ? selection?.codec ?? '' : preferences.codec;
      if (!automatic && codec.querySelector<HTMLOptionElement>(`option[value="${preferences.codec}"]`)?.disabled) codec.value = '';
    }
    for (const mode of ['hardware', 'software'] as const) {
      const label = this.container?.querySelector(`#screen-encoding-${mode}-choice`);
      if (label) label.textContent = automatic ? '' : this.choiceText(mode, this.modeCodec(mode), this.choice(mode, this.modeCodec(mode)));
    }
    const choices = this.container?.querySelector('#screen-encoding-choices');
    if (choices) {
      choices.setAttribute('aria-busy', String(this.checkingChoices));
      choices.textContent = automatic ? '' : this.checkingChoices ? t('settings.screenEncodingCheckingChoices')
        : (['h264', 'av1'] as const).flatMap(codec => {
          const choice = this.choice(preferences.encodingMode, codec);
          return choice && ('error' in choice || !choice.availability.selection)
            ? [this.choiceText(preferences.encodingMode, codec, choice)] : [];
        }).join(' ');
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
    this.requested = null;
    this.choices.clear();
    this.choicesProfile = '';
    this.checkingChoices = false;
    this.events?.abort();
    this.probe?.abort();
    this.events = null;
    this.probe = null;
    this.container = null;
  }
}
