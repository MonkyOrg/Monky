export interface HostedServerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HostedServerTarget {
  port: number;
  serverId?: string;
}

export interface HostedServerEntry {
  port: number;
  serverId: string | null;
}

export class HostedServerConflictError extends Error {
  /**
   * `port`: another hosted server already listens on the requested port.
   * `identity`: the same server (same data folder) already runs on another port.
   */
  constructor(public readonly reason: 'port' | 'identity', public readonly port: number) {
    super('HOSTED_SERVER_ALREADY_RUNNING');
    this.name = 'HostedServerConflictError';
  }
}

export class HostedServerCleanupError extends Error {
  constructor(
    public readonly startError: unknown,
    public readonly stopError: unknown,
  ) {
    super('HOSTED_SERVER_START_CLEANUP_FAILED', { cause: startError });
    this.name = 'HostedServerCleanupError';
  }
}

interface ActiveServer<Server> {
  server: Server;
  port: number;
  serverId: string | null;
  ready: boolean;
}

/**
 * Every server hosted by this app, keyed by port. Starts and stops still run
 * one at a time: two servers may share the process, but never a data folder
 * or a port, and a half-finished start must not race the next decision.
 */
export class HostedServerLifecycle<Server extends HostedServerRuntime, Options extends HostedServerTarget> {
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Map<number, ActiveServer<Server>>();

  constructor(
    private readonly createServer: (options: Options) => Promise<Server>,
    private readonly onChange: () => void,
  ) {}

  public runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // Return the original rejection to its caller without poisoning later work.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public start(options: Options): Promise<void> {
    const target = { ...options };
    return this.runExclusive(async () => {
      const serverId = target.serverId ?? null;
      const onPort = this.active.get(target.port);
      if (onPort) {
        // An absent id owns the legacy flat directory, not any named server's
        // directory. Matching only the port must never relabel that data.
        if (onPort.ready && onPort.serverId === serverId) return;
        throw new HostedServerConflictError('port', target.port);
      }
      const sameData = [...this.active.values()].find((entry) => entry.serverId === serverId);
      if (sameData) throw new HostedServerConflictError('identity', sameData.port);

      const server = await this.createServer(target);
      try {
        await server.start();
      } catch (startError) {
        try {
          await server.stop();
        } catch (stopError) {
          // Failed cleanup still owns resources. Keep an explicit stop possible,
          // but do not acknowledge a duplicate start as a healthy instance.
          this.active.set(target.port, { server, port: target.port, serverId, ready: false });
          this.onChange();
          throw new HostedServerCleanupError(startError, stopError);
        }
        throw startError;
      }

      this.active.set(target.port, { server, port: target.port, serverId, ready: true });
      this.onChange();
    });
  }

  public stop(port: number): Promise<void> {
    return this.runExclusive(async () => {
      const entry = this.active.get(port);
      if (!entry) return;
      entry.ready = false;
      await entry.server.stop();
      this.active.delete(port);
      this.onChange();
    });
  }

  /** Stops everything, e.g. on quit. Every server is attempted even if one fails. */
  public stopAll(): Promise<void> {
    return this.runExclusive(async () => {
      const failures: unknown[] = [];
      for (const entry of [...this.active.values()]) {
        entry.ready = false;
        try {
          await entry.server.stop();
          this.active.delete(entry.port);
        } catch (error) {
          failures.push(error);
        }
      }
      this.onChange();
      if (failures.length) throw failures[0];
    });
  }

  public getServer(port: number): Server | null {
    return this.active.get(port)?.server ?? null;
  }

  public entries(): Array<HostedServerEntry & { server: Server }> {
    return [...this.active.values()]
      .sort((a, b) => a.port - b.port)
      .map(({ server, port, serverId }) => ({ server, port, serverId }));
  }

  public getStatus(): { servers: HostedServerEntry[] } {
    return { servers: this.entries().map(({ port, serverId }) => ({ port, serverId })) };
  }
}