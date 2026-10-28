CREATE TABLE `message_images` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`marker_index` integer,
	`media_id` text,
	`model_id` text NOT NULL,
	`error` text,
	`shown_at` integer,
	`comparison_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_message_images_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_images_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_images_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_images_media_id_media_id_fk` FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_message_images_message` ON `message_images` (`message_id`,`marker_index`);--> statement-breakpoint
CREATE INDEX `idx_message_images_conversation` ON `message_images` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_message_images_user` ON `message_images` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_message_images_media` ON `message_images` (`media_id`);