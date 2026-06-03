DROP INDEX `users_github_user_id_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `github_user_id`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `github_username`;