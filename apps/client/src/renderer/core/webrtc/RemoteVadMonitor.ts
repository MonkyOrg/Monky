import type { ParticipantManager } from '../ParticipantManager';
import type { PeerSession } from '../WebRtcManager';

interface AudioLevelReceiver {
  readonly track: Pick<MediaStreamTrack, 'readyState'>;
  getStats(): Promise<RTCStatsReport>;
}

/**
 * Samples each decoded microphone without allocating per tick. Receiver stats
 * remain a fallback when its playback graph is not available yet.
 */
export class RemoteVadMonitor {
  private remoteAudioVads: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(
    private getVoiceParticipants: () => ParticipantManager,
    private getDecodedAudioLevel?: (peerSessionId: string) => number | null,
  ) {}

  public setupRemoteVad(peerSessionId: string, getSession: () => PeerSession | undefined): void {
    this.setupRemoteReceiverVad(peerSessionId, () => {
      const session = getSession();
      if (!session || !session.pc || session.pc.connectionState === 'closed') {
        return null;
      }
      return session.pc.getReceivers().find((r) => r.track?.kind === 'audio');
    });
  }

  public setupRemoteReceiverVad(
    peerSessionId: string,
    getReceiver: () => AudioLevelReceiver | null | undefined
  ): void {
    this.cleanupRemoteVad(peerSessionId);
    const participants = this.getVoiceParticipants();
    let silenceCounter = 0;
    let sampling = false;
    const isCurrent = () => this.remoteAudioVads.get(peerSessionId) === interval
      && this.getVoiceParticipants() === participants;

    const interval = setInterval(async () => {
      if (sampling || !isCurrent()) return;
      sampling = true;
      try {
        const audioReceiver = getReceiver();
        if (!audioReceiver) return;
        const receiverIsCurrent = () => isCurrent() && audioReceiver === getReceiver()
          && audioReceiver.track.readyState !== 'ended';
        if (!receiverIsCurrent()) return;
        let audioLevel = this.getDecodedAudioLevel?.(peerSessionId) ?? undefined;
        if (audioLevel === undefined) {
          const stats = await audioReceiver.getStats();
          if (!receiverIsCurrent()) return;
          for (const report of stats.values()) {
            if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
              if (typeof report.audioLevel === 'number') {
                audioLevel = report.audioLevel;
                break;
              }
            }
          }
        }

        const publishedSpeaking = participants.get(peerSessionId)?.voiceState?.isSpeaking === true;
        if (audioLevel !== undefined || publishedSpeaking) {
          // WebRTC RFC 6464 audioLevel ranges from 0.0 to 1.0 (linear scale).
          // Missing/zero receiver telemetry must not erase published transmission.
          const isVoiceActive = publishedSpeaking || (audioLevel ?? 0) > 0.01;

          if (isVoiceActive) {
            silenceCounter = 0;
            participants.setSpeaking(peerSessionId, true);
          } else {
            silenceCounter++;
            // Brief gaps between words should not make the indicator flicker.
            if (silenceCounter > 3) participants.setSpeaking(peerSessionId, false);
          }
        }
      } catch (error: unknown) {
        if (isCurrent() && getReceiver()?.track.readyState !== 'ended') {
          console.warn('[WebRTC:VAD] Could not sample remote audio:', error);
        }
      } finally {
        sampling = false;
      }
    }, 150);

    this.remoteAudioVads.set(peerSessionId, interval);
  }

  public cleanupRemoteVad(peerSessionId: string): void {
    const interval = this.remoteAudioVads.get(peerSessionId);
    if (interval) {
      clearInterval(interval);
      this.remoteAudioVads.delete(peerSessionId);
    }
  }

  public cleanupAll(): void {
    for (const interval of this.remoteAudioVads.values()) {
      clearInterval(interval);
    }
    this.remoteAudioVads.clear();
  }
}
