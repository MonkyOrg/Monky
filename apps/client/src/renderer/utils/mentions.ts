import { MentionMatcher } from '@monky/shared';
import type { ServerStore } from '../stores/serverStore';

/**
 * Who can be mentioned on a server: the names the server matches too, so the cue,
 * the @ badge and the highlight agree with the mention it records. That is every
 * member, offline ones included (#14) — bots are left out on both sides, so presence
 * never changes who a message mentions — plus `@todos` / `@everyone` when the server
 * allows them (#464). Building it walks the member list, so build it once per render.
 */
export function serverMentionMatcher(
  server: Pick<ServerStore, 'knownMembers' | 'currentUser' | 'serverDetails'>,
): MentionMatcher {
  const nicknames = [...server.knownMembers.values()].filter(member => !member.isBot).map(member => member.nickname);
  if (server.currentUser?.nickname) nicknames.push(server.currentUser.nickname);
  return new MentionMatcher(nicknames, { everyone: server.serverDetails?.allowEveryoneMention !== false });
}
