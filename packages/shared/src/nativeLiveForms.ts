import { z } from 'zod';
import {
  botFormFieldSchema,
  botFormSchema,
  botFormValuesSchema,
  validateBotFormValues,
  type BotFormValues,
  type BotInputResult,
} from './botInteractions.js';
import { LIMITS } from './constants.js';
import { selectionChoicesSchema, selectionDescriptionSchema, selectionLabelSchema } from './selection.js';
import {
  PUBLIC_AUDIENCE,
  resourceAudienceProjectionSchema,
  resourceAudienceSchema,
} from './resourceAudience.js';

const id = z.string().min(1).max(128);
const timestamp = z.number().int().safe().nonnegative();
const avatarUrl = z.string().regex(/^\/avatars\/[a-zA-Z0-9-]+\.(png|jpg|webp)$/).nullable();

const nativeMultiSelectFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .refine(name => !['__proto__', 'constructor', 'prototype'].includes(name)),
  label: selectionLabelSchema,
  description: selectionDescriptionSchema.optional(),
  required: z.boolean().optional(),
  type: z.literal('multi-select'),
  choices: selectionChoicesSchema.min(2).max(LIMITS.MAX_BOT_FORM_CHOICES)
    .refine(choices => new Set(choices.map(choice => choice.value)).size === choices.length),
  defaultValue: z.array(z.string().max(100)).min(1).max(LIMITS.MAX_BOT_FORM_CHOICES).optional(),
}).strict().superRefine((field, ctx) => {
  if (field.defaultValue && (new Set(field.defaultValue).size !== field.defaultValue.length ||
      field.defaultValue.some(value => !field.choices.some(choice => choice.value === value)))) {
    ctx.addIssue({ code: 'custom', path: ['defaultValue'], message: 'Invalid multiple-choice default value' });
  }
});

const nativeRatingFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .refine(name => !['__proto__', 'constructor', 'prototype'].includes(name)),
  label: selectionLabelSchema,
  description: selectionDescriptionSchema.optional(),
  required: z.boolean().optional(),
  type: z.literal('rating'),
}).strict();

export const nativeLiveFormFieldSchema = z.union([
  botFormFieldSchema,
  nativeMultiSelectFieldSchema,
  nativeRatingFieldSchema,
]);
export const nativeLiveFormDefinitionSchema = z.object({
  title: selectionLabelSchema,
  description: selectionDescriptionSchema.optional(),
  fields: z.array(nativeLiveFormFieldSchema).min(1).max(LIMITS.MAX_BOT_FORM_FIELDS),
  submitLabel: selectionLabelSchema.optional(),
  anonymous: z.boolean().optional().default(false),
}).strict().superRefine((form, ctx) => {
  if (new Set(form.fields.map(field => field.name)).size !== form.fields.length) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Duplicate field names' });
  }
  for (const [index, field] of form.fields.entries()) {
    if (!['text', 'integer', 'boolean', 'select', 'multi-select', 'rating'].includes(field.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields', index, 'type'],
        message: 'Unsupported native live form field type',
      });
    } else if (!['multi-select', 'rating'].includes(field.type) && !botFormSchema.safeParse({
      title: form.title,
      fields: [field],
    }).success) {
      ctx.addIssue({ code: 'custom', path: ['fields', index], message: 'Invalid native live form field' });
    }
  }
});

export const nativeLiveFormCreateSchema = z.object({
  channelId: id,
  form: nativeLiveFormDefinitionSchema,
  durationMinutes: z.number().int().min(1).max(43_200),
  audience: resourceAudienceSchema.optional().default(PUBLIC_AUDIENCE),
}).strict();

export const nativeLiveFormResponseSchema = z.object({
  values: botFormValuesSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const nativeLiveFormRecordSchema = z.object({
  id,
  channelId: id,
  creatorUserId: id,
  form: nativeLiveFormDefinitionSchema,
  expiresAt: timestamp,
  closedAt: timestamp.nullable(),
  createdAt: timestamp,
  revision: z.number().int().nonnegative(),
  audience: resourceAudienceSchema.optional().default(PUBLIC_AUDIENCE),
}).strict();

export const nativeLiveFormSchema = nativeLiveFormRecordSchema.omit({ audience: true }).extend({
  audience: resourceAudienceProjectionSchema.optional().default(PUBLIC_AUDIENCE),
  responseCount: z.number().int().nonnegative().max(10_000),
  myResponse: nativeLiveFormResponseSchema.nullable(),
}).strict();

export const nativeLiveFormSubmitSchema = z.object({
  id,
  expectedRevision: z.number().int().nonnegative(),
  values: botFormValuesSchema,
}).strict();

export const nativeLiveFormIdSchema = z.object({ id }).strict();

export const nativeLiveFormResultsRequestSchema = z.object({
  id,
  cursor: id.optional(),
  limit: z.number().int().min(1).max(50).default(50),
}).strict();

export const nativeLiveFormResultEntrySchema = z.object({
  user: z.object({
    id,
    nickname: z.string().min(1).max(128),
    avatarUrl,
  }).strict(),
  response: nativeLiveFormResponseSchema,
}).strict().or(z.object({
  user: z.null(),
  response: z.object({ values: botFormValuesSchema }).strict(),
}).strict());

export const nativeLiveFormResultsSchema = z.object({
  id,
  responses: z.array(nativeLiveFormResultEntrySchema).max(50),
  nextCursor: id.nullable(),
}).strict();

export function validateNativeLiveFormValues(
  form: NativeLiveFormDefinition,
  input: unknown,
): BotInputResult<BotFormValues> {
  const parsed = botFormValuesSchema.safeParse(input);
  if (!parsed.success) return { success: false, field: '', reason: 'type' };
  const names = new Set(form.fields.map(field => field.name));
  for (const name of Object.keys(parsed.data)) {
    if (!names.has(name)) return { success: false, field: name, reason: 'unknown' };
  }
  const values: BotFormValues = {};
  for (const field of form.fields) {
    const value = parsed.data[field.name];
    if (field.type === 'rating') {
      if (value === undefined) {
        if (field.required) return { success: false, field: field.name, reason: 'required' };
        continue;
      }
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) {
        return { success: false, field: field.name, reason: 'choice' };
      }
      values[field.name] = value;
      continue;
    }
    if (field.type === 'multi-select') {
      if (value === undefined || (Array.isArray(value) && value.length === 0)) {
        if (field.required) return { success: false, field: field.name, reason: 'required' };
        continue;
      }
      if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string') ||
          value.length > field.choices.length || new Set(value).size !== value.length ||
          value.some(entry => !field.choices.some(choice => choice.value === entry))) {
        return { success: false, field: field.name, reason: 'choice' };
      }
      values[field.name] = [...value];
      continue;
    }
    const result = validateBotFormValues({
      title: form.title,
      fields: [field],
    }, value === undefined ? {} : { [field.name]: value });
    if (!result.success) return result;
    if (result.values[field.name] !== undefined) values[field.name] = result.values[field.name];
  }
  return { success: true, values };
}

export type NativeLiveFormDefinition = z.infer<typeof nativeLiveFormDefinitionSchema>;
export type NativeLiveFormField = z.infer<typeof nativeLiveFormFieldSchema>;
export type NativeLiveFormCreate = z.input<typeof nativeLiveFormCreateSchema>;
export type NativeLiveFormResponse = z.infer<typeof nativeLiveFormResponseSchema>;
export type NativeLiveFormRecord = z.infer<typeof nativeLiveFormRecordSchema>;
export type NativeLiveForm = z.infer<typeof nativeLiveFormSchema>;
export type NativeLiveFormSubmit = z.infer<typeof nativeLiveFormSubmitSchema>;
export type NativeLiveFormResultsRequest = z.infer<typeof nativeLiveFormResultsRequestSchema>;
export type NativeLiveFormResults = z.infer<typeof nativeLiveFormResultsSchema>;
