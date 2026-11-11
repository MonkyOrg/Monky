CREATE TABLE guest_memberships (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
);
CREATE TABLE identity_bans (
  public_key TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  reason TEXT NOT NULL,
  show_reason INTEGER NOT NULL CHECK(show_reason IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX identity_bans_expiry ON identity_bans(expires_at);
