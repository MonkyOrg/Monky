import type { NetworkClient } from '../../NetworkClient';
import type { ParticipantManager } from '../../ParticipantManager';
import { appEvents } from '../../EventBus';
import { clientLog } from '../../ClientLogService';
import { RtcDiagnosticsCollector } from '../RtcDiagnosticsCollector';
import { clearLinkTimers, waitForStable, type PeerLink } from './PeerLink';

/** What the recovery needs from the mesh and the call it serves. */
export interface P2pRecoveryHost {
  link(peerSessionId: string): PeerLink | undefined;
  sendOffer(link: PeerLink, iceRestart: boolean): Promise<void>;
  /** Drops a dead link before it is rebuilt. */
  retire(link: PeerLink): void;
  /** Rebuilds a link through the call, which may have moved on meanwhile. */
  reconnect(peerSessionId: string, initiator: boolean): Promise<void>;
  participants(): ParticipantManager;
  channelId(): string | null;
  selfSessionId(): string;
  client(): NetworkClient;
}

/**
 * Keeps each peer link alive and tells the user when one is not happening.
 *
 * A link degrades on its own: a grace period for a brief disconnection, then
 * ICE restarts, then up to three rebuilds. Independently of that ladder, a
 * person not reachable within 20 s is flagged with "no direct connection"
 * (#426), and the ICE candidates the link tried are reported to the server.
 */
export class P2pRecovery {
  /**
   * How long a peer may stay unconnected before the user is told the direct
   * link is not happening (#426).
   *
   * This is deliberately independent of the recovery ladder: waiting for the
   * ICE restarts and hard reconnects to run out took over two minutes, and any
   * momentary `connected` reset the counters and started it over, so the
   * warning could never show. The ladder still runs in the background — this
   * only decides when to warn.
   */
  private static readonly PEER_FAILURE_THRESHOLD_MS = 20000;
  /** A link that drops is given this long to come back by itself. */
  private static readonly DISCONNECT_GRACE_MS = 4000;

  /**
   * One-shot timers that flag a peer as unreachable (#426).
   *
   * Keyed by session id rather than stored on the link, because a hard
   * reconnect throws the link away and builds a new one: a budget living on
   * the link would restart from zero on every retry and the warning would
   * never fire.
   */
  private failureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Peers already flagged as unreachable, so the warning is raised once (#426). */
  private failedPeers = new Set<string>();
  /**
   * Peers we have talked to at least once in this call (#426).
   *
   * Separates "never managed to connect" from "connected and dropped": only the
   * former is reported the moment ICE gives up, since a drop on a link that was
   * working is usually a blip worth waiting out.
   */
  private everConnected = new Set<string>();
  private readonly diagnostics = new RtcDiagnosticsCollector();

  constructor(private readonly host: P2pRecoveryHost) {}

  /** A link is being built: its first connection gets a deadline (#426). */
  public watch(link: PeerLink, timeoutMs = 12000): void {
    if (link.watchdogTimer) clearTimeout(link.watchdogTimer);
    link.watchdogTimer = setTimeout(() => {
      link.watchdogTimer = undefined;
      const state = link.pc.connectionState;
      const iceState = link.pc.iceConnectionState;
      if (state !== 'connected' && state !== 'closed') {
        clientLog.warn('WEBRTC', `Watchdog timeout (${timeoutMs}ms) for peer ${link.peerSessionId}`, { state, iceState });
        console.warn(
          `[WebRTC] Watchdog timeout (${timeoutMs}ms) for peer ${link.peerSessionId} (state=${state}, iceState=${iceState}). Triggering recovery.`
        );
        this.recover(link, 'watchdog_timeout');
      }
    }, timeoutMs);
  }

  public iceStateChanged(link: PeerLink): void {
    const iceState = link.pc.iceConnectionState;
    if (iceState === 'connected' || iceState === 'completed') {
      clearLinkTimers(link);
      link.iceRestartAttempts = 0;
      link.reconnectAttempts = 0;
    } else if (iceState === 'disconnected') {
      this.graceThenRecover(link, 'ice_disconnected', () => link.pc.iceConnectionState === 'disconnected');
    } else if (iceState === 'failed') {
      clearLinkTimers(link);
      console.warn(`[WebRTC] Peer ${link.peerSessionId} ICE state failed. Recovering immediately.`);
      clientLog.error('WEBRTC', `ICE state failed for peer ${link.peerSessionId}`);
      this.reportIfNeverConnected(link);
      this.recover(link, 'ice_failed');
    }
  }

  public connectionStateChanged(link: PeerLink): void {
    const state = link.pc.connectionState;
    const peerSessionId = link.peerSessionId;
    if (state === 'connected') {
      clearLinkTimers(link);
      this.host.participants().setPeerConnecting(peerSessionId, false);
      link.iceRestartAttempts = 0;
      link.reconnectAttempts = 0;
      this.everConnected.add(peerSessionId);
      this.markReachable(peerSessionId);
    } else if (state === 'failed') {
      clearLinkTimers(link);
      appEvents.emit('remote.peer_degraded', { sessionId: peerSessionId });
      this.reportIfNeverConnected(link);
      this.recover(link, 'connection_failed');
    } else if (state === 'disconnected') {
      appEvents.emit('remote.peer_degraded', { sessionId: peerSessionId });
      this.graceThenRecover(link, 'connection_disconnected', () => link.pc.connectionState === 'disconnected');
    }
  }

  /**
   * One grace period per link, whichever state reported the drop first: ICE and
   * the connection usually disconnect together.
   */
  private graceThenRecover(link: PeerLink, reason: string, stillDisconnected: () => boolean): void {
    if (link.disconnectGraceTimer) return;
    link.disconnectGraceTimer = setTimeout(() => {
      link.disconnectGraceTimer = undefined;
      if (!stillDisconnected()) return;
      console.warn(`[WebRTC] Peer ${link.peerSessionId} remained disconnected for 4s (${reason}). Recovering.`);
      this.recover(link, reason);
    }, P2pRecovery.DISCONNECT_GRACE_MS);
  }

  private recover(link: PeerLink, reason: string): void {
    clientLog.warn('WEBRTC', `Recovery triggered for peer ${link.peerSessionId}`, {
      reason,
      iceRestartAttempts: link.iceRestartAttempts,
      connectionState: link.pc.connectionState,
      iceState: link.pc.iceConnectionState,
    });
    // Any degradation reopens the window that decides whether to warn the user,
    // so a peer that drops long after connecting is reported too (#426).
    this.beginFailureCountdown(link.peerSessionId);
    if (link.iceRestartAttempts < 2) {
      void this.restartIce(link, reason);
    } else {
      void this.hardReconnect(link.peerSessionId);
    }
  }

  private async restartIce(link: PeerLink, reason: string): Promise<void> {
    if (link.isRecovering || link.pc.connectionState === 'closed') return;
    link.isRecovering = true;
    link.iceRestartAttempts++;
    clientLog.warn('WEBRTC', `ICE restart #${link.iceRestartAttempts} for peer ${link.peerSessionId}`, { reason });
    console.log(
      `[WebRTC] Attempting ICE restart #${link.iceRestartAttempts} for peer ${link.peerSessionId} (reason: ${reason})`
    );
    try {
      const isStable = await waitForStable(link.pc, 3000);
      if (!isStable && link.pc.signalingState !== 'stable') {
        throw new Error(`PeerConnection not stable (current: ${link.pc.signalingState})`);
      }
      if (typeof link.pc.restartIce === 'function') link.pc.restartIce();
      await this.host.sendOffer(link, true);
      this.watch(link, 10000);
    } catch (err) {
      clientLog.error('WEBRTC', `ICE restart failed for ${link.peerSessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.warn(`[WebRTC] ICE restart failed for ${link.peerSessionId}:`, err);
      await this.hardReconnect(link.peerSessionId);
    } finally {
      link.isRecovering = false;
    }
  }

  private async hardReconnect(peerSessionId: string): Promise<void> {
    const existing = this.host.link(peerSessionId);
    const attempts = (existing?.reconnectAttempts || 0) + 1;

    if (attempts > 3) {
      clientLog.error('WEBRTC', `Max hard reconnect attempts (3) reached for peer ${peerSessionId} — giving up`);
      console.warn(`[WebRTC] Max hard reconnect attempts reached for peer ${peerSessionId}. Aborting recovery.`);
      this.markFailed(peerSessionId, existing);
      return;
    }

    clientLog.warn('WEBRTC', `Hard reconnect #${attempts} for peer ${peerSessionId}`);
    console.log(`[WebRTC] Performing Hard Reconnect #${attempts} for peer ${peerSessionId}...`);
    if (existing) this.host.retire(existing);

    // Exponential backoff delay (1s, 2s, 4s)
    const backoffMs = Math.min(4000, 1000 * Math.pow(2, attempts - 1));
    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    const channelId = this.host.channelId();
    if (!channelId || this.host.participants().get(peerSessionId)?.voiceState?.channelId !== channelId) return;

    const isInitiator = this.host.selfSessionId().localeCompare(peerSessionId) < 0;
    await this.host.reconnect(peerSessionId, isInitiator);
    const rebuilt = this.host.link(peerSessionId);
    if (rebuilt) rebuilt.reconnectAttempts = attempts;
  }

  /**
   * Starts counting down to the "no direct connection" warning for a peer.
   *
   * Idempotent: an already running countdown is left alone so the elapsed time
   * survives every ICE restart and hard reconnect in between.
   */
  public beginFailureCountdown(peerSessionId: string): void {
    if (this.failureTimers.has(peerSessionId) || this.failedPeers.has(peerSessionId)) return;

    // Both entry points for this countdown (first attempt and recovery) are
    // exactly the moments when media is not flowing yet, which is what the
    // "connecting" indicator reports (#433).
    this.host.participants().setPeerConnecting(peerSessionId, true);

    const timer = setTimeout(() => {
      this.failureTimers.delete(peerSessionId);
      const link = this.host.link(peerSessionId);
      if (link?.pc.connectionState === 'connected') return;
      this.markFailed(peerSessionId, link);
    }, P2pRecovery.PEER_FAILURE_THRESHOLD_MS);

    this.failureTimers.set(peerSessionId, timer);
  }

  private clearFailureCountdown(peerSessionId: string): void {
    const timer = this.failureTimers.get(peerSessionId);
    if (timer) {
      clearTimeout(timer);
      this.failureTimers.delete(peerSessionId);
    }
  }

  /**
   * Flags a peer as unreachable and reports the ICE candidates to the server.
   *
   * The participant state is written here, at the source, instead of relying on
   * a view listening to the event: the failure often happens while the user is
   * somewhere other than the voice stage, and a warning nobody was mounted to
   * receive was silently lost (#426).
   */
  private markFailed(peerSessionId: string, link: PeerLink | undefined): void {
    if (this.failedPeers.has(peerSessionId)) return;
    clientLog.error('WEBRTC', `Peer ${peerSessionId} marked as unreachable`, {
      connectionState: link?.pc.connectionState,
      iceState: link?.pc.iceConnectionState,
      iceRestartAttempts: link?.iceRestartAttempts,
      reconnectAttempts: link?.reconnectAttempts,
    });
    this.failedPeers.add(peerSessionId);
    this.clearFailureCountdown(peerSessionId);
    const participants = this.host.participants();
    participants.setPeerConnecting(peerSessionId, false);
    participants.setPeerConnectionFailed(peerSessionId, true);
    void this.diagnostics.sendDiagnosticsReport(peerSessionId, link, this.host.client());
    appEvents.emit('remote.peer_failed', { sessionId: peerSessionId });
  }

  /**
   * Reports a peer the moment ICE gives up, but only if it never connected.
   *
   * `failed` is ICE's own verdict that every candidate pair was exhausted, so
   * for a link that never worked there is nothing left to wait for — warning
   * right away beats sitting on the timer. A link that had been up keeps the
   * grace period so a brief network blip does not flash the warning (#426).
   */
  private reportIfNeverConnected(link: PeerLink): void {
    if (this.everConnected.has(link.peerSessionId)) return;
    this.markFailed(link.peerSessionId, link);
  }

  /** Clears the warning once the peer is reachable again (#426). */
  private markReachable(peerSessionId: string): void {
    this.clearFailureCountdown(peerSessionId);
    if (!this.failedPeers.delete(peerSessionId)) return;
    this.host.participants().setPeerConnectionFailed(peerSessionId, false);
    appEvents.emit('remote.peer_recovered', { sessionId: peerSessionId });
  }

  /**
   * Wipes everything known about a peer link (#466).
   *
   * The indicators describe a link, not a person, so they have to go the moment
   * the link does. Leaving them behind is what kept the relay badge on somebody
   * after the call ended, and showed "no direct connection" next to a person
   * sitting in a different voice channel — where there is no link at all.
   */
  public forget(peerSessionId: string): void {
    this.clearFailureCountdown(peerSessionId);
    const participants = this.host.participants();
    participants.setPeerConnecting(peerSessionId, false);
    participants.setPeerConnectionFailed(peerSessionId, false);
    participants.setPeerRelayed(peerSessionId, false);
    this.failedPeers.delete(peerSessionId);
    this.everConnected.delete(peerSessionId);
  }

  /** The call ended: no countdown survives it. */
  public reset(): void {
    for (const timer of this.failureTimers.values()) clearTimeout(timer);
    this.failureTimers.clear();
    this.failedPeers.clear();
    this.everConnected.clear();
  }
}
