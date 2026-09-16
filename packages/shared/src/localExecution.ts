import { z } from 'zod';
import { normalizePublicKeyHex } from './identity.js';
import { LIMITS } from './constants.js';

export const LOCAL_TOOL_IDS = ['node', 'yt-dlp', 'ffmpeg'] as const;
export const LOCAL_CAPABILITY_IDS = ['youtube-audio'] as const;
export const localToolIdSchema = z.enum(LOCAL_TOOL_IDS);
export const localCapabilityIdSchema = z.enum(LOCAL_CAPABILITY_IDS);
export type LocalToolId = z.infer<typeof localToolIdSchema>;
export type LocalCapabilityId = z.infer<typeof localCapabilityIdSchema>;

export const LOCAL_CAPABILITY_TOOLS: Readonly<Record<LocalCapabilityId, readonly LocalToolId[]>> = {
  'youtube-audio': LOCAL_TOOL_IDS,
};

const identifier = z.string().min(1).max(128);
const displayName = z.string().min(1).max(128);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const localBotIdentitySchema = z.object({
  serverOrigin: z.string().max(2048).url().pipe(z.string().refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === '/' || url.pathname === '');
  })).transform((value) => new URL(value).origin),
  serverId: identifier,
  serverName: displayName,
  botId: identifier,
  botName: displayName,
  botPublicKey: z.string().min(64).max(128).regex(/^[a-fA-F0-9]+$/).transform(normalizePublicKeyHex),
}).strict();
export type LocalBotIdentity = z.infer<typeof localBotIdentitySchema>;

export const localExecutionSubjectSchema = localBotIdentitySchema.extend({
  connectionId: identifier,
}).strict();
export type LocalExecutionSubject = z.infer<typeof localExecutionSubjectSchema>;

export const localExecutionFailureSchema = z.enum([
  'invalid_request',
  'permission_denied',
  'permission_revoked',
  'executor_unavailable',
  'unsupported_platform',
  'tools_missing',
  'tool_install_failed',
  'integrity_failed',
  'storage_failed',
  'provider_unavailable',
  'transport_failed',
  'worker_failed',
  'busy',
  'timeout',
  'cancelled',
]);
export type LocalExecutionFailure = z.infer<typeof localExecutionFailureSchema>;

export const localOperationSchema = z.enum([
  'youtube.search',
  'youtube.resolve',
  'youtube.preview',
  'youtube.stream',
]);
export type LocalOperation = z.infer<typeof localOperationSchema>;

export const localYoutubeUrlSchema = z.string().length(43)
  .regex(/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/);

export const localMediaTrackSchema = z.object({
  id: z.string().length(11).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().min(1).max(512),
  url: localYoutubeUrlSchema,
  duration: z.number().positive().max(3600),
}).strict().refine((track) => track.url.endsWith(`v=${track.id}`));
export type LocalMediaTrack = z.infer<typeof localMediaTrackSchema>;

export const localTaskSpecSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('youtube.search'),
    query: z.string().trim().min(1).max(LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH),
  }).strict(),
  z.object({ operation: z.literal('youtube.resolve'), url: localYoutubeUrlSchema }).strict(),
  z.object({ operation: z.literal('youtube.preview'), url: localYoutubeUrlSchema }).strict(),
  z.object({ operation: z.literal('youtube.stream'), url: localYoutubeUrlSchema }).strict(),
]);
export type LocalTaskSpec = z.infer<typeof localTaskSpecSchema>;

export const localTaskResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('youtube.search'),
    tracks: z.array(localMediaTrackSchema).max(LIMITS.MAX_BOT_AUTOCOMPLETE_CHOICES),
  }).strict(),
  z.object({ operation: z.literal('youtube.resolve'), track: localMediaTrackSchema }).strict(),
  z.object({
    operation: z.literal('youtube.preview'),
    mimeType: z.literal('audio/ogg'),
    audioBase64: z.string().min(4).max(Math.ceil(LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).strict(),
  z.object({ operation: z.literal('youtube.stream'), track: localMediaTrackSchema }).strict(),
]);
export type LocalTaskResult = z.infer<typeof localTaskResultSchema>;

export const LOCAL_EXECUTION_RUNTIME_LIMITS = {
  tasks: 4,
  prepareTimeoutMs: 10 * 60_000,
  metadataTimeoutMs: 45_000,
  frameBatch: 8,
  frameBytes: 1275,
  sourceRecoveryAttempts: 100,
} as const;

export const localRuntimeSourceFailureSchema = z.discriminatedUnion('code', [
  z.object({ code: z.enum(['input', 'unsupported', 'tools', 'runtime', 'unavailable', 'timeout', 'busy']) }).strict(),
  z.object({
    code: z.literal('recovery_failed'),
    attempts: z.number().int().min(1).max(LOCAL_EXECUTION_RUNTIME_LIMITS.sourceRecoveryAttempts),
  }).strict(),
]);
export type LocalRuntimeSourceFailure = z.infer<typeof localRuntimeSourceFailureSchema>;

export interface LocalExecutionFailureDetails {
  reason: LocalExecutionFailure;
  sourceFailure?: LocalRuntimeSourceFailure;
}
export type LocalExecutionFailedResult = { status: 'failed' } & LocalExecutionFailureDetails;

export const localPreparationInputSchema = z.object({
  requestId: identifier,
  subject: localExecutionSubjectSchema,
  capability: localCapabilityIdSchema,
}).strict();
export type LocalPreparationInput = z.infer<typeof localPreparationInputSchema>;

export type LocalPreparationResult =
  | { status: 'prepared'; permit: string }
  | { status: 'cancelled' }
  | LocalExecutionFailedResult;

export const localTaskStartInputSchema = z.object({
  requestId: identifier,
  permit: z.string().length(64).regex(/^[a-f0-9]+$/),
  spec: localTaskSpecSchema,
  voiceChannelId: identifier.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.spec.operation === 'youtube.stream' && !value.voiceChannelId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['voiceChannelId'], message: 'A voice context is required.' });
  }
});
export type LocalTaskStartInput = z.infer<typeof localTaskStartInputSchema>;

export type LocalTaskStartResult =
  | { status: 'started'; taskId: string; result: LocalTaskResult }
  | { status: 'cancelled' }
  | LocalExecutionFailedResult;

export const localFrameReadInputSchema = z.object({
  taskId: identifier,
  count: z.number().int().min(1).max(LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch),
}).strict();
export type LocalFrameReadInput = z.infer<typeof localFrameReadInputSchema>;

export const localFrameProgressSchema = z.object({
  taskId: identifier,
  playedFrames: z.number().int().nonnegative().max(0xffffffff),
}).strict();
export type LocalFrameProgress = z.infer<typeof localFrameProgressSchema>;

export type LocalFrameReadResult =
  | { status: 'frames'; frames: Uint8Array[]; done: boolean }
  | { status: 'cancelled' }
  | LocalExecutionFailedResult;

export const localRequestCancellationSchema = z.object({ requestId: identifier }).strict();
export type LocalRequestCancellation = z.infer<typeof localRequestCancellationSchema>;

export const localTaskPauseSchema = z.object({ taskId: identifier, paused: z.boolean() }).strict();
export type LocalTaskPause = z.infer<typeof localTaskPauseSchema>;

export const localConnectionStateSchema = z.object({
  connectionId: identifier,
  connected: z.boolean(),
  voiceChannelId: identifier.nullable(),
}).strict();
export type LocalConnectionState = z.infer<typeof localConnectionStateSchema>;

export interface LocalTaskFailureEvent extends LocalExecutionFailureDetails {
  taskId: string;
}

export type LocalConsentDecision = 'deny' | 'connection' | 'always';

export const LOCAL_PERMISSION_LIMITS = { entries: 512, bytes: 2 * 1024 * 1024 } as const;
export const localPermissionInfoSchema = z.object({
  id: z.string().length(64).regex(/^[a-f0-9]+$/),
  bot: localBotIdentitySchema,
  capability: localCapabilityIdSchema,
  decision: z.enum(['deny', 'connection', 'always']),
  updatedAt: z.number().int().positive(),
}).strict();
export type LocalPermissionInfo = z.infer<typeof localPermissionInfoSchema>;

export const localPermissionsFileSchema = z.object({
  version: z.literal(1),
  permissions: z.array(localPermissionInfoSchema.extend({
    decision: z.enum(['deny', 'always']),
  }).strict()).max(LOCAL_PERMISSION_LIMITS.entries),
}).strict();

export type LocalToolStatus = 'absent' | 'installing' | 'ready' | 'invalid' | 'removing' | 'failed';

export interface LocalToolProgress {
  stage: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'checking';
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface LocalToolInfo {
  id: LocalToolId;
  status: LocalToolStatus;
  version: string | null;
  sizeBytes: number;
  sourceUrl: string | null;
  requiredBy: string[];
  progress: LocalToolProgress | null;
  failure: LocalExecutionFailure | null;
}

export type LocalTaskPhase = 'consent' | 'installing' | 'running' | 'streaming' | 'paused' | 'cancelling';

export interface LocalTaskInfo {
  id: string;
  bot: LocalBotIdentity;
  capability: LocalCapabilityId;
  operation: LocalOperation | 'tools.prepare';
  phase: LocalTaskPhase;
  startedAt: number;
}

export interface LocalExecutionSnapshot {
  supported: boolean;
  tools: LocalToolInfo[];
  permissions: LocalPermissionInfo[];
  tasks: LocalTaskInfo[];
  toolsBytes: number;
  cacheBytes: number;
}

export type LocalExecutionMutationResult =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | LocalExecutionFailedResult;

export const localPermissionChangeSchema = z.object({
  permissionId: identifier,
  enabled: z.boolean(),
}).strict();
export type LocalPermissionChange = z.infer<typeof localPermissionChangeSchema>;

export const localToolReceiptSchema = z.object({
  id: localToolIdSchema,
  version: z.string().min(1).max(128),
  artifactName: z.string().min(1).max(256),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.string().max(2048).url(),
  sizeBytes: bytes,
  installedAt: z.number().int().positive(),
}).strict();
export type LocalToolReceipt = z.infer<typeof localToolReceiptSchema>;
