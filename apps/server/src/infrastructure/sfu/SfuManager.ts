import os from 'os';
import net from 'net';
import dgram from 'dgram';
import * as mediasoup from 'mediasoup';
import type { RouterRtpCodecCapability, TransportListenInfo } from 'mediasoup/node/lib/types.js';
import { LIMITS, SCREEN_SHARE_LIMITS, aggregateTransportHealth, VoiceConnectionHealth, type RtcTransportPurpose,
  type SfuMediaAppData, sfuCreateWebRtcTransportSchema, nativeScreenRenditionSchema } from '@monky/shared';
import { getPublicIp } from '../discovery/ServerIpScanner';
import { describeFailure } from '../lifecycle/ServerResourceScope';
import { Logger } from '../logger/Logger';

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
    // The router forwards AV1 without decoding; each receiver still negotiates its own actual level.
    parameters: { profile: 0, tier: 0, 'level-idx': 23 },
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
  // Keep Constrained Baseline first for existing clients, but also negotiate
  // Baseline: some hardware encoders do not advertise the constrained profile.
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42001f',
      'level-asymmetry-allowed': 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d003c',
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
  transportId: string;
  sessionId: string;
  channelId: string;
  kind: 'audio' | 'video';
  appData: SfuMediaAppData;
}

/** What callers outside the manager may read of a producer. */
export type SfuProducerView = Readonly<Pick<SfuProducerRecord, 'sessionId' | 'channelId' | 'kind' | 'appData'>>;

export interface SfuConsumerRecord {
  consumer: mediasoup.types.Consumer;
  transportId: string;
  sessionId: string;
  channelId: string;
  producerId: string;
}

export interface SfuTransportRecord {
  transport: mediasoup.types.WebRtcTransport;
  sessionId: string;
  channelId: string;
  direction: 'send' | 'recv';
  purpose: RtcTransportPurpose;
  screenSessionId?: string;
  healthState?: string;
}

type PendingSfuTransport = Pick<SfuTransportRecord, 'sessionId' | 'channelId' | 'direction' | 'purpose' | 'screenSessionId'> & {
  cancelled: boolean;
};

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

/** Publishing more than a session may, which no client does on its own. */
export class SfuProducerLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SfuProducerLimitError';
  }
}

/**
 * What one session may publish at once in a call: a microphone, a camera and,
 * for each screen, a video and an audio per rendition. Every producer is
 * announced to the room and auto-consumed, so this bounds what one client
 * makes everyone else receive.
 */
const MAX_PRODUCERS_PER_SESSION = 2 + SCREEN_SHARE_LIMITS.maximum * 4 * 2;

/**
 * Wait before starting the worker again once starts keep failing, doubling
 * from the first value up to the second. The worker is started on demand, by
 * the next call request, so this bounds how often a broken host spawns a
 * process however many clients keep retrying.
 */
const WORKER_RETRY_MIN_MS = 2_000;
const WORKER_RETRY_MAX_MS = 30_000;

/**
 * Clients swap devices with replaceTrack and close a producer before making its
 * successor, so a second live one in the same slot of a transport is never
 * legitimate. Each native rendition has a transport of its own.
 */
function producerSlot(transportId: string, appData: SfuMediaAppData): string {
  return 'shareId' in appData ? `${transportId}:${appData.mediaType}:${appData.shareId}` : `${transportId}:${appData.mediaType}`;
}

function isScreenMedia(appData: SfuMediaAppData): boolean {
  return appData.mediaType === 'screen_video' || appData.mediaType === 'screen_audio';
}

export class SfuManager {
  private healthListener?: (sessionId: string, channelId: string, health: VoiceConnectionHealth) => void;

  public setHealthListener(listener: (sessionId: string, channelId: string, health: VoiceConnectionHealth) => void): void {
    this.healthListener = listener;
  }

  public getConnectionHealth(
    sessionId: string, channelId: string, purpose: RtcTransportPurpose = 'call'
  ): VoiceConnectionHealth {
    return aggregateTransportHealth(Array.from(this.transports.values())
      .filter((r) => r.sessionId === sessionId && r.channelId === channelId && r.purpose === purpose)
      .map((r) => r.healthState ?? 'new'));
  }

  /**
   * Whether the session's call transports exist but nothing was ever negotiated
   * on them. Mediasoup only starts ICE/DTLS on the first produce or consume, so
   * such transports stay `new` and carry no media in either direction.
   */
  public isCallIdle(sessionId: string, channelId: string): boolean {
    const transportIds = new Set<string>();
    for (const [id, record] of this.transports) {
      if (record.sessionId !== sessionId || record.channelId !== channelId || record.purpose !== 'call') continue;
      if ((record.healthState ?? 'new') !== 'new') return false;
      transportIds.add(id);
    }
    if (transportIds.size === 0) return false;
    for (const producer of this.producers.values()) if (transportIds.has(producer.transportId)) return false;
    for (const consumer of this.consumers.values()) if (transportIds.has(consumer.transportId)) return false;
    return true;
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
    if (record.purpose === 'call') {
      this.healthListener?.(record.sessionId, record.channelId, this.getConnectionHealth(record.sessionId, record.channelId));
    }
  }

  private cancelPendingTransports(matches: (pending: PendingSfuTransport) => boolean): void {
    for (const pending of this.pendingTransports) {
      if (matches(pending)) pending.cancelled = true;
    }
  }

  private worker: mediasoup.types.Worker | null = null;
  /** Monotonic time the current worker came up: tells a crash loop from a one-off death. */
  private workerStartedAt = 0;
  private routers: Map<string, mediasoup.types.Router> = new Map(); // key = channelId
  /** Routers being created: concurrent first requests for a channel must share one. */
  private readonly routerCreations = new Map<string, Promise<mediasoup.types.Router>>();
  private transports: Map<string, SfuTransportRecord> = new Map(); // key = transportId
  private readonly pendingTransports = new Set<PendingSfuTransport>();
  private producers: Map<string, SfuProducerRecord> = new Map(); // key = producerId
  private consumers: Map<string, SfuConsumerRecord> = new Map(); // key = consumerId

  private startup: Promise<boolean> | null = null;
  /** Failed starts and young deaths in a row; the next start waits longer for each. */
  private workerFailures = 0;
  /** Monotonic time before which a failed or dead worker is not started again on demand. */
  private retryAt = 0;
  private initializationError: string | null = null;
  private generation = 0;
  private readonly retiringWorkers = new Set<mediasoup.types.Worker>();
  private workerLostListener?: () => void;

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

  /** Called once the worker died and everything it carried was forgotten. */
  public setWorkerLostListener(listener: () => void): void {
    this.workerLostListener = listener;
  }

  /**
   * Starts the mediasoup worker unless it is running or already starting.
   *
   * A worker that failed to start or died is started again on demand: by the
   * next call request, whoever makes it. Starts that keep failing wait longer
   * each time (see WORKER_RETRY_MIN_MS), so a broken host does not spawn a
   * process per request; `retryNow` is for an operator's explicit action.
   */
  public init(options: { retryNow?: boolean } = {}): Promise<boolean> {
    if (this.isReady()) return Promise.resolve(true);
    if (this.startup) return this.startup;
    if (!options.retryNow && performance.now() < this.retryAt) return Promise.resolve(false);
    const attempt = this.initializeWorker(this.generation);
    this.startup = attempt;
    const settled = () => { if (this.startup === attempt) this.startup = null; };
    void attempt.then(settled, settled);
    return attempt;
  }

  private async initializeWorker(generation: number): Promise<boolean> {
    let worker: mediasoup.types.Worker | null = null;
    try {
      if (!this.announcedIp && !this.detectedPublicIp) {
        getPublicIp().then((ip) => {
          if (ip && generation === this.generation) {
            this.detectedPublicIp = ip;
            console.log(`[SFU] Auto-detected public IP for WebRTC candidates: ${ip}`);
          }
        }).catch(() => {});
      }

      const created = await mediasoup.createWorker({
        rtcMinPort: this.rtcMinPort,
        rtcMaxPort: this.rtcMaxPort,
        logLevel: 'warn',
      });
      worker = created;

      if (generation !== this.generation) {
        this.retiringWorkers.add(created);
        created.close();
        this.retiringWorkers.delete(created);
        return false;
      }
      this.worker = created;
      this.workerStartedAt = performance.now();
      created.on('died', (error) => this.workerDied(created, error));

      if (this.initializationError !== null) Logger.info('SFU', 'The mediasoup worker is running again.');
      this.initializationError = null;
      this.retryAt = 0;
      console.log(`[SFU] mediasoup Worker initialized on UDP ports ${this.rtcMinPort}-${this.rtcMaxPort}`);
      return true;
    } catch (error) {
      if (worker && generation !== this.generation) throw error;
      if (generation === this.generation) {
        this.noteWorkerFailure(describeFailure(error));
        Logger.warn('SFU', `Failed to start the mediasoup worker: ${describeFailure(error)}`);
      }
      return false;
    }
  }

  /**
   * The worker crashed or was killed, and every router, transport, producer
   * and consumer went with it. They are forgotten here, the server is told so
   * it can tell the clients, and the next call request starts a new worker:
   * nothing else would ever bring the SFU back short of restarting the server.
   */
  private workerDied(worker: mediasoup.types.Worker, error: Error): void {
    if (this.worker !== worker) return;
    // A worker that served for a while died of something transient: the next
    // request starts another at once. One that keeps dying young backs off.
    if (performance.now() - this.workerStartedAt >= WORKER_RETRY_MAX_MS) this.workerFailures = 0;
    this.noteWorkerFailure(describeFailure(error) || 'Worker died unexpectedly');
    this.generation++;
    this.worker = null;
    this.forgetMedia();
    Logger.error('SFU', 'The mediasoup worker died; SFU calls reconnect once a new one starts.', error);
    this.workerLostListener?.();
  }

  /** A start that failed or a worker that died young: the next start waits longer. */
  private noteWorkerFailure(reason: string): void {
    this.initializationError = reason;
    this.workerFailures++;
    // The first one is retried right away; repeated ones wait 2 s, 4 s, ... 30 s.
    const wait = this.workerFailures === 1 ? 0
      : Math.min(WORKER_RETRY_MAX_MS, WORKER_RETRY_MIN_MS * 2 ** (this.workerFailures - 2));
    this.retryAt = performance.now() + wait;
  }

  /** Drops every record: the worker that owned them is gone or closing. */
  private forgetMedia(): void {
    this.cancelPendingTransports(() => true);
    this.pendingTransports.clear();
    this.routerCreations.clear();
    this.routers.clear();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }

  public isReady(): boolean {
    return this.worker !== null && !this.worker.died;
  }

  public getLastError(): string | null {
    return this.initializationError;
  }

  /**
   * The router of a channel, created on first use. Concurrent first requests
   * share one creation: two routers would split the channel, leaving
   * participants unable to hear each other, and the first one orphaned.
   */
  public getOrCreateRouter(channelId: string): Promise<mediasoup.types.Router> {
    const router = this.routers.get(channelId);
    if (router && !router.closed) return Promise.resolve(router);
    const pending = this.routerCreations.get(channelId);
    if (pending) return pending;
    const creation = this.createRouter(channelId);
    this.routerCreations.set(channelId, creation);
    const settled = () => { if (this.routerCreations.get(channelId) === creation) this.routerCreations.delete(channelId); };
    void creation.then(settled, settled);
    return creation;
  }

  private async createRouter(channelId: string): Promise<mediasoup.types.Router> {
    if (!this.isReady()) await this.init();
    const worker = this.worker;
    if (!worker || worker.died) {
      throw new Error(`SFU worker is not available: ${this.initializationError || 'worker offline'}`);
    }
    const generation = this.generation;
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    // The worker died or the SFU was closed meanwhile: the router belongs to neither.
    if (generation !== this.generation) {
      router.close();
      throw new Error('The SFU worker changed while the router was being created');
    }
    this.routers.set(channelId, router);
    return router;
  }

  /**
   * The address a client used to reach the server, as an ICE candidate: the
   * `Host` of its upgrade request without the brackets an IPv6 literal keeps
   * for URLs, which no ICE agent can parse. Loopback is announced anyway, and
   * an IPv6 address cannot reach sockets bound to IPv4, so neither comes from here.
   */
  private static announceableClientHost(host: string | undefined, listenIp: string): string | undefined {
    if (!host) return undefined;
    const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (!address || address === 'localhost' || address === '127.0.0.1') return undefined;
    if (net.isIPv6(address) && !net.isIPv6(listenIp)) return undefined;
    return address;
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
    const clientHost = SfuManager.announceableClientHost(preferredAnnouncedIp, this.listenIp);
    if (clientHost) {
      addAnnouncedAddress(clientHost);
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
    clientHost?: string,
    purpose: RtcTransportPurpose = 'call',
    screenSessionId?: string
  ): Promise<{
    id: string;
    iceParameters: mediasoup.types.IceParameters;
    iceCandidates: mediasoup.types.IceCandidate[];
    dtlsParameters: mediasoup.types.DtlsParameters;
    sctpParameters?: mediasoup.types.SctpParameters;
  }> {
    sfuCreateWebRtcTransportSchema.parse({ channelId, direction, purpose, screenSessionId });
    // 64 watched sources, every publication with four profiles, and the legacy pair.
    if (purpose === 'screen' && [...this.transports.values(), ...this.pendingTransports]
      .filter(record => record.sessionId === sessionId && record.purpose === 'screen').length
        >= 64 + SCREEN_SHARE_LIMITS.maximum * 4 + 2) {
      throw new Error('Too many screen transports for this voice session');
    }
    const pending: PendingSfuTransport = { sessionId, channelId, direction, purpose, screenSessionId, cancelled: false };
    this.pendingTransports.add(pending);
    let allocated: mediasoup.types.WebRtcTransport | undefined;
    let registered = false;
    try {
      const router = await this.getOrCreateRouter(channelId);
      if (pending.cancelled) throw new Error('Transport creation was cancelled before setup');
      const listenInfos = this.getListenInfos(clientHost);

      const transport = await router.createWebRtcTransport({
        listenInfos,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 2000000,
      });
      allocated = transport;
      if (pending.cancelled || transport.closed) {
        throw new Error('Transport creation was cancelled or closed during setup');
      }

      console.log(`[SFU Server] Created ${purpose}/${direction} transport ${transport.id} for session ${sessionId} in channel ${channelId}`);
      console.log(`[SFU Server] Transport ${transport.id} ICE candidates (${transport.iceCandidates.length}):`, transport.iceCandidates.map((c) => `${c.protocol?.toUpperCase()} ${c.ip || ('address' in c ? c.address : '')}:${c.port}`));

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

      const record: SfuTransportRecord = { transport, sessionId, channelId, direction, purpose, screenSessionId };
      this.transports.set(transport.id, record);
      this.updateTransportHealth(transport.id);
      if (pending.cancelled || transport.closed || this.transports.get(transport.id) !== record) {
        throw new Error('Transport creation was cancelled or closed during registration');
      }
      registered = true;
      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      };
    } finally {
      this.pendingTransports.delete(pending);
      if (allocated && !registered) {
        if (this.transports.get(allocated.id)?.transport === allocated) this.transports.delete(allocated.id);
        allocated.close();
      }
    }
  }

  /** Reaps an allocation abandoned before its response, without touching a newer bot session. */
  public discardPendingTransport(transportId: string): void {
    const record = this.transports.get(transportId);
    if (!record) return;
    this.transports.delete(transportId);
    record.transport.close();
  }

  /**
   * Closes what this session already had for one purpose/direction in a channel,
   * and reports the producers that went with it.
   *
   * Each purpose/screen engine uses one transport per direction, so an earlier
   * one in that same scope is abandoned on replacement — which is what a rejoin
   * does. Nothing on the wire says so: the client's `leave()` is local, and a
   * transport whose ICE never completed never reaches the `dtlsstatechange`
   * that would close it. Without this, a client retrying behind a broken
   * network path piles up two transports per attempt, each holding ports out
   * of the SFU range and worker memory until it leaves the voice channel.
   */
  public closeTransportsFor(
    sessionId: string,
    channelId: string,
    direction: 'send' | 'recv',
    purpose: RtcTransportPurpose = 'call',
    screenSessionId?: string
  ): { closedProducerIds: string[] } {
    this.cancelPendingTransports(pending => pending.sessionId === sessionId && pending.channelId === channelId
      && pending.direction === direction && pending.purpose === purpose && pending.screenSessionId === screenSessionId);
    const staleTransportIds = new Set<string>();
    for (const [id, record] of Array.from(this.transports.entries())) {
      if (record.sessionId === sessionId && record.channelId === channelId
        && record.direction === direction && record.purpose === purpose && record.screenSessionId === screenSessionId) {
        staleTransportIds.add(id);
      }
    }
    if (staleTransportIds.size === 0) return { closedProducerIds: [] };
    return this.closeTransportRecords(staleTransportIds);
  }

  public closeTransport(
    sessionId: string, channelId: string, transportId: string, purpose: RtcTransportPurpose
  ): { closedProducerIds: string[] } | null {
    const record = this.transports.get(transportId);
    if (!record) return { closedProducerIds: [] };
    if (record.sessionId !== sessionId || record.channelId !== channelId || record.purpose !== purpose) return null;
    return this.closeTransportRecords(new Set([transportId]));
  }

  private closeTransportRecords(transportIds: ReadonlySet<string>): { closedProducerIds: string[] } {
    const closedProducerIds: string[] = [];
    for (const id of transportIds) {
      const record = this.transports.get(id);
      if (!record) continue;
      const producers = [...this.producers].filter(([, producer]) => producer.transportId === id);
      const consumers = [...this.consumers].filter(([, consumer]) => consumer.transportId === id);
      console.log(
        `[SFU Server] Closing ${record.purpose}/${record.direction} transport ${id} for session ${record.sessionId} in channel ${record.channelId}`
      );
      record.transport.close();
      this.transports.delete(id);
      for (const [producerId, producer] of producers) {
        if (this.producers.get(producerId) === producer) this.producers.delete(producerId);
        closedProducerIds.push(producerId);
      }
      for (const [consumerId, consumer] of consumers) {
        if (this.consumers.get(consumerId) === consumer) this.consumers.delete(consumerId);
      }
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
    this.cancelPendingTransports(pending => pending.sessionId === sessionId && pending.channelId !== keepChannelId);
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
    appData: SfuMediaAppData;
  }> {
    const list: Array<{
      producerId: string;
      producerSessionId: string;
      kind: 'audio' | 'video';
      appData: SfuMediaAppData;
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

  /**
   * One live producer by id, without walking every producer of the server as
   * `getProducersInChannel` does: access checks run it per consumer (S-VOICE-10).
   */
  public getProducer(producerId: string): SfuProducerView | undefined {
    const record = this.producers.get(producerId);
    return record && !record.producer.closed ? record : undefined;
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
    appData: SfuMediaAppData,
    paused = false
  ): Promise<{ id: string }> {
    const record = this.transports.get(transportId);
    if (!record) {
      throw new Error(`Transport ${transportId} not found`);
    }
    if (!this.ownsTransport(sessionId, channelId, transportId, 'send')) {
      throw new Error('Producer transport does not belong to this voice session');
    }
    if (record.purpose === 'screen' && !isScreenMedia(appData)) {
      throw new Error('Screen transport only accepts screen video and screen audio');
    }
    if ('nativeScreen' in appData && appData.nativeScreen !== undefined) {
      const nativeScreen = nativeScreenRenditionSchema.parse(appData.nativeScreen);
      if (record.purpose !== 'screen' || record.screenSessionId !== nativeScreen.pipelineId || !isScreenMedia(appData)) {
        throw new Error('Native screen media must belong to its own rendition transport');
      }
    }

    this.assertProducerFits(sessionId, channelId, transportId, appData);
    const producer = await record.transport.produce({
      kind,
      rtpParameters,
      appData,
      paused,
    });
    if (this.transports.get(transportId) !== record || record.transport.closed) {
      producer.close();
      throw new Error('Producer transport was closed during setup');
    }
    try {
      this.assertProducerFits(sessionId, channelId, transportId, appData);
    } catch (error) {
      producer.close();
      throw error;
    }

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
      transportId,
      sessionId,
      channelId,
      kind,
      appData,
    });

    return { id: producer.id };
  }

  /** Refuses a producer beyond what one session may publish; see MAX_PRODUCERS_PER_SESSION. */
  private assertProducerFits(sessionId: string, channelId: string, transportId: string, appData: SfuMediaAppData): void {
    const slot = producerSlot(transportId, appData);
    let live = 0;
    for (const record of this.producers.values()) {
      if (record.sessionId !== sessionId || record.channelId !== channelId || record.producer.closed) continue;
      if (producerSlot(record.transportId, record.appData) === slot) {
        throw new SfuProducerLimitError(`This session already publishes ${appData.mediaType} on this transport`);
      }
      live++;
    }
    if (live >= MAX_PRODUCERS_PER_SESSION) throw new SfuProducerLimitError('Too many producers for this voice session');
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
    appData: SfuMediaAppData;
  }> {
    const transportRecord = this.transports.get(transportId);
    if (!transportRecord) {
      throw new Error(`Transport ${transportId} not found`);
    }
    if (!this.ownsTransport(sessionId, channelId, transportId, 'recv')) {
      throw new Error('Consumer transport does not belong to this voice session');
    }

    const producerRecord = this.producers.get(producerId);
    if (!producerRecord || producerRecord.producer.closed) {
      throw new SfuProducerClosedError(producerId);
    }
    if (producerRecord.channelId !== channelId || producerRecord.sessionId === sessionId) {
      throw new Error('Producer is not a remote source in this voice channel');
    }
    if (transportRecord.purpose === 'screen' && !isScreenMedia(producerRecord.appData)) {
      throw new Error('Screen transport only receives screen video and screen audio');
    }
    const channelProducerCount = this.getProducersInChannel(channelId).length;
    const consumerCount = [...this.consumers.values()].filter(record => record.sessionId === sessionId).length;
    if (consumerCount >= Math.max(16, channelProducerCount * 2)) {
      throw new Error('Too many consumers for this voice session');
    }

    const router = await this.getOrCreateRouter(channelId);
    const producerIsGone = () => this.producers.get(producerId) !== producerRecord || producerRecord.producer.closed;
    const transportIsGone = () => this.transports.get(transportId) !== transportRecord || transportRecord.transport.closed;
    if (producerIsGone()) throw new SfuProducerClosedError(producerId);
    if (transportIsGone()) throw new Error('Consumer transport was closed during setup');
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`Cannot consume producer ${producerId} with provided capabilities`);
    }

    let consumer: mediasoup.types.Consumer;
    try {
      consumer = await transportRecord.transport.consume({
        producerId,
        rtpCapabilities,
        paused: isScreenMedia(producerRecord.appData),
      });
    } catch (error) {
      if (producerIsGone()) throw new SfuProducerClosedError(producerId);
      throw error;
    }
    if (producerIsGone()) {
      consumer.close();
      throw new SfuProducerClosedError(producerId);
    }
    if (transportIsGone()) {
      consumer.close();
      throw new Error('Consumer transport was closed during setup');
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
      transportId,
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

  public closeProducerForSession(
    sessionId: string, channelId: string, producerId: string
  ): { closedProducerIds: string[] } | null {
    const record = this.producers.get(producerId);
    if (!record) return { closedProducerIds: [] };
    if (record.sessionId !== sessionId || record.channelId !== channelId) return null;
    this.closeProducer(producerId);
    return { closedProducerIds: [producerId] };
  }

  public discardPendingConsumer(consumerId: string): void {
    const record = this.consumers.get(consumerId);
    if (!record) return;
    this.consumers.delete(consumerId);
    record.consumer.close();
  }

  public ownsTransport(
    sessionId: string, channelId: string, transportId: string, direction?: 'send' | 'recv', purpose?: RtcTransportPurpose
  ): boolean {
    const record = this.transports.get(transportId);
    return !!record && record.sessionId === sessionId && record.channelId === channelId
      && !record.transport.closed && (!direction || record.direction === direction)
      && (!purpose || record.purpose === purpose);
  }

  public ownsProducer(sessionId: string, channelId: string, producerId: string, purpose?: RtcTransportPurpose): boolean {
    const record = this.producers.get(producerId);
    return !!record && record.sessionId === sessionId && record.channelId === channelId
      && (!purpose || this.ownsTransport(sessionId, channelId, record.transportId, 'send', purpose));
  }

  public ownsConsumer(sessionId: string, channelId: string, consumerId: string): boolean {
    const record = this.consumers.get(consumerId);
    return !!record && !record.consumer.closed && record.sessionId === sessionId && record.channelId === channelId;
  }

  public getConsumerProducerId(sessionId: string, channelId: string, consumerId: string): string | undefined {
    const record = this.consumers.get(consumerId);
    return record?.sessionId === sessionId && record.channelId === channelId ? record.producerId : undefined;
  }

  public getScreenViewers(publisherSessionId: string, channelId: string, shareId: string): string[] {
    const viewers = new Set<string>();
    for (const record of this.consumers.values()) {
      if (record.channelId !== channelId || record.consumer.closed || record.consumer.paused) continue;
      const source = this.producers.get(record.producerId);
      if (source && !source.producer.closed && source.channelId === channelId && source.sessionId === publisherSessionId
        && source.kind === 'video' && source.appData.mediaType === 'screen_video' && source.appData.shareId === shareId)
        viewers.add(record.sessionId);
    }
    return [...viewers];
  }

  public revokeConsumers(canReceive: (sessionId: string, channelId: string, producerId: string) => boolean): void {
    for (const [id, record] of this.consumers) {
      if (!canReceive(record.sessionId, record.channelId, record.producerId)) this.discardPendingConsumer(id);
    }
  }

  public async setMicrophonesMuted(sessionId: string, muted: boolean): Promise<void> {
    await Promise.all([...this.producers.values()].filter((record) =>
      record.sessionId === sessionId && record.kind === 'audio' && record.appData.mediaType === 'mic'
    ).map(async (record) => {
      try {
        if (muted) await record.producer.pause();
        else await record.producer.resume();
      } catch (error) {
        if (!record.producer.closed && this.producers.get(record.producer.id) === record) throw error;
      }
    }));
  }

  public closeConsumer(sessionId: string, channelId: string, consumerId: string): boolean {
    const record = this.consumers.get(consumerId);
    // The producer or parent transport may have closed it before this request.
    if (!record) return true;
    if (record.sessionId !== sessionId || record.channelId !== channelId) return false;
    record.consumer.close();
    if (this.consumers.get(consumerId) === record) this.consumers.delete(consumerId);
    return true;
  }

  public async setProducerPaused(sessionId: string, channelId: string, producerId: string, paused: boolean): Promise<void> {
    const record = this.producers.get(producerId);
    if (!record || record.producer.closed) throw new SfuProducerClosedError(producerId);
    if (!this.ownsProducer(sessionId, channelId, producerId, 'screen') || !isScreenMedia(record.appData)) {
      throw new Error('Producer is not owned screen media in this voice session');
    }
    if (paused) await record.producer.pause();
    else await record.producer.resume();
    if (this.producers.get(producerId) !== record || record.producer.closed) {
      record.producer.close();
      throw new SfuProducerClosedError(producerId);
    }
  }

  public async setConsumerPaused(sessionId: string, channelId: string, consumerId: string, paused: boolean): Promise<boolean> {
    const record = this.consumers.get(consumerId);
    if (!record || record.sessionId !== sessionId || record.channelId !== channelId || record.consumer.closed) return false;
    const producer = this.producers.get(record.producerId);
    const retired = () => record.consumer.closed || this.consumers.get(consumerId) !== record ||
      !producer || producer.producer.closed || this.producers.get(record.producerId) !== producer;
    // A worker can retire the consumer before Node receives producerclose.
    if (retired()) return false;
    try {
      if (paused) await record.consumer.pause();
      else await record.consumer.resume();
    } catch (error) {
      if (!retired()) throw error;
      return false;
    }
    // Closing a producer/transport can interleave with a worker response.
    if (retired()) {
      record.consumer.close();
      return false;
    }
    return true;
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
    this.cancelPendingTransports(pending => pending.sessionId === sessionId);
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

  /** Closes everything of a removed channel, its router included, reporting the producers that went with it. */
  public closeChannel(channelId: string): { closedProducerIds: string[] } {
    this.cancelPendingTransports(pending => pending.channelId === channelId);
    const closedProducerIds: string[] = [];
    for (const [id, record] of Array.from(this.producers.entries())) {
      if (record.channelId === channelId) {
        closedProducerIds.push(id);
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
    return { closedProducerIds };
  }

  public close(): void {
    this.generation++;
    this.startup = null;
    // An explicit stop ends any backoff: the next start is a deliberate one.
    this.workerFailures = 0;
    this.retryAt = 0;
    const errors: unknown[] = [];
    for (const router of this.routers.values()) {
      try {
        router.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.forgetMedia();

    if (this.worker) this.retiringWorkers.add(this.worker);
    // A worker whose close failed stays retiring, for the next close to retry.
    this.worker = null;
    for (const worker of this.retiringWorkers) {
      try {
        if (!worker.died) worker.close();
        this.retiringWorkers.delete(worker);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `SFU cleanup failed: ${errors.map(describeFailure).join('; ')}`);
    }
  }
}
