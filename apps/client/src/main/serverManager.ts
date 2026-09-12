import path from 'path';
import fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { MonkyServer, Logger, type ServerConfig } from '@monky/server';
import { LIMITS, type HostServerOptions, type IpcEvents, type LogEntry, type ServerStats } from '@monky/shared';
import { mt, type MainTranslationKey } from './i18n';
import { isSafeServerId, migrateLegacyServerData, serverDataDirFor } from './serverDataDir';
import { HostedServerCleanupError, HostedServerConflictError, HostedServerLifecycle } from './hostedServerLifecycle';

export type { HostServerOptions };

function errorMessage(error: unknown, fallback: MainTranslationKey): string {
  return error instanceof Error && error.message ? error.message : mt(fallback);
}

export class ServerManager {
  private unsubscribeLogs: (() => void) | null = null;
  private readonly lifecycle = new HostedServerLifecycle<MonkyServer, HostServerOptions>(
    (options) => this.createServer(options),
    () => this.onLifecycleChange(),
  );

  public async startServer(options: HostServerOptions): Promise<{ success: boolean; error?: string }> {
    if (
      !options || !Number.isInteger(options.port) || options.port < LIMITS.MIN_PORT || options.port > LIMITS.MAX_PORT ||
      typeof options.serverName !== 'string' ||
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
        return { success: false, error: mt('error.hostedServerAlreadyRunning') };
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
      serverName: options.serverName || 'Monky Server',
      password: options.password || '',
      initialVoiceChannel: options.initialVoiceChannel || 'Geral',
      initialTextChannel: options.initialTextChannel || 'geral',
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
    return this.lifecycle.runExclusive(() => {
      // Wait for pending starts and stops before deciding whether data is free.
      const status = this.getStatus();
      if (status.isRunning && status.serverId === serverId) {
        return { success: false, error: mt('error.deleteServerDataRunning') };
      }

      try {
        fs.rmSync(serverDataDirFor(ServerManager.baseDataDir(), serverId), { recursive: true, force: true });
        return { success: true };
      } catch (error) {
        console.error('[ServerManager] Error deleting server data:', error);
        return { success: false, error: errorMessage(error, 'error.deleteServerDataFailed') };
      }
    });
  }

  public async stopServer(): Promise<void> {
    try {
      await this.lifecycle.stop();
    } catch (error) {
      console.error('[ServerManager] Error stopping local server:', error);
      throw new Error(errorMessage(error, 'error.stopServerFailed'), { cause: error });
    }
  }

  private onLifecycleChange(): void {
    if (this.getStatus().isRunning) {
      if (!this.unsubscribeLogs) this.startForwardingLogs();
    } else {
      this.unsubscribeLogs?.();
      this.unsubscribeLogs = null;
    }
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
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(channel, ...args);
      }
    }
  }

  /**
   * Streams the hosted server's log entries to the renderer as they happen, so
   * the log view does not have to poll. The subscription is dropped on stop:
   * starting and stopping repeatedly would otherwise stack listeners.
   */
  private startForwardingLogs(): void {
    this.unsubscribeLogs?.();
    this.unsubscribeLogs = Logger.subscribe((entry: LogEntry) => {
      this.broadcast('server-host:log', entry);
    });
  }

  public getLogs(): LogEntry[] {
    return Logger.getRecent();
  }

  public clearLogs(): void {
    Logger.clearBuffer();
  }

  public async getStats(): Promise<ServerStats | null> {
    const server = this.lifecycle.getServer();
    return server ? server.getStats() : null;
  }

  /**
   * Single source of truth for the hosted server. The renderer used to track
   * which of the user's servers was up in view state, which went stale as soon
   * as it was started from somewhere else (#333).
   */
  public getStatus(): { isRunning: boolean; port: number | null; serverId: string | null } {
    return this.lifecycle.getStatus();
  }
}
