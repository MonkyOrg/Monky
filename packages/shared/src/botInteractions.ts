import { z } from 'zod';
import { LIMITS } from './constants.js';
import { botMessageLocalizationsSchema } from './botMessages.js';
import { botCapabilitiesSchema, botPermissionsSchema } from './botPermissions.js';
import type { CommandOption } from './models.js';
import {
  commandCallerContextSchema,
  localCapabilitiesSchema,
  localCommandPreparationSchema,
  localPreviewReferenceSchema,
} from './localExecutionProtocol.js';
import {
  BOT_LOCALES, botFieldLocalizationSchema, botLocaleSchema, commandLocalizationsSchema, commandNameSchema,
  getCommandPresentation, localizeBotChoices, resolveBotLocale, type BotLocale,
} from './botLocales.js';
import {
  audioPreviewResourceIdSchema,
  createSelectionChoiceSchema,
  selectionChoicesSchema,
  selectionDescriptionSchema,
  selectionLabelSchema,
} from './selection.js';

const identifier = z.string().min(1).max(128);
const inputName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
  .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name));
const commandName = commandNameSchema;
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
  label: label.optional(),
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
  localizations: commandLocalizationsSchema.optional(),
  downloadsSound: z.boolean().optional(),
  voiceRequirement: z.enum(['joined', 'same-bot-channel']).optional(),
  localCapabilities: localCapabilitiesSchema.optional(),
}).strict().refine((command) =>
  new Set(command.options?.map((option) => option.name)).size === (command.options?.length ?? 0)
).superRefine((command, ctx) => {
  for (const locale of BOT_LOCALES) {
    for (const [name, text] of Object.entries(command.localizations?.[locale]?.options ?? {})) {
      const option = command.options?.find((entry) => entry.name === name);
      const path = ['localizations', locale, 'options', name];
      if (!option) {
        ctx.addIssue({ code: 'custom', message: 'Unknown localized command option', path });
        continue;
      }
      for (const value of Object.keys(text.choices ?? {})) {
        if (!option.choices?.some((choice) => choice.value === value)) {
          ctx.addIssue({ code: 'custom', message: 'Unknown localized command choice', path: [...path, 'choices', value] });
        }
      }
    }
  }
});

export const commandInvokeSchema = z.object({
  commandName,
  botId: identifier,
  channelId: identifier,
  options: commandValuesSchema.optional(),
  locale: botLocaleSchema.optional(),
  allowSoundDownload: z.boolean().optional(),
  userSettings: botSettingsValuesSchema.optional(),
  localPreparation: localCommandPreparationSchema.optional(),
}).strict();

export const commandExecutionSchema = commandInvokeSchema.omit({ userSettings: true, localPreparation: true }).extend({
  ...commandCallerContextSchema.shape,
  invocationId: identifier,
  settings: botSettingsContextSchema.optional(),
});

export const commandAutocompleteChoiceSchema = createSelectionChoiceSchema(
  z.string().min(1).max(LIMITS.MAX_MESSAGE_LENGTH).refine((value) => value.trim().length > 0)
);
export const commandAutocompleteChoicesSchema = z.array(commandAutocompleteChoiceSchema)
  .max(LIMITS.MAX_BOT_AUTOCOMPLETE_CHOICES)
  .refine((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length);
export type CommandAutocompleteChoice = z.infer<typeof commandAutocompleteChoiceSchema>;

const autocompleteCursorSchema = z.string().min(1).max(LIMITS.MAX_BOT_AUTOCOMPLETE_CURSOR_LENGTH);
const autocompletePageFields = {
  choices: commandAutocompleteChoicesSchema,
  hasMore: z.boolean().optional(),
  nextCursor: autocompleteCursorSchema.optional(),
};
function validAutocompleteContinuation(page: { hasMore?: boolean; nextCursor?: string }): boolean {
  return page.nextCursor === undefined || page.hasMore === true;
}
export const commandAutocompletePageSchema = z.object(autocompletePageFields).strict()
  .refine(validAutocompleteContinuation, 'A continuation cursor requires hasMore');
export type CommandAutocompletePage = z.infer<typeof commandAutocompletePageSchema>;

export const commandAutocompleteSchema = z.object({
  botId: identifier,
  commandName,
  channelId: identifier,
  optionName: inputName,
  query: z.string().max(LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH),
  page: z.number().int().safe().nonnegative().optional(),
  cursor: autocompleteCursorSchema.optional(),
  options: commandValuesSchema.optional(),
  locale: botLocaleSchema.optional(),
  userSettings: botSettingsValuesSchema.optional(),
  localPreparation: localCommandPreparationSchema.optional(),
}).strict();
export const commandAutocompleteExecutionSchema = commandAutocompleteSchema
  .omit({ userSettings: true, localPreparation: true })
  .extend({
    ...commandCallerContextSchema.shape,
    options: commandValuesSchema,
    locale: botLocaleSchema,
    settings: botSettingsContextSchema.optional(),
  });
export const commandAutocompleteResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    ...autocompletePageFields,
  }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['handler_failed', 'invalid_response', 'timeout']),
  }).strict(),
]).refine((result) => result.status !== 'ok' || validAutocompleteContinuation(result),
  'A continuation cursor requires hasMore');
export type CommandAutocompleteResult = z.infer<typeof commandAutocompleteResultSchema>;
export const commandAutocompleteCancelSchema = z.object({ requestId: identifier }).strict();

export const commandAudioPreviewSchema = z.object({
  botId: identifier,
  commandName,
  channelId: identifier,
  optionName: inputName,
  autocompleteRequestId: identifier,
  resourceId: audioPreviewResourceIdSchema,
  localPreparation: localCommandPreparationSchema.optional(),
}).strict();
export type CommandAudioPreviewPayload = z.infer<typeof commandAudioPreviewSchema>;

export const commandAudioPreviewExecutionSchema = z.object({
  ...commandCallerContextSchema.shape,
  commandName,
  optionName: inputName,
  resourceId: audioPreviewResourceIdSchema,
  locale: botLocaleSchema,
  settings: botSettingsContextSchema.optional(),
}).strict();
export type CommandAudioPreviewExecutionPayload = z.infer<typeof commandAudioPreviewExecutionSchema>;

export const commandAudioPreviewMimeSchema = z.enum(['audio/ogg', 'audio/mpeg', 'audio/wav']);
export type CommandAudioPreviewMimeType = z.infer<typeof commandAudioPreviewMimeSchema>;
export const commandAudioPreviewBase64Schema = z.string().min(4)
  .max(Math.ceil(LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES / 3) * 4)
  .refine((value) => {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const size = value.length / 4 * 3 - padding;
    if (size < 1 || size > LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES) return false;
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      .indexOf(value[value.length - padding - 1]);
    return padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0;
  });
export const commandAudioPreviewResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    audioBase64: commandAudioPreviewBase64Schema,
    mimeType: commandAudioPreviewMimeSchema,
  }).strict(),
  localPreviewReferenceSchema.extend({ status: z.literal('local') }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['handler_failed', 'invalid_response', 'timeout', 'too_large', 'unsupported_audio', 'busy', 'expired']),
  }).strict(),
]);
export type CommandAudioPreviewResult = z.infer<typeof commandAudioPreviewResultSchema>;
export type CommandAudioPreviewFailureReason = Extract<CommandAudioPreviewResult, { status: 'failed' }>['reason'];
export const commandAudioPreviewCancelSchema = z.object({ requestId: identifier }).strict();

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

const botSettingsFormLocalizationSchema = z.object({
  title: label.optional(),
  description: description.optional(),
  submitLabel: label.optional(),
  fields: z.record(inputName, botFieldLocalizationSchema).optional(),
}).strict();
const botSettingsLocalizationSchema = z.object({
  server: botSettingsFormLocalizationSchema.optional(),
  user: botSettingsFormLocalizationSchema.optional(),
}).strict();

export const botSettingsDefinitionSchema = z.object({
  server: botFormSchema.optional(),
  user: botFormSchema.optional(),
  localizations: z.object({
    'pt-BR': botSettingsLocalizationSchema.optional(),
    en: botSettingsLocalizationSchema.optional(),
  }).strict().optional(),
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
  for (const locale of ['pt-BR', 'en'] as const) {
    for (const scope of ['server', 'user'] as const) {
      const localized = definition.localizations?.[locale]?.[scope];
      if (!localized) continue;
      const form = definition[scope];
      if (!form) {
        ctx.addIssue({ code: 'custom', message: 'Localized settings scope is not declared', path: ['localizations', locale, scope] });
        continue;
      }
      for (const [name, text] of Object.entries(localized.fields ?? {})) {
        const field = form.fields.find((entry) => entry.name === name);
        const path = ['localizations', locale, scope, 'fields', name];
        if (!field) {
          ctx.addIssue({ code: 'custom', message: 'Unknown localized settings field', path: ['localizations', locale, scope, 'fields', name] });
          continue;
        }
        if (text.placeholder !== undefined && field.type === 'boolean') {
          ctx.addIssue({ code: 'custom', message: 'This settings field has no placeholder', path: [...path, 'placeholder'] });
        }
        for (const value of Object.keys(text.choices ?? {})) {
          if (field.type !== 'select' || !field.choices.some((choice) => choice.value === value)) {
            ctx.addIssue({ code: 'custom', message: 'Unknown localized settings choice', path: [...path, 'choices', value] });
          }
        }
      }
    }
  }
});
export type BotSettingsDefinition = z.infer<typeof botSettingsDefinitionSchema>;

export function localizeBotSettingsForm(
  definition: BotSettingsDefinition,
  scope: 'server' | 'user',
  locale: BotLocale,
): BotForm | undefined {
  const form = definition[scope];
  const localized = definition.localizations?.[resolveBotLocale(locale)]?.[scope];
  if (!form || !localized) return form;
  return {
    ...form,
    title: localized.title ?? form.title,
    description: localized.description ?? form.description,
    submitLabel: localized.submitLabel ?? form.submitLabel,
    fields: form.fields.map((field) => {
      const text = localized.fields?.[field.name];
      return {
        ...field,
        label: text?.label ?? field.label,
        description: text?.description ?? field.description,
        ...(field.type !== 'boolean' ? { placeholder: text?.placeholder ?? field.placeholder } : {}),
        ...(field.type === 'select' ? { choices: localizeBotChoices(field.choices, text?.choices) } : {}),
      };
    }),
  };
}

export const commandDefinitionsSchema = z.array(commandDefinitionSchema).max(LIMITS.MAX_COMMANDS_PER_BOT)
  .superRefine((commands, ctx) => {
    for (const locale of BOT_LOCALES) {
      const owners = new Map<string, number>();
      commands.forEach((command, index) => {
        for (const name of getCommandPresentation(command, locale).inputNames) {
          const previous = owners.get(name);
          if (previous !== undefined) {
            ctx.addIssue({
              code: 'custom',
              message: `Command input "/${name}" is ambiguous in ${locale}: ${commands[previous].name}, ${command.name}`,
              path: name === command.name ? [index, 'name'] : [index, 'localizations', locale],
            });
          } else {
            owners.set(name, index);
          }
        }
      });
    }
  });

export const commandRegisterSchema = z.object({
  requestedCapabilities: botCapabilitiesSchema,
  commands: commandDefinitionsSchema,
  settings: botSettingsDefinitionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const required = [
    ...(value.commands.length ? ['commands'] as const : []),
    ...(value.commands.some((command) => command.downloadsSound) ? ['sound_download'] as const : []),
    ...(value.commands.some((command) => command.localCapabilities?.length) ? ['local_execution'] as const : []),
  ];
  for (const capability of required) {
    if (!value.requestedCapabilities.includes(capability)) {
      ctx.addIssue({ code: 'custom', message: `Commands require the declared capability: ${capability}`, path: ['requestedCapabilities'] });
    }
  }
});

export const commandRegisteredSchema = z.object({
  registered: z.number().int().min(0).max(LIMITS.MAX_COMMANDS_PER_BOT),
  settings: botServerSettingsSnapshotSchema,
  permissions: botPermissionsSchema.optional(),
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
  content: z.string().trim().min(1).max(LIMITS.WS_MAX_PAYLOAD_BYTES),
  localizations: botMessageLocalizationsSchema.optional(),
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
  requestedCapabilities: botCapabilitiesSchema,
  name: botIdentitySchema.shape.name,
  description: description.optional(),
  icon: avatarSchema.optional(),
  commands: z.array(z.object({ name: commandName, description: label }).strict()).max(LIMITS.MAX_COMMANDS_PER_BOT).optional(),
  registrationUrl: httpUrl,
}).strict().refine((manifest) => !manifest.commands?.length || manifest.requestedCapabilities.includes('commands'), {
  message: 'Manifest commands require the declared capability: commands', path: ['requestedCapabilities'],
});

export const botInstallPreviewRequestSchema = z.object({ manifestUrl: httpUrl }).strict();
export const botInstallPreviewSchema = z.object({
  previewId: identifier,
  expiresAt: z.number().int().safe().nonnegative(),
  manifest: botManifestSchema,
}).strict();
export type BotInstallPreview = z.infer<typeof botInstallPreviewSchema>;
export const botInstallSchema = z.object({
  previewId: identifier,
  grantedCapabilities: botCapabilitiesSchema,
}).strict();

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
  permissions: botPermissionsSchema.optional(),
  canManage: z.boolean().optional(),
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
