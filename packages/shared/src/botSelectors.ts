import { z } from 'zod';
import { LIMITS } from './constants.js';
import { selectionChoiceSchema } from './selection.js';
import { botSettingsContextSchema, botSettingsValuesSchema } from './botInteractions.js';

const id = z.string().min(1).max(128);
const title = z.string().trim().min(1).max(200);
const choices = z.array(selectionChoiceSchema).min(1).max(25)
  .refine((entries) => new Set(entries.map((entry) => entry.value)).size === entries.length);
const maxResponders = z.number().int().min(1).max(10000);
const expiresAt = z.number().int().safe().positive();

const selectorFieldsSchema = z.object({
  id: id.optional(),
  channelId: id,
  title,
  choices,
  presentation: z.enum(['buttons', 'dropdown']),
  responder: z.enum(['any', 'invoker']),
  invokerId: id.optional(),
  allowChange: z.boolean(),
  expiresAt: expiresAt.optional(),
  maxResponders: maxResponders.optional(),
  metadata: z.record(z.string().min(1).max(32), z.string().max(200))
    .refine((value) => Object.keys(value).length <= 10).optional(),
}).strict();
export const botSelectorCreateSchema = selectorFieldsSchema.extend({ invocationId: id.optional() })
  .refine((value) => value.expiresAt !== undefined || value.maxResponders !== undefined)
  .refine((value) => value.responder !== 'invoker' || value.invokerId !== undefined || value.invocationId !== undefined);

export const botSelectorPatchSchema = z.object({
  title: title.optional(),
  expiresAt: expiresAt.optional(),
  maxResponders: maxResponders.optional(),
}).strict();
export const botSelectorUpdateSchema = z.object({ id, patch: botSelectorPatchSchema }).strict();
export const botSelectorIdSchema = z.object({ id }).strict();
export const botSelectorListSchema = z.object({ channelId: id.optional() }).strict();
export const botSelectorRespondSchema = z.object({
  id, value: z.string().min(1).max(100), userSettings: botSettingsValuesSchema.optional(),
}).strict();
export const botSelectorRespondedSchema = z.object({
  id, channelId: id, userId: id, value: z.string().min(1).max(100),
  settings: botSettingsContextSchema.optional(),
}).strict();
export type BotSelectorRespondedPayload = z.infer<typeof botSelectorRespondedSchema>;
export const botSelectorFinalizeSchema = z.object({
  id, content: z.string().trim().min(1).max(LIMITS.MAX_MESSAGE_LENGTH),
}).strict();

export type BotSelectorCreate = z.infer<typeof botSelectorCreateSchema>;
export type BotSelectorPatch = z.infer<typeof botSelectorPatchSchema>;
export interface BotSelector extends Omit<BotSelectorCreate, 'id' | 'invocationId'> {
  id: string;
  botId: string;
  messageId: string;
  createdAt: number;
  closedAt: number | null;
  responses: Record<string, string>;
  resultMessageId: string | null;
  messagePublished?: boolean;
  /** Server-derived, channel-scoped capability; never accepted in create payloads. */
  creatorUserId?: string;
  sourceInvocationId?: string;
}

export const botSelectorSchema = selectorFieldsSchema.extend({
  id,
  botId: id,
  messageId: id,
  createdAt: z.number().int().safe(),
  closedAt: z.number().int().safe().nullable(),
  responses: z.record(id, z.string().max(100)),
  resultMessageId: id.nullable(),
  messagePublished: z.boolean().optional(),
  creatorUserId: id.optional(),
  sourceInvocationId: id.optional(),
});

/** Public snapshots expose a tally and the caller's choice, never other voters' identities. */
export interface BotSelectorPublic extends Omit<BotSelector, 'responses' | 'metadata' | 'invokerId' | 'creatorUserId' | 'sourceInvocationId'> {
  counts: Record<string, number>;
  responseCount: number;
  ownResponse?: string;
  canRespond: boolean;
}

export const botSelectorPublicSchema = botSelectorSchema.omit({
  responses: true, metadata: true, invokerId: true, creatorUserId: true, sourceInvocationId: true,
}).extend({
  counts: z.record(z.string(), z.number().int().nonnegative()),
  responseCount: z.number().int().nonnegative(),
  ownResponse: z.string().optional(),
  canRespond: z.boolean(),
});

export const BOT_SELECTOR_MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
