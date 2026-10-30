import { DEFAULT_PERMISSIONS, isAfkTimeoutSeconds, LIMITS, type VoiceMode } from '@monky/shared';
import type { ServerRecord } from './entities';

/**
 * Rules for changing the server settings, shared by every way in: the desktop
 * over the WebSocket (through `AuthService.updateServerSettings`) and
 * `monky config set`. The CLI used to keep its own copy, which had drifted: it
 * let the per-file attachment limit exceed the server total and left the
 * recent-sound cache on with the soundboard off (SHARED-CLI-9).
 *
 * Pure on purpose: reading the server, counting members, hashing a password,
 * storing an icon and minting the TURN secret stay with the caller.
 */

/** Shortest server name, after trimming. */
export const MIN_SERVER_NAME_LENGTH = 2;

/**
 * What each setting holds until someone changes it. A new server starts with
 * these, and reading one fills in any that is missing, so every other reader
 * takes the stored value as it is (S-APP-10).
 */
export const SERVER_SETTING_DEFAULTS = {
  everyonePermissions: DEFAULT_PERMISSIONS,
  maxMessageLength: LIMITS.MAX_MESSAGE_LENGTH,
  ownerUserId: null,
  allowSoundboard: true,
  dmRelayEnabled: true,
  recentSoundCacheEnabled: false,
  recentSoundCacheLimit: LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT,
  allowEveryoneMention: true,
  allowMessageEdit: true,
  messageDeleteUndoSeconds: LIMITS.MESSAGE_DELETE_UNDO_SECONDS,
  showRoleBadgesToEveryone: true,
  voiceMode: 'p2p',
  iconPath: null,
  maxAttachmentFileBytes: null,
  maxAttachmentStorageBytes: null,
  turnEnabled: false,
  afkChannelId: null,
  afkTimeoutSeconds: LIMITS.AFK_TIMEOUT_DEFAULT_SECONDS,
  maxBots: LIMITS.MAX_BOTS_DEFAULT,
  turnSecret: null,
} as const satisfies Omit<ServerRecord, 'id' | 'name' | 'passwordHash' | 'createdAt' | 'maxUsers'>;

/** The name as stored, or null when it is too short to be one. */
export function normalizeServerName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= MIN_SERVER_NAME_LENGTH ? trimmed : null;
}

/** Settings a change may carry, with the values it asks for. */
export interface ServerSettingsPatch {
  name?: string;
  maxMessageLength?: number;
  messageDeleteUndoSeconds?: number;
  maxAttachmentFileBytes?: number;
  maxAttachmentStorageBytes?: number;
  maxUsers?: number;
  allowSoundboard?: boolean;
  dmRelayEnabled?: boolean;
  recentSoundCacheEnabled?: boolean;
  recentSoundCacheLimit?: number;
  allowEveryoneMention?: boolean;
  allowMessageEdit?: boolean;
  showRoleBadgesToEveryone?: boolean;
  voiceMode?: VoiceMode;
  turnEnabled?: boolean;
  afkTimeoutSeconds?: number;
}

/** Why a change was refused. Each way in words it in its own language. */
export type ServerSettingsProblem =
  | { code: 'afk-timeout' }
  | { code: 'delete-undo-seconds' }
  | { code: 'max-message-length' }
  | { code: 'attachment-limits' }
  | { code: 'attachment-file-over-total'; fileBytes: number; totalBytes: number }
  | { code: 'max-users' }
  | { code: 'members-over-limit'; memberCount: number }
  | { code: 'recent-sound-cache-limit' }
  | { code: 'turn-in-sfu' };

export type ServerSettingsPlan =
  | { ok: true; updates: Partial<ServerRecord> }
  | { ok: false; problem: ServerSettingsProblem };

/** What the rules read from the stored server. */
export type CurrentServerSettings = Pick<
  ServerRecord, 'maxAttachmentFileBytes' | 'maxAttachmentStorageBytes' | 'voiceMode' | 'turnEnabled'
>;

/**
 * Decides what happens to the TURN relay when voice settings are saved.
 *
 * TURN and SFU are mutually exclusive: the SFU already receives and forwards
 * every stream, so it *is* the relay. Keeping coturn on would burn a second
 * relay hop, hand out credentials nobody uses and fight the SFU for UDP
 * ports (#515).
 *
 * The interesting case is not the obvious one. The desktop submits the current
 * voice mode on *every* save, so `turnEnabled: true` arriving next to
 * `voiceMode: 'sfu'` is the ordinary "admin whose relay was already on picks
 * SFU" migration — not a contradiction. Refusing it there would make the
 * P2P+TURN → SFU upgrade impossible from the UI, which is exactly the most
 * common upgrade path. Only switching the relay on against a server that is
 * *staying* in SFU is a genuine contradiction.
 *
 * `turnEnabled: undefined` in the result means "leave the stored value alone".
 */
export function resolveTurnSfuExclusion(
  current: { voiceMode?: string | null; turnEnabled?: boolean | null },
  requested: { voiceMode?: 'p2p' | 'sfu'; turnEnabled?: boolean }
): { rejected: boolean; turnEnabled: boolean | undefined } {
  const effectiveVoiceMode = requested.voiceMode ?? current.voiceMode ?? 'p2p';
  const switchingIntoSfu = requested.voiceMode === 'sfu' && current.voiceMode !== 'sfu';

  if (requested.turnEnabled === true && effectiveVoiceMode === 'sfu' && !switchingIntoSfu) {
    return { rejected: true, turnEnabled: undefined };
  }

  let turnEnabled = requested.turnEnabled;
  if (effectiveVoiceMode === 'sfu' && (turnEnabled || current.turnEnabled)) {
    turnEnabled = false;
  }
  return { rejected: false, turnEnabled };
}

function refuse(problem: ServerSettingsProblem): ServerSettingsPlan {
  return { ok: false, problem };
}

/**
 * Checks a settings change against the stored server and returns what to
 * store, or the first rule it breaks. Nothing is stored when one is broken.
 *
 * A name too short to be one is left as it was, as it always has been over the
 * WebSocket; the CLI refuses it beforehand with {@link normalizeServerName}.
 */
export function planServerSettingsUpdate(
  current: CurrentServerSettings,
  patch: ServerSettingsPatch,
  memberCount: number
): ServerSettingsPlan {
  const updates: Partial<ServerRecord> = {};
  if (patch.afkTimeoutSeconds !== undefined) {
    if (!isAfkTimeoutSeconds(patch.afkTimeoutSeconds)) return refuse({ code: 'afk-timeout' });
    updates.afkTimeoutSeconds = patch.afkTimeoutSeconds;
  }
  if (patch.messageDeleteUndoSeconds !== undefined) {
    if (!Number.isSafeInteger(patch.messageDeleteUndoSeconds) || patch.messageDeleteUndoSeconds < 1
      || patch.messageDeleteUndoSeconds > LIMITS.MAX_MESSAGE_DELETE_UNDO_SECONDS) {
      return refuse({ code: 'delete-undo-seconds' });
    }
    updates.messageDeleteUndoSeconds = patch.messageDeleteUndoSeconds;
  }
  if (patch.maxMessageLength !== undefined) {
    if (!Number.isSafeInteger(patch.maxMessageLength) || patch.maxMessageLength < 0) {
      return refuse({ code: 'max-message-length' });
    }
    updates.maxMessageLength = patch.maxMessageLength;
  }

  const name = patch.name ? normalizeServerName(patch.name) : null;
  if (name) updates.name = name;

  if (patch.maxAttachmentFileBytes !== undefined || patch.maxAttachmentStorageBytes !== undefined) {
    const nextFile = patch.maxAttachmentFileBytes
      ?? current.maxAttachmentFileBytes ?? LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT;
    const nextTotal = patch.maxAttachmentStorageBytes
      ?? current.maxAttachmentStorageBytes ?? LIMITS.MAX_ATTACHMENT_STORAGE_TOTAL_DEFAULT;
    if (!Number.isFinite(nextFile) || !Number.isFinite(nextTotal) || nextFile < 1 || nextTotal < 1) {
      return refuse({ code: 'attachment-limits' });
    }
    if (nextFile > nextTotal) {
      return refuse({ code: 'attachment-file-over-total', fileBytes: nextFile, totalBytes: nextTotal });
    }
    if (patch.maxAttachmentFileBytes !== undefined) updates.maxAttachmentFileBytes = Math.floor(nextFile);
    if (patch.maxAttachmentStorageBytes !== undefined) updates.maxAttachmentStorageBytes = Math.floor(nextTotal);
  }

  if (patch.maxUsers !== undefined) {
    const nextMax = Math.floor(patch.maxUsers);
    if (!Number.isFinite(nextMax) || nextMax < LIMITS.MAX_USERS_UNLIMITED) return refuse({ code: 'max-users' });
    // Refusing to drop below the current membership keeps the server out of an
    // "over the limit" state we would have no safe way to resolve — kicking
    // members automatically is never acceptable (#403).
    if (nextMax > LIMITS.MAX_USERS_UNLIMITED && nextMax < memberCount) {
      return refuse({ code: 'members-over-limit', memberCount });
    }
    updates.maxUsers = nextMax;
  }

  if (patch.allowSoundboard !== undefined) {
    updates.allowSoundboard = Boolean(patch.allowSoundboard);
    if (!updates.allowSoundboard) updates.recentSoundCacheEnabled = false;
  }
  if (patch.dmRelayEnabled !== undefined) {
    updates.dmRelayEnabled = Boolean(patch.dmRelayEnabled);
  }
  if (patch.recentSoundCacheEnabled !== undefined) {
    updates.recentSoundCacheEnabled = Boolean(patch.recentSoundCacheEnabled);
  }
  if (patch.recentSoundCacheLimit !== undefined) {
    if (!Number.isSafeInteger(patch.recentSoundCacheLimit)
      || patch.recentSoundCacheLimit < LIMITS.RECENT_SOUND_CACHE_MIN_LIMIT
      || patch.recentSoundCacheLimit > LIMITS.RECENT_SOUND_CACHE_MAX_LIMIT) {
      return refuse({ code: 'recent-sound-cache-limit' });
    }
    updates.recentSoundCacheLimit = patch.recentSoundCacheLimit;
  }
  if (patch.allowEveryoneMention !== undefined) {
    updates.allowEveryoneMention = Boolean(patch.allowEveryoneMention);
  }
  if (patch.allowMessageEdit !== undefined) {
    updates.allowMessageEdit = Boolean(patch.allowMessageEdit);
  }
  if (patch.showRoleBadgesToEveryone !== undefined) {
    updates.showRoleBadgesToEveryone = Boolean(patch.showRoleBadgesToEveryone);
  }
  if (patch.voiceMode !== undefined) {
    updates.voiceMode = patch.voiceMode === 'sfu' ? 'sfu' : 'p2p';
  }

  const relay = resolveTurnSfuExclusion(
    { voiceMode: current.voiceMode, turnEnabled: current.turnEnabled },
    {
      voiceMode: updates.voiceMode,
      turnEnabled: patch.turnEnabled === undefined ? undefined : Boolean(patch.turnEnabled),
    }
  );
  if (relay.rejected) return refuse({ code: 'turn-in-sfu' });
  if (relay.turnEnabled !== undefined) updates.turnEnabled = relay.turnEnabled;

  return { ok: true, updates };
}
