ALTER TABLE native_polls ADD COLUMN allow_multiple INTEGER NOT NULL DEFAULT 0;
ALTER TABLE native_polls ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE native_poll_votes RENAME TO native_poll_votes_single;

CREATE TABLE native_poll_votes (
  poll_id TEXT NOT NULL REFERENCES native_polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, option_id)
);

INSERT INTO native_poll_votes (poll_id, user_id, option_id, created_at, updated_at)
SELECT poll_id, user_id, option_id, created_at, updated_at
FROM native_poll_votes_single;

DROP TABLE native_poll_votes_single;
