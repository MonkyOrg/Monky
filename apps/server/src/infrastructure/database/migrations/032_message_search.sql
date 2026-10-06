-- sql.js ships FTS4 + unicode61, not FTS5. Index live content only, never undo storage.
CREATE VIRTUAL TABLE message_search_fts USING fts4(content, tokenize=unicode61);
INSERT INTO message_search_fts(docid, content)
SELECT rowid, content || ' ' || COALESCE(json_extract(bot_localizations_json, '$.en'), '')
  || ' ' || COALESCE(json_extract(bot_localizations_json, '$."pt-BR"'), '')
FROM messages WHERE deleted_at IS NULL AND is_system = 0;

CREATE TABLE message_search_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO message_search_state VALUES (1, 0);

CREATE TABLE message_search_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, user_id)
);
CREATE INDEX idx_search_mentions_user ON message_search_mentions(user_id, message_id);
-- Historical unread mentions are not authoritative: opening a channel removes them.
INSERT OR IGNORE INTO message_search_mentions
SELECT m.id, u.id FROM messages m CROSS JOIN users u
WHERE m.deleted_at IS NULL AND m.is_system = 0 AND instr(m.content, '@') > 0
  AND trim(u.nickname) <> '' AND instr(lower(m.content), '@' || lower(trim(u.nickname))) > 0;
INSERT OR IGNORE INTO message_search_mentions
SELECT message_id, user_id FROM mentions WHERE message_id IN (SELECT id FROM messages WHERE deleted_at IS NULL);

CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_search_fts(docid, content)
  SELECT NEW.rowid, NEW.content || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$.en'), '')
    || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$."pt-BR"'), '')
  WHERE NEW.deleted_at IS NULL AND NEW.is_system = 0;
  INSERT OR IGNORE INTO message_search_mentions
  SELECT NEW.id, id FROM users WHERE NEW.deleted_at IS NULL AND NEW.is_system = 0 AND instr(NEW.content, '@') > 0
    AND trim(nickname) <> '' AND instr(lower(NEW.content), '@' || lower(trim(nickname))) > 0;
  UPDATE message_search_state SET revision = revision + 1;
END;
CREATE TRIGGER message_search_update AFTER UPDATE OF content, bot_localizations_json, deleted_at ON messages BEGIN
  DELETE FROM message_search_fts WHERE docid = OLD.rowid;
  DELETE FROM message_search_mentions WHERE message_id = OLD.id;
  INSERT INTO message_search_fts(docid, content)
  SELECT NEW.rowid, NEW.content || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$.en'), '')
    || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$."pt-BR"'), '')
  WHERE NEW.deleted_at IS NULL AND NEW.is_system = 0;
  INSERT OR IGNORE INTO message_search_mentions
  SELECT NEW.id, id FROM users WHERE NEW.deleted_at IS NULL AND NEW.is_system = 0 AND instr(NEW.content, '@') > 0
    AND trim(nickname) <> '' AND instr(lower(NEW.content), '@' || lower(trim(nickname))) > 0;
  UPDATE message_search_state SET revision = revision + 1;
END;
CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_search_fts WHERE docid = OLD.rowid;
  UPDATE message_search_state SET revision = revision + 1;
END;
-- Preserve the service's Unicode-aware mention resolution after the unread row is cleared.
CREATE TRIGGER message_search_mention_insert AFTER INSERT ON mentions BEGIN
  INSERT OR IGNORE INTO message_search_mentions VALUES (NEW.message_id, NEW.user_id);
END;

CREATE INDEX idx_search_channel_page ON messages(channel_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;
CREATE INDEX idx_search_author_page ON messages(user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;
CREATE INDEX idx_search_bot_page ON messages(author_bot_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;
CREATE INDEX idx_search_page ON messages(created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;
CREATE INDEX idx_search_attachment_kind ON message_attachments(message_id, kind);
