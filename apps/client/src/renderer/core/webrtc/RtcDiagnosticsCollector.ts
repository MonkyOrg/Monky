import {
  MessageType,
  RtcCandidateInfo,
  RtcDiagnosticsReportPayload,
} from '@monky/shared';
import type { NetworkClient } from '../NetworkClient';
import type { PeerLink } from './p2p/PeerLink';
import { diagnosticCandidateRoute, type CandidateEndpoint } from './rtcStats';

function candidateInfo(candidate: CandidateEndpoint | null): RtcCandidateInfo | null {
  if (!candidate) return null;
  return {
    type: candidate.type ?? 'unknown',
    ...(candidate.address ? { address: candidate.address } : {}),
    ...(candidate.port !== null ? { port: candidate.port } : {}),
    ...(candidate.protocol ? { protocol: candidate.protocol } : {}),
  };
}

/**
 * Sends the server what a failing peer link tried, so an admin can diagnose
 * NAT and connectivity problems from the server log (#426).
 */
export class RtcDiagnosticsCollector {
  public async sendDiagnosticsReport(
    peerSessionId: string,
    session: PeerLink | undefined,
    signalClient: NetworkClient
  ): Promise<void> {
    let localCandidate: RtcCandidateInfo | null = null;
    let remoteCandidate: RtcCandidateInfo | null = null;
    let iceGatheringState = 'unknown';
    let signalingState = 'unknown';

    if (session?.pc) {
      try {
        iceGatheringState = session.pc.iceGatheringState;
        signalingState = session.pc.signalingState;
        const route = diagnosticCandidateRoute(await session.pc.getStats());
        localCandidate = candidateInfo(route?.local ?? null);
        remoteCandidate = candidateInfo(route?.remote ?? null);
      } catch (e) {
        console.warn('[WebRTC:Diagnostics] Failed to collect diagnostics stats:', e);
      }
    }

    const payload: RtcDiagnosticsReportPayload = {
      targetSessionId: peerSessionId,
      reason: `ice_restart=${session?.iceRestartAttempts ?? 0}, hard_reconnect=${session?.reconnectAttempts ?? 0}`,
      iceGatheringState,
      signalingState,
      iceRestartAttempts: session?.iceRestartAttempts ?? 0,
      hardReconnectAttempts: session?.reconnectAttempts ?? 0,
      localCandidate,
      remoteCandidate,
    };

    signalClient.send(MessageType.RTC_DIAGNOSTICS_REPORT, payload);
  }
}
