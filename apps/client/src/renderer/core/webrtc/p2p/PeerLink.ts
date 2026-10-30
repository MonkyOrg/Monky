/**
 * One offer/answer exchange with a peer. A newer exchange replaces it, so one
 * that resumes after an await stops instead of applying a stale description.
 */
export type PeerNegotiation = object;

/**
 * One RTCPeerConnection of the P2P mesh: the link to one participant.
 *
 * Kept as plain data, so the mesh, its recovery and the tests all read and
 * write the same record; the operations on it live in P2pMeshTransport.
 */
export interface PeerLink {
  /** Bots may receive one authorized microphone, never camera or screen media. */
  botPeer?: boolean;
  receiveOnly?: boolean;
  botAudioSync?: Promise<void>;
  peerSessionId: string;
  pc: RTCPeerConnection;
  isPolite: boolean;
  makingOffer: boolean;
  /** Candidates that arrived before any remote description, bounded (R-VOICE-7). */
  candidateQueue: RTCIceCandidateInit[];
  /** The queue overflowed since it was last flushed; logged once. */
  candidatesDropped?: boolean;
  /**
   * The last offer from this peer was dropped as the impolite side of a
   * collision, so the candidates that follow it are expected not to apply.
   */
  ignoreOffer?: boolean;
  /**
   * A local change (such as the camera direction) still has to reach this peer
   * in an offer. Raised by the change, cleared by the next offer or answer, which
   * carry it — so a peer that is not answering holds up only its own link.
   */
  negotiationNeeded?: boolean;
  audioSender?: RTCRtpSender | null;
  videoSender?: RTCRtpSender | null;
  /**
   * Identity of this connection, sent with every offer and answer. The Light and
   * the bot SDK tell a rebuilt connection from the same session apart by it.
   */
  subscriptionId: string;
  negotiation?: PeerNegotiation;
  // Auto-recovery and retry management (P2pRecovery)
  iceRestartAttempts: number;
  reconnectAttempts: number;
  watchdogTimer?: ReturnType<typeof setTimeout>;
  disconnectGraceTimer?: ReturnType<typeof setTimeout>;
  isRecovering: boolean;
  /**
   * Last relay verdict pushed to the participant list, so the periodic sample
   * only writes (and logs) when the route actually changes (#466).
   */
  isRelayed?: boolean;
}

/** The connection carries a single audio m-line: the microphone. */
export function microphoneTransceiver(link: PeerLink): RTCRtpTransceiver | undefined {
  return link.pc.getTransceivers().find((transceiver) =>
    transceiver.receiver.track.kind === 'audio' || transceiver.sender.track?.kind === 'audio');
}

/** The connection carries a single video m-line: the camera. */
export function cameraTransceiver(link: PeerLink): RTCRtpTransceiver | undefined {
  return link.pc.getTransceivers().find((transceiver) =>
    transceiver.receiver.track.kind === 'video' || transceiver.sender.track?.kind === 'video');
}

/**
 * Wait for a peer connection's signaling state to become 'stable'.
 * Returns immediately if already stable, otherwise waits up to timeoutMs.
 */
export function waitForStable(pc: RTCPeerConnection, timeoutMs = 5000): Promise<boolean> {
  if (pc.signalingState === 'stable') return Promise.resolve(true);
  if (pc.signalingState === 'closed') return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onStateChange = () => {
      if (pc.signalingState === 'stable' || pc.signalingState === 'closed') {
        pc.removeEventListener('signalingstatechange', onStateChange);
        clearTimeout(timer);
        resolve(pc.signalingState === 'stable');
      }
    };
    const timer = setTimeout(() => {
      pc.removeEventListener('signalingstatechange', onStateChange);
      resolve(pc.signalingState === 'stable');
    }, timeoutMs);
    pc.addEventListener('signalingstatechange', onStateChange);
  });
}

/**
 * True if any local sender track sits on a transceiver that has never been
 * negotiated (mid === null). This happens when an offer that would have
 * negotiated the track was discarded by an offer-collision rollback — leaving
 * e.g. a camera added locally but never sent over the wire.
 */
export function hasUnnegotiatedSenders(pc: RTCPeerConnection): boolean {
  return pc.getTransceivers().some((transceiver) => !!transceiver.sender.track && transceiver.mid === null);
}

export function clearLinkTimers(link: PeerLink): void {
  if (link.watchdogTimer) {
    clearTimeout(link.watchdogTimer);
    link.watchdogTimer = undefined;
  }
  if (link.disconnectGraceTimer) {
    clearTimeout(link.disconnectGraceTimer);
    link.disconnectGraceTimer = undefined;
  }
}

/**
 * The single teardown of a link, whatever replaces or ends it: a departure, a
 * hard reconnect or a new connection to the same person. Authority is retired
 * before the connection closes, so a native callback still queued can never
 * recreate playback or signal for a link that is gone.
 */
export function closeLink(link: PeerLink): void {
  clearLinkTimers(link);
  link.pc.ontrack = null;
  link.pc.onicecandidate = null;
  link.pc.oniceconnectionstatechange = null;
  link.pc.onconnectionstatechange = null;
  for (const { track } of link.pc.getReceivers()) {
    track.onended = null;
    track.onunmute = null;
  }
  link.candidateQueue.length = 0;
  try {
    link.pc.close();
  } catch {
    // An already closed connection has nothing left to release.
  }
}
