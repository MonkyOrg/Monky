-- Every few seconds the server ends the undo window of deleted messages, and
-- finding them used to read the whole messages table (S-APP-7). Only messages
-- deleted within their undo window carry the column, so the index stays tiny.
CREATE INDEX IF NOT EXISTS idx_messages_delete_undo ON messages(delete_undo_until)
  WHERE delete_undo_until IS NOT NULL;
