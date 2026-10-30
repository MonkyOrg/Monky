import type { ParticipantManager } from '../ParticipantManager';
import type { AudioLevelReceiver } from './RemoteVadMonitor';

export type RemoteMediaKind = 'mic' | 'camera';

export interface RemoteTrack {
  readonly peerSessionId: string;
  readonly kind: RemoteMediaKind;
  readonly track: MediaStreamTrack;
  /** Receiver of a microphone, read for its voice activity while no playback graph exists. */
  readonly receiver?: () => AudioLevelReceiver | null | undefined;
}

interface Delivered {
  readonly track: MediaStreamTrack;
  /** The stream handed out for the track, kept so a repeated arrival changes nothing. */
  readonly stream: MediaStream;
}

/** What the sink plays remote microphones through (RemoteMediaRouter). */
export interface RemoteAudioPlayback {
  ensureVoiceAudioElement(peerSessionId: string, stream: MediaStream): unknown;
  removeVoiceAudio(peerSessionId: string): void;
  cleanupPeerMedia(peerSessionId: string): void;
  closeAllMedia(): void;
  setOutputDeviceIds(voiceDeviceId: string, screenDeviceId: string): Promise<void>;
}

/** What samples the voice activity of remote microphones (RemoteVadMonitor). */
export interface RemoteVoiceActivity {
  setupRemoteReceiverVad(peerSessionId: string, getReceiver: () => AudioLevelReceiver | null | undefined): void;
  cleanupRemoteVad(peerSessionId: string): void;
  cleanupAll(): void;
}

/**
 * Where every remote microphone and camera ends up, whichever transport carried
 * it (R-VOICE-5). A P2P link reports its receiver tracks and the SFU its
 * consumers; the rules are applied here once:
 *
 * - the microphone of our own other device is dropped, or the speakers of one
 *   device would feed the microphone of the other (#309);
 * - a microphone plays through the router, with its voice activity sampled;
 * - a camera becomes the participant's `remoteStream`. The core never touches
 *   the views: the stage attaches the stream to its own elements.
 *
 * Every track gets a stream of its own, kept while the track lasts, so a view
 * sees a new object only when the media really changed.
 */
export class RemoteMediaSink {
  private readonly microphones = new Map<string, Delivered>();
  private readonly cameras = new Map<string, Delivered>();

  constructor(
    private readonly participants: () => ParticipantManager,
    private readonly router: RemoteAudioPlayback,
    private readonly vad: RemoteVoiceActivity,
    private readonly isOwnOtherDevice: (peerSessionId: string) => boolean,
    /** Output of the screens' audio, played by the native screen owner. */
    private readonly setScreenOutput: (deviceId: string) => Promise<void>,
  ) {}

  public trackArrived({ peerSessionId, kind, track, receiver }: RemoteTrack): void {
    if (kind === 'mic' && this.isOwnOtherDevice(peerSessionId)) {
      console.log(`[RemoteMedia] Dropping the microphone of our own other device (${peerSessionId})`);
      return;
    }
    const delivered = kind === 'mic' ? this.microphones : this.cameras;
    const current = delivered.get(peerSessionId);
    const media = current?.track === track ? current : { track, stream: new MediaStream([track]) };
    delivered.set(peerSessionId, media);
    if (kind === 'camera') {
      this.participants().setRemoteStream(peerSessionId, media.stream);
      return;
    }
    this.router.ensureVoiceAudioElement(peerSessionId, media.stream);
    if (media !== current) this.vad.setupRemoteReceiverVad(peerSessionId, receiver ?? (() => null));
  }

  /** A track that went quiet carries media again: replays the microphone, refreshes the camera. */
  public trackUnmuted(peerSessionId: string, kind: RemoteMediaKind, track: MediaStreamTrack): void {
    const media = (kind === 'mic' ? this.microphones : this.cameras).get(peerSessionId);
    if (media?.track !== track) return;
    if (kind === 'mic') this.router.ensureVoiceAudioElement(peerSessionId, media.stream);
    else this.participants().setRemoteStream(peerSessionId, media.stream);
  }

  /**
   * A track stopped for good: its consumer closed, or its receiver ended. A
   * newer track that already took its place is left alone.
   */
  public trackEnded(peerSessionId: string, kind: RemoteMediaKind, track: MediaStreamTrack): void {
    const delivered = kind === 'mic' ? this.microphones : this.cameras;
    const media = delivered.get(peerSessionId);
    if (media?.track !== track) return;
    delivered.delete(peerSessionId);
    track.stop();
    if (kind === 'mic') {
      this.vad.cleanupRemoteVad(peerSessionId);
      this.router.removeVoiceAudio(peerSessionId);
      return;
    }
    // The stream stays: the stage keeps its element instead of rebuilding the card.
    media.stream.removeTrack(track);
    this.participants().setRemoteStream(peerSessionId, media.stream);
  }

  /** The person left the call, or their link is being rebuilt. */
  public peerGone(peerSessionId: string): void {
    this.vad.cleanupRemoteVad(peerSessionId);
    this.router.cleanupPeerMedia(peerSessionId);
    for (const delivered of [this.microphones, this.cameras]) {
      delivered.get(peerSessionId)?.track.stop();
      delivered.delete(peerSessionId);
    }
  }

  /**
   * The link carrying this person's media dropped and is being rebuilt. Their
   * voice activity stops until a new microphone arrives; the element keeps
   * playing whatever the new link brings, as do the camera tile and its card.
   */
  public linkLost(peerSessionId: string): void {
    this.vad.cleanupRemoteVad(peerSessionId);
    this.microphones.delete(peerSessionId);
  }

  public closeAll(): void {
    for (const delivered of [this.microphones, this.cameras]) {
      for (const media of delivered.values()) media.track.stop();
      delivered.clear();
    }
    this.router.closeAllMedia();
    this.vad.cleanupAll();
  }

  /**
   * The one place remote media gets its output devices: voices, and the
   * screens' audio wherever it plays.
   */
  public async setOutputDevices(voiceDeviceId: string, screenDeviceId: string): Promise<void> {
    await this.router.setOutputDeviceIds(voiceDeviceId, screenDeviceId);
    await this.setScreenOutput(screenDeviceId);
  }
}
