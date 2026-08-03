ALTER TABLE `sessions` ADD `last_seen_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_agent` text;