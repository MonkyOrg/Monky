import { z } from 'zod';
import { MessageType } from './protocol.js';
import {
  nativeScreenFailureSchema, nativeScreenRenditionSchema, nativeScreenSignalSchema,
  nativeScreenSourcesSchema, nativeScreenVideoProfileSchema, screenShareIdSchema, screenShareQualitySchema,
  type NativeScreenSource,
} from './screenSharing.js';

const reference = z.string().min(1).max(128).refine(value => !value.includes('\0')
  && new TextEncoder().encode(value).byteLength <= 128);
const uuid = z.string().uuid();
const callScope = z.object({ callId: uuid });

export const nativeScreenIceServersSchema = z.array(z.object({
  urls: z.array(z.string().min(1).max(2048).regex(/^(?:stun|stuns|turn|turns):[^\s\0]+$/)).min(1).max(4),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
}).strict()).max(8);

export const nativeScreenAudioPreferencesSchema = z.object({
  sinkId: z.string().max(512).refine(value => !value.includes('\0')),
  muted: z.boolean(), volume: z.number().finite().min(0).max(2),
}).strict();
export type NativeScreenAudioPreferences = z.infer<typeof nativeScreenAudioPreferencesSchema>;
export const nativeScreenAudioBitrateSchema = z.number().int().min(6).max(510);

function isBoundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let nodes = 0, bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || ++nodes > 8192 || item.depth > 24) return false;
    const current = item.value;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'number') { if (!Number.isFinite(current)) return false; continue; }
    if (typeof current === 'string') {
      bytes += new TextEncoder().encode(current).byteLength;
      if (bytes > 1024 * 1024) return false;
      continue;
    }
    if (typeof current !== 'object') return false;
    if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current))) return false;
    const keys = Object.keys(current);
    if (keys.length > 2048 || keys.some(key => key.length > 256)) return false;
    for (const entry of Object.values(current)) pending.push({ value: entry, depth: item.depth + 1 });
  }
  return true;
}
const json = z.unknown().refine(isBoundedJson, 'Native screen IPC requires bounded JSON data.');

export const nativeScreenRpcMethodSchema = z.enum([
  MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES, MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
  MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, MessageType.SFU_PRODUCE, MessageType.SFU_CONSUME,
  MessageType.SFU_PRODUCER_SET_PAUSED, MessageType.SFU_CONSUMER_SET_PAUSED,
  MessageType.SFU_PRODUCER_CLOSED, MessageType.SFU_CONSUMER_CLOSED, MessageType.SFU_CLOSE_WEBRTC_TRANSPORT,
  MessageType.SFU_GET_PRODUCERS,
]);
export type NativeScreenRpcMethod = z.infer<typeof nativeScreenRpcMethodSchema>;

export const nativeScreenProducerSchema = z.object({
  channelId: reference, producerId: reference, producerSessionId: reference,
  kind: z.enum(['audio', 'video']),
  appData: z.object({
    mediaType: z.enum(['screen_video', 'screen_audio']), shareId: screenShareIdSchema,
    nativeScreen: nativeScreenRenditionSchema,
  }).strict(),
}).strict().refine(value => value.kind === (value.appData.mediaType === 'screen_video' ? 'video' : 'audio'));
export type NativeScreenProducer = z.infer<typeof nativeScreenProducerSchema>;

export const nativeScreenCallSchema = callScope.extend({
  sessionId: reference, channelId: reference, mode: z.enum(['p2p', 'sfu']), iceServers: nativeScreenIceServersSchema,
}).strict();
export type NativeScreenCall = z.infer<typeof nativeScreenCallSchema>;
export const nativeScreenParticipantSchema = z.object({
  sessionId: reference, nativeScreenShares: nativeScreenSourcesSchema,
}).strict();
export type NativeScreenParticipant = z.infer<typeof nativeScreenParticipantSchema>;

export const nativeScreenCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capabilities') }).strict(),
  nativeScreenCallSchema.extend({ action: z.literal('join') }).strict(),
  callScope.extend({ action: z.literal('leave') }).strict(),
  callScope.extend({ action: z.literal('leave-local') }).strict(),
  callScope.extend({
    action: z.literal('participants'), participants: z.array(nativeScreenParticipantSchema).max(1024)
      .refine(values => new Set(values.map(value => value.sessionId)).size === values.length),
  }).strict(),
  callScope.extend({
    action: z.literal('source-add'), shareId: screenShareIdSchema,
    desktopSourceId: z.string().regex(/^window:[1-9][0-9]{0,15}:[0-9]{1,10}$/),
    video: nativeScreenVideoProfileSchema, audio: z.boolean(), audioBitrateKbps: nativeScreenAudioBitrateSchema,
  }).strict(),
  callScope.extend({ action: z.literal('source-remove'), shareId: screenShareIdSchema }).strict(),
  callScope.extend({
    action: z.literal('watch'), publisherSessionId: reference, shareId: screenShareIdSchema,
    quality: screenShareQualitySchema, presentationId: uuid, audio: nativeScreenAudioPreferencesSchema,
  }).strict(),
  callScope.extend({
    action: z.literal('watch-audio'), publisherSessionId: reference, shareId: screenShareIdSchema, presentationId: uuid,
    muted: z.boolean(), volume: z.number().finite().min(0).max(2),
  }).strict(),
  callScope.extend({
    action: z.literal('stop'), publisherSessionId: reference, shareId: screenShareIdSchema, presentationId: uuid,
  }).strict(),
  callScope.extend({ action: z.literal('signal'), signal: nativeScreenSignalSchema }).strict(),
  callScope.extend({ action: z.literal('producer'), producer: nativeScreenProducerSchema }).strict(),
  callScope.extend({ action: z.literal('producer-remove'), producerId: reference }).strict(),
  callScope.extend({ action: z.literal('stats') }).strict(),
  callScope.extend({
    action: z.literal('diagnostics'), publisherSessionId: reference, shareId: screenShareIdSchema,
    sourceInstanceId: uuid, presentationId: uuid.optional(),
  }).strict(),
]);
export type NativeScreenCommand = z.infer<typeof nativeScreenCommandSchema>;

export interface NativeScreenCapabilities {
  capture: boolean;
  captureAudio: boolean;
  receive: boolean;
  backend: 'libobs-amf' | null;
  reason: 'platform' | 'runtime' | 'encoder' | null;
}

const metric = z.number().finite().nonnegative();
const counter = metric.int().max(Number.MAX_SAFE_INTEGER);
const statsText = z.string().max(2048);
export const nativeScreenRtpReportTypeSchema = z.enum([
  'outbound-rtp', 'inbound-rtp', 'codec', 'media-source', 'transport', 'candidate-pair',
]);
// Only fields consumed by video diagnostics cross IPC; addresses and credentials do not.
export const nativeScreenRtpReportSchema = z.object({
  id: reference, type: nativeScreenRtpReportTypeSchema, timestamp: metric,
  kind: z.enum(['audio', 'video']).optional(), mediaType: z.enum(['audio', 'video']).optional(),
  active: z.boolean().optional(), powerEfficientEncoder: z.boolean().optional(),
  codecId: reference.optional(), mediaSourceId: reference.optional(), transportId: reference.optional(),
  selectedCandidatePairId: reference.optional(), trackIdentifier: reference.optional(), rid: reference.optional(),
  mimeType: statsText.optional(), sdpFmtpLine: statsText.optional(), encoderImplementation: statsText.optional(),
  decoderImplementation: statsText.optional(), qualityLimitationReason: z.enum(['none', 'cpu', 'bandwidth', 'other']).optional(),
  frameWidth: counter.optional(), frameHeight: counter.optional(), width: counter.optional(), height: counter.optional(),
  framesPerSecond: metric.optional(), bytesSent: counter.optional(), bytesReceived: counter.optional(),
  frames: counter.optional(), framesEncoded: counter.optional(), framesSent: counter.optional(),
  framesReceived: counter.optional(), framesDecoded: counter.optional(), framesDropped: counter.optional(),
  keyFramesEncoded: counter.optional(), packetsReceived: counter.optional(), packetsLost: z.number().int().safe().optional(),
  totalEncodeTime: metric.optional(), totalDecodeTime: metric.optional(), targetBitrate: metric.optional(),
  jitter: metric.optional(), jitterBufferDelay: metric.optional(), jitterBufferEmittedCount: counter.optional(),
  currentRoundTripTime: metric.optional(), availableOutgoingBitrate: metric.optional(),
});
export type NativeScreenRtpReport = z.infer<typeof nativeScreenRtpReportSchema>;

export const nativeScreenDecoderObservationSchema = z.object({
  sessionId: counter.positive(), completedCallbacks: counter, observedAtSteadyUs: counter,
  snapshotCopyMs: metric, clock: z.literal('process-steady-clock'), counterScope: z.literal('decoder-worker-lifetime'),
}).strict().refine(value => value.snapshotCopyMs * 1000 <= value.observedAtSteadyUs);
export type NativeScreenDecoderObservation = z.infer<typeof nativeScreenDecoderObservationSchema>;

export const nativeScreenEndpointDiagnosticsSchema = z.object({
  pipelineId: uuid, profile: nativeScreenVideoProfileSchema, readErrors: counter,
  rtp: z.array(z.object({
    id: reference, reports: z.array(nativeScreenRtpReportSchema).max(512),
  }).strict()).max(64),
  decoders: z.array(nativeScreenDecoderObservationSchema).max(64),
}).strict();
export type NativeScreenEndpointDiagnostics = z.infer<typeof nativeScreenEndpointDiagnosticsSchema>;

export type NativeScreenCommandResult =
  | { kind: 'ok' }
  | { kind: 'retired-with-errors'; remoteAcknowledged: boolean; error: string }
  | { kind: 'capabilities'; capabilities: NativeScreenCapabilities }
  | { kind: 'source'; source: NativeScreenSource }
  | { kind: 'subscription'; subscriptionId: string; presentationId: string }
  | { kind: 'diagnostics'; sourceInstanceId: string; presentationId: string | null; viewers: number | null;
    endpoints: readonly NativeScreenEndpointDiagnostics[] }
  | { kind: 'stats'; publishers: readonly unknown[]; subscriptions: readonly unknown[] };

const request = callScope.extend({ requestId: uuid });
export const nativeScreenEventSchema = z.discriminatedUnion('type', [
  request.extend({ type: z.literal('signal'), signal: nativeScreenSignalSchema }).strict(),
  request.extend({ type: z.literal('rpc'), method: nativeScreenRpcMethodSchema, payload: z.record(json).refine(isBoundedJson) }).strict(),
  request.extend({ type: z.literal('presentation-stop'), presentationId: uuid }).strict(),
  callScope.extend({
    type: z.literal('state'), publisherSessionId: reference, shareId: screenShareIdSchema,
    sourceInstanceId: uuid,
    presentationId: uuid.optional(), state: z.enum(['connecting', 'playing', 'closed', 'unavailable']),
    reason: nativeScreenFailureSchema.optional(),
  }).strict(),
  callScope.extend({
    type: z.literal('error'), publisherSessionId: reference, shareId: screenShareIdSchema.optional(),
    sourceInstanceId: uuid.optional(),
    presentationId: uuid.optional(), reason: nativeScreenFailureSchema, message: z.string().min(1).max(4096),
  }).strict(),
]);
export type NativeScreenEvent = z.infer<typeof nativeScreenEventSchema>;
export const nativeScreenReplySchema = z.discriminatedUnion('ok', [
  request.extend({ ok: z.literal(true), value: json }).strict(),
  request.extend({ ok: z.literal(false), error: z.string().min(1).max(4096) }).strict(),
]);
export type NativeScreenReply = z.infer<typeof nativeScreenReplySchema>;
export const nativeScreenPresentationSchema = z.object({
  presentationId: uuid, elementId: uuid,
}).strict();
export type NativeScreenPresentation = z.infer<typeof nativeScreenPresentationSchema>;
export interface NativeScreenPresentationSample {
  framesSubmitted: number;
  bridgeBusyDrops: number;
  presentedFrames: number | null;
  playbackStarted: boolean;
}
