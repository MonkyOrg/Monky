/**
 * Persistent logging service for the Monky desktop client (#444).
 *
 * Writes structured JSON-lines log files to the Electron `userData` directory.
 * Implements rotating log files with a configurable size limit: when the total
 * exceeds the budget, the oldest file is deleted. Each file corresponds to one
 * app session (identified by its start timestamp).
 *
 * Sensitive data (passwords, tokens) must never reach this layer — renderer and
 * main-process callers select safe diagnostic fields before writing.
 */

import { app, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ClientLogConfig, ClientLogEntry } from '@monky/shared';
import { CLIENT_LOG_DEFAULTS } from '@monky/shared';

const LOGS_DIR_NAME = 'client-logs';
const CONFIG_FILE_NAME = 'log-config.json';
const LOG_FILE_EXT = '.jsonl';

export class ClientLogger {
  private logsDir: string;
  private configPath: string;
  private config: ClientLogConfig;
  private currentLogPath: string;
  private writeStream: fs.WriteStream | null = null;
  private bytesWrittenThisSession = 0;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.logsDir = path.join(userDataPath, LOGS_DIR_NAME);
    this.configPath = path.join(this.logsDir, CONFIG_FILE_NAME);
    this.config = this.loadConfig();

    // Create logs directory if it doesn't exist
    fs.mkdirSync(this.logsDir, { recursive: true });

    // Each session gets its own log file
    const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    this.currentLogPath = path.join(this.logsDir, `session-${sessionId}${LOG_FILE_EXT}`);

    if (this.config.enabled) {
      this.openStream();
      this.enforceRotation();
    }
  }

  private loadConfig(): ClientLogConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        return {
          enabled: typeof raw.enabled === 'boolean' ? raw.enabled : CLIENT_LOG_DEFAULTS.enabled,
          maxSizeBytes:
            typeof raw.maxSizeBytes === 'number' && raw.maxSizeBytes > 0
              ? raw.maxSizeBytes
              : CLIENT_LOG_DEFAULTS.maxSizeBytes,
        };
      }
    } catch {
      // Corrupted config — use defaults
    }
    return { ...CLIENT_LOG_DEFAULTS };
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch {
      // Filesystem error — nothing we can do
    }
  }

  private openStream(): void {
    if (this.writeStream) return;
    try {
      this.writeStream = fs.createWriteStream(this.currentLogPath, { flags: 'a', encoding: 'utf8' });
      this.writeStream.on('error', () => {
        this.writeStream = null;
      });
    } catch {
      this.writeStream = null;
    }
  }

  private closeStream(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  private async flushWrites(): Promise<void> {
    const stream = this.writeStream;
    if (!stream) return;
    // A queued empty write is a flush barrier without closing the live sink.
    await new Promise<void>((resolve, reject) => {
      stream.write('', error => { if (error) reject(error); else resolve(); });
    });
  }

  /**
   * Lists log files sorted oldest-first.
   */
  private listLogFiles(): { path: string; size: number; mtime: number }[] {
    try {
      return fs
        .readdirSync(this.logsDir)
        .filter((f) => f.endsWith(LOG_FILE_EXT))
        .map((f) => {
          const filePath = path.join(this.logsDir, f);
          const stat = fs.statSync(filePath);
          return { path: filePath, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
    } catch {
      return [];
    }
  }

  /**
   * Deletes oldest log files until total size is under the budget.
   */
  private enforceRotation(): void {
    const files = this.listLogFiles();
    let totalSize = files.reduce((sum, f) => sum + f.size, 0);

    for (const file of files) {
      if (totalSize <= this.config.maxSizeBytes) break;
      // Never delete the current session's log
      if (file.path === this.currentLogPath) continue;
      try {
        fs.unlinkSync(file.path);
        totalSize -= file.size;
      } catch {
        // File may be locked or already deleted
      }
    }
  }

  public write(entry: ClientLogEntry): void {
    if (!this.config.enabled) return;

    // Ensure timestamp exists
    const enriched: ClientLogEntry = {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    const line = JSON.stringify(enriched) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');

    if (this.writeStream) {
      this.writeStream.write(line);
      this.bytesWrittenThisSession += lineBytes;

      // Check rotation every ~100KB of writes to avoid checking on every line
      if (this.bytesWrittenThisSession % (100 * 1024) < lineBytes) {
        this.enforceRotation();
      }
    }
  }

  public getConfig(): ClientLogConfig {
    return { ...this.config };
  }

  public setConfig(update: Partial<ClientLogConfig>): void {
    if (typeof update.enabled === 'boolean') {
      this.config.enabled = update.enabled;
      if (update.enabled && !this.writeStream) {
        this.openStream();
      } else if (!update.enabled) {
        this.closeStream();
      }
    }
    if (typeof update.maxSizeBytes === 'number' && update.maxSizeBytes > 0) {
      this.config.maxSizeBytes = update.maxSizeBytes;
    }
    this.saveConfig();
    if (this.config.enabled) {
      this.enforceRotation();
    }
  }

  /**
   * Total bytes used by all log files.
   */
  public getTotalSize(): number {
    return this.listLogFiles().reduce((sum, f) => sum + f.size, 0);
  }

  /**
   * Deletes all log files except the current session's.
   */
  public clearLogs(): void {
    for (const file of this.listLogFiles()) {
      if (file.path === this.currentLogPath) continue;
      try {
        fs.unlinkSync(file.path);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Exports all logs into a single file and opens a "Save As" dialog.
   * Returns the path where the file was saved, or an error.
   */
  public async exportLogs(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      await this.flushWrites();
      if (this.listLogFiles().length === 0) {
        if (this.config.enabled) this.openStream();
        return { success: false, error: 'no-logs' };
      }

      const result = await dialog.showSaveDialog({
        title: 'Exportar logs do Monky',
        defaultPath: `monky-logs-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [
          { name: 'Logs', extensions: ['txt'] },
          { name: 'JSON Lines', extensions: ['jsonl'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        if (this.config.enabled) this.openStream();
        return { success: false, error: 'cancelled' };
      }

      // Include events produced while the save dialog was open, without
      // suspending logging or using a stale list after rotation.
      await this.flushWrites();
      const files = this.listLogFiles();
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(result.filePath, { encoding: 'utf8' });
        output.once('error', reject);
        output.once('finish', resolve);
        try {
          for (const file of files) {
            const fileName = path.basename(file.path);
            output.write(`\n--- ${fileName} (${(file.size / 1024).toFixed(1)} KB) ---\n`);
            output.write(fs.readFileSync(file.path, 'utf8'));
          }
          output.end();
        } catch (error) {
          output.destroy();
          reject(error);
        }
      });

      if (this.config.enabled) this.openStream();

      return { success: true, filePath: result.filePath };
    } catch (err) {
      // Re-open stream on error
      if (this.config.enabled) this.openStream();
      return { success: false, error: err instanceof Error ? err.message : 'unknown' };
    }
  }

  /**
   * Shuts down the logger cleanly — call from `app.on('before-quit')`.
   */
  public shutdown(): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category: 'APP',
      message: 'Application shutting down',
    });
    this.closeStream();
  }
}
