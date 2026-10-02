ALTER TABLE server_community_settings ADD COLUMN disabled_at INTEGER;
UPDATE server_community_settings
SET disabled_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE events_enabled = 0;
