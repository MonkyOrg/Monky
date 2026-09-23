CREATE TABLE bot_settings (
    bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
    definition_json TEXT NOT NULL,
    server_overrides_json TEXT NOT NULL,
    schema_revision INTEGER NOT NULL CHECK (schema_revision >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    downloads_sound INTEGER NOT NULL CHECK (downloads_sound IN (0, 1))
);
