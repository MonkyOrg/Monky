import { WebSocket } from 'ws';
import {
  MessageType,
  ProtocolErrorCode,
  SCREEN_SHARE_LIMITS,
  nativeScreenSignalSchema,
  screenViewersRequestSchema,
  sfuMediaAppDataSchema,
  type AuthSuccessPayload,
  type NativeScreenSignalPayload,
  type ServerMessage,
  type ScreenViewersResult,
  type SfuConsumedPayload,
  type SfuNewProducerPayload,
  type SfuProducedPayload,
  type SfuProducerClosedPayload,
  type SfuProducersListPayload,
  type VoiceParticipantState,
  type VoiceRosterParticipant,
  type VoiceStateChangedPayload,
  type VoiceUserJoinedPayload,
} from '@monky/shared';
import type { PermissionService } from '../../../application/services/PermissionService';
import type { RoleService } from '../../../application/services/RoleService';
import type { SignalingService } from '../../../application/services/SignalingService';
import { Logger } from '../../logger/Logger';
import type { SfuManager } from '../../sfu/SfuManager';
import type { ClientSession } from '../ClientSession';

const MAX_RETIRED_SFU_PRODUCERS = 256;

/**
 * Whether an update touched the fields that decide who may receive a
 * participant's screens. Anything in doubt counts as a change: a missed one
 * would leave a revoked viewer watching.
 */
export function screenAccessChanged(before: VoiceParticipantState | undefined, after: VoiceParticipantState): boolean {
  return !before || before.isScreenSharing !== after.isScreenSharing
    || before.isSharingScreenAudio !== after.isSharingScreenAudio
    || JSON.stringify(before.screenShareIds ?? []) !== JSON.stringify(after.screenShareIds ?? [])
    || JSON.stringify(before.nativeScreenShares ?? []) !== JSON.stringify(after.nativeScreenShares ?? []);
}

/** What the screen rules use of the WebSocket server. */
export interface ScreenAccessHost {
  readonly signaling: SignalingService;
  readonly sfu: SfuManager;
  readonly permissions: PermissionService;
  readonly roles: RoleService;
  /** The server is shutting down. */
  readonly closing: boolean;
  sessions(): Iterable<ClientSession>;
  findSession(sessionId: string): ClientSession | undefined;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcastToChannel(channelId: string, message: ServerMessage, ignoreWs?: WebSocket, canSend?: () => boolean): Promise<void>;
}

/**
 * Who may receive which screen, and what each connection is told of them
 * (S-VOICE-12). The three screen transports — legacy P2P, native and SFU —
 * keep subscriptions of their own, but all go through this one policy, built
 * on SignalingService's canSeeScreenSource and canWatchScreen.
 */
export class ScreenAccessCoordinator {
  /** Role-gated screen visibility is republished one pass at a time. */
  private screenRolesRefresh: Promise<void> = Promise.resolve();
  /** The screen-role revision whose visibility every participant was last sent. */
  private publishedScreenRoles?: number;

  constructor(private readonly host: ScreenAccessHost) {}

  public canReceiveProducer(session: ClientSession, channelId: string, producerId: string): boolean {
    const producer = this.host.sfu.getProducer(producerId);
    if (!producer || producer.channelId !== channelId || !session.sessionId) return false;
    const appData = producer.appData;
    if (appData.mediaType !== 'screen_video' && appData.mediaType !== 'screen_audio') return true;
    if (session.isBot) return false;
    const publisher = this.host.signaling.getVoiceState(producer.sessionId);
    const parsed = sfuMediaAppDataSchema.safeParse(appData);
    if (!publisher || !parsed.success || !('shareId' in parsed.data)) return false;
    const native = 'nativeScreen' in parsed.data ? parsed.data.nativeScreen : undefined;
    const shareId = parsed.data.shareId;
    const source = publisher.nativeScreenShares?.find(value => value.shareId === shareId);
    if (native) return this.host.signaling.canWatchScreen(
      publisher.sessionId, session.sessionId, parsed.data.shareId, native.sourceInstanceId,
    ) && (appData.mediaType !== 'screen_audio' || source?.audio === true);
    // A native source can never be fetched through the unrestricted legacy call transport.
    if (source || (appData.mediaType === 'screen_audio' && publisher.nativeScreenShares?.some(value => value.audience))) return false;
    return publisher.channelId === this.host.signaling.getVoiceState(session.sessionId)?.channelId;
  }

  public reconcileScreenAccess(): void {
    this.host.signaling.reconcileScreenSubscriptions();
    this.host.sfu.revokeConsumers((sessionId, channelId, producerId) => {
      const session = this.host.findSession(sessionId);
      return !!session && this.canReceiveProducer(session, channelId, producerId);
    });
    for (const session of this.host.sessions()) {
      const channelId = session.sessionId && this.host.signaling.getVoiceState(session.sessionId)?.channelId;
      if (!channelId) continue;
      for (const producerId of session.knownProducerIds ?? []) {
        if (this.host.sfu.ownsProducer(session.sessionId!, channelId, producerId)) continue;
        if (!this.canReceiveProducer(session, channelId, producerId)) this.host.send(session.ws, {
          type: MessageType.SFU_PRODUCER_CLOSED, payload: { channelId, producerId },
        });
      }
    }
  }

  /** Every outbound path, including auth, bots and broadcasts, uses this projection. */
  public projectScreenMessage(session: ClientSession, message: ServerMessage): ServerMessage | null {
    // A client's native roster only accepts as many screens per person as it negotiated.
    const shareLimit = session.protocol?.features.includes('screen-shares-8')
      ? SCREEN_SHARE_LIMITS.maximum : SCREEN_SHARE_LIMITS.legacy;
    const state = (value: VoiceParticipantState) => this.host.signaling.projectVoiceState(value, session.user?.id, shareLimit);
    const roster = (values: VoiceRosterParticipant[]) => values.map(value => ({ ...value, voiceState: state(value.voiceState) }));
    const remember = (id: string) => {
      session.retiredProducerIds?.delete(id);
      (session.knownProducerIds ??= new Set()).add(id);
    };
    switch (message.type) {
      case MessageType.AUTH_SUCCESS: {
        const payload: AuthSuccessPayload = message.payload;
        return { ...message, payload: { ...payload, server: { ...payload.server,
          voiceStates: Object.fromEntries(Object.entries(payload.server.voiceStates ?? {}).map(([id, value]) => [id, state(value)])),
        } } };
      }
      case MessageType.VOICE_USER_JOINED: {
        const payload: VoiceUserJoinedPayload = message.payload;
        return { ...message, payload: { ...payload, voiceState: state(payload.voiceState),
          ...(payload.participants ? { participants: roster(payload.participants) } : {}),
        } };
      }
      case MessageType.VOICE_STATE_CHANGED: {
        const payload: VoiceStateChangedPayload = message.payload;
        return { ...message, payload: { ...payload, voiceState: state(payload.voiceState) } };
      }
      case MessageType.SFU_NEW_PRODUCER: {
        const payload: SfuNewProducerPayload = message.payload;
        if (!this.canReceiveProducer(session, payload.channelId, payload.producerId)) return null;
        remember(payload.producerId);
        break;
      }
      case MessageType.SFU_PRODUCERS_LIST: {
        const payload: SfuProducersListPayload = message.payload;
        const producers = payload.producers.filter(value => this.canReceiveProducer(session, payload.channelId, value.producerId));
        producers.forEach(value => remember(value.producerId));
        return { ...message, payload: { ...payload, producers,
          ...(payload.participants ? { participants: roster(payload.participants) } : {}),
        } };
      }
      case MessageType.SFU_PRODUCED: {
        const payload: SfuProducedPayload = message.payload;
        remember(payload.id);
        break;
      }
      case MessageType.SFU_CONSUMED: {
        const payload: SfuConsumedPayload = message.payload;
        if (!this.canReceiveProducer(session, payload.channelId, payload.producerId)) return null;
        remember(payload.producerId);
        break;
      }
      case MessageType.SFU_PRODUCER_CLOSED: {
        const payload: SfuProducerClosedPayload = message.payload;
        const advertised = session.knownProducerIds?.delete(payload.producerId);
        if (!advertised && !message.requestId) return null;
        // A revocation also sends CLOSED, but must not grant a later liveness oracle.
        if (advertised && this.host.sfu.getProducer(payload.producerId)?.channelId !== payload.channelId) {
          const retired = session.retiredProducerIds ??= new Set();
          retired.add(payload.producerId);
          if (retired.size > MAX_RETIRED_SFU_PRODUCERS) {
            const oldest = retired.values().next().value;
            if (oldest !== undefined) retired.delete(oldest);
          }
        }
        break;
      }
    }
    return message;
  }

  /**
   * A role was written. The authority it took away is withdrawn at once; what
   * it gave is republished once the roles are read again.
   */
  public rolesChanged(revocation: { roleId?: string; userId?: string } | null): void {
    if (revocation) this.host.signaling.invalidateScreenRoles(
      revocation, this.host.permissions.getScreenRoleAccessVersion(),
    );
    this.reconcileScreenAccess();
    void this.refreshScreenRoles().catch(error => Logger.error('WEBRTC', 'Screen audience refresh failed.', error));
  }

  /**
   * Republishes the role-gated screens each participant may see once the roles
   * behind them changed: on role mutations, and once at startup, never on a
   * login (S-VOICE-10). Calls run one after another, so awaiting one means
   * every publication asked before it has reached its recipients.
   */
  public refreshScreenRoles(): Promise<void> {
    const run = (this.screenRolesRefresh ?? Promise.resolve()).then(() => this.publishScreenRoles());
    this.screenRolesRefresh = run.catch(() => {});
    return run;
  }

  private async publishScreenRoles(): Promise<void> {
    if (this.host.closing) return;
    const version = this.host.permissions.getScreenRoleAccessVersion();
    const readVersion = this.host.permissions.getRoleAccessVersion();
    if (readVersion === null) return;
    const state = await this.host.roles.getRoleState();
    if (this.host.closing || this.host.permissions.getScreenRoleAccessVersion() !== version
      || this.host.permissions.getRoleAccessVersion() !== readVersion) return;
    this.host.signaling.setScreenRoles(state.roles, state.userRoles, version);
    const revision = this.host.signaling.getScreenRolesRevision();
    if (revision === this.publishedScreenRoles) return;
    this.publishedScreenRoles = revision;
    this.reconcileScreenAccess();
    for (const voiceState of Object.values(this.host.signaling.getAllVoiceStates())) {
      if (!voiceState.nativeScreenShares?.length) continue;
      await this.host.broadcastToChannel(voiceState.channelId, {
        type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState },
      }, undefined, () => this.host.signaling.getVoiceState(voiceState.sessionId) === voiceState);
    }
    for (const session of this.host.sessions()) {
      const channelId = session.sessionId && this.host.signaling.getVoiceState(session.sessionId)?.channelId;
      if (!channelId) continue;
      for (const producer of this.host.sfu.getProducersInChannel(channelId)) {
        if (producer.appData.mediaType !== 'screen_video' && producer.appData.mediaType !== 'screen_audio') continue;
        if (!session.knownProducerIds?.has(producer.producerId)
          && producer.producerSessionId !== session.sessionId
          && this.canReceiveProducer(session, channelId, producer.producerId)) {
          this.host.send(session.ws, { type: MessageType.SFU_NEW_PRODUCER, payload: { channelId, ...producer } });
        }
      }
    }
  }

  public handleScreenViewers(session: ClientSession, value: unknown, requestId?: string): void {
    if (!session.user || !session.sessionId || session.isBot) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'A consulta de espectadores exige uma sessão de participante.', requestId);
      return;
    }
    const parsed = screenViewersRequestSchema.safeParse(value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Consulta de espectadores inválida.', requestId);
      return;
    }
    const query = parsed.data;
    const publisher = this.host.signaling.getVoiceState(query.publisherSessionId);
    const source = publisher?.nativeScreenShares?.find(entry => entry.shareId === query.shareId);
    if (!publisher || publisher.channelId !== query.channelId || !publisher.screenShareIds?.includes(query.shareId)
      || (source?.instanceId ?? null) !== query.sourceInstanceId
      || !this.host.signaling.canWatchScreen(query.publisherSessionId, session.sessionId, query.shareId, source?.instanceId)) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'A transmissão não está disponível para esta sessão.', requestId);
      return;
    }
    const viewers = source
      ? this.host.signaling.getNativeScreenViewers(query.publisherSessionId, query.shareId, source.instanceId)
      : [...this.host.sfu.getScreenViewers(query.publisherSessionId, query.channelId, query.shareId),
        ...this.host.signaling.getLegacyScreenViewers(query.publisherSessionId, query.shareId)];
    const viewerSessionIds = [...new Set(viewers)].filter(id => {
      const viewer = this.host.findSession(id);
      return id !== query.publisherSessionId && viewer?.ws.readyState === WebSocket.OPEN
        && this.host.signaling.canWatchScreen(query.publisherSessionId, id, query.shareId, source?.instanceId);
    });
    this.host.send(session.ws, {
      type: MessageType.SCREEN_VIEWERS_RESULT, requestId,
      payload: { ...query, viewerSessionIds } satisfies ScreenViewersResult,
    });
  }

  public handleNativeScreenSignal(session: ClientSession, value: unknown, requestId?: string): void {
    if (!session.user || !session.sessionId) return;
    const parsed = nativeScreenSignalSchema.safeParse(
      value && typeof value === 'object' ? { ...value, fromSessionId: session.sessionId } : value);
    if (!parsed.success) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Controle de transmissão inválido.', requestId);
      return;
    }
    const target = this.host.findSession(parsed.data.targetSessionId);
    const canForward = target && !target.isBot && target.ws.readyState === WebSocket.OPEN;
    if (session.isBot || (!canForward && parsed.data.action !== 'stop')) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'O participante não pode receber esta transmissão.', requestId);
      return;
    }
    const authorized = this.host.signaling.authorizeNativeScreenSignal(parsed.data);
    if (!authorized.success) {
      this.host.sendError(session.ws, authorized.code, authorized.message, requestId);
      return;
    }
    if (authorized.forward !== false) {
      if (!canForward) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'O participante não pode receber esta transmissão.', requestId);
        return;
      }
      this.host.send(target.ws, { type: MessageType.NATIVE_SCREEN_SIGNAL, requestId, payload: parsed.data });
    }
    this.host.send(session.ws, {
      type: MessageType.NATIVE_SCREEN_SIGNAL_ACK, requestId,
      payload: { subscriptionId: parsed.data.subscriptionId, accepted: true },
    });
  }

  /** A native subscription lost its authorization: the publisher stops sending, and the viewer is told why. */
  public revokeNativeSubscription(request: Extract<NativeScreenSignalPayload, { action: 'watch' }>): void {
    const { action: _action, quality: _quality, backend: _backend, ...identity } = request;
    const publisher = this.host.findSession(request.publisherSessionId);
    const viewer = this.host.findSession(request.fromSessionId);
    if (publisher) this.host.send(publisher.ws, {
      type: MessageType.NATIVE_SCREEN_SIGNAL, payload: { ...identity, action: 'stop' },
    });
    if (viewer) this.host.send(viewer.ws, {
      type: MessageType.NATIVE_SCREEN_SIGNAL, payload: {
        action: 'closed', fromSessionId: request.publisherSessionId, targetSessionId: request.fromSessionId,
        publisherSessionId: request.publisherSessionId, channelId: request.channelId,
        shareId: request.shareId, sourceInstanceId: request.sourceInstanceId, subscriptionId: request.subscriptionId,
        reason: 'source-unavailable',
      },
    });
  }
}
