ALTER TABLE native_polls
  ADD COLUMN audience_json TEXT NOT NULL DEFAULT '{"visibility":"public"}';

CREATE TABLE community_resource_audiences (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('event', 'live_action', 'poll', 'native_form')),
  resource_id TEXT NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE community_resource_audience_users (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_type, resource_id, user_id),
  FOREIGN KEY (resource_type, resource_id)
    REFERENCES community_resource_audiences(resource_type, resource_id) ON DELETE CASCADE
);

CREATE TABLE community_resource_audience_roles (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_type, resource_id, role_id),
  FOREIGN KEY (resource_type, resource_id)
    REFERENCES community_resource_audiences(resource_type, resource_id) ON DELETE CASCADE
);

CREATE INDEX community_resource_audience_users_lookup
  ON community_resource_audience_users(user_id, resource_type, resource_id);
CREATE INDEX community_resource_audience_roles_lookup
  ON community_resource_audience_roles(role_id, resource_type, resource_id);

CREATE TRIGGER community_event_audience_delete AFTER DELETE ON server_events
BEGIN
  DELETE FROM community_resource_audiences WHERE resource_type = 'event' AND resource_id = OLD.id;
END;

CREATE TRIGGER community_live_action_audience_delete AFTER DELETE ON bot_live_actions
BEGIN
  DELETE FROM community_resource_audiences WHERE resource_type = 'live_action' AND resource_id = OLD.id;
END;

CREATE TRIGGER community_poll_audience_delete AFTER DELETE ON native_polls
BEGIN
  DELETE FROM community_resource_audiences WHERE resource_type = 'poll' AND resource_id = OLD.id;
END;

CREATE TRIGGER community_native_form_audience_delete AFTER DELETE ON native_live_forms
BEGIN
  DELETE FROM community_resource_audiences WHERE resource_type = 'native_form' AND resource_id = OLD.id;
END;
