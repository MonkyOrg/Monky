import limiterUrl from '../audio/soundboardLimiter.worklet.js?url&no-inline';
import { settingsStore } from '../stores/settingsStore';
import { setAudioOutputSink } from './AudioOutputSink';

interface SoundboardGraph {
  context: AudioContext;
  mixer: GainNode;
  gate: GainNode;
  limiter: AudioWorkletNode | null;
  failure: Error | null;
}

interface SoundboardSource {
  node: MediaElementAudioSourceNode | null;
  release: (drain?: boolean) => void;
}

export class SoundboardAudioOutput {
  private graph: SoundboardGraph | null = null;
  private ready: Promise<SoundboardGraph> | null = null;
  private sources = new Map<HTMLAudioElement, SoundboardSource>();
  private volume = 1;
  private sinkId = settingsStore.selectedSpeakerId;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private preparations = 0;

  constructor(private readonly onIntensity: (value: number | null) => void) {}

  private getGraph(): Promise<SoundboardGraph> {
    if (this.ready) return this.ready;
    const context = new AudioContext({ latencyHint: 'interactive' });
    const mixer = context.createGain();
    mixer.channelCount = 2;
    mixer.channelCountMode = 'explicit';
    const graph: SoundboardGraph = { context, mixer, gate: context.createGain(), limiter: null, failure: null };
    this.graph = graph;
    this.setVolume(this.volume);
    this.ready = (async () => {
      if (!context.audioWorklet) throw new Error('Soundboard audio processing requires AudioWorklet');
      await context.audioWorklet.addModule(limiterUrl);
      if (this.graph !== graph || context.state === 'closed') {
        throw new DOMException('Soundboard audio processing was cancelled', 'AbortError');
      }
      const limiter = new AudioWorkletNode(context, 'monky-soundboard-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      graph.limiter = limiter;
      limiter.onprocessorerror = () => {
        graph.failure = new Error('Soundboard audio limiter processor failed');
        graph.gate.gain.value = 0;
        this.onIntensity(null);
        console.error('[Soundboard] Audio limiter processor failed; playback was stopped.');
        for (const audio of [...this.sources.keys()]) audio.dispatchEvent(new Event('error'));
      };
      limiter.port.onmessage = (event: MessageEvent<unknown>) => {
        if (this.graph !== graph || graph.failure) return;
        const data = event.data;
        if (data === 'invalid-samples') {
          console.warn('[Soundboard] Non-finite audio samples were silenced.');
          return;
        }
        if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'intensity'
          || !('value' in data) || typeof data.value !== 'number' || !Number.isFinite(data.value) || data.value < 0) {
          console.warn('[Soundboard] Invalid intensity report from the audio processor.');
          this.onIntensity(null);
          return;
        }
        this.onIntensity(this.volume > 0 ? data.value : 0);
      };
      mixer.connect(limiter);
      limiter.connect(graph.gate);
      graph.gate.connect(context.destination);
      this.updateLimiter();
      await setAudioOutputSink(context, this.sinkId);
      return graph;
    })();
    return this.ready;
  }

  public async prepareLimiter(): Promise<void> {
    this.preparations++;
    try {
      await this.getGraph();
    } finally {
      this.preparations--;
      this.closeIfIdle();
    }
  }

  public async connect(audio: HTMLAudioElement, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.sources.has(audio)) throw new Error('Soundboard audio is already connected');
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    const source: SoundboardSource = {
      node: null,
      release: (drain = false) => {
        signal.removeEventListener('abort', onAbort);
        source.node?.disconnect();
        source.node = null;
        if (this.sources.get(audio) === source) {
          this.sources.delete(audio);
          this.closeIfIdle(drain);
        }
      },
    };
    const onAbort = () => source.release();
    this.sources.set(audio, source);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const graph = await this.getGraph();
      signal.throwIfAborted();
      if (this.graph !== graph) throw new DOMException('Soundboard playback was closed', 'AbortError');
      if (graph.failure) throw graph.failure;
      source.node = graph.context.createMediaElementSource(audio);
      audio.volume = 1;
      source.node.connect(graph.mixer);
      await graph.context.resume();
      signal.throwIfAborted();
      if (graph.failure) throw graph.failure;
    } catch (error: unknown) {
      source.release();
      throw error;
    }
  }

  public disconnect(audio: HTMLAudioElement, drain = false): void {
    this.sources.get(audio)?.release(drain);
  }

  public setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Invalid soundboard playback volume');
    this.volume = volume;
    if (this.graph) {
      this.graph.mixer.gain.value = volume;
      this.graph.gate.gain.value = volume === 0 ? 0 : 1;
      if (volume === 0) this.onIntensity(0);
    }
  }

  public updateLimiter(): void {
    const node = this.graph?.limiter;
    if (!node) return;
    const enabled = node.parameters.get('enabled');
    const ceiling = node.parameters.get('limitLevel');
    if (!enabled || !ceiling) throw new Error('Soundboard limiter parameters are unavailable');
    enabled.value = settingsStore.soundboardLimiterEnabled ? 1 : 0;
    ceiling.value = settingsStore.soundboardLoudnessLimit;
  }

  public async setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId;
    if (this.graph) await setAudioOutputSink(this.graph.context, sinkId);
  }

  private closeIfIdle(drain = false): void {
    if (this.sources.size || this.preparations || !this.graph) return;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (drain) {
      const context = this.graph.context;
      const latency = context.baseLatency + (Number.isFinite(context.outputLatency) ? context.outputLatency : 0);
      // The limiter buffers two 50 ms blocks, including the end of short clips.
      this.closeTimer = setTimeout(() => { this.closeTimer = null; this.closeIfIdle(); }, (latency + 0.12) * 1000);
      return;
    }
    const graph = this.graph;
    this.graph = null;
    this.ready = null;
    this.onIntensity(null);
    graph.mixer.disconnect();
    graph.gate.disconnect();
    if (graph.limiter) {
      graph.limiter.onprocessorerror = null;
      graph.limiter.port.onmessage = null;
      graph.limiter.port.close();
      graph.limiter.disconnect();
    }
    if (graph.context.state !== 'closed') {
      void graph.context.close().catch((error: unknown) => console.warn('[Soundboard] Could not close audio output:', error));
    }
  }
}
