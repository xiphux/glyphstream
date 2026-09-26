ALTER TABLE `sessions` ADD `unlocked_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `app_lock_timeout_ms` integer;