import { identityBanNoticeSchema, Permission } from '@monky/shared';
import type { ServerStore } from '../stores/serverStore';
import { getLanguage, t } from '../i18n';
import { appEvents } from '../core/EventBus';
import type { SessionBinding } from '../core/sessionBinding';
import type { ModalShell } from './modalShell';

export function bindIdentityBanAccess(shell: ModalShell, binding: SessionBinding, store: ServerStore, userId?: string): () => boolean {
  const current = () => {
    if (!binding.failure() && (userId ? canBanIdentity(store, userId) : canManageIdentityBans(store))) return true;
    shell.close('owner', true);
    return false;
  };
  for (const event of ['session.changed', 'network.status', 'server.updated', 'server.roles_updated', 'server.members_updated'] as const) {
    shell.signal.addEventListener('abort', appEvents.on(event, () => { current(); }), { once: true });
  }
  return current;
}

export function canManageIdentityBans(store: ServerStore): boolean {
  return store.hasPermission(Permission.MANAGE_SERVER) && store.serverDetails?.protocol?.features.includes('identity-bans') === true;
}

export function canBanIdentity(store: ServerStore, userId: string): boolean {
  const target = store.knownMembers.get(userId);
  return canManageIdentityBans(store) && !!target && !target.isBot && userId !== store.ownerId && userId !== store.currentUser?.id;
}

export function identityBanMessage(value: unknown): string {
  const parsed = identityBanNoticeSchema.safeParse(value);
  if (!parsed.success) return t('identity.banned');
  const ban = parsed.data;
  const duration = ban.expiresAt === null ? t('identity.banPermanent')
    : t('identity.banUntil', { time: new Date(ban.expiresAt).toLocaleString(getLanguage()) });
  return `${t('identity.banned')}\n${duration}${ban.reason ? `\n${t('identity.banReason')}: ${ban.reason}` : ''}`;
}
