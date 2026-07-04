ALTER TABLE `memories` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `superseded_by_memory_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `last_dreamed_at` integer;