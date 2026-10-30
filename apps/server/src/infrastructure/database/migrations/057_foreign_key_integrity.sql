-- Foreign keys are now enforced for good (S-APP-1). sql.js used to turn them
-- off at the first save, so in production no ON DELETE ran for months. This
-- migration takes the database to the state the schema promises, in order:
--   1. Removing a member keeps what they posted (D2). Messages, forum posts,
--      their attachments and polls no longer reference users: the cascade
--      would erase them, and a forum author could not be removed at all.
--      Bots belong to the server rather than to whoever added them, so they
--      stay as well.
--   2. Private audiences shrink to what their resource last saved (S-APP-2).
--   3. Rows whose parent is gone go, as the cascades would have taken them.
-- Step 1 must come first: checked against the old constraints, the removed
-- members' messages and attachments would count as orphans, and the startup
-- reconciliation would then delete the attachment files for good.

-- 1. SQLite's table rebuild. Rowids are copied: the search index points at
-- message rowids (message_search_fts.docid), and forum previews order by them.
-- The triggers go first: a rename fails while a trigger names a dropped table.
DROP TRIGGER IF EXISTS clear_deleted_message_reactions;
DROP TRIGGER IF EXISTS forum_locked_message;
DROP TRIGGER IF EXISTS message_search_insert;
DROP TRIGGER IF EXISTS message_search_update;
DROP TRIGGER IF EXISTS message_search_delete;
DROP TRIGGER IF EXISTS community_poll_audience_delete;
DROP TRIGGER IF EXISTS clear_bot_reactions;

CREATE TABLE messages_rebuilt (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  deleted_at INTEGER,
  author_bot_id TEXT,
  author_bot_name TEXT,
  author_bot_avatar_path TEXT,
  bot_command_json TEXT,
  reply_to_message_id TEXT,
  bot_localizations_json TEXT,
  blocks_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  deleted_by_user_id TEXT,
  delete_undo_until INTEGER,
  forwarded INTEGER NOT NULL DEFAULT 0,
  forward_source TEXT,
  forward_created_at INTEGER,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO messages_rebuilt (rowid, id, channel_id, user_id, content, created_at, is_system, edited_at,
  deleted_at, author_bot_id, author_bot_name, author_bot_avatar_path, bot_command_json, reply_to_message_id,
  bot_localizations_json, blocks_json, revision, deleted_by_user_id, delete_undo_until, forwarded,
  forward_source, forward_created_at)
SELECT rowid, id, channel_id, user_id, content, created_at, is_system, edited_at,
  deleted_at, author_bot_id, author_bot_name, author_bot_avatar_path, bot_command_json, reply_to_message_id,
  bot_localizations_json, blocks_json, revision, deleted_by_user_id, delete_undo_until, forwarded,
  forward_source, forward_created_at
FROM messages;
DROP TABLE messages;
ALTER TABLE messages_rebuilt RENAME TO messages;
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_author_bot ON messages(author_bot_id);
CREATE INDEX idx_messages_reply_to ON messages(reply_to_message_id);
CREATE INDEX idx_search_channel_page ON messages(channel_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;
CREATE INDEX idx_search_author_page ON messages(user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;
CREATE INDEX idx_search_bot_page ON messages(author_bot_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;
CREATE INDEX idx_search_page ON messages(created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_system = 0;

CREATE TABLE message_attachments_rebuilt (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  evicted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO message_attachments_rebuilt (rowid, id, message_id, channel_id, user_id, kind, filename,
  original_name, mime_type, size_bytes, width, height, duration_ms, evicted, created_at)
SELECT rowid, id, message_id, channel_id, user_id, kind, filename,
  original_name, mime_type, size_bytes, width, height, duration_ms, evicted, created_at
FROM message_attachments;
DROP TABLE message_attachments;
ALTER TABLE message_attachments_rebuilt RENAME TO message_attachments;
CREATE INDEX idx_attachments_message ON message_attachments(message_id);
CREATE INDEX idx_attachments_evict ON message_attachments(evicted, created_at);
CREATE INDEX idx_search_attachment_kind ON message_attachments(message_id, kind);

CREATE TABLE forum_posts_rebuilt (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  forum_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0, 1))
);
INSERT INTO forum_posts_rebuilt (rowid, channel_id, forum_id, author_id, created_at, pinned, locked, closed)
SELECT rowid, channel_id, forum_id, author_id, created_at, pinned, locked, closed FROM forum_posts;
DROP TABLE forum_posts;
ALTER TABLE forum_posts_rebuilt RENAME TO forum_posts;
CREATE INDEX idx_forum_posts_order ON forum_posts(forum_id, pinned DESC, created_at DESC);

-- A poll is the content of its message: deleting it with its creator would
-- turn a private poll into a plain message every channel member can read.
CREATE TABLE native_polls_rebuilt (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  allow_change INTEGER NOT NULL DEFAULT 1,
  closes_at INTEGER,
  max_voters INTEGER,
  closed_at INTEGER,
  live_action INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  allow_multiple INTEGER NOT NULL DEFAULT 0,
  images_json TEXT NOT NULL DEFAULT '[]',
  audience_json TEXT NOT NULL DEFAULT '{"visibility":"public"}',
  anonymous_votes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO native_polls_rebuilt (rowid, id, message_id, channel_id, creator_user_id, question, options_json,
  allow_change, closes_at, max_voters, closed_at, live_action, created_at, revision, allow_multiple,
  images_json, audience_json, anonymous_votes)
SELECT rowid, id, message_id, channel_id, creator_user_id, question, options_json,
  allow_change, closes_at, max_voters, closed_at, live_action, created_at, revision, allow_multiple,
  images_json, audience_json, anonymous_votes
FROM native_polls;
DROP TABLE native_polls;
ALTER TABLE native_polls_rebuilt RENAME TO native_polls;
CREATE INDEX native_polls_channel ON native_polls (channel_id, created_at);
CREATE INDEX native_polls_expiry ON native_polls (closed_at, closes_at);

-- A bot is added to the server: it keeps working when whoever added it leaves.
CREATE TABLE bots_rebuilt (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  avatar_path TEXT,
  bound_public_key TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  profile_pending INTEGER NOT NULL DEFAULT 0 CHECK (profile_pending IN (0, 1)),
  last_protocol_version INTEGER,
  manifest_url TEXT
);
INSERT INTO bots_rebuilt (rowid, id, name, token_hash, avatar_path, bound_public_key, created_by_user_id, created_at,
  profile_pending, last_protocol_version, manifest_url)
SELECT rowid, id, name, token_hash, avatar_path, bound_public_key, created_by_user_id, created_at,
  profile_pending, last_protocol_version, manifest_url
FROM bots;
DROP TABLE bots;
ALTER TABLE bots_rebuilt RENAME TO bots;

CREATE TRIGGER clear_deleted_message_reactions
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND NEW.delete_undo_until IS NULL
BEGIN
  DELETE FROM message_reactions WHERE message_id = NEW.id;
END;
CREATE TRIGGER forum_locked_message BEFORE INSERT ON messages
WHEN EXISTS (
  SELECT 1 FROM forum_posts
  WHERE channel_id = NEW.channel_id AND (locked = 1 OR closed = 1)
)
BEGIN
  SELECT RAISE(ABORT, 'Forum post is not accepting replies');
END;
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
CREATE TRIGGER community_poll_audience_delete AFTER DELETE ON native_polls
BEGIN
  DELETE FROM community_resource_audiences WHERE resource_type = 'poll' AND resource_id = OLD.id;
END;
CREATE TRIGGER clear_bot_reactions AFTER DELETE ON bots
BEGIN
  DELETE FROM message_reactions WHERE user_id = OLD.id;
END;

-- 2. Editing an audience replaced its parent row while the children lost to the
-- missing cascade stayed, so people removed from it kept their access. Every
-- edit wrote the full selection to the resource, so only the extra rows go:
-- nobody gains access here. An event that started, ended or repeated since
-- wrote those rows back into its record, and nothing tells them apart from a
-- real choice: the startup lists every private resource for the owner to review.
WITH saved(resource_type, resource_id, audience) AS (
  SELECT 'event', id, CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.audience') END FROM server_events
  UNION ALL
  SELECT 'live_action', id, CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.audience') END FROM bot_live_actions
  UNION ALL
  SELECT 'native_form', id, CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.audience') END FROM native_live_forms
  UNION ALL
  SELECT 'poll', id, CASE WHEN json_valid(audience_json) THEN audience_json END FROM native_polls
)
DELETE FROM community_resource_audience_users WHERE EXISTS (
  SELECT 1 FROM saved
  WHERE saved.resource_type = community_resource_audience_users.resource_type
    AND saved.resource_id = community_resource_audience_users.resource_id
    AND json_extract(saved.audience, '$.visibility') = 'private'
    AND json_type(saved.audience, '$.userIds') = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(saved.audience, '$.userIds') AS selected
      WHERE selected.value = community_resource_audience_users.user_id)
);
WITH saved(resource_type, resource_id, audience) AS (
  SELECT 'event', id, CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.audience') END FROM server_events
  UNION ALL
  SELECT 'live_action', id, CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.audience') END FROM bot_live_actions
  UNION ALL
  SELECT 'native_form', id, CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.audience') END FROM native_live_forms
  UNION ALL
  SELECT 'poll', id, CASE WHEN json_valid(audience_json) THEN audience_json END FROM native_polls
)
DELETE FROM community_resource_audience_roles WHERE EXISTS (
  SELECT 1 FROM saved
  WHERE saved.resource_type = community_resource_audience_roles.resource_type
    AND saved.resource_id = community_resource_audience_roles.resource_id
    AND json_extract(saved.audience, '$.visibility') = 'private'
    AND json_type(saved.audience, '$.roleIds') = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(saved.audience, '$.roleIds') AS selected
      WHERE selected.value = community_resource_audience_roles.role_id)
);

-- 3. References that fall back to a default when their target goes are reset;
-- deleting the row instead would take a whole channel, or the server settings.
UPDATE server_meta SET afk_channel_id = NULL
  WHERE afk_channel_id IS NOT NULL AND afk_channel_id NOT IN (SELECT id FROM channels);
UPDATE channels SET category_id = NULL, inherit_category_permissions = 0
  WHERE category_id IS NOT NULL AND category_id NOT IN (SELECT id FROM channel_categories);

-- Parents before children, since each deletion can orphan what the next one checks.
-- Of the channels, only forum topics whose forum is gone: every channel and
-- category belongs to the database's single server row, so a mismatch there
-- is not an orphan to delete with its whole history.
DELETE FROM channels WHERE forum_parent_id IS NOT NULL AND forum_parent_id NOT IN (SELECT id FROM channels);
DELETE FROM messages WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('messages'));
DELETE FROM native_polls WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('native_polls'));
DELETE FROM native_live_forms WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('native_live_forms'));
DELETE FROM bot_live_actions WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('bot_live_actions'));
-- Audiences follow their resource through triggers, not foreign keys.
DELETE FROM community_resource_audiences
  WHERE (resource_type = 'event' AND resource_id NOT IN (SELECT id FROM server_events))
    OR (resource_type = 'live_action' AND resource_id NOT IN (SELECT id FROM bot_live_actions))
    OR (resource_type = 'native_form' AND resource_id NOT IN (SELECT id FROM native_live_forms))
    OR (resource_type = 'poll' AND resource_id NOT IN (SELECT id FROM native_polls));

DELETE FROM bot_permissions WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('bot_permissions'));
DELETE FROM bot_selectors WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('bot_selectors'));
DELETE FROM bot_settings WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('bot_settings'));
DELETE FROM bot_storage_objects WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('bot_storage_objects'));
DELETE FROM bot_storage_quotas WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('bot_storage_quotas'));
DELETE FROM bot_voice_restrictions WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('bot_voice_restrictions'));
DELETE FROM category_allowed_roles WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('category_allowed_roles'));
DELETE FROM category_permission_overwrites
  WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('category_permission_overwrites'));
DELETE FROM channel_allowed_roles WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('channel_allowed_roles'));
DELETE FROM channel_permission_overwrites
  WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('channel_permission_overwrites'));
DELETE FROM community_resource_audience_users
  WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('community_resource_audience_users'));
DELETE FROM community_resource_audience_roles
  WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('community_resource_audience_roles'));
DELETE FROM forum_posts WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('forum_posts'));
DELETE FROM mentions WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('mentions'));
-- Only attachments of a channel or message that no longer exists, which the
-- startup reconciliation would also remove; their files go with it.
DELETE FROM message_attachments WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('message_attachments'));
DELETE FROM message_deletion_backups WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('message_deletion_backups'));
DELETE FROM message_reactions WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('message_reactions'));
DELETE FROM message_search_mentions WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('message_search_mentions'));
DELETE FROM native_live_form_responses
  WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('native_live_form_responses'));
DELETE FROM native_poll_votes WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('native_poll_votes'));
DELETE FROM server_event_interest WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('server_event_interest'));
DELETE FROM user_roles WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('user_roles'));
DELETE FROM user_voice_restrictions WHERE rowid IN (SELECT rowid FROM pragma_foreign_key_check('user_voice_restrictions'));
