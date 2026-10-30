import { audioProcessor } from './AudioProcessor';
import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { createNoiseSuppressor, destroyNoiseSuppressor, type NoiseSuppressorNode } from './NoiseSuppression';
import { microphoneConstraints, type NoiseSuppressionMode } from '../utils/audioPreferences';
import { isVoiceActive, speechLevel, VAD_SENSITIVITY_MAX, vadSensitivity } from '../audio/voiceActivity';

interface MeterSubscriber {
  meter: HTMLElement;
  fill: HTMLElement;
  error?: (error: unknown | null) => void;
  streamChanged?: (stream: MediaStream | null) => void;
}

/**
 * One local-only preview graph shared by settings, quick input selection and explicit
 * microphone testing. It always owns its input: in a call, a clone of the call's
 * microphone, whose `enabled` is its own, so mute and push-to-talk neither silence nor
 * restart it and the device is not opened twice; outside a call, its own capture.
 */
class MicrophoneLevelMeter {
  private subscribers = new Set<MeterSubscriber>();
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** The processed preview, which the explicit loopback test plays. */
  private stream: MediaStream | null = null;
  /** The preview's own input tracks, stopped on release. */
  private captureStream: MediaStream | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private suppressor: NoiseSuppressorNode | null = null;
  private mode: NoiseSuppressionMode = settingsStore.noiseSuppressionMode;
  private generation = 0;
  private raf: number | null = null;
  private unbind: Array<() => void> = [];
  private removeEnded: (() => void) | null = null;
  private deviceId = '';
  /** The call's microphone when the preview started, and whether it was cloned. */
  private borrowed: MediaStream | null = null;
  private cloned = false;
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

  /** A call microphone with a live track can be cloned; its `enabled` (mute, push-to-talk) does not matter. */
  private canClone(stream: MediaStream | null): boolean {
    return Boolean(stream?.getAudioTracks().some((track) => track.readyState === 'live'));
  }

  /** The call's microphone was replaced (another device), or came or went: the preview has to follow. */
  private sourceChanged(): boolean {
    const raw = audioProcessor.getRawMicrophoneStream();
    return this.borrowed !== raw || this.cloned !== this.canClone(raw);
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
    // A clone stops alone: the call's own microphone keeps running.
    this.captureStream?.getTracks().forEach((track) => track.stop());
    this.captureStream = null;
    this.stream = null;
    this.borrowed = null;
    this.cloned = false;
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
    this.cloned = this.canClone(this.borrowed);
    this.starting = true;
    void this.start(generation);
  }

  /** The preview's input: a clone of the call's microphone, enabled on its own, or a capture of its own. */
  private async openInput(): Promise<MediaStream> {
    const track = this.cloned ? this.borrowed?.getAudioTracks().find((candidate) => candidate.readyState === 'live') : undefined;
    if (track) {
      const clone = track.clone();
      clone.enabled = true;
      return new MediaStream([clone]);
    }
    return navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(this.deviceId, this.mode), video: false });
  }

  private async start(generation: number): Promise<void> {
    try {
      const stream = await this.openInput();
      if (generation !== this.generation || !this.subscribers.size) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (this.sourceChanged()) {
        stream.getTracks().forEach((track) => track.stop());
        this.restart();
        return;
      }
      this.captureStream = stream;
      this.context = new AudioContext({ sampleRate: 48000 });
      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
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
        const level = speechLevel(buffer);
        const active = isVoiceActive(level, settingsStore.vadSensitivity);
        const threshold = `${vadSensitivity(settingsStore.vadSensitivity) / VAD_SENSITIVITY_MAX * 100}%`;
        for (const { fill, meter } of this.subscribers) {
          fill.style.width = `${Math.min(100, (level.peak / 255) * 100)}%`;
          fill.classList.toggle('active', active);
          meter.setAttribute('aria-valuenow', String(Math.round((level.peak / 255) * 100)));
          const line = meter.querySelector<HTMLElement>('.vad-meter-threshold');
          if (line) line.style.left = threshold;
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
