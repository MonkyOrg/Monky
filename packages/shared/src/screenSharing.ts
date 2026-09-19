import { z } from 'zod';

const utf8 = new TextEncoder();
const reference = (bytes: number) => z.string().min(1).max(bytes)
  .refine(value => !value.includes('\0') && utf8.encode(value).byteLength <= bytes);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const screenShareIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
export const screenShareQualitySchema = z.enum(['source', '1080p60', '720p60', '480p30']);
export type ScreenShareQuality = z.infer<typeof screenShareQualitySchema>;

export const nativeScreenVideoProfileSchema = z.object({
  // libobs aligns output width to four pixels before encoding; reject silent truncation.
  width: z.number().int().min(4).max(1920).multipleOf(4),
  height: z.number().int().min(2).max(1080).multipleOf(2),
  fps: z.number().int().min(1).max(120),
  maxBitrateKbps: z.number().int().min(150).max(20000).multipleOf(50),
}).strict();
export type NativeScreenVideoProfile = z.infer<typeof nativeScreenVideoProfileSchema>;

export const nativeScreenRenditionSchema = z.object({
  sourceInstanceId: z.string().uuid(),
  pipelineId: z.string().uuid(),
  video: nativeScreenVideoProfileSchema,
}).strict();
export type NativeScreenRendition = z.infer<typeof nativeScreenRenditionSchema>;

export const nativeScreenSourceSchema = z.object({
  shareId: screenShareIdSchema,
  instanceId: z.string().uuid(),
  video: nativeScreenVideoProfileSchema,
  audio: z.boolean(),
}).strict();
export type NativeScreenSource = z.infer<typeof nativeScreenSourceSchema>;
export const nativeScreenSourcesSchema = z.array(nativeScreenSourceSchema).max(2)
  .refine(sources => new Set(sources.map(source => source.shareId)).size === sources.length
    && new Set(sources.map(source => source.instanceId)).size === sources.length);

const qualityLimits: Readonly<Record<Exclude<ScreenShareQuality, 'source'>, NativeScreenVideoProfile>> = {
  '1080p60': { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 },
  '720p60': { width: 1280, height: 720, fps: 60, maxBitrateKbps: 6000 },
  '480p30': { width: 852, height: 480, fps: 30, maxBitrateKbps: 1500 },
};

export function getScreenShareProfile(
  source: Readonly<NativeScreenVideoProfile>, quality: ScreenShareQuality,
): Readonly<NativeScreenVideoProfile> {
  const maximum = nativeScreenVideoProfileSchema.parse(source);
  const selected = screenShareQualitySchema.parse(quality);
  if (selected === 'source') return Object.freeze(maximum);
  const limit = qualityLimits[selected];
  return Object.freeze({
    width: Math.min(maximum.width, limit.width),
    height: Math.min(maximum.height, limit.height),
    fps: Math.min(maximum.fps, limit.fps),
    maxBitrateKbps: Math.min(maximum.maxBitrateKbps, limit.maxBitrateKbps),
  });
}

export function screenShareProfileKey(profile: Readonly<NativeScreenVideoProfile>): string {
  return `${profile.width}x${profile.height}@${profile.fps}:${profile.maxBitrateKbps}`;
}

export function getScreenShareQualities(source: Readonly<NativeScreenVideoProfile>): {
  quality: ScreenShareQuality; profile: Readonly<NativeScreenVideoProfile>;
}[] {
  const seen = new Set<string>();
  return screenShareQualitySchema.options.flatMap(quality => {
    const profile = getScreenShareProfile(source, quality);
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
    || (['accepted', 'closed'].includes(value.action) && !fromPublisher)) {
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
