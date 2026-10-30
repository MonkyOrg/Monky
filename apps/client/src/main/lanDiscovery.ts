import dgram from 'dgram';
import type { DiscoveredLanServer, IpcEventChannel } from '@monky/shared';

const DEFAULT_DISCOVERY_PORT = 41234;
const ANNOUNCEMENT_TYPE = 'monky-announce';
const SERVER_TTL_MS = 10000;
const PRUNE_INTERVAL_MS = 1000;

/** What the renderer hears about a server announced on the local network. */
export type LanDiscoveryEvent = Extract<IpcEventChannel, 'lan:found' | 'lan:lost'>;

interface DiscoveredLanServerEntry extends DiscoveredLanServer {
  lastSeen: number;
}

interface DiscoveryMessage {
  type?: string;
  serverName?: string;
  port?: number;
  version?: string;
}

export class LanDiscovery {
  private readonly discoveryPort: number;
  private socket: dgram.Socket | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly servers = new Map<string, DiscoveredLanServerEntry>();
  private isStarted = false;

  constructor(
    private readonly notify: (event: LanDiscoveryEvent, server: DiscoveredLanServer) => void,
    discoveryPort = DEFAULT_DISCOVERY_PORT,
  ) {
    this.discoveryPort = discoveryPort;
  }

  public async start(): Promise<void> {
    if (this.isStarted) return;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const handleError = (error: Error) => {
          socket.off('listening', handleListening);
          reject(error);
        };
        const handleListening = () => {
          socket.off('error', handleError);
          resolve();
        };

        socket.once('error', handleError);
        socket.once('listening', handleListening);
        socket.bind(this.discoveryPort, '0.0.0.0');
      });
    } catch {
      try {
        socket.close();
      } catch {}
      return;
    }

    this.socket = socket;
    this.isStarted = true;

    socket.on('message', (message, remote) => {
      this.handleMessage(message, remote.address);
    });

    socket.on('error', () => {});

    this.pruneTimer = setInterval(() => this.pruneExpiredServers(), PRUNE_INTERVAL_MS);
  }

  public async stop(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    this.servers.clear();

    const socket = this.socket;
    this.socket = null;
    this.isStarted = false;

    if (!socket) return;

    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private handleMessage(message: Buffer, host: string): void {
    let parsed: DiscoveryMessage;
    try {
      parsed = JSON.parse(message.toString('utf8')) as DiscoveryMessage;
    } catch {
      return;
    }

    if (
      parsed.type !== ANNOUNCEMENT_TYPE ||
      typeof parsed.serverName !== 'string' ||
      typeof parsed.port !== 'number' ||
      parsed.port < 1 ||
      parsed.port > 65535
    ) {
      return;
    }

    const server: DiscoveredLanServerEntry = {
      host,
      port: parsed.port,
      serverName: parsed.serverName,
      version: typeof parsed.version === 'string' ? parsed.version : '1.0',
      lastSeen: Date.now(),
    };

    const key = this.getKey(server.host, server.port);
    const existing = this.servers.get(key);
    const isNew =
      !existing ||
      existing.serverName !== server.serverName ||
      existing.version !== server.version;

    this.servers.set(key, server);
    if (isNew) {
      this.notify('lan:found', server);
    }
  }

  private pruneExpiredServers(): void {
    const cutoff = Date.now() - SERVER_TTL_MS;
    for (const [key, server] of this.servers.entries()) {
      if (server.lastSeen > cutoff) continue;
      this.servers.delete(key);
      this.notify('lan:lost', server);
    }
  }

  private getKey(host: string, port: number): string {
    return `${host}:${port}`;
  }
}
