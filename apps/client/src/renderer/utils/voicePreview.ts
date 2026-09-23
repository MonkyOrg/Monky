export interface VoicePreviewUser {
  nickname: string;
  avatarUrl: string | null;
}

export interface HomeVoicePreview {
  count: number | null;
  users: VoicePreviewUser[];
  memberCount: number | null;
  maxUsers: number | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseHomeVoicePreview(value: unknown): HomeVoicePreview {
  const result: HomeVoicePreview = { count: null, users: [], memberCount: null, maxUsers: null };
  if (!value || typeof value !== 'object') return result;
  result.count = count('voiceUserCount' in value ? value.voiceUserCount : undefined);
  result.memberCount = count('memberCount' in value ? value.memberCount : undefined);
  result.maxUsers = count('maxUsers' in value ? value.maxUsers : undefined);
  // The preview is deduplicated by person on the server, after filtering voice
  // sessions. Online members/statuses cannot stand in for physical occupancy.
  if (!result.count || !('voiceUsers' in value) || !Array.isArray(value.voiceUsers)) return result;
  for (const user of value.voiceUsers) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) continue;
    result.users.push({
      nickname: 'nickname' in user && typeof user.nickname === 'string' ? user.nickname : '',
      avatarUrl: 'avatarUrl' in user && typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
    });
    if (result.users.length >= Math.min(5, result.count)) break;
  }
  return result;
}
