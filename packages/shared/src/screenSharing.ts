import { z } from 'zod';

const utf8 = new TextEncoder();
const reference = (bytes: number) => z.string().min(1).max(bytes)
  .refine(value => !value.includes('\0') && utf8.encode(value).byteLength <= bytes);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const screenShareIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
export const screenShareQualitySchema = z.enum(['source', '1080p60', '720p60', '480p30']);
export type ScreenShareQuality = z.infer<typeof screenShareQualitySchema>;

export const screenEncodingModeSchema = z.enum(['hardware', 'software']);
export type ScreenEncodingMode = z.infer<typeof screenEncodingModeSchema>;
export const screenEncodingStrategySchema = z.enum(['automatic', 'manual']);
export type ScreenEncodingStrategy = z.infer<typeof screenEncodingStrategySchema>;
export const screenCodecSchema = z.enum(['h264', 'av1']);
export type ScreenCodec = z.infer<typeof screenCodecSchema>;
export const screenCodecPreferenceSchema = z.enum(['auto', 'h264', 'av1']);
export type ScreenCodecPreference = z.infer<typeof screenCodecPreferenceSchema>;
export const screenEncoderSchema = z.enum([
  'h264_texture_amf', 'obs_nvenc_h264_tex', 'obs_x264',
  'av1_texture_amf', 'obs_nvenc_av1_tex', 'monky_aom_av1',
]);
export type ScreenEncoder = z.infer<typeof screenEncoderSchema>;
export interface ScreenEncodingSelection {
  mode: ScreenEncodingMode;
  codec: ScreenCodec;
  encoder: ScreenEncoder;
}
export interface ScreenEncodingAvailability {
  selection: ScreenEncodingSelection | null;
  hardware: { available: boolean; reason: string | null; error?: boolean };
  fallback: boolean;
  reason?: string;
}

export const nativeScreenCaptureModeSchema = z.enum(['normal', 'game']);
export type NativeScreenCaptureMode = z.infer<typeof nativeScreenCaptureModeSchema>;
export const nativeScreenCaptureStatusSchema = z.object({
  mode: nativeScreenCaptureModeSchema, ready: z.boolean(),
}).strict();
export type NativeScreenCaptureStatus = z.infer<typeof nativeScreenCaptureStatusSchema>;
// One Game Capture attempt, verified teardown and one Normal attempt, not an unlimited retry.
export const NATIVE_SCREEN_GAME_STARTUP_TIMEOUT_MS = 75000;

export const NATIVE_SCREEN_VIDEO_LIMITS = Object.freeze({
  width: 3840, height: 2160, fps: 240, maxBitrateKbps: 80000,
});

export const nativeScreenVideoProfileSchema = z.object({
  // libobs aligns output width to four pixels before encoding; reject silent truncation.
  width: z.number().int().min(4).max(NATIVE_SCREEN_VIDEO_LIMITS.width).multipleOf(4),
  height: z.number().int().min(2).max(NATIVE_SCREEN_VIDEO_LIMITS.height).multipleOf(2),
  fps: z.number().int().min(1).max(NATIVE_SCREEN_VIDEO_LIMITS.fps),
  maxBitrateKbps: z.number().int().min(150).max(NATIVE_SCREEN_VIDEO_LIMITS.maxBitrateKbps).multipleOf(50),
}).strict().refine(video => (video.width < NATIVE_SCREEN_VIDEO_LIMITS.width
  && video.height < NATIVE_SCREEN_VIDEO_LIMITS.height) || video.fps <= 120,
  '4K screen profiles support at most 120 FPS.');
export type NativeScreenVideoProfile = z.infer<typeof nativeScreenVideoProfileSchema>;

export function getScreenH264ProfileLevelId(profile: Readonly<NativeScreenVideoProfile>): '4d0033' | '4d0034' | '4d003c' {
  const video = nativeScreenVideoProfileSchema.parse(profile);
  const macroblocksPerSecond = Math.ceil(video.width / 16) * Math.ceil(video.height / 16) * video.fps;
  return macroblocksPerSecond <= 983040 ? '4d0033' : macroblocksPerSecond <= 2073600 ? '4d0034' : '4d003c';
}

/** Annex A lower bound for Main-tier, single-layer video; not proof of an encoder's actual sequence level. */
export function getScreenAv1MinimumLevelIndex(profile: Readonly<NativeScreenVideoProfile>): number {
  const video = nativeScreenVideoProfileSchema.parse(profile);
  // https://aomediacodec.github.io/av1-spec/#levels
  const levels = [
    [0, 147456, 2048, 1152, 4423680, 1500],
    [1, 278784, 2816, 1584, 8363520, 3000],
    [4, 665856, 4352, 2448, 19975680, 6000],
    [5, 1065024, 5504, 3096, 31950720, 10000],
    [8, 2359296, 6144, 3456, 70778880, 12000],
    [9, 2359296, 6144, 3456, 141557760, 20000],
    [12, 8912896, 8192, 4352, 267386880, 30000],
    [13, 8912896, 8192, 4352, 534773760, 40000],
    [14, 8912896, 8192, 4352, 1069547520, 60000],
    [17, 35651584, 16384, 8704, 2139095040, 100000],
  ] as const;
  const pixels = video.width * video.height;
  const level = levels.find(([, size, width, height, rate, bitrate]) => pixels <= size
    && video.width <= width && video.height <= height && pixels * video.fps <= rate && video.maxBitrateKbps <= bitrate);
  if (!level) throw new Error('The selected screen profile exceeds the supported AV1 level bounds.');
  return level[0];
}

export const nativeScreenRenditionSchema = z.object({
  sourceInstanceId: z.string().uuid(),
  pipelineId: z.string().uuid(),
  video: nativeScreenVideoProfileSchema,
}).strict();
export type NativeScreenRendition = z.infer<typeof nativeScreenRenditionSchema>;

export const screenShareAudienceSchema = z.object({
  userIds: z.array(reference(128)).max(256),
  roleIds: z.array(reference(128)).max(128),
}).strict().refine(value => value.userIds.length + value.roleIds.length > 0,
  'A private screen share requires at least one user or role.');
export type ScreenShareAudience = z.infer<typeof screenShareAudienceSchema>;

export const nativeScreenSourceSchema = z.object({
  shareId: screenShareIdSchema,
  instanceId: z.string().uuid(),
  video: nativeScreenVideoProfileSchema,
  audio: z.boolean(),
  /** Absent on legacy descriptors: H.264. Codec is independent of rendition geometry. */
  codec: screenCodecSchema.optional(),
  /** Omitted means public. Only the publisher receives the full access list. */
  audience: screenShareAudienceSchema.optional(),
}).strict();
export type NativeScreenSource = z.infer<typeof nativeScreenSourceSchema>;
export const screenViewersRequestSchema = z.object({
  channelId: reference(128), publisherSessionId: reference(128),
  shareId: screenShareIdSchema, sourceInstanceId: z.string().uuid().nullable(),
}).strict();
export const screenViewersResultSchema = screenViewersRequestSchema.extend({
  viewerSessionIds: z.array(reference(128)).max(1024),
}).strict();
export type ScreenViewersResult = z.infer<typeof screenViewersResultSchema>;
export const nativeScreenSourcesSchema = z.array(nativeScreenSourceSchema).max(2)
  .refine(sources => new Set(sources.map(source => source.shareId)).size === sources.length
    && new Set(sources.map(source => source.instanceId)).size === sources.length);

const qualityLimits: Readonly<Record<Exclude<ScreenShareQuality, 'source'>, NativeScreenVideoProfile>> = {
  '1080p60': { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 },
  '720p60': { width: 1280, height: 720, fps: 60, maxBitrateKbps: 6000 },
  '480p30': { width: 852, height: 480, fps: 30, maxBitrateKbps: 1500 },
};

export function getScreenShareProfile(
  source: Readonly<NativeScreenVideoProfile>, quality: ScreenShareQuality, codec: ScreenCodec = 'h264',
): Readonly<NativeScreenVideoProfile> {
  const maximum = nativeScreenVideoProfileSchema.parse(source);
  const selected = screenShareQualitySchema.parse(quality);
  // AMF AV1 otherwise pads four-pixel-aligned widths without signaling the intended visible width.
  const alignment = screenCodecSchema.parse(codec) === 'av1' ? 8 : 4;
  const limit = selected === 'source' ? maximum : qualityLimits[selected];
  return Object.freeze({
    width: Math.max(alignment, Math.floor(Math.min(maximum.width, limit.width) / alignment) * alignment),
    height: Math.min(maximum.height, limit.height),
    fps: Math.min(maximum.fps, limit.fps),
    maxBitrateKbps: Math.min(maximum.maxBitrateKbps, limit.maxBitrateKbps),
  });
}

export function screenShareProfileKey(profile: Readonly<NativeScreenVideoProfile>): string {
  return `${profile.width}x${profile.height}@${profile.fps}:${profile.maxBitrateKbps}`;
}

export function getScreenShareQualities(source: Readonly<NativeScreenVideoProfile>, codec: ScreenCodec = 'h264'): {
  quality: ScreenShareQuality; profile: Readonly<NativeScreenVideoProfile>;
}[] {
  const seen = new Set<string>();
  return screenShareQualitySchema.options.flatMap(quality => {
    const profile = getScreenShareProfile(source, quality, codec);
    const key = screenShareProfileKey(profile);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ quality, profile }];
  });
}

const controlEnvelope = z.object({
  protocol: z.literal('monky-native-screen-p2p'),
  version: z.union([z.literal(1), z.literal(2)]),
  callId: reference(128),
  channelId: reference(128),
  connectionId: reference(128),
  generation: positive,
});
const publicationIdentity = {
  shareId: screenShareIdSchema, publicationId: positive, publicationVersion: positive,
};
const publicationMetadata = {
  metadataVersion: positive, trackId: reference(256), mid: reference(256).nullable(),
  streamIds: z.array(reference(256)).max(8),
};
const watchFields = {
  ...publicationIdentity, metadataVersion: positive, subscriptionId: positive,
  revision: positive, watching: z.boolean(),
};
const videoSubscription = z.object({
  publicationId: positive, publicationVersion: positive, metadataVersion: positive,
  subscriptionId: positive, revision: positive,
}).strict();

export const nativeScreenP2pControlSchema = z.union([
  controlEnvelope.extend({ type: z.literal('negotiate'), requestVersion: positive }).strict(),
  controlEnvelope.extend({ type: z.literal('turn'), turn: positive, offererSessionId: reference(128) }).strict(),
  controlEnvelope.extend({ type: z.enum(['offer', 'answer']), turn: positive, sdp: reference(1024 * 1024) }).strict(),
  controlEnvelope.extend({ type: z.enum(['turn-applied', 'turn-done']), turn: positive }).strict(),
  controlEnvelope.extend({
    type: z.literal('ice'), turn: positive,
    candidate: z.string().max(8192).refine(value => !value.includes('\0') && utf8.encode(value).byteLength <= 8192),
    sdpMid: reference(128).nullable(), sdpMLineIndex: z.number().int().min(0).max(65535).nullable(),
  }).strict().refine(value => value.sdpMid !== null || value.sdpMLineIndex !== null),
  controlEnvelope.extend({
    version: z.literal(1), type: z.literal('publication'), ...publicationIdentity, ...publicationMetadata,
  }).strict(),
  controlEnvelope.extend({
    version: z.literal(2), type: z.literal('publication'), ...publicationIdentity, ...publicationMetadata,
    kind: z.enum(['video', 'audio']), syncGroup: reference(128),
  }).strict(),
  controlEnvelope.extend({
    version: z.literal(1), type: z.literal('unpublish'), ...publicationIdentity,
  }).strict(),
  controlEnvelope.extend({
    version: z.literal(2), type: z.literal('unpublish'), ...publicationIdentity, kind: z.enum(['video', 'audio']),
  }).strict(),
  controlEnvelope.extend({ version: z.literal(1), type: z.literal('watch'), ...watchFields }).strict(),
  controlEnvelope.extend({
    version: z.literal(2), type: z.literal('watch'), ...watchFields, kind: z.literal('video'),
  }).strict(),
  controlEnvelope.extend({
    version: z.literal(2), type: z.literal('watch'), ...watchFields, kind: z.literal('audio'), video: videoSubscription,
  }).strict(),
]);
export type NativeScreenP2pControl = z.infer<typeof nativeScreenP2pControlSchema>;

const signalEnvelope = z.object({
  fromSessionId: reference(128),
  targetSessionId: reference(128),
  publisherSessionId: reference(128),
  channelId: reference(128),
  shareId: screenShareIdSchema,
  sourceInstanceId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
});
export const nativeScreenFailureSchema = z.enum([
  'unsupported', 'source-unavailable', 'capture-failed', 'connection-failed', 'capacity-exceeded',
]);
export type NativeScreenFailure = z.infer<typeof nativeScreenFailureSchema>;

export const nativeScreenSignalSchema = z.discriminatedUnion('action', [
  signalEnvelope.extend({
    action: z.literal('watch'), quality: screenShareQualitySchema, backend: z.enum(['native', 'browser']),
  }).strict(),
  signalEnvelope.extend({
    action: z.literal('accepted'), quality: screenShareQualitySchema, backend: z.enum(['native', 'browser']),
    generation: positive,
  }).strict(),
  signalEnvelope.extend({
    action: z.literal('capture-mode'), generation: positive, capture: nativeScreenCaptureStatusSchema,
  }).strict(),
  signalEnvelope.extend({ action: z.literal('control'), control: nativeScreenP2pControlSchema }).strict(),
  signalEnvelope.extend({ action: z.literal('stop') }).strict(),
  signalEnvelope.extend({ action: z.literal('closed'), reason: nativeScreenFailureSchema }).strict(),
]).superRefine((value, context) => {
  if (value.fromSessionId === value.targetSessionId
    || ![value.fromSessionId, value.targetSessionId].includes(value.publisherSessionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A screen subscription requires two distinct participants.' });
  }
  const fromPublisher = value.fromSessionId === value.publisherSessionId;
  if ((['watch', 'stop'].includes(value.action) && fromPublisher)
    || (['accepted', 'capture-mode', 'closed'].includes(value.action) && !fromPublisher)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Screen subscription action has the wrong owner.' });
  }
  if (value.action === 'control') {
    const control = value.control;
    if (control.channelId !== value.channelId || control.callId !== value.sourceInstanceId
      || control.connectionId !== value.subscriptionId
      || ('shareId' in control && control.shareId !== value.shareId)
      || ('syncGroup' in control && control.syncGroup !== value.sourceInstanceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Native control escaped its screen subscription.' });
    }
  }
});
export type NativeScreenSignalPayload = z.infer<typeof nativeScreenSignalSchema>;

export const nativeScreenSignalAckSchema = z.object({
  subscriptionId: z.string().uuid(), accepted: z.literal(true),
}).strict();
