UPDATE channel_permission_overwrites
SET allow_bits = allow_bits & ~129,
    deny_bits = deny_bits & ~129
WHERE ((allow_bits | deny_bits) & 129) <> 0;

DELETE FROM channel_permission_overwrites
WHERE allow_bits = 0 AND deny_bits = 0;

UPDATE category_permission_overwrites
SET allow_bits = allow_bits & ~129,
    deny_bits = deny_bits & ~129
WHERE ((allow_bits | deny_bits) & 129) <> 0;

DELETE FROM category_permission_overwrites
WHERE allow_bits = 0 AND deny_bits = 0;
