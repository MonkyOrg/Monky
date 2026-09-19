import { Device, type types as SfuTypes } from 'mediasoup-client';
import {
  MessageType, nativeScreenProducerSchema, screenShareProfileKey,
  type NativeScreenCall, type NativeScreenProducer, type NativeScreenRpcMethod, type NativeScreenSource,
  type NativeScreenVideoProfile, type SfuConsumedPayload, type SfuProducerClosedPayload,
  type SfuProducersListPayload, type SfuRouterRtpCapabilitiesPayload, type SfuWebRtcTransportCreatedPayload,
} from '@monky/shared';

export type BrowserScreenRpc = <T>(method: NativeScreenRpcMethod, payload: Record<string, unknown>) => Promise<T>;
type RouterResponse = Omit<SfuRouterRtpCapabilitiesPayload, 'rtpCapabilities'> & { rtpCapabilities: SfuTypes.RtpCapabilities };
type TransportResponse = Omit<SfuWebRtcTransportCreatedPayload, 'transportOptions'> & { transportOptions: SfuTypes.TransportOptions };
type ConsumerResponse = Omit<SfuConsumedPayload, 'rtpParameters' | 'appData'> & {
  rtpParameters: SfuTypes.RtpParameters; appData: NativeScreenProducer['appData'];
};
type Producer = { value: NativeScreenProducer; consumer: SfuTypes.Consumer | null; started: boolean };

export interface BrowserScreenSfuOptions {
  call: NativeScreenCall;
  publisherSessionId: string;
  source: NativeScreenSource;
  profile: Readonly<NativeScreenVideoProfile>;
  muted: boolean;
  rpc: BrowserScreenRpc;
  onTrack: (track: MediaStreamTrack, receiver?: RTCRtpReceiver) => void;
  onError: (error: unknown) => void;
}

export class BrowserScreenSfu {
  private readonly device = new Device();
  private readonly screenSessionId = crypto.randomUUID();
  private readonly producers = new Map<string, Producer>();
  private readonly serverConsumers = new Set<string>();
  private transport: SfuTypes.Transport | null = null;
  private serverTransportId: string | null = null;
  private opening: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;
  private muted: boolean;
  private closing: Promise<void> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: BrowserScreenSfuOptions) { this.muted = options.muted; }

  private current(): void {
    if (this.stopping) throw new DOMException('The browser SFU screen was retired.', 'AbortError');
  }

  private fail(error: unknown): void { if (!this.stopping) this.options.onError(error); }

  public start(): Promise<void> {
    if (this.opening) return this.opening;
    this.current();
    this.opening = this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    const { call, rpc } = this.options;
    const router = await rpc<RouterResponse>(MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES, { channelId: call.channelId });
    this.current();
    if (router.channelId !== call.channelId) throw new Error('Screen router capabilities belong to another channel.');
    await this.device.load({ routerRtpCapabilities: router.rtpCapabilities, preferLocalCodecsOrder: true });
    this.current();
    const created = await rpc<TransportResponse>(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, {
      channelId: call.channelId, direction: 'recv', purpose: 'screen', screenSessionId: this.screenSessionId,
    });
    if (typeof created.transportOptions?.id !== 'string' || !created.transportOptions.id)
      throw new Error('The screen server did not identify its new transport.');
    // Remember allocations before checking cancellation or metadata, so late replies can be retired.
    this.serverTransportId = created.transportOptions.id;
    this.current();
    if (created.channelId !== call.channelId || created.direction !== 'recv'
      || created.purpose !== 'screen' || created.screenSessionId !== this.screenSessionId)
      throw new Error('The screen transport changed its authorized scope.');
    const transport = this.transport = this.device.createRecvTransport(created.transportOptions);
    transport.on('connect', ({ dtlsParameters }, resolve, reject) => {
      if (this.stopping) { reject(new Error('The screen transport was retired.')); return; }
      void rpc<{ channelId: string; transportId: string }>(MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, {
        channelId: call.channelId, transportId: transport.id, dtlsParameters,
      }).then(response => {
        this.current();
        if (response.channelId !== call.channelId || response.transportId !== transport.id)
          throw new Error('Screen DTLS acknowledged another transport.');
        resolve();
      }).catch(error => reject(error instanceof Error ? error : new Error(String(error))));
    });
    transport.on('connectionstatechange', state => {
      if (this.stopping) return;
      if (state === 'failed' || state === 'closed') this.fail(new Error('The browser screen SFU connection failed.'));
      if (state === 'disconnected' && !this.disconnectedTimer)
        this.disconnectedTimer = setTimeout(() => this.fail(new Error('The browser screen SFU did not reconnect.')), 10000);
      if (state === 'connected' && this.disconnectedTimer) {
        clearTimeout(this.disconnectedTimer);
        this.disconnectedTimer = null;
      }
    });
    const listed = await rpc<SfuProducersListPayload>(MessageType.SFU_GET_PRODUCERS, { channelId: call.channelId });
    this.current();
    if (listed.channelId !== call.channelId || !Array.isArray(listed.producers) || listed.producers.length > 2048)
      throw new Error('The screen producer list has an invalid scope or size.');
    for (const value of listed.producers) {
      const parsed = nativeScreenProducerSchema.safeParse(value);
      if (parsed.success) this.registerProducer(parsed.data);
    }
    await this.consumePending();
  }

  private registerProducer(value: NativeScreenProducer): void {
    const { source, profile, publisherSessionId, call } = this.options;
    const rendition = value.appData.nativeScreen;
    if (this.stopping || value.channelId !== call.channelId || value.producerSessionId !== publisherSessionId
      || value.appData.shareId !== source.shareId || rendition.sourceInstanceId !== source.instanceId
      || screenShareProfileKey(rendition.video) !== screenShareProfileKey(profile)) return;
    if (value.kind === 'audio' && !source.audio) throw new Error('The screen published undeclared audio.');
    if (this.producers.has(value.producerId)) return;
    if (this.producers.size >= 8) throw new Error('The screen exceeded its rendition limit.');
    this.producers.set(value.producerId, { value, consumer: null, started: false });
  }

  public addProducer(value: NativeScreenProducer): Promise<void> {
    this.registerProducer(nativeScreenProducerSchema.parse(value));
    return this.consumePending();
  }

  private consumePending(): Promise<void> {
    const work = this.queue.then(async () => {
      if (!this.transport || this.stopping) return;
      while (!this.stopping) {
        const next = [...this.producers.values()]
          .sort((left, right) => Number(left.value.kind === 'audio') - Number(right.value.kind === 'audio'))
          .find(entry => !entry.started && (entry.value.kind === 'video'
            || [...this.producers.values()].some(video => video.consumer && video.value.kind === 'video'
              && video.value.appData.nativeScreen.pipelineId === entry.value.appData.nativeScreen.pipelineId)));
        if (!next) return;
        next.started = true;
        await this.consume(next);
      }
    });
    this.queue = work.catch(error => this.fail(error));
    return work;
  }

  private async consume(entry: Producer): Promise<void> {
    const { rpc, call } = this.options;
    const transport = this.transport;
    if (!transport) throw new Error('No screen receive transport was created.');
    const producer = entry.value;
    const selected = () => !this.stopping && this.producers.get(producer.producerId) === entry;
    const capabilities = structuredClone(this.device.rtpCapabilities);
    for (const codec of capabilities.codecs ?? []) {
      const profile = codec.parameters?.['profile-level-id'];
      if (codec.mimeType.toLowerCase() === 'video/h264' && typeof profile === 'string'
        && /^4d[0-9a-f]{4}$/i.test(profile) && Number.parseInt(profile.slice(4), 16) < 51)
        codec.parameters = { ...codec.parameters, 'max-recv-level': '0033' };
    }
    const consumed = await rpc<ConsumerResponse | SfuProducerClosedPayload>(MessageType.SFU_CONSUME, {
      channelId: call.channelId, transportId: transport.id, producerId: producer.producerId,
      rtpCapabilities: capabilities,
    });
    if (!('id' in consumed)) {
      if (consumed.channelId !== call.channelId || consumed.producerId !== producer.producerId)
        throw new Error('Screen consumption ended another producer.');
      this.producers.delete(producer.producerId);
      return;
    }
    if (typeof consumed.id !== 'string' || !consumed.id) throw new Error('The server did not identify its screen consumer.');
    this.serverConsumers.add(consumed.id);
    if (!selected()) { await this.closeConsumer(consumed.id); return; }
    const metadata = nativeScreenProducerSchema.parse({
      channelId: consumed.channelId, producerId: consumed.producerId,
      producerSessionId: consumed.producerSessionId, kind: consumed.kind, appData: consumed.appData,
    });
    if (metadata.channelId !== call.channelId || metadata.producerId !== producer.producerId
      || metadata.producerSessionId !== producer.producerSessionId || metadata.kind !== producer.kind
      || metadata.appData.shareId !== producer.appData.shareId
      || metadata.appData.nativeScreen.pipelineId !== producer.appData.nativeScreen.pipelineId
      || metadata.appData.nativeScreen.sourceInstanceId !== producer.appData.nativeScreen.sourceInstanceId
      || screenShareProfileKey(metadata.appData.nativeScreen.video) !== screenShareProfileKey(producer.appData.nativeScreen.video))
      throw new Error('The screen consumer changed its publisher, source or rendition.');
    const consumer = await transport.consume({
      id: consumed.id, producerId: consumed.producerId, kind: consumed.kind,
      rtpParameters: consumed.rtpParameters, appData: metadata.appData,
      ...(consumed.kind === 'audio' ? { codecOptions: { opusStereo: true } } : {}),
    });
    if (!selected()) { consumer.close(); await this.closeConsumer(consumed.id); return; }
    entry.consumer = consumer;
    consumer.on('trackended', () => {
      if (selected()) this.fail(new Error('The screen consumer track ended unexpectedly.'));
    });
    this.options.onTrack(consumer.track, consumer.rtpReceiver);
    await this.pauseConsumer(consumer, producer.kind === 'audio' && this.muted);
  }

  private async pauseConsumer(consumer: SfuTypes.Consumer, paused: boolean): Promise<void> {
    if (paused) consumer.pause();
    const { call, rpc } = this.options;
    const response = await rpc<{ channelId: string; consumerId: string; paused: boolean }>(
      MessageType.SFU_CONSUMER_SET_PAUSED, { channelId: call.channelId, consumerId: consumer.id, paused });
    if (response.channelId !== call.channelId || response.consumerId !== consumer.id || response.paused !== paused)
      throw new Error('The screen pause acknowledgement changed its consumer or state.');
    if (!this.stopping && !consumer.closed && !paused) consumer.resume();
  }

  private async closeConsumer(consumerId: string): Promise<void> {
    const { call, rpc } = this.options;
    const response = await rpc<{ channelId: string; consumerId: string }>(MessageType.SFU_CONSUMER_CLOSED,
      { channelId: call.channelId, consumerId });
    if (response.channelId !== call.channelId || response.consumerId !== consumerId)
      throw new Error('Screen cleanup acknowledged another consumer.');
    this.serverConsumers.delete(consumerId);
  }

  public removeProducer(producerId: string): Promise<void> {
    const producer = this.producers.get(producerId);
    this.producers.delete(producerId);
    producer?.consumer?.close();
    return producer?.consumer ? this.closeConsumer(producer.consumer.id) : Promise.resolve();
  }

  public setMuted(muted: boolean): Promise<void> {
    if (this.muted === muted || this.stopping) return Promise.resolve();
    this.muted = muted;
    const work = this.queue.then(async () => {
      if (this.stopping) return;
      for (const entry of this.producers.values())
        if (entry.value.kind === 'audio' && entry.consumer) await this.pauseConsumer(entry.consumer, this.muted);
    });
    this.queue = work.catch(error => this.fail(error));
    return work;
  }

  public async stats(): Promise<RTCStatsReport | null> {
    const video = [...this.producers.values()].find(entry => entry.value.kind === 'video')?.consumer;
    return video && !video.closed ? video.getStats() : null;
  }

  public close(notify: boolean): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.transport?.close();
    for (const entry of this.producers.values()) entry.consumer?.close();
    this.closing = (async () => {
      await Promise.allSettled([this.opening, this.queue]);
      this.transport?.close();
      for (const entry of this.producers.values()) entry.consumer?.close();
      if (notify && this.serverTransportId) {
        const { call, rpc } = this.options;
        const transportId = this.serverTransportId;
        const response = await rpc<{ channelId: string; transportId: string; purpose: string }>(
          MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, { channelId: call.channelId, transportId, purpose: 'screen' });
        if (response.channelId !== call.channelId || response.transportId !== transportId || response.purpose !== 'screen')
          throw new Error('Screen cleanup acknowledged another transport.');
      }
      this.serverTransportId = null;
      this.serverConsumers.clear();
      this.producers.clear();
      if (this.transport && !this.transport.closed) throw new Error('The browser screen retained its SFU transport.');
    })();
    void this.closing.catch(() => { this.closing = null; });
    return this.closing;
  }
}
