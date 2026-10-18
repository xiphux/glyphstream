CREATE TABLE `model_stats_daily` (
	`day` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`model_id` text NOT NULL,
	`metric` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`sum` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `model_stats_daily_pk` PRIMARY KEY(`day`, `endpoint_id`, `model_id`, `metric`)
);
--> statement-breakpoint
CREATE TABLE `model_user_usage` (
	`endpoint_id` text NOT NULL,
	`model_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_used_at` integer NOT NULL,
	CONSTRAINT `model_user_usage_pk` PRIMARY KEY(`endpoint_id`, `model_id`, `user_id`),
	CONSTRAINT `fk_model_user_usage_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_model_user_usage_user` ON `model_user_usage` (`user_id`);