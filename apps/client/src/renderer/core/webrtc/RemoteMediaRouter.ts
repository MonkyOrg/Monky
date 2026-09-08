import { settingsStore } from '../../stores/settingsStore';
import { voiceStore } from '../../stores/voiceStore';
import type { ParticipantManager } from '../ParticipantManager';
import type { PeerSession } from '../WebRtcManager';

/**
 * Pipeline de amplificação via Web Audio API.
 * Usado apenas quando o volume > 100% — o <audio> element continua
 * sendo o consumidor primário do stream (garante que o Chromium decodifique
 * as tracks), e o GainNode faz a amplificação conectando ao ctx.destination.
 *
 * Quando volume <= 100%, o pipeline é desconectado e o <audio>.volume
 * controla o nível normalmente (mais leve para a CPU).
 */
interface AmplificationPipeline {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  destination: MediaStreamAudioDestinationNode;
  trackId: string;
  connected: boolean;
}

/**
 * RemoteMediaRouter manages playback, volume (0–200%), audio routing,
 * speaker device sinks, and video DOM attachments for remote audio and screen tracks.
 *
 * Architecture:
 * - <audio> elements remain the primary playback mechanism (Chromium requires
 *   them to keep decoding MediaStream tracks).
 * - For amplification above 100%, a Web Audio GainNode pipeline is layered on
 *   top: the <audio> element is muted, and the GainNode output is routed to
 *   an AudioContext destination with the selected speaker sink.
 */
export class RemoteMediaRouter {
  private audioElements: Map<string, HTMLAudioElement> = new Map();
  private screenAudioElements: Map<string, HTMLAudioElement> = new Map();
  private amplificationPipelines: Map<string, AmplificationPipeline> = new Map();
  private screenAmplificationPipelines: Map<string, AmplificationPipeline> = new Map();
  private isDeafened: boolean = false;
  private audioContext: AudioContext | null = null;

  constructor(private getVoiceParticipants: () => ParticipantManager) {}

  // ── AudioContext (lazy, only created when amplification > 100% is needed) ──

  private getOrCreateAudioContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass();
      const sinkId = settingsStore.selectedSpeakerId;
      if (sinkId && typeof (this.audioContext as any).setSinkId === 'function') {
        (this.audioContext as any).setSinkId(sinkId).catch(() => {});
      }
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    return this.audioContext;
  }

  // ── Public getters (preserving existing API) ──

  public getAudioElement(peerSessionId: string): HTMLAudioElement | undefined {
    return this.audioElements.get(peerSessionId);
  }

  public getScreenAudioElement(peerSessionId: string): HTMLAudioElement | undefined {
    return this.screenAudioElements.get(peerSessionId);
  }

  // ── Deafen ──

  public setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    for (const audioEl of this.audioElements.values()) {
      audioEl.muted = deafened;
    }
    // Also silence any active amplification pipelines
    if (deafened) {
      for (const pipeline of this.amplificationPipelines.values()) {
        pipeline.gain.gain.value = 0;
      }
    } else {
      this.applyUserVolumes();
    }
  }

  // ── Speaker device routing ──

  public async setSpeakerDeviceId(deviceId: string): Promise<void> {
    const sinkId = deviceId ?? settingsStore.selectedSpeakerId;
    // Apply to all peer audio elements
    for (const audioEl of this.audioElements.values()) {
      await this.applySinkToElement(audioEl, sinkId);
    }
    // Apply to all screen audio elements
    for (const screenAudioEl of this.screenAudioElements.values()) {
      await this.applySinkToElement(screenAudioEl, sinkId);
    }
    // Apply to the AudioContext if it exists (for amplification > 100%)
    if (this.audioContext && typeof (this.audioContext as any).setSinkId === 'function') {
      try {
        await (this.audioContext as any).setSinkId(sinkId || '');
      } catch (err) {
        console.warn('[WebRTC:MediaRouter] Error setting sink ID for AudioContext:', err);
      }
    }
  }

  public async applySinkToElement(audioEl: HTMLAudioElement, deviceId?: string, force = false): Promise<void> {
    const sinkId = deviceId ?? settingsStore.selectedSpeakerId;
    if (!sinkId || typeof (audioEl as any).setSinkId !== 'function') return;
    if (!force && (audioEl as any).sinkId === sinkId) return;
    try {
      await (audioEl as any).setSinkId(sinkId);
    } catch (err) {
      console.warn('[WebRTC:MediaRouter] Error setting sink ID for speaker device:', err);
    }
  }

  // ── Screen audio routing ──

  public routeScreenAudioTrack(peerSessionId: string, track: MediaStreamTrack): void {
    let screenAudioEl = this.screenAudioElements.get(peerSessionId);
    if (!screenAudioEl) {
      screenAudioEl = document.createElement('audio');
      screenAudioEl.autoplay = true;
      // #150: start silent — screen audio is gated behind "Assistir transmissão"
      // in the stage view, which unmutes this element when the viewer opts in.
      screenAudioEl.muted = true;
      screenAudioEl.setAttribute('data-screen-audio-session', peerSessionId);
      document.body.appendChild(screenAudioEl);
      this.screenAudioElements.set(peerSessionId, screenAudioEl);
    }
    const screenStream = new MediaStream([track]);
    screenAudioEl.srcObject = screenStream;
    const participant = this.getVoiceParticipants().get(peerSessionId);
    const volume = settingsStore.getScreenAudioVolume(peerSessionId, participant?.user.clientId);
    this.applyVolumeToElement(screenAudioEl, volume, peerSessionId, this.screenAmplificationPipelines, track);
    this.applySinkToElement(screenAudioEl).finally(() => {
      screenAudioEl!.play().catch((e) => console.warn('[WebRTC:MediaRouter] Screen audio play error:', e));
    });
    track.onended = () => {
      this.cleanupScreenAudio(peerSessionId);
    };
  }

  public setScreenAudioMuted(peerSessionId: string, muted: boolean): void {
    const screenAudioEl = this.screenAudioElements.get(peerSessionId);
    if (screenAudioEl) {
      screenAudioEl.muted = muted;
    }
    const participant = this.getVoiceParticipants().get(peerSessionId);
    this.setScreenAudioVolume(peerSessionId, settingsStore.getScreenAudioVolume(peerSessionId, participant?.user.clientId));
  }

  // ── Screen video routing ──

  private sfuRemoteScreenStreams: Map<string, Map<string, MediaStream>> = new Map();

  public routeScreenVideoTrack(
    peerSessionId: string,
    track: MediaStreamTrack,
    shareId: string,
    session: PeerSession | undefined
  ): void {
    // If it was provisionally added to the camera stream (meta arrived late),
    // move it out so it doesn't render as the camera.
    if (session && session.remoteStream.getTrackById(track.id)) {
      session.remoteStream.removeTrack(track);
      this.getVoiceParticipants().setRemoteStream(peerSessionId, session.remoteStream);
    }

    let streamsMap: Map<string, MediaStream>;
    if (session) {
      streamsMap = session.remoteScreenStreams;
    } else {
      let sfuMap = this.sfuRemoteScreenStreams.get(peerSessionId);
      if (!sfuMap) {
        sfuMap = new Map();
        this.sfuRemoteScreenStreams.set(peerSessionId, sfuMap);
      }
      streamsMap = sfuMap;
    }

    let screenStream = streamsMap.get(shareId);
    if (!screenStream) {
      screenStream = new MediaStream();
      streamsMap.set(shareId, screenStream);
    }

    // Replace any previous screen video track for this share with this one.
    screenStream.getVideoTracks().forEach((old) => {
      if (old.id !== track.id) {
        try { old.stop(); } catch {}
        screenStream!.removeTrack(old);
      }
    });
    if (!screenStream.getTrackById(track.id)) {
      screenStream.addTrack(track);
    }
    this.getVoiceParticipants().setRemoteScreenStream(peerSessionId, shareId, screenStream);

    const attach = (el: HTMLVideoElement | null) => {
      if (el) {
        el.muted = true;
        if (el.srcObject !== screenStream) {
          el.srcObject = screenStream!;
        }
        el.play().catch(() => {});
      }
    };
    attach(document.getElementById(`video-${peerSessionId}-screen-${shareId}`) as HTMLVideoElement | null);
    attach(document.getElementById(`video-mini-${peerSessionId}-screen-${shareId}`) as HTMLVideoElement | null);
    // Pre-#253 peers don't publish a screenShareIds list, so their tile is keyed
    // by the stage's legacy placeholder rather than by this stream id.
    attach(document.getElementById(`video-${peerSessionId}-screen-legacy`) as HTMLVideoElement | null);
    attach(document.getElementById(`video-mini-${peerSessionId}-screen-legacy`) as HTMLVideoElement | null);

    track.onended = () => {
      try { track.stop(); } catch {}
      screenStream!.removeTrack(track);
      streamsMap.delete(shareId);
      this.getVoiceParticipants().removeRemoteScreenStream(peerSessionId, shareId);
    };
  }

  // ── Peer voice audio ──

  public ensureVoiceAudioElement(peerSessionId: string, stream: MediaStream): HTMLAudioElement {
    let audioEl = this.audioElements.get(peerSessionId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.muted = this.isDeafened || voiceStore.getEffectiveDeafened();
      audioEl.setAttribute('data-peer-session', peerSessionId);
      document.body.appendChild(audioEl);
      this.audioElements.set(peerSessionId, audioEl);
      console.log(`[MediaRouter] Created new <audio> element for peerSessionId: ${peerSessionId}`);
    }
    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
      console.log(`[MediaRouter] Set srcObject on <audio> element for ${peerSessionId} with ${stream.getAudioTracks().length} audio tracks`);
    }
    const participant = this.getVoiceParticipants().get(peerSessionId);
    const volume = settingsStore.getUserVolume(peerSessionId, participant?.user.clientId);
    const audioTrack = stream.getAudioTracks()[0];
    console.log(`[MediaRouter] Applying volume ${volume}% to peerSessionId ${peerSessionId} (audioTrack id: ${audioTrack?.id}, enabled: ${audioTrack?.enabled})`);
    this.applyVolumeToElement(audioEl, volume, peerSessionId, this.amplificationPipelines, audioTrack);
    this.applySinkToElement(audioEl).finally(() => {
      audioEl!
        .play()
        .then(() => console.log(`[MediaRouter] Audio playback started for peerSessionId: ${peerSessionId}`))
        .catch((e) => console.warn('[WebRTC:MediaRouter] Audio play error:', e));
    });
    return audioEl;
  }

  // ── Volume control (hybrid: <audio>.volume for ≤100%, GainNode for >100%) ──

  /**
   * Applies volume to an audio element. For volumes 0–100%, uses the native
   * HTMLAudioElement.volume property. For volumes >100%, mutes the <audio>
   * element and routes through a GainNode pipeline for amplification.
   */
  private applyVolumeToElement(
    audioEl: HTMLAudioElement,
    volume: number,
    sessionId: string,
    pipelineMap: Map<string, AmplificationPipeline>,
    track?: MediaStreamTrack
  ): void {
    const clamped = Math.max(0, Math.min(200, volume));
    const isScreenAudio = audioEl.hasAttribute('data-screen-audio-session');
    const isDeaf = !isScreenAudio && (this.isDeafened || voiceStore.getEffectiveDeafened());

    if (isDeaf) {
      audioEl.muted = true;
      const pipeline = pipelineMap.get(sessionId);
      if (pipeline) {
        pipeline.gain.gain.value = 0;
      }
      return;
    }

    if (clamped <= 100) {
      // Normal range: use native <audio> volume, disconnect amplification pipeline
      audioEl.volume = clamped / 100;
      // Don't unmute screen audio elements that are intentionally muted (#150)
      if (!audioEl.hasAttribute('data-screen-audio-session') || !audioEl.muted) {
        audioEl.muted = false;
      }
      this.disconnectAmplificationPipeline(sessionId, pipelineMap);
    } else {
      // Amplification range (101–200%): mute <audio> element, route through GainNode
      audioEl.volume = 0;
      // Keep audioEl unmuted so Chromium continues decoding the stream,
      // but set volume to 0 so it doesn't output sound directly.
      // The GainNode pipeline handles the actual audio output.
      this.ensureAmplificationPipeline(sessionId, audioEl, pipelineMap, track);
      const pipeline = pipelineMap.get(sessionId);
      if (pipeline) {
        pipeline.gain.gain.value = isScreenAudio && audioEl.muted ? 0 : clamped / 100;
      }
    }
  }

  private ensureAmplificationPipeline(
    sessionId: string,
    audioEl: HTMLAudioElement,
    pipelineMap: Map<string, AmplificationPipeline>,
    track?: MediaStreamTrack
  ): void {
    const existingPipeline = pipelineMap.get(sessionId);

    // Determine the track to use
    const audioTrack = track || (audioEl.srcObject as MediaStream | null)?.getAudioTracks()[0];
    if (!audioTrack) return;

    // If pipeline already exists and is for the same track, just ensure it's connected
    if (existingPipeline && existingPipeline.trackId === audioTrack.id) {
      if (!existingPipeline.connected) {
        existingPipeline.source.connect(existingPipeline.gain);
        existingPipeline.gain.connect(this.getOrCreateAudioContext().destination);
        existingPipeline.connected = true;
      }
      return;
    }

    // Cleanup old pipeline if track changed
    if (existingPipeline) {
      try {
        existingPipeline.source.disconnect();
        existingPipeline.gain.disconnect();
      } catch {}
      pipelineMap.delete(sessionId);
    }

    // Create new pipeline
    const ctx = this.getOrCreateAudioContext();
    const amplStream = new MediaStream([audioTrack]);
    const source = ctx.createMediaStreamSource(amplStream);
    const gain = ctx.createGain();
    const destination = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(ctx.destination);

    pipelineMap.set(sessionId, {
      source,
      gain,
      destination,
      trackId: audioTrack.id,
      connected: true,
    });
  }

  private disconnectAmplificationPipeline(
    sessionId: string,
    pipelineMap: Map<string, AmplificationPipeline>
  ): void {
    const pipeline = pipelineMap.get(sessionId);
    if (pipeline && pipeline.connected) {
      try {
        pipeline.source.disconnect();
        pipeline.gain.disconnect();
      } catch {}
      pipeline.connected = false;
    }
  }

  public setPeerVolume(peerSessionId: string, volume: number): void {
    const audioEl = this.audioElements.get(peerSessionId);
    if (audioEl) {
      const stream = audioEl.srcObject as MediaStream | null;
      const track = stream?.getAudioTracks()[0];
      this.applyVolumeToElement(audioEl, volume, peerSessionId, this.amplificationPipelines, track);
    }
  }

  public setScreenAudioVolume(peerSessionId: string, volume: number): void {
    const screenAudioEl = this.screenAudioElements.get(peerSessionId);
    if (screenAudioEl) {
      const stream = screenAudioEl.srcObject as MediaStream | null;
      const track = stream?.getAudioTracks()[0];
      this.applyVolumeToElement(screenAudioEl, volume, peerSessionId, this.screenAmplificationPipelines, track);
    }
  }

  public applyUserVolumes(): void {
    for (const [peerSessionId, audioEl] of this.audioElements.entries()) {
      const participant = this.getVoiceParticipants().get(peerSessionId);
      const vol = settingsStore.getUserVolume(peerSessionId, participant?.user.clientId);
      const stream = audioEl.srcObject as MediaStream | null;
      const track = stream?.getAudioTracks()[0];
      this.applyVolumeToElement(audioEl, vol, peerSessionId, this.amplificationPipelines, track);
    }
  }

  // ── Cleanup ──

  private cleanupAmplificationPipeline(sessionId: string, pipelineMap: Map<string, AmplificationPipeline>): void {
    const pipeline = pipelineMap.get(sessionId);
    if (pipeline) {
      try {
        pipeline.source.disconnect();
        pipeline.gain.disconnect();
      } catch {}
      pipelineMap.delete(sessionId);
    }
  }

  public cleanupScreenAudio(peerSessionId: string): void {
    const el = this.screenAudioElements.get(peerSessionId);
    if (el) {
      try {
        el.pause();
      } catch {}
      el.srcObject = null;
      el.remove();
      this.screenAudioElements.delete(peerSessionId);
    }
    this.cleanupAmplificationPipeline(peerSessionId, this.screenAmplificationPipelines);
  }

  public cleanupPeerMedia(peerSessionId: string, session?: PeerSession): void {
    const audioEl = this.audioElements.get(peerSessionId);
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {}
      audioEl.srcObject = null;
      audioEl.remove();
      this.audioElements.delete(peerSessionId);
    }
    this.cleanupAmplificationPipeline(peerSessionId, this.amplificationPipelines);

    this.cleanupScreenAudio(peerSessionId);

    const sfuScreens = this.sfuRemoteScreenStreams.get(peerSessionId);
    if (sfuScreens) {
      for (const [shareId, stream] of sfuScreens.entries()) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
        this.getVoiceParticipants().removeRemoteScreenStream(peerSessionId, shareId);
      }
      this.sfuRemoteScreenStreams.delete(peerSessionId);
    }

    if (session) {
      // Explicitly stop all remote voice/camera tracks to free WebRTC decoding buffers
      session.remoteStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });

      // Explicitly stop all remote screen share tracks
      for (const [shareId, screenStream] of session.remoteScreenStreams.entries()) {
        screenStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
        this.getVoiceParticipants().removeRemoteScreenStream(peerSessionId, shareId);
      }
      session.remoteScreenStreams.clear();
    }
  }

  public closeAllMedia(): void {
    for (const audioEl of this.audioElements.values()) {
      try {
        audioEl.pause();
      } catch {}
      audioEl.srcObject = null;
      audioEl.remove();
    }
    this.audioElements.clear();

    for (const screenAudioEl of this.screenAudioElements.values()) {
      try {
        screenAudioEl.pause();
      } catch {}
      screenAudioEl.srcObject = null;
      screenAudioEl.remove();
    }
    this.screenAudioElements.clear();

    for (const [peerSessionId, sfuScreens] of this.sfuRemoteScreenStreams.entries()) {
      for (const [shareId, stream] of sfuScreens.entries()) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
        this.getVoiceParticipants().removeRemoteScreenStream(peerSessionId, shareId);
      }
    }
    this.sfuRemoteScreenStreams.clear();

    // Cleanup all amplification pipelines
    for (const pipeline of this.amplificationPipelines.values()) {
      try {
        pipeline.source.disconnect();
        pipeline.gain.disconnect();
      } catch {}
    }
    this.amplificationPipelines.clear();

    for (const pipeline of this.screenAmplificationPipelines.values()) {
      try {
        pipeline.source.disconnect();
        pipeline.gain.disconnect();
      } catch {}
    }
    this.screenAmplificationPipelines.clear();

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}
