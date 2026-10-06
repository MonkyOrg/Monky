import { z } from 'zod';
import { nativePollSchema } from './nativePolls.js';
import { communityImageAssetRefSchema, communityImageUrlSchema } from './communityImages.js';
import { LIMITS } from './constants.js';
import { botFormSchema, botFormValuesSchema } from './botInteractions.js';
import { botCarouselPresentationSchema } from './botCarousels.js';
import { botLocaleSchema } from './botLocales.js';
import { nativeLiveFormSchema } from './nativeLiveForms.js';
import {
  PUBLIC_AUDIENCE,
  resourceAudienceProjectionSchema,
  resourceAudienceSchema,
} from './resourceAudience.js';

const id = z.string().min(1).max(128);
const timestamp = z.number().int().safe().nonnegative();
const image = z.string().max(7_000_000).nullable();
const imageUrl = z.string().regex(/^\/avatars\/[a-zA-Z0-9-]+\.(png|jpg|webp)$/).nullable();
export const communitySettingsSchema = z.object({
  eventsEnabled: z.boolean(),
  bannerUrl: imageUrl,
}).strict();
export const communitySettingsUpdateSchema = z.object({
  eventsEnabled: z.boolean().optional(),
  bannerBase64: image.optional(),
}).strict();

export const eventDefinitionSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(4000),
  location: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('voice'), channelId: id }).strict(),
    z.object({ kind: z.literal('text'), channelId: id }).strict(),
    z.object({ kind: z.literal('external'), label: z.string().trim().min(1).max(500) }).strict(),
  ]),
  startsAt: timestamp,
  endsAt: timestamp.nullable(),
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly']),
  timeZone: z.string().max(100).refine((zone) => {
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; }
    catch { return false; }
  }),
  audience: resourceAudienceSchema.optional().default(PUBLIC_AUDIENCE),
}).strict();
export const eventSaveSchema = eventDefinitionSchema.extend({
  id: id.optional(),
  expectedRevision: timestamp.optional(),
  imageBase64: image.optional(),
  imageSources: z.array(z.union([
    communityImageUrlSchema,
    z.string().min(1).max(7_000_000),
  ])).max(LIMITS.MAX_LIVE_ACTION_IMAGES).optional(),
}).superRefine((value, ctx) => {
  if (value.imageBase64 !== undefined && value.imageSources !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['imageSources'], message: 'Use one event image input format.' });
  }
  if (value.endsAt !== null && value.endsAt <= value.startsAt) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'The end must follow the start.' });
  }
  if (value.endsAt === null) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Events require an end time.' });
  }
  if (!!value.id !== (value.expectedRevision !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Editing requires the current revision.' });
  }
});
export const serverEventSchema = eventDefinitionSchema.extend({
  id,
  creatorUserId: id,
  imageUrl,
  imageUrls: z.array(communityImageUrlSchema).max(LIMITS.MAX_LIVE_ACTION_IMAGES).default([]),
  status: z.enum(['scheduled', 'active', 'ended', 'cancelled']),
  revision: timestamp,
  occurrence: timestamp,
  anchorStartsAt: timestamp,
  startedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  createdAt: timestamp,
}).strict();
export const serverEventPublicSchema = serverEventSchema.omit({ audience: true }).extend({
  audience: resourceAudienceProjectionSchema.optional().default(PUBLIC_AUDIENCE),
  interested: z.boolean(),
  interestedCount: timestamp,
}).strict();
export const eventControlSchema = z.object({
  id, expectedRevision: timestamp,
  action: z.enum(['start', 'end', 'cancel', 'delete']),
}).strict();
export const eventInterestSchema = z.object({ id, interested: z.boolean() }).strict();
export const eventIdRequestSchema = z.object({ id }).strict();
export const eventInterestedListSchema = z.object({
  id, cursor: id.optional(), limit: z.number().int().min(1).max(50).default(50),
}).strict();
export const eventInterestedListResultSchema = z.object({
  id,
  users: z.array(z.object({ id, nickname: z.string().min(1).max(128), avatarUrl: imageUrl }).strict()).max(50),
  nextCursor: id.nullable(),
}).strict();
export const eventResultSchema = z.object({ event: serverEventPublicSchema }).strict();
export const eventListSchema = z.object({ includeEnded: z.boolean().optional() }).strict();

export const liveActionContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selector'), selectorId: id }).strict(),
  z.object({ kind: z.literal('form'), form: botFormSchema }).strict(),
]);
const liveActionBaseDefinitionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(1000),
  content: liveActionContentSchema,
  imagePresentation: botCarouselPresentationSchema.optional(),
  expiresAt: timestamp,
  audience: resourceAudienceSchema.optional().default(PUBLIC_AUDIENCE),
}).strict();
export const liveActionDefinitionSchema = liveActionBaseDefinitionSchema.extend({
  imageAssetRefs: z.array(communityImageAssetRefSchema).max(LIMITS.MAX_LIVE_ACTION_IMAGES).optional(),
}).strict();
export const liveActionCreateSchema = liveActionDefinitionSchema.extend({
  id: id.optional(), channelId: id, invocationId: id,
}).strict();
export const liveActionRecordSchema = liveActionBaseDefinitionSchema.extend({
  id, channelId: id, botId: id, creatorUserId: id,
  imageUrls: z.array(communityImageUrlSchema).max(LIMITS.MAX_LIVE_ACTION_IMAGES).default([]),
  createdAt: timestamp, revision: timestamp,
}).strict();
export const liveActionSchema = liveActionRecordSchema.omit({ audience: true }).extend({
  audience: resourceAudienceProjectionSchema.optional().default(PUBLIC_AUDIENCE),
}).strict();
export const liveActionUpdateSchema = z.object({
  id, expectedRevision: timestamp,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  content: liveActionContentSchema.optional(),
  expiresAt: timestamp.optional(),
  audience: resourceAudienceSchema.optional(),
  imageAssetRefs: z.array(communityImageAssetRefSchema).max(LIMITS.MAX_LIVE_ACTION_IMAGES).optional(),
}).strict();
export const liveActionIdSchema = z.object({ id }).strict();
export const liveActionSubmitSchema = z.object({
  id, expectedRevision: timestamp, values: botFormValuesSchema, locale: botLocaleSchema,
}).strict();
export const liveActionSubmissionSchema = liveActionSubmitSchema.extend({
  submissionId: id, channelId: id, userId: id, userNickname: z.string().max(128),
}).strict();
export const communityImageUploadSchema = z.object({
  channelId: id,
  imageData: z.string().min(1).max(LIMITS.MAX_LIVE_ACTION_IMAGE_DATA_LENGTH),
}).strict();
export const communityImageUploadResultSchema = z.object({
  ref: communityImageAssetRefSchema,
  url: communityImageUrlSchema,
}).strict();
export const communitySnapshotSchema = z.object({
  settings: communitySettingsSchema,
  events: z.array(serverEventPublicSchema).max(200),
  liveActions: z.array(liveActionSchema).max(64),
  polls: z.array(nativePollSchema).max(64).default([]),
  nativeForms: z.array(nativeLiveFormSchema).max(64).default([]),
}).strict();
export const eventStartedSchema = z.object({
  event: serverEventPublicSchema,
}).strict();

export type CommunitySettings = z.infer<typeof communitySettingsSchema>;
export type CommunitySettingsUpdate = z.infer<typeof communitySettingsUpdateSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventPublic = z.infer<typeof serverEventPublicSchema>;
export type EventSave = z.input<typeof eventSaveSchema>;
export type EventControl = z.infer<typeof eventControlSchema>;
export type EventInterestedList = z.infer<typeof eventInterestedListSchema>;
export type EventInterestedListResult = z.infer<typeof eventInterestedListResultSchema>;
export type LiveAction = z.infer<typeof liveActionSchema>;
export type LiveActionRecord = z.infer<typeof liveActionRecordSchema>;
export type LiveActionCreate = z.input<typeof liveActionCreateSchema>;
export type LiveActionUpdate = z.infer<typeof liveActionUpdateSchema>;
export type LiveActionSubmission = z.infer<typeof liveActionSubmissionSchema>;
export type CommunitySnapshot = z.infer<typeof communitySnapshotSchema>;

function localParts(time: number, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(time);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((type) =>
    Number(parts.find((part) => part.type === type)?.value));
}

export function eventTimeInZone(local: string, timeZone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) throw new Error('Invalid local event time.');
  const desired = Date.parse(`${local}Z`);
  if (!Number.isFinite(desired)) throw new Error('Invalid local event time.');
  if (new Date(desired).toISOString().slice(0, local.length) !== local) throw new Error('Invalid local event time.');
  return resolveWallTime(desired, timeZone);
}

function resolveWallTime(desired: number, timeZone: string): number {
  let result = desired;
  let previous = result;
  for (let attempt = 0; attempt < 6; attempt++) {
    const [y, m, d, h, min, sec] = localParts(result, timeZone);
    const delta = desired - Date.UTC(y, m - 1, d, h, min, sec);
    if (delta === 0) return result;
    const next = result + delta;
    if (next === previous && attempt > 0) return Math.max(result, next);
    previous = result;
    result = next;
  }
  throw new Error('Could not resolve the event time zone.');
}

/** Calendar recurrence preserves the organizer's local time across DST changes. */
export function eventOccurrenceStart(event: Pick<ServerEvent, 'anchorStartsAt' | 'timeZone' | 'repeat'>, occurrence: number): number {
  if (event.repeat === 'none' || occurrence === 0) return event.anchorStartsAt;
  const [year, month, day, hour, minute, second] = localParts(event.anchorStartsAt, event.timeZone);
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (event.repeat === 'monthly') {
    local.setUTCDate(1);
    local.setUTCMonth(month - 1 + occurrence);
    const lastDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
    local.setUTCDate(Math.min(day, lastDay));
  } else {
    local.setUTCDate(day + occurrence * (event.repeat === 'weekly' ? 7 : 1));
  }
  return resolveWallTime(local.getTime(), event.timeZone);
}
