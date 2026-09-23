import {
  SERVER_MONITOR_LIMITS, serverMonitorSnapshotSchema,
  type ServerMonitorSnapshotPayload, type ServerStats,
} from '@monky/shared';
import { ServerLogScope } from '../../infrastructure/logger/ServerLogScope';
import { RateLimiter } from '../../infrastructure/security/RateLimiter';

export class ServerMonitorService {
  constructor(
    public readonly serverId: string,
    private readonly logs: ServerLogScope,
    private readonly getStats: () => Promise<ServerStats>,
    private readonly rateLimiter: RateLimiter,
  ) {}

  public acceptsCursor(cursor: number | undefined): boolean {
    return this.logs.acceptsCursor(cursor);
  }

  public allowRequest(userId: string): boolean {
    return this.rateLimiter.checkLimit(
      `server-monitor:${userId}`,
      SERVER_MONITOR_LIMITS.REQUESTS_PER_WINDOW,
      SERVER_MONITOR_LIMITS.RATE_WINDOW_MS,
    ) && this.rateLimiter.checkLimit(
      'server-monitor:global', SERVER_MONITOR_LIMITS.TOTAL_REQUESTS_PER_SECOND, 1000,
    );
  }

  public async getSnapshot(cursor?: number): Promise<ServerMonitorSnapshotPayload> {
    const stats = await this.getStats();
    return serverMonitorSnapshotSchema.parse({
      serverId: this.serverId,
      stats: {
        serverName: stats.serverName,
        port: stats.port,
        startedAt: stats.startedAt,
        uptimeMs: stats.uptimeMs,
        onlineUsers: stats.onlineUsers,
        maxUsers: stats.maxUsers,
        members: stats.members,
        channels: stats.channels,
        messages: stats.messages,
      },
      ...this.logs.read(cursor),
    });
  }
}
