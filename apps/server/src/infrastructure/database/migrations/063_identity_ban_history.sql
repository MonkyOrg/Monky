CREATE TABLE identity_ban_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL,
  nickname TEXT NOT NULL,
  reason TEXT NOT NULL,
  show_reason INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_by_id TEXT,
  created_by_nickname TEXT,
  ended_at INTEGER,
  ended_by_id TEXT,
  ended_by_nickname TEXT,
  resolution TEXT CHECK (resolution IN ('revoked', 'replaced'))
);

CREATE INDEX identity_ban_history_identity ON identity_ban_history(public_key, id);
CREATE INDEX identity_ban_history_active ON identity_ban_history(resolution, expires_at, id);

ALTER TABLE identity_bans ADD COLUMN history_id INTEGER REFERENCES identity_ban_history(id);

INSERT INTO identity_ban_history (public_key, nickname, reason, show_reason, created_at, expires_at)
SELECT public_key, nickname, reason, show_reason, created_at, expires_at FROM identity_bans ORDER BY created_at, public_key;

UPDATE identity_bans SET history_id = (
  SELECT id FROM identity_ban_history WHERE identity_ban_history.public_key = identity_bans.public_key
);
