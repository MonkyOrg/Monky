import type { QualityPresetType, QualityProfile } from '@monky/shared';

/** Restores what a microphone switch changed, if it has to be undone. */
export type Rollback = () => Promise<void>;

/** A switch of the published microphone (another device, a fallback after a failure). */
export interface MicrophoneChange {
  readonly track: MediaStreamTrack;
  /** The microphone published until now; the SFU puts it back on rollback. */
  readonly previous: MediaStreamTrack | null;
  /** Throws an AbortError once the switch is no longer wanted. */
  ensureCurrent(): void;
  /** Whether the call the switch started in is still the one on air. */
  sameSession(): boolean;
}

/**
 * How the call's media travels (R-VOICE-2): the P2P mesh (P2pMeshTransport) or
 * the SFU (SfuCallSession). The WebRtcManager keeps one API for the views and
 * hands each of these operations to the transport of the call; what only one
 * of them has — signalling, bots and the recovery ladder of the mesh, the join
 * ladder of the SFU — stays on that transport.
 */
export interface VoiceTransport {
  readonly mode: 'p2p' | 'sfu';
  /** Somebody is in the call: the mesh links up with them, the SFU makes sure the room is joined. */
  addParticipant(peerSessionId: string, initiator: boolean): Promise<void>;
  /** Publishes the call's microphone, or stops publishing it. */
  setMicrophone(track: MediaStreamTrack | null): Promise<void>;
  /** Switches the published microphone as one change, and says how to undo it. */
  replaceMicrophone(change: MicrophoneChange): Promise<Rollback>;
  /** Publishes the call's camera, or stops publishing it; `ensureCurrent` cancels it between steps. */
  setCamera(track: MediaStreamTrack | null, ensureCurrent: () => void): Promise<void>;
  /** Takes a camera that failed to publish off the transport. */
  detachCamera(track: MediaStreamTrack): Promise<void>;
  /** The shared encoding policy on what is published, until `isCurrent` says a newer one won. */
  applyQuality(preset: QualityPresetType, profile: QualityProfile, isCurrent: () => boolean): Promise<void>;
  /** Round trip of the media path in milliseconds, or null while none is measured. */
  samplePing(): Promise<number | null>;
  /** Every sender of the local camera (#493). */
  cameraSenders(): RTCRtpSender[];
  /** The receiver of one remote track, for its inbound stats (#340). */
  receiverForTrack(peerSessionId: string, trackId: string): RTCRtpReceiver | null;
}
