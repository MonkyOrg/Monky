-- server-key-auth (#821). The server's Ed25519 identity, created once and kept
-- with the rest of the data, so backups, update rollbacks and moving the data
-- directory keep the key the members' apps pinned.
CREATE TABLE IF NOT EXISTS server_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  private_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Set on a member's first sign-in bound to that key; from then on the server
-- refuses that member's bare-nonce signatures, which a relaying server could
-- otherwise still obtain from an app that never saw it with a key.
ALTER TABLE users ADD COLUMN server_key_required INTEGER NOT NULL DEFAULT 0;
