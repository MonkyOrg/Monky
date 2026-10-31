import { z } from 'zod';
import { LIMITS } from './constants.js';
import type { ChatMessage } from './models.js';

const id = z.string().min(1).max(128);
/**
 * Where a page ends in the list's order: pinned first, then the time the order uses (`updatedAt`
 * for `latest`, `createdAt` otherwise), then the post id. The next page starts right after it,
 * so posts that move meanwhile neither push one out of it nor bring one back (`forum-cursor`).
 */
export const forumCursorSchema = z.object({
  pinned: z.boolean(),
  at: z.number().int().min(-8.64e15).max(8.64e15),
  channelId: id,
}).strict();
export const forumListSchema = z.object({
  channelId: id,
  query: z.string().trim().max(200).optional(),
  sort: z.enum(['latest', 'newest', 'oldest']).default('latest'),
  offset: z.number().int().min(0).max(100_000).default(0),
  /** Only sent to servers that negotiated `forum-cursor`; it then takes the place of `offset`. */
  after: forumCursorSchema.optional(),
}).strict();
export const forumCreatePostSchema = z.object({
  id: z.string().uuid(),
  channelId: id,
  title: z.string().trim().min(1).max(100),
  content: z.string().trim(),
  attachmentIds: z.array(id).max(LIMITS.MAX_ATTACHMENTS_PER_MESSAGE)
    .refine(ids => new Set(ids).size === ids.length).optional(),
}).strict().refine(value => !!value.content || !!value.attachmentIds?.length);
export const forumUpdatePostSchema = z.object({
  channelId: id,
  title: z.string().trim().min(1).max(100).optional(),
  pinned: z.boolean().optional(),
  locked: z.boolean().optional(),
  closed: z.boolean().optional(),
}).strict().refine(value =>
  value.title !== undefined || value.pinned !== undefined || value.locked !== undefined || value.closed !== undefined);
export const forumDeletePostSchema = z.object({ channelId: id }).strict();
export interface ForumPost {
  channelId: string;
  forumId: string;
  title: string;
  authorId: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  locked: boolean;
  closed: boolean;
  replyCount: number;
  preview: string;
  firstMessageId: string | null;
  thumbnailUrl?: string | null;
  reactionCount?: number;
}
export interface ForumListResult {
  channelId: string;
  posts: ForumPost[];
  hasMore: boolean;
  nextOffset: number;
  /** Where the next page starts, with `hasMore`, for peers that negotiated `forum-cursor`. */
  nextCursor?: ForumCursor;
}
export interface ForumPostSaved {
  post: ForumPost;
  message?: ChatMessage;
  deleted?: boolean;
}
export type ForumCursor = z.infer<typeof forumCursorSchema>;
export type ForumList = z.input<typeof forumListSchema>;
export type ForumCreatePost = z.infer<typeof forumCreatePostSchema>;
export type ForumUpdatePost = z.infer<typeof forumUpdatePostSchema>;
export type ForumDeletePost = z.infer<typeof forumDeletePostSchema>;
