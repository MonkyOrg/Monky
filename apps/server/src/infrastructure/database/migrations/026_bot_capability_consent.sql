-- No legacy bot is grandfathered in: absent rows mean undeclared and no grants.
CREATE TABLE bot_permissions (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  permissions_json TEXT NOT NULL
);
