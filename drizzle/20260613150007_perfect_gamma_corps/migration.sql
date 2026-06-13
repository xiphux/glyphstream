CREATE TABLE `invites` (
	`id` text PRIMARY KEY,
	`token_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_user_id` text,
	CONSTRAINT `fk_invites_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_invites_used_by_user_id_users_id_fk` FOREIGN KEY (`used_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_invites_token_hash` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_invites_created_by` ON `invites` (`created_by_user_id`);