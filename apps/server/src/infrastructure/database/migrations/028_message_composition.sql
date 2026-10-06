ALTER TABLE server_meta ADD COLUMN max_message_length INTEGER NOT NULL DEFAULT 16000 CHECK (max_message_length >= 0);
ALTER TABLE messages ADD COLUMN blocks_json TEXT;
