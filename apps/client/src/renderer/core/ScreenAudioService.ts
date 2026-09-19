/**
 * ScreenAudioService
 *
 * Bridges the native screen audio capture module (via preload IPC) with WebRTC.
 * Receives raw PCM float32 frames from main process, feeds them into an
 * AudioWorklet ring buffer, and outputs a MediaStreamTrack that can be added
 * to peer connections.
 *
 * Includes a test-tone mode (440 Hz sine wave) that bypasses the native module
 * entirely, useful for validating the WebRTC pipeline end-to-end.
 *
 * Part of #55 (screen audio) and #75 (per-user volume).
 */

import { appEvents } from './EventBus';
import { webRtcManager } from './WebRtcManager';
import { callClient } from './serverConnection';
import { voiceStore } from '../stores/voiceStore';
import { MessageType } from '@monky/shared';
import { t } from '../i18n';
import { clientLog } from './ClientLogService';

// Ring-buffer based AudioWorklet processor (inlined as a string so it can be
// loaded via Blob URL without a separate file).
const RING_BUFFER_SIZE = 48000 * 2 * 4; // ~4 s of stereo 48 kHz
const WORKLET_CODE = `
class ScreenAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(${RING_BUFFER_SIZE});
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'pcm-data') {
        const samples = e.data.samples;
        const len = samples.length;
        const cap = this.ring.length;
        for (let i = 0; i < len; i++) {
          this.ring[this.writePos] = samples[i];
          this.writePos = (this.writePos + 1) % cap;
        }
        this.available += len;
        if (this.available > cap) this.available = cap;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const channels = output.length;
    const frameSize = output[0].length;
    const samplesNeeded = frameSize * channels;
    const cap = this.ring.length;

    if (this.available >= samplesNeeded) {
      for (let i = 0; i < frameSize; i++) {
        for (let ch = 0; ch < channels; ch++) {
          output[ch][i] = this.ring[this.readPos];
          this.readPos = (this.readPos + 1) % cap;
        }
      }
      this.available -= samplesNeeded;
    } else {
      for (let ch = 0; ch < channels; ch++) {
        output[ch].fill(0);
      }
    }
    return true;
  }
}
registerProcessor('screen-audio-processor', ScreenAudioProcessor);
`;

// Seconds to wait for the first native frame before warning the user
const FRAME_WATCHDOG_TIMEOUT = 5;

class ScreenAudioService {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;
  private outputTrack: MediaStreamTrack | null = null;
  private isCapturing: boolean = false;
  private isTestTone: boolean = false;
  private frameCount: number = 0;
  private testToneInterval: ReturnType<typeof setInterval> | null = null;
  private frameWatchdog: ReturnType<typeof setTimeout> | null = null;
  private removeFrameListener: (() => void) | null = null;
  private removeErrorListener: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private startPromise: Promise<MediaStreamTrack | null> | null = null;
  private captureEpoch = 0;
  private captureCall: { client: ReturnType<typeof callClient>; isCurrent: () => boolean } | null = null;

  public async isSupported(): Promise<boolean> {
    return window.api.screenAudioSupported();
  }

  /**
   * Return diagnostic information about the screen audio subsystem.
   */
  public async diagnose(): Promise<Record<string, unknown>> {
    const supported = await this.isSupported();
    const diag = await window.api.screenAudioDiagnose();
    return {
      nativeModuleLoaded: diag.nativeModuleLoaded,
      platformSupported: supported,
      osVersion: diag.osVersion,
      isCapturing: this.isCapturing,
      isTestTone: this.isTestTone,
      framesReceived: this.frameCount,
    };
  }

  // ────────────────────────────────────────────
  //  Shared pipeline setup (used by both modes)
  // ────────────────────────────────────────────

  private async setupPipeline(): Promise<void> {
    this.audioContext = new AudioContext({ sampleRate: 48000 });
    // A suspended context produces a silent output track even though frames are
    // being fed to the worklet. Ensure it is running.
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.audioContext.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.workletNode = new AudioWorkletNode(this.audioContext, 'screen-audio-processor', {
      outputChannelCount: [2],
      numberOfOutputs: 1,
    });

    this.destinationNode = this.audioContext.createMediaStreamDestination();
    this.workletNode.connect(this.destinationNode);
    this.outputTrack = this.destinationNode.stream.getAudioTracks()[0];
    this.frameCount = 0;
  }

  private feedSamples(float32: Float32Array): void {
    if (!this.workletNode) return;
    const copy = new Float32Array(float32);
    this.workletNode.port.postMessage({ type: 'pcm-data', samples: copy }, [copy.buffer]);
  }

  // ────────────────────────────────────────────
  //  Native capture mode
  // ────────────────────────────────────────────

  public start(sourceId?: string): Promise<MediaStreamTrack | null> {
    return this.runStart(isCurrent => this.startNativeCapture(isCurrent, sourceId));
  }

  private async startNativeCapture(isCurrent: () => boolean, sourceId?: string): Promise<MediaStreamTrack | null> {
    const supported = await this.isSupported();
    if (!isCurrent()) return null;
    if (!supported) {
      clientLog.warn('MEDIA', 'Screen audio not supported on this platform');
      console.warn('[ScreenAudio] Not supported on this platform');
      appEvents.emit('screen_audio.error', t('screenAudio.unsupportedWindows'));
      return null;
    }

    await this.setupPipeline();
    if (!isCurrent()) return null;

    // Listen for PCM frames from the native module via preload.
    this.removeFrameListener = window.api.onScreenAudioFrame((buffer: ArrayBuffer | Uint8Array) => {
      if (!this.workletNode) return;

      let float32: Float32Array;
      if (buffer instanceof ArrayBuffer) {
        float32 = new Float32Array(buffer);
      } else {
        float32 = new Float32Array(
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        );
      }

      if (this.frameCount === 0) {
        console.log(`[ScreenAudio] First native frame: ${float32.length} samples`);
        this.clearFrameWatchdog();
      }
      this.frameCount++;
      this.feedSamples(float32);
    });

    // Listen for asynchronous native errors (e.g. device disconnect / invalidation)
    if (window.api.onScreenAudioError) {
      this.removeErrorListener = window.api.onScreenAudioError((errorMsg: string) => {
        console.warn('[ScreenAudio] Asynchronous error from native capture:', errorMsg);
        appEvents.emit('screen_audio.error', errorMsg);
        void this.stop();
      });
    }

    const result = await window.api.screenAudioStart(sourceId);
    if (!result.success) {
      clientLog.error('MEDIA', 'Failed to start native screen audio capture', { error: result.error });
      console.error('[ScreenAudio] Failed to start native capture:', result.error);
      appEvents.emit('screen_audio.error', `Falha ao iniciar captura: ${result.error}`);
      this.cleanup();
      return null;
    }

    this.isCapturing = true;
    this.isTestTone = false;
    if (!isCurrent()) return null;
    clientLog.info('MEDIA', 'Native screen audio capture started');
    console.log('[ScreenAudio] Native capture started');

    // Watchdog: warn if no frames arrive within timeout
    this.frameWatchdog = setTimeout(() => {
      if (this.frameCount === 0 && this.isCapturing && !this.isTestTone) {
        console.warn('[ScreenAudio] No frames received within timeout — native capture may have failed silently');
        appEvents.emit('screen_audio.warning', t('screenAudio.noFrames'));
      }
    }, FRAME_WATCHDOG_TIMEOUT * 1000);

    return this.outputTrack;
  }

  // ────────────────────────────────────────────
  //  Test tone mode (440 Hz, no native module)
  // ────────────────────────────────────────────

  public startTestTone(): Promise<MediaStreamTrack | null> {
    return this.runStart(isCurrent => this.startToneCapture(isCurrent));
  }

  private async startToneCapture(isCurrent: () => boolean): Promise<MediaStreamTrack | null> {
    await this.setupPipeline();
    if (!isCurrent()) return null;

    // Generate a 440 Hz stereo sine wave in chunks matching 48 kHz / 100 = 480 frames (10 ms)
    const sampleRate = 48000;
    const channels = 2;
    const chunkSize = 480 * channels;
    const frequency = 440;
    const amplitude = 0.3;
    let phase = 0;

    this.testToneInterval = setInterval(() => {
      const samples = new Float32Array(chunkSize);
      for (let i = 0; i < 480; i++) {
        const v = amplitude * Math.sin(2 * Math.PI * frequency * phase / sampleRate);
        samples[i * channels] = v;       // left
        samples[i * channels + 1] = v;   // right
        phase++;
      }
      this.feedSamples(samples);
      this.frameCount++;
    }, 10);

    this.isCapturing = true;
    this.isTestTone = true;
    console.log('[ScreenAudio] Test tone started (440 Hz)');

    return this.outputTrack;
  }

  private async runStart(
    start: (isCurrent: () => boolean) => Promise<MediaStreamTrack | null>,
  ): Promise<MediaStreamTrack | null> {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    if (this.isCapturing) return this.outputTrack;
    const epoch = ++this.captureEpoch;
    const client = callClient();
    const sessionKey = voiceStore.voiceSessionKey;
    const channelId = voiceStore.currentVoiceChannelId;
    const isCurrentCall = () => sessionKey === voiceStore.voiceSessionKey && channelId === voiceStore.currentVoiceChannelId;
    this.captureCall = { client, isCurrent: isCurrentCall };
    const isCurrent = () => epoch === this.captureEpoch && isCurrentCall();
    const pending = (async () => {
      let published = false;
      try {
        const track = await start(isCurrent);
        if (!track || !isCurrent()) return null;
        await webRtcManager.setLocalScreenAudioTrack(track);
        if (!isCurrent() || this.outputTrack !== track || track.readyState !== 'live') return null;
        client.send(MessageType.VOICE_STATE_UPDATE, { isSharingScreenAudio: true });
        appEvents.emit('local.screen_audio_started');
        published = true;
        return track;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && !isCurrent()) return null;
        throw error;
      } finally {
        // stop() owns cleanup after explicit cancellation and waits for this task.
        if (!published && epoch === this.captureEpoch) await this.stopCapture(client, isCurrent());
      }
    })();
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  // ────────────────────────────────────────────
  //  Stop (both modes)
  // ────────────────────────────────────────────

  public stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    ++this.captureEpoch;
    if (!this.isCapturing && !this.startPromise) return Promise.resolve();
    if (this.outputTrack) this.outputTrack.enabled = false;
    this.clearFrameWatchdog();
    const context = this.captureCall;
    const client = context?.client ?? callClient();
    const starting = this.startPromise;
    const pending = (async () => {
      if (starting) {
        await starting.catch(error => {
          clientLog.warn('MEDIA', 'Screen audio startup failed while stopping', { error: String(error) });
        });
      }
      await this.stopCapture(client, context?.isCurrent() ?? false);
    })();
    this.stopPromise = pending.finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async stopCapture(client: ReturnType<typeof callClient>, notify = true): Promise<void> {
    const wasCapturing = this.isCapturing;
    try {
      if (wasCapturing && !this.isTestTone) await window.api.screenAudioStop();
    } finally {
      try {
        await webRtcManager.setLocalScreenAudioTrack(null);
      } finally {
        if (wasCapturing && notify) client.send(MessageType.VOICE_STATE_UPDATE, { isSharingScreenAudio: false });
        clientLog.info('MEDIA', 'Screen audio stopped', { framesReceived: this.frameCount });
        this.cleanup();
        this.isCapturing = false;
        this.isTestTone = false;
        this.captureCall = null;
        if (wasCapturing) appEvents.emit('local.screen_audio_stopped');
      }
    }
  }

  public getIsCapturing(): boolean {
    return this.isCapturing;
  }

  public getIsTestTone(): boolean {
    return this.isTestTone;
  }

  public getOutputTrack(): MediaStreamTrack | null {
    return this.outputTrack;
  }

  public getFrameCount(): number {
    return this.frameCount;
  }

  private clearFrameWatchdog(): void {
    if (this.frameWatchdog) {
      clearTimeout(this.frameWatchdog);
      this.frameWatchdog = null;
    }
  }

  private cleanup(): void {
    if (this.removeFrameListener) {
      try {
        this.removeFrameListener();
      } catch {}
      this.removeFrameListener = null;
    } else if (window.api?.removeScreenAudioFrameListener) {
      try {
        window.api.removeScreenAudioFrameListener();
      } catch {}
    }

    if (this.removeErrorListener) {
      try {
        this.removeErrorListener();
      } catch {}
      this.removeErrorListener = null;
    }

    if (this.testToneInterval) {
      clearInterval(this.testToneInterval);
      this.testToneInterval = null;
    }

    this.clearFrameWatchdog();

    if (this.outputTrack) {
      try {
        this.outputTrack.stop();
      } catch {}
      this.outputTrack = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }
    if (this.destinationNode) {
      try {
        this.destinationNode.disconnect();
      } catch {}
      this.destinationNode = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}

export const screenAudioService = new ScreenAudioService();
