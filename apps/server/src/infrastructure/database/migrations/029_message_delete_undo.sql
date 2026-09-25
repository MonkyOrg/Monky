ALTER TABLE server_meta ADD COLUMN message_delete_undo_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN deleted_by_user_id TEXT;
ALTER TABLE messages ADD COLUMN delete_undo_until INTEGER;

CREATE TABLE message_deletion_backups (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  deleted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  content TEXT NOT NULL,
  blocks_json TEXT,
  bot_localizations_json TEXT
);
CREATE INDEX idx_message_deletion_expiry ON message_deletion_backups(expires_at);

DROP TRIGGER clear_deleted_message_reactions;
CREATE TRIGGER clear_deleted_message_reactions
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND NEW.delete_undo_until IS NULL
BEGIN
  DELETE FROM message_reactions WHERE message_id = NEW.id;
END;
