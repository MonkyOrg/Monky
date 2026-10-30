-- #834: the "menciona:" index is written by the application with MentionMatcher, the
-- same rule as the chat's highlight. The triggers keep the text index and only clear
-- the mention rows of a rewritten message; the server indexes the new text in the same
-- transaction, and the rows are rebuilt right after this file.
DROP TRIGGER IF EXISTS message_search_insert;
DROP TRIGGER IF EXISTS message_search_update;
DROP TRIGGER IF EXISTS message_search_mention_insert;

CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_search_fts(docid, content)
  SELECT NEW.rowid, NEW.content || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$.en'), '')
    || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$."pt-BR"'), '')
  WHERE NEW.deleted_at IS NULL AND NEW.is_system = 0;
  UPDATE message_search_state SET revision = revision + 1;
END;
CREATE TRIGGER message_search_update AFTER UPDATE OF content, bot_localizations_json, deleted_at ON messages BEGIN
  DELETE FROM message_search_fts WHERE docid = OLD.rowid;
  DELETE FROM message_search_mentions WHERE message_id = OLD.id;
  INSERT INTO message_search_fts(docid, content)
  SELECT NEW.rowid, NEW.content || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$.en'), '')
    || ' ' || COALESCE(json_extract(NEW.bot_localizations_json, '$."pt-BR"'), '')
  WHERE NEW.deleted_at IS NULL AND NEW.is_system = 0;
  UPDATE message_search_state SET revision = revision + 1;
END;
