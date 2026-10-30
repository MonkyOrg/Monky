import { WebSocket } from 'ws';
import {
  MessageType,
  Permission,
  ProtocolErrorCode,
  botVoiceChannelSchema,
  getScreenShareQualities,
  isReceivingBotVoice,
  messageReferenceSchema,
  screenShareProfileKey,
  sfuCloseWebRtcTransportSchema,
  sfuConnectWebRtcTransportSchema,
  sfuConsumeSchema,
  sfuConsumerClosedSchema,
  sfuConsumerSetPausedSchema,
  sfuCreateWebRtcTransportSchema,
  sfuMediaAppDataSchema,
  sfuProduceSchema,
  sfuProducerClosedSchema,
  sfuProducerSetPausedSchema,
  type BotCapability,
  type ServerMessage,
  type SfuCloseWebRtcTransportPayload,
  type SfuConsumedPayload,
  type SfuCreateWebRtcTransportPayload,
  type SfuGetProducersPayload,
  type SfuGetRouterRtpCapabilitiesPayload,
  type SfuNewProducerPayload,
  type SfuProducedPayload,
  type SfuProducerClosedPayload,
  type SfuProducerSetPausedPayload,
  type SfuProducersListPayload,
  type SfuRouterRtpCapabilitiesPayload,
  type SfuWebRtcTransportCreatedPayload,
  type VoiceConnectionHealth,
  type VoiceParticipantState,
  type VoiceRosterParticipant,
  type VoiceStateChangedPayload,
} from '@monky/shared';
import type { SignalingService } from '../../../application/services/SignalingService';
import type { IServerRepository } from '../../../domain/repositories';
import { describeFailure } from '../../lifecycle/ServerResourceScope';
import { Logger } from '../../logger/Logger';
import { SfuProducerClosedError, SfuProducerLimitError, type SfuManager } from '../../sfu/SfuManager';
import { checkSfuPreflight, formatSfuPreflightForLog } from '../../sfu/SfuPreflight';
import type { ClientSession } from '../ClientSession';

/** What SFU signaling uses of the WebSocket server. */
export interface SfuSignalingHost {
  readonly signaling: SignalingService;
  readonly sfu: SfuManager;
  readonly serverRepo: IServerRepository;
  /** The server is shutting down. */
  readonly closing: boolean;
  sessions(): Iterable<ClientSession>;
  findSession(sessionId: string): ClientSession | undefined;
  isCurrentSession(session: ClientSession): boolean;
  isCurrentBotOperation(session: ClientSession, ...capabilities: BotCapability[]): boolean;
  requirePermission(session: ClientSession, permission: Permission, requestId?: string, channelId?: string): Promise<boolean>;
  requireChannelAccess(session: ClientSession, channelId: string | undefined, requestId?: string): Promise<boolean>;
  hasBotVoiceGrant(session: ClientSession, channelId: string): boolean;
  canReceiveProducer(session: ClientSession, channelId: string, producerId: string): boolean;
  voiceRoster(channelId: string, viewerUserId?: string): VoiceRosterParticipant[];
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcast(message: ServerMessage, ignoreWs?: WebSocket): void;
  broadcastToChannel(channelId: string, message: ServerMessage, ignoreWs?: WebSocket, canSend?: () => boolean): Promise<void>;
}

/**
 * Media through the server (#515): the SFU_* requests of humans and bots, the
 * microphone mute the server imposes, the health of each call and what goes
 * when a connection, a transport or the worker itself does (S-VOICE-12).
 * Membership stays with the voice sessions; this only carries their media.
 */
export class SfuSignalingHandler {
  constructor(private readonly host: SfuSignalingHost) {}

  /** One SFU request, on a server that has to be in SFU mode for it. */
  public async handle(session: ClientSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    if (!(await this.requireSfuMode(session, requestId))) return;
    switch (type) {
      case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
        await this.handleSfuGetRouterRtpCapabilities(session, payload as SfuGetRouterRtpCapabilitiesPayload, requestId);
        break;
      case MessageType.SFU_CREATE_WEBRTC_TRANSPORT:
        await this.handleSfuCreateWebRtcTransport(session, payload as SfuCreateWebRtcTransportPayload, requestId);
        break;
      case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
        await this.handleSfuConnectWebRtcTransport(session, payload, requestId);
        break;
      case MessageType.SFU_PRODUCE:
        await this.handleSfuProduce(session, payload, requestId);
        break;
      case MessageType.SFU_CONSUME:
        await this.handleSfuConsume(session, payload, requestId);
        break;
      case MessageType.SFU_PRODUCER_CLOSED:
        this.handleSfuProducerClosed(session, payload, requestId);
        break;
      case MessageType.SFU_PRODUCER_SET_PAUSED:
        await this.handleSfuProducerSetPaused(session, payload, requestId);
        break;
      case MessageType.SFU_CLOSE_WEBRTC_TRANSPORT:
        this.handleSfuCloseWebRtcTransport(session, payload, requestId);
        break;
      case MessageType.SFU_GET_PRODUCERS:
        await this.handleSfuGetProducers(session, payload as SfuGetProducersPayload, requestId);
        break;
      case MessageType.SFU_CONSUMER_SET_PAUSED:
        await this.handleSfuConsumerSetPaused(session, payload, requestId);
        break;
      case MessageType.SFU_CONSUMER_CLOSED:
        this.handleSfuConsumerClosed(session, payload, requestId);
        break;
    }
  }

  /** The SFU saw a call transport change state: the room learns the call's new health. */
  public transportHealthChanged(sessionId: string, channelId: string, transportHealth: VoiceConnectionHealth): void {
    const connectionHealth = this.sfuCallHealth(sessionId, channelId, transportHealth);
    const current = this.host.signaling.getVoiceState(sessionId);
    if (!current || current.channelId !== channelId || current.connectionHealth === connectionHealth) return;
    const voiceState = this.host.signaling.updateVoiceState(sessionId, { connectionHealth });
    if (voiceState) {
      void this.host.broadcastToChannel(channelId, {
        type: MessageType.VOICE_STATE_CHANGED,
        payload: { voiceState } satisfies VoiceStateChangedPayload,
      }, undefined, () => this.host.signaling.getVoiceState(sessionId) === voiceState);
    }
  }

  public async initSfuIfConfigured(): Promise<void> {
    try {
      const server = await this.host.serverRepo.getServer();
      if (this.host.closing) return;
      if (server?.voiceMode === 'sfu') {
        const ok = await this.host.sfu.init();
        if (this.host.closing) return;
        if (!ok) {
          // Silently downgrading a mode the operator deliberately configured
          // is an error, not a warning — the preflight names the part of the
          // environment that is missing instead of only echoing the throw.
          const preflight = checkSfuPreflight();
          const diagnosis = preflight.ok ? '' : ` ${formatSfuPreflightForLog(preflight)}`;
          Logger.error(
            'SFU',
            `voiceMode is "sfu" but the SFU worker failed to start: ${this.host.sfu.getLastError()}.${diagnosis} ` +
              'Clients will keep retrying until it comes up.'
          );
        }
      }
    } catch (error) {
      Logger.warn('SFU', `Error checking SFU configuration on startup: ${describeFailure(error)}`);
    }
  }

  /**
   * Refuses SFU traffic on a server that is not in SFU mode (#515).
   *
   * Sits at dispatch because two of these handlers are self-sufficient:
   * `SFU_GET_ROUTER_RTP_CAPABILITIES` and `SFU_CREATE_WEBRTC_TRANSPORT` both
   * boot the mediasoup worker on demand, and the latter goes further and
   * allocates a UDP/TCP port pair per call. Without this any authenticated
   * member could spawn a worker — and burn ports — on a server the operator
   * deliberately left in P2P. Guarding only the handshake entry point would
   * miss the shorter and more expensive path.
   */
  private async requireSfuMode(session: ClientSession, requestId?: string): Promise<boolean> {
    const server = await this.host.serverRepo.getServer();
    if (server?.voiceMode === 'sfu') return true;

    // Not SFU_UNAVAILABLE: that code means the host cannot carry SFU media and
    // the client surfaces it to the admin with the reason attached. This is an
    // ordinary request arriving for the wrong mode — a client still closing
    // producers while the server is switched to P2P hits it on the normal
    // path, and it must not raise an alarm at everyone in the call.
    this.host.sendError(
      session.ws,
      ProtocolErrorCode.BAD_REQUEST,
      'Este servidor não está no modo SFU.',
      requestId
    );
    return false;
  }

  public closeBotVoiceReception(session: ClientSession, channelId: string): void {
    if (!session.sessionId) return;
    session.botVoiceReceiveEpoch = (session.botVoiceReceiveEpoch ?? 0) + 1;
    this.host.sfu.closeTransportsFor(session.sessionId, channelId, 'recv');
    for (const [id, transport] of session.botVoiceTransports ?? []) {
      if (transport.direction === 'recv' && transport.channelId === channelId) session.botVoiceTransports?.delete(id);
    }
  }

  private isCurrentBotVoiceReceiver(session: ClientSession, channelId: string): boolean {
    const state = session.sessionId ? this.host.signaling.getVoiceState(session.sessionId) : undefined;
    return this.host.isCurrentBotOperation(session, 'receive_voice') &&
      state?.channelId === channelId && isReceivingBotVoice(state);
  }

  private isBotMicrophoneSource(sessionId: string, channelId: string): boolean {
    const source = this.host.findSession(sessionId);
    return !!source && !source.isBot && this.host.isCurrentSession(source) &&
      this.host.signaling.getVoiceState(sessionId)?.channelId === channelId;
  }

  public syncSfuMicrophoneMute(sessionId: string): Promise<void> {
    const state = this.host.signaling.getVoiceState(sessionId);
    return this.host.sfu.setMicrophonesMuted(sessionId,
      !state || state.isMuted || state.isDeafened || !!state.serverMuted || !!state.serverDeafened || !!state.permissionMuted);
  }

  /**
   * Health of a member's SFU call as the room sees it. A listen-only member
   * (Speak denied, which everyone in the AFK room is) with nobody to hear never
   * negotiates its transports, so they would read `connecting` forever. With no
   * media to carry in either direction, the call is `idle`: admitted, untested.
   */
  public sfuCallHealth(
    sessionId: string, channelId: string, health = this.host.sfu.getConnectionHealth(sessionId, channelId),
  ): ReturnType<SfuManager['getConnectionHealth']> {
    if (health !== 'connecting' || !this.host.signaling.getVoiceState(sessionId)?.permissionMuted) return health;
    return this.host.sfu.isCallIdle(sessionId, channelId) ? 'idle' : health;
  }

  public closePermissionMutedAudio(voiceState: VoiceParticipantState): void {
    for (const producer of this.host.sfu.getProducersInChannel(voiceState.channelId)) {
      if (producer.producerSessionId !== voiceState.sessionId || producer.appData.mediaType !== 'screen_audio') continue;
      this.host.sfu.closeProducer(producer.producerId);
      this.notifyProducersClosed(voiceState.channelId, [producer.producerId]);
    }
  }

  private async authorizeBotVoiceMedia(
    session: ClientSession, payload: unknown, requestId?: string, transportId?: string, direction?: 'send' | 'recv',
  ): Promise<boolean> {
    const parsed = botVoiceChannelSchema.safeParse(payload);
    if (!parsed.success || !session.sessionId ||
        this.host.signaling.getVoiceState(session.sessionId)?.channelId !== parsed.data.channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Join the voice channel before creating media.', requestId);
      return false;
    }
    if (!(await this.host.requirePermission(session, Permission.SPEAK, requestId,
        this.host.hasBotVoiceGrant(session, parsed.data.channelId) ? undefined : parsed.data.channelId)) ||
        (!this.host.hasBotVoiceGrant(session, parsed.data.channelId) &&
          !(await this.host.requireChannelAccess(session, parsed.data.channelId, requestId)))) return false;
    const transport = transportId === undefined ? undefined : session.botVoiceTransports?.get(transportId);
    const mediaDirection = direction ?? transport?.direction;
    const allowed = mediaDirection === 'recv' ? this.isCurrentBotVoiceReceiver(session, parsed.data.channelId)
      : mediaDirection === 'send' ? this.host.isCurrentBotOperation(session, 'publish_voice')
      : this.isCurrentBotVoiceReceiver(session, parsed.data.channelId) || this.host.isCurrentBotOperation(session, 'publish_voice');
    if (!allowed) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bot microphone capability is unavailable or reception is deafened.', requestId);
      return false;
    }
    if (!this.host.isCurrentSession(session) ||
        this.host.signaling.getVoiceState(session.sessionId)?.channelId !== parsed.data.channelId) return false;
    if (transportId !== undefined && (transport?.channelId !== parsed.data.channelId ||
        (direction !== undefined && direction !== transport.direction))) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Transport does not belong to this bot voice connection.', requestId);
      return false;
    }
    return true;
  }

  private requireSfuVoiceSession(session: ClientSession, channelId: unknown, requestId?: string): boolean {
    if (!session.user || !session.sessionId) return false;
    if (!messageReferenceSchema.safeParse(channelId).success
      || this.host.signaling.getVoiceState(session.sessionId)?.channelId !== channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Entre neste canal de voz antes de solicitar mídia.', requestId);
      return false;
    }
    return true;
  }

  private async handleSfuGetRouterRtpCapabilities(
    session: ClientSession,
    payload: SfuGetRouterRtpCapabilitiesPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    if (session.isBot && !(await this.authorizeBotVoiceMedia(session, payload, requestId))) return;
    if (!this.requireSfuVoiceSession(session, payload?.channelId, requestId)) return;
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) requested router capabilities for channel ${payload.channelId}`);
      if (!this.host.sfu.isReady()) {
        await this.host.sfu.init();
      }
      const rtpCapabilities = await this.host.sfu.getRouterRtpCapabilities(payload.channelId);
      this.host.send(session.ws, {
        type: MessageType.SFU_ROUTER_RTP_CAPABILITIES,
        requestId,
        payload: {
          channelId: payload.channelId,
          rtpCapabilities,
        } satisfies SfuRouterRtpCapabilitiesPayload,
      });
    } catch (err: unknown) {
      console.error(`[SFU Server:WS] Error getting router capabilities for ${session.user.nickname}:`, err);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        err instanceof Error && err.message ? err.message : 'Erro ao obter capacidades do roteador SFU', requestId);
    }
  }

  private async handleSfuCreateWebRtcTransport(
    session: ClientSession,
    payload: SfuCreateWebRtcTransportPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuCreateWebRtcTransportSchema.safeParse(payload);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Direção ou finalidade de transporte inválida.', requestId);
      return;
    }
    const { channelId, direction, purpose, screenSessionId } = parsed.data;
    if (session.isBot && purpose !== 'call') {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Bot voice supports call transports only.', requestId);
      return;
    }
    if (session.isBot && !(await this.authorizeBotVoiceMedia(session, parsed.data, requestId, undefined, direction))) return;
    if (!this.requireSfuVoiceSession(session, channelId, requestId)) return;
    const receiveEpoch = session.isBot && direction === 'recv'
      ? (session.botVoiceReceiveEpoch = (session.botVoiceReceiveEpoch ?? 0) + 1) : undefined;
    try {
      if (!this.host.sfu.isReady()) {
        await this.host.sfu.init();
        if (!this.requireSfuVoiceSession(session, channelId, requestId)) return;
      }
      if (!this.host.isCurrentSession(session)) return;
      if (receiveEpoch !== undefined && receiveEpoch !== session.botVoiceReceiveEpoch) {
        this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Voice reception changed during transport preparation.', requestId);
        return;
      }
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) creating ${purpose}/${direction} transport for channel ${channelId}`);
      // A client asking for a transport it already has is rejoining after a
      // failure. Its previous one is never coming back, and nothing else would
      // ever close it, so it goes now — along with the producers other clients
      // would otherwise keep trying to consume.
      const { closedProducerIds } = this.host.sfu.closeTransportsFor(
        session.sessionId,
        channelId,
        direction,
        purpose,
        screenSessionId
      );
      this.notifyProducersClosed(channelId, closedProducerIds);
      // Whatever this session still holds in another channel is over too. The
      // join it belonged to may only have reached this point *after* the
      // VOICE_JOIN for the new channel was handled — clicking straight from one
      // channel to another starts a join for the old one that is only abandoned
      // once its first round-trip returns — and joins are serialised, so a
      // transport for another channel arriving here is always the older one.
      const abandoned = this.host.sfu.closeSessionExcept(
        session.sessionId,
        channelId
      );
      for (const closed of abandoned.closedProducerIds) this.notifyProducersClosed(closed.channelId, [closed.producerId]);
      const transportOptions = await this.host.sfu.createWebRtcTransport(
        session.sessionId,
        channelId,
        direction,
        session.requestHost,
        purpose,
        screenSessionId
      );
      if (!this.host.isCurrentSession(session) ||
          this.host.signaling.getVoiceState(session.sessionId)?.channelId !== channelId ||
          (receiveEpoch !== undefined && receiveEpoch !== session.botVoiceReceiveEpoch) ||
          (session.isBot && direction === 'recv' && !this.isCurrentBotVoiceReceiver(session, channelId))) {
        // A reconnected device keeps its logical session ID. Reap only this
        // late allocation, never the replacement connection's media.
        this.host.sfu.discardPendingTransport(transportOptions.id);
        if (this.host.isCurrentSession(session)) {
          this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Voice reception changed during transport allocation.', requestId);
        }
        return;
      }
      if (session.isBot) {
        session.botVoiceTransports ??= new Map();
        for (const [id, transport] of session.botVoiceTransports) {
          if (transport.direction === direction) session.botVoiceTransports.delete(id);
        }
        session.botVoiceTransports.set(transportOptions.id, { channelId, direction });
      }
      this.host.send(session.ws, {
        type: MessageType.SFU_WEBRTC_TRANSPORT_CREATED,
        requestId,
        payload: {
          channelId,
          direction,
          purpose,
          ...(screenSessionId ? { screenSessionId } : {}),
          transportOptions,
        } satisfies SfuWebRtcTransportCreatedPayload,
      });
    } catch (err: unknown) {
      console.error(`[SFU Server:WS] Error creating transport for ${session.user.nickname}:`, err);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        err instanceof Error && err.message ? err.message : 'Erro ao criar transporte SFU', requestId);
    }
  }

  private async handleSfuConnectWebRtcTransport(
    session: ClientSession,
    value: unknown,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuConnectWebRtcTransportSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de conexão de transporte inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    if (session.isBot && !(await this.authorizeBotVoiceMedia(session, payload, requestId, payload.transportId))) return;
    if (!this.requireSfuVoiceSession(session, payload.channelId, requestId)) return;
    if (!this.host.sfu.ownsTransport(session.sessionId, payload.channelId, payload.transportId)) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Transporte não pertence a esta sessão.', requestId);
      return;
    }
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) connecting transport ${payload.transportId}`);
      await this.host.sfu.connectWebRtcTransport(payload.transportId, payload.dtlsParameters);
      this.host.send(session.ws, {
        type: MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED,
        requestId,
        payload: {
          channelId: payload.channelId,
          transportId: payload.transportId,
        },
      });
    } catch (err: unknown) {
      console.error(`[SFU Server:WS] Error connecting transport ${payload.transportId} for ${session.user.nickname}:`, err);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        err instanceof Error && err.message ? err.message : 'Erro ao conectar transporte SFU', requestId);
    }
  }

  private async handleSfuProduce(
    session: ClientSession,
    value: unknown,
    requestId?: string
  ): Promise<void> {
    const sessionId = session.sessionId;
    if (!session.user || !sessionId) return;
    const parsed = sfuProduceSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de produção de mídia inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    if (session.isBot && !(await this.authorizeBotVoiceMedia(session, payload, requestId, payload.transportId, 'send'))) return;
    if (!this.requireSfuVoiceSession(session, payload.channelId, requestId)) return;
    const appData = sfuMediaAppDataSchema.safeParse(payload.appData);
    const voiceRestrictions = session.isBot ? this.host.signaling.getVoiceRestrictions(session.user.id) : undefined;
    if (session.isBot && (payload.kind !== 'audio' || !appData.success || appData.data.mediaType !== 'mic' ||
        voiceRestrictions?.serverMuted || voiceRestrictions?.serverDeafened)) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bot microphone is not permitted.', requestId);
      return;
    }
    if (!appData.success || payload.kind !== (
      appData.data.mediaType === 'mic' || appData.data.mediaType === 'screen_audio' ? 'audio' : 'video')) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Tipo ou origem da mídia inválidos.', requestId);
      return;
    }
    const currentVoiceState = this.host.signaling.getVoiceState(sessionId);
    if (!session.isBot && currentVoiceState?.permissionMuted &&
        (appData.data.mediaType === 'mic' || appData.data.mediaType === 'screen_audio')) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Sem permissão para falar neste canal.', requestId);
      return;
    }
    const nativeScreen = 'nativeScreen' in appData.data ? appData.data.nativeScreen : undefined;
    const shareId = 'shareId' in appData.data ? appData.data.shareId : undefined;
    const sourceIsCurrent = () => {
      if (!nativeScreen) return !this.host.signaling.getVoiceState(sessionId)?.nativeScreenShares
        ?.some(source => source.shareId === shareId);
      const source = this.host.signaling.getVoiceState(sessionId)
        ?.nativeScreenShares?.find(value => value.shareId === shareId && value.instanceId === nativeScreen.sourceInstanceId);
      return !!source && (payload.kind !== 'audio' || source.audio)
        && getScreenShareQualities(source.video, source.codec).some(value =>
          screenShareProfileKey(value.profile) === screenShareProfileKey(nativeScreen.video));
    };
    if (!sourceIsCurrent()) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'O perfil não pertence à transmissão anunciada.', requestId);
      return;
    }
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) producing ${payload.kind} (${appData.data.mediaType}) in channel ${payload.channelId}`);
      const { id } = await this.host.sfu.produce(
        sessionId,
        payload.channelId,
        payload.transportId,
        payload.kind,
        payload.rtpParameters,
        appData.data,
        appData.data.mediaType === 'mic'
      );
      if (!this.host.isCurrentSession(session) ||
          this.host.signaling.getVoiceState(sessionId)?.channelId !== payload.channelId || !sourceIsCurrent()) {
        this.host.sfu.closeProducer(id);
        return;
      }
      if (appData.data.mediaType === 'mic') await this.syncSfuMicrophoneMute(sessionId);

      this.host.send(session.ws, {
        type: MessageType.SFU_PRODUCED,
        requestId,
        payload: {
          channelId: payload.channelId,
          id,
        } satisfies SfuProducedPayload,
      });

      // Notify other participants in the channel about the new producer
      const newProducerPayload: SfuNewProducerPayload = {
        channelId: payload.channelId,
        producerId: id,
        producerSessionId: sessionId,
        kind: payload.kind,
        appData: appData.data,
      };

      const participants = this.host.signaling.getParticipantsInChannel(payload.channelId);
      console.log(`[SFU Server:WS] Broadcasting SFU_NEW_PRODUCER to ${participants.length - 1} other participants in channel ${payload.channelId}`);
      for (const p of participants) {
        if (p.sessionId === session.sessionId) continue;
        const recipient = this.host.findSession(p.sessionId);
        if (recipient?.isBot && (!this.isCurrentBotVoiceReceiver(recipient, payload.channelId) ||
            session.isBot || payload.kind !== 'audio' || appData.data.mediaType !== 'mic')) continue;
        const sock = recipient?.ws;
        if (sock && sock.readyState === WebSocket.OPEN) {
          this.host.send(sock, {
            type: MessageType.SFU_NEW_PRODUCER,
            payload: newProducerPayload,
          });
        }
      }
    } catch (err: unknown) {
      if (err instanceof SfuProducerLimitError) {
        this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST,
          'Esta mídia já está sendo transmitida. Encerre a anterior antes de iniciar outra.', requestId);
        return;
      }
      console.error(`[SFU Server:WS] Error producing for ${session.user.nickname}:`, err);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        err instanceof Error && err.message ? err.message : 'Erro ao produzir mídia no SFU', requestId);
    }
  }

  private async handleSfuConsume(
    session: ClientSession,
    value: unknown,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuConsumeSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de consumo de mídia inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    if (session.isBot) {
      if (!(await this.authorizeBotVoiceMedia(session, payload, requestId, payload.transportId, 'recv'))) return;
      const producer = this.host.sfu.getProducer(payload.producerId);
      if (!producer || producer.channelId !== payload.channelId || producer.kind !== 'audio' ||
          producer.appData.mediaType !== 'mic' || !this.isBotMicrophoneSource(producer.sessionId, payload.channelId)) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots may only receive human microphones in their authorized room.', requestId);
        return;
      }
    }
    if (!this.requireSfuVoiceSession(session, payload.channelId, requestId)) return;
    if (!this.host.canReceiveProducer(session, payload.channelId, payload.producerId)) {
      const advertised = session.knownProducerIds?.has(payload.producerId)
        || session.retiredProducerIds?.has(payload.producerId);
      const exists = this.host.sfu.getProducer(payload.producerId)?.channelId === payload.channelId;
      if (advertised && !exists) {
        this.host.send(session.ws, {
          type: MessageType.SFU_PRODUCER_CLOSED, requestId,
          payload: { channelId: payload.channelId, producerId: payload.producerId } satisfies SfuProducerClosedPayload,
        });
      } else this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Transmissão não está disponível.', requestId);
      return;
    }
    try {
      console.log(`[SFU Server:WS] User ${session.user.nickname} (${session.sessionId}) consuming producer ${payload.producerId}`);
      const consumed = await this.host.sfu.consume(
        session.sessionId,
        payload.channelId,
        payload.transportId,
        payload.producerId,
        payload.rtpCapabilities
      );
      if (!this.host.isCurrentSession(session) ||
          this.host.signaling.getVoiceState(session.sessionId)?.channelId !== payload.channelId ||
          !this.host.canReceiveProducer(session, payload.channelId, payload.producerId) ||
          (session.isBot && (!this.isCurrentBotVoiceReceiver(session, payload.channelId) ||
            session.botVoiceTransports?.get(payload.transportId)?.direction !== 'recv' ||
            !this.isBotMicrophoneSource(consumed.producerSessionId, payload.channelId)))) {
        this.host.sfu.discardPendingConsumer(consumed.id);
        if (this.host.isCurrentSession(session)) {
          if (session.isBot && !this.isBotMicrophoneSource(consumed.producerSessionId, payload.channelId)) {
            this.host.send(session.ws, {
              type: MessageType.SFU_PRODUCER_CLOSED, requestId,
              payload: { channelId: payload.channelId, producerId: payload.producerId } satisfies SfuProducerClosedPayload,
            });
          } else this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Voice connection changed during microphone subscription.', requestId);
        }
        return;
      }

      this.host.send(session.ws, {
        type: MessageType.SFU_CONSUMED,
        requestId,
        payload: {
          channelId: payload.channelId,
          ...consumed,
        } satisfies SfuConsumedPayload,
      });
    } catch (err) {
      if (err instanceof SfuProducerClosedError) {
        // The producer closed while this request was on its way: it ends with
        // the same terminal event the room got, not a link error.
        this.host.send(session.ws, {
          type: MessageType.SFU_PRODUCER_CLOSED,
          requestId,
          payload: { channelId: payload.channelId, producerId: err.producerId } satisfies SfuProducerClosedPayload,
        });
        return;
      }
      console.error(`[SFU Server:WS] Error consuming producer ${payload.producerId} for ${session.user.nickname}:`, err);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : 'Erro ao consumir mídia no SFU', requestId);
    }
  }

  private handleSfuProducerClosed(
    session: ClientSession,
    value: unknown,
    requestId?: string,
  ): void {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuProducerClosedSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de encerramento de mídia inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    let closed: { closedProducerIds: string[] } | null;
    try {
      closed = this.host.sfu.closeProducerForSession(session.sessionId, payload.channelId, payload.producerId);
    } catch (error) {
      console.error('[SFU Server:WS] Producer close failed:', error);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, 'Não foi possível encerrar o produtor de mídia.', requestId);
      return;
    }
    if (!closed) {
      if (requestId) this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Produtor não pertence a esta sessão.', requestId);
      return;
    }
    if (requestId) this.host.send(session.ws, { type: MessageType.SFU_PRODUCER_CLOSED, requestId, payload });
    for (const producerId of closed.closedProducerIds) {
      console.log(`[SFU Server:WS] User ${session.user.nickname} closed producer ${producerId}`);
    }
    this.notifyProducersClosed(payload.channelId, closed.closedProducerIds);
  }

  /**
   * Tells whoever was told of these producers that they are gone. The
   * projection in `send` keeps it to them (projectScreenMessage), so nothing
   * outside the call learns of its media and the room's audience never has to
   * be resolved: the notice cannot wait on permissions, nor be dropped by an
   * access change meanwhile, while someone still consumes a producer that left.
   */
  public notifyProducersClosed(channelId: string, producerIds: Iterable<string>): void {
    for (const producerId of producerIds) {
      this.host.broadcast({
        type: MessageType.SFU_PRODUCER_CLOSED,
        payload: { channelId, producerId } satisfies SfuProducerClosedPayload,
      });
    }
  }

  private handleSfuCloseWebRtcTransport(session: ClientSession, value: unknown, requestId?: string): void {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuCloseWebRtcTransportSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de encerramento de transporte inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    let closed: { closedProducerIds: string[] } | null;
    try {
      closed = this.host.sfu.closeTransport(session.sessionId, payload.channelId, payload.transportId, payload.purpose);
    } catch (error) {
      console.error('[SFU Server:WS] Screen transport close failed:', error);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, 'Não foi possível encerrar o transporte de tela.', requestId);
      return;
    }
    if (!closed) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Transporte de tela não pertence a esta sessão.', requestId);
      return;
    }
    this.host.send(session.ws, {
      type: MessageType.SFU_WEBRTC_TRANSPORT_CLOSED, requestId,
      payload: payload satisfies SfuCloseWebRtcTransportPayload,
    });
    this.notifyProducersClosed(payload.channelId, closed.closedProducerIds);
  }

  private async handleSfuProducerSetPaused(session: ClientSession, value: unknown, requestId?: string): Promise<void> {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuProducerSetPausedSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Controle de produção de mídia inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    if (!this.requireSfuVoiceSession(session, payload.channelId, requestId)) return;
    if (!this.host.sfu.ownsProducer(session.sessionId, payload.channelId, payload.producerId, payload.purpose)) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Produtor de tela não pertence a esta sessão.', requestId);
      return;
    }
    try {
      await this.host.sfu.setProducerPaused(session.sessionId, payload.channelId, payload.producerId, payload.paused);
      if (requestId) this.host.send(session.ws, {
        type: MessageType.SFU_PRODUCER_SET_PAUSED, requestId,
        payload: payload satisfies SfuProducerSetPausedPayload,
      });
    } catch (error) {
      console.error('[SFU Server:WS] Producer pause/resume failed:', error);
      this.host.sendError(session.ws, error instanceof SfuProducerClosedError
        ? ProtocolErrorCode.BAD_REQUEST : ProtocolErrorCode.INTERNAL_ERROR,
      'Não foi possível alterar o produtor de tela.', requestId);
    }
  }

  private async handleSfuGetProducers(
    session: ClientSession,
    payload: SfuGetProducersPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    if (session.isBot && !(await this.authorizeBotVoiceMedia(session, payload, requestId, undefined, 'recv'))) return;
    if (!this.requireSfuVoiceSession(session, payload?.channelId, requestId)) return;
    try {
      const channelProducers = this.host.sfu.getProducersInChannel(payload.channelId).filter((producer) =>
        !session.isBot || (producer.kind === 'audio' && producer.appData.mediaType === 'mic' &&
          this.isBotMicrophoneSource(producer.producerSessionId, payload.channelId)));
      console.log(`[SFU Server:WS] User ${session.user.nickname} requested producers list for channel ${payload.channelId} (found ${channelProducers.length})`);
      const producers: SfuNewProducerPayload[] = channelProducers.map((p) => ({
        channelId: payload.channelId,
        producerId: p.producerId,
        producerSessionId: p.producerSessionId,
        kind: p.kind,
        appData: p.appData,
      }));

      this.host.send(session.ws, {
        type: MessageType.SFU_PRODUCERS_LIST,
        requestId,
        payload: {
          channelId: payload.channelId,
          producers,
          participants: this.host.voiceRoster(payload.channelId, session.user.id),
        } satisfies SfuProducersListPayload,
      });
    } catch (err: unknown) {
      console.error(`[SFU Server:WS] Error listing producers for ${session.user.nickname}:`, err);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR,
        err instanceof Error && err.message ? err.message : 'Erro ao listar produtores SFU', requestId);
    }
  }

  private async handleSfuConsumerSetPaused(
    session: ClientSession,
    value: unknown,
    requestId?: string,
  ): Promise<void> {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuConsumerSetPausedSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Controle de consumo de mídia inválido.', requestId);
      return;
    }
    const payload = parsed.data;
    if (!this.requireSfuVoiceSession(session, payload.channelId, requestId)) return;
    if (session.isBot) {
      if (!(await this.authorizeBotVoiceMedia(session, payload, requestId, undefined, 'recv'))) return;
      if (!this.host.sfu.ownsConsumer(session.sessionId, payload.channelId, payload.consumerId)) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Consumer does not belong to this bot.', requestId);
        return;
      }
    }
    let updated: boolean;
    const producerId = this.host.sfu.getConsumerProducerId(session.sessionId, payload.channelId, payload.consumerId);
    if (producerId && !this.host.canReceiveProducer(session, payload.channelId, producerId)) {
      this.host.sfu.closeConsumer(session.sessionId, payload.channelId, payload.consumerId);
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Transmissão não está disponível.', requestId);
      return;
    }
    try {
      updated = await this.host.sfu.setConsumerPaused(session.sessionId, payload.channelId, payload.consumerId, payload.paused);
      if (producerId && !this.host.canReceiveProducer(session, payload.channelId, producerId)) {
        this.host.sfu.closeConsumer(session.sessionId, payload.channelId, payload.consumerId);
        updated = false;
      }
    } catch (error) {
      console.error('[SFU Server:WS] Consumer pause/resume failed:', error);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, 'Não foi possível alterar o consumo de mídia.', requestId);
      return;
    }
    if (requestId) {
      if (!updated) this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Consumer não pertence a esta sessão ou foi encerrado.', requestId);
      else this.host.send(session.ws, { type: MessageType.SFU_CONSUMER_SET_PAUSED, requestId, payload });
    }
  }

  private handleSfuConsumerClosed(session: ClientSession, value: unknown, requestId?: string): void {
    if (!session.user || !session.sessionId) return;
    const parsed = sfuConsumerClosedSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Pedido de encerramento de mídia inválido.', requestId);
      return;
    }
    let closed: boolean;
    try {
      closed = this.host.sfu.closeConsumer(session.sessionId, parsed.data.channelId, parsed.data.consumerId);
    } catch (error) {
      console.error('[SFU Server:WS] Consumer close failed:', error);
      this.host.sendError(session.ws, ProtocolErrorCode.INTERNAL_ERROR, 'Não foi possível encerrar o consumo de mídia.', requestId);
      return;
    }
    if (requestId) {
      if (!closed) this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Consumer não pertence a esta sessão ou foi encerrado.', requestId);
      else this.host.send(session.ws, { type: MessageType.SFU_CONSUMER_CLOSED, requestId, payload: parsed.data });
    }
  }

  /**
   * Reaps everything one connection held in the SFU and tells the channel that
   * those producers are gone. Without this, whoever joins next is handed a
   * producer with nobody behind it and sits there consuming a ghost (#527).
   */
  public closeSfuSession(sessionId: string, channelId: string): void {
    const session = this.host.findSession(sessionId);
    if (session) {
      session.botVoiceJoinAttempt = undefined;
      session.botVoiceGrant = undefined;
      session.botVoiceTransports?.clear();
      if (session.isBot) session.botVoiceReceiveEpoch = (session.botVoiceReceiveEpoch ?? 0) + 1;
    }
    if (!this.host.sfu) return;
    this.notifyProducersClosed(channelId, this.host.sfu.closeSession(sessionId).closedProducerIds);
  }

  /**
   * The SFU worker died and took every transport and producer with it. Each
   * client is told the producers it knew are gone and every SFU call is marked
   * failed, which is what makes clients rebuild their transports — against a
   * worker started again on their first request. Membership stays: nobody
   * leaves the channel because the media server restarted.
   */
  public sfuWorkerLost(): void {
    if (this.host.closing) return;
    for (const session of this.host.sessions()) {
      session.botVoiceTransports?.clear();
      const channelId = session.sessionId && this.host.signaling.getVoiceState(session.sessionId)?.channelId;
      if (!channelId) continue;
      for (const producerId of [...(session.knownProducerIds ?? [])]) {
        this.host.send(session.ws, {
          type: MessageType.SFU_PRODUCER_CLOSED,
          payload: { channelId, producerId } satisfies SfuProducerClosedPayload,
        });
      }
    }
    for (const voiceState of Object.values(this.host.signaling.getAllVoiceStates())) {
      // Only SFU calls carry a server-observed health; P2P ones have none to fail.
      if (voiceState.connectionHealth === undefined || voiceState.connectionHealth === 'failed') continue;
      const updated = this.host.signaling.updateVoiceState(voiceState.sessionId, { connectionHealth: 'failed' });
      if (!updated) continue;
      void this.host.broadcastToChannel(updated.channelId, {
        type: MessageType.VOICE_STATE_CHANGED,
        payload: { voiceState: updated } satisfies VoiceStateChangedPayload,
      }, undefined, () => this.host.signaling.getVoiceState(updated.sessionId) === updated)
        .catch((error: unknown) => Logger.error('SFU', 'Failed to publish the health of a call after losing the SFU worker.', error));
    }
  }
}
