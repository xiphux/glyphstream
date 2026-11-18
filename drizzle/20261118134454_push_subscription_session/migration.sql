ALTER TABLE `push_subscriptions` ADD `session_id` text REFERENCES sessions(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX `idx_push_subscriptions_session_id` ON `push_subscriptions` (`session_id`);--> statement-breakpoint
-- A row from before the link can't be tied to a session, so it would outlive a
-- sign-out forever. Live devices re-register on their next load.
DELETE FROM `push_subscriptions` WHERE `session_id` IS NULL;
