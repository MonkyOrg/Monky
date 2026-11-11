import type { IdentityBanHistoryPage, IdentityBanHistoryRequest, IdentityBanModerator, IdentityBanNotice, IdentityBanSummary } from '@monky/shared';

export interface StoredIdentityBan extends IdentityBanSummary { historyId: number }

export interface IdentityAccessRepository {
  ban(publicKey: string): StoredIdentityBan | undefined;
  bans(): IdentityBanSummary[];
  history(request: IdentityBanHistoryRequest, now?: number): IdentityBanHistoryPage;
  saveBan(ban: IdentityBanSummary, moderator?: IdentityBanModerator): void;
  unban(publicKey: string, moderator?: IdentityBanModerator, expectedId?: number, now?: number): boolean;
  registerGuest(userId: string): void;
  retireGuest(userId: string): boolean;
  retireAllGuests(): void;
}

export function activeIdentityBan(
  repository: IdentityAccessRepository | undefined, publicKey: string | undefined, now = Date.now(),
): IdentityBanSummary | undefined {
  const ban = publicKey && repository?.ban(publicKey);
  return ban && (ban.expiresAt === null || ban.expiresAt > now) ? ban : undefined;
}

export function identityBanNotice(ban: IdentityBanSummary): IdentityBanNotice {
  return { expiresAt: ban.expiresAt, ...(ban.showReason ? { reason: ban.reason } : {}) };
}
