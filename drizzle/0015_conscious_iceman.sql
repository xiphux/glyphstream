DROP INDEX `idx_media_unreferenced`;--> statement-breakpoint
CREATE INDEX `idx_media_unreferenced` ON `media` (`origin`,`hard_deleted_at`,`unreferenced_since`);