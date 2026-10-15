-- Voice channels gain a user limit shown next to their name. Every room used to
-- be capped at a hidden 10 (text channels stored 10 or 50 for nothing), a limit
-- nobody could see or change. 0 now means "no limit", where every channel starts.
UPDATE channels SET max_participants = 0;
