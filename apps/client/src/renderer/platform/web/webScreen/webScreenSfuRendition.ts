import { Device, type types as SfuTypes } from 'mediasoup-client';
import { MessageType, type ScreenFormat, type NativeScreenRendition } from '@monky/shared';
import { isScreenCodec } from './browserScreenProfile';

export type WebScreenRpc = (method: MessageType, payload: Record<string, unknown>) => Promise<unknown>;

export interface WebScreenSfuRenditionOptions {
  readonly channelId: string;
  readonly shareId: string;
  readonly format: ScreenFormat;
  readonly rendition: NativeScreenRendition;
  readonly video: MediaStreamTrack;
  readonly audio: MediaStreamTrack | null;
  readonly audioBitrateBps: number;
  readonly rpc: WebScreenRpc;
  readonly onError: (error: unknown) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isRtpCapabilities = (value: unknown): value is SfuTypes.RtpCapabilities =>
  isRecord(value) && (value.codecs === undefined || Array.isArray(value.codecs))
  && (value.headerExtensions === undefined || Array.isArray(value.headerExtensions));
const isTransportOptions = (value: unknown): value is SfuTypes.TransportOptions =>
  isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && isRecord(value.iceParameters)
  && Array.isArray(value.iceCandidates) && isRecord(value.dtlsParameters);

/**
 * One rendition of a browser screen on the server's SFU (#858), as the native SFU broker publishes it: its
 * own screen transport named after the rendition's pipeline, a video producer and, when the screen has sound,
 * an audio producer, both carrying the rendition so viewers consume the profile they asked for.
 */
export class WebScreenSfuRendition {
  public readonly ready: Promise<void>;
  private readonly device = new Device();
  private readonly producers: SfuTypes.Producer[] = [];
  private transport: SfuTypes.Transport | null = null;
  private serverTransportId: string | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: WebScreenSfuRenditionOptions) {
    this.ready = this.open();
    void this.ready.catch(() => {});
  }

  private current(): void {
    if (this.stopping) throw new DOMException('The screen rendition was retired.', 'AbortError');
  }

  private fail(error: unknown): void {
    if (!this.stopping) this.options.onError(error);
  }

  private async open(): Promise<void> {
    const { channelId, rpc, rendition } = this.options;
    const router = await rpc(MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES, { channelId });
    this.current();
    if (!isRecord(router) || router.channelId !== channelId || !isRtpCapabilities(router.rtpCapabilities))
      throw new Error('The screen router capabilities belong to another channel.');
    await this.device.load({ routerRtpCapabilities: router.rtpCapabilities });
    this.current();
    const { format } = this.options;
    const codec = this.device.rtpCapabilities.codecs?.find(value => value.kind === 'video' && isScreenCodec({
      mimeType: value.mimeType,
      sdpFmtpLine: Object.entries(value.parameters ?? {}).map(([key, parameter]) => `${key}=${String(parameter)}`).join(';'),
    }, format));
    if (!codec || !this.device.canProduce('video')) throw new Error(`The server and this browser share no ${format} screen codec.`);
    const created = await rpc(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, {
      channelId, direction: 'send', purpose: 'screen', screenSessionId: rendition.pipelineId,
    });
    if (!isRecord(created) || !isTransportOptions(created.transportOptions))
      throw new Error('The screen server did not describe its new transport.');
    // A late reply is still retired by close().
    this.serverTransportId = created.transportOptions.id;
    this.current();
    if (created.channelId !== channelId || created.direction !== 'send' || created.purpose !== 'screen'
      || created.screenSessionId !== rendition.pipelineId)
      throw new Error('The screen transport changed its authorized scope.');
    const transport = this.transport = this.device.createSendTransport(created.transportOptions);
    transport.on('connect', ({ dtlsParameters }, resolve, reject) => {
      if (this.stopping) { reject(new Error('The screen transport was retired.')); return; }
      void rpc(MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, { channelId, transportId: transport.id, dtlsParameters })
        .then(response => {
          this.current();
          if (!isRecord(response) || response.channelId !== channelId || response.transportId !== transport.id)
            throw new Error('Screen DTLS acknowledged another transport.');
          resolve();
        }).catch(error => reject(error instanceof Error ? error : new Error(String(error))));
    });
    transport.on('produce', ({ kind, rtpParameters, appData }, resolve, reject) => {
      if (this.stopping) { reject(new Error('The screen transport was retired.')); return; }
      void rpc(MessageType.SFU_PRODUCE, { channelId, transportId: transport.id, kind, rtpParameters, appData })
        .then(response => {
          if (!isRecord(response) || response.channelId !== channelId || typeof response.id !== 'string' || !response.id)
            throw new Error('The screen producer was acknowledged for another channel.');
          resolve({ id: response.id });
        }).catch(error => reject(error instanceof Error ? error : new Error(String(error))));
    });
    transport.on('connectionstatechange', state => {
      if (this.stopping) return;
      if (state === 'failed' || state === 'closed') this.fail(new Error('The screen SFU connection failed.'));
      if (state === 'disconnected' && !this.disconnectedTimer)
        this.disconnectedTimer = setTimeout(() => this.fail(new Error('The screen SFU did not reconnect.')), 10000);
      if (state === 'connected' && this.disconnectedTimer) {
        clearTimeout(this.disconnectedTimer);
        this.disconnectedTimer = null;
      }
    });
    const { shareId, video, audio, audioBitrateBps } = this.options;
    this.producers.push(await transport.produce({
      track: video, codec, stopTracks: false,
      encodings: [{ maxBitrate: rendition.video.maxBitrateKbps * 1000, maxFramerate: rendition.video.fps }],
      codecOptions: { videoGoogleStartBitrate: Math.min(5000, rendition.video.maxBitrateKbps) },
      appData: { mediaType: 'screen_video', shareId, nativeScreen: rendition },
    }));
    this.current();
    if (audio) {
      this.producers.push(await transport.produce({
        track: audio, stopTracks: false, encodings: [{ maxBitrate: audioBitrateBps }],
        codecOptions: { opusStereo: true, opusMaxAverageBitrate: audioBitrateBps },
        appData: { mediaType: 'screen_audio', shareId, nativeScreen: rendition },
      }));
      this.current();
    }
  }

  public stats(): Promise<RTCStatsReport | null> {
    const video = this.producers[0];
    return video && !video.closed ? video.getStats() : Promise.resolve(null);
  }

  /** Retires the producers and the transport, here and on the server. */
  public close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.closing = (async () => {
      await Promise.allSettled([this.ready]);
      const { channelId, rpc } = this.options;
      const results = await Promise.allSettled(this.producers.map(async producer => {
        const producerId = producer.id;
        producer.close();
        const response = await rpc(MessageType.SFU_PRODUCER_CLOSED, { channelId, producerId });
        if (!isRecord(response) || response.channelId !== channelId || response.producerId !== producerId)
          throw new Error('Screen cleanup acknowledged another producer.');
      }));
      this.producers.length = 0;
      this.transport?.close();
      const transportId = this.serverTransportId;
      this.serverTransportId = null;
      if (transportId) {
        const response = await rpc(MessageType.SFU_CLOSE_WEBRTC_TRANSPORT, { channelId, transportId, purpose: 'screen' });
        if (!isRecord(response) || response.channelId !== channelId || response.transportId !== transportId)
          throw new Error('Screen cleanup acknowledged another transport.');
      }
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'The screen producers did not retire cleanly.');
    })();
    return this.closing;
  }
}
