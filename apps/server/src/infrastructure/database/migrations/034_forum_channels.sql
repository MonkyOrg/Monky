CREATE TABLE channels_new (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES server_meta(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('VOICE', 'TEXT', 'FORUM')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  max_participants INTEGER NOT NULL DEFAULT 10,
  is_private INTEGER NOT NULL DEFAULT 0,
  bot_commands_enabled INTEGER NOT NULL DEFAULT 1 CHECK(bot_commands_enabled IN (0, 1)),
  category_id TEXT REFERENCES channel_categories(id),
  inherit_category_permissions INTEGER NOT NULL DEFAULT 1,
  forum_parent_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  CHECK(forum_parent_id IS NULL OR type = 'TEXT')
);
INSERT INTO channels_new (
  id, server_id, name, type, position, created_at, max_participants, is_private,
  bot_commands_enabled, category_id, inherit_category_permissions
)
SELECT id, server_id, name, type, position, created_at, max_participants, is_private,
  bot_commands_enabled, category_id, inherit_category_permissions FROM channels;
DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;
CREATE INDEX idx_channels_server ON channels(server_id, position);
CREATE INDEX idx_channels_category ON channels(category_id, position);
CREATE INDEX idx_channels_forum ON channels(forum_parent_id);

CREATE TABLE forum_posts (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  forum_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_forum_posts_order ON forum_posts(forum_id, pinned DESC, created_at DESC);
CREATE TRIGGER forum_locked_message BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM forum_posts WHERE channel_id = NEW.channel_id AND locked = 1)
BEGIN
  SELECT RAISE(ABORT, 'Forum post is locked');
END;
