import { settingsStore } from '../../stores/settingsStore';
import { voiceStore } from '../../stores/voiceStore';
import type { ParticipantManager } from '../ParticipantManager';
import type { PeerSession } from '../WebRtcManager';
import { normalizeAudioOutputId } from '../../utils/audioPreferences';
import { setAudioOutputSink } from '../AudioOutputSink';

interface AudioPlaybackPipeline {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  trackId: string;
}

/**
 * RemoteMediaRouter manages playback, volume (0–200%), audio routing,
 * speaker device sinks, and video DOM attachments for remote audio and screen tracks.
 *
 * Chromium shares one native renderer/output for remote WebRTC audio elements.
 * Keep them playing silently for decoding, and route every audible track through
 * its category's AudioContext. The shared native output follows voice only,
 * because Chromium also uses it to select the echo-cancellation reference device.
 */
export class RemoteMediaRouter {
  private audioElements: Map<string, HTMLAudioElement> = new Map();
  private screenAudioElements: Map<string, HTMLAudioElement> = new Map();
  private voicePipelines: Map<string, AudioPlaybackPipeline> = new Map();
  private screenAudioPipelines: Map<string, AudioPlaybackPipeline> = new Map();
  private isDeafened: boolean = false;
  private audioContexts = new Map<'voice' | 'screen', AudioContext>();
  private speakerDeviceIds: Record<'voice' | 'screen', string | null> = { voice: null, screen: null };
  private decoderOutputQueue: Promise<void> = Promise.resolve();

  constructor(private getVoiceParticipants: () => ParticipantManager) {}

  // ── AudioContext (one per active playback category) ──

  private getOrCreateAudioContext(category: 'voice' | 'screen'): AudioContext {
    let context = this.audioContexts.get(category);
    if (!context || context.state === 'closed') {
      // A new graph stays silent until its category's output has been selected.
      context = new AudioContext({ sinkId: { type: 'none' } });
      this.audioContexts.set(category, context);
    }
    return context;
  }

  private async routeAudioOutput(category: 'voice' | 'screen'): Promise<void> {
    const context = this.getOrCreateAudioContext(category);
    const sinkId = this.speakerDeviceIds[category] ?? settingsStore.getAudioOutputDeviceId(category);
    if (typeof context.setSinkId !== 'function') throw new Error('Audio output selection unavailable');
    await setAudioOutputSink(context, sinkId);
    if (context.state === 'suspended') await context.resume();
  }

  private routeDecoderOutput(audioEl: HTMLAudioElement): Promise<void> {
    const apply = async () => {
      if (!audioEl.isConnected) return;
      // The native renderer is shared across elements. Serialize its switches
      // globally and resolve the latest voice preference after waiting.
      const voiceId = this.speakerDeviceIds.voice ?? settingsStore.getAudioOutputDeviceId('voice');
      await setAudioOutputSink(audioEl, voiceId);
    };
    const change = this.decoderOutputQueue.then(apply, apply);
    this.decoderOutputQueue = change;
    return change;
  }

  private async playRemoteAudio(
    category: 'voice' | 'screen',
    audioEl: HTMLAudioElement,
    stream: MediaStream,
  ): Promise<void> {
    const isCurrent = () => audioEl.isConnected && audioEl.srcObject === stream;
    try {
      await this.routeDecoderOutput(audioEl);
    } catch (error) {
      if (category !== 'screen') throw error;
      console.warn('[WebRTC:MediaRouter] Could not align the voice echo-reference device for independent screen playback:', error);
    }
    if (!isCurrent()) return;
    await this.routeAudioOutput(category);
    if (isCurrent()) await audioEl.play();
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
    if (deafened) {
      for (const pipeline of this.voicePipelines.values()) {
        pipeline.gain.gain.value = 0;
      }
    } else {
      this.applyUserVolumes();
    }
  }

  // ── Speaker device routing ──

  public async setSpeakerDeviceId(deviceId: string): Promise<void> {
    await this.setOutputDeviceIds(deviceId, deviceId);
  }

  public async setOutputDeviceIds(voiceDeviceId: string, screenDeviceId: string): Promise<void> {
    const voiceId = normalizeAudioOutputId(voiceDeviceId);
    const screenId = normalizeAudioOutputId(screenDeviceId);
    this.speakerDeviceIds = { voice: voiceId, screen: screenId };
    for (const audioEl of [...this.audioElements.values(), ...this.screenAudioElements.values()]) {
      await this.routeDecoderOutput(audioEl);
    }
    for (const category of this.audioContexts.keys()) await this.routeAudioOutput(category);
  }

  // ── Screen audio routing ──

  public routeScreenAudioTrack(peerSessionId: string, track: MediaStreamTrack): void {
    let screenAudioEl = this.screenAudioElements.get(peerSessionId);
    if (!screenAudioEl) {
      screenAudioEl = document.createElement('audio');
      screenAudioEl.autoplay = true;
      screenAudioEl.volume = 0;
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
    this.applyVolumeToElement(screenAudioEl, volume, peerSessionId, this.screenAudioPipelines, track);
    void this.playRemoteAudio('screen', screenAudioEl, screenStream)
      .catch((error: unknown) => console.warn('[WebRTC:MediaRouter] Screen audio playback failed:', error));
    track.onended = () => {
      if (this.screenAudioElements.get(peerSessionId) === screenAudioEl && screenAudioEl.srcObject === screenStream) {
        this.cleanupScreenAudio(peerSessionId);
      }
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
      audioEl.volume = 0;
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
    this.applyVolumeToElement(audioEl, volume, peerSessionId, this.voicePipelines, audioTrack);
    void this.playRemoteAudio('voice', audioEl, stream)
      .catch((error: unknown) => console.warn('[WebRTC:MediaRouter] Voice audio playback failed:', error));
    return audioEl;
  }

  // ── Volume control (0–200% on the category's output graph) ──
  private applyVolumeToElement(
    audioEl: HTMLAudioElement,
    volume: number,
    sessionId: string,
    pipelineMap: Map<string, AudioPlaybackPipeline>,
    track?: MediaStreamTrack
  ): void {
    const clamped = Math.max(0, Math.min(200, volume));
    const isScreenAudio = audioEl.hasAttribute('data-screen-audio-session');
    const isDeaf = !isScreenAudio && (this.isDeafened || voiceStore.getEffectiveDeafened());

    audioEl.volume = 0;
    if (!isScreenAudio) audioEl.muted = isDeaf;
    this.ensurePlaybackPipeline(sessionId, audioEl, pipelineMap, track);
    const pipeline = pipelineMap.get(sessionId);
    if (pipeline) pipeline.gain.gain.value = audioEl.muted ? 0 : clamped / 100;
  }

  private ensurePlaybackPipeline(
    sessionId: string,
    audioEl: HTMLAudioElement,
    pipelineMap: Map<string, AudioPlaybackPipeline>,
    track?: MediaStreamTrack
  ): void {
    const existingPipeline = pipelineMap.get(sessionId);
    const category = audioEl.hasAttribute('data-screen-audio-session') ? 'screen' : 'voice';

    const audioTrack = track || (audioEl.srcObject as MediaStream | null)?.getAudioTracks()[0];
    if (!audioTrack) {
      this.cleanupAudioPipeline(sessionId, pipelineMap);
      return;
    }
    if (existingPipeline?.trackId === audioTrack.id) return;

    this.cleanupAudioPipeline(sessionId, pipelineMap);

    const ctx = this.getOrCreateAudioContext(category);
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(ctx.destination);

    pipelineMap.set(sessionId, {
      source,
      gain,
      trackId: audioTrack.id,
    });
  }

  public setPeerVolume(peerSessionId: string, volume: number): void {
    const audioEl = this.audioElements.get(peerSessionId);
    if (audioEl) {
      const stream = audioEl.srcObject as MediaStream | null;
      const track = stream?.getAudioTracks()[0];
      this.applyVolumeToElement(audioEl, volume, peerSessionId, this.voicePipelines, track);
    }
  }

  public setScreenAudioVolume(peerSessionId: string, volume: number): void {
    const screenAudioEl = this.screenAudioElements.get(peerSessionId);
    if (screenAudioEl) {
      const stream = screenAudioEl.srcObject as MediaStream | null;
      const track = stream?.getAudioTracks()[0];
      this.applyVolumeToElement(screenAudioEl, volume, peerSessionId, this.screenAudioPipelines, track);
    }
  }

  public applyUserVolumes(): void {
    for (const [peerSessionId, audioEl] of this.audioElements.entries()) {
      const participant = this.getVoiceParticipants().get(peerSessionId);
      const vol = settingsStore.getUserVolume(peerSessionId, participant?.user.clientId);
      const stream = audioEl.srcObject as MediaStream | null;
      const track = stream?.getAudioTracks()[0];
      this.applyVolumeToElement(audioEl, vol, peerSessionId, this.voicePipelines, track);
    }
  }

  // ── Cleanup ──

  private cleanupAudioPipeline(sessionId: string, pipelineMap: Map<string, AudioPlaybackPipeline>): void {
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
    this.cleanupAudioPipeline(peerSessionId, this.screenAudioPipelines);
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
    this.cleanupAudioPipeline(peerSessionId, this.voicePipelines);

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

    for (const pipeline of this.voicePipelines.values()) {
      try {
        pipeline.source.disconnect();
        pipeline.gain.disconnect();
      } catch {}
    }
    this.voicePipelines.clear();

    for (const pipeline of this.screenAudioPipelines.values()) {
      try {
        pipeline.source.disconnect();
        pipeline.gain.disconnect();
      } catch {}
    }
    this.screenAudioPipelines.clear();

    for (const context of this.audioContexts.values()) {
      if (context.state !== 'closed') {
        void context.close().catch((error: unknown) => console.warn('[WebRTC:MediaRouter] Could not close audio context:', error));
      }
    }
    this.audioContexts.clear();
  }
}
