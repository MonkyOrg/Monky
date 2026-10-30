import type { QualityPresetType, QualityProfile } from '@monky/shared';
import type { NetworkClient } from '../../NetworkClient';
import type { ParticipantManager } from '../../ParticipantManager';
import { appEvents } from '../../EventBus';
import { clientLog } from '../../ClientLogService';
import { voiceStore } from '../../../stores/voiceStore';
import type { RemoteMediaSink } from '../RemoteMediaSink';
import { SfuClientEngine } from '../SfuClientEngine';
import type { MicrophoneChange, Rollback, VoiceTransport } from '../VoiceTransport';

/** What the SFU session needs from the call it carries. */
export interface SfuCallHost {
  /** Signalling of the call (#400). */
  client(): NetworkClient;
  selfSessionId(): string;
  /** The server hosting the call is configured for the SFU. */
  isSfuMode(): boolean;
  /** The call is being admitted again; its media waits. */
  isSuspended(): boolean;
  participants(): ParticipantManager;
  /** What the call publishes. */
  microphone(): MediaStreamTrack | null;
  camera(): MediaStreamTrack | null;
  readonly media: RemoteMediaSink;
  /** The room's roster changed: the screen sources follow it. */
  rosterChanged(): void;
  /** The microphone track ended under the call, which carries on listen-only (R-VOICE-12). */
  microphoneEnded(track: MediaStreamTrack): void;
  /** A camera the call still wanted could not be published on a join. */
  cameraFailed(track: MediaStreamTrack, error: unknown): void;
  /** The shared quality policy, seeded before and after publishing. */
  applyQuality(): Promise<void>;
  /** Media flows again: the call is measured at once. */
  mediaFlowing(): void;
}

/**
 * The SFU transport: one room on the server, joined with a send and a receive
 * transport, which every participant publishes to and consumes from.
 *
 * A join takes several round-trips, so it is guarded by an epoch and never runs
 * twice at once. When the room drops there is nothing to degrade to, so a
 * rejoin ladder with backoff retries for as long as the user sits in the call.
 */
export class SfuCallSession implements VoiceTransport {
  /**
   * Ceiling for the rejoin backoff.
   *
   * Unlike a peer link, the SFU has nothing to degrade to: if it is down the
   * call is down. So the ladder never gives up while the user sits in the
   * channel — it backs off to this delay and keeps retrying from there.
   */
  private static readonly RECONNECT_MAX_DELAY_MS = 15000;
  /**
   * Failed rejoins before the user is told, which is deliberately later than
   * the first attempt: a transport that drops and comes straight back should
   * not raise an alert nobody needs to act on.
   */
  private static readonly RECONNECT_WARN_AFTER = 3;

  public readonly mode = 'sfu';
  public readonly engine: SfuClientEngine;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private joining = false;
  /**
   * A join was asked for while another was running. The one in flight captured
   * the channel as it was when it started, so it cannot serve a request made
   * after the state moved: it runs again once the current one unwinds.
   */
  private joinRequested = false;
  /**
   * Bumped whenever the session is torn down or a new join starts. A join
   * takes several round-trips, and the user can leave the channel or a newer
   * join can begin while an older one is still awaiting; comparing the epoch
   * it started with is what tells the stale join to undo itself instead of
   * finishing and reviving a session nobody is in.
   */
  private epoch = 0;

  constructor(private readonly host: SfuCallHost) {
    this.engine = new SfuClientEngine(
      () => host.client(),
      () => host.selfSessionId(),
      {
        onHealthChanged: (health) => voiceStore.setConnectionHealth(health),
        onRoster: (channelId, participants) => {
          if (voiceStore.currentVoiceChannelId !== channelId) return;
          host.participants().reconcileVoiceChannel(channelId, participants);
          host.rosterChanged();
        },
        onConsumerTrack: ({ producerSessionId, mediaType, track, rtpReceiver }) => host.media.trackArrived({
          peerSessionId: producerSessionId, kind: mediaType, track, receiver: () => rtpReceiver,
        }),
        onConsumerClosed: (producerSessionId, mediaType, track) => {
          if (track && (mediaType === 'mic' || mediaType === 'camera')) {
            host.media.trackEnded(producerSessionId, mediaType, track);
          }
        },
        onConnectionFailed: (reason) => this.connectionFailed(reason),
        onConnected: () => this.connected(),
      },
    );
  }

  /** Failed rejoins in a row, reset once media flows again. */
  public get reconnectAttempts(): number {
    return this.attempts;
  }

  /** Identity of the current join; a microphone switch that outlives it is cancelled. */
  public get joinEpoch(): number {
    return this.epoch;
  }

  public isReady(): boolean {
    return this.engine.isReady();
  }

  /** Joins the room unless a session or a rejoin ladder already owns it. */
  public async ensureJoined(): Promise<void> {
    if (this.host.isSuspended() || this.host.client().getStatus() !== 'CONNECTED' || this.engine.isReady()) return;
    // A rejoin ladder already owns the connection: joining again from here
    // would race it and strand a second set of transports on the server. This
    // path is reached for every participant that joins, so an SFU that is down
    // would otherwise get one extra join per participant, ignoring the backoff.
    if (this.reconnectTimer) return;
    await this.join();
  }

  /**
   * Builds the session for the channel the user is in and publishes whatever
   * is being captured locally.
   *
   * Everything after the first await can outlive what asked for it: joining
   * takes several round-trips, during which the user can leave the channel,
   * the server can be switched to P2P, or a rejoin can tear the session down.
   * A join that resumes into any of those would rebuild transports for a
   * session nobody is in, leaving the engine reporting itself connected to a
   * channel that was already left — so it checks the epoch it started with and
   * undoes itself instead.
   */
  private async join(): Promise<void> {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId || !this.host.isSfuMode() || this.host.isSuspended()
      || this.host.client().getStatus() !== 'CONNECTED') return;
    // Two joins in flight interleave their assignments inside the engine and
    // can leave it holding a send transport from one and a recv transport from
    // the other, whose server-side peer is already gone. The request is not
    // dropped, though: the running join captured the channel as it was when it
    // started, so a state change since then may be exactly what it is missing.
    // Switching voice channels does both at once — the join for the old
    // channel is still in flight when the join for the new one is asked for —
    // and dropping the second one left the client in the new channel with no
    // session at all, because the first then discarded itself for being stale.
    if (this.joining) {
      this.joinRequested = true;
      return;
    }

    const epoch = ++this.epoch;
    this.joining = true;
    try {
      const ok = await this.engine.join(channelId);
      if (this.isJoinStale(epoch, channelId)) {
        this.engine.leave();
        return;
      }
      if (!ok) {
        this.connectionFailed('Could not join the SFU room for this channel');
        return;
      }

      // Seed the common policy before any new sender starts publishing.
      await this.host.applyQuality();
      if (this.isJoinStale(epoch, channelId)) {
        this.engine.leave();
        return;
      }
      // Speak denied: stay in the call listening; publish once it is allowed.
      const microphone = this.host.microphone();
      if (microphone && !voiceStore.permissionMuted) {
        const producer = await this.engine.produceMic(microphone);
        if (this.isJoinStale(epoch, channelId)) return;
        if (!producer && microphone.readyState !== 'live') {
          this.host.microphoneEnded(microphone);
        } else if (!producer && !this.engine.isMicrophoneDenied()) {
          this.connectionFailed('Could not publish the microphone to the SFU');
          return;
        }
      }
      const camera = this.host.camera();
      if (camera) {
        if (this.isJoinStale(epoch, channelId)) {
          this.engine.leave();
          return;
        }
        try {
          const producer = await this.engine.produceCamera(camera);
          if (!producer) throw new Error('SFU camera transport is unavailable');
        } catch (error) {
          if (!this.isJoinStale(epoch, channelId)) this.host.cameraFailed(camera, error);
        }
      }

      // A user may have changed the profile while publication was awaiting SDP.
      await this.host.applyQuality();

      if (this.isJoinStale(epoch, channelId)) {
        this.engine.leave();
      } else {
        this.engine.settlePublication();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      clientLog.error('SFU', 'SFU join threw', { error: message });
      // Without this the ladder would end here: the throw is what the retry
      // exists for, and nothing else would schedule the next attempt.
      if (!this.isJoinStale(epoch, channelId)) {
        this.connectionFailed(message);
      }
    } finally {
      this.joining = false;
      // Only re-run when the finished join did not already serve the request:
      // it may well have been for this very channel, and rebuilding a healthy
      // session closes the producers everyone is consuming — a room-wide audio
      // gap every time someone new arrives mid-join. The ladder is left alone
      // for the same reason `ensureJoined` refuses to run under it.
      const queued = this.joinRequested;
      this.joinRequested = false;
      if (queued && !this.reconnectTimer && !this.engine.isReady()) {
        await this.join();
      }
    }
  }

  /** Whether the join that started at `epoch` still describes the session the user is actually in. */
  private isJoinStale(epoch: number, channelId: string): boolean {
    return (
      this.epoch !== epoch ||
      voiceStore.currentVoiceChannelId !== channelId ||
      this.host.isSuspended() ||
      this.host.client().getStatus() !== 'CONNECTED' ||
      !this.host.isSfuMode()
    );
  }

  /**
   * The room is down, so rebuild it — there is nothing to fall back to.
   *
   * An earlier version dropped the call into a P2P mesh here. It could not
   * work: only the side whose transport failed switched protocol, while the
   * other kept answering as an SFU client and discarded the incoming offer,
   * so the mesh never formed and the call went silent behind a reassuring
   * "contingency active" notice. Retrying the SFU is both simpler and honest
   * about what is happening.
   */
  private connectionFailed(reason: string): void {
    if (!this.host.isSfuMode() || !voiceStore.currentVoiceChannelId || this.host.isSuspended()
      || this.host.client().getStatus() !== 'CONNECTED') return;
    // Send and recv transports usually fail together; one ladder covers both.
    if (this.reconnectTimer) return;

    this.attempts++;
    const attempt = this.attempts;
    const delay = Math.min(SfuCallSession.RECONNECT_MAX_DELAY_MS, 1000 * Math.pow(2, attempt - 1));

    clientLog.warn('SFU', `SFU connection failed — rejoin #${attempt} in ${delay}ms`, { reason });
    console.warn(`[SFU] Connection failed (${reason}). Rejoin #${attempt} in ${delay}ms.`);
    voiceStore.setReconnecting(true);

    if (attempt === SfuCallSession.RECONNECT_WARN_AFTER) {
      appEvents.emit('sfu.reconnecting', { reason });
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.rejoin();
    }, delay);
  }

  /** Tears the session down and builds it again from scratch. */
  private async rejoin(): Promise<void> {
    if (!voiceStore.currentVoiceChannelId || !this.host.isSfuMode() || this.host.isSuspended()
      || this.host.client().getStatus() !== 'CONNECTED') return;
    // A join from an earlier rung is still running. Cutting it off here would
    // leave nobody to schedule the next one, so let it finish and take the
    // following rung instead.
    if (this.joining) {
      this.connectionFailed('A previous SFU join is still in flight');
      return;
    }

    this.abandon();
    // Calls the inner join directly: it schedules the next rung on its own if
    // this attempt fails.
    await this.join();
  }

  /** Closes the ladder once media is flowing again. */
  private connected(): void {
    if (!voiceStore.currentVoiceChannelId || this.host.isSuspended()
      || this.host.client().getStatus() !== 'CONNECTED') return;
    this.host.mediaFlowing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const wasRecovering = this.attempts > 0;
    this.attempts = 0;
    // The engine already reported the health; this only clears a recovery
    // flag, and must not turn an `idle` call into a connected one.
    if (voiceStore.isReconnecting) voiceStore.setReconnecting(false);
    if (wasRecovering) {
      clientLog.info('SFU', 'SFU connection restored');
      appEvents.emit('sfu.reconnected');
    }
  }

  /**
   * Drops the session and disowns any join still in flight, so one that
   * resumes afterwards undoes itself rather than rebuilding what was just
   * torn down.
   */
  private abandon(): void {
    this.epoch++;
    this.engine.leave();
  }

  /**
   * Stops the reconnection ladder. It deliberately does not touch `joining`:
   * clearing a mutex a running join still owns is how two of them end up
   * interleaved.
   */
  private resetReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempts = 0;
  }

  /** The call ended or moved: no session, no ladder. */
  public close(): void {
    this.abandon();
    this.resetReconnect();
  }

  /** Publishes the microphone that was withheld while Speak was denied. */
  public async syncMicrophonePublication(): Promise<void> {
    const track = this.host.microphone();
    if (!this.host.isSfuMode() || this.host.isSuspended() || this.joining || voiceStore.permissionMuted ||
        !track || track.readyState !== 'live' || !this.engine.isReady() || this.engine.hasMicrophonePublication()) return;
    await this.engine.produceMic(track);
  }

  public async addParticipant(): Promise<void> {
    if (!this.engine.isReady()) await this.ensureJoined();
  }

  public async setMicrophone(track: MediaStreamTrack | null): Promise<void> {
    if (!this.engine.isReady()) {
      await this.ensureJoined();
    } else if (track && !voiceStore.permissionMuted) {
      await this.engine.produceMic(track);
    } else {
      this.engine.closeProducer('mic');
    }
  }

  public async replaceMicrophone({ track, previous, ensureCurrent, sameSession }: MicrophoneChange): Promise<Rollback> {
    if (!this.engine.hasMicrophonePublication() && voiceStore.permissionMuted) {
      // Speak is denied: nothing is published, so the track is swapped locally
      // and published once the permission returns.
      return async () => {};
    }
    if (!previous) {
      // The user may have joined receive-only after capture failed.
      if (!this.engine.isReady()) throw new Error('SFU microphone transport is not ready');
      const producer = await this.engine.produceMic(track);
      const rollback: Rollback = async () => {
        if (sameSession()) this.engine.closeProducer('mic');
        else producer?.close();
      };
      try {
        ensureCurrent();
        if (!producer) throw new Error('Could not publish SFU microphone');
      } catch (error) {
        await rollback();
        throw error;
      }
      return rollback;
    }
    if (!await this.engine.replaceTrack('mic', track)) throw new Error('Could not replace SFU microphone');
    const rollback: Rollback = async () => {
      if (sameSession() && !await this.engine.replaceTrack('mic', previous)) {
        console.warn('[WebRTC] Could not restore the previous SFU microphone');
      }
    };
    try {
      ensureCurrent();
    } catch (error) {
      await rollback();
      throw error;
    }
    return rollback;
  }

  public async setCamera(track: MediaStreamTrack | null, ensureCurrent: () => void): Promise<void> {
    if (!track) {
      this.closeCamera();
      return;
    }
    if (!this.engine.isReady()) await this.ensureJoined();
    ensureCurrent();
    if (!this.engine.isReady()) throw new Error('SFU camera transport is not ready');
    const current = this.engine.getCameraTrack();
    if (current === track) return;
    if (current) {
      if (!await this.engine.replaceTrack('camera', track)) throw new Error('Could not replace SFU camera');
    } else if (!await this.engine.produceCamera(track)) {
      throw new Error('Could not publish SFU camera');
    }
  }

  /** Stops publishing the camera, whatever track it carries. */
  public closeCamera(): void {
    this.engine.closeProducer('camera');
  }

  public async detachCamera(track: MediaStreamTrack): Promise<void> {
    if (this.engine.getCameraTrack() === track) this.engine.closeProducer('camera');
  }

  public async applyQuality(preset: QualityPresetType, profile: QualityProfile, isCurrent: () => boolean): Promise<void> {
    if (isCurrent()) await this.engine.applyQualityParams(preset, profile);
  }

  /** The SFU reports the worse of its two transports, which lead to the same server. */
  public samplePing(): Promise<number | null> {
    return this.engine.getPing();
  }

  public cameraSenders(): RTCRtpSender[] {
    const sender = this.engine.getCameraSender();
    return sender ? [sender] : [];
  }

  public receiverForTrack(_peerSessionId: string, trackId: string): RTCRtpReceiver | null {
    return this.engine.getReceiverForTrack(trackId);
  }
}
