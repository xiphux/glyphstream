CREATE TABLE `artifact_versions` (
	`id` text PRIMARY KEY,
	`artifact_id` text NOT NULL,
	`parent_version_id` text,
	`content` text NOT NULL,
	`content_html` text,
	`created_by_message_id` text,
	`edit_source` text DEFAULT 'agent' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_artifact_versions_artifact_id_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_artifact_versions_created_by_message_id_messages_id_fk` FOREIGN KEY (`created_by_message_id`) REFERENCES `messages`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`title` text,
	`kind` text DEFAULT 'markdown' NOT NULL,
	`current_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_artifacts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_artifacts_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_artifacts_current_version_id_artifact_versions_id_fk` FOREIGN KEY (`current_version_id`) REFERENCES `artifact_versions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifact_versions_artifact_created` ON `artifact_versions` (`artifact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_versions_created_by_message` ON `artifact_versions` (`created_by_message_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_conversation` ON `artifacts` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_user_updated` ON `artifacts` (`user_id`,`updated_at`);