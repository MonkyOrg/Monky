-- Bot accounts: each bot has a hashed token and optional TOFU-bound public key (#569).
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  avatar_path TEXT,
  bound_public_key TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Server-level bot limit, separate from member cap.
ALTER TABLE server_meta ADD COLUMN max_bots INTEGER NOT NULL DEFAULT 10;
