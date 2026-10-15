-- The AFK voice channel: members idle in a call are moved into it, where the
-- server mutes their microphone. It is an ordinary channel row; losing that row
-- turns the feature off instead of leaving a dangling reference.
ALTER TABLE server_meta ADD COLUMN afk_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE server_meta ADD COLUMN afk_timeout_seconds INTEGER NOT NULL DEFAULT 900;
