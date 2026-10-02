CREATE TABLE native_polls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  allow_change INTEGER NOT NULL DEFAULT 1,
  closes_at INTEGER,
  max_voters INTEGER,
  closed_at INTEGER,
  live_action INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX native_polls_channel ON native_polls (channel_id, created_at);
CREATE INDEX native_polls_expiry ON native_polls (closed_at, closes_at);

CREATE TABLE native_poll_votes (
  poll_id TEXT NOT NULL REFERENCES native_polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
