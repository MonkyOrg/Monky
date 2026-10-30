import * as mediasoupClient from 'mediasoup-client';
import type { types as mediasoupTypes } from 'mediasoup-client';
import {
  MessageType,
  ProtocolErrorCode,
  aggregateTransportHealth,
  VoiceConnectionHealth,
  VoiceRosterParticipant,
  QualityPresetType,
  QualityProfile,
  SfuConnectWebRtcTransportPayload,
  SfuConsumePayload,
  SfuConsumedPayload,
  SfuConsumerClosedPayload,
  SfuCreateWebRtcTransportPayload,
  SfuGetProducersPayload,
  SfuGetRouterRtpCapabilitiesPayload,
  SfuNewProducerPayload,
  SfuProducePayload,
  SfuProducedPayload,
  SfuProducerClosedPayload,
  SfuProducersListPayload,
  SfuRouterRtpCapabilitiesPayload,
  SfuWebRtcTransportCreatedPayload,
} from '@monky/shared';
import { NetworkClient, ProtocolRequestError } from '../NetworkClient';
import { clientLog } from '../ClientLogService';
import { appEvents } from '../EventBus';
import { currentEventOrigin } from '../sessionRouting';
import { shouldPreferHardwareEncoding, sortVideoCodecs } from './codecPreferences';
import { applyMediaEncodingPolicy, getMediaEncodingPolicy, type OutboundMediaKind } from './mediaEncodingPolicy';
import { updateRtpSenderParameters } from './rtpSenderParameters';
import { candidateRoute } from './rtcStats';

/** Replies carry mediasoup structures as `unknown`; this engine reads them with mediasoup-client's types. */
type RouterCapabilitiesResponse = Omit<SfuRouterRtpCapabilitiesPayload, 'rtpCapabilities'> & {
  rtpCapabilities: mediasoupTypes.RtpCapabilities;
};
type TransportCreatedResponse = Omit<SfuWebRtcTransportCreatedPayload, 'transportOptions'> & {
  transportOptions: mediasoupTypes.TransportOptions;
};
type ConsumedResponse = Omit<SfuConsumedPayload, 'rtpParameters'> & { rtpParameters: mediasoupTypes.RtpParameters };

export interface SfuConsumerTrackEvent {
  producerSessionId: string;
  kind: 'audio' | 'video';
  mediaType: 'mic' | 'camera';
  track: MediaStreamTrack;
  consumerId: string;
  producerId: string;
  rtpReceiver?: RTCRtpReceiver;
}

export interface SfuClientEngineCallbacks {
  onHealthChanged: (health: VoiceConnectionHealth) => void;
  onRoster: (channelId: string, participants: VoiceRosterParticipant[]) => void;
  onConsumerTrack: (event: SfuConsumerTrackEvent) => void;
  onConsumerClosed: (producerSessionId: string, mediaType: string, track?: MediaStreamTrack) => void;
  /**
   * The SFU link is down. There is no degraded mode to fall back to, so the
   * manager answers this by rejoining the room until it comes back.
   */
  onConnectionFailed: (reason: string) => void;
  /** A transport reached `connected`, or the call settled `idle`; either closes any rejoin ladder in flight. */
  onConnected: () => void;
}

export class SfuClientEngine {
  private getClient: () => NetworkClient;
  private getMySessionId: () => string | undefined;
  private joinedClient: NetworkClient | null = null;
  private device: mediasoupClient.Device | null = null;
  private sendTransport: mediasoupTypes.Transport | null = null;
  private recvTransport: mediasoupTypes.Transport | null = null;
  private channelId: string | null = null;
  private producers: Map<string, mediasoupTypes.Producer> = new Map();
  private pendingCameraProducer: object | null = null;
  private pendingMicProducer: object | null = null;
  // The manager resolves the profile; both transports use mediaEncodingPolicy.
  private qualityPreset: QualityPresetType = 'NORMAL';
  private qualityProfile: QualityProfile | null = null;
  private consumers: Map<string, mediasoupTypes.Consumer> = new Map();
  private pendingConsumers = new Map<string, object>();
  /** Consumer tracking metadata: producerId -> { producerSessionId, mediaType, consumerId } */
  private consumerMeta: Map<string, { producerSessionId: string; mediaType: string; consumerId: string }> = new Map();
  private isConnecting: boolean = false;
  private isInitialized: boolean = false;
  /**
   * Last reported state of each transport.
   *
   * Tracked separately because the two carry different media in different
   * directions and can diverge: a send transport reaching `connected` while
   * the recv one failed must not be read as a healthy session, or the rejoin
   * that the failure asked for would be cancelled and half the call would stay
   * dead.
   */
  private sendTransportState: string = 'new';
  private recvTransportState: string = 'new';
  private unsubscribeEvents: Array<() => void> = [];
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private joinEpoch = 0;
  private consumerSetupFailed = false;
  private microphoneSetupFailed = false;
  // The server refuses microphone publication while Speak is denied in the
  // channel. That is a permission mute, not a broken transport.
  private microphoneDenied = false;
  // The manager finished publishing what the call had to publish. Until then,
  // transports that are still `new` may just be waiting for their first producer.
  private publicationSettled = false;

  constructor(
    getClient: () => NetworkClient,
    getMySessionId: () => string | undefined,
    private callbacks: SfuClientEngineCallbacks
  ) {
    this.getClient = getClient;
    this.getMySessionId = getMySessionId;
  }

  private get client(): NetworkClient {
    return this.joinedClient ?? this.getClient();
  }

  private logTransportCandidates(
    direction: 'send' | 'recv',
    transport: { id: string; iceCandidates: readonly unknown[] },
  ): void {
    const candidates = transport.iceCandidates.map(candidate => {
      if (!candidate || typeof candidate !== 'object') return { invalid: true };
      const address = 'ip' in candidate && typeof candidate.ip === 'string' ? candidate.ip
        : 'address' in candidate && typeof candidate.address === 'string' ? candidate.address : undefined;
      const protocol = 'protocol' in candidate && typeof candidate.protocol === 'string' ? candidate.protocol : undefined;
      const port = 'port' in candidate && typeof candidate.port === 'number' ? candidate.port : undefined;
      if (!address || !protocol || port === undefined) return { invalid: true };
      return { address, protocol, port };
    });
    clientLog.info('SFU', `${direction} transport created; ICE connectivity is not confirmed`, {
      transportId: transport.id, candidates,
    });
  }

  public async join(channelId: string): Promise<boolean> {
    this.leave();
    this.joinedClient = this.getClient();
    const epoch = this.joinEpoch;
    const client = this.client;
    const connectionId = client.getConnectionId();
    const isCurrent = () => epoch === this.joinEpoch && client.getConnectionId() === connectionId;
    const abandoned = () => new DOMException('SFU connection was abandoned', 'AbortError');
    this.channelId = channelId;
    this.isConnecting = true;
    this.callbacks.onHealthChanged('connecting');

    try {
      console.log(`[SFU Client] Joining SFU room for channel ${channelId}...`);
      clientLog.info('SFU', `Joining SFU room for channel ${channelId}`);

      // 1. Get router RTP capabilities
      const routerCapsResp = await client.sendRequest<RouterCapabilitiesResponse>(
        MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES,
        { channelId } satisfies SfuGetRouterRtpCapabilitiesPayload,
        undefined,
        10000
      );
      if (!isCurrent()) return false;

      if (!routerCapsResp || !routerCapsResp.rtpCapabilities) {
        throw new Error('Falha ao obter capacidades RTP do servidor SFU');
      }

      console.log(`[SFU Client] Received Router RTP capabilities (${routerCapsResp.rtpCapabilities.codecs?.length || 0} codecs). Loading device...`);

      // 2. Load device
      this.device = new mediasoupClient.Device();
      await this.device.load({
        routerRtpCapabilities: routerCapsResp.rtpCapabilities,
        // Preserve native profile order, as in P2P. A router's first H.264
        // profile can select software even when another has a hardware encoder.
        preferLocalCodecsOrder: true,
      });
      if (!isCurrent()) return false;
      console.log(`[SFU Client] Mediasoup Device loaded! Can produce audio: ${this.canProduceKind('audio')}, video: ${this.canProduceKind('video')}`);

      // 3. Create send transport
      console.log(`[SFU Client] Requesting createSendTransport from server...`);
      const sendCreated = await client.sendRequest<TransportCreatedResponse>(
        MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
        { channelId, direction: 'send' } satisfies SfuCreateWebRtcTransportPayload,
        undefined,
        10000
      );
      if (!isCurrent()) return false;

      this.logTransportCandidates('send', sendCreated.transportOptions);

      this.sendTransport = this.device.createSendTransport(sendCreated.transportOptions);
      const sendTransport = this.sendTransport;

      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        if (!isCurrent()) { errback(abandoned()); return; }
        console.log(`[SFU Client] Send transport on('connect') DTLS triggered (role: ${dtlsParameters.role})`);
        client
          .sendRequest(
            MessageType.SFU_CONNECT_WEBRTC_TRANSPORT,
            {
              channelId,
              transportId: sendTransport.id,
              dtlsParameters,
            } satisfies SfuConnectWebRtcTransportPayload,
            undefined,
            8000
          )
          .then(() => {
            if (!isCurrent()) { errback(abandoned()); return; }
            console.log(`[SFU Client] Send transport DTLS connect acknowledged by server`);
            callback();
          })
          .catch((err) => {
            console.error('[SFU Client] Send transport connect error:', err);
            clientLog.error('SFU', 'Send transport connect error', { error: err?.message });
            errback(err);
          });
      });

      sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        if (!isCurrent()) { errback(abandoned()); return; }
        console.log(`[SFU Client] Send transport on('produce') triggered: kind=${kind}, type=${appData?.mediaType}`);
        client
          .sendRequest<SfuProducedPayload>(
            MessageType.SFU_PRODUCE,
            {
              channelId,
              transportId: sendTransport.id,
              kind,
              rtpParameters,
              appData,
            } satisfies SfuProducePayload,
            undefined,
            8000
          )
          .then((resp) => {
            if (!isCurrent()) { errback(abandoned()); return; }
            console.log(`[SFU Client] Producer acknowledged by server with producerId: ${resp.id}`);
            callback({ id: resp.id });
          })
          .catch((err) => {
            console.error('[SFU Client] Send transport produce error:', err);
            clientLog.error('SFU', 'Send transport produce error', { error: err?.message });
            errback(err);
          });
      });

      sendTransport.on('connectionstatechange', (state) => {
        if (!isCurrent()) return;
        console.log(`[SFU Client] Send transport connectionState changed: ${state}`);
        clientLog.info('SFU', `Send transport state: ${state}`);
        this.sendTransportState = state;
        this.notifyIfHealthy();
      });

      // 4. Create recv transport
      console.log(`[SFU Client] Requesting createRecvTransport from server...`);
      const recvCreated = await client.sendRequest<TransportCreatedResponse>(
        MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
        { channelId, direction: 'recv' } satisfies SfuCreateWebRtcTransportPayload,
        undefined,
        10000
      );
      if (!isCurrent()) return false;

      this.logTransportCandidates('recv', recvCreated.transportOptions);

      this.recvTransport = this.device.createRecvTransport(recvCreated.transportOptions);
      const recvTransport = this.recvTransport;

      recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        if (!isCurrent()) { errback(abandoned()); return; }
        console.log(`[SFU Client] Recv transport on('connect') DTLS triggered (role: ${dtlsParameters.role})`);
        client
          .sendRequest(
            MessageType.SFU_CONNECT_WEBRTC_TRANSPORT,
            {
              channelId,
              transportId: recvTransport.id,
              dtlsParameters,
            } satisfies SfuConnectWebRtcTransportPayload,
            undefined,
            8000
          )
          .then(() => {
            if (!isCurrent()) { errback(abandoned()); return; }
            console.log(`[SFU Client] Recv transport DTLS connect acknowledged by server`);
            callback();
          })
          .catch((err) => {
            console.error('[SFU Client] Recv transport connect error:', err);
            clientLog.error('SFU', 'Recv transport connect error', { error: err?.message });
            errback(err);
          });
      });

      recvTransport.on('connectionstatechange', (state) => {
        if (!isCurrent()) return;
        console.log(`[SFU Client] Recv transport connectionState changed: ${state}`);
        clientLog.info('SFU', `Recv transport state: ${state}`);
        this.recvTransportState = state;
        this.notifyIfHealthy();
      });

      // 5. Register network listeners for new producers and producer closed
      this.subscribeNetworkEvents(client);

      // 6. Fetch existing producers in the channel and consume them
      try {
        console.log(`[SFU Client] Fetching existing producers in channel ${channelId}...`);
        const producersResp = await client.sendRequest<SfuProducersListPayload>(
          MessageType.SFU_GET_PRODUCERS,
          { channelId } satisfies SfuGetProducersPayload,
          undefined,
          8000
        );
        if (!isCurrent()) return false;
        this.callbacks.onRoster(channelId, producersResp.participants);

        if (producersResp && Array.isArray(producersResp.producers)) {
          console.log(`[SFU Client] Found ${producersResp.producers.length} existing producers in channel:`, producersResp.producers);
          for (const prod of producersResp.producers) {
            void this.consumeRemoteProducer(prod);
          }
        }
      } catch (err: any) {
        console.warn('[SFU Client] Failed to fetch existing producers in channel:', err);
        clientLog.warn('SFU', 'Failed to fetch existing producers in channel', { error: err?.message });
        throw err;
      }
      if (!isCurrent()) return false;

      this.isInitialized = true;
      this.isConnecting = false;
      console.log(`[SFU Client] Successfully joined and initialized SFU for channel ${channelId}`);
      clientLog.info('SFU', `Signaling ready for SFU channel ${channelId}; waiting for media transport`);
      return true;
    } catch (err: any) {
      if (!isCurrent()) return false;
      console.error('[SFU Client] Error joining SFU channel:', err);
      clientLog.error('SFU', 'Error joining SFU channel', { error: err?.message });
      this.leave();
      return false;
    }
  }

  private subscribeNetworkEvents(client = this.client): void {
    const isOrigin = () => !currentEventOrigin() || currentEventOrigin() === client.sessionKey;
    const handleNewProducer = (payload: SfuNewProducerPayload) => {
      if (!isOrigin() || payload.channelId !== this.channelId) return;
      void this.consumeRemoteProducer(payload);
    };

    const handleProducerClosed = (payload: SfuProducerClosedPayload) => {
      if (!isOrigin() || payload.channelId !== this.channelId) return;
      this.handleRemoteProducerClosed(payload.producerId);
    };

    appEvents.on(`message.${MessageType.SFU_NEW_PRODUCER}`, handleNewProducer);
    appEvents.on(`message.${MessageType.SFU_PRODUCER_CLOSED}`, handleProducerClosed);

    this.unsubscribeEvents.push(() => {
      appEvents.off(`message.${MessageType.SFU_NEW_PRODUCER}`, handleNewProducer);
      appEvents.off(`message.${MessageType.SFU_PRODUCER_CLOSED}`, handleProducerClosed);
    });
  }

  public canProduceKind(kind: 'audio' | 'video'): boolean {
    if (!this.device || !this.device.loaded) return false;
    try {
      return this.device.canProduce(kind);
    } catch {
      return false;
    }
  }

  /**
   * Picks which codec to encode the camera with instead of letting mediasoup
   * take the first one the router offers (#526): the router advertises AV1
   * first, and AV1 has no hardware encoder on most desktops. This follows the
   * same automatic order as P2P calls.
   */
  private pickVideoCodec(): mediasoupTypes.RtpCodecCapability | undefined {
    // Receive capabilities are not evidence that this device can encode the
    // same profile. mediasoup exposes the negotiated send set separately.
    const codecs = this.device?.sendRtpCapabilities?.codecs ?? [];

    const videoCodecs = codecs.filter(
      (codec) => codec.kind === 'video' && !/\/(rtx|red|ulpfec|flexfec)/i.test(codec.mimeType)
    );
    const [best] = sortVideoCodecs(videoCodecs, shouldPreferHardwareEncoding());
    return best;
  }

  private async produceTrack(
    kind: OutboundMediaKind,
    options: mediasoupTypes.ProducerOptions,
  ): Promise<mediasoupTypes.Producer> {
    const transport = this.sendTransport;
    const epoch = this.joinEpoch;
    const client = this.client;
    const channelId = this.channelId;
    if (!transport) throw new Error('SFU transport is unavailable');
    // Capture services own these tracks. A transport rebuild must not stop the
    // microphone/camera/share that the replacement is about to publish.
    const policy = this.qualityProfile ? getMediaEncodingPolicy(kind, this.qualityPreset, this.qualityProfile) : null;
    const producer = await transport.produce({
      ...options,
      ...(policy && !options.encodings ? { encodings: [{ ...policy.encoding }] } : {}),
      stopTracks: false,
    });
    if (epoch !== this.joinEpoch) {
      producer.close();
      if (channelId) client.send(MessageType.SFU_PRODUCER_CLOSED, { channelId, producerId: producer.id } satisfies SfuProducerClosedPayload);
      throw new DOMException('SFU producer belongs to an abandoned connection', 'AbortError');
    }
    return producer;
  }

  public async produceMic(track: MediaStreamTrack): Promise<mediasoupTypes.Producer | null> {
    if (!this.sendTransport || !this.canProduceKind('audio')) {
      console.warn(`[SFU Client] Cannot produce mic: sendTransport=${!!this.sendTransport}, canProduceAudio=${this.canProduceKind('audio')}`);
      if (this.channelId) {
        this.microphoneSetupFailed = true;
        this.notifyIfHealthy();
      }
      return null;
    }
    this.closeProducer('mic', false);
    // An ended capture track is a local device problem, not a broken link.
    // Reported as a transport failure, it sent the call into a rejoin whose
    // every rung published the same dead track again (R-VOICE-12).
    if (track.readyState !== 'live') {
      clientLog.warn('SFU', 'The microphone track ended before publication; the call stays listen-only');
      this.notifyIfHealthy();
      return null;
    }
    const operation = {};
    const client = this.client;
    const channelId = this.channelId;
    this.pendingMicProducer = operation;
    this.microphoneSetupFailed = false;
    this.microphoneDenied = false;
    this.notifyIfHealthy();
    let producer: mediasoupTypes.Producer | null = null;
    try {
      console.log(`[SFU Client] Producing microphone track ${track.id} (enabled=${track.enabled}, readyState=${track.readyState})...`);
      producer = await this.produceTrack('audio', {
        track,
        appData: { mediaType: 'mic' },
        codecOptions: {
          opusDtx: true,
        },
      });
      if (this.pendingMicProducer !== operation || track.readyState !== 'live') {
        throw new DOMException('Microphone producer was stopped or replaced', 'AbortError');
      }
      this.producers.set('mic', producer);
      await this.applyProducerQuality('mic', producer);
      if (this.pendingMicProducer !== operation || this.producers.get('mic') !== producer || producer.closed) {
        throw new DOMException('Microphone producer was stopped or replaced', 'AbortError');
      }
      const current = producer;
      producer.on('transportclose', () => {
        console.log(`[SFU Client] Mic producer transport closed`);
        if (this.producers.get('mic') === current) this.producers.delete('mic');
      });
      console.log(`[SFU Client] Produced mic audio track ${track.id} with producerId ${producer.id}`);
      clientLog.info('SFU', `Produced mic audio track ${track.id} with producerId ${producer.id}`);
      return producer;
    } catch (error) {
      if (producer) {
        if (this.producers.get('mic') === producer) this.producers.delete('mic');
        if (!producer.closed) {
          producer.close();
          if (channelId) client.send(MessageType.SFU_PRODUCER_CLOSED, { channelId, producerId: producer.id } satisfies SfuProducerClosedPayload);
        }
      }
      if (this.pendingMicProducer === operation) {
        if (error instanceof ProtocolRequestError && error.code === ProtocolErrorCode.PERMISSION_DENIED) {
          clientLog.warn('SFU', 'Microphone publication refused while Speak is denied in this channel');
          this.microphoneDenied = true;
        } else if (track.readyState !== 'live') {
          clientLog.warn('SFU', 'The microphone track ended during publication; the call stays listen-only');
        } else {
          clientLog.error('SFU', 'Failed to produce mic track', { error: error instanceof Error ? error.message : String(error) });
          this.microphoneSetupFailed = true;
        }
      }
      return null;
    } finally {
      if (this.pendingMicProducer === operation) {
        this.pendingMicProducer = null;
        this.notifyIfHealthy();
      }
    }
  }

  public async produceCamera(track: MediaStreamTrack): Promise<mediasoupTypes.Producer | null> {
    if (!this.sendTransport || !this.canProduceKind('video')) {
      console.warn(`[SFU Client] Cannot produce camera: sendTransport=${!!this.sendTransport}, canProduceVideo=${this.canProduceKind('video')}`);
      return null;
    }
    this.closeProducer('camera');
    const operation = {};
    const client = this.client;
    const channelId = this.channelId;
    this.pendingCameraProducer = operation;
    let producer: mediasoupTypes.Producer | null = null;
    try {
      console.log(`[SFU Client] Producing camera track ${track.id}...`);
      producer = await this.produceTrack('camera', {
        track,
        codec: this.pickVideoCodec(),
        appData: { mediaType: 'camera' },
      });
      if (this.pendingCameraProducer !== operation || track.readyState !== 'live') {
        throw new DOMException('Camera producer was stopped or replaced', 'AbortError');
      }
      this.producers.set('camera', producer);
      await this.applyProducerQuality('camera', producer);
      if (this.pendingCameraProducer !== operation || this.producers.get('camera') !== producer || producer.closed) {
        throw new DOMException('Camera producer was stopped or replaced', 'AbortError');
      }
      const current = producer;
      producer.on('transportclose', () => {
        if (this.producers.get('camera') === current) this.producers.delete('camera');
      });
      console.log(`[SFU Client] Produced camera video track ${track.id} with producerId ${producer.id}`);
      clientLog.info('SFU', `Produced camera video track ${track.id} with producerId ${producer.id}`);
      return producer;
    } catch (err) {
      if (producer) {
        if (this.producers.get('camera') === producer) this.producers.delete('camera');
        if (!producer.closed) {
          producer.close();
          if (channelId) client.send(MessageType.SFU_PRODUCER_CLOSED, { channelId, producerId: producer.id } satisfies SfuProducerClosedPayload);
        }
      }
      console.error('[SFU Client] Failed to produce camera track:', err);
      clientLog.error('SFU', 'Failed to produce camera track', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      if (this.pendingCameraProducer === operation) this.pendingCameraProducer = null;
    }
  }

  /** Store the shared policy before publishing and reapply it to existing senders. */
  public async applyQualityParams(preset: QualityPresetType, profile: QualityProfile): Promise<void> {
    this.qualityPreset = preset;
    this.qualityProfile = { ...profile };
    for (const [key, producer] of this.producers.entries()) {
      await this.applyProducerQuality(key, producer);
    }
  }

  private async applyProducerQuality(key: string, producer: mediasoupTypes.Producer): Promise<void> {
    const profile = this.qualityProfile;
    if (!profile) return;
    const sender = producer.rtpSender;
    if (!sender) return;
    const kind: OutboundMediaKind = key === 'mic' ? 'audio' : 'camera';
    const policy = getMediaEncodingPolicy(kind, this.qualityPreset, profile);
    const isCurrent = () => this.producers.get(key) === producer && !producer.closed && this.qualityProfile === profile;
    try {
      await updateRtpSenderParameters(sender, parameters =>
        isCurrent() && applyMediaEncodingPolicy(parameters, policy));
    } catch (error) {
      if (isCurrent()) {
        clientLog.warn('SFU', `Failed to apply quality params to producer ${key}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public async replaceTrack(key: string, track: MediaStreamTrack | null): Promise<boolean> {
    const producer = this.producers.get(key);
    if (!producer) return false;
    try {
      await producer.replaceTrack({ track });
      return this.producers.get(key) === producer && !producer.closed;
    } catch (err) {
      clientLog.error('SFU', `Failed to replace track for producer ${key}`, { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  public closeProducer(key: string, notifyHealth = true): void {
    if (key === 'mic') {
      this.pendingMicProducer = null;
      this.microphoneSetupFailed = false;
      this.microphoneDenied = false;
    }
    if (key === 'camera') this.pendingCameraProducer = null;
    const producer = this.producers.get(key);
    if (producer) {
      try {
        producer.close();
      } catch {}
      this.producers.delete(key);
      if (this.channelId) {
        this.client.send(MessageType.SFU_PRODUCER_CLOSED, {
          channelId: this.channelId,
          producerId: producer.id,
        } satisfies SfuProducerClosedPayload);
      }
    }
    if (key === 'mic' && notifyHealth && this.channelId) this.notifyIfHealthy();
  }

  private async consumeRemoteProducer(producerData: SfuNewProducerPayload): Promise<void> {
    // Screens use their own authenticated transport/receiver owner (NativeScreenController).
    if (producerData.appData.mediaType !== 'mic' && producerData.appData.mediaType !== 'camera') return;
    if (!this.recvTransport || !this.device || !this.channelId) {
      console.warn(`[SFU Client] Cannot consume: recvTransport=${!!this.recvTransport}, device=${!!this.device}, channelId=${this.channelId}`);
      return;
    }
    const { producerId, producerSessionId, kind, appData } = producerData;

    // Do not consume our own producers
    const mySessionId = this.getMySessionId();
    if (producerSessionId && mySessionId && producerSessionId === mySessionId) {
      console.log(`[SFU Client] Skipping consumption of our own producer ${producerId}`);
      return;
    }

    if (this.consumers.has(producerId) || this.pendingConsumers.has(producerId)) {
      console.log(`[SFU Client] Already consuming producer ${producerId}`);
      return;
    }

    const epoch = this.joinEpoch;
    const transport = this.recvTransport;
    const client = this.client;
    const channelId = this.channelId;
    const closeServerConsumer = (consumerId: string) => client.send(MessageType.SFU_CONSUMER_CLOSED, {
      channelId, consumerId,
    } satisfies SfuConsumerClosedPayload);
    const pending = {};
    this.pendingConsumers.set(producerId, pending);
    this.notifyIfHealthy();
    const isCurrent = () => epoch === this.joinEpoch && this.pendingConsumers.get(producerId) === pending;
    let serverConsumerId: string | undefined;
    try {
      console.log(`[SFU Client] Consuming remote producer ${producerId} (${kind}, mediaType: ${appData?.mediaType}) from session ${producerSessionId}...`);
      clientLog.info('SFU', `Consuming producer ${producerId} (${kind}) from session ${producerSessionId}`);

      const consumed = await client.sendRequest<ConsumedResponse | SfuProducerClosedPayload>(
        MessageType.SFU_CONSUME,
        {
          channelId,
          transportId: transport.id,
          producerId,
          rtpCapabilities: this.device.rtpCapabilities,
        } satisfies SfuConsumePayload,
        undefined,
        8000
      );
      if (!isCurrent()) {
        if ('id' in consumed) closeServerConsumer(consumed.id);
        return;
      }
      if (!('id' in consumed)) {
        this.handleRemoteProducerClosed(producerId);
        return;
      }
      serverConsumerId = consumed.id;

      const consumer = await transport.consume({
        id: consumed.id,
        producerId: consumed.producerId,
        kind: consumed.kind,
        rtpParameters: consumed.rtpParameters,
        appData: consumed.appData || {},
      });
      if (!isCurrent()) {
        consumer.close();
        closeServerConsumer(consumed.id);
        return;
      }

      console.log(`[SFU Client] Consumed producer ${producerId} successfully! Consumer track: (id=${consumer.track.id}, kind=${consumer.track.kind}, enabled=${consumer.track.enabled}, readyState=${consumer.track.readyState}, muted=${consumer.track.muted})`);

      this.consumers.set(producerId, consumer);
      this.consumerMeta.set(producerId, {
        producerSessionId,
        mediaType: appData.mediaType,
        consumerId: consumer.id,
      });

      consumer.on('trackended', () => {
        if (epoch !== this.joinEpoch || this.consumers.get(producerId) !== consumer) return;
        console.log(`[SFU Client] Consumer track ended for producer ${producerId}`);
        this.consumerSetupFailed = true;
        this.handleRemoteProducerClosed(producerId);
      });

      consumer.on('transportclose', () => {
        if (epoch !== this.joinEpoch || this.consumers.get(producerId) !== consumer) return;
        console.log(`[SFU Client] Consumer transport closed for producer ${producerId}`);
        this.handleRemoteProducerClosed(producerId);
      });

      this.callbacks.onConsumerTrack({
        producerSessionId,
        kind,
        mediaType: appData.mediaType,
        track: consumer.track,
        consumerId: consumer.id,
        producerId,
        rtpReceiver: consumer.rtpReceiver,
      });
    } catch (err) {
      const reportFailure = isCurrent();
      if (reportFailure) this.consumerSetupFailed = true;
      if (serverConsumerId && this.consumers.get(producerId)?.id === serverConsumerId) this.closeRemoteConsumer(producerId);
      else if (serverConsumerId) closeServerConsumer(serverConsumerId);
      if (!reportFailure || epoch !== this.joinEpoch) return;
      console.error(`[SFU Client] Error consuming remote producer ${producerId}:`, err);
      clientLog.error('SFU', `Error consuming remote producer ${producerId}`, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.pendingConsumers.get(producerId) === pending) {
        this.pendingConsumers.delete(producerId);
        this.notifyIfHealthy();
      }
    }
  }

  private handleRemoteProducerClosed(producerId: string): void {
    this.closeRemoteConsumer(producerId);
  }

  private closeRemoteConsumer(producerId: string): void {
    this.pendingConsumers.delete(producerId);
    const consumer = this.consumers.get(producerId);
    const meta = this.consumerMeta.get(producerId);
    this.consumers.delete(producerId);
    this.consumerMeta.delete(producerId);
    if (consumer) {
      if (this.channelId) this.client.send(MessageType.SFU_CONSUMER_CLOSED, {
        channelId: this.channelId, consumerId: consumer.id,
      } satisfies SfuConsumerClosedPayload);
      try {
        consumer.close();
      } catch {}
    }
    if (meta) {
      this.callbacks.onConsumerClosed(meta.producerSessionId, meta.mediaType, consumer?.track);
    }
    if (this.channelId) this.notifyIfHealthy();
  }

  public getConsumerReceiver(producerSessionId: string, mediaType: string = 'mic'): RTCRtpReceiver | null {
    for (const [prodId, meta] of this.consumerMeta.entries()) {
      if (meta.producerSessionId === producerSessionId && meta.mediaType === mediaType) {
        const consumer = this.consumers.get(prodId);
        return (consumer as any)?.rtpReceiver ?? null;
      }
    }
    return null;
  }

  public isReady(): boolean {
    return this.isInitialized && !!this.sendTransport && !!this.recvTransport;
  }

  public hasMicrophonePublication(): boolean {
    return this.producers.has('mic') || this.pendingMicProducer !== null;
  }

  public isMicrophoneDenied(): boolean {
    return this.microphoneDenied;
  }

  public isChannelConnected(): boolean {
    return this.getHealth() === 'connected';
  }

  public getCameraSender(): RTCRtpSender | null {
    const producer = this.producers.get('camera');
    return producer?.rtpSender ?? null;
  }

  public getCameraTrack(): MediaStreamTrack | null {
    return this.producers.get('camera')?.track ?? null;
  }

  public getReceiverForTrack(trackId: string): RTCRtpReceiver | null {
    for (const consumer of this.consumers.values()) {
      if (consumer.track.id === trackId) {
        return (consumer as any)?.rtpReceiver ?? null;
      }
    }
    return null;
  }

  /** Round trip to the server over the worse connected transport, read from the pair carrying media. */
  public async getPing(): Promise<number | null> {
    const pings: number[] = [];
    for (const transport of [this.sendTransport, this.recvTransport]) {
      if (!transport || transport.connectionState !== 'connected') continue;
      try {
        const rttMs = candidateRoute(await transport.getStats())?.rttMs;
        if (rttMs !== null && rttMs !== undefined) pings.push(rttMs);
      } catch {
        // A closing send transport must not hide a still-live receive RTT.
      }
    }
    return pings.length ? Math.max(...pings) : null;
  }

  public leave(): void {
    this.joinEpoch++;
    this.channelId = null;
    this.pendingMicProducer = null;
    this.pendingCameraProducer = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    for (const unsub of this.unsubscribeEvents) {
      unsub();
    }
    this.unsubscribeEvents = [];

    for (const producer of this.producers.values()) {
      try {
        producer.close();
      } catch {}
    }
    this.producers.clear();

    for (const producerId of this.consumers.keys()) {
      this.handleRemoteProducerClosed(producerId);
    }
    this.consumers.clear();
    this.pendingConsumers.clear();
    this.consumerMeta.clear();

    if (this.sendTransport) {
      try {
        this.sendTransport.close();
      } catch {}
      this.sendTransport = null;
    }

    if (this.recvTransport) {
      try {
        this.recvTransport.close();
      } catch {}
      this.recvTransport = null;
    }

    this.device = null;
    this.channelId = null;
    this.joinedClient = null;
    this.isInitialized = false;
    this.isConnecting = false;
    this.sendTransportState = 'new';
    this.recvTransportState = 'new';
    this.consumerSetupFailed = false;
    this.microphoneSetupFailed = false;
    this.microphoneDenied = false;
    this.publicationSettled = false;
  }

  /**
   * Called once the join published everything it had to. A call that then has
   * nothing to send or receive (a listen-only member alone with silent peers,
   * as everyone in the AFK room is) is reported `idle` instead of waiting for a
   * negotiation that will never happen.
   */
  public settlePublication(): void {
    if (!this.channelId || !this.isReady()) return;
    this.publicationSettled = true;
    this.notifyIfHealthy();
  }

  private isIdle(): boolean {
    return this.sendTransportState === 'new' && this.recvTransportState === 'new'
      && !this.pendingMicProducer && !this.pendingCameraProducer && this.pendingConsumers.size === 0;
  }

  /**
   * Reports a healthy session as soon as one direction is up, provided the
   * other one is not down.
   *
   * Requiring *both* to be connected reads safer — a rejoin asked for by one
   * transport must never be cancelled by the other succeeding — but a
   * transport's underlying peer connection stays `new` until something
   * negotiates on it, and mediasoup only negotiates on the first `produce()`
   * or `consume()`. A listen-only client never produces and a client whose
   * peers are all silent never consumes, so for them the pair could never both
   * be connected: recovery would never be reported as finished, the other
   * participants would keep their "connecting" badge, and the backoff would
   * stay pinned at its longest delay for the rest of the session.
   *
   * When neither direction ever negotiates, there is no media to carry at all:
   * once publication settled, the call is `idle` — not failing, but with its
   * connectivity untested, so it is not reported as connected either.
   */
  private getHealth(): VoiceConnectionHealth {
    if (this.consumerSetupFailed || this.microphoneSetupFailed) return 'failed';
    if (this.publicationSettled && this.isIdle()) return 'idle';
    return aggregateTransportHealth([
      this.sendTransportState, this.recvTransportState,
      ...(this.pendingMicProducer || this.pendingConsumers.size > 0 ? ['connecting'] : []),
    ]);
  }

  private notifyIfHealthy(): void {
    const health = this.getHealth();
    this.callbacks.onHealthChanged(health);
    if (health === 'connected' || health === 'idle' || health === 'failed') {
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      if (health === 'failed') this.callbacks.onConnectionFailed('SFU transport failed');
      else this.callbacks.onConnected();
    } else if (!this.recoveryTimer) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        clientLog.warn('SFU', 'SFU media transport connection timed out', {
          sendState: this.sendTransportState, recvState: this.recvTransportState,
        });
        this.callbacks.onConnectionFailed('SFU transport connection timed out');
      }, health === 'reconnecting' ? 3000 : 15000);
    }
  }
}
