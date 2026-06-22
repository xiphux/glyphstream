-- Full-text search index over generated-media prompts (`media.prompt_full`).
--
-- Mirrors the conversation `search_index` (migration 0010): an FTS5 virtual
-- table the gallery's prompt search MATCHes against, kept in sync by triggers
-- on `media`. Visibility (hard_deleted_at / origin / kind / model) is enforced
-- by the search query's JOIN back to `media`, NOT here — media rows are
-- soft-deleted (the row persists with bytes cleared), so the join-filter is the
-- robust gate, same as conversation search joining `conversations`.
--
-- `media_id` / `user_id` are UNINDEXED: SELECT-retrievable + WHERE-filterable
-- (user scoping) without becoming search terms. Tokenizer porter+unicode61
-- matches the conversation index (stemming over Unicode segmentation).
CREATE VIRTUAL TABLE media_prompt_fts USING fts5(
    text,
    media_id UNINDEXED,
    user_id UNINDEXED,
    tokenize = 'porter unicode61'
);
--> statement-breakpoint
-- COALESCE prompt to '' so uploads / legacy null-prompt rows still get an inert
-- FTS row (which simply never matches) and the trigger never inserts NULL text.
CREATE TRIGGER media_prompt_fts_ai AFTER INSERT ON media BEGIN
    INSERT INTO media_prompt_fts (text, media_id, user_id)
    VALUES (COALESCE(NEW.prompt_full, ''), NEW.id, NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER media_prompt_fts_au AFTER UPDATE OF prompt_full ON media BEGIN
    DELETE FROM media_prompt_fts WHERE media_id = NEW.id;
    INSERT INTO media_prompt_fts (text, media_id, user_id)
    VALUES (COALESCE(NEW.prompt_full, ''), NEW.id, NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER media_prompt_fts_ad AFTER DELETE ON media BEGIN
    DELETE FROM media_prompt_fts WHERE media_id = OLD.id;
END;
--> statement-breakpoint
-- Backfill existing rows.
INSERT INTO media_prompt_fts (text, media_id, user_id)
SELECT COALESCE(prompt_full, ''), id, user_id FROM media;
