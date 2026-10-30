import { WebSocket } from 'ws';
import {
  MessageType,
  ProtocolErrorCode,
  botVoiceSignalSchema,
  isBotVoiceSignalAllowed,
  isReceivingBotVoice,
  rtcDiagnosticsReportSchema,
  rtcSignalSchema,
  type BotCapability,
  type ServerMessage,
} from '@monky/shared';
import type { SignalingService } from '../../../application/services/SignalingService';
import { Logger } from '../../logger/Logger';
import type { ClientSession } from '../ClientSession';

/** What the P2P signal relay uses of the WebSocket server. */
export interface RtcSignalHost {
  readonly signaling: SignalingService;
  findSession(sessionId: string): ClientSession | undefined;
  isCurrentBotOperation(session: ClientSession, ...capabilities: BotCapability[]): boolean;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
}

/**
 * P2P calls go through the server only as signals between two participants of
 * the same room (S-VOICE-12): relayed once authorized, with bots held to the
 * microphone directions they were approved for, plus the reports a client
 * sends when a connection failed.
 */
export class RtcSignalRelay {
  constructor(private readonly host: RtcSignalHost) {}

  public handleRtcSignal(
    session: ClientSession,
    value: unknown,
    requestId?: string
  ): void {
    if (!session.user || !session.sessionId) return;
    const parsed = rtcSignalSchema.safeParse(
      value && typeof value === 'object' ? { ...value, fromSessionId: session.sessionId } : value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Sinal de mídia inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    if (session.isBot && !botVoiceSignalSchema.safeParse(payload).success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Invalid or oversized voice signal.', requestId);
      return;
    }

    const target = this.host.findSession(payload.targetSessionId);
    if (session.isBot || target?.isBot) {
      const bot = session.isBot ? session : target;
      const state = bot?.sessionId ? this.host.signaling.getVoiceState(bot.sessionId) : undefined;
      const publish = !!bot && this.host.isCurrentBotOperation(bot, 'publish_voice');
      const receive = !!bot && this.host.isCurrentBotOperation(bot, 'receive_voice') && isReceivingBotVoice(state);
      if (!bot || (session.isBot && target?.isBot) ||
          (!publish && !this.host.isCurrentBotOperation(bot, 'receive_voice')) ||
          !isBotVoiceSignalAllowed(payload, session.isBot === true, { publish, receive })) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED,
          'Bot voice signaling exceeds its authorized microphone directions.', requestId);
        return;
      }
    }

    if (!this.host.signaling.validateSignalRouting(payload)) {
      Logger.warn('WEBRTC', `Invalid signal routing attempt from ${session.sessionId} to ${payload.targetSessionId}`);
      return;
    }
    if (payload.signalType === 'screen-watch' && payload.watching
      && !this.host.signaling.getVoiceState(payload.targetSessionId)?.screenShareIds?.includes(payload.streamId)) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Transmissão não está disponível.', requestId);
      return;
    }
    if (payload.signalType === 'screen-watch' || payload.signalType === 'screen-video-meta' || payload.signalType === 'screen-audio-meta') {
      const publisherId = payload.signalType === 'screen-watch' ? payload.targetSessionId : session.sessionId;
      const viewerId = payload.signalType === 'screen-watch' ? session.sessionId : payload.targetSessionId;
      const publisher = this.host.signaling.getVoiceState(publisherId);
      // Legacy audio has its own MediaStream ID, separate from the advertised video shares.
      const canRoute = payload.signalType === 'screen-audio-meta'
        ? !publisher?.nativeScreenShares?.some(source => source.audience)
          && !!publisher?.screenShareIds?.some(shareId =>
            !publisher.nativeScreenShares?.some(source => source.shareId === shareId)
            && this.host.signaling.canWatchScreen(publisherId, viewerId, shareId))
        : this.host.signaling.canWatchScreen(publisherId, viewerId, payload.streamId);
      // Native sources use isolated, authorized subscriptions, never the legacy call peer.
      if (!payload.streamId || publisher?.nativeScreenShares?.some(source => source.shareId === payload.streamId)
        || !canRoute) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Transmissão não está disponível.', requestId);
        return;
      }
    }

    const targetSocket = target?.ws;
    if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
      this.host.signaling.trackScreenSignal(payload);
      this.host.send(targetSocket, {
        type: MessageType.RTC_SIGNAL,
        requestId,
        payload,
      });
    }
  }

  public handleRtcDiagnosticsReport(session: ClientSession, value: unknown): void {
    if (!session.user || !session.sessionId) return;
    // A report only ever becomes one log line, so anything that would not be a
    // short printable one is dropped unanswered, like an excess of reports.
    const parsed = rtcDiagnosticsReportSchema.safeParse(value);
    if (!parsed.success) return;
    const payload = parsed.data;

    const targetSession = this.host.findSession(payload.targetSessionId);
    const fromName = session.user.nickname;
    const toName = targetSession?.user?.nickname ?? payload.targetSessionId;

    const fmtCandidate = (c: typeof payload.localCandidate): string => {
      if (!c) return 'none';
      const addr = c.address ? `${c.address}:${c.port ?? '?'}` : 'unknown';
      return `${c.type} ${addr} (${c.protocol ?? '?'})`;
    };

    // Infer probable cause from candidate types
    let probableCause = 'unknown';
    if (!payload.remoteCandidate && !payload.localCandidate) {
      probableCause = 'signaling_failure_or_firewall';
    } else if (!payload.remoteCandidate) {
      probableCause = 'remote_unreachable (firewall or peer disconnected)';
    } else if (payload.localCandidate?.type === 'srflx' && payload.remoteCandidate?.type === 'srflx') {
      probableCause = 'symmetric_nat_or_cgnat (no TURN relay configured)';
    } else if (payload.localCandidate?.type === 'host' && payload.remoteCandidate?.type === 'host') {
      probableCause = 'different_networks_no_stun_success';
    } else {
      probableCause = 'nat_traversal_failed';
    }

    Logger.warn(
      'WEBRTC',
      `P2P connection failed: ${fromName} → ${toName} | ` +
      `local=${fmtCandidate(payload.localCandidate)} | ` +
      `remote=${fmtCandidate(payload.remoteCandidate)} | ` +
      `ICE gathering=${payload.iceGatheringState}, signaling=${payload.signalingState} | ` +
      `attempts: ICE restart=${payload.iceRestartAttempts}, hard reconnect=${payload.hardReconnectAttempts} | ` +
      `probable cause: ${probableCause}`
    );
  }
}
