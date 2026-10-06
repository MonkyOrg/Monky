import { z } from 'zod';
import type { ChatMessage } from './models';

export const MESSAGE_SEARCH_PAGE_SIZE = 25;
const ids = z.array(z.string().min(1).max(128)).max(50).default([])
  .transform(values => [...new Set(values)].sort());
const timestamp = z.number().int().min(0).max(8640000000000000);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
});

/** Values within a filter are ORed; different filters are ANDed. Dates are UTC. */
export const messageSearchSchema = z.object({
  query: z.string().trim().max(200).default(''),
  authorIds: ids,
  channelIds: ids,
  mentionsUserIds: ids,
  contains: z.array(z.enum(['image', 'video', 'audio', 'file', 'link'])).max(5).default([])
    .transform(values => [...new Set(values)].sort()),
  authorType: z.enum(['human', 'bot']).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  before: timestamp.optional(),
  after: timestamp.optional(),
  on: calendarDate.optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict().refine(value => value.before === undefined || value.after === undefined || value.after < value.before,
  { message: 'Invalid date range' });

export type MessageSearchPayload = z.input<typeof messageSearchSchema>;
export type MessageSearchFilters = z.output<typeof messageSearchSchema>;
export interface MessageSearchResultPayload {
  messages: ChatMessage[];
  /** Counts and cursors include only authorized, live rows matching the filters. */
  total: number;
  nextCursor?: string;
}

/** Literal words, not the FTS query language. All words must match (prefix search). */
export function messageSearchTerms(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])];
}
