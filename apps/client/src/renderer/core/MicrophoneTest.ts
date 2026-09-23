import { appEvents } from './EventBus';
import { bindMicrophoneLevelMeter } from './MicrophoneLevelMeter';
import { settingsStore } from '../stores/settingsStore';

type StopReason = 'device-changed' | 'disconnected';

export type MicrophoneTestState =
  | { status: 'stopped'; reason?: StopReason }
  | { status: 'starting' }
  | { status: 'playing' }
  | { status: 'error'; error: unknown };

/** Explicit, local loopback only. The shared preview owns capture and never changes RTC tracks. */
export class MicrophoneTest {
  private active = false;
  private destroyed = false;
  private generation = 0;
  private playback: HTMLAudioElement | null = null;
  private unbindMeter: (() => void) | null = null;
  private unbind: Array<() => void> = [];
  private inputId = '';
  private outputId = '';

  constructor(private readonly meter: HTMLElement, private readonly onState: (state: MicrophoneTestState) => void) {
    const devicesChanged = () => this.stop('device-changed');
    const visibilityChanged = () => { if (document.hidden) this.stop(); };
    this.unbind = [
      appEvents.on('settings.updated', () => {
        if (this.active && (this.inputId !== settingsStore.selectedMicrophoneId || this.outputId !== settingsStore.selectedSpeakerId)) {
          this.stop('device-changed');
        }
      }),
      appEvents.on('voice.channel_changed', () => this.stop('disconnected')),
      appEvents.on('network.disconnected', () => this.stop('disconnected')),
    ];
    navigator.mediaDevices?.addEventListener('devicechange', devicesChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    const onMutation = () => {
      if (!meter.isConnected) this.destroy();
      else if (this.active && this.isHidden()) this.stop();
    };
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    const visibilityObserver = new MutationObserver(onMutation);
    for (let parent = meter.parentElement; parent; parent = parent.parentElement) {
      visibilityObserver.observe(parent, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
    }
    this.unbind.push(
      () => navigator.mediaDevices?.removeEventListener('devicechange', devicesChanged),
      () => document.removeEventListener('visibilitychange', visibilityChanged),
      () => observer.disconnect(),
      () => visibilityObserver.disconnect(),
    );
  }

  private isHidden(): boolean {
    for (let element: HTMLElement | null = this.meter; element; element = element.parentElement) {
      if (element.hidden || getComputedStyle(element).display === 'none') return true;
    }
    return false;
  }

  public toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  public start(): void {
    if (this.active || this.destroyed || !this.meter.isConnected || this.isHidden()) return;
    this.active = true;
    this.inputId = settingsStore.selectedMicrophoneId;
    this.outputId = settingsStore.selectedSpeakerId;
    this.onState({ status: 'starting' });
    try {
      const unbind = bindMicrophoneLevelMeter(
        this.meter,
        (error) => { if (error && this.active) this.fail(error); },
        (stream) => { void this.setStream(stream); },
      );
      // Binding to an already-ready stream can synchronously fail before bind returns.
      if (this.active) this.unbindMeter = unbind;
      else unbind();
    } catch (error) {
      this.fail(error);
    }
  }

  private releasePlayback(audio: HTMLAudioElement | null): void {
    if (!audio) return;
    audio.onerror = null;
    audio.pause();
    audio.srcObject = null;
    if (this.playback === audio) this.playback = null;
  }

  private async setStream(stream: MediaStream | null): Promise<void> {
    const generation = ++this.generation;
    this.releasePlayback(this.playback);
    if (!stream || !this.active) return;
    let audio: HTMLAudioElement | null = null;
    try {
      audio = new Audio();
      this.playback = audio;
      audio.autoplay = false;
      audio.volume = 0.25;
      audio.srcObject = stream;
      const currentAudio = audio;
      audio.onerror = () => {
        if (this.playback === currentAudio && this.active) this.fail(new Error(currentAudio.error?.message || 'Microphone playback failed'));
      };
      if (typeof audio.setSinkId !== 'function') throw new Error('Audio output selection unavailable');
      await audio.setSinkId(this.outputId === 'default' ? '' : this.outputId);
      if (!this.active || generation !== this.generation) {
        this.releasePlayback(audio);
        return;
      }
      await audio.play();
      if (!this.active || generation !== this.generation) {
        this.releasePlayback(audio);
        return;
      }
      this.onState({ status: 'playing' });
    } catch (error) {
      this.releasePlayback(audio);
      if (this.active && generation === this.generation) this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.stop();
    this.onState({ status: 'error', error });
  }

  public stop(reason?: StopReason): void {
    const wasActive = this.active;
    this.active = false;
    this.generation++;
    this.releasePlayback(this.playback);
    this.unbindMeter?.();
    this.unbindMeter = null;
    const fill = this.meter.querySelector<HTMLElement>('.vad-meter-fill');
    if (fill) {
      fill.style.width = '0%';
      fill.classList.remove('active');
    }
    this.meter.setAttribute('aria-valuenow', '0');
    if (wasActive) this.onState({ status: 'stopped', reason });
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.unbind.forEach((off) => off());
    this.unbind = [];
  }
}
