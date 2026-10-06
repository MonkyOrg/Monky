ALTER TABLE server_meta ADD COLUMN recent_sound_cache_enabled INTEGER NOT NULL DEFAULT 0
  CHECK(recent_sound_cache_enabled IN (0, 1));
ALTER TABLE server_meta ADD COLUMN recent_sound_cache_limit INTEGER NOT NULL DEFAULT 20
  CHECK(recent_sound_cache_limit BETWEEN 1 AND 100);
