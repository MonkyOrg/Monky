import { z } from 'zod';

/** Only capabilities implemented by the current server and SDK belong here. */
export const BOT_CAPABILITIES = [
  'commands',
  'read_messages',
  'send_messages',
  'publish_voice',
  'receive_voice',
  'local_execution',
  'sound_download',
  'selectors',
  'miniapps',
] as const;

export const botCapabilitySchema = z.enum(BOT_CAPABILITIES);
export type BotCapability = z.infer<typeof botCapabilitySchema>;
export const botCapabilitiesSchema = z.array(botCapabilitySchema).max(BOT_CAPABILITIES.length)
  .refine((values) => new Set(values).size === values.length, 'Duplicate bot capabilities')
  .transform((values) => BOT_CAPABILITIES.filter((capability) => values.includes(capability)));

export const botPermissionsSchema = z.object({
  requested: botCapabilitiesSchema.nullable(),
  granted: botCapabilitiesSchema,
  revision: z.number().int().safe().nonnegative(),
  reviewRequired: z.boolean(),
  reviewedBy: z.string().min(1).max(128).nullable(),
  reviewedAt: z.number().int().safe().nonnegative().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.granted.some((capability) => !value.requested?.includes(capability)) ||
      (value.requested === null && !value.reviewRequired) ||
      ((value.reviewedBy === null) !== (value.reviewedAt === null)) ||
      (!value.reviewRequired && value.reviewedBy === null)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent bot permission approval' });
  }
});
export type BotPermissions = z.infer<typeof botPermissionsSchema>;

export function unreviewedBotPermissions(): BotPermissions {
  return { requested: null, granted: [], revision: 0, reviewRequired: true, reviewedBy: null, reviewedAt: null };
}

export const botPermissionsGetSchema = z.object({ botId: z.string().min(1).max(128) }).strict();
export const botPermissionsUpdateSchema = botPermissionsGetSchema.extend({
  expectedRevision: z.number().int().safe().nonnegative(),
  granted: botCapabilitiesSchema,
}).strict();
export type BotPermissionsUpdate = z.infer<typeof botPermissionsUpdateSchema>;
export const botPermissionsSnapshotSchema = botPermissionsGetSchema.extend({
  permissions: botPermissionsSchema,
}).strict();
export type BotPermissionsSnapshot = z.infer<typeof botPermissionsSnapshotSchema>;
