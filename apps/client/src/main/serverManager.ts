import path from 'path';
import fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { MonkyServer, readStoredUpdateInventory, type ServerConfig } from '@monky/server';
import { LIMITS, type HostedUpdateServer, type HostServerOptions, type HostServerStatus, type IpcEvents, type LogEntry, type ServerStats } from '@monky/shared';
import { mt, type MainTranslationKey } from './i18n';
import { isSafeServerId, migrateLegacyServerData, serverDataDirFor } from './serverDataDir';
import { HostedServerCleanupError, HostedServerConflictError, HostedServerLifecycle } from './hostedServerLifecycle';

export type { HostServerOptions };

function errorMessage(error: unknown, fallback: MainTranslationKey): string {
  return error instanceof Error && error.message ? error.message : mt(fallback);
}

export class ServerManager {
  /** Log forwarding per hosted port, dropped as soon as that server stops. */
  private readonly logForwarders = new Map<number, { server: MonkyServer; unsubscribe: () => void }>();
  private readonly lifecycle = new HostedServerLifecycle<MonkyServer, HostServerOptions>(
    (options) => this.createServer(options),
    () => this.onLifecycleChange(),
  );

  public async startServer(options: HostServerOptions): Promise<{ success: boolean; error?: string }> {
    if (
      !options || !Number.isInteger(options.port) || options.port < LIMITS.MIN_PORT || options.port > LIMITS.MAX_PORT ||
      typeof options.serverName !== 'string' ||
      (options.categoryLocale !== undefined && options.categoryLocale !== 'pt-BR' && options.categoryLocale !== 'en') ||
      (options.serverId !== undefined && (typeof options.serverId !== 'string' || !isSafeServerId(options.serverId))) ||
      [options.password, options.initialVoiceChannel, options.initialTextChannel].some(value => value !== undefined && typeof value !== 'string') ||
      (options.maxUsers !== undefined && (!Number.isSafeInteger(options.maxUsers) || options.maxUsers < 0)) ||
      (options.voiceMode !== undefined && options.voiceMode !== 'p2p' && options.voiceMode !== 'sfu')
    ) {
      return { success: false, error: mt('error.startServerFailed') };
    }

    try {
      await this.lifecycle.start(options);
      return { success: true };
    } catch (error) {
      if (error instanceof HostedServerConflictError) {
        return {
          success: false,
          error: mt(error.reason === 'port' ? 'error.hostedServerAlreadyRunning' : 'error.hostedServerIdentityRunning', { port: String(error.port) }),
        };
      }
      console.error('[ServerManager] Error starting local server:', error);
      if (error instanceof HostedServerCleanupError) {
        return {
          success: false,
          error: mt('error.startServerCleanupFailed', {
            startError: errorMessage(error.startError, 'error.startServerFailed'),
            stopError: errorMessage(error.stopError, 'error.stopServerFailed'),
          }),
        };
      }
      return { success: false, error: errorMessage(error, 'error.startServerFailed') };
    }
  }

  private async createServer(options: HostServerOptions): Promise<MonkyServer> {
    const dataDir = this.resolveDataDir(options.serverId);
    fs.mkdirSync(dataDir, { recursive: true });
    const config: ServerConfig = {
      port: options.port,
      dataDir,
      version: app.getVersion(),
      serverName: options.serverName || 'Monky Server',
      password: options.password || '',
      initialVoiceChannel: options.initialVoiceChannel || 'Geral',
      initialTextChannel: options.initialTextChannel || 'geral',
      categoryLocale: options.categoryLocale,
      maxUsers: options.maxUsers,
      voiceMode: options.voiceMode,
    };
    return MonkyServer.create(config);
  }

  private static baseDataDir(): string {
    return path.join(app.getPath('userData'), 'server-data');
  }

  /**
   * One folder per entry of "Meus Servidores" (#364). Servers started without
   * an id keep the flat folder: they have no entry to be told apart by.
   */
  private resolveDataDir(serverId?: string): string {
    const baseDir = ServerManager.baseDataDir();
    if (!serverId) return baseDir;

    const dataDir = serverDataDirFor(baseDir, serverId);
    migrateLegacyServerData(baseDir, dataDir);
    return dataDir;
  }

  /**
   * Drops the data of a server removed from "Meus Servidores". Without this the
   * database outlived the entry and was inherited by the next server created
   * (#364).
   */
  public async deleteServerData(serverId: string): Promise<{ success: boolean; error?: string }> {
    if (!serverId || !isSafeServerId(serverId)) {
      return { success: false, error: mt('error.deleteServerDataFailed') };
    }
    return this.lifecycle.runExclusive(async () => {
      // Wait for pending starts and stops before deciding whether data is free.
      if (this.getStatus().servers.some((server) => server.serverId === serverId)) {
        return { success: false, error: mt('error.deleteServerDataRunning') };
      }

      try {
        // Months of attachments can be thousands of files; a synchronous delete froze the window and IPC.
        await fs.promises.rm(serverDataDirFor(ServerManager.baseDataDir(), serverId), { recursive: true, force: true });
        return { success: true };
      } catch (error) {
        console.error('[ServerManager] Error deleting server data:', error);
        return { success: false, error: errorMessage(error, 'error.deleteServerDataFailed') };
      }
    });
  }

  public async stopServer(port: number): Promise<void> {
    try {
      await this.lifecycle.stop(port);
    } catch (error) {
      console.error('[ServerManager] Error stopping local server:', error);
      throw new Error(errorMessage(error, 'error.stopServerFailed'), { cause: error });
    }
  }

  /** Stops every hosted server, e.g. when the app quits. */
  public async stopAll(): Promise<void> {
    try {
      await this.lifecycle.stopAll();
    } catch (error) {
      console.error('[ServerManager] Error stopping local servers:', error);
      throw new Error(errorMessage(error, 'error.stopServerFailed'), { cause: error });
    }
  }

  private onLifecycleChange(): void {
    this.syncLogForwarding();
    this.notifyStatus();
  }

  /**
   * Pushes the hosted server state to every window. Polling it at render time
   * loses every transition that happens while another screen is up, which is
   * how "Meus Servidores" ended up offering to start a server that was already
   * running (#333).
   */
  private notifyStatus(): void {
    this.broadcast('server-host:status-changed', this.getStatus());
  }

  private broadcast<C extends keyof IpcEvents>(channel: C, ...args: IpcEvents[C]): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
        && !window.webContents.mainFrame.isDestroyed() && !window.webContents.mainFrame.detached) {
        window.webContents.send(channel, ...args);
      }
    }
  }

  /**
   * Streams each hosted server's own log entries to the renderer as they
   * happen, tagged with its port so two servers never share a log view. A
   * subscription is dropped on stop: starting and stopping repeatedly would
   * otherwise stack listeners.
   */
  private syncLogForwarding(): void {
    const live = new Map(this.lifecycle.entries().map((entry) => [entry.port, entry.server]));
    for (const [port, forwarder] of [...this.logForwarders]) {
      if (live.get(port) === forwarder.server) continue;
      forwarder.unsubscribe();
      this.logForwarders.delete(port);
    }
    for (const [port, server] of live) {
      if (this.logForwarders.has(port)) continue;
      const unsubscribe = server.subscribeLogs((entry: LogEntry) => this.broadcast('server-host:log', port, entry));
      this.logForwarders.set(port, { server, unsubscribe });
    }
  }

  public getLogs(port: number): LogEntry[] {
    return this.lifecycle.getServer(port)?.getRecentLogs() ?? [];
  }

  public clearLogs(port: number): void {
    this.lifecycle.getServer(port)?.clearLogs();
  }

  public async getStats(port: number): Promise<ServerStats | null> {
    const server = this.lifecycle.getServer(port);
    return server ? server.getStats() : null;
  }

  public getUpdateInventory(signal?: AbortSignal): Promise<HostedUpdateServer[]> {
    return this.lifecycle.runExclusive(async () => {
      signal?.throwIfAborted();
      const base = ServerManager.baseDataDir();
      const active = new Map(this.lifecycle.entries().map((entry) => [entry.serverId, entry.server]));
      const ids: Array<string | null> = [];
      if (fs.existsSync(base)) {
        if (fs.existsSync(path.join(base, 'server.db'))) ids.push(null);
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && isSafeServerId(entry.name) &&
              fs.existsSync(path.join(base, entry.name, 'server.db'))) ids.push(entry.name);
        }
      }
      for (const activeId of active.keys()) if (!ids.includes(activeId)) ids.push(activeId);
      const servers: HostedUpdateServer[] = [];
      for (const serverId of ids) {
        signal?.throwIfAborted();
        const live = active.get(serverId);
        const inventory = live
          ? live.getUpdateInventory()
          : await readStoredUpdateInventory(path.join(serverId === null ? base : serverDataDirFor(base, serverId), 'server.db'));
        if (inventory.bots.length) servers.push({ serverId, ...inventory });
      }
      signal?.throwIfAborted();
      return servers;
    });
  }

  /**
   * Single source of truth for the hosted servers. The renderer used to track
   * which of the user's servers was up in view state, which went stale as soon
   * as it was started from somewhere else (#333).
   */
  public getStatus(): HostServerStatus {
    return this.lifecycle.getStatus();
  }
}
