-- Forwarded messages (message-forward). The source label and the original's
-- timestamp are resolved by the server when the message is sent, so a later
-- rename or deletion of the original does not rewrite the badge.
ALTER TABLE messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN forward_source TEXT;
ALTER TABLE messages ADD COLUMN forward_created_at INTEGER;
