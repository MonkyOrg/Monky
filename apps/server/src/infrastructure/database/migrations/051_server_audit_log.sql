-- Audit log of what is done on the server. Entries are never edited; the
-- service prunes them by age and by count. AUTOINCREMENT keeps ids from being
-- reused after pruning, so a client cursor never points at a different entry.
CREATE TABLE IF NOT EXISTS server_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  -- Lowercase names without accents, matched by the audit search.
  search_text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_server_audit_log_created ON server_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_server_audit_log_category ON server_audit_log(category, id);
-- Pruning keeps separate quotas for actions any member can repeat and for the rest.
CREATE INDEX IF NOT EXISTS idx_server_audit_log_action ON server_audit_log(action, id);
