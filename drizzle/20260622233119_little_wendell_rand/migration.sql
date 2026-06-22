ALTER TABLE `media` ADD `embedding` blob;--> statement-breakpoint
ALTER TABLE `media` ADD `embedding_model` text;--> statement-breakpoint
CREATE INDEX `idx_media_unembedded` ON `media` (`id`) WHERE "media"."embedding" is null and "media"."prompt_full" is not null and "media"."origin" = 'generated';