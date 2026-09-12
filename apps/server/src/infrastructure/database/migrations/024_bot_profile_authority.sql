-- Existing identities remain unchanged; only new manual links start pending.
ALTER TABLE bots ADD COLUMN profile_pending INTEGER NOT NULL DEFAULT 0
  CHECK (profile_pending IN (0, 1));
