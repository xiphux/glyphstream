ALTER TABLE `sessions` ADD `created_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Backfill rows that predate the column. `expires_at` was always set to
-- issue-or-renewal time + 30 days, so subtracting the session duration
-- recovers the last renewal instant exactly.
--
-- The point of this over leaving the literal 0 is upgrade behaviour: 0 reads
-- as "issued at the epoch", so the new absolute-lifetime check would log every
-- existing user out the moment they upgraded.
--
-- It is NOT much of a security win over stamping `unixepoch()`, and shouldn't
-- be read as one. Renewal fires within 7 days of expiry and pushes expiry to
-- now + 30 days, so for any session in regular use — including one an attacker
-- is keeping warm, which is the case the 90-day ceiling exists for —
-- `expires_at - 30d` lands within the last 23 days, and its absolute clock
-- effectively restarts here anyway. The two options only diverge for sessions
-- that HAVEN'T been renewed recently, which is the opposite of the abuse case.
-- Anything already stolen keeps roughly a full window either way; the ceiling
-- starts biting on sessions issued after this migration.
UPDATE `sessions` SET `created_at` = `expires_at` - 2592000000 WHERE `created_at` = 0;
