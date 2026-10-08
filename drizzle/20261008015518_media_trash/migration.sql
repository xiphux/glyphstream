ALTER TABLE `media` RENAME COLUMN `hard_deleted_at` TO `deleted_at`;--> statement-breakpoint
ALTER TABLE `media` ADD `purged_at` integer;--> statement-breakpoint
-- Every row deleted before the trash existed had its bytes unlinked at delete
-- time, so its purge moment IS its delete moment. Without this they'd all read
-- as restorable trash pointing at files that are gone.
UPDATE `media` SET `purged_at` = `deleted_at` WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_media_trash` ON `media` (`user_id`,`origin`,`deleted_at`,`id`) WHERE "media"."deleted_at" is not null and "media"."purged_at" is null;