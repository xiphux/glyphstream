CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`endpoint_id` text NOT NULL,
	`model_id` text NOT NULL,
	`custom_model_id` text,
	`system_prompt` text,
	`active_leaf_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`custom_model_id`) REFERENCES `custom_models`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_leaf_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_user_updated` ON `conversations` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `custom_models` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`base_endpoint_id` text NOT NULL,
	`base_model_id` text NOT NULL,
	`system_prompt` text,
	`parameters_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`storage_path` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`kind` text NOT NULL,
	`source_endpoint_id` text,
	`source_model` text,
	`prompt_excerpt` text,
	`created_at` integer NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`unreferenced_since` integer,
	`hard_deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_storage_path_unique` ON `media` (`storage_path`);--> statement-breakpoint
CREATE INDEX `idx_media_user_created` ON `media` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_media_unreferenced` ON `media` (`unreferenced_since`);--> statement-breakpoint
CREATE TABLE `message_media` (
	`message_id` text NOT NULL,
	`media_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `media_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`parent_message_id` text,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`content_html` text,
	`reasoning_text` text,
	`finish_reason` text,
	`model_used` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`raw_response_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_conv_parent` ON `messages` (`conversation_id`,`parent_message_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_conv_created` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_user_id` integer NOT NULL,
	`github_username` text NOT NULL,
	`email` text,
	`display_name` text,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_user_id_unique` ON `users` (`github_user_id`);