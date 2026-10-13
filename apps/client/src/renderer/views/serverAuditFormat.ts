import {
  BOT_CAPABILITIES, SERVER_AUDIT_ACTIONS, isServerAuditAction,
  type BotCapability, type ServerAuditAction, type ServerAuditCategory, type ServerAuditChange,
  type ServerAuditEntry, type ServerAuditRef, type ServerAuditValue,
} from '@monky/shared';
import { getLanguage, t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';
import { formatBytes } from '../utils/attachment';

export const AUDIT_CATEGORY_ICONS: Record<ServerAuditCategory, string> = {
  channels: 'tag',
  roles: 'shield_person',
  members: 'group',
  voice: 'graphic_eq',
  server: 'dns',
  community: 'event',
  bots: 'smart_toy',
  messages: 'gavel',
};

export const AUDIT_CATEGORY_LABELS: Record<ServerAuditCategory, TranslationKey> = {
  channels: 'serverAudit.category.channels',
  roles: 'serverAudit.category.roles',
  members: 'serverAudit.category.members',
  voice: 'serverAudit.category.voice',
  server: 'serverAudit.category.server',
  community: 'serverAudit.category.community',
  bots: 'serverAudit.category.bots',
  messages: 'serverAudit.category.messages',
};

const ACTION_KEYS: Record<ServerAuditAction, TranslationKey> = {
  'channel.create': 'serverAudit.action.channel.create',
  'channel.update': 'serverAudit.action.channel.update',
  'channel.delete': 'serverAudit.action.channel.delete',
  'channel.move': 'serverAudit.action.channel.move',
  'category.create': 'serverAudit.action.category.create',
  'category.update': 'serverAudit.action.category.update',
  'category.delete': 'serverAudit.action.category.delete',
  'category.move': 'serverAudit.action.category.move',
  'role.create': 'serverAudit.action.role.create',
  'role.update': 'serverAudit.action.role.update',
  'role.delete': 'serverAudit.action.role.delete',
  'role.assign': 'serverAudit.action.role.assign',
  'role.unassign': 'serverAudit.action.role.unassign',
  'member.join': 'serverAudit.action.member.join',
  'member.kick': 'serverAudit.action.member.kick',
  'member.nickname': 'serverAudit.action.member.nickname',
  'voice.mute': 'serverAudit.action.voice.mute',
  'voice.unmute': 'serverAudit.action.voice.unmute',
  'voice.deafen': 'serverAudit.action.voice.deafen',
  'voice.undeafen': 'serverAudit.action.voice.undeafen',
  'voice.disconnect': 'serverAudit.action.voice.disconnect',
  'voice.move': 'serverAudit.action.voice.move',
  'server.update': 'serverAudit.action.server.update',
  'community.update': 'serverAudit.action.community.update',
  'event.create': 'serverAudit.action.event.create',
  'event.update': 'serverAudit.action.event.update',
  'event.start': 'serverAudit.action.event.start',
  'event.end': 'serverAudit.action.event.end',
  'event.cancel': 'serverAudit.action.event.cancel',
  'event.delete': 'serverAudit.action.event.delete',
  'live.create': 'serverAudit.action.live.create',
  'live.update': 'serverAudit.action.live.update',
  'live.close': 'serverAudit.action.live.close',
  'form.create': 'serverAudit.action.form.create',
  'form.close': 'serverAudit.action.form.close',
  'poll.create': 'serverAudit.action.poll.create',
  'poll.edit': 'serverAudit.action.poll.edit',
  'poll.close': 'serverAudit.action.poll.close',
  'bot.create': 'serverAudit.action.bot.create',
  'bot.install': 'serverAudit.action.bot.install',
  'bot.revoke': 'serverAudit.action.bot.revoke',
  'bot.profile': 'serverAudit.action.bot.profile',
  'bot.permissions': 'serverAudit.action.bot.permissions',
  'bot.settings': 'serverAudit.action.bot.settings',
  'bot.command': 'serverAudit.action.bot.command',
  'message.delete': 'serverAudit.action.message.delete',
  'message.restore': 'serverAudit.action.message.restore',
  'forum.update': 'serverAudit.action.forum.update',
  'forum.delete': 'serverAudit.action.forum.delete',
};

const RELATED_KEYS: Record<string, TranslationKey> = {
  from: 'serverAudit.related.from',
  to: 'serverAudit.related.to',
  channel: 'serverAudit.related.channel',
  category: 'serverAudit.related.category',
  role: 'serverAudit.related.role',
  bot: 'serverAudit.related.bot',
  author: 'serverAudit.related.author',
  invoker: 'serverAudit.related.invoker',
};

const FIELD_KEYS: Record<string, TranslationKey> = {
  name: 'serverAudit.field.name',
  type: 'serverAudit.field.type',
  userLimit: 'serverAudit.field.userLimit',
  category: 'serverAudit.field.category',
  syncPermissions: 'serverAudit.field.syncPermissions',
  private: 'serverAudit.field.private',
  botCommands: 'serverAudit.field.botCommands',
  permissions: 'serverAudit.field.permissions',
  position: 'serverAudit.field.position',
  color: 'serverAudit.field.color',
  isDefault: 'serverAudit.field.isDefault',
  permissionsGranted: 'serverAudit.field.permissionsGranted',
  permissionsRevoked: 'serverAudit.field.permissionsRevoked',
  nickname: 'serverAudit.field.nickname',
  password: 'serverAudit.field.password',
  icon: 'serverAudit.field.icon',
  maxUsers: 'serverAudit.field.maxUsers',
  maxMessageLength: 'serverAudit.field.maxMessageLength',
  deleteUndoSeconds: 'serverAudit.field.deleteUndoSeconds',
  allowSoundboard: 'serverAudit.field.allowSoundboard',
  dmRelay: 'serverAudit.field.dmRelay',
  recentSounds: 'serverAudit.field.recentSounds',
  recentSoundsLimit: 'serverAudit.field.recentSoundsLimit',
  everyoneMention: 'serverAudit.field.everyoneMention',
  messageEdit: 'serverAudit.field.messageEdit',
  roleBadges: 'serverAudit.field.roleBadges',
  voiceMode: 'serverAudit.field.voiceMode',
  relay: 'serverAudit.field.relay',
  maxFileSize: 'serverAudit.field.maxFileSize',
  maxStorage: 'serverAudit.field.maxStorage',
  maxBots: 'serverAudit.field.maxBots',
  eventsEnabled: 'serverAudit.field.eventsEnabled',
  banner: 'serverAudit.field.banner',
  title: 'serverAudit.field.title',
  description: 'serverAudit.field.description',
  startsAt: 'serverAudit.field.startsAt',
  endsAt: 'serverAudit.field.endsAt',
  expiresAt: 'serverAudit.field.expiresAt',
  closesAt: 'serverAudit.field.closesAt',
  location: 'serverAudit.field.location',
  repeat: 'serverAudit.field.repeat',
  audience: 'serverAudit.field.audience',
  images: 'serverAudit.field.images',
  question: 'serverAudit.field.question',
  options: 'serverAudit.field.options',
  allowMultiple: 'serverAudit.field.allowMultiple',
  anonymousVotes: 'serverAudit.field.anonymousVotes',
  maxVoters: 'serverAudit.field.maxVoters',
  liveAction: 'serverAudit.field.liveAction',
  capabilitiesGranted: 'serverAudit.field.capabilitiesGranted',
  capabilitiesRevoked: 'serverAudit.field.capabilitiesRevoked',
  settings: 'serverAudit.field.settings',
  commandOptions: 'serverAudit.field.commandOptions',
  pinned: 'serverAudit.field.pinned',
  locked: 'serverAudit.field.locked',
  closed: 'serverAudit.field.closed',
};

const PERMISSION_KEYS: Record<string, TranslationKey> = {
  MANAGE_CHANNELS: 'permissions.manageChannels',
  MANAGE_SERVER: 'permissions.manageServer',
  MANAGE_ROLES: 'permissions.manageRoles',
  KICK_MEMBERS: 'permissions.kickMembers',
  SPEAK: 'permissions.speak',
  MUTE_MEMBERS: 'permissions.muteMembers',
  DEAFEN_MEMBERS: 'permissions.deafenMembers',
  MOVE_MEMBERS: 'permissions.moveMembers',
  SEND_MESSAGES: 'permissions.sendMessages',
  READ_MESSAGES: 'permissions.readMessages',
  ATTACH_FILES: 'permissions.attachFiles',
  ADMINISTRATOR: 'permissions.administrator',
  USE_SOUNDBOARD: 'permissions.useSoundboard',
  MANAGE_BOTS: 'permissions.manageBots',
  USE_BOT_COMMANDS: 'permissions.useBotCommands',
  CONFIGURE_BOTS: 'permissions.configureBots',
  VIEW_SERVER_MONITOR: 'permissions.viewServerMonitor',
  MANAGE_EVENTS: 'permissions.manageEvents',
  EMIT_LIVE_ACTIONS: 'permissions.emitLiveActions',
  VIEW_CHANNEL: 'permissions.viewChannel',
  VIEW_AUDIT_LOG: 'permissions.viewAuditLog',
};

const VALUE_KEYS: Record<string, Record<string, TranslationKey>> = {
  type: { TEXT: 'serverAudit.channelType.TEXT', VOICE: 'serverAudit.channelType.VOICE', FORUM: 'serverAudit.channelType.FORUM' },
  repeat: { none: 'community.none', daily: 'community.daily', weekly: 'community.weekly', monthly: 'community.monthly' },
};

const TIME_FIELDS = new Set(['startsAt', 'endsAt', 'expiresAt', 'closesAt']);
const BYTE_FIELDS = new Set(['maxFileSize', 'maxStorage']);

function isBotCapability(value: string): value is BotCapability {
  return BOT_CAPABILITIES.some((capability) => capability === value);
}

export function auditCategory(action: string): ServerAuditCategory | null {
  return isServerAuditAction(action) ? SERVER_AUDIT_ACTIONS[action] : null;
}

export function formatAuditTime(timestamp: number): string {
  return new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
}

function formatListItem(field: string, item: string): string {
  if (field === 'permissionsGranted' || field === 'permissionsRevoked') {
    const key = PERMISSION_KEYS[item];
    return key ? t(key) : item;
  }
  if ((field === 'capabilitiesGranted' || field === 'capabilitiesRevoked') && isBotCapability(item)) {
    return t(`botPermissions.${item}.title`);
  }
  return item;
}

/** A value as members read it: localized booleans and enumerations, dates, sizes and lists. */
export function formatAuditValue(field: string, value: ServerAuditValue): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return t(value ? 'serverAudit.yes' : 'serverAudit.no');
  if (Array.isArray(value)) return value.length ? value.map((item) => formatListItem(field, item)).join(', ') : '—';
  if (typeof value === 'number') {
    if (TIME_FIELDS.has(field)) return formatAuditTime(value);
    if (BYTE_FIELDS.has(field)) return formatBytes(value);
    return new Intl.NumberFormat(getLanguage()).format(value);
  }
  const key = VALUE_KEYS[field]?.[value];
  if (key) return t(key);
  return field === 'voiceMode' ? value.toUpperCase() : value;
}

export interface FormattedAuditChange {
  label: string;
  before?: string;
  after?: string;
  /** Only that the field changed, e.g. a password whose value is never recorded. */
  changedOnly: boolean;
}

export function formatAuditChange(change: ServerAuditChange): FormattedAuditChange {
  const key = FIELD_KEYS[change.field];
  return {
    label: key ? t(key) : change.field,
    before: change.before === undefined ? undefined : formatAuditValue(change.field, change.before),
    after: change.after === undefined ? undefined : formatAuditValue(change.field, change.after),
    changedOnly: change.before === undefined && change.after === undefined,
  };
}

function strong(text: string): string {
  return `<strong>${escapeHtml(text)}</strong>`;
}

function refName(ref: ServerAuditRef | null | undefined): string {
  return ref ? ref.name || ref.id : t('serverAudit.removed');
}

export interface FormattedAuditEntry {
  icon: string;
  /** HTML with every name escaped. */
  summary: string;
  related: Array<{ label: string; name: string }>;
  changes: FormattedAuditChange[];
}

export function formatAuditEntry(entry: ServerAuditEntry): FormattedAuditEntry {
  const category = auditCategory(entry.action);
  const key = isServerAuditAction(entry.action) ? ACTION_KEYS[entry.action] : 'serverAudit.action.unknown';
  const template = t(key);
  const params: Record<string, string> = {
    actor: strong(entry.actor ? refName(entry.actor) : t('serverAudit.system')),
    target: strong(refName(entry.target)),
    command: strong(entry.detail ?? ''),
    action: escapeHtml(entry.action),
  };
  for (const name of Object.keys(RELATED_KEYS)) params[name] = strong(refName(entry.related[name]));
  // Anything the sentence does not mention is still shown beside it.
  const related = Object.entries(entry.related)
    .filter(([name]) => !template.includes(`{${name}}`))
    .map(([name, ref]) => ({ label: RELATED_KEYS[name] ? t(RELATED_KEYS[name]) : name, name: refName(ref) }));
  return {
    icon: category ? AUDIT_CATEGORY_ICONS[category] : 'history',
    summary: t(key, params),
    related,
    changes: entry.changes.map(formatAuditChange),
  };
}
