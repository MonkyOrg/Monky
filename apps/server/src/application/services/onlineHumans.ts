import type { UserSummary } from '@monky/shared';

/** Human identities, not sockets or bot accounts, count as connected people. */
export function listOnlineHumans(sessions: Iterable<{ user: UserSummary }>): UserSummary[] {
  const people = new Map<string, UserSummary>();
  for (const { user } of sessions) {
    if (!user.isBot && !people.has(user.id)) people.set(user.id, user);
  }
  return [...people.values()];
}
