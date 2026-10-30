import { MentionMatcher } from '@monky/shared';
import type { IDatabaseDriver } from './SqliteWrapper';

export const MESSAGE_SEARCH_MENTIONS_MIGRATION = '059_message_search_mentions.sql';

interface IndexedMessage {
  id: string;
  content: string;
  localizations: string | null;
}

const LIVE_MESSAGES = 'deleted_at IS NULL AND is_system = 0';
const WITH_MENTION = "(instr(content, '@') > 0 OR instr(COALESCE(bot_localizations_json, ''), '@') > 0)";

function texts(message: IndexedMessage): string[] {
  const variants = message.localizations ? Object.values(JSON.parse(message.localizations) as Record<string, unknown>) : [];
  return [message.content, ...variants.filter((value): value is string => typeof value === 'string')];
}

function write(db: IDatabaseDriver, messages: readonly IndexedMessage[]): void {
  if (!messages.length) return;
  const members = db.prepare('SELECT id, nickname FROM users').all() as Array<{ id: string; nickname: string }>;
  // The highlight in the chat and in the search results, over the same names (#834).
  const matcher = new MentionMatcher(members.map(member => member.nickname));
  const byName = new Map<string, string[]>();
  for (const member of members) {
    const name = member.nickname.trim().toLowerCase();
    if (name) byName.set(name, [...byName.get(name) ?? [], member.id]);
  }
  const insert = db.prepare('INSERT OR IGNORE INTO message_search_mentions (message_id, user_id) VALUES (?, ?)');
  for (const message of messages) {
    for (const mention of texts(message).flatMap(text => matcher.find(text))) {
      for (const userId of byName.get(mention.name.toLowerCase()) ?? []) insert.run(message.id, userId);
    }
  }
}

/**
 * Rewrites who `messageId` mentions for the "menciona:" search filter, with the same
 * rule as the chat (`MentionMatcher`). Call it inside the transaction that stores the
 * new text: creation, edit and undoing a deletion.
 */
export function indexMessageMentions(db: IDatabaseDriver, messageId: string): void {
  db.prepare('DELETE FROM message_search_mentions WHERE message_id = ?').run(messageId);
  write(db, db.prepare(`SELECT id, content, bot_localizations_json AS localizations FROM messages
    WHERE id = ? AND ${LIVE_MESSAGES} AND ${WITH_MENTION}`).all(messageId) as IndexedMessage[]);
}

/** Rebuilds the whole index with the single rule; runs inside the migration's transaction. */
export function rebuildMessageSearchMentions(db: IDatabaseDriver): void {
  db.prepare('DELETE FROM message_search_mentions').run();
  write(db, db.prepare(`SELECT id, content, bot_localizations_json AS localizations FROM messages
    WHERE ${LIVE_MESSAGES} AND ${WITH_MENTION}`).all() as IndexedMessage[]);
}
