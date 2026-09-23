import { audioProcessor } from './AudioProcessor';
import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { createNoiseSuppressor, destroyNoiseSuppressor, type NoiseSuppressorNode } from './NoiseSuppression';
import type { NoiseSuppressionMode } from '../utils/audioPreferences';

interface MeterSubscriber {
  meter: HTMLElement;
  fill: HTMLElement;
  error?: (error: unknown | null) => void;
  streamChanged?: (stream: MediaStream | null) => void;
}

/** One local-only preview graph shared by settings, quick input selection and explicit microphone testing. */
class MicrophoneLevelMeter {
  private subscribers = new Set<MeterSubscriber>();
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private captureStream: MediaStream | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private suppressor: NoiseSuppressorNode | null = null;
  private mode: NoiseSuppressionMode = settingsStore.noiseSuppressionMode;
  private owned = false;
  private generation = 0;
  private raf: number | null = null;
  private unbind: Array<() => void> = [];
  private removeEnded: (() => void) | null = null;
  private deviceId = '';
  private borrowed: MediaStream | null = null;
  private usingRaw = false;
  private ready = false;
  private starting = false;

  public bind(meter: HTMLElement, error?: MeterSubscriber['error'], streamChanged?: MeterSubscriber['streamChanged']): () => void {
    const fill = meter.querySelector<HTMLElement>('.vad-meter-fill');
    if (!fill) throw new Error('Microphone level meter requires a .vad-meter-fill element');
    const subscriber = { meter, fill, error, streamChanged };
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) {
      this.deviceId = settingsStore.selectedMicrophoneId;
      const refresh = () => this.restart();
      this.unbind = [
        appEvents.on('settings.updated', () => {
          if (this.deviceId === settingsStore.selectedMicrophoneId && this.mode === settingsStore.noiseSuppressionMode) return;
          this.deviceId = settingsStore.selectedMicrophoneId;
          this.mode = settingsStore.noiseSuppressionMode;
          this.restart();
        }),
        appEvents.on('voice.channel_changed', refresh),
        appEvents.on('voice.microphone_updated', () => {
          if (this.sourceChanged()) this.restart();
        }),
      ];
      navigator.mediaDevices?.addEventListener('devicechange', refresh);
      this.unbind.push(() => navigator.mediaDevices?.removeEventListener('devicechange', refresh));
      this.restart();
    } else if (this.ready) {
      streamChanged?.(this.stream);
    } else if (!this.starting) {
      this.restart();
    }
    return () => {
      this.subscribers.delete(subscriber);
      fill.style.width = '0%';
      fill.classList.remove('active');
      meter.setAttribute('aria-valuenow', '0');
      if (!this.subscribers.size) {
        this.unbind.forEach((off) => off());
        this.unbind = [];
        this.release();
      }
    };
  }

  private notify(error: unknown | null): void {
    for (const subscriber of this.subscribers) subscriber.error?.(error);
  }

  private canUseRaw(stream: MediaStream | null): boolean {
    return Boolean(stream?.getAudioTracks().some((track) => track.readyState === 'live' && track.enabled));
  }

  private sourceChanged(): boolean {
    const raw = audioProcessor.getRawMicrophoneStream();
    return this.borrowed !== raw || this.usingRaw !== this.canUseRaw(raw);
  }

  private release(): void {
    this.generation++;
    this.ready = false;
    this.starting = false;
    for (const subscriber of this.subscribers) subscriber.streamChanged?.(null);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.removeEnded?.();
    this.removeEnded = null;
    this.source?.disconnect();
    this.analyser?.disconnect();
    destroyNoiseSuppressor(this.suppressor);
    this.suppressor = null;
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.destination?.disconnect();
    this.destination = null;
    if (this.owned) this.captureStream?.getTracks().forEach((track) => track.stop());
    this.captureStream = null;
    this.stream = null;
    this.borrowed = null;
    this.usingRaw = false;
    this.owned = false;
    this.source = null;
    this.analyser = null;
    if (this.context && this.context.state !== 'closed') {
      void this.context.close().catch((error: unknown) => console.warn('Could not close microphone preview context:', error));
    }
    this.context = null;
    for (const { fill, meter } of this.subscribers) {
      fill.style.width = '0%';
      fill.classList.remove('active');
      meter.setAttribute('aria-valuenow', '0');
    }
  }

  private restart(): void {
    this.release();
    if (!this.subscribers.size) return;
    const generation = this.generation;
    this.mode = settingsStore.noiseSuppressionMode;
    this.borrowed = audioProcessor.getRawMicrophoneStream();
    this.usingRaw = this.canUseRaw(this.borrowed);
    this.starting = true;
    void this.start(generation);
  }

  private async start(generation: number): Promise<void> {
    try {
      const live = this.borrowed;
      // Muted call tracks stay untouched. A separate local-only preview still lets
      // the user inspect their input without unmuting personal/admin/PTT gates.
      const owned = !(this.usingRaw && live);
      const stream = !owned && live ? audioProcessor.getLocalAudioStream() ?? live : await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: this.mode === 'browser',
          autoGainControl: true,
        },
        video: false,
      });
      if (generation !== this.generation || !this.subscribers.size) {
        if (owned) stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (this.sourceChanged()) {
        if (owned) stream.getTracks().forEach((track) => track.stop());
        this.restart();
        return;
      }
      this.stream = stream;
      this.captureStream = stream;
      this.owned = owned;
      this.context = new AudioContext({ sampleRate: 48000 });
      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      if (owned) {
        const suppressor = await createNoiseSuppressor(this.context, this.mode);
        if (generation !== this.generation) {
          destroyNoiseSuppressor(suppressor);
          return;
        }
        this.suppressor = suppressor;
        this.destination = this.context.createMediaStreamDestination();
        if (suppressor) {
          suppressor.onprocessorerror = () => {
            if (generation !== this.generation) return;
            this.release();
            this.notify(new Error('Microphone preview noise suppression failed'));
          };
          this.source.connect(suppressor);
          suppressor.connect(this.analyser);
          suppressor.connect(this.destination);
        } else {
          this.source.connect(this.analyser);
          this.source.connect(this.destination);
        }
        this.stream = this.destination.stream;
      } else {
        this.source.connect(this.analyser);
      }
      // No connection to context.destination: only the opt-in loopback can play this stream.
      const ended = () => {
        this.release();
        this.notify(new DOMException('Microphone disconnected', 'NotFoundError'));
      };
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', ended));
      this.removeEnded = () => stream.getAudioTracks().forEach((track) => track.removeEventListener('ended', ended));
      await this.context.resume();
      if (generation !== this.generation) return;
      this.ready = true;
      this.starting = false;
      for (const subscriber of this.subscribers) subscriber.streamChanged?.(this.stream);
      if (generation !== this.generation) return;
      this.notify(null);
      if (generation !== this.generation || !this.analyser) return;
      const buffer = new Uint8Array(this.analyser.frequencyBinCount);
      const loop = () => {
        if (generation !== this.generation || !this.analyser) return;
        if (this.sourceChanged()) {
          this.restart();
          return;
        }
        this.analyser.getByteFrequencyData(buffer);
        const speechBins = Math.min(36, buffer.length);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < speechBins; i++) {
          sum += buffer[i];
          peak = Math.max(peak, buffer[i]);
        }
        const average = sum / speechBins;
        const targetAvg = Math.max(16, settingsStore.vadSensitivity * 0.8);
        const targetPeak = Math.max(42, settingsStore.vadSensitivity * 1.8);
        const active = (average > targetAvg && peak > targetPeak) || average > targetAvg * 1.4;
        for (const { fill, meter } of this.subscribers) {
          fill.style.width = `${Math.min(100, (peak / 255) * 100)}%`;
          fill.classList.toggle('active', active);
          meter.setAttribute('aria-valuenow', String(Math.round((peak / 255) * 100)));
          const threshold = meter.querySelector<HTMLElement>('.vad-meter-threshold');
          if (threshold) threshold.style.left = `${Math.min(100, Math.max(0, settingsStore.vadSensitivity / 160 * 100))}%`;
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    } catch (error) {
      if (generation !== this.generation) return;
      this.release();
      this.notify(error);
    }
  }
}

const microphoneLevelMeter = new MicrophoneLevelMeter();

export function bindMicrophoneLevelMeter(
  meter: HTMLElement,
  onError?: (error: unknown | null) => void,
  // The explicit loopback test may observe this stream, but must not modify or stop its tracks.
  onStreamChanged?: (stream: MediaStream | null) => void,
): () => void {
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', '0');
  return microphoneLevelMeter.bind(meter, onError, onStreamChanged);
}
