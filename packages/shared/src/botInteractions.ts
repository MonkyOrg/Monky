import { z } from 'zod';
import { LIMITS } from './constants.js';
import type { CommandOption } from './models.js';
import {
  createSelectionChoiceSchema,
  selectionChoicesSchema,
  selectionDescriptionSchema,
  selectionLabelSchema,
} from './selection.js';

const identifier = z.string().min(1).max(128);
const inputName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
  .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name));
const commandName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const label = selectionLabelSchema;
const description = selectionDescriptionSchema;
const choicesSchema = selectionChoicesSchema.min(1).max(LIMITS.MAX_BOT_FORM_CHOICES)
  .refine((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length);
const scalarSchema = z.union([z.string().max(LIMITS.MAX_MESSAGE_LENGTH), z.number().finite(), z.boolean()]);
const formValueSchema = z.union([
  scalarSchema,
  z.array(z.string().max(LIMITS.MAX_MESSAGE_LENGTH)).max(LIMITS.MAX_BOT_FORM_LIST_ITEMS),
]);

export type CommandValue = z.infer<typeof scalarSchema>;
export type CommandValues = Record<string, CommandValue>;
export type BotFormValues = Record<string, z.infer<typeof formValueSchema>>;
const commandValuesSchema = z.record(inputName, scalarSchema)
  .refine((values) => Object.keys(values).length <= LIMITS.MAX_OPTIONS_PER_COMMAND);

export const botFormValuesSchema = z.record(inputName, formValueSchema)
  .refine((values) => Object.keys(values).length <= LIMITS.MAX_BOT_FORM_FIELDS);
export const botSettingsValuesSchema = botFormValuesSchema.refine(
  (values) => jsonBytes(values) <= LIMITS.MAX_BOT_SETTINGS_VALUES_BYTES,
  'Settings values exceed the size limit'
);
const settingsRevision = z.number().int().safe().nonnegative();
export const botServerSettingsSnapshotSchema = z.object({
  schemaRevision: settingsRevision,
  revision: settingsRevision,
  values: botSettingsValuesSchema,
}).strict();
export type BotServerSettingsSnapshot = z.infer<typeof botServerSettingsSnapshotSchema>;

export const botSettingsContextSchema = z.object({
  schemaRevision: settingsRevision,
  serverRevision: settingsRevision,
  server: botSettingsValuesSchema,
  user: botSettingsValuesSchema,
}).strict();
export type BotSettingsContext = z.infer<typeof botSettingsContextSchema>;

export const commandRequestIdSchema = identifier;

export const commandOptionSchema = z.object({
  name: inputName,
  description: label,
  type: z.enum(['string', 'integer', 'boolean', 'user']),
  required: z.boolean().optional(),
  placeholder: z.string().max(150).optional(),
  choices: choicesSchema.optional(),
  autocomplete: z.boolean().optional(),
  min: z.number().int().safe().optional(),
  max: z.number().int().safe().optional(),
}).strict().refine((option) =>
  (!option.choices || option.type === 'string') &&
  (!option.autocomplete || (option.type === 'string' && !option.choices)) &&
  ((option.min === undefined && option.max === undefined) || option.type === 'integer') &&
  (option.min === undefined || option.max === undefined || option.min <= option.max)
);

export const commandDefinitionSchema = z.object({
  name: commandName,
  description: label,
  options: z.array(commandOptionSchema).max(LIMITS.MAX_OPTIONS_PER_COMMAND).optional(),
  downloadsSound: z.boolean().optional(),
}).strict().refine((command) =>
  new Set(command.options?.map((option) => option.name)).size === (command.options?.length ?? 0)
);

export const commandInvokeSchema = z.object({
  commandName,
  botId: identifier,
  channelId: identifier,
  options: commandValuesSchema.optional(),
  locale: z.enum(['pt-BR', 'en']).optional(),
  allowSoundDownload: z.boolean().optional(),
  userSettings: botSettingsValuesSchema.optional(),
}).strict();

export const commandExecutionSchema = commandInvokeSchema.omit({ userSettings: true }).extend({
  invocationId: identifier,
  invokerId: identifier,
  invokerNickname: z.string().min(1).max(LIMITS.MAX_NICKNAME_LENGTH),
  settings: botSettingsContextSchema.optional(),
});

export const commandAutocompleteChoiceSchema = createSelectionChoiceSchema(
  z.string().min(1).max(LIMITS.MAX_MESSAGE_LENGTH).refine((value) => value.trim().length > 0)
);
export const commandAutocompleteChoicesSchema = z.array(commandAutocompleteChoiceSchema)
  .max(LIMITS.MAX_BOT_AUTOCOMPLETE_CHOICES)
  .refine((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length);
export type CommandAutocompleteChoice = z.infer<typeof commandAutocompleteChoiceSchema>;

export const commandAutocompleteSchema = z.object({
  botId: identifier,
  commandName,
  channelId: identifier,
  optionName: inputName,
  query: z.string().max(LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH),
  options: commandValuesSchema.optional(),
  locale: z.enum(['pt-BR', 'en']).optional(),
  userSettings: botSettingsValuesSchema.optional(),
}).strict();
export const commandAutocompleteExecutionSchema = commandAutocompleteSchema
  .omit({ botId: true, channelId: true, userSettings: true })
  .extend({
    options: commandValuesSchema,
    locale: z.enum(['pt-BR', 'en']),
    settings: botSettingsContextSchema.optional(),
  });
export const commandAutocompleteResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    choices: commandAutocompleteChoicesSchema,
  }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['handler_failed', 'invalid_response', 'timeout']),
  }).strict(),
]);
export type CommandAutocompleteResult = z.infer<typeof commandAutocompleteResultSchema>;
export const commandAutocompleteCancelSchema = z.object({ requestId: identifier }).strict();

const fieldBase = {
  name: inputName,
  label,
  description: description.optional(),
  required: z.boolean().optional(),
};
export const botFormFieldSchema = z.discriminatedUnion('type', [
  z.object({
    ...fieldBase,
    type: z.literal('text'),
    placeholder: z.string().max(150).optional(),
    multiline: z.boolean().optional(),
    minLength: z.number().int().min(0).max(LIMITS.MAX_MESSAGE_LENGTH).optional(),
    maxLength: z.number().int().min(1).max(LIMITS.MAX_MESSAGE_LENGTH).optional(),
    defaultValue: z.string().max(LIMITS.MAX_MESSAGE_LENGTH).optional(),
  }).strict(),
  z.object({
    ...fieldBase,
    type: z.literal('integer'),
    placeholder: z.string().max(150).optional(),
    min: z.number().int().safe().optional(),
    max: z.number().int().safe().optional(),
    defaultValue: z.number().int().safe().optional(),
  }).strict(),
  z.object({
    ...fieldBase,
    type: z.literal('select'),
    choices: choicesSchema,
    presentation: z.enum(['dropdown', 'buttons']).optional(),
    placeholder: z.string().max(150).optional(),
    defaultValue: z.string().max(100).optional(),
  }).strict(),
  z.object({
    ...fieldBase,
    type: z.literal('boolean'),
    defaultValue: z.boolean().optional(),
  }).strict(),
  z.object({
    ...fieldBase,
    type: z.literal('string-list'),
    placeholder: z.string().max(150).optional(),
    minItems: z.number().int().min(1).max(LIMITS.MAX_BOT_FORM_LIST_ITEMS).optional(),
    maxItems: z.number().int().min(1).max(LIMITS.MAX_BOT_FORM_LIST_ITEMS).optional(),
    maxLength: z.number().int().min(1).max(LIMITS.MAX_MESSAGE_LENGTH).optional(),
    defaultValue: z.array(z.string().max(LIMITS.MAX_MESSAGE_LENGTH))
      .max(LIMITS.MAX_BOT_FORM_LIST_ITEMS).optional(),
  }).strict(),
]);

export type BotFormField = z.infer<typeof botFormFieldSchema>;

export const botFormSchema = z.object({
  title: label,
  description: description.optional(),
  fields: z.array(botFormFieldSchema).min(1).max(LIMITS.MAX_BOT_FORM_FIELDS),
  submitLabel: label.optional(),
}).strict().superRefine((form, ctx) => {
  if (new Set(form.fields.map((field) => field.name)).size !== form.fields.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate field names' });
  }
  for (const field of form.fields) {
    const invalidRange =
      (field.type === 'text' && (field.minLength ?? 0) > (field.maxLength ?? LIMITS.MAX_MESSAGE_LENGTH)) ||
      (field.type === 'integer' && field.min !== undefined && field.max !== undefined && field.min > field.max) ||
      (field.type === 'string-list' && (field.minItems ?? 1) > (field.maxItems ?? LIMITS.MAX_BOT_FORM_LIST_ITEMS));
    if (invalidRange) ctx.addIssue({ code: 'custom', message: 'Invalid field range', path: ['fields', field.name] });
    const emptyDefault = field.defaultValue === '' ||
      (Array.isArray(field.defaultValue) && field.defaultValue.length === 0);
    if (field.defaultValue !== undefined && !emptyDefault && validateField(field, field.defaultValue) !== null) {
      ctx.addIssue({ code: 'custom', message: 'Invalid default value', path: ['fields', field.name] });
    }
  }
});

export type BotForm = z.infer<typeof botFormSchema>;

export const botSettingsDefinitionSchema = z.object({
  server: botFormSchema.optional(),
  user: botFormSchema.optional(),
}).strict().superRefine((definition, ctx) => {
  if (jsonBytes(definition) > LIMITS.MAX_BOT_SETTINGS_DEFINITION_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'Settings declaration exceeds the size limit' });
  }
  for (const scope of ['server', 'user'] as const) {
    const defaults = resolveBotSettingsValues(definition[scope], {});
    if (!defaults.success) {
      ctx.addIssue({
        code: 'custom', message: `Invalid settings default: ${defaults.field} (${defaults.reason})`,
        path: [scope, 'fields', defaults.field],
      });
    }
  }
});
export type BotSettingsDefinition = z.infer<typeof botSettingsDefinitionSchema>;

export const commandRegisterSchema = z.object({
  commands: z.array(commandDefinitionSchema).max(LIMITS.MAX_COMMANDS_PER_BOT),
  settings: botSettingsDefinitionSchema.optional(),
}).strict().refine((payload) =>
  new Set(payload.commands.map((command) => command.name)).size === payload.commands.length
);

export const commandRegisteredSchema = z.object({
  registered: z.number().int().min(0).max(LIMITS.MAX_COMMANDS_PER_BOT),
  settings: botServerSettingsSnapshotSchema,
}).strict();

export const commandPromptSchema = z.object({
  invocationId: identifier,
  interactionId: identifier,
  form: botFormSchema,
}).strict();

export const commandSubmitSchema = z.object({
  invocationId: identifier,
  interactionId: identifier,
  values: botFormValuesSchema,
}).strict();

export const commandCancelSchema = z.object({ invocationId: identifier }).strict();
export const commandFinishSchema = commandCancelSchema.extend({ failed: z.boolean().optional() });
export const commandFinishedSchema = commandCancelSchema.extend({
  channelId: identifier,
  reason: z.enum(['completed', 'cancelled', 'expired', 'bot_disconnected', 'caller_disconnected', 'failed']),
});
export const commandResponseSchema = commandCancelSchema.extend({
  content: z.string().trim().min(1).max(LIMITS.MAX_MESSAGE_LENGTH),
  ephemeral: z.boolean().optional(),
});

const avatarSchema = z.string().min(1).max(Math.ceil(LIMITS.MAX_AVATAR_SIZE * 4 / 3) + 256);
export const botIdentitySchema = z.object({
  name: z.string().trim().min(LIMITS.MIN_NICKNAME_LENGTH).max(LIMITS.MAX_NICKNAME_LENGTH),
  avatarBase64: avatarSchema.optional(),
}).strict();
export type BotIdentity = z.infer<typeof botIdentitySchema>;
export const botCreateSchema = z.object({}).strict();
export const botProfileUpdateSchema = z.object({
  botId: identifier.optional(),
  name: botIdentitySchema.shape.name.optional(),
  avatarBase64: avatarSchema.nullable().optional(),
}).strict().refine((profile) => profile.name !== undefined || profile.avatarBase64 !== undefined);

const httpUrl = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
});
export const botManifestSchema = z.object({
  name: botIdentitySchema.shape.name,
  description: description.optional(),
  icon: avatarSchema.optional(),
  commands: z.array(z.object({ name: commandName, description: label })).max(LIMITS.MAX_COMMANDS_PER_BOT).optional(),
  registrationUrl: httpUrl,
});

export const botRegistrationSchema = z.object({
  token: z.string().min(1).max(128),
  serverId: identifier.optional(),
  serverName: z.string().min(1).max(200),
  serverUrl: z.string().url().max(2048).refine((value) => /^wss?:\/\//.test(value)).optional(),
});

export const botSettingsSummarySchema = z.object({
  botId: identifier,
  name: botIdentitySchema.shape.name,
  avatarUrl: z.string().min(1).max(2048).nullable().optional(),
  online: z.boolean(),
  capabilities: z.object({ downloadsSound: z.boolean() }).strict(),
  schemaRevision: settingsRevision,
  revision: settingsRevision,
  hasServerSettings: z.boolean(),
  hasUserSettings: z.boolean(),
  canConfigure: z.boolean(),
}).strict();
export type BotSettingsSummary = z.infer<typeof botSettingsSummarySchema>;

export const botSettingsSnapshotSchema = z.object({
  bot: botSettingsSummarySchema,
  definition: botSettingsDefinitionSchema,
  server: botServerSettingsSnapshotSchema.optional(),
}).strict().superRefine((snapshot, ctx) => {
  const { bot, definition, server } = snapshot;
  if (!!definition.user !== bot.hasUserSettings ||
      (!!definition.server && !bot.hasServerSettings) ||
      (!!definition.server !== !!server) ||
      (bot.canConfigure && bot.hasServerSettings && !server)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent settings declaration' });
  }
  if (server && (server.schemaRevision !== bot.schemaRevision || server.revision !== bot.revision)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent settings revisions', path: ['server'] });
  }
  if (definition.server && server) {
    const validated = validateBotFormValues(definition.server, server.values);
    if (!validated.success) {
      ctx.addIssue({ code: 'custom', message: 'Invalid shared settings values', path: ['server', 'values', validated.field] });
    }
  }
});
export type BotSettingsSnapshot = z.infer<typeof botSettingsSnapshotSchema>;

export const botSettingsListSchema = z.object({}).strict();
export const botSettingsListResponseSchema = z.object({
  bots: z.array(botSettingsSummarySchema).max(LIMITS.MAX_BOT_SETTINGS_CATALOG)
    .refine((bots) => new Set(bots.map((bot) => bot.botId)).size === bots.length, 'Duplicate bot IDs'),
}).strict();
export type BotSettingsListResponse = z.infer<typeof botSettingsListResponseSchema>;
export const botSettingsGetSchema = z.object({ botId: identifier }).strict();
export const botSettingsPatchSchema = z.record(inputName, formValueSchema.nullable())
  .refine((patch) => Object.keys(patch).length <= LIMITS.MAX_BOT_FORM_FIELDS &&
    jsonBytes(patch) <= LIMITS.MAX_BOT_SETTINGS_VALUES_BYTES);
export type BotSettingsPatch = z.infer<typeof botSettingsPatchSchema>;
export const botSettingsUpdateSchema = botSettingsGetSchema.extend({
  schemaRevision: settingsRevision,
  expectedRevision: settingsRevision,
  patch: botSettingsPatchSchema,
}).strict();

export type BotInputError = 'required' | 'type' | 'choice' | 'min' | 'max' | 'duplicate' | 'unknown';
export type BotInputResult<T> =
  | { success: true; values: T }
  | { success: false; field: string; reason: BotInputError };

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Defaults fill absent keys only; explicit invalid overrides never fall back. */
export function resolveBotSettingsValues(form: BotForm | undefined, input: unknown): BotInputResult<BotFormValues> {
  const parsed = botSettingsValuesSchema.safeParse(input === undefined ? {} : input);
  if (!parsed.success) return { success: false, field: '', reason: 'type' };
  if (!form) {
    const field = Object.keys(parsed.data)[0];
    return field === undefined ? { success: true, values: {} } : { success: false, field, reason: 'unknown' };
  }
  const declaration = botFormSchema.safeParse(form);
  if (!declaration.success) return { success: false, field: '', reason: 'type' };
  const defaults: BotFormValues = {};
  for (const field of declaration.data.fields) {
    if (field.defaultValue !== undefined) defaults[field.name] = field.defaultValue;
  }
  const result = validateBotFormValues(declaration.data, { ...defaults, ...parsed.data });
  if (!result.success) return result;
  // Keep explicit unset markers so resolving an effective snapshot cannot
  // accidentally restore the default the user cleared.
  for (const [name, value] of Object.entries(parsed.data)) {
    if (value === '' || (Array.isArray(value) && value.length === 0)) result.values[name] = value;
  }
  if (!botSettingsValuesSchema.safeParse(result.values).success) {
    return { success: false, field: '', reason: 'max' };
  }
  return result;
}

function validateField(field: BotFormField, value: BotFormValues[string]): BotInputError | null {
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return 'type';
      if (value.trim().length < Math.max(field.minLength ?? 0, field.required ? 1 : 0)) return 'min';
      if (value.length > (field.maxLength ?? LIMITS.MAX_MESSAGE_LENGTH)) return 'max';
      return null;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'type';
      if (field.min !== undefined && value < field.min) return 'min';
      if (field.max !== undefined && value > field.max) return 'max';
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'type';
    case 'select':
      return typeof value === 'string' && field.choices.some((choice) => choice.value === value) ? null : 'choice';
    case 'string-list':
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return 'type';
      if (value.length < (field.minItems ?? 1)) return 'min';
      if (value.length > (field.maxItems ?? LIMITS.MAX_BOT_FORM_LIST_ITEMS)) return 'max';
      if (value.some((entry) => !entry.trim())) return 'required';
      if (value.some((entry) => entry.length > (field.maxLength ?? LIMITS.MAX_MESSAGE_LENGTH))) return 'max';
      if (new Set(value.map((entry) => entry.trim().toLowerCase())).size !== value.length) return 'duplicate';
      return null;
  }
}

export function validateBotFormValues(form: BotForm, input: unknown): BotInputResult<BotFormValues> {
  const parsed = botFormValuesSchema.safeParse(input);
  if (!parsed.success) return { success: false, field: '', reason: 'type' };
  const names = new Set(form.fields.map((field) => field.name));
  for (const name of Object.keys(parsed.data)) {
    if (!names.has(name)) return { success: false, field: name, reason: 'unknown' };
  }
  const values: BotFormValues = {};
  for (const field of form.fields) {
    const value = parsed.data[field.name];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      if (field.required) return { success: false, field: field.name, reason: 'required' };
      continue;
    }
    const reason = validateField(field, value);
    if (reason) return { success: false, field: field.name, reason };
    values[field.name] = Array.isArray(value) ? value.map((entry) => entry.trim()) : value;
  }
  return { success: true, values };
}

export function validateCommandOptions(
  definitions: CommandOption[],
  input: unknown,
  settings: { partial?: boolean } = {}
): BotInputResult<CommandValues> {
  const parsed = commandValuesSchema.safeParse(input ?? {});
  if (!parsed.success) return { success: false, field: '', reason: 'type' };
  const names = new Set(definitions.map((option) => option.name));
  for (const name of Object.keys(parsed.data)) {
    if (!names.has(name)) return { success: false, field: name, reason: 'unknown' };
  }
  const values: CommandValues = {};
  for (const option of definitions) {
    const value = parsed.data[option.name];
    if (value === undefined || value === '') {
      if (option.required && !settings.partial) return { success: false, field: option.name, reason: 'required' };
      continue;
    }
    let reason: BotInputError | null = null;
    if (option.type === 'integer') {
      reason = validateField({ ...option, label: option.description, type: 'integer' }, value);
    } else if (option.type === 'boolean') {
      reason = typeof value === 'boolean' ? null : 'type';
    } else if (typeof value !== 'string' || !value.trim()) {
      reason = 'type';
    } else if (option.choices && !option.choices.some((choice) => choice.value === value)) {
      reason = 'choice';
    }
    if (reason) return { success: false, field: option.name, reason };
    values[option.name] = value;
  }
  return { success: true, values };
}
