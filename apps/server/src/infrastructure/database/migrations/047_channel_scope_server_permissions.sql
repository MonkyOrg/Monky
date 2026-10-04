-- Manage events (131072) and Emit live actions (262144) are server-wide
-- permissions; channel and category rules no longer carry them.
UPDATE channel_permission_overwrites
SET allow_bits = allow_bits & ~393216,
    deny_bits = deny_bits & ~393216
WHERE ((allow_bits | deny_bits) & 393216) <> 0;

DELETE FROM channel_permission_overwrites
WHERE allow_bits = 0 AND deny_bits = 0;

UPDATE category_permission_overwrites
SET allow_bits = allow_bits & ~393216,
    deny_bits = deny_bits & ~393216
WHERE ((allow_bits | deny_bits) & 393216) <> 0;

DELETE FROM category_permission_overwrites
WHERE allow_bits = 0 AND deny_bits = 0;
