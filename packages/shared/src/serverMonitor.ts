import { z } from 'zod';
import { LIMITS } from './constants.js';
import type { ServerStats } from './ipc.js';

export const SERVER_MONITOR_LIMITS = {
  HISTORY_ENTRIES: LIMITS.LOG_BUFFER_SIZE,
  MAX_BATCH_ENTRIES: 100,
  MAX_MESSAGE_LENGTH: 1024,
  POLL_INTERVAL_MS: 3000,
  REQUEST_TIMEOUT_MS: 8000,
  REQUESTS_PER_WINDOW: 2,
  RATE_WINDOW_MS: 3000,
  TOTAL_REQUESTS_PER_SECOND: 20,
} as const;

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const serverId = z.string().min(1).max(128);

export const serverMonitorGetSchema = z.object({
  serverId,
  cursor: counter.optional(),
}).strict();

export const serverMonitorStatsSchema = z.object({
  serverName: z.string().min(1).max(512),
  port: z.number().int().min(0).max(65535),
  startedAt: counter.nullable(),
  uptimeMs: counter,
  onlineUsers: counter,
  maxUsers: counter,
  members: counter,
  channels: counter,
  messages: counter,
}).strict() satisfies z.ZodType<Omit<ServerStats, 'dataDir'>>;

export const serverMonitorLogEntrySchema = z.object({
  sequence: counter.positive(),
  timestamp: z.string().max(32).datetime(),
  level: z.enum(['INFO', 'WARN', 'ERROR']),
  category: z.enum([
    'INFO', 'WARN', 'ERROR', 'SECURITY', 'NETWORK', 'DATABASE',
    'WEBRTC', 'SFU', 'SOUNDBOARD', 'ATTACHMENT', 'BOT',
  ]),
  message: z.string().max(SERVER_MONITOR_LIMITS.MAX_MESSAGE_LENGTH),
}).strict();

export const serverMonitorSnapshotSchema = z.object({
  serverId,
  stats: serverMonitorStatsSchema,
  entries: z.array(serverMonitorLogEntrySchema).max(SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES),
  cursor: counter,
  dropped: counter,
}).strict().superRefine((snapshot, ctx) => {
  let previous = -1;
  for (const entry of snapshot.entries) {
    if (entry.sequence <= previous || entry.sequence > snapshot.cursor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid monitor log sequence.' });
      break;
    }
    previous = entry.sequence;
  }
});

export type ServerMonitorGetPayload = z.infer<typeof serverMonitorGetSchema>;
export type ServerMonitorStats = z.infer<typeof serverMonitorStatsSchema>;
export type ServerMonitorLogEntry = z.infer<typeof serverMonitorLogEntrySchema>;
export type ServerMonitorSnapshotPayload = z.infer<typeof serverMonitorSnapshotSchema>;
