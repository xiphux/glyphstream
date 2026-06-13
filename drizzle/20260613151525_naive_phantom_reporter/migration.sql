CREATE TABLE `mcp_credentials` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`secret_ciphertext` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_mcp_credentials_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mcp_credentials_user_server` ON `mcp_credentials` (`user_id`,`server_id`);