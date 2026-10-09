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

/** Voters shown beside each answer; the complete list is requested separately. */
export const NATIVE_POLL_VOTER_PREVIEW_LIMIT = 10;
const MAX_POLL_VOTES = 10_000;

export const nativePollVoterSchema = z.object({
  userId: id,
  userNickname: z.string().max(128),
  userAvatarUrl: z.string().max(512).nullable(),
}).strict();

export const nativePollOptionSchema = z.object({
  id,
  label: z.string().trim().min(1).max(80),
  emoji: reactionEmojiSchema.nullable(),
  votes: z.number().int().min(0).max(MAX_POLL_VOTES),
  /** Earliest voters of this answer. Absent from anonymous polls and servers without `poll-voters`. */
  voters: z.array(nativePollVoterSchema).max(NATIVE_POLL_VOTER_PREVIEW_LIMIT).optional(),
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
  totalVotes: z.number().int().min(0).max(MAX_POLL_VOTES),
  myVoteOptionIds: z.array(id).max(10).nullable(),
  /** Absent when the server does not negotiate `poll-voters`; voters are then unknown. */
  anonymousVotes: z.boolean().optional(),
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
  /** Requires `poll-voters`; older servers reject the field. */
  anonymousVotes: z.boolean().optional(),
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

/** The complete answer set of one member. An empty set withdraws the vote (`poll-voters` only). */
export const nativePollVoteSchema = z.object({
  id,
  optionIds: z.array(id).max(10).refine(values => new Set(values).size === values.length),
}).strict();

export const nativePollIdSchema = z.object({ id }).strict();

/** Every field of an open poll can change; `planNativePollEdit` says which votes survive. */
export const nativePollEditSchema = z.object({
  id,
  /** Revision the editor reviewed; votes that arrived since are never discarded without a new review. */
  expectedRevision: z.number().int().nonnegative(),
  question: z.string().trim().min(1).max(200),
  /** Answers with an `id` keep it, and their votes unless the text changes; the rest are new. */
  options: z.array(z.object({
    id: id.optional(),
    label: z.string().trim().min(1).max(80),
    emoji: reactionEmojiSchema.nullable(),
  }).strict()).min(2).max(10),
  allowMultiple: z.boolean(),
  anonymousVotes: z.boolean(),
  /** Kept images by URL and newly staged ones by reference, in display order. */
  images: z.array(z.union([communityImageUrlSchema, communityImageAssetRefSchema])).max(LIMITS.MAX_LIVE_ACTION_IMAGES),
  /** Counted from the edit. `null` removes the deadline; omitting it keeps the current one. */
  durationMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
  maxVoters: z.number().int().min(1).max(10_000).nullable(),
  liveAction: z.boolean(),
  audience: resourceAudienceSchema,
}).strict().superRefine((poll, ctx) => {
  if (new Set(poll.options.map(option => option.label.toLocaleLowerCase())).size !== poll.options.length) {
    ctx.addIssue({ code: 'custom', message: 'Poll options must be unique.', path: ['options'] });
  }
  const ids = poll.options.flatMap(option => option.id ? [option.id] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Poll options must be unique.', path: ['options'] });
});

export interface NativePollEditPlan {
  /** Every vote is discarded: the question changed, or secret votes would become public. */
  resetAll: 'question' | 'anonymity' | null;
  /** Kept answers whose text changed; only their votes are discarded. */
  relabeledOptionIds: string[];
  /** Existing answers left out of the edit, together with their votes. */
  removedOptionIds: string[];
  /** Members with several answers lose their vote once the poll accepts a single one. */
  singleAnswer: boolean;
}

export function planNativePollEdit(
  current: {
    question: string; allowMultiple: boolean; anonymousVotes?: boolean;
    options: ReadonlyArray<{ id: string; label: string }>;
  },
  next: {
    question: string; allowMultiple: boolean; anonymousVotes: boolean;
    options: ReadonlyArray<{ id?: string; label: string }>;
  },
): NativePollEditPlan {
  const kept = new Map(next.options.flatMap(option => option.id ? [[option.id, option.label.trim()] as const] : []));
  return {
    resetAll: current.question.trim() !== next.question.trim() ? 'question'
      : current.anonymousVotes === true && !next.anonymousVotes ? 'anonymity' : null,
    relabeledOptionIds: current.options
      .filter(option => kept.has(option.id) && kept.get(option.id) !== option.label.trim()).map(option => option.id),
    removedOptionIds: current.options.filter(option => !kept.has(option.id)).map(option => option.id),
    singleAnswer: current.allowMultiple && !next.allowMultiple,
  };
}

export const nativePollVotersSchema = z.object({
  id,
  options: z.array(z.object({
    id,
    voters: z.array(nativePollVoterSchema).max(MAX_POLL_VOTES),
  }).strict()).min(2).max(10),
}).strict();

export type NativePoll = z.infer<typeof nativePollSchema>;
export type NativePollVoter = z.infer<typeof nativePollVoterSchema>;
export type NativePollCreate = z.input<typeof nativePollCreateSchema>;
export type NativePollVote = z.infer<typeof nativePollVoteSchema>;
export type NativePollVoters = z.infer<typeof nativePollVotersSchema>;
export type NativePollEdit = z.input<typeof nativePollEditSchema>;

/**
 * Broadcast updates carry no personal vote. A selection kept from an earlier
 * update must drop answers an edit reset or removed (they have new ids) and, once
 * the poll accepts a single answer, a set the server already discarded.
 */
export function survivingNativePollSelection(
  poll: Pick<NativePoll, 'options' | 'allowMultiple'>,
  selection: readonly string[] | null,
): string[] | null {
  if (selection === null) return null;
  const valid = selection.filter(optionId => poll.options.some(option => option.id === optionId));
  return !poll.allowMultiple && valid.length > 1 ? [] : valid;
}

/** Shape understood by clients without `poll-voters`, whose strict schema rejects the new fields. */
export function legacyNativePoll(poll: NativePoll): NativePoll {
  const { anonymousVotes: _anonymousVotes, ...legacy } = poll;
  return { ...legacy, options: poll.options.map(({ voters: _voters, ...option }) => option) };
}
