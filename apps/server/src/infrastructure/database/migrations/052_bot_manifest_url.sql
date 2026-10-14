-- Manifest URL used to install each bot, shown to people who manage bots so they
-- can tell where a bot came from. Bots linked by token, or installed before this
-- column existed, keep NULL: the URL was never stored and cannot be recovered.
ALTER TABLE bots ADD COLUMN manifest_url TEXT;
