CREATE INDEX `idx_media_user_gallery` ON `media` (`user_id`,`origin`,`hard_deleted_at`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_media_unembedded`;--> statement-breakpoint
CREATE INDEX `idx_media_unembedded` ON `media` (`origin`,`hard_deleted_at`,`id`,`prompt_full`) WHERE "media"."embedding" is null and "media"."prompt_full" is not null and "media"."origin" = 'generated' and "media"."hard_deleted_at" is null;
