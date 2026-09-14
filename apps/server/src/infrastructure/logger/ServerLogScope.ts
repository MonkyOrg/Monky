import {
  SERVER_MONITOR_LIMITS, type LogEntry, type ServerMonitorLogEntry,
} from '@monky/shared';

const SAFE_MESSAGES = new Set([
  'Server seeded successfully with default channels.',
  'Stopping Monky Server...',
  'Server stopped.',
  'Failed to prepare the public server preview.',
  'LAN discovery broadcast unavailable; continuing without it.',
  'Failed to send LAN discovery broadcast.',
  'WebSocket server error',
  'Failed to parse message',
  'Failed to process message',
  'Failed to apply the TURN relay state',
  'Failed to evaluate the TURN relay configuration',
  'Failed to build the ICE server list; sending STUN only.',
  'Installing coturn so the TURN relay can start...',
  'coturn installed successfully.',
  'Failed to write the coturn configuration',
  'coturn failed to run',
  'Failed to start the TURN relay',
  'TURN relay stopped',
  'TURN relay is enabled but has no shared secret; leaving it off.',
  'TURN relay was enabled alongside SFU mode; disabling it (the SFU is the relay).',
  'Startup reconciliation failed',
  'Screen cleanup failed.',
  'Failed to reconcile voice miniapp access.',
  'Failed to clean up disconnected bot screens.',
  'Bot settings operation failed.',
  'Failed to create bot.',
  'Failed to update bot profile.',
  'Failed to complete bot registration.',
  'Failed to save bot avatar.',
  'Could not authorize an audio preview',
  'Could not deliver an audio preview',
  'Error generating server invite info',
]);

const SAFE_TEMPLATES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Monky Server running on /, 'Monky Server is listening.'],
  [/^New connection established from /, 'New client connection.'],
  [/^Socket error for /, 'Client socket error.'],
  [/^Replaced stale session /, 'A stale client session was replaced.'],
  [/^User .+ joined the server\.$/s, 'A user joined the server.'],
  [/^User .+ lost connection /s, 'A user lost connection; waiting for reconnection.'],
  [/^User .+ disconnected$/s, 'A user disconnected.'],
  [/^User .+ was kicked from the server by /s, 'A user was removed from the server.'],
  [/^Member .+ removed from the server$/s, 'A member was removed from the server.'],
  [/^Terminating dead socket for /, 'An unresponsive client connection was closed.'],
  [/^Failed authentication attempt for nickname: /, 'A client authentication attempt failed.'],
  [/^Applying migration /, 'Applying a database migration.'],
  [/^Migration .+ applied successfully$/, 'Database migration applied.'],
  [/^Session .+ joined voice channel /, 'A participant joined a voice channel.'],
  [/^Session .+ left voice channel /, 'A participant left a voice channel.'],
  [/^Invalid signal routing attempt /, 'Invalid voice signal routing was refused.'],
  [/^Bot ".+" .+ connected\.$/s, 'A bot connected.'],
  [/^Bot ".+" .+ revoked\.$/s, 'A bot credential was revoked.'],
  [/^Bot ".+" registered \d+ command\(s\)\.$/s, 'A bot registered commands.'],
  [/^SFU initialization failed/, 'SFU initialization failed.'],
  [/^Error checking SFU configuration/, 'Could not check the SFU configuration.'],
  [/^TURN relay started and listening on port /, 'TURN relay started.'],
  [/^TURN relay not started:/, 'TURN relay could not start.'],
  [/^coturn installation failed /, 'TURN relay installation failed.'],
  [/^Failed to store upload:/, 'An attachment upload failed.'],
  [/^Reconciliation removed \d+ stale pending upload/, 'Stale attachment uploads were cleaned up.'],
];

/**
 * Remote viewing is not permission to inspect private messages or host secrets.
 * Legacy logs contain interpolated payloads, paths, errors and subprocess output;
 * regex secret masking cannot make those arbitrary strings safe. Only fixed
 * operational templates leave the host. No matched values or metadata survive.
 */
export function remoteLogMessage(message: string): string {
  const restricted = 'Operational event (details restricted to the server host).';
  if (message.length > SERVER_MONITOR_LIMITS.MAX_MESSAGE_LENGTH) return restricted;
  if (SAFE_MESSAGES.has(message)) return message;
  for (const [pattern, summary] of SAFE_TEMPLATES) {
    if (pattern.test(message)) return summary;
  }
  return restricted;
}

export class ServerLogScope {
  private entries: ServerMonitorLogEntry[] = [];
  private sequence = 0;
  private closed = false;

  public record(entry: LogEntry, message: string): void {
    if (this.closed) return;
    this.entries.push({
      timestamp: entry.timestamp,
      level: entry.level,
      category: entry.category,
      message: remoteLogMessage(message),
      sequence: ++this.sequence,
    });
    if (this.entries.length > SERVER_MONITOR_LIMITS.HISTORY_ENTRIES) {
      this.entries.splice(0, this.entries.length - SERVER_MONITOR_LIMITS.HISTORY_ENTRIES);
    }
  }

  public acceptsCursor(cursor: number | undefined): boolean {
    return cursor === undefined || (Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= this.sequence);
  }

  public read(cursor?: number): { entries: ServerMonitorLogEntry[]; cursor: number; dropped: number } {
    if (this.closed) throw new Error('Server monitoring has stopped.');
    if (!this.acceptsCursor(cursor)) throw new RangeError('Invalid monitor cursor.');
    const after = cursor ?? Math.max(0, this.sequence - SERVER_MONITOR_LIMITS.HISTORY_ENTRIES);
    const entries = this.entries
      .filter((entry) => entry.sequence > after)
      .slice(-SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES)
      .map((entry) => ({ ...entry }));
    return {
      entries,
      cursor: this.sequence,
      dropped: Math.max(0, this.sequence - after - entries.length),
    };
  }

  public close(): void {
    this.closed = true;
    this.entries = [];
  }
}
