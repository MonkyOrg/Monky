ALTER TABLE server_meta ADD COLUMN everyone_permissions INTEGER NOT NULL DEFAULT 546576;

CREATE TABLE channel_permission_overwrites (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  allow_bits INTEGER NOT NULL DEFAULT 0,
  deny_bits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_id),
  CHECK ((role_id IS NULL AND target_id = '@everyone') OR target_id = role_id),
  CHECK ((allow_bits & deny_bits) = 0)
);
CREATE TABLE category_permission_overwrites (
  category_id TEXT NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  allow_bits INTEGER NOT NULL DEFAULT 0,
  deny_bits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, target_id),
  CHECK ((role_id IS NULL AND target_id = '@everyone') OR target_id = role_id),
  CHECK ((allow_bits & deny_bits) = 0)
);

-- A role used to select private community audiences is already configured.
-- Keep it rather than deleting or publishing those audiences.
CREATE TEMP TABLE migrated_member_roles AS
SELECT id FROM roles
WHERE name = 'Membro' AND color = '#5865f2' AND position = 0
  AND permissions = 22288 AND is_default = 1
  AND NOT EXISTS (SELECT 1 FROM community_resource_audience_roles a WHERE a.role_id = roles.id);

INSERT INTO channel_permission_overwrites (channel_id, target_id, allow_bits, deny_bits)
SELECT id, '@everyone', 0, 524288 FROM channels WHERE is_private = 1;
INSERT INTO category_permission_overwrites (category_id, target_id, allow_bits, deny_bits)
SELECT id, '@everyone', 0, 524288 FROM channel_categories WHERE is_private = 1;

INSERT INTO channel_permission_overwrites (channel_id, target_id, role_id, allow_bits, deny_bits)
SELECT a.channel_id,
  CASE WHEN m.id IS NULL THEN a.role_id ELSE '@everyone' END,
  CASE WHEN m.id IS NULL THEN a.role_id ELSE NULL END, 524288, 0
FROM channel_allowed_roles a JOIN channels c ON c.id = a.channel_id
LEFT JOIN migrated_member_roles m ON m.id = a.role_id WHERE c.is_private = 1
ON CONFLICT(channel_id, target_id) DO UPDATE SET allow_bits = 524288, deny_bits = 0;
INSERT INTO category_permission_overwrites (category_id, target_id, role_id, allow_bits, deny_bits)
SELECT a.category_id,
  CASE WHEN m.id IS NULL THEN a.role_id ELSE '@everyone' END,
  CASE WHEN m.id IS NULL THEN a.role_id ELSE NULL END, 524288, 0
FROM category_allowed_roles a JOIN channel_categories c ON c.id = a.category_id
LEFT JOIN migrated_member_roles m ON m.id = a.role_id WHERE c.is_private = 1
ON CONFLICT(category_id, target_id) DO UPDATE SET allow_bits = 524288, deny_bits = 0;

-- Preserve existing managers' visibility as explicit grants, not a permanent bypass.
INSERT OR IGNORE INTO channel_permission_overwrites (channel_id, target_id, role_id, allow_bits, deny_bits)
SELECT c.id, r.id, r.id, 524288, 0 FROM channels c CROSS JOIN roles r
WHERE c.is_private = 1 AND (r.permissions & 1) <> 0 AND (r.permissions & 2048) = 0;
INSERT OR IGNORE INTO category_permission_overwrites (category_id, target_id, role_id, allow_bits, deny_bits)
SELECT c.id, r.id, r.id, 524288, 0 FROM channel_categories c CROSS JOIN roles r
WHERE c.is_private = 1 AND (r.permissions & 1) <> 0 AND (r.permissions & 2048) = 0;

DELETE FROM roles WHERE id IN (SELECT id FROM migrated_member_roles);
DROP TABLE migrated_member_roles;
UPDATE roles SET permissions = permissions | 524288;
