CREATE TABLE `scheduled_runs` (
	`id` text PRIMARY KEY,
	`schedule_id` text NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`slot_at` integer NOT NULL,
	`trigger` text NOT NULL,
	`state` text NOT NULL,
	`failure_kind` text,
	`failure_detail` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT `fk_scheduled_runs_schedule_id_scheduled_tasks_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `scheduled_tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scheduled_runs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scheduled_runs_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`model_id` text NOT NULL,
	`custom_model_id` text,
	`system_prompt` text,
	`parameters_json` text,
	`cadence_json` text NOT NULL,
	`timezone` text NOT NULL,
	`tool_policy_json` text NOT NULL,
	`disabled_features` text,
	`deadline_minutes` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`disabled_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_scheduled_tasks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scheduled_tasks_custom_model_id_custom_models_id_fk` FOREIGN KEY (`custom_model_id`) REFERENCES `custom_models`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `schedule_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_scheduled_runs_schedule_slot` ON `scheduled_runs` (`schedule_id`,`slot_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_runs_schedule_created` ON `scheduled_runs` (`schedule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_runs_user` ON `scheduled_runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_runs_conversation` ON `scheduled_runs` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_runs_unsettled` ON `scheduled_runs` (`state`) WHERE "scheduled_runs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_user` ON `scheduled_tasks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_due` ON `scheduled_tasks` (`next_run_at`) WHERE "scheduled_tasks"."enabled" = 1;--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_custom_model` ON `scheduled_tasks` (`custom_model_id`);