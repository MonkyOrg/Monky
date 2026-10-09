import {
  LIMITS, Permission, channelPermissionTargetKey, channelTreeRoot,
  type ChannelCategory, type ChannelPermissionOverwrite, type ChannelSummary, type ServerAuditChange,
  type ServerAuditRef, type ServerEvent,
} from '@monky/shared';
import type { NativePollRecord, ServerRecord } from '../../domain/entities';
import { auditDiff, auditRef } from './ServerAuditService';

/** Names the audit shows for ids that changes refer to. */
export interface AuditNames {
  category(id: string | null | undefined): string | null;
  role(id: string): string;
  user(id: string): string;
}

const PERMISSION_FLAGS = Object.entries(Permission).flatMap(([name, value]) =>
  typeof value === 'number' ? [{ name, value }] : []);

/** Permission names in `bits`, in declaration order. */
export function permissionNames(bits: number): string[] {
  return PERMISSION_FLAGS.filter(({ value }) => (bits & value) !== 0).map(({ name }) => name);
}

/** What a role grants after a change compared with before, by permission name. */
export function permissionChanges(before: number, after: number): ServerAuditChange[] {
  const granted = permissionNames(after & ~before);
  const revoked = permissionNames(before & ~after);
  return [
    ...(granted.length ? [{ field: 'permissionsGranted', after: granted }] : []),
    ...(revoked.length ? [{ field: 'permissionsRevoked', after: revoked }] : []),
  ];
}

function overwriteTargetName(overwrite: ChannelPermissionOverwrite, names: AuditNames): string {
  if (overwrite.userId !== undefined) return names.user(overwrite.userId);
  return overwrite.roleId === null ? '@everyone' : names.role(overwrite.roleId);
}

/** The roles and members whose channel permissions differ, by name. */
function overwriteChanges(
  before: readonly ChannelPermissionOverwrite[] | undefined, after: readonly ChannelPermissionOverwrite[] | undefined, names: AuditNames,
): ServerAuditChange[] {
  const index = (overwrites: readonly ChannelPermissionOverwrite[] | undefined) =>
    new Map((overwrites ?? []).map((overwrite) => [channelPermissionTargetKey(overwrite), overwrite]));
  const previous = index(before);
  const next = index(after);
  const changed: string[] = [];
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    const a = previous.get(key);
    const b = next.get(key);
    if ((a?.allow ?? 0) !== (b?.allow ?? 0) || (a?.deny ?? 0) !== (b?.deny ?? 0)) {
      const overwrite = b ?? a;
      if (overwrite) changed.push(overwriteTargetName(overwrite, names));
    }
  }
  return changed.length ? [{ field: 'permissions', after: changed }] : [];
}

export function channelChanges(before: ChannelSummary, after: ChannelSummary, names: AuditNames): ServerAuditChange[] {
  const sameCategory = (before.categoryId ?? null) === (after.categoryId ?? null);
  return [
    ...auditDiff([
      ['name', before.name, after.name],
      ['userLimit', before.maxParticipants ?? null, after.maxParticipants ?? null],
      ['category', names.category(before.categoryId), names.category(after.categoryId)],
      ['syncPermissions', sameCategory && after.categoryId ? before.inheritCategoryPermissions !== false : undefined,
        sameCategory && after.categoryId ? after.inheritCategoryPermissions !== false : undefined],
      ['private', before.isPrivate, after.isPrivate],
      ['botCommands', before.botCommandsEnabled, after.botCommandsEnabled],
    ]),
    ...overwriteChanges(before.permissionOverwrites, after.permissionOverwrites, names),
  ];
}

/** What a new channel or category starts with, so the creation entry tells more than its name. */
export function channelCreationChanges(channel: ChannelSummary, names: AuditNames): ServerAuditChange[] {
  return auditDiff([
    ['type', undefined, channel.type],
    ['category', undefined, names.category(channel.categoryId) ?? undefined],
    ['userLimit', undefined, channel.type === 'VOICE' ? channel.maxParticipants ?? undefined : undefined],
    ['private', undefined, channel.isPrivate || undefined],
  ]);
}

export function categoryChanges(before: ChannelCategory, after: ChannelCategory, names: AuditNames): ServerAuditChange[] {
  return [
    ...auditDiff([
      ['name', before.name, after.name],
      ['private', before.isPrivate, after.isPrivate],
    ]),
    ...overwriteChanges(before.permissionOverwrites, after.permissionOverwrites, names),
  ];
}

interface ChannelTreeSnapshot {
  channels: readonly ChannelSummary[];
  categories: readonly ChannelCategory[];
}

export interface AuditMove {
  target: ServerAuditRef;
  /** The category the item moved inside of; absent at the top of the list. */
  container: ServerAuditRef | null;
  from: number;
  to: number;
}

/**
 * The fewest items whose move explains the new order: everything on the
 * longest run that kept its relative order stayed put. A drag shifts every
 * position after it, but only the dragged item actually moved.
 */
export function movedItems(before: readonly string[], after: readonly string[]): Array<{ id: string; from: number; to: number }> {
  const beforeIndex = new Map(before.map((id, index) => [id, index]));
  const afterIndex = new Map(after.map((id, index) => [id, index]));
  const common = after.filter((id) => beforeIndex.has(id));
  const sequence = common.map((id) => beforeIndex.get(id) ?? 0);
  const tails: number[] = [];
  const previous: number[] = new Array(sequence.length).fill(-1);
  for (let index = 0; index < sequence.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sequence[tails[middle]] < sequence[index]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const kept = new Set<string>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) kept.add(common[index]);
  return common.filter((id) => !kept.has(id)).map((id) => ({
    id, from: (beforeIndex.get(id) ?? 0) + 1, to: (afterIndex.get(id) ?? 0) + 1,
  }));
}

/** Items that changed place inside the same container between two snapshots of the channel list. */
export function channelTreeMoves(before: ChannelTreeSnapshot, after: ChannelTreeSnapshot): AuditMove[] {
  const refFor = (snapshot: ChannelTreeSnapshot, id: string): ServerAuditRef | null => {
    const category = snapshot.categories.find((entry) => entry.id === id);
    if (category) return auditRef.category(category);
    const channel = snapshot.channels.find((entry) => entry.id === id);
    return channel ? auditRef.channel(channel) : null;
  };
  const containerOrder = (snapshot: ChannelTreeSnapshot, categoryId: string) => snapshot.channels
    .filter((channel) => !channel.forumId && channel.categoryId === categoryId)
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
    .map((channel) => channel.id);
  const containers: Array<{ container: ServerAuditRef | null; before: string[]; after: string[] }> = [{
    container: null,
    before: channelTreeRoot(before.channels, before.categories).map((item) => item.id),
    after: channelTreeRoot(after.channels, after.categories).map((item) => item.id),
  }, ...after.categories.map((category) => ({
    container: auditRef.category(category),
    before: containerOrder(before, category.id),
    after: containerOrder(after, category.id),
  }))];
  return containers.flatMap(({ container, before: previous, after: next }) =>
    movedItems(previous, next).flatMap(({ id, from, to }) => {
      const target = refFor(after, id);
      return target ? [{ target, container, from, to }] : [];
    }));
}

/** Settings as members see them, with the same defaults the server applies. */
function serverSettings(server: ServerRecord) {
  return {
    name: server.name,
    maxUsers: server.maxUsers,
    maxMessageLength: server.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH,
    deleteUndoSeconds: server.messageDeleteUndoSeconds ?? LIMITS.MESSAGE_DELETE_UNDO_SECONDS,
    allowSoundboard: server.allowSoundboard !== false,
    dmRelay: server.dmRelayEnabled !== false,
    recentSounds: Boolean(server.recentSoundCacheEnabled),
    recentSoundsLimit: server.recentSoundCacheLimit ?? LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT,
    everyoneMention: server.allowEveryoneMention !== false,
    messageEdit: server.allowMessageEdit !== false,
    roleBadges: server.showRoleBadgesToEveryone !== false,
    voiceMode: server.voiceMode ?? 'p2p',
    relay: Boolean(server.turnEnabled),
    maxFileSize: server.maxAttachmentFileBytes ?? null,
    maxStorage: server.maxAttachmentStorageBytes ?? null,
    maxBots: server.maxBots ?? LIMITS.MAX_BOTS_DEFAULT,
  };
}

/** Secrets are never stored: a password or icon change only says that it changed. */
export function serverSettingsChanges(before: ServerRecord, after: ServerRecord): ServerAuditChange[] {
  const previous = serverSettings(before);
  const next = serverSettings(after);
  const hadPassword = Boolean(before.passwordHash);
  const hasPassword = Boolean(after.passwordHash);
  return [
    ...auditDiff([
      ['name', previous.name, next.name],
      ['maxUsers', previous.maxUsers, next.maxUsers],
      ['maxMessageLength', previous.maxMessageLength, next.maxMessageLength],
      ['deleteUndoSeconds', previous.deleteUndoSeconds, next.deleteUndoSeconds],
      ['allowSoundboard', previous.allowSoundboard, next.allowSoundboard],
      ['dmRelay', previous.dmRelay, next.dmRelay],
      ['recentSounds', previous.recentSounds, next.recentSounds],
      ['recentSoundsLimit', previous.recentSoundsLimit, next.recentSoundsLimit],
      ['everyoneMention', previous.everyoneMention, next.everyoneMention],
      ['messageEdit', previous.messageEdit, next.messageEdit],
      ['roleBadges', previous.roleBadges, next.roleBadges],
      ['voiceMode', previous.voiceMode, next.voiceMode],
      ['relay', previous.relay, next.relay],
      ['maxFileSize', previous.maxFileSize, next.maxFileSize],
      ['maxStorage', previous.maxStorage, next.maxStorage],
      ['maxBots', previous.maxBots, next.maxBots],
    ]),
    ...(hadPassword !== hasPassword ? [{ field: 'password', before: hadPassword, after: hasPassword }]
      : hasPassword && before.passwordHash !== after.passwordHash ? [{ field: 'password' }] : []),
    ...((before.iconPath ?? null) !== (after.iconPath ?? null) ? [{ field: 'icon' }] : []),
  ];
}

function eventLocation(event: ServerEvent, channelName: (id: string) => string): string {
  return event.location.kind === 'external' ? event.location.label : channelName(event.location.channelId);
}

export function eventChanges(
  before: ServerEvent | undefined, after: ServerEvent, channelName: (id: string) => string,
): ServerAuditChange[] {
  if (!before) {
    return auditDiff([
      ['startsAt', undefined, after.startsAt],
      ['endsAt', undefined, after.endsAt ?? undefined],
      ['location', undefined, eventLocation(after, channelName)],
      ['repeat', undefined, after.repeat === 'none' ? undefined : after.repeat],
    ]);
  }
  return [
    ...auditDiff([
      ['title', before.title, after.title],
      ['startsAt', before.startsAt, after.startsAt],
      ['endsAt', before.endsAt, after.endsAt],
      ['location', eventLocation(before, channelName), eventLocation(after, channelName)],
      ['repeat', before.repeat, after.repeat],
    ]),
    ...(before.description !== after.description ? [{ field: 'description' }] : []),
    ...(JSON.stringify(before.audience) !== JSON.stringify(after.audience) ? [{ field: 'audience' }] : []),
    ...(JSON.stringify(before.imageUrls) !== JSON.stringify(after.imageUrls) ? [{ field: 'images' }] : []),
  ];
}

export function pollChanges(before: NativePollRecord | undefined, after: NativePollRecord): ServerAuditChange[] {
  const options = (poll: NativePollRecord) => poll.options.map((option) => option.emoji ? `${option.emoji} ${option.label}` : option.label);
  if (!before) {
    return auditDiff([
      ['options', undefined, options(after)],
      ['liveAction', undefined, after.liveAction || undefined],
    ]);
  }
  return [
    ...auditDiff([
      ['question', before.question, after.question],
      ['options', options(before), options(after)],
      ['allowMultiple', before.allowMultiple, after.allowMultiple],
      ['anonymousVotes', before.anonymousVotes, after.anonymousVotes],
      ['closesAt', before.closesAt, after.closesAt],
      ['maxVoters', before.maxVoters, after.maxVoters],
      ['liveAction', before.liveAction, after.liveAction],
    ]),
    ...(JSON.stringify(before.audience) !== JSON.stringify(after.audience) ? [{ field: 'audience' }] : []),
    ...(JSON.stringify(before.imagePaths) !== JSON.stringify(after.imagePaths) ? [{ field: 'images' }] : []),
  ];
}
