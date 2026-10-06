CREATE TABLE native_live_forms (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  snapshot TEXT NOT NULL
);
CREATE INDEX native_live_forms_active ON native_live_forms (closed_at, expires_at);

CREATE TABLE native_live_form_responses (
  form_id TEXT NOT NULL REFERENCES native_live_forms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  values_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (form_id, user_id)
);
CREATE INDEX native_live_form_responses_page ON native_live_form_responses (form_id, user_id);
