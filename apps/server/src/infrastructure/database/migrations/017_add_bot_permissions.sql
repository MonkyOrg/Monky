-- Preserve command access for existing members, including custom roles.
UPDATE roles SET permissions = permissions | 16384;
ALTER TABLE channels ADD COLUMN bot_commands_enabled INTEGER NOT NULL DEFAULT 1 CHECK (bot_commands_enabled IN (0, 1));
