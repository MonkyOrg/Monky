ALTER TABLE messages ADD COLUMN author_bot_id TEXT;
ALTER TABLE messages ADD COLUMN author_bot_name TEXT;
ALTER TABLE messages ADD COLUMN author_bot_avatar_path TEXT;
ALTER TABLE messages ADD COLUMN bot_command_json TEXT;
CREATE INDEX idx_messages_author_bot ON messages(author_bot_id);
