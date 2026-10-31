-- Proof of private key possession for bots (bot-key-proof). Set on the first
-- valid proof; from then on the server refuses this bot without one, so a
-- captured token cannot sign in by simply not offering the feature.
ALTER TABLE bots ADD COLUMN key_proof_required INTEGER NOT NULL DEFAULT 0;
