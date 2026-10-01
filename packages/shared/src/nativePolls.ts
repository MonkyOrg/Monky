import { z } from 'zod';
import { reactionEmojiSchema } from './reactions.js';
import { LIMITS } from './constants.js';
import { communityImageAssetRefSchema, communityImageUrlSchema } from './communityImages.js';
import {
  PUBLIC_AUDIENCE,
  resourceAudienceProjectionSchema,
  resourceAudienceSchema,
} from './resourceAudience.js';

const id = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative();
export { communityImageAssetRefSchema, communityImageUrlSchema } from './communityImages.js';

export const nativePollOptionSchema = z.object({
  id,
  label: z.string().trim().min(1).max(80),
  emoji: reactionEmojiSchema.nullable(),
  votes: z.number().int().min(0).max(10_000),
}).strict();

export const nativePollCreateOptionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  emoji: reactionEmojiSchema.nullable(),
}).strict();

export const nativePollSchema = z.object({
  id,
  messageId: id,
  channelId: id,
  creatorUserId: id,
  question: z.string().trim().min(1).max(200),
  allowMultiple: z.boolean(),
  imageUrls: z.array(communityImageUrlSchema).max(LIMITS.MAX_LIVE_ACTION_IMAGES),
  options: z.array(nativePollOptionSchema).min(2).max(10),
  totalVotes: z.number().int().min(0).max(10_000),
  myVoteOptionIds: z.array(id).max(10).nullable(),
  allowChange: z.boolean(),
  closesAt: timestamp.nullable(),
  maxVoters: z.number().int().min(1).max(10_000).nullable(),
  closedAt: timestamp.nullable(),
  liveAction: z.boolean(),
  createdAt: timestamp,
  revision: z.number().int().nonnegative(),
  audience: resourceAudienceProjectionSchema.optional().default(PUBLIC_AUDIENCE),
}).strict();

export const nativePollCreateSchema = z.object({
  channelId: id,
  clientMessageId: id.optional(),
  question: z.string().trim().min(1).max(200),
  options: z.array(nativePollCreateOptionSchema).min(2).max(10),
  allowMultiple: z.boolean().optional(),
  imageAssetRefs: z.array(communityImageAssetRefSchema).max(LIMITS.MAX_LIVE_ACTION_IMAGES).optional(),
  durationMinutes: z.number().int().min(1).max(43_200).optional(),
  maxVoters: z.number().int().min(1).max(10_000).optional(),
  liveAction: z.boolean().optional(),
  audience: resourceAudienceSchema.optional().default(PUBLIC_AUDIENCE),
}).strict().superRefine((poll, ctx) => {
  if (poll.durationMinutes === undefined && poll.maxVoters === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A duration or voter limit is required.' });
  }
  if (new Set(poll.options.map(option => option.label.toLocaleLowerCase())).size !== poll.options.length) {
    ctx.addIssue({ code: 'custom', message: 'Poll options must be unique.', path: ['options'] });
  }
});

export const nativePollVoteSchema = z.object({
  id,
  optionIds: z.array(id).min(1).max(10).refine(values => new Set(values).size === values.length),
}).strict();

export const nativePollIdSchema = z.object({ id }).strict();

export type NativePoll = z.infer<typeof nativePollSchema>;
export type NativePollCreate = z.input<typeof nativePollCreateSchema>;
export type NativePollVote = z.infer<typeof nativePollVoteSchema>;
