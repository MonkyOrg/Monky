import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { soundEffects } from './SoundEffects';
import { clientLog } from './ClientLogService';
import { createNoiseSuppressor, destroyNoiseSuppressor, type NoiseSuppressorNode } from './NoiseSuppression';
import type { NoiseSuppressionMode } from '../utils/audioPreferences';

export class AudioProcessor {
  private rawMicStream: MediaStream | null = null;
  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private noiseSuppressorNode: NoiseSuppressorNode | null = null;
  private noiseSuppressionGeneration = 0;
  private noiseSuppressionChanging = false;
  private noiseProcessorFailed = false;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private isSpeaking: boolean = false;
  private vadThreshold: number = settingsStore.vadSensitivity !== undefined ? settingsStore.vadSensitivity : 14;
  private isMuted: boolean = voiceStore.getEffectiveMuted();
  private isDeafened: boolean = voiceStore.getEffectiveDeafened();

  private isPttActive: boolean = false;
  private isPttPressed: boolean = false;
  private inputMode = settingsStore.inputMode;
  private pttReleaseTimeout: ReturnType<typeof setTimeout> | null = null;
  private unbindPttEvents: Array<() => void> = [];
  private unbindMicrophoneEvents: Array<() => void> = [];
  private captureGeneration = 0;
  private pendingDeviceSwitch: AbortController | null = null;
  private deviceSwitchTask: Promise<void> | null = null;
  private graphReady = false;
  private microphonePublicationPending = false;

  constructor() {
    this.initPtt();
  }

  public async startMicrophone(deviceId?: string): Promise<MediaStream> {
    this.stopMicrophone();
    const generation = this.captureGeneration;

    const targetDeviceId = deviceId ?? settingsStore.selectedMicrophoneId;
    clientLog.info('AUDIO', 'Starting microphone', { deviceId: targetDeviceId || 'default' });
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: settingsStore.noiseSuppressionMode === 'browser',
        autoGainControl: true,
      },
      video: false,
    };

    let rawStream: MediaStream;
    try {
      rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err: unknown) {
      if (generation !== this.captureGeneration) throw new DOMException('Microphone startup was cancelled', 'AbortError');
      if (targetDeviceId) {
        clientLog.warn('AUDIO', 'Could not open specific mic, falling back to default', { error: err instanceof Error ? err.message : String(err) });
        console.warn('[AudioProcessor] Could not open specific mic, falling back to default mic:', err);
        rawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: settingsStore.noiseSuppressionMode === 'browser',
            autoGainControl: true,
          },
          video: false,
        });
      } else {
        throw err;
      }
    }
    if (generation !== this.captureGeneration) {
      rawStream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Microphone startup was cancelled', 'AbortError');
    }
    this.rawMicStream = rawStream;
    rawStream.getAudioTracks().forEach((track) => { track.enabled = false; });

    try {
      await this.setupAudioGraph(rawStream);
    } catch (error) {
      if (generation === this.captureGeneration) this.releaseMicrophoneResources();
      throw error;
    }
    if (this.rawMicStream !== rawStream) {
      throw new DOMException('Microphone startup was cancelled', 'AbortError');
    }
    this.isMuted = voiceStore.getEffectiveMuted();
    this.isDeafened = voiceStore.getEffectiveDeafened();
    this.bindMicrophoneTracks();
    this.graphReady = true;
    this.applyTrackEnabled();
    return this.localStream || this.rawMicStream;
  }

  private bindMicrophoneTracks(): void {
    this.unbindMicrophoneEvents.forEach((unbind) => unbind());
    this.unbindMicrophoneEvents = [];
    const tracks = new Set([
      ...(this.rawMicStream?.getAudioTracks() ?? []),
      ...(this.localStream?.getAudioTracks() ?? []),
    ]);
    for (const track of tracks) {
      const onEnded = () => {
        this.resetPttState();
        this.applyTrackEnabled();
      };
      track.addEventListener('ended', onEnded);
      this.unbindMicrophoneEvents.push(() => track.removeEventListener('ended', onEnded));
    }
  }

  public async switchMicrophone(
    deviceId: string,
    replaceTrack: (track: MediaStreamTrack, signal: AbortSignal) => Promise<void | (() => Promise<void>)>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.noiseSuppressionChanging) throw new Error('Noise suppression is being changed');
    this.pendingDeviceSwitch?.abort();
    const preceding = this.deviceSwitchTask;
    const controller = new AbortController();
    this.pendingDeviceSwitch = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const channelId = voiceStore.currentVoiceChannelId;
    const sessionKey = voiceStore.voiceSessionKey;
    const ensureCurrent = () => {
      if (signal?.aborted || controller.signal.aborted ||
          voiceStore.currentVoiceChannelId !== channelId || voiceStore.voiceSessionKey !== sessionKey) {
        throw new DOMException('Microphone switch was cancelled', 'AbortError');
      }
    };
    const task = (async () => {
      // Finish rollback before another selection can publish or build a graph.
      if (preceding) await preceding.catch(() => {});
      ensureCurrent();
      if (!this.graphReady) {
        // A switch may supersede initial capture or asynchronous RNNoise setup.
        this.captureGeneration++;
        this.releaseMicrophoneResources();
      }
      await this.performMicrophoneSwitch(deviceId, replaceTrack, controller.signal, ensureCurrent);
    })();
    this.deviceSwitchTask = task;
    try {
      await task;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.pendingDeviceSwitch === controller) this.pendingDeviceSwitch = null;
      if (this.deviceSwitchTask === task) this.deviceSwitchTask = null;
    }
  }

  private async performMicrophoneSwitch(
    deviceId: string,
    replaceTrack: (track: MediaStreamTrack, signal: AbortSignal) => Promise<void | (() => Promise<void>)>,
    signal: AbortSignal,
    ensureCurrent: () => void,
  ): Promise<void> {
    const previous = this.rawMicStream;
    const generation = this.captureGeneration;
    let next: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      ensureCurrent();
      next = await this.captureSelectedMicrophone(deviceId, signal);
      next.getTracks().forEach((track) => { track.enabled = false; });
      ensureCurrent();
      const track = next.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('Selected microphone has no live audio track');
      if (!previous) {
        this.rawMicStream = next;
        this.microphonePublicationPending = true;
        await this.setupAudioGraph(next, ensureCurrent);
        ensureCurrent();
        const processedTrack = this.localStream?.getAudioTracks()[0];
        if (!processedTrack || processedTrack.readyState !== 'live') throw new Error('Microphone graph has no live audio track');
        const rollback = await replaceTrack(processedTrack, signal);
        try {
          ensureCurrent();
        } catch (error) {
          await rollback?.();
          throw error;
        }
        this.microphonePublicationPending = false;
        this.graphReady = true;
      } else if (this.audioContext && this.destinationNode && this.analyser && this.localStream !== previous) {
        // Keep the outgoing processed track stable for both P2P and SFU calls.
        source = this.audioContext.createMediaStreamSource(next);
        if (this.noiseSuppressorNode) source.connect(this.noiseSuppressorNode);
        else {
          source.connect(this.destinationNode);
          source.connect(this.analyser);
        }
        this.microphoneSource?.disconnect();
        this.microphoneSource = source;
      } else {
        await replaceTrack(track, signal);
        try {
          ensureCurrent();
        } catch (error) {
          const previousTrack = previous.getAudioTracks()[0];
          if (this.rawMicStream === previous && previousTrack?.readyState === 'live') {
            await replaceTrack(previousTrack, new AbortController().signal);
          }
          throw error;
        }
        this.localStream = next;
      }
      this.rawMicStream = next;
      this.bindMicrophoneTracks();
      this.isMuted = voiceStore.getEffectiveMuted();
      this.isDeafened = voiceStore.getEffectiveDeafened();
      this.applyTrackEnabled();
      previous?.getTracks().forEach((oldTrack) => oldTrack.stop());
      next = null;
    } finally {
      if (next) {
        source?.disconnect();
        next.getTracks().forEach((track) => track.stop());
        if (!previous && generation === this.captureGeneration) this.releaseMicrophoneResources();
      }
    }
  }

  private captureSelectedMicrophone(deviceId: string, signal: AbortSignal): Promise<MediaStream> {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new DOMException('Microphone capture was cancelled', 'AbortError'));
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      void navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: settingsStore.noiseSuppressionMode === 'browser',
          autoGainControl: true,
        },
        video: false,
      }).then((stream) => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) stream.getTracks().forEach((track) => track.stop());
        else resolve(stream);
      }, (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      });
    });
  }

  private async setupAudioGraph(rawStream: MediaStream, ensureActive?: () => void): Promise<void> {
    const generation = this.captureGeneration;
    const ensureCurrent = () => {
      ensureActive?.();
      if (generation !== this.captureGeneration || this.rawMicStream !== rawStream) {
        throw new DOMException('Microphone startup was cancelled', 'AbortError');
      }
    };
    const context = new AudioContext({ sampleRate: 48000 });
    this.audioContext = context;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.25;
    this.destinationNode = context.createMediaStreamDestination();
    this.microphoneSource = context.createMediaStreamSource(rawStream);
    let node: NoiseSuppressorNode | null = null;
    try {
      await context.resume();
      ensureCurrent();
      node = await createNoiseSuppressor(context, settingsStore.noiseSuppressionMode);
      ensureCurrent();
    } catch (error) {
      destroyNoiseSuppressor(node);
      ensureCurrent();
      throw error;
    }
    this.noiseSuppressorNode = node;
    this.noiseProcessorFailed = false;
    this.bindNoiseSuppressorError(node);
    if (node) {
      this.microphoneSource.connect(node);
      node.connect(this.destinationNode);
      node.connect(this.analyser);
    } else {
      this.microphoneSource.connect(this.destinationNode);
      this.microphoneSource.connect(this.analyser);
    }
    this.localStream = this.destinationNode.stream;
    this.applyTrackEnabled();
    this.startVadLoop();
    clientLog.info('AUDIO', 'Microphone processing initialized', { mode: settingsStore.noiseSuppressionMode });
  }

  private bindNoiseSuppressorError(node: NoiseSuppressorNode | null): void {
    if (!node) return;
    node.onprocessorerror = () => {
      if (this.noiseSuppressorNode !== node) return;
      this.noiseProcessorFailed = true;
      this.graphReady = false;
      this.applyTrackEnabled();
      clientLog.error('AUDIO', 'Noise suppression processor failed; microphone transmission stopped');
      appEvents.emit('audio.processing_error');
    };
  }

  private initPtt(): void {
    if (window.api?.onPttStateChanged) {
      const unbind = window.api.onPttStateChanged((active) => this.handlePttState(active));
      this.unbindPttEvents.push(unbind);
    }

    const unbindSettings = appEvents.on('settings.updated', () => {
      this.syncPttConfig();
      this.applyTrackEnabled();
    });
    this.unbindPttEvents.push(unbindSettings);

    let channelId = voiceStore.currentVoiceChannelId;
    let sessionKey = voiceStore.voiceSessionKey;
    this.unbindPttEvents.push(appEvents.on('voice.channel_changed', () => {
      if (channelId === voiceStore.currentVoiceChannelId && sessionKey === voiceStore.voiceSessionKey) return;
      channelId = voiceStore.currentVoiceChannelId;
      sessionKey = voiceStore.voiceSessionKey;
      this.resetPttState();
      this.setSpeaking(false);
      this.applyTrackEnabled();
    }));

    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (settingsStore.inputMode !== 'push_to_talk') return;
      if (!settingsStore.pttKey || settingsStore.pttKey.keyType !== 'keyboard') return;
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isInput && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        return;
      }
      if (e.code === settingsStore.pttKey.code || e.key === settingsStore.pttKey.code) {
        this.handlePttState(true);
      }
    };

    const handleWindowKeyUp = (e: KeyboardEvent) => {
      if (settingsStore.inputMode !== 'push_to_talk') return;
      if (!settingsStore.pttKey || settingsStore.pttKey.keyType !== 'keyboard') return;
      if (e.code === settingsStore.pttKey.code || e.key === settingsStore.pttKey.code) {
        this.handlePttState(false);
      }
    };

    const handleWindowMouseDown = (e: MouseEvent) => {
      if (settingsStore.inputMode !== 'push_to_talk') return;
      if (!settingsStore.pttKey || settingsStore.pttKey.keyType !== 'mouse') return;
      let button = e.button + 1;
      if (e.button === 1) button = 3;
      else if (e.button === 2) button = 2;
      if (settingsStore.pttKey.mouseButton === button) {
        this.handlePttState(true);
      }
    };

    const handleWindowMouseUp = (e: MouseEvent) => {
      if (settingsStore.inputMode !== 'push_to_talk') return;
      if (!settingsStore.pttKey || settingsStore.pttKey.keyType !== 'mouse') return;
      let button = e.button + 1;
      if (e.button === 1) button = 3;
      else if (e.button === 2) button = 2;
      if (settingsStore.pttKey.mouseButton === button) {
        this.handlePttState(false);
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    window.addEventListener('keyup', handleWindowKeyUp, true);
    window.addEventListener('mousedown', handleWindowMouseDown, true);
    window.addEventListener('mouseup', handleWindowMouseUp, true);

    this.unbindPttEvents.push(() => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
      window.removeEventListener('keyup', handleWindowKeyUp, true);
      window.removeEventListener('mousedown', handleWindowMouseDown, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
    });

    this.syncPttConfig();
  }

  public syncPttConfig(): void {
    if (!window.api?.setPttConfig) return;
    window.api.setPttConfig({
      enabled: settingsStore.inputMode === 'push_to_talk',
      key: settingsStore.pttKey,
    }).catch((err) => {
      console.warn('[AudioProcessor] Failed to set PTT config:', err);
    });
  }

  public handlePttState(active: boolean): void {
    if (settingsStore.inputMode !== 'push_to_talk'
      || !this.isMicrophonePermitted()) {
      this.resetPttState();
      this.applyTrackEnabled();
      return;
    }

    if (active) {
      this.isPttPressed = true;
      if (this.pttReleaseTimeout) {
        clearTimeout(this.pttReleaseTimeout);
        this.pttReleaseTimeout = null;
      }
      const newlyActive = !this.isPttActive;
      this.isPttActive = true;
      this.applyTrackEnabled();
      this.setSpeaking(true);
      if (newlyActive && voiceStore.microphoneOpen) soundEffects.playPttTone(true);
    } else {
      // Native and focused-window handlers can report the same release.
      // Only the first release starts the tail; duplicates must not extend it.
      if (this.isPttPressed) {
        this.isPttPressed = false;
        this.applyTrackEnabled();
        const delay = Math.max(0, settingsStore.pttReleaseDelay || 0);
        this.pttReleaseTimeout = setTimeout(() => {
          const wasOpen = voiceStore.microphoneOpen;
          this.isPttActive = false;
          this.pttReleaseTimeout = null;
          if (settingsStore.inputMode === 'push_to_talk') {
            this.applyTrackEnabled();
            this.setSpeaking(false);
            if (wasOpen) soundEffects.playPttTone(false);
          }
        }, delay);
      }
    }
  }

  private resetPttState(): void {
    if (this.pttReleaseTimeout) clearTimeout(this.pttReleaseTimeout);
    this.pttReleaseTimeout = null;
    this.isPttPressed = false;
    this.isPttActive = false;
    if (this.inputMode === 'push_to_talk') this.setSpeaking(false);
  }

  private isMicrophonePermitted(): boolean {
    return voiceStore.currentVoiceChannelId !== null
      && !this.isMuted && !this.isDeafened && !voiceStore.getEffectiveMuted();
  }

  private canActivateMicrophone(): boolean {
    return this.isMicrophonePermitted() && this.graphReady && !this.microphonePublicationPending
      && [this.rawMicStream, this.localStream || this.rawMicStream].every((stream) =>
        stream?.getAudioTracks().some((track) => track.readyState === 'live'));
  }

  private publishMicrophoneState(): void {
    const hasEnabledTrack = (stream: MediaStream | null): boolean =>
      stream?.getAudioTracks().some((track) => track.readyState === 'live' && track.enabled) ?? false;
    // A Web Audio destination can stay live after the physical input ends.
    const ready = this.canActivateMicrophone();
    const open = ready && hasEnabledTrack(this.rawMicStream) && hasEnabledTrack(this.localStream || this.rawMicStream);
    // An in-call key may stay held during device recovery, but no activity is published before capture is ready.
    voiceStore.setMicrophoneState(open, ready && this.isPttPressed);
    if (!open) this.setSpeaking(false);
  }

  public applyTrackEnabled(forceState?: boolean): void {
    const isPtt = settingsStore.inputMode === 'push_to_talk';
    const canActivate = this.canActivateMicrophone();
    if (this.inputMode !== settingsStore.inputMode || !this.isMicrophonePermitted()) {
      this.resetPttState();
      this.inputMode = settingsStore.inputMode;
    }
    let enabled: boolean;

    if (!canActivate) {
      enabled = false;
    } else if (typeof forceState === 'boolean') {
      enabled = forceState;
    } else if (isPtt) {
      enabled = this.isPttActive;
    } else {
      enabled = true;
    }

    if (this.rawMicStream) {
      this.rawMicStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
    this.publishMicrophoneState();
  }

  public async setNoiseSuppression(mode: NoiseSuppressionMode, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Noise suppression selection was cancelled', 'AbortError');
    if (this.noiseSuppressionChanging) throw new Error('Noise suppression is already being changed');
    const generation = ++this.noiseSuppressionGeneration;
    const context = this.audioContext;
    const source = this.microphoneSource;
    const destination = this.destinationNode;
    const analyser = this.analyser;
    const raw = this.rawMicStream;
    if (!raw) {
      const probe = new AudioContext({ sampleRate: 48000 });
      let node: NoiseSuppressorNode | null = null;
      try {
        node = await createNoiseSuppressor(probe, mode);
        if (signal?.aborted || generation !== this.noiseSuppressionGeneration || this.rawMicStream) {
          throw new DOMException('Noise suppression selection was cancelled', 'AbortError');
        }
      } finally {
        destroyNoiseSuppressor(node);
        await probe.close();
      }
      return;
    }
    if ((!this.graphReady && !this.noiseProcessorFailed) || !context || !source || !destination || !analyser || this.pendingDeviceSwitch) {
      throw new Error('Microphone capture is changing; try again when it is ready');
    }
    const ensureCurrent = () => {
      if (signal?.aborted || generation !== this.noiseSuppressionGeneration ||
          this.audioContext !== context || this.microphoneSource !== source || this.rawMicStream !== raw) {
        throw new DOMException('Noise suppression selection was cancelled', 'AbortError');
      }
    };
    const previous = this.noiseSuppressorNode;
    const previousBrowserSuppression = settingsStore.noiseSuppressionMode === 'browser';
    this.noiseSuppressionChanging = true;
    let next: NoiseSuppressorNode | null = null;
    let constraintsChanged = false;
    try {
      next = await createNoiseSuppressor(context, mode);
      ensureCurrent();
      const track = raw.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('Microphone is no longer available');
      await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: mode === 'browser' });
      constraintsChanged = true;
      ensureCurrent();
      if (next) {
        next.connect(destination);
        next.connect(analyser);
      }
      source.disconnect();
      if (next) source.connect(next);
      else {
        source.connect(destination);
        source.connect(analyser);
      }
      this.noiseSuppressorNode = next;
      this.noiseProcessorFailed = false;
      this.graphReady = true;
      this.bindNoiseSuppressorError(next);
      destroyNoiseSuppressor(previous);
      this.applyTrackEnabled();
      clientLog.info('AUDIO', 'Noise suppression changed', { mode });
    } catch (error) {
      destroyNoiseSuppressor(next);
      if (this.rawMicStream === raw && this.microphoneSource === source && constraintsChanged) {
        const track = raw.getAudioTracks()[0];
        if (track?.readyState === 'live') {
          await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: previousBrowserSuppression });
        }
        source.disconnect();
        if (previous) source.connect(previous);
        else {
          source.connect(destination);
          source.connect(analyser);
        }
      }
      ensureCurrent();
      throw error;
    } finally {
      this.noiseSuppressionChanging = false;
    }
  }

  private startVadLoop(): void {
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    if (!this.analyser) return;

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const speechBins = Math.min(36, bufferLength);
    let silenceCounter = 0;

    this.vadInterval = setInterval(() => {
      const isPtt = settingsStore.inputMode === 'push_to_talk';
      if (!this.analyser || !this.canActivateMicrophone() || !voiceStore.microphoneOpen) {
        silenceCounter = 0;
        if (this.isSpeaking) {
          this.setSpeaking(false);
        }
        return;
      }

      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }

      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < speechBins; i++) {
        const val = dataArray[i];
        sum += val;
        if (val > peak) peak = val;
      }
      const average = sum / speechBins;

      // In PTT mode, speaking state is controlled by PTT key activation
      if (isPtt) {
        if (this.isPttActive && !this.isSpeaking && !this.isMuted && !this.isDeafened) {
          this.setSpeaking(true);
        } else if (!this.isPttActive && this.isSpeaking) {
          this.setSpeaking(false);
        }
        return;
      }

      // Calibrated threshold: filters background mic hiss while activating reliably when talking
      const targetAvg = Math.max(16, this.vadThreshold * 0.8);
      const targetPeak = Math.max(42, this.vadThreshold * 1.8);
      const isVoiceActive = (average > targetAvg && peak > targetPeak) || average > (targetAvg * 1.4);

      if (isVoiceActive) {
        silenceCounter = 0;
        if (!this.isSpeaking) {
          this.setSpeaking(true);
        }
      } else {
        silenceCounter++;
        // 4 cycles (~200ms) of silence before turning off to avoid jitter between words
        if (silenceCounter > 4 && this.isSpeaking) {
          this.setSpeaking(false);
        }
      }
    }, 50);
  }

  private setSpeaking(speaking: boolean): void {
    const active = speaking && this.canActivateMicrophone() && voiceStore.microphoneOpen
      && (settingsStore.inputMode !== 'push_to_talk' || this.isPttActive);
    if (this.isSpeaking !== active) {
      this.isSpeaking = active;
      appEvents.emit('local.speaking', active);
    }
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyTrackEnabled();
    if (muted && this.isSpeaking) {
      this.setSpeaking(false);
    }
    appEvents.emit('local.muted', muted);
  }

  public setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    // When deafened, also mute microphone
    if (deafened && !this.isMuted) {
      this.setMuted(true);
    } else {
      this.applyTrackEnabled();
    }
    appEvents.emit('local.deafened', deafened);
  }

  public setVadThreshold(threshold: number): void {
    this.vadThreshold = Math.max(0, Math.min(160, threshold));
  }

  public getLocalAudioStream(): MediaStream | null {
    return this.localStream || this.rawMicStream;
  }

  public getRawMicrophoneStream(): MediaStream | null {
    return this.rawMicStream;
  }

  /**
   * Returns the live call's input level, or -1 while transmission is disabled.
   * Microphone settings use a separate local-only preview graph.
   */
  public getInputLevel(): number {
    if (!this.analyser || !this.canActivateMicrophone() || !voiceStore.microphoneOpen) return -1;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);
    const speechBins = Math.min(36, bufferLength);
    let sum = 0;
    for (let i = 0; i < speechBins; i++) sum += dataArray[i];
    return sum / speechBins;
  }

  public stopMicrophone(): void {
    this.captureGeneration++;
    this.pendingDeviceSwitch?.abort();
    this.pendingDeviceSwitch = null;
    clientLog.info('AUDIO', 'Stopping microphone');
    this.resetPttState();
    this.releaseMicrophoneResources();
  }

  private releaseMicrophoneResources(): void {
    this.graphReady = false;
    this.microphonePublicationPending = false;
    this.unbindMicrophoneEvents.forEach((unbind) => unbind());
    this.unbindMicrophoneEvents = [];
    this.releaseAudioGraph();
    if (this.rawMicStream) {
      this.rawMicStream.getTracks().forEach((t) => t.stop());
      this.rawMicStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.isSpeaking) {
      this.setSpeaking(false);
    }
    this.publishMicrophoneState();
  }

  private releaseAudioGraph(): void {
    this.noiseSuppressionGeneration++;
    this.noiseProcessorFailed = false;
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    destroyNoiseSuppressor(this.noiseSuppressorNode);
    this.noiseSuppressorNode = null;
    if (this.microphoneSource) {
      try {
        this.microphoneSource.disconnect();
      } catch {}
      this.microphoneSource = null;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {}
      this.analyser = null;
    }
    if (this.destinationNode) {
      this.destinationNode.stream.getTracks().forEach((track) => track.stop());
      try {
        this.destinationNode.disconnect();
      } catch {}
      this.destinationNode = null;
    }
    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  public destroy(): void {
    this.stopMicrophone();
    if (this.pttReleaseTimeout) {
      clearTimeout(this.pttReleaseTimeout);
      this.pttReleaseTimeout = null;
    }
    this.unbindPttEvents.forEach((unbind) => unbind());
    this.unbindPttEvents = [];
  }
}

export const audioProcessor = new AudioProcessor();
