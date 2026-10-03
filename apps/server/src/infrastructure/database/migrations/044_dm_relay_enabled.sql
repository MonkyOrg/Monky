ALTER TABLE server_meta ADD COLUMN dm_relay_enabled INTEGER NOT NULL DEFAULT 1
  CHECK(dm_relay_enabled IN (0, 1));
