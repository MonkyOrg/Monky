import VoiceCaptureWorker from './voiceCapture.worker?worker';
import { VOICE_SAMPLE_RATE } from './audioFrames';
import type { VoiceCaptureRequest, VoiceCaptureResponse } from './voiceCaptureProtocol';
import {
  createNoiseSuppressor, destroyNoiseSuppressor, loadNoiseSuppressorAssets, type NoiseSuppressorNode,
} from '../NoiseSuppression';
import type { NoiseSuppressionMode, WorkletNoiseSuppressionMode } from '../../utils/audioPreferences';

declare const MediaStreamTrackProcessor: {
  new(options: { track: MediaStreamTrack }): { readable: ReadableStream<AudioData> };
} | undefined;

declare const MediaStreamTrackGenerator: {
  new(options: { kind: 'audio' }): MediaStreamTrack & { readonly writable: WritableStream<AudioData> };
} | undefined;

/** A noise-suppression engine loaded and ready, not yet carrying the voice. */
export interface PreparedSuppression {
  commit(): void;
  cancel(): void;
}

/**
 * Microphone processing: noise suppression, input volume and the level meter.
 * `output` is the stable track sent to calls; `analyser` reads the voice before the volume.
 */
export interface MicrophoneChain {
  readonly pipeline: 'worker' | 'webaudio';
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly output: MediaStream;
  /** The engine processing the voice, or null for browser suppression or none. */
  readonly suppression: WorkletNoiseSuppressionMode | null;
  start(mode: NoiseSuppressionMode): Promise<void>;
  setInput(stream: MediaStream): void;
  prepareSuppression(mode: NoiseSuppressionMode): Promise<PreparedSuppression>;
  setVolume(volume: number): void;
  destroy(): void;
}

interface ChainOptions {
  volume: number;
  onFailure: () => void;
}

function engineMode(mode: NoiseSuppressionMode): WorkletNoiseSuppressionMode | null {
  return mode === 'browser' || mode === 'off' ? null : mode;
}

function cancelled(): DOMException {
  return new DOMException('Microphone processing was cancelled', 'AbortError');
}

function audioTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('Microphone stream has no audio track');
  return track;
}

function createMeter(): { context: AudioContext; analyser: AnalyserNode } {
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.25;
  return { context, analyser };
}

function settleOnce(action: () => void): () => void {
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    action();
  };
}

/**
 * Processes the voice in a worker paced by the microphone itself. An
 * AudioContext follows the output device's clock instead: when that clock runs
 * slow, Web Audio drops microphone samples and the voice arrives late,
 * robotic and cut. Only the level meter still uses an AudioContext.
 */
class WorkerMicrophoneChain implements MicrophoneChain {
  public readonly pipeline = 'worker';
  public readonly context: AudioContext;
  public readonly analyser: AnalyserNode;
  public readonly output: MediaStream;
  public suppression: WorkletNoiseSuppressionMode | null = null;
  private readonly worker: Worker;
  private readonly transmitted: MediaStreamTrack;
  private readonly level: MediaStreamTrack;
  private readonly levelSource: MediaStreamAudioSourceNode;
  private readonly pending = new Map<number, { resolve: () => void; reject: (error: unknown) => void }>();
  private nextPreparation = 0;
  private destroyed = false;

  public constructor(raw: MediaStream, private readonly options: ChainOptions) {
    if (typeof MediaStreamTrackProcessor !== 'function' || typeof MediaStreamTrackGenerator !== 'function') {
      throw new Error('Worker microphone processing is unavailable');
    }
    const transmitted = new MediaStreamTrackGenerator({ kind: 'audio' });
    const level = new MediaStreamTrackGenerator({ kind: 'audio' });
    let worker: Worker | null = null;
    try {
      const { readable } = new MediaStreamTrackProcessor({ track: audioTrack(raw) });
      worker = new VoiceCaptureWorker();
      const init: VoiceCaptureRequest = {
        type: 'init', readable, output: transmitted.writable, level: level.writable, gain: options.volume / 100,
      };
      worker.postMessage(init, [readable, transmitted.writable, level.writable]);
    } catch (error) {
      worker?.terminate();
      transmitted.stop();
      level.stop();
      throw error;
    }
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<VoiceCaptureResponse>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.crash(new Error(event.message || 'Microphone processing worker failed'));
    };
    this.worker.onmessageerror = () => this.crash(new Error('Microphone processing message failed'));
    this.transmitted = transmitted;
    this.level = level;
    this.output = new MediaStream([transmitted]);
    ({ context: this.context, analyser: this.analyser } = createMeter());
    this.levelSource = this.context.createMediaStreamSource(new MediaStream([level]));
    this.levelSource.connect(this.analyser);
  }

  public async start(mode: NoiseSuppressionMode): Promise<void> {
    // The meter must not hold back transmission when the output device is slow or stuck.
    void this.context.resume().catch(() => undefined);
    (await this.prepareSuppression(mode)).commit();
  }

  public setInput(stream: MediaStream): void {
    if (this.destroyed) throw cancelled();
    const { readable } = new MediaStreamTrackProcessor!({ track: audioTrack(stream) });
    this.send({ type: 'input', readable }, [readable]);
  }

  public async prepareSuppression(mode: NoiseSuppressionMode): Promise<PreparedSuppression> {
    if (this.destroyed) throw cancelled();
    const assets = await loadNoiseSuppressorAssets(mode);
    if (this.destroyed) throw cancelled();
    const id = ++this.nextPreparation;
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ type: 'prepare', id, assets });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return {
      commit: settleOnce(() => {
        if (this.destroyed) return;
        this.send({ type: 'commit', id });
        this.suppression = engineMode(mode);
      }),
      cancel: settleOnce(() => {
        if (!this.destroyed) this.send({ type: 'discard', id });
      }),
    };
  }

  public setVolume(volume: number): void {
    if (!this.destroyed) this.send({ type: 'gain', value: volume / 100 });
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rejectPending(cancelled());
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.transmitted.stop();
    this.level.stop();
    this.levelSource.disconnect();
    this.analyser.disconnect();
    if (this.context.state !== 'closed') this.context.close().catch(() => undefined);
  }

  private send(request: VoiceCaptureRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(request, transfer);
  }

  private receive(response: VoiceCaptureResponse): void {
    if (this.destroyed) return;
    switch (response.type) {
      case 'prepared': {
        const pending = this.pending.get(response.id);
        this.pending.delete(response.id);
        pending?.resolve();
        return;
      }
      case 'prepare-failed': {
        const pending = this.pending.get(response.id);
        this.pending.delete(response.id);
        pending?.reject(new Error(response.message));
        return;
      }
      case 'failed':
        console.warn('[MicrophoneChain] Voice processing failed:', response.message);
        this.options.onFailure();
    }
  }

  private crash(error: Error): void {
    if (this.destroyed) return;
    console.warn('[MicrophoneChain] Voice processing worker failed:', error);
    this.rejectPending(error);
    this.options.onFailure();
  }

  private rejectPending(error: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of pending) reject(error);
  }
}

/** Web Audio processing, for browsers without MediaStreamTrackProcessor (the web version outside Chromium). */
class WebAudioMicrophoneChain implements MicrophoneChain {
  public readonly pipeline = 'webaudio';
  public readonly context: AudioContext;
  public readonly analyser: AnalyserNode;
  public readonly output: MediaStream;
  public suppression: WorkletNoiseSuppressionMode | null = null;
  private source: MediaStreamAudioSourceNode;
  private readonly gain: GainNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  private node: NoiseSuppressorNode | null = null;
  private destroyed = false;

  public constructor(raw: MediaStream, private readonly options: ChainOptions) {
    ({ context: this.context, analyser: this.analyser } = createMeter());
    this.destination = this.context.createMediaStreamDestination();
    this.gain = this.context.createGain();
    this.gain.gain.value = options.volume / 100;
    this.gain.connect(this.destination);
    this.source = this.context.createMediaStreamSource(raw);
    this.output = this.destination.stream;
  }

  public async start(mode: NoiseSuppressionMode): Promise<void> {
    await this.context.resume();
    if (this.destroyed) throw cancelled();
    (await this.prepareSuppression(mode)).commit();
  }

  public setInput(stream: MediaStream): void {
    if (this.destroyed) throw cancelled();
    const source = this.context.createMediaStreamSource(stream);
    this.connectSource(source, this.node);
    this.source.disconnect();
    this.source = source;
  }

  public async prepareSuppression(mode: NoiseSuppressionMode): Promise<PreparedSuppression> {
    if (this.destroyed) throw cancelled();
    const node = await createNoiseSuppressor(this.context, mode);
    if (this.destroyed) {
      destroyNoiseSuppressor(node);
      throw cancelled();
    }
    return {
      commit: settleOnce(() => {
        if (this.destroyed) {
          destroyNoiseSuppressor(node);
          return;
        }
        if (node) {
          node.connect(this.gain);
          node.connect(this.analyser);
          node.onprocessorerror = () => {
            if (this.node === node && !this.destroyed) this.options.onFailure();
          };
        }
        this.source.disconnect();
        this.connectSource(this.source, node);
        destroyNoiseSuppressor(this.node);
        this.node = node;
        this.suppression = engineMode(mode);
      }),
      cancel: settleOnce(() => destroyNoiseSuppressor(node)),
    };
  }

  public setVolume(volume: number): void {
    this.gain.gain.value = volume / 100;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    destroyNoiseSuppressor(this.node);
    this.node = null;
    for (const node of [this.source, this.analyser, this.gain, this.destination]) {
      try {
        node.disconnect();
      } catch {}
    }
    this.output.getTracks().forEach((track) => track.stop());
    if (this.context.state !== 'closed') this.context.close().catch(() => undefined);
  }

  private connectSource(source: MediaStreamAudioSourceNode, node: NoiseSuppressorNode | null): void {
    if (node) {
      source.connect(node);
      return;
    }
    source.connect(this.gain);
    source.connect(this.analyser);
  }
}

function supportsWorkerProcessing(): boolean {
  return typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function'
    && typeof AudioData === 'function' && typeof Worker === 'function';
}

export function createMicrophoneChain(raw: MediaStream, options: ChainOptions): MicrophoneChain {
  if (supportsWorkerProcessing()) {
    try {
      return new WorkerMicrophoneChain(raw, options);
    } catch (error) {
      console.warn('[MicrophoneChain] Worker processing unavailable; using Web Audio.', error);
    }
  }
  return new WebAudioMicrophoneChain(raw, options);
}
