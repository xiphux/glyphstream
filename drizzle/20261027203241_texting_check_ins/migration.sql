CREATE TABLE `check_ins` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`note` text NOT NULL,
	`fire_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_check_ins_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_check_ins_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_check_ins_source_message_id_messages_id_fk` FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_check_ins_conversation` ON `check_ins` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_check_ins_fire_at` ON `check_ins` (`fire_at`);--> statement-breakpoint
CREATE INDEX `idx_check_ins_user` ON `check_ins` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_check_ins_source_message` ON `check_ins` (`source_message_id`);