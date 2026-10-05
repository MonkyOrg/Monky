-- Server roles only grant again: a member has whatever Everyone or any of
-- their roles turns on, and a role never takes a permission away. Restricting
-- now happens through Everyone or channel rules. Allowed bits stay as the
-- role's grants and denials are dropped. The column stays so a 36.1 server
-- can still open this database: with nothing denied it resolves the same way.
UPDATE roles SET deny_permissions = 0;
