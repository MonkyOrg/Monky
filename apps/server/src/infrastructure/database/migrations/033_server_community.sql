CREATE TABLE server_community_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  events_enabled INTEGER NOT NULL DEFAULT 0,
  banner_path TEXT
);
INSERT INTO server_community_settings (id) VALUES (1);

CREATE TABLE server_events (
  id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER
);
CREATE INDEX server_events_schedule ON server_events (status, starts_at);
CREATE TABLE server_event_interest (
  event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE bot_live_actions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE INDEX bot_live_actions_expiry ON bot_live_actions (expires_at);
