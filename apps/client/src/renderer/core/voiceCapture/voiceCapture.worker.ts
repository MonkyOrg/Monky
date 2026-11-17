import {
  LinearResampler, SampleQueue, SampleTimeline, VOICE_BLOCK_SIZE, VOICE_CHUNK_SIZE, VOICE_SAMPLE_RATE, downmix,
} from './audioFrames';
import type { SuppressionAssets, VoiceCaptureRequest, VoiceCaptureResponse } from './voiceCaptureProtocol';

declare const self: {
  addEventListener(type: 'message', listener: (event: MessageEvent<VoiceCaptureRequest>) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void;
  postMessage(message: VoiceCaptureResponse): void;
  close(): void;
};

interface EngineOptions {
  processorOptions: { maxChannels: number; wasmBinary: ArrayBuffer };
}

/** The noise-suppression engines' AudioWorkletProcessor, as this worker drives it. */
interface EngineProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  destroy(): void;
}

type EngineConstructor = new (options: EngineOptions) => EngineProcessor;

/**
 * The engines are AudioWorklet scripts. This scope provides what they use, so
 * the same scripts run here, paced by the microphone instead of by the
 * output device's audio clock.
 */
const engines = new Map<string, EngineConstructor>();
class WorkletProcessorScope {
  public readonly port = new MessageChannel().port1;
}
Object.assign(globalThis, {
  sampleRate: VOICE_SAMPLE_RATE,
  AudioWorkletProcessor: WorkletProcessorScope,
  registerProcessor: (name: string, processor: EngineConstructor) => engines.set(name, processor),
});

// Engines initialize their WebAssembly asynchronously and report failure only as an unhandled rejection.
const initializing = new Set<(reason: unknown) => void>();
self.addEventListener('unhandledrejection', (event) => {
  if (initializing.size === 0) return;
  event.preventDefault();
  for (const reject of initializing) reject(event.reason);
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves once the engine assigned its WebAssembly processor, which it does after construction. */
function engineReady(engine: EngineProcessor): Promise<void> {
  return new Promise((resolve, reject) => {
    let processor: unknown;
    const settle = (error?: unknown) => {
      initializing.delete(fail);
      if (error === undefined) resolve();
      else reject(error);
    };
    const fail = (reason: unknown) => settle(reason ?? new Error('Noise suppression failed to start'));
    initializing.add(fail);
    Object.defineProperty(engine, 'processor', {
      configurable: true,
      get: () => processor,
      set: (value: unknown) => {
        processor = value;
        if (value) settle();
      },
    });
  });
}

class VoiceCaptureWorker {
  private reader: ReadableStreamDefaultReader<AudioData> | null = null;
  private output: WritableStreamDefaultWriter<AudioData> | null = null;
  private level: WritableStreamDefaultWriter<AudioData> | null = null;
  private levelBusy = false;
  private gain = 1;
  private engine: EngineProcessor | null = null;
  private readonly prepared = new Map<number, EngineProcessor | null>();
  private readonly discarded = new Set<number>();
  private failed = false;
  private disposed = false;
  private readonly resampler = new LinearResampler();
  private readonly input = new SampleQueue();
  private readonly processed = new SampleQueue();
  private readonly timeline = new SampleTimeline();
  private readonly block = new Float32Array(VOICE_BLOCK_SIZE);
  private readonly result = new Float32Array(VOICE_BLOCK_SIZE);

  public receive(request: VoiceCaptureRequest): void {
    if (this.disposed) return;
    switch (request.type) {
      case 'init':
        this.output = request.output.getWriter();
        this.level = request.level.getWriter();
        this.gain = request.gain;
        this.setInput(request.readable);
        return;
      case 'input':
        this.setInput(request.readable);
        return;
      case 'prepare':
        void this.prepare(request.id, request.assets);
        return;
      case 'commit':
        this.commit(request.id);
        return;
      case 'discard':
        this.discard(request.id);
        return;
      case 'gain':
        this.gain = request.value;
        return;
      case 'dispose':
        this.dispose();
    }
  }

  private setInput(readable: ReadableStream<AudioData>): void {
    const previous = this.reader;
    const reader = readable.getReader();
    this.reader = reader;
    if (previous) void previous.cancel().catch(() => undefined);
    void this.pump(reader);
  }

  private async pump(reader: ReadableStreamDefaultReader<AudioData>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (this.reader !== reader || this.disposed) {
          value.close();
          return;
        }
        await this.handle(value);
      }
    } catch (error) {
      if (this.reader === reader && !this.disposed) this.fail(error);
    }
  }

  private async handle(frame: AudioData): Promise<void> {
    const frames = frame.numberOfFrames;
    const timestamp = frame.timestamp;
    const rate = frame.sampleRate;
    let samples: Float32Array;
    try {
      const planes: Float32Array[] = [];
      for (let plane = 0; plane < frame.numberOfChannels; plane++) {
        const data = new Float32Array(frames);
        frame.copyTo(data, { planeIndex: plane, format: 'f32-planar' });
        planes.push(data);
      }
      samples = downmix(planes, frames);
    } finally {
      frame.close();
    }
    this.input.push(this.resampler.process(samples, rate));
    while (this.input.take(this.block)) {
      if (this.failed) continue;
      try {
        this.result.fill(0);
        if (this.engine) this.engine.process([[this.block]], [[this.result]]);
        else this.result.set(this.block);
      } catch (error) {
        this.fail(error);
        continue;
      }
      this.processed.push(this.result);
    }
    if (!this.output) return;
    for (;;) {
      const voice = new Float32Array(VOICE_CHUNK_SIZE);
      if (!this.processed.take(voice)) return;
      const stamp = this.timeline.stamp(timestamp, voice.length);
      this.writeLevel(voice, stamp);
      if (this.gain !== 1) {
        for (let index = 0; index < voice.length; index++) voice[index] *= this.gain;
      }
      await this.output.write(audioData(voice, stamp));
    }
  }

  /** The meter never holds back transmission: a chunk is dropped while the previous one is still being written. */
  private writeLevel(voice: Float32Array<ArrayBuffer>, timestamp: number): void {
    if (!this.level || this.levelBusy) return;
    this.levelBusy = true;
    this.level.write(audioData(voice.slice(), timestamp))
      .catch(() => undefined)
      .finally(() => { this.levelBusy = false; });
  }

  private async prepare(id: number, assets: SuppressionAssets | null): Promise<void> {
    let engine: EngineProcessor | null = null;
    try {
      if (assets) {
        await import(/* @vite-ignore */ assets.scriptUrl);
        const Engine = engines.get(`@sapphi-red/web-noise-suppressor/${assets.mode}`);
        if (!Engine) throw new Error(`Noise suppression engine ${assets.mode} did not register`);
        engine = new Engine({ processorOptions: { maxChannels: 1, wasmBinary: assets.wasmBinary } });
        await engineReady(engine);
      }
      if (this.disposed || this.discarded.delete(id)) {
        engine?.destroy();
        return;
      }
      this.prepared.set(id, engine);
      self.postMessage({ type: 'prepared', id });
    } catch (error) {
      engine?.destroy();
      this.discarded.delete(id);
      if (!this.disposed) self.postMessage({ type: 'prepare-failed', id, message: message(error) });
    }
  }

  private commit(id: number): void {
    if (!this.prepared.has(id)) return;
    const next = this.prepared.get(id) ?? null;
    this.prepared.delete(id);
    this.engine?.destroy();
    this.engine = next;
    this.failed = false;
  }

  private discard(id: number): void {
    if (!this.prepared.has(id)) {
      this.discarded.add(id);
      return;
    }
    this.prepared.get(id)?.destroy();
    this.prepared.delete(id);
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    self.postMessage({ type: 'failed', message: message(error) });
  }

  private dispose(): void {
    this.disposed = true;
    const reader = this.reader;
    this.reader = null;
    if (reader) void reader.cancel().catch(() => undefined);
    for (const writer of [this.output, this.level]) void writer?.close().catch(() => undefined);
    this.output = null;
    this.level = null;
    this.engine?.destroy();
    this.engine = null;
    for (const engine of this.prepared.values()) engine?.destroy();
    this.prepared.clear();
    self.close();
  }
}

function audioData(data: Float32Array<ArrayBuffer>, timestamp: number): AudioData {
  return new AudioData({
    format: 'f32-planar', sampleRate: VOICE_SAMPLE_RATE, numberOfFrames: data.length, numberOfChannels: 1, timestamp, data,
  });
}

const worker = new VoiceCaptureWorker();
self.addEventListener('message', (event) => worker.receive(event.data));
