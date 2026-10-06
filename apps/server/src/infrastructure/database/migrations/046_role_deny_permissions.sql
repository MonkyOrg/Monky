-- Roles become allow/deny rules over Everyone instead of full masks that
-- replaced it. Each existing role is converted against the current Everyone
-- so nobody's permissions change: bits Everyone already grants are denied
-- where the role had them off, bits it lacks are allowed where the role had
-- them on, and everything else inherits. The built-in Admin role keeps its
-- full mask (546576 is the default Everyone of migration 042).
ALTER TABLE roles ADD COLUMN deny_permissions INTEGER NOT NULL DEFAULT 0;

UPDATE roles
SET deny_permissions = (COALESCE((SELECT everyone_permissions FROM server_meta LIMIT 1), 546576) & ~permissions) & ~2048,
    permissions = permissions & ~COALESCE((SELECT everyone_permissions FROM server_meta LIMIT 1), 546576)
WHERE lower(name) <> 'admin';
