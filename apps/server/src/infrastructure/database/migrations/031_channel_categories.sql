CREATE TABLE channel_categories (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES server_meta(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE category_allowed_roles (
  category_id TEXT NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, role_id)
);
ALTER TABLE channels ADD COLUMN category_id TEXT REFERENCES channel_categories(id);
ALTER TABLE channels ADD COLUMN inherit_category_permissions INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_channels_category ON channels(category_id, position);
CREATE INDEX idx_categories_server ON channel_categories(server_id, position);

INSERT INTO channel_categories (id, server_id, name, position, created_at)
SELECT id || '-text-category', id, 'Canais de texto', 0, created_at FROM server_meta;
INSERT INTO channel_categories (id, server_id, name, position, created_at)
SELECT id || '-voice-category', id, 'Canais de voz', 1, created_at FROM server_meta;
UPDATE channels SET category_id = server_id || CASE WHEN type = 'VOICE' THEN '-voice-category' ELSE '-text-category' END,
  inherit_category_permissions = CASE WHEN is_private = 1 THEN 0 ELSE 1 END;
