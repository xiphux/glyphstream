ALTER TABLE `media` ADD `prompt_full` text;
--> statement-breakpoint
-- Backfill: existing rows only have `prompt_excerpt` (truncated to 500
-- chars). For pre-existing media that's the best record of the prompt
-- we have, so copy it forward into `prompt_full`. Rows with a NULL
-- `prompt_excerpt` (uploads, or anything inserted without a prompt)
-- stay NULL in `prompt_full` too. Going forward, `persister.ts`
-- populates `prompt_full` with the untruncated original.
UPDATE `media` SET `prompt_full` = `prompt_excerpt` WHERE `prompt_excerpt` IS NOT NULL;
