import { MessageType, type DmSelfProfile, type DmSelfProfileInput } from '@monky/shared';
import { sessionManager } from './SessionManager';
import { clientLog } from './ClientLogService';
import { connectionStore } from '../stores/connectionStore';
import { dmStore } from '../stores/dmStore';
import { getAvatarUrl } from '../utils/avatar';

/**
 * Nickname and avatar travel with the identity (#743 follow-up): every device
 * of the same identity converges on the newest choice, and friends see it in
 * their DMs. The main process keeps the shared profile; this module keeps the
 * local copy (localStorage) in step with it.
 */

const STAMPS_KEY = 'monky_profile_at';
/** Data URL length the avatar thumbnail aims for; the hard cap lives in shared. */
const THUMBNAIL_TARGET_LENGTH = 60_000;
const THUMBNAIL_SIZES = [256, 192, 128, 96];
const THUMBNAIL_QUALITIES = [0.8, 0.65, 0.5];

interface ProfileStamps {
  nicknameAt: number;
  avatarAt: number;
}

function readStamps(): ProfileStamps {
  try {
    const parsed = JSON.parse(localStorage.getItem(STAMPS_KEY) || '{}') as Partial<ProfileStamps>;
    return {
      nicknameAt: typeof parsed.nicknameAt === 'number' && parsed.nicknameAt > 0 ? parsed.nicknameAt : 0,
      avatarAt: typeof parsed.avatarAt === 'number' && parsed.avatarAt > 0 ? parsed.avatarAt : 0,
    };
  } catch {
    return { nicknameAt: 0, avatarAt: 0 };
  }
}

function writeStamps(stamps: ProfileStamps): void {
  try {
    localStorage.setItem(STAMPS_KEY, JSON.stringify(stamps));
  } catch {
    // Without stamps the local values only seed an empty profile; nothing breaks.
  }
}

export function clearProfileStamps(): void {
  try {
    localStorage.removeItem(STAMPS_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Marks the local nickname/avatar as chosen now, before DMs are running. */
export function stampProfileChange(fields: { nickname?: boolean; avatar?: boolean }, at = Date.now()): void {
  const stamps = readStamps();
  if (fields.nickname) stamps.nicknameAt = Math.max(stamps.nicknameAt + 1, at);
  if (fields.avatar) stamps.avatarAt = Math.max(stamps.avatarAt + 1, at);
  writeStamps(stamps);
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Avatar could not be decoded'));
    image.src = source;
  });
}

/** The cropped avatar is a 512px PNG; DMs carry a small WebP of it instead. */
export async function makeProfileThumbnail(source: string): Promise<string | null> {
  if (!source.startsWith('data:image/')) return null;
  // A picture received from another device is already a thumbnail; encoding it
  // again would yield different bytes and restart the exchange on every launch.
  if (source.startsWith('data:image/webp;base64,') && source.length <= THUMBNAIL_TARGET_LENGTH) return source;
  try {
    const image = await loadImage(source);
    let smallest: string | null = null;
    for (const size of THUMBNAIL_SIZES) {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, size / Math.max(image.naturalWidth || size, image.naturalHeight || size));
      canvas.width = Math.max(1, Math.round((image.naturalWidth || size) * scale));
      canvas.height = Math.max(1, Math.round((image.naturalHeight || size) * scale));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of THUMBNAIL_QUALITIES) {
        const encoded = canvas.toDataURL('image/webp', quality);
        if (!encoded.startsWith('data:image/webp')) return null;
        if (encoded.length <= THUMBNAIL_TARGET_LENGTH) return encoded;
        if (!smallest || encoded.length < smallest.length) smallest = encoded;
      }
    }
    return smallest;
  } catch (error) {
    clientLog.warn('DM', 'Could not prepare the profile picture', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Own avatar for local rendering, even when this device never saved one. */
export function ownAvatarSource(): string | null {
  if (connectionStore.savedAvatarBase64) return connectionStore.savedAvatarBase64;
  for (const session of sessionManager.getAll()) {
    const url = session.serverStore.currentUser?.avatarUrl;
    if (!url) continue;
    if (!url.startsWith('/')) return url;
    const base = session.client.getHttpBaseUrl();
    if (base) return `${base}${url}`;
  }
  return null;
}

/** Writes a nickname/avatar to this device and to every server it is on. */
export function applyProfileEverywhere(change: { nickname?: string; avatar?: string | null }): void {
  const { nickname, avatar } = change;
  for (const session of sessionManager.getAll()) {
    const user = session.serverStore.currentUser;
    if (user) {
      session.serverStore.updateCurrentUser({
        ...user,
        ...(nickname !== undefined ? { nickname } : {}),
        ...(avatar ? { avatarUrl: avatar } : {}),
      });
    }
    if (session.client.getStatus() !== 'CONNECTED') continue;
    if (nickname !== undefined) session.client.send(MessageType.USER_CHANGE_NICKNAME, { newNickname: nickname });
    if (avatar) session.client.send(MessageType.USER_UPDATE_AVATAR, { avatarBase64: avatar });
  }
  connectionStore.saveUserProfile(nickname ?? connectionStore.savedNickname, avatar);
  if (nickname !== undefined) {
    const footerName = document.getElementById('main-user-name');
    if (footerName) footerName.textContent = nickname;
  }
  if (avatar !== undefined) {
    const footerAvatar = document.getElementById('main-user-avatar') as HTMLImageElement | null;
    if (footerAvatar) footerAvatar.src = getAvatarUrl(avatar ?? ownAvatarSource());
  }
  dmStore.bus.emit('changed');
}

/**
 * Adopts the shared profile. `pushed` is what this device just sent: when the
 * same value comes back only its timestamp is kept, so the full-size local
 * avatar is not replaced by its own thumbnail.
 */
function adoptProfile(profile: DmSelfProfile, pushed: { nickname?: string; avatar?: string | null } = {}): void {
  const stamps = readStamps();
  const change: { nickname?: string; avatar?: string | null } = {};
  if (profile.nickname && profile.nicknameAt > stamps.nicknameAt) {
    stamps.nicknameAt = profile.nicknameAt;
    if (profile.nickname !== (pushed.nickname ?? connectionStore.savedNickname)) change.nickname = profile.nickname;
  }
  if (profile.avatarAt > stamps.avatarAt) {
    stamps.avatarAt = profile.avatarAt;
    const same = pushed.avatar !== undefined && profile.avatar === pushed.avatar;
    // A missing picture never erases a local one: remote removal is not something the UI offers.
    if (!same && profile.avatar) change.avatar = profile.avatar;
  }
  writeStamps(stamps);
  if (change.nickname !== undefined || change.avatar !== undefined) applyProfileEverywhere(change);
}

async function localInput(): Promise<{ input: DmSelfProfileInput; pushed: { nickname?: string; avatar?: string | null } }> {
  const stamps = readStamps();
  const nickname = connectionStore.savedNickname.trim();
  const input: DmSelfProfileInput = {};
  const pushed: { nickname?: string; avatar?: string | null } = {};
  if (nickname) {
    input.nickname = nickname;
    input.nicknameAt = stamps.nicknameAt;
    pushed.nickname = nickname;
  }
  const avatar = connectionStore.savedAvatarBase64;
  const thumbnail = avatar ? await makeProfileThumbnail(avatar) : null;
  if (thumbnail) {
    input.avatar = thumbnail;
    input.avatarAt = stamps.avatarAt;
    pushed.avatar = thumbnail;
  }
  return { input, pushed };
}

async function pushLocalProfile(): Promise<void> {
  const { input, pushed } = await localInput();
  const profile = await dmStore.setSelfProfile(input);
  if (profile) adoptProfile(profile, pushed);
}

/** Records an explicit nickname/avatar change and shares it with own devices and friends. */
export async function recordProfileChange(fields: { nickname?: boolean; avatar?: boolean }): Promise<void> {
  stampProfileChange(fields);
  await pushLocalProfile();
}

/** Starts the profile exchange; call once DMs are running. */
export async function initProfileSync(): Promise<() => void> {
  const off = dmStore.bus.on('self-profile', (data: { profile: DmSelfProfile }) => adoptProfile(data.profile));
  await pushLocalProfile().catch((error: unknown) => {
    clientLog.warn('DM', 'Profile sync failed to start', { error: error instanceof Error ? error.message : String(error) });
  });
  return off;
}
