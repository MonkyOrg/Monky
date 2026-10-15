-- Objects a bot keeps on this server (`server_storage`). Bytes live on disk under
-- bot-storage/; only metadata is kept here, and removing the bot removes both.
CREATE TABLE bot_storage_objects (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, object_key)
);

-- Absent rows use the default quota.
CREATE TABLE bot_storage_quotas (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  max_bytes INTEGER NOT NULL CHECK (max_bytes > 0)
);
