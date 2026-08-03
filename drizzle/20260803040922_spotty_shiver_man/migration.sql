ALTER TABLE `sessions` ADD `created_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Backfill rows that predate the column. `expires_at` was always set to
-- issue-or-renewal time + 30 days, so subtracting the session duration
-- recovers the last renewal instant exactly. That matters in both directions:
-- leaving the literal 0 would read as "issued at the epoch", and the new
-- absolute-lifetime check would log every existing user out on upgrade;
-- stamping `unixepoch()` instead would hand every live session a fresh full
-- window, including any already-stolen token.
UPDATE `sessions` SET `created_at` = `expires_at` - 2592000000 WHERE `created_at` = 0;
