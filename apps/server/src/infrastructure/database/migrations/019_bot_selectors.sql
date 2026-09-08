CREATE TABLE bot_selectors (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL,
    closed_at INTEGER,
    expires_at INTEGER
);
CREATE INDEX idx_bot_selectors_bot ON bot_selectors(bot_id);
CREATE INDEX idx_bot_selectors_channel ON bot_selectors(channel_id);
CREATE INDEX idx_bot_selectors_expiry ON bot_selectors(closed_at, expires_at);
