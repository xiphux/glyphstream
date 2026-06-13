CREATE TABLE `oauth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`external_username` text,
	`external_email` text,
	`created_at` integer NOT NULL,
	`last_synced_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_accounts_provider_external` ON `oauth_accounts` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_accounts_user_id` ON `oauth_accounts` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `disabled_at` integer;--> statement-breakpoint
-- Backfill: every existing user has a GitHub binding; preserve it as a
-- row in oauth_accounts so the next migration can drop the columns from
-- users without losing identity. randomblob(16) is SQLite-native and
-- gives a 32-char hex id (cosmetic inconsistency with the UUID format
-- app code uses for new rows; functional and globally unique).
INSERT INTO `oauth_accounts` (`id`, `user_id`, `provider`, `external_id`, `external_username`, `external_email`, `created_at`, `last_synced_at`)
SELECT lower(hex(randomblob(16))), `id`, 'github', CAST(`github_user_id` AS TEXT), `github_username`, `email`, `created_at`, `last_login_at`
FROM `users`
WHERE `github_user_id` IS NOT NULL;--> statement-breakpoint
-- Preserve the existing operator's visible sidebar/greeting label by
-- promoting their GitHub username into display_name when they haven't
-- set one explicitly. Without this, the post-refactor fallback chain
-- (displayName ?? email ?? 'You') would show 'You' on a fresh upgrade.
UPDATE `users` SET `display_name` = `github_username` WHERE `display_name` IS NULL OR `display_name` = '';