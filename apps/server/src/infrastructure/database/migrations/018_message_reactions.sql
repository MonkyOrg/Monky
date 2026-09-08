CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL CHECK(length(emoji) BETWEEN 1 AND 64),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX idx_message_reactions_user ON message_reactions(user_id);

CREATE TRIGGER clear_user_reactions AFTER DELETE ON users
BEGIN
  DELETE FROM message_reactions WHERE user_id = OLD.id;
END;

CREATE TRIGGER clear_bot_reactions AFTER DELETE ON bots
BEGIN
  DELETE FROM message_reactions WHERE user_id = OLD.id;
END;

CREATE TRIGGER clear_deleted_message_reactions
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM message_reactions WHERE message_id = NEW.id;
END;
