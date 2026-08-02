CREATE INDEX `idx_conversations_user_archived` ON `conversations` (`user_id`,`updated_at`) WHERE "conversations"."archived_at" is not null;--> statement-breakpoint
CREATE INDEX `idx_conversations_summary_queue` ON `conversations` (`updated_at`) WHERE "conversations"."private" = 0;--> statement-breakpoint
CREATE INDEX `idx_custom_models_user_name` ON `custom_models` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_memories_deleted` ON `memories` (`deleted_at`,`user_id`) WHERE "memories"."deleted_at" is not null;--> statement-breakpoint
-- Hand-added: drizzle-kit records a changed index's new columns in the snapshot
-- but does not emit the DROP/CREATE for it (same omission as idx_media_unembedded
-- in 20260802152917_equal_lilith). Without these two statements the DB keeps the
-- old two-column shape while the snapshot claims the new one.
DROP INDEX `idx_messages_conv_created`;--> statement-breakpoint
CREATE INDEX `idx_messages_conv_created` ON `messages` (`conversation_id`,`created_at`,`parent_message_id`,`role`,`id`);
