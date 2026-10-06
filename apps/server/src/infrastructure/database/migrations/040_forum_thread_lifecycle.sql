ALTER TABLE forum_posts ADD COLUMN closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0, 1));

DROP TRIGGER forum_locked_message;
CREATE TRIGGER forum_locked_message BEFORE INSERT ON messages
WHEN EXISTS (
  SELECT 1 FROM forum_posts
  WHERE channel_id = NEW.channel_id AND (locked = 1 OR closed = 1)
)
BEGIN
  SELECT RAISE(ABORT, 'Forum post is not accepting replies');
END;
