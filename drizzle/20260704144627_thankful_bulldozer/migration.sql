ALTER TABLE `memories` ADD `topic` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `recall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `last_recalled_at` integer;