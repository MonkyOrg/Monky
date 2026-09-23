CREATE TABLE user_voice_restrictions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  server_muted INTEGER NOT NULL DEFAULT 0 CHECK (server_muted IN (0, 1)),
  server_deafened INTEGER NOT NULL DEFAULT 0 CHECK (server_deafened IN (0, 1))
);
