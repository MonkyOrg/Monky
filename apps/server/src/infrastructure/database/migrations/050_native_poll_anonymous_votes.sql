-- Votes are public unless the poll was created with anonymous votes. Polls
-- created before this column existed default to public, as decided for the
-- feature: their voters become visible to everyone who can see the poll.
ALTER TABLE native_polls ADD COLUMN anonymous_votes INTEGER NOT NULL DEFAULT 0;

-- Voter previews and lists read each answer in voting order.
CREATE INDEX IF NOT EXISTS idx_native_poll_votes_option
  ON native_poll_votes(poll_id, option_id, created_at);
