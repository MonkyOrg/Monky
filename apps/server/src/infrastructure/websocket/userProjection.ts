import type { CustomStatus, ProtocolAgreement, UserSummary } from '@monky/shared';

/**
 * A person as one recipient may see them: presence fields its app did not
 * negotiate are dropped. Older clients would ignore the game (#675) anyway,
 * but its icon is up to 32 KB per update and nothing on their side shows it.
 */
export function userForRecipient(recipient: { protocol?: ProtocolAgreement }, user: UserSummary): UserSummary {
  const features = recipient.protocol?.features;
  let shared = user;
  if (shared.activity !== undefined && !features?.includes('game-activity')) shared = { ...shared, activity: undefined };
  // Peers without user-brb keep seeing a plain online person.
  if (shared.brb !== undefined && !features?.includes('user-brb')) shared = { ...shared, brb: undefined };
  if (shared.customStatus !== undefined && !features?.includes('custom-status')) shared = { ...shared, customStatus: undefined };
  return shared;
}

/** Whether two devices of one person show the same custom status (custom-status). */
export function sameCustomStatus(a: CustomStatus | undefined, b: CustomStatus | undefined): boolean {
  if (!a || !b) return a === b;
  return a.text === b.text && a.emoji === b.emoji && a.tag === b.tag && a.color === b.color
    && a.showEmoji === b.showEmoji && a.showTag === b.showTag;
}
