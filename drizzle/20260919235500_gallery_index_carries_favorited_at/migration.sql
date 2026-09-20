-- Carry `favorited_at` on the gallery's hot index so the cache fingerprint stays
-- index-only. `galleryUserFingerprint` aggregates max(favorited_at), and reading a
-- column this index doesn't hold costs a table-row lookup per matching row: the
-- plan drops from COVERING INDEX to INDEX and the query measured 0.8ms -> 3.2ms at
-- 30k media, on the one piece of DB work a gallery cache HIT still performs.
--
-- Hand-authored, hence no snapshot.json: drizzle-kit v1 does NOT diff an index's
-- column list. `pnpm db:generate` reports "No schema changes, nothing to migrate"
-- with schema.ts declaring five columns and the last snapshot recording four, so
-- this can only be written by hand. (The stale entry in
-- 20260919231727_giant_red_skull/snapshot.json is corrected in place, so a future
-- generate diffs against the truth rather than re-proposing this.)
DROP INDEX `idx_media_user_gallery`;--> statement-breakpoint
CREATE INDEX `idx_media_user_gallery` ON `media` (`user_id`,`origin`,`hard_deleted_at`,`created_at`,`favorited_at`);
