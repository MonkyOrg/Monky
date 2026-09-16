/**
 * Control and media contracts for client-local bot execution.
 *
 * Source contexts retain the original physical executor independently of voice
 * membership. Tasks bind the current authenticated sockets, never a saved Main
 * permit or a replacement device. Admission, consent and membership must be
 * rechecked by the owners after asynchronous work.
 * Streams require both current endpoints in the specified voice room. A
 * reconnect can use a retained source only through a fresh task and consent on
 * that original physical session; it cannot revive a task or media generation.
 *
 * Private ICE reachability is required in either room mode. SFU alone does not
 * provide this separate path. Use only the server's authorized ICE configuration;
 * never fall back to WebSocket audio, another executor or bot impersonation.
 */
import { z } from 'zod';
import { LIMITS } from './constants.js';
import { botVoiceAuthSchema, botVoiceSignalSchema } from './botVoice.js';
import {
  LOCAL_CAPABILITY_IDS,
  LOCAL_EXECUTION_RUNTIME_LIMITS,
  localBotIdentitySchema,
  localCapabilityIdSchema,
  localExecutionFailureSchema,
  localMediaTrackSchema,
  localRuntimeSourceFailureSchema,
  localTaskSpecSchema,
  localYoutubeUrlSchema,
  type LocalCapabilityId,
  type LocalOperation,
  type LocalTaskSpec,
} from './localExecution.js';

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uint32 = z.number().int().min(0).max(0xffffffff);
const generation = uint32.min(1);

export const LOCAL_EXECUTION_PROTOCOL_LIMITS = {
  sourceContextsPerBot: 1000,
  tasksPerExecutor: 4,
  tasksPerBot: 16,
  sourceContextTtlMs: 24 * 60 * 60_000,
  taskStartTimeoutMs: 45_000,
  mediaConnectTimeoutMs: 20_000,
  queuedSignals: 128,
  iceCandidates: 256,
  recoveryAttempts: LOCAL_EXECUTION_RUNTIME_LIMITS.sourceRecoveryAttempts,
} as const;

export const LOCAL_OPERATION_CAPABILITY: Readonly<Record<LocalOperation, LocalCapabilityId>> = {
  'youtube.search': 'youtube-audio',
  'youtube.resolve': 'youtube-audio',
  'youtube.preview': 'youtube-audio',
  'youtube.stream': 'youtube-audio',
};

export const localCapabilitiesSchema = z.array(localCapabilityIdSchema).max(LOCAL_CAPABILITY_IDS.length)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length, 'Duplicate local capability');

export const commandLocalMetadataSchema = z.object({
  localCapabilities: localCapabilitiesSchema.optional(),
  botPublicKey: localBotIdentitySchema.shape.botPublicKey.optional(),
}).strict().refine((metadata) => !metadata.localCapabilities?.length || metadata.botPublicKey !== undefined, {
  path: ['botPublicKey'], message: 'Local commands require the authenticated bot public key',
});
export type CommandLocalMetadata = z.infer<typeof commandLocalMetadataSchema>;

/** Public readiness hint, not proof of consent. Main permits and subjects stay on the client. */
export const localCommandPreparationSchema = z.object({
  capability: localCapabilityIdSchema,
}).strict();
export type LocalCommandPreparation = z.infer<typeof localCommandPreparationSchema>;

/** Project a prepared capability without serializing its native authorization or identity. */
export function toLocalCommandPreparation(
  prepared: { readonly capability: LocalCapabilityId },
): LocalCommandPreparation {
  return localCommandPreparationSchema.parse({ capability: prepared.capability });
}

export const commandCallerContextSchema = z.object({
  botId: identifier,
  channelId: identifier,
  invokerId: identifier,
  invokerSessionId: identifier,
  invokerNickname: z.string().min(1).max(LIMITS.MAX_NICKNAME_LENGTH),
  invokerVoiceChannelId: identifier.nullable(),
}).strict();
export type CommandCallerContext = z.infer<typeof commandCallerContextSchema>;

export const localRequestContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invocation'), invocationId: identifier }).strict(),
  z.object({ kind: z.literal('autocomplete'), requestId: identifier }).strict(),
  z.object({ kind: z.literal('audio-preview'), requestId: identifier }).strict(),
  z.object({ kind: z.literal('source'), sourceContextId: identifier }).strict(),
]);
export type LocalRequestContext = z.infer<typeof localRequestContextSchema>;

export const localSourceRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retain'), invocationId: identifier, url: localYoutubeUrlSchema }).strict(),
  z.object({ action: z.literal('release'), sourceContextId: identifier }).strict(),
  z.object({ action: z.literal('check'), sourceContextId: identifier, voiceChannelId: identifier }).strict(),
]);
export type LocalSourceRequest = z.infer<typeof localSourceRequestSchema>;

/** Server-issued metadata, not a live task, Main permit or transferable grant. */
export const localSourceContextSchema = z.object({
  sourceContextId: identifier,
  botId: identifier,
  botPublicKey: localBotIdentitySchema.shape.botPublicKey,
  invokerId: identifier,
  invokerSessionId: identifier,
  originChannelId: identifier,
  capability: localCapabilityIdSchema,
  provider: z.literal('youtube-local'),
  url: localYoutubeUrlSchema,
  expiresAt: timestamp,
}).strict();
export type LocalSourceContext = z.infer<typeof localSourceContextSchema>;

export const localSourceResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('retained'), source: localSourceContextSchema }).strict(),
  z.object({ status: z.literal('released'), sourceContextId: identifier }).strict(),
  z.object({ status: z.literal('available'), sourceContextId: identifier, voiceChannelId: identifier }).strict(),
]);
export type LocalSourceResult = z.infer<typeof localSourceResultSchema>;

export function localTaskMatchesSource(source: LocalSourceContext, spec: LocalTaskSpec): boolean {
  return LOCAL_OPERATION_CAPABILITY[spec.operation] === source.capability &&
    spec.operation !== 'youtube.search' && spec.url === source.url;
}

/** requestId is the original executor-side request correlation, not a bot-chosen identity. */
export const localPreviewReferenceSchema = z.object({
  localPreviewId: identifier,
  taskId: identifier,
  requestId: identifier,
  executorSessionId: identifier,
}).strict();
export type LocalPreviewReference = z.infer<typeof localPreviewReferenceSchema>;

// Preview bytes are deliberately absent: LocalTaskResult is a different, IPC-only contract.
export const localWireTaskResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('youtube.search'),
    tracks: z.array(localMediaTrackSchema).max(LIMITS.MAX_BOT_AUTOCOMPLETE_CHOICES),
  }).strict(),
  z.object({ operation: z.literal('youtube.resolve'), track: localMediaTrackSchema }).strict(),
  localPreviewReferenceSchema.extend({ operation: z.literal('youtube.preview') }).strict(),
  z.object({ operation: z.literal('youtube.stream'), track: localMediaTrackSchema }).strict(),
]);
export type LocalWireTaskResult = z.infer<typeof localWireTaskResultSchema>;
export type LocalWirePreviewResult = Extract<LocalWireTaskResult, { operation: 'youtube.preview' }>;

export const LOCAL_MEDIA_PROTOCOL = 'opus-datachannel-v1';
export const LOCAL_MEDIA_CHANNEL_LABEL = 'monky.local-audio.v1';
export const LOCAL_MEDIA_CHANNEL_OPTIONS = {
  ordered: true,
  protocol: LOCAL_MEDIA_PROTOCOL,
} as const;
export const LOCAL_MEDIA_FORMAT = {
  codec: 'opus',
  sampleRate: 48000,
  channels: 2,
  frameDurationMs: 20,
  samplesPerFrame: 960,
  maxPacketBytes: 1275,
  creditWindowFrames: 25,
  creditWindowMs: 500,
  maxFrameSequence: 0xfffffffe,
  maxFrameCount: 0xffffffff,
} as const;

const localIceServersSchema = z.array(botVoiceAuthSchema.shape.iceServers.element.strict()).max(16);
export const localMediaGenerationSchema = z.object({
  protocol: z.literal(LOCAL_MEDIA_PROTOCOL),
  generation,
  iceServers: localIceServersSchema,
}).strict();
export type LocalMediaGeneration = z.infer<typeof localMediaGenerationSchema>;

function checkVoiceScope(spec: LocalTaskSpec, voiceChannelId: string | undefined, ctx: z.RefinementCtx): void {
  if ((spec.operation === 'youtube.stream') !== (voiceChannelId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['voiceChannelId'], message: 'Only streams require a voice channel' });
  }
}

export const localTaskRequestSchema = z.object({
  context: localRequestContextSchema,
  spec: localTaskSpecSchema,
  voiceChannelId: identifier.optional(),
}).strict().superRefine((request, ctx) => checkVoiceScope(request.spec, request.voiceChannelId, ctx));
export type LocalTaskRequest = z.infer<typeof localTaskRequestSchema>;

/**
 * Server reservation sent to both endpoints before relaying any private SDP.
 * The bot's envelope requestId correlates its pending task request; payload
 * requestId remains the original client correlation. The executor's unsolicited
 * envelope omits requestId so it cannot settle an ordinary command/preview RPC.
 * ICE is authorized for the recipient, so the bot need not wait for acceptance
 * or reuse expired auth ICE.
 *
 * After current Main preparation, the executor connects its private PC/channel
 * before starting native stream processing. Signals therefore route while the
 * task is pending. The executor derives origin/connectionId from its own socket.
 */
export const localTaskOfferSchema = z.object({
  taskId: identifier,
  /** Original executor UI correlation, or a fresh server correlation for retained-source work. */
  requestId: identifier,
  context: localRequestContextSchema,
  bot: localBotIdentitySchema.omit({ serverOrigin: true }).strict(),
  botSessionId: identifier,
  invokerId: identifier,
  invokerSessionId: identifier,
  capability: localCapabilityIdSchema,
  spec: localTaskSpecSchema,
  expiresAt: timestamp,
  voiceChannelId: identifier.optional(),
  media: localMediaGenerationSchema.optional(),
}).strict().superRefine((offer, ctx) => {
  checkVoiceScope(offer.spec, offer.voiceChannelId, ctx);
  if (offer.capability !== LOCAL_OPERATION_CAPABILITY[offer.spec.operation]) {
    ctx.addIssue({ code: 'custom', path: ['capability'], message: 'Capability does not authorize the operation' });
  }
  if ((offer.spec.operation === 'youtube.stream') !== (offer.media !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['media'], message: 'Only streams require private media negotiation' });
  }
});
export type LocalTaskOffer = z.infer<typeof localTaskOfferSchema>;

function checkPreviewTask(taskId: string, result: LocalWireTaskResult, ctx: z.RefinementCtx): void {
  if (result.operation === 'youtube.preview' && result.taskId !== taskId) {
    ctx.addIssue({ code: 'custom', path: ['result', 'taskId'], message: 'Preview belongs to another task' });
  }
}

/** Main has started the task; this does not claim that private media is connected. */
export const localTaskAcceptSchema = z.object({
  taskId: identifier,
  result: localWireTaskResultSchema,
}).strict().superRefine((accept, ctx) => checkPreviewTask(accept.taskId, accept.result, ctx));
export type LocalTaskAccept = z.infer<typeof localTaskAcceptSchema>;

export function localTaskAcceptMatchesOffer(offer: LocalTaskOffer, accept: LocalTaskAccept): boolean {
  if (offer.taskId !== accept.taskId || offer.spec.operation !== accept.result.operation) return false;
  if (accept.result.operation === 'youtube.preview') {
    return accept.result.taskId === offer.taskId && accept.result.requestId === offer.requestId &&
      accept.result.executorSessionId === offer.invokerSessionId;
  }
  if (accept.result.operation === 'youtube.search') return true;
  return offer.spec.operation !== 'youtube.search' && accept.result.track.url === offer.spec.url;
}

export const localTaskControlSchema = z.object({
  taskId: identifier,
  revision: uint32,
  action: z.enum(['pause', 'resume', 'cancel']),
}).strict();
export type LocalTaskControl = z.infer<typeof localTaskControlSchema>;

export const localTaskCancellationCauseSchema = z.enum([
  'requested',
  'requester_left_voice',
  'requester_disconnected',
  'bot_left_voice',
  'bot_disconnected',
  'permission_revoked',
  'source_released',
  'voice_mode_changed',
  'expired',
  'server_shutdown',
]);
export type LocalTaskCancellationCause = z.infer<typeof localTaskCancellationCauseSchema>;
export const localTaskFailureReasonSchema = localExecutionFailureSchema.exclude(['cancelled', 'permission_revoked']);
export type LocalTaskFailureReason = z.infer<typeof localTaskFailureReasonSchema>;

export const localSourceFailureSchema = localRuntimeSourceFailureSchema;
export type LocalSourceFailure = z.infer<typeof localSourceFailureSchema>;

/**
 * Routing validates the reporting endpoint and current task/generation.
 * Endpoint ready reports may precede Main acceptance. The server publishes
 * accepted, then ready only after valid acceptance AND both endpoints report
 * their private peer connection/channel open. Only then may credit/media flow.
 * Stream completion requires the same-channel EOF/drain ACK and played count.
 * Voice/socket/expiry cancellation causes are server-owned, not endpoint claims.
 */
export const localTaskEventSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('accepted'), taskId: identifier, result: localWireTaskResultSchema,
    media: localMediaGenerationSchema.optional(),
  }).strict(),
  z.object({ state: z.literal('ready'), taskId: identifier, mediaGeneration: generation }).strict(),
  z.object({ state: z.literal('paused'), taskId: identifier, revision: uint32 }).strict(),
  z.object({ state: z.literal('resumed'), taskId: identifier, revision: uint32 }).strict(),
  z.object({
    state: z.literal('completed'), taskId: identifier,
    mediaGeneration: generation.optional(), playedFrames: uint32.optional(),
  }).strict(),
  z.object({
    state: z.literal('failed'), taskId: identifier, reason: localTaskFailureReasonSchema,
    sourceFailure: localSourceFailureSchema.optional(),
  }).strict(),
  z.object({ state: z.literal('cancelled'), taskId: identifier, cause: localTaskCancellationCauseSchema }).strict(),
]).superRefine((event, ctx) => {
  if (event.state === 'accepted') {
    checkPreviewTask(event.taskId, event.result, ctx);
    if ((event.result.operation === 'youtube.stream') !== (event.media !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['media'], message: 'Only streams require private media negotiation' });
    }
  }
  if (event.state === 'completed' && (event.mediaGeneration === undefined) !== (event.playedFrames === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['playedFrames'], message: 'Stream completion requires generation and played count' });
  }
});
export type LocalTaskEvent = z.infer<typeof localTaskEventSchema>;

export function isLocalMediaSdp(sdp: string): boolean {
  const media = sdp.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => /^m\s*=/i.test(line));
  if (media.length !== 1) return false;
  const fields = media[0].trim().split(/\s+/);
  return fields.length === 4 && fields[0] === 'm=application' &&
    /^(?:0|[1-9]\d{0,4})$/.test(fields[1]) && Number(fields[1]) <= 65535 &&
    fields[2] === 'UDP/DTLS/SCTP' && fields[3] === 'webrtc-datachannel';
}

const dataSdp = botVoiceSignalSchema.shape.sdp.unwrap().shape.sdp
  .refine(isLocalMediaSdp, 'Expected one data-channel m-line and no audio/video media');
const localCandidateSchema = botVoiceSignalSchema.shape.candidate.unwrap().unwrap().strict();
/** The executor offers, the bot answers; either may send ICE. Routing supplies the other endpoint. */
export const localMediaSignalSchema = z.object({
  taskId: identifier,
  mediaGeneration: generation,
  signal: z.discriminatedUnion('signalType', [
    z.object({
      signalType: z.literal('offer'),
      sdp: z.object({ type: z.literal('offer'), sdp: dataSdp }).strict(),
    }).strict(),
    z.object({
      signalType: z.literal('answer'),
      sdp: z.object({ type: z.literal('answer'), sdp: dataSdp }).strict(),
    }).strict(),
    z.object({ signalType: z.literal('candidate'), candidate: localCandidateSchema.nullable() }).strict(),
  ]),
}).strict();
export type LocalMediaSignal = z.infer<typeof localMediaSignalSchema>;

export interface LocalMediaChannelParameters {
  label: string;
  protocol: string;
  ordered: boolean;
  maxPacketLifeTime?: number | null;
  maxRetransmits?: number | null;
}

export function assertLocalMediaChannel(channel: LocalMediaChannelParameters): void {
  if (channel.label !== LOCAL_MEDIA_CHANNEL_LABEL || channel.protocol !== LOCAL_MEDIA_PROTOCOL ||
      channel.ordered !== true || channel.maxPacketLifeTime != null || channel.maxRetransmits != null) {
    throw new TypeError('Expected the fixed reliable, ordered local Opus data channel');
  }
}

/** The existing publisher's encoded-duration contract, not a full Opus decoder. */
export function isLocalOpusPacket(frame: Uint8Array): boolean {
  if (!(frame instanceof Uint8Array) || frame.length < 1 || frame.length > LOCAL_MEDIA_FORMAT.maxPacketBytes) return false;
  const config = frame[0] >> 3;
  const samples = config >= 16 ? 120 << (config & 3)
    : config >= 12 ? 480 << (config & 1)
    : (config & 3) === 3 ? 2880 : 480 << (config & 3);
  const code = frame[0] & 3;
  const count = code === 0 ? 1 : code === 3 ? (frame[1] ?? 0) & 0x3f : 2;
  return count > 0 && count * samples === LOCAL_MEDIA_FORMAT.samplesPerFrame;
}

export const LOCAL_MEDIA_RECORD_KIND = { frame: 1, credit: 2, end: 3, drainAck: 4, played: 5 } as const;
export const LOCAL_MEDIA_MAX_RECORD_BYTES = 5 + LOCAL_MEDIA_FORMAT.maxPacketBytes;
export const localMediaRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('frame'),
    sequence: uint32.max(LOCAL_MEDIA_FORMAT.maxFrameSequence),
    opus: z.instanceof(Uint8Array).refine(isLocalOpusPacket, 'Expected one 1-1275 byte, 20 ms Opus packet'),
  }).strict(),
  z.object({ kind: z.literal('credit'), consumedFrames: uint32, windowEnd: uint32 }).strict(),
  z.object({ kind: z.literal('end'), finalSequence: uint32 }).strict(),
  z.object({ kind: z.literal('drainAck'), finalSequence: uint32 }).strict(),
  z.object({ kind: z.literal('played'), playedFrames: uint32 }).strict(),
]).superRefine((record, ctx) => {
  if (record.kind === 'credit' && (record.windowEnd < record.consumedFrames ||
      record.windowEnd - record.consumedFrames > LOCAL_MEDIA_FORMAT.creditWindowFrames)) {
    ctx.addIssue({ code: 'custom', path: ['windowEnd'], message: 'Absolute credit window exceeds 25 frames' });
  }
});
export type LocalMediaRecord = z.infer<typeof localMediaRecordSchema>;

/** uint32 fields are big-endian; finalSequence is exclusive (the total frame count). */
export function encodeLocalMediaRecord(input: LocalMediaRecord): Uint8Array {
  const record = localMediaRecordSchema.parse(input);
  const length = record.kind === 'frame' ? 5 + record.opus.length : record.kind === 'credit' ? 9 : 5;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes[0] = LOCAL_MEDIA_RECORD_KIND[record.kind];
  switch (record.kind) {
    case 'frame':
      view.setUint32(1, record.sequence, false);
      bytes.set(record.opus, 5);
      break;
    case 'credit':
      view.setUint32(1, record.consumedFrames, false);
      view.setUint32(5, record.windowEnd, false);
      break;
    case 'played':
      view.setUint32(1, record.playedFrames, false);
      break;
    case 'end':
    case 'drainAck':
      view.setUint32(1, record.finalSequence, false);
      break;
  }
  return bytes;
}

export function decodeLocalMediaRecord(bytes: Uint8Array): LocalMediaRecord {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5 || bytes.byteLength > LOCAL_MEDIA_MAX_RECORD_BYTES) {
    throw new RangeError('Invalid local media record length');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getUint32(1, false);
  const kind = bytes[0];
  if (kind === LOCAL_MEDIA_RECORD_KIND.frame) {
    return localMediaRecordSchema.parse({ kind: 'frame', sequence: value, opus: Uint8Array.from(bytes.subarray(5)) });
  }
  if (bytes.byteLength !== (kind === LOCAL_MEDIA_RECORD_KIND.credit ? 9 : 5)) {
    throw new RangeError('Invalid local media control length');
  }
  switch (kind) {
    case LOCAL_MEDIA_RECORD_KIND.credit:
      return localMediaRecordSchema.parse({ kind: 'credit', consumedFrames: value, windowEnd: view.getUint32(5, false) });
    case LOCAL_MEDIA_RECORD_KIND.end:
      return { kind: 'end', finalSequence: value };
    case LOCAL_MEDIA_RECORD_KIND.drainAck:
      return { kind: 'drainAck', finalSequence: value };
    case LOCAL_MEDIA_RECORD_KIND.played:
      return { kind: 'played', playedFrames: value };
    default:
      throw new TypeError('Unknown local media record kind');
  }
}

/** One fresh, owner-held state per task/media generation. Counts never wrap. */
export interface LocalMediaFlowState {
  readonly nextSequence: number;
  readonly consumedFrames: number;
  readonly windowEnd: number;
  readonly playedFrames: number;
  readonly finalSequence: number | null;
  readonly drained: boolean;
}

export function createLocalMediaFlowState(): LocalMediaFlowState {
  return { nextSequence: 0, consumedFrames: 0, windowEnd: 0, playedFrames: 0, finalSequence: null, drained: false };
}

/**
 * Apply both sent and received records in channel order. Credit accounts for
 * consumption from the bounded ingress queue; only PLAYED advances the source
 * playback checkpoint. PLAYED is the bot's playback clock, not proof that a
 * listener heard the audio.
 */
export function advanceLocalMediaFlow(
  state: LocalMediaFlowState, input: LocalMediaRecord, sender: 'executor' | 'bot'
): LocalMediaFlowState {
  const record = localMediaRecordSchema.parse(input);
  const fromExecutor = record.kind === 'frame' || record.kind === 'end';
  if ((sender !== 'executor' && sender !== 'bot') || (sender === 'executor') !== fromExecutor) {
    throw new TypeError('Local media record has the wrong sender');
  }
  if (state.drained) throw new Error('Local media generation has already drained');
  switch (record.kind) {
    case 'frame':
      if (state.finalSequence !== null || record.sequence !== state.nextSequence || record.sequence >= state.windowEnd) {
        throw new RangeError('Local media frame is out of sequence or credit');
      }
      return { ...state, nextSequence: state.nextSequence + 1 };
    case 'credit':
      if (record.consumedFrames < state.consumedFrames || record.consumedFrames > state.nextSequence ||
          record.windowEnd < state.windowEnd) {
        throw new RangeError('Local media credit is stale or acknowledges unsent frames');
      }
      return { ...state, consumedFrames: record.consumedFrames, windowEnd: record.windowEnd };
    case 'played':
      if (record.playedFrames < state.playedFrames || record.playedFrames > state.consumedFrames) {
        throw new RangeError('Local playback acknowledgment is stale or exceeds consumed frames');
      }
      return { ...state, playedFrames: record.playedFrames };
    case 'end':
      if (state.finalSequence !== null || record.finalSequence !== state.nextSequence) {
        throw new RangeError('Local media EOF does not match the final sequence');
      }
      return { ...state, finalSequence: record.finalSequence };
    case 'drainAck':
      if (state.finalSequence === null || record.finalSequence !== state.finalSequence ||
          state.playedFrames !== state.finalSequence) {
        throw new RangeError('Local media drain requires EOF and actual playback of every frame');
      }
      return { ...state, drained: true };
  }
}
