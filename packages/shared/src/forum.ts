import { z } from 'zod';
import { LIMITS } from './constants.js';
import type { ChatMessage } from './models.js';

const id = z.string().min(1).max(128);
export const forumListSchema = z.object({
  channelId: id,
  query: z.string().trim().max(200).optional(),
  sort: z.enum(['latest', 'newest', 'oldest']).default('latest'),
  offset: z.number().int().min(0).max(100_000).default(0),
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
}
export interface ForumPostSaved {
  post: ForumPost;
  message?: ChatMessage;
  deleted?: boolean;
}
export type ForumList = z.input<typeof forumListSchema>;
export type ForumCreatePost = z.infer<typeof forumCreatePostSchema>;
export type ForumUpdatePost = z.infer<typeof forumUpdatePostSchema>;
export type ForumDeletePost = z.infer<typeof forumDeletePostSchema>;
