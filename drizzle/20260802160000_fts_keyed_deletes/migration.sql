-- Make every FTS5 maintenance delete keyed instead of a full virtual-table scan.
--
-- The triggers in 20260530031640_message_search_index,
-- 20260708020600_conversation_summary_search and 20260622120000_media_prompt_search
-- all deleted by an UNINDEXED column (`message_id`, `conversation_id`, `media_id`).
-- FTS5 has no index on those, so each of those statements scanned the entire
-- virtual table. Cost measured on a synthetic index, per single-row delete:
--
--     10k rows -> 2.7ms   50k rows -> 14.2ms   200k rows -> 54.4ms
--
-- and it fires once per message row deleted. Deleting one 356-message
-- conversation against a 200k-row index is ~19s of blocking work inside a single
-- transaction holding the writer lock — and the aggregate is quadratic
-- (O(messages deleted x total indexed rows)). The message UPDATE trigger pays it
-- too, once per resolved tool call on the live streaming path.
--
-- Two fixes, one per table shape:
--
--  * `media_prompt_fts` is 1:1 with `media`, so its FTS rowid is simply pinned to
--    `media.rowid`. Deletes become `WHERE rowid = OLD.rowid`. No side table.
--
--  * `search_index` mixes three kinds ('message', 'title', 'summary') sourced
--    from two different tables, whose rowids would collide, so it gets
--    `search_index_ref`: an ordinary (indexed) table mapping each FTS rowid back
--    to what produced it. Deletes resolve through it and become rowid lookups.
--
-- `last_insert_rowid()` is what links the two — verified to return the FTS5
-- rowid when the INSERT happens inside a trigger body. Where the row-producing
-- INSERT is conditional (a SELECT that may match nothing, or a NULL title /
-- summary), the ref INSERT repeats the *same* condition rather than testing
-- `changes()`, so the two can never disagree and a stale `last_insert_rowid()`
-- can't be recorded against another row's id.
--
-- Hand-authored: SQL-only, NO snapshot.json — drizzle-kit doesn't track FTS
-- virtual tables or triggers. See the CLAUDE.md note on this pattern.

CREATE TABLE search_index_ref (
    fts_rowid INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id TEXT
);
--> statement-breakpoint
-- Both lookups the triggers perform: by message (the per-message delete) and by
-- conversation (the whole-conversation sweep, and the title/summary updates).
CREATE INDEX idx_search_index_ref_message ON search_index_ref (message_id, kind);
--> statement-breakpoint
CREATE INDEX idx_search_index_ref_conversation ON search_index_ref (conversation_id, kind);
--> statement-breakpoint
-- Adopt every row already in the index.
INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
SELECT rowid, kind, conversation_id, message_id FROM search_index;
--> statement-breakpoint

-- --- search_index: message rows -------------------------------------------

DROP TRIGGER search_index_messages_ai;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    SELECT
        COALESCE((SELECT group_concat(json_extract(value, '$.text'), ' ')
                  FROM json_each(NEW.content_json)
                  WHERE json_extract(value, '$.type') = 'text'), ''),
        c.user_id,
        NEW.conversation_id,
        NEW.id,
        'message'
    FROM conversations c WHERE c.id = NEW.conversation_id;
    INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
    SELECT last_insert_rowid(), 'message', NEW.conversation_id, NEW.id
    FROM conversations c WHERE c.id = NEW.conversation_id;
END;
--> statement-breakpoint
-- Fires once per message row whose text changes — in practice once per resolved
-- tool call, since the relay appends the assistant row a single time rather than
-- rewriting it per chunk. (The original comment here claimed a per-chunk
-- rewrite; that has not been true since the relay was restructured.)
DROP TRIGGER search_index_messages_au;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_au AFTER UPDATE OF content_json ON messages BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref
        WHERE message_id = NEW.id AND kind = 'message');
    DELETE FROM search_index_ref WHERE message_id = NEW.id AND kind = 'message';
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    SELECT
        COALESCE((SELECT group_concat(json_extract(value, '$.text'), ' ')
                  FROM json_each(NEW.content_json)
                  WHERE json_extract(value, '$.type') = 'text'), ''),
        c.user_id,
        NEW.conversation_id,
        NEW.id,
        'message'
    FROM conversations c WHERE c.id = NEW.conversation_id;
    INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
    SELECT last_insert_rowid(), 'message', NEW.conversation_id, NEW.id
    FROM conversations c WHERE c.id = NEW.conversation_id;
END;
--> statement-breakpoint
DROP TRIGGER search_index_messages_ad;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref
        WHERE message_id = OLD.id AND kind = 'message');
    DELETE FROM search_index_ref WHERE message_id = OLD.id AND kind = 'message';
END;
--> statement-breakpoint

-- --- search_index: conversation title rows ---------------------------------

DROP TRIGGER search_index_conversations_ai;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_ai AFTER INSERT ON conversations
WHEN NEW.title IS NOT NULL
BEGIN
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    VALUES (NEW.title, NEW.user_id, NEW.id, NULL, 'title');
    INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
    VALUES (last_insert_rowid(), 'title', NEW.id, NULL);
END;
--> statement-breakpoint
DROP TRIGGER search_index_conversations_au;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_au AFTER UPDATE OF title ON conversations BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref
        WHERE conversation_id = NEW.id AND kind = 'title');
    DELETE FROM search_index_ref WHERE conversation_id = NEW.id AND kind = 'title';
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    SELECT NEW.title, NEW.user_id, NEW.id, NULL, 'title'
    WHERE NEW.title IS NOT NULL;
    INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
    SELECT last_insert_rowid(), 'title', NEW.id, NULL
    WHERE NEW.title IS NOT NULL;
END;
--> statement-breakpoint
-- Whole-conversation sweep. The messages cascade fires search_index_messages_ad
-- per child row first; this catches the title + summary rows (and stays a
-- belt-and-suspenders sweep for any future kind).
DROP TRIGGER search_index_conversations_ad;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_ad AFTER DELETE ON conversations BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref WHERE conversation_id = OLD.id);
    DELETE FROM search_index_ref WHERE conversation_id = OLD.id;
END;
--> statement-breakpoint

-- --- search_index: conversation summary rows -------------------------------

DROP TRIGGER search_index_conv_summary_ai;
--> statement-breakpoint
CREATE TRIGGER search_index_conv_summary_ai AFTER INSERT ON conversations
WHEN NEW.summary IS NOT NULL
BEGIN
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    VALUES (NEW.summary, NEW.user_id, NEW.id, NULL, 'summary');
    INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
    VALUES (last_insert_rowid(), 'summary', NEW.id, NULL);
END;
--> statement-breakpoint
DROP TRIGGER search_index_conv_summary_au;
--> statement-breakpoint
CREATE TRIGGER search_index_conv_summary_au AFTER UPDATE OF summary ON conversations BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref
        WHERE conversation_id = NEW.id AND kind = 'summary');
    DELETE FROM search_index_ref WHERE conversation_id = NEW.id AND kind = 'summary';
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    SELECT NEW.summary, NEW.user_id, NEW.id, NULL, 'summary'
    WHERE NEW.summary IS NOT NULL;
    INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
    SELECT last_insert_rowid(), 'summary', NEW.id, NULL
    WHERE NEW.summary IS NOT NULL;
END;
--> statement-breakpoint

-- --- media_prompt_fts ------------------------------------------------------
--
-- Rebuilt so each FTS rowid equals the `media.rowid` that produced it.
-- Additionally, rows with no prompt are no longer indexed at all: the old
-- COALESCE(prompt_full, '') gave every upload an empty FTS row that can never
-- match, costing index space and a write per upload. Search joins back to
-- `media` for visibility, so an absent row reads the same as a non-matching one.

DROP TRIGGER media_prompt_fts_ai;
--> statement-breakpoint
CREATE TRIGGER media_prompt_fts_ai AFTER INSERT ON media
WHEN NEW.prompt_full IS NOT NULL
BEGIN
    INSERT INTO media_prompt_fts (rowid, text, media_id, user_id)
    VALUES (NEW.rowid, NEW.prompt_full, NEW.id, NEW.user_id);
END;
--> statement-breakpoint
DROP TRIGGER media_prompt_fts_au;
--> statement-breakpoint
CREATE TRIGGER media_prompt_fts_au AFTER UPDATE OF prompt_full ON media BEGIN
    DELETE FROM media_prompt_fts WHERE rowid = OLD.rowid;
    INSERT INTO media_prompt_fts (rowid, text, media_id, user_id)
    SELECT NEW.rowid, NEW.prompt_full, NEW.id, NEW.user_id
    WHERE NEW.prompt_full IS NOT NULL;
END;
--> statement-breakpoint
DROP TRIGGER media_prompt_fts_ad;
--> statement-breakpoint
CREATE TRIGGER media_prompt_fts_ad AFTER DELETE ON media BEGIN
    DELETE FROM media_prompt_fts WHERE rowid = OLD.rowid;
END;
--> statement-breakpoint
DELETE FROM media_prompt_fts;
--> statement-breakpoint
INSERT INTO media_prompt_fts (rowid, text, media_id, user_id)
SELECT rowid, prompt_full, id, user_id FROM media WHERE prompt_full IS NOT NULL;
