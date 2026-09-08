import os from 'os';
import net from 'net';
import dgram from 'dgram';
import * as mediasoup from 'mediasoup';
import type { RouterRtpCodecCapability, TransportListenInfo } from 'mediasoup/node/lib/types.js';
import { LIMITS, aggregateTransportHealth, VoiceConnectionHealth } from '@monky/shared';
import { getPublicIp } from '../discovery/ServerIpScanner';

const MEDIA_CODECS: RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/AV1',
    clockRate: 90000,
    parameters: {},
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 0,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {},
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
];

export interface SfuManagerOptions {
  rtcMinPort?: number;
  rtcMaxPort?: number;
  announcedIp?: string | null;
  listenIp?: string;
}

export interface SfuProducerRecord {
  producer: mediasoup.types.Producer;
  sessionId: string;
  channelId: string;
  kind: 'audio' | 'video';
  appData: Record<string, any>;
}

export interface SfuConsumerRecord {
  consumer: mediasoup.types.Consumer;
  sessionId: string;
  channelId: string;
  producerId: string;
}

export interface SfuTransportRecord {
  transport: mediasoup.types.WebRtcTransport;
  sessionId: string;
  channelId: string;
  direction: 'send' | 'recv';
  healthState?: string;
}

/**
 * Why the configured UDP range cannot carry media.
 *
 * Structured instead of a message so the CLI and the desktop app can translate
 * it, the same way {@link checkSfuPreflight} reports a missing worker.
 */
export type SfuPortProblem =
  | { code: 'bind-failed'; port: number; minPort: number; maxPort: number }
  | {
      code: 'turn-overlap';
      minPort: number;
      maxPort: number;
      turnMinPort: number;
      turnMaxPort: number;
    };

/**
 * Renders a port problem as the human-readable text carried in the error
 * payload, and in the server log.
 *
 * Portuguese, like the other messages the server sends straight to the client
 * (`ensureRelayCanRun`). The current desktop client translates
 * `SFU_UNAVAILABLE` through its own catalogue and only falls back to this text
 * when it does not recognise the code, so this is what an older client — or
 * any non-desktop consumer — gets to see. The CLI never reads it: it renders
 * the structured `SfuPortProblem` through `t()` instead.
 */
export function describeSfuPortProblem(problem: SfuPortProblem): string {
  if (problem.code === 'turn-overlap') {
    return (
      `O range UDP do SFU (${problem.minPort}-${problem.maxPort}) invade o range de relay do ` +
      `coturn (${problem.turnMinPort}-${problem.turnMaxPort}). Os dois disputariam as mesmas portas. ` +
      'Ajuste o range do SFU para terminar antes de ' + problem.turnMinPort + '.'
    );
  }
  return (
    `A porta ${problem.port}/UDP não pôde ser reservada, então o range ${problem.minPort}-${problem.maxPort} ` +
    'não está utilizável. Libere esse range (UDP) no firewall da VPS e confira se nenhum outro processo o ocupa. ' +
    'Sem essas portas o SFU não consegue transmitir mídia.'
  );
}

export class SfuProducerClosedError extends Error {
  constructor(public readonly producerId: string) {
    super(`Producer ${producerId} is no longer available`);
    this.name = 'SfuProducerClosedError';
  }
}

export class SfuManager {
  private healthListener?: (sessionId: string, channelId: string, health: VoiceConnectionHealth) => void;

  public setHealthListener(listener: (sessionId: string, channelId: string, health: VoiceConnectionHealth) => void): void {
    this.healthListener = listener;
  }

  public getConnectionHealth(sessionId: string, channelId: string): VoiceConnectionHealth {
    return aggregateTransportHealth(Array.from(this.transports.values())
      .filter((r) => r.sessionId === sessionId && r.channelId === channelId)
      .map((r) => r.healthState ?? 'new'));
  }

  private updateTransportHealth(transportId: string): void {
    const record = this.transports.get(transportId);
    if (!record) return;
    const { transport } = record;
    record.healthState = transport.closed || transport.dtlsState === 'failed' || transport.dtlsState === 'closed'
      ? 'failed'
      : transport.iceState === 'disconnected' ? 'disconnected'
      : transport.dtlsState === 'connected' && (transport.iceState === 'connected' || transport.iceState === 'completed')
        ? 'connected'
        : transport.iceState === 'new' && transport.dtlsState === 'new' ? 'new' : 'connecting';
    this.healthListener?.(record.sessionId, record.channelId, this.getConnectionHealth(record.sessionId, record.channelId));
  }
  private worker: mediasoup.types.Worker | null = null;
  private routers: Map<string, mediasoup.types.Router> = new Map(); // key = channelId
  private transports: Map<string, SfuTransportRecord> = new Map(); // key = transportId
  private producers: Map<string, SfuProducerRecord> = new Map(); // key = producerId
  private consumers: Map<string, SfuConsumerRecord> = new Map(); // key = consumerId

  private isInitialized = false;
  private isAvailable = false;
  private initializationError: string | null = null;

  private readonly rtcMinPort: number;
  private readonly rtcMaxPort: number;
  private readonly listenIp: string;
  private announcedIp: string | null = null;
  private detectedPublicIp: string | null = null;

  constructor(options: SfuManagerOptions = {}) {
    this.rtcMinPort = options.rtcMinPort || LIMITS.SFU_DEFAULT_MIN_PORT;
    this.rtcMaxPort = options.rtcMaxPort || LIMITS.SFU_DEFAULT_MAX_PORT;
    this.listenIp = options.listenIp || '0.0.0.0';
    this.announcedIp = options.announcedIp || null;
  }

  public setAnnouncedIp(ip: string | null): void {
    this.announcedIp = ip;
  }

  public getAnnouncedIp(): string | null {
    return this.announcedIp;
  }

  public getPortRange(): { minPort: number; maxPort: number } {
    return { minPort: this.rtcMinPort, maxPort: this.rtcMaxPort };
  }

  /**
   * Checks that the media range can actually be used, mirroring what
   * `CoturnManager.checkPortReachability` does for the relay (#515).
   *
   * Without this the worker starts, reports success and only fails later when a
   * transport tries to allocate a blocked port — by then the call is already
   * degraded and nobody knows why.
   *
   * Only a local bind is attempted: unlike the TURN check there is no fixed
   * port an external service could probe, so a firewall that drops inbound
   * traffic cannot be detected from here. The bind still catches the common
   * cases — a conflicting process or a range the OS refuses.
   */
  public async checkPortAvailability(): Promise<SfuPortProblem | null> {
    const overlap = this.findTurnOverlap();
    if (overlap) return overlap;

    // Sampling: binding ten thousand sockets to prove a range is free would
    // cost more than it tells us. The edges plus the middle catch a range that
    // is entirely unusable, which is what actually happens in practice.
    const span = this.rtcMaxPort - this.rtcMinPort;
    const samplePorts = [
      this.rtcMinPort,
      this.rtcMinPort + Math.floor(span / 2),
      this.rtcMaxPort,
    ];

    for (const port of samplePorts) {
      const bindOk = await SfuManager.probeUdpBind(port, 2000);
      if (!bindOk) {
        return {
          code: 'bind-failed',
          port,
          minPort: this.rtcMinPort,
          maxPort: this.rtcMaxPort,
        };
      }
    }

    return null;
  }

  /**
   * coturn allocates relay ports anywhere in its own range, so an overlap makes
   * the two servers race for the same port once both are enabled.
   */
  private findTurnOverlap(): SfuPortProblem | null {
    const turnMinPort = LIMITS.TURN_RELAY_MIN_PORT;
    const turnMaxPort = LIMITS.TURN_RELAY_MAX_PORT;
    if (this.rtcMinPort > turnMaxPort || this.rtcMaxPort < turnMinPort) {
      return null;
    }
    return {
      code: 'turn-overlap',
      minPort: this.rtcMinPort,
      maxPort: this.rtcMaxPort,
      turnMinPort,
      turnMaxPort,
    };
  }

  /** Binds a UDP socket briefly to prove the port is free. */
  private static probeUdpBind(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        resolve(false);
      }, timeoutMs);

      socket.once('error', () => {
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        resolve(false);
      });

      socket.bind(port, '0.0.0.0', () => {
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        resolve(true);
      });
    });
  }

  public async init(): Promise<boolean> {
    if (this.isInitialized) {
      return this.isAvailable;
    }

    try {
      if (!this.announcedIp && !this.detectedPublicIp) {
        getPublicIp().then((ip) => {
          if (ip) {
            this.detectedPublicIp = ip;
            console.log(`[SFU] Auto-detected public IP for WebRTC candidates: ${ip}`);
          }
        }).catch(() => {});
      }

      this.worker = await mediasoup.createWorker({
        rtcMinPort: this.rtcMinPort,
        rtcMaxPort: this.rtcMaxPort,
        logLevel: 'warn',
      });

      this.worker.on('died', (error) => {
        console.error('[SFU] mediasoup Worker died:', error);
        this.isAvailable = false;
        this.initializationError = error?.message || 'Worker died unexpectedly';
      });

      this.isInitialized = true;
      this.isAvailable = true;
      this.initializationError = null;
      console.log(`[SFU] mediasoup Worker initialized on UDP ports ${this.rtcMinPort}-${this.rtcMaxPort}`);
      return true;
    } catch (err: any) {
      this.isInitialized = true;
      this.isAvailable = false;
      this.initializationError = err?.message || String(err);
      console.warn('[SFU] Failed to start mediasoup worker:', this.initializationError);
      return false;
    }
  }

  public isReady(): boolean {
    return this.isAvailable && this.worker !== null && !this.worker.died;
  }

  public getLastError(): string | null {
    return this.initializationError;
  }

  public async getOrCreateRouter(channelId: string): Promise<mediasoup.types.Router> {
    if (!this.isInitialized) {
      await this.init();
    }
    if (!this.isReady() || !this.worker) {
      throw new Error(`SFU worker is not available: ${this.initializationError || 'worker offline'}`);
    }

    let router = this.routers.get(channelId);
    if (!router || router.closed) {
      router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
      this.routers.set(channelId, router);
    }
    return router;
  }

  private getListenInfos(preferredAnnouncedIp?: string): TransportListenInfo[] {
    const portRange = { min: this.rtcMinPort, max: this.rtcMaxPort };
    const infos: TransportListenInfo[] = [];
    const addedAddresses = new Set<string>();

    const addAnnouncedAddress = (addr: string | null | undefined) => {
      if (!addr) return;
      const trimmed = addr.trim();
      if (!trimmed || addedAddresses.has(trimmed)) return;
      infos.push({
        protocol: 'udp',
        ip: this.listenIp,
        announcedAddress: trimmed,
        portRange,
      });
      infos.push({
        protocol: 'tcp',
        ip: this.listenIp,
        announcedAddress: trimmed,
        portRange,
      });
      addedAddresses.add(trimmed);
    };

    // 1. Explicit announced IP configured by admin
    if (this.announcedIp) {
      addAnnouncedAddress(this.announcedIp);
    }

    // 2. Client connection host / IP (if client reached server via a public IP or domain)
    if (preferredAnnouncedIp && preferredAnnouncedIp !== 'localhost' && preferredAnnouncedIp !== '127.0.0.1') {
      addAnnouncedAddress(preferredAnnouncedIp);
    }

    // 3. Auto-detected server public IP (for cloud VPS behind 1:1 NAT like AWS, Oracle Cloud, GCP, etc.)
    if (this.detectedPublicIp) {
      addAnnouncedAddress(this.detectedPublicIp);
    }

    // 4. Always include 127.0.0.1 for local/loopback clients
    addAnnouncedAddress('127.0.0.1');

    // 5. Detect all available local network interfaces (Radmin VPN 26.x, LAN 192.168.x, 10.x, etc.)
    try {
      const interfaces = os.networkInterfaces();
      for (const [_, ifaceList] of Object.entries(interfaces)) {
        if (!ifaceList) continue;
        for (const iface of ifaceList) {
          const family = String(iface.family);
          if ((family === 'IPv4' || family === '4') && iface.address) {
            addAnnouncedAddress(iface.address);
          }
        }
      }
    } catch {
      // Ignore network interface detection failure
    }

    // Fallback if no valid address was found
    if (infos.length === 0) {
      infos.push({
        protocol: 'udp',
        ip: this.listenIp,
        portRange,
      });
      infos.push({
        protocol: 'tcp',
        ip: this.listenIp,
        portRange,
      });
    }

    return infos;
  }

  public async getRouterRtpCapabilities(channelId: string): Promise<mediasoup.types.RtpCapabilities> {
    const router = await this.getOrCreateRouter(channelId);
    return router.rtpCapabilities;
  }

  public async createWebRtcTransport(
    sessionId: string,
    channelId: string,
    direction: 'send' | 'recv',
    clientHost?: string
  ): Promise<{
    id: string;
    iceParameters: mediasoup.types.IceParameters;
    iceCandidates: mediasoup.types.IceCandidate[];
    dtlsParameters: mediasoup.types.DtlsParameters;
    sctpParameters?: mediasoup.types.SctpParameters;
  }> {
    const router = await this.getOrCreateRouter(channelId);
    const listenInfos = this.getListenInfos(clientHost);

    const transport = await router.createWebRtcTransport({
      listenInfos,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 2000000,
    });

    console.log(`[SFU Server] Created ${direction} transport ${transport.id} for session ${sessionId} in channel ${channelId}`);
    console.log(`[SFU Server] Transport ${transport.id} ICE candidates (${transport.iceCandidates.length}):`, transport.iceCandidates.map((c) => `${c.protocol?.toUpperCase()} ${c.ip || (c as any).address}:${c.port}`));

    transport.on('icestatechange', (iceState) => {
      console.log(`[SFU Server] Transport ${transport.id} (${direction}, session ${sessionId}) ICE state changed: ${iceState}`);
      this.updateTransportHealth(transport.id);
    });

    transport.on('dtlsstatechange', (dtlsState) => {
      console.log(`[SFU Server] Transport ${transport.id} (${direction}, session ${sessionId}) DTLS state changed: ${dtlsState}`);
      this.updateTransportHealth(transport.id);
      if (dtlsState === 'failed' || dtlsState === 'closed') {
        transport.close();
      }
    });

    transport.on('@close', () => {
      console.log(`[SFU Server] Transport ${transport.id} closed`);
      // Keep the failed direction until replacement/leave; forgetting it would
      // let the opposite transport falsely report the whole session healthy.
      this.updateTransportHealth(transport.id);
    });
    transport.on('routerclose', () => this.updateTransportHealth(transport.id));

    this.transports.set(transport.id, {
      transport,
      sessionId,
      channelId,
      direction,
    });
    this.updateTransportHealth(transport.id);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  /**
   * Closes whatever this session already had for one direction in a channel,
   * and reports the producers that went with it.
   *
   * A client only ever uses one transport per direction, so an earlier one is
   * abandoned by definition once it asks for another — which is what a rejoin
   * does. Nothing on the wire says so: the client's `leave()` is local, and a
   * transport whose ICE never completed never reaches the `dtlsstatechange`
   * that would close it. Without this, a client retrying behind a broken
   * network path piles up two transports per attempt, each holding ports out
   * of the SFU range and worker memory until it leaves the voice channel.
   */
  public closeTransportsFor(
    sessionId: string,
    channelId: string,
    direction: 'send' | 'recv'
  ): { closedProducerIds: string[] } {
    const staleTransportIds = new Set<string>();
    for (const [id, record] of Array.from(this.transports.entries())) {
      if (record.sessionId === sessionId && record.channelId === channelId && record.direction === direction) {
        staleTransportIds.add(id);
      }
    }
    if (staleTransportIds.size === 0) return { closedProducerIds: [] };

    // Closing a transport closes its producers and consumers in mediasoup, but
    // our own bookkeeping is not notified — leaving entries behind that other
    // participants would still be told to consume. A session's producers live
    // on its send transport and its consumers on its recv one, and this runs
    // before the replacement exists, so everything it has for this direction
    // in this channel belongs to the transports being dropped.
    const closedProducerIds: string[] = [];
    if (direction === 'send') {
      for (const [id, record] of Array.from(this.producers.entries())) {
        if (record.sessionId === sessionId && record.channelId === channelId) {
          closedProducerIds.push(id);
          this.producers.delete(id);
        }
      }
    } else {
      for (const [id, record] of Array.from(this.consumers.entries())) {
        if (record.sessionId === sessionId && record.channelId === channelId) {
          this.consumers.delete(id);
        }
      }
    }

    for (const id of staleTransportIds) {
      const record = this.transports.get(id);
      if (!record) continue;
      console.log(
        `[SFU Server] Replacing abandoned ${direction} transport ${id} for session ${sessionId} in channel ${channelId}`
      );
      try {
        record.transport.close();
      } catch {}
      this.transports.delete(id);
    }

    return { closedProducerIds };
  }

  /**
   * Closes everything a session still holds in channels other than the one it
   * is joining, reporting the producers that went with it.
   *
   * Switching voice channels on the same server never sends a `VOICE_LEAVE`,
   * and the client's own teardown is local, so without this the transports of
   * the channel just left keep their port pairs until the socket drops.
   */
  public closeSessionExcept(
    sessionId: string,
    keepChannelId: string
  ): { closedProducerIds: Array<{ channelId: string; producerId: string }> } {
    const closedProducerIds: Array<{ channelId: string; producerId: string }> = [];

    for (const [id, record] of Array.from(this.producers.entries())) {
      if (record.sessionId === sessionId && record.channelId !== keepChannelId) {
        closedProducerIds.push({ channelId: record.channelId, producerId: id });
        record.producer.close();
        this.producers.delete(id);
      }
    }

    for (const [id, record] of Array.from(this.consumers.entries())) {
      if (record.sessionId === sessionId && record.channelId !== keepChannelId) {
        record.consumer.close();
        this.consumers.delete(id);
      }
    }

    for (const [id, record] of Array.from(this.transports.entries())) {
      if (record.sessionId === sessionId && record.channelId !== keepChannelId) {
        try {
          record.transport.close();
        } catch {}
        this.transports.delete(id);
      }
    }

    return { closedProducerIds };
  }

  public getProducersInChannel(channelId: string): Array<{
    producerId: string;
    producerSessionId: string;
    kind: 'audio' | 'video';
    appData: Record<string, any>;
  }> {
    const list: Array<{
      producerId: string;
      producerSessionId: string;
      kind: 'audio' | 'video';
      appData: Record<string, any>;
    }> = [];

    for (const [producerId, p] of this.producers.entries()) {
      if (p.channelId === channelId && !p.producer.closed) {
        list.push({
          producerId,
          producerSessionId: p.sessionId,
          kind: p.kind,
          appData: p.appData,
        });
      }
    }

    return list;
  }

  public async connectWebRtcTransport(
    transportId: string,
    dtlsParameters: mediasoup.types.DtlsParameters
  ): Promise<void> {
    const record = this.transports.get(transportId);
    if (!record) {
      throw new Error(`Transport ${transportId} not found`);
    }
    console.log(`[SFU Server] Connecting transport ${transportId} (session ${record.sessionId}, ${record.direction}) with DTLS role ${dtlsParameters.role}`);
    await record.transport.connect({ dtlsParameters });
    console.log(`[SFU Server] Transport ${transportId} connect resolved successfully`);
  }

  public async produce(
    sessionId: string,
    channelId: string,
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: mediasoup.types.RtpParameters,
    appData: Record<string, any> = {}
  ): Promise<{ id: string }> {
    const record = this.transports.get(transportId);
    if (!record) {
      throw new Error(`Transport ${transportId} not found`);
    }

    const producer = await record.transport.produce({
      kind,
      rtpParameters,
      appData,
    });

    console.log(`[SFU Server] Producer created ${producer.id} (${kind}, mediaType: ${appData?.mediaType || 'unknown'}) on transport ${transportId} for session ${sessionId}`);

    producer.on('transportclose', () => {
      console.log(`[SFU Server] Producer ${producer.id} closed (transport closed)`);
      this.producers.delete(producer.id);
    });

    producer.on('@close', () => {
      console.log(`[SFU Server] Producer ${producer.id} closed`);
      this.producers.delete(producer.id);
    });

    this.producers.set(producer.id, {
      producer,
      sessionId,
      channelId,
      kind,
      appData,
    });

    return { id: producer.id };
  }

  public async consume(
    sessionId: string,
    channelId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities
  ): Promise<{
    id: string;
    producerId: string;
    kind: 'audio' | 'video';
    rtpParameters: mediasoup.types.RtpParameters;
    producerSessionId: string;
    appData: Record<string, any>;
  }> {
    const transportRecord = this.transports.get(transportId);
    if (!transportRecord) {
      throw new Error(`Transport ${transportId} not found`);
    }

    const producerRecord = this.producers.get(producerId);
    if (!producerRecord || producerRecord.producer.closed) {
      throw new SfuProducerClosedError(producerId);
    }

    const router = await this.getOrCreateRouter(channelId);
    const producerIsGone = () => this.producers.get(producerId) !== producerRecord || producerRecord.producer.closed;
    if (producerIsGone()) throw new SfuProducerClosedError(producerId);
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`Cannot consume producer ${producerId} with provided capabilities`);
    }

    let consumer: mediasoup.types.Consumer;
    try {
      consumer = await transportRecord.transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });
    } catch (error) {
      if (producerIsGone()) throw new SfuProducerClosedError(producerId);
      throw error;
    }
    if (producerIsGone()) {
      consumer.close();
      throw new SfuProducerClosedError(producerId);
    }

    console.log(`[SFU Server] Consumer created ${consumer.id} (${consumer.kind}) for session ${sessionId} consuming producer ${producerId} (owner: ${producerRecord.sessionId}, type: ${producerRecord.appData?.mediaType})`);

    consumer.on('transportclose', () => {
      console.log(`[SFU Server] Consumer ${consumer.id} closed (transport closed)`);
      this.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      console.log(`[SFU Server] Consumer ${consumer.id} closed (producer closed)`);
      this.consumers.delete(consumer.id);
    });

    consumer.on('@close', () => {
      console.log(`[SFU Server] Consumer ${consumer.id} closed`);
      this.consumers.delete(consumer.id);
    });

    this.consumers.set(consumer.id, {
      consumer,
      sessionId,
      channelId,
      producerId,
    });

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind as 'audio' | 'video',
      rtpParameters: consumer.rtpParameters,
      producerSessionId: producerRecord.sessionId,
      appData: producerRecord.appData,
    };
  }

  public closeProducer(producerId: string): void {
    const record = this.producers.get(producerId);
    if (record) {
      record.producer.close();
      this.producers.delete(producerId);
    }
  }

  public async setConsumerPaused(consumerId: string, paused: boolean): Promise<void> {
    const record = this.consumers.get(consumerId);
    if (!record) return;
    if (paused) {
      await record.consumer.pause();
    } else {
      await record.consumer.resume();
    }
  }

  public getProducersForChannel(channelId: string, excludeSessionId?: string): SfuProducerRecord[] {
    const list: SfuProducerRecord[] = [];
    for (const record of this.producers.values()) {
      if (record.channelId === channelId) {
        if (!excludeSessionId || record.sessionId !== excludeSessionId) {
          list.push(record);
        }
      }
    }
    return list;
  }

  public closeSession(sessionId: string): { closedProducerIds: string[] } {
    const closedProducerIds: string[] = [];

    // Close producers for session
    for (const [id, record] of Array.from(this.producers.entries())) {
      if (record.sessionId === sessionId) {
        closedProducerIds.push(id);
        record.producer.close();
        this.producers.delete(id);
      }
    }

    // Close consumers for session
    for (const [id, record] of Array.from(this.consumers.entries())) {
      if (record.sessionId === sessionId) {
        record.consumer.close();
        this.consumers.delete(id);
      }
    }

    // Close transports for session
    for (const [id, record] of Array.from(this.transports.entries())) {
      if (record.sessionId === sessionId) {
        record.transport.close();
        this.transports.delete(id);
      }
    }

    return { closedProducerIds };
  }

  public closeChannel(channelId: string): void {
    for (const [id, record] of Array.from(this.producers.entries())) {
      if (record.channelId === channelId) {
        record.producer.close();
        this.producers.delete(id);
      }
    }

    for (const [id, record] of Array.from(this.consumers.entries())) {
      if (record.channelId === channelId) {
        record.consumer.close();
        this.consumers.delete(id);
      }
    }

    for (const [id, record] of Array.from(this.transports.entries())) {
      if (record.channelId === channelId) {
        record.transport.close();
        this.transports.delete(id);
      }
    }

    const router = this.routers.get(channelId);
    if (router) {
      router.close();
      this.routers.delete(channelId);
    }
  }

  public close(): void {
    for (const router of this.routers.values()) {
      router.close();
    }
    this.routers.clear();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();

    if (this.worker && !this.worker.died) {
      this.worker.close();
    }
    this.worker = null;
    this.isInitialized = false;
    this.isAvailable = false;
  }
}
