CREATE TABLE channel_permission_overwrites_next (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  allow_bits INTEGER NOT NULL DEFAULT 0,
  deny_bits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_id),
  CHECK (
    (role_id IS NULL AND user_id IS NULL AND target_id = '@everyone') OR
    (role_id IS NOT NULL AND user_id IS NULL AND target_id = 'role:' || role_id) OR
    (role_id IS NULL AND user_id IS NOT NULL AND target_id = 'user:' || user_id)
  ),
  CHECK ((allow_bits & deny_bits) = 0)
);
INSERT INTO channel_permission_overwrites_next (channel_id, target_id, role_id, allow_bits, deny_bits)
SELECT channel_id, CASE WHEN role_id IS NULL THEN '@everyone' ELSE 'role:' || role_id END,
  role_id, allow_bits, deny_bits FROM channel_permission_overwrites;
DROP TABLE channel_permission_overwrites;
ALTER TABLE channel_permission_overwrites_next RENAME TO channel_permission_overwrites;

CREATE TABLE category_permission_overwrites_next (
  category_id TEXT NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  allow_bits INTEGER NOT NULL DEFAULT 0,
  deny_bits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, target_id),
  CHECK (
    (role_id IS NULL AND user_id IS NULL AND target_id = '@everyone') OR
    (role_id IS NOT NULL AND user_id IS NULL AND target_id = 'role:' || role_id) OR
    (role_id IS NULL AND user_id IS NOT NULL AND target_id = 'user:' || user_id)
  ),
  CHECK ((allow_bits & deny_bits) = 0)
);
INSERT INTO category_permission_overwrites_next (category_id, target_id, role_id, allow_bits, deny_bits)
SELECT category_id, CASE WHEN role_id IS NULL THEN '@everyone' ELSE 'role:' || role_id END,
  role_id, allow_bits, deny_bits FROM category_permission_overwrites;
DROP TABLE category_permission_overwrites;
ALTER TABLE category_permission_overwrites_next RENAME TO category_permission_overwrites;
