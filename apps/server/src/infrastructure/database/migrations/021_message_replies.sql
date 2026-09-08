ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;
CREATE INDEX idx_messages_reply_to ON messages(reply_to_message_id);
