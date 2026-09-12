export interface HostedServerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HostedServerTarget {
  port: number;
  serverId?: string;
}

export interface HostedServerStatus {
  isRunning: boolean;
  port: number | null;
  serverId: string | null;
}

export class HostedServerConflictError extends Error {
  constructor() {
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

export class HostedServerLifecycle<Server extends HostedServerRuntime, Options extends HostedServerTarget> {
  private tail: Promise<void> = Promise.resolve();
  private active: { server: Server; port: number; serverId: string | null; ready: boolean } | null = null;

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
      if (this.active) {
        // An absent id owns the legacy flat directory, not any named server's
        // directory. Matching only the port must never relabel that data.
        if (this.active.ready && this.active.port === target.port && this.active.serverId === serverId) return;
        throw new HostedServerConflictError();
      }

      const server = await this.createServer(target);
      try {
        await server.start();
      } catch (startError) {
        try {
          await server.stop();
        } catch (stopError) {
          // Failed cleanup still owns resources. Keep an explicit stop possible,
          // but do not acknowledge a duplicate start as a healthy instance.
          this.active = { server, port: target.port, serverId, ready: false };
          this.onChange();
          throw new HostedServerCleanupError(startError, stopError);
        }
        throw startError;
      }

      this.active = { server, port: target.port, serverId, ready: true };
      this.onChange();
    });
  }

  public stop(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.active) return;
      this.active.ready = false;
      await this.active.server.stop();
      this.active = null;
      this.onChange();
    });
  }

  public getServer(): Server | null {
    return this.active?.server ?? null;
  }

  public getStatus(): HostedServerStatus {
    return {
      isRunning: this.active !== null,
      port: this.active?.port ?? null,
      serverId: this.active?.serverId ?? null,
    };
  }
}
