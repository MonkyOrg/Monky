import { z } from 'zod';

export const SERVER_AUDIT_LIMITS = {
  PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  RETENTION_DAYS: 90,
  MAX_ENTRIES: 50_000,
  /**
   * Part of MAX_ENTRIES kept for what any member can do in bulk (bot commands,
   * joins, nicknames), so a flood of those never pushes moderation out.
   */
  MAX_ACTIVITY_ENTRIES: 20_000,
  /** Beyond this, one person's bot commands and nickname changes in a minute are not recorded. */
  ACTIVITY_ENTRIES_PER_MINUTE: 30,
  MAX_CHANGES: 24,
  MAX_RELATED: 8,
  MAX_LIST_ITEMS: 32,
  MAX_NAME_LENGTH: 128,
  MAX_VALUE_LENGTH: 300,
  MAX_DETAIL_LENGTH: 500,
  MAX_QUERY_LENGTH: 100,
  POLL_INTERVAL_MS: 5000,
  REQUEST_TIMEOUT_MS: 8000,
  REQUESTS_PER_WINDOW: 6,
  RATE_WINDOW_MS: 5000,
  TOTAL_REQUESTS_PER_SECOND: 20,
} as const;

export const SERVER_AUDIT_CATEGORIES = [
  'channels', 'roles', 'members', 'voice', 'server', 'community', 'bots', 'messages',
] as const;
export type ServerAuditCategory = typeof SERVER_AUDIT_CATEGORIES[number];

/** Each recorded action and the filter it belongs to. */
export const SERVER_AUDIT_ACTIONS = {
  'channel.create': 'channels',
  'channel.update': 'channels',
  'channel.delete': 'channels',
  'channel.move': 'channels',
  'category.create': 'channels',
  'category.update': 'channels',
  'category.delete': 'channels',
  'category.move': 'channels',
  'role.create': 'roles',
  'role.update': 'roles',
  'role.delete': 'roles',
  'role.assign': 'roles',
  'role.unassign': 'roles',
  'member.join': 'members',
  'member.kick': 'members',
  'member.nickname': 'members',
  'voice.mute': 'voice',
  'voice.unmute': 'voice',
  'voice.deafen': 'voice',
  'voice.undeafen': 'voice',
  'voice.disconnect': 'voice',
  'voice.move': 'voice',
  'server.update': 'server',
  'community.update': 'community',
  'event.create': 'community',
  'event.update': 'community',
  'event.start': 'community',
  'event.end': 'community',
  'event.cancel': 'community',
  'event.delete': 'community',
  'live.create': 'community',
  'live.update': 'community',
  'live.close': 'community',
  'form.create': 'community',
  'form.close': 'community',
  'poll.create': 'community',
  'poll.edit': 'community',
  'poll.close': 'community',
  'bot.create': 'bots',
  'bot.install': 'bots',
  'bot.revoke': 'bots',
  'bot.profile': 'bots',
  'bot.permissions': 'bots',
  'bot.settings': 'bots',
  'bot.command': 'bots',
  'message.delete': 'messages',
  'message.restore': 'messages',
  'forum.update': 'messages',
  'forum.delete': 'messages',
} as const satisfies Record<string, ServerAuditCategory>;
export type ServerAuditAction = keyof typeof SERVER_AUDIT_ACTIONS;

/** Actions any member can repeat at will; they count against MAX_ACTIVITY_ENTRIES only. */
export const SERVER_AUDIT_ACTIVITY_ACTIONS: readonly ServerAuditAction[] = ['bot.command', 'member.join', 'member.nickname'];

export function isServerAuditAction(value: string): value is ServerAuditAction {
  return Object.prototype.hasOwnProperty.call(SERVER_AUDIT_ACTIONS, value);
}

/**
 * Actions, reference kinds and change fields travel as open identifiers so a
 * newer server can record something an older client does not know yet; the
 * client renders those generically instead of rejecting the whole page.
 */
const actionName = z.string().min(3).max(64).regex(/^[a-z]+(\.[a-z]+)+$/);
const identifier = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9]*$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const serverId = z.string().min(1).max(128);

export const serverAuditRefSchema = z.object({
  type: identifier,
  id: z.string().min(1).max(128),
  name: z.string().max(SERVER_AUDIT_LIMITS.MAX_NAME_LENGTH),
}).strict();

export const serverAuditValueSchema = z.union([
  z.string().max(SERVER_AUDIT_LIMITS.MAX_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(SERVER_AUDIT_LIMITS.MAX_NAME_LENGTH)).max(SERVER_AUDIT_LIMITS.MAX_LIST_ITEMS),
]);

/** A change without `before` and `after` only says that the field changed, e.g. a password. */
export const serverAuditChangeSchema = z.object({
  field: identifier,
  before: serverAuditValueSchema.optional(),
  after: serverAuditValueSchema.optional(),
}).strict();

export const serverAuditEntrySchema = z.object({
  id: counter.positive(),
  createdAt: counter,
  action: actionName,
  /** Null only for the server itself, e.g. an automatic change. */
  actor: serverAuditRefSchema.nullable(),
  target: serverAuditRefSchema.nullable(),
  /** Other things involved, such as where a member was moved from and to or the bot a command went to. */
  related: z.record(identifier, serverAuditRefSchema)
    .refine(related => Object.keys(related).length <= SERVER_AUDIT_LIMITS.MAX_RELATED),
  changes: z.array(serverAuditChangeSchema).max(SERVER_AUDIT_LIMITS.MAX_CHANGES),
  detail: z.string().max(SERVER_AUDIT_LIMITS.MAX_DETAIL_LENGTH).nullable(),
}).strict();

const entryId = counter.positive();

export const serverAuditGetSchema = z.object({
  serverId,
  /** Older entries than this id, for "load more". */
  before: entryId.optional(),
  /** Newer entries than this id, for live refresh. */
  after: entryId.optional(),
  category: z.enum(SERVER_AUDIT_CATEGORIES).optional(),
  /** Matches the names of whoever acted, the target and related items, and the detail. */
  query: z.string().trim().max(SERVER_AUDIT_LIMITS.MAX_QUERY_LENGTH).optional(),
  limit: z.number().int().min(1).max(SERVER_AUDIT_LIMITS.MAX_PAGE_SIZE).optional(),
}).strict().refine(request => request.before === undefined || request.after === undefined, {
  message: 'Use either before or after.',
});

export const serverAuditPageSchema = z.object({
  serverId,
  /** Newest first. */
  entries: z.array(serverAuditEntrySchema).max(SERVER_AUDIT_LIMITS.MAX_PAGE_SIZE),
  /** Older entries remain; after a refresh with `after`, newer entries than the page could hold remain. */
  hasMore: z.boolean(),
  retentionDays: z.number().int().positive().max(3650),
}).strict().superRefine((page, ctx) => {
  for (let index = 1; index < page.entries.length; index++) {
    if (page.entries[index].id >= page.entries[index - 1].id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Audit entries must be newest first.' });
      return;
    }
  }
});

export type ServerAuditRef = z.infer<typeof serverAuditRefSchema>;
export type ServerAuditValue = z.infer<typeof serverAuditValueSchema>;
export type ServerAuditChange = z.infer<typeof serverAuditChangeSchema>;
export type ServerAuditEntry = z.infer<typeof serverAuditEntrySchema>;
export type ServerAuditGetPayload = z.input<typeof serverAuditGetSchema>;
export type ServerAuditGetRequest = z.infer<typeof serverAuditGetSchema>;
export type ServerAuditPagePayload = z.infer<typeof serverAuditPageSchema>;
