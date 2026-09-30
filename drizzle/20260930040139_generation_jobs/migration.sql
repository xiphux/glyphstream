CREATE TABLE `generation_jobs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`anchor_message_id` text NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`model_id` text NOT NULL,
	`fanout_index` integer,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`params_json` text NOT NULL,
	`prepared_json` text,
	`upstream_job_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	CONSTRAINT `fk_generation_jobs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_generation_jobs_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_generation_jobs_anchor_message_id_messages_id_fk` FOREIGN KEY (`anchor_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_anchor` ON `generation_jobs` (`anchor_message_id`);