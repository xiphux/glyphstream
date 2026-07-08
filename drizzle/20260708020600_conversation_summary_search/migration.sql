-- Index the per-conversation summary (conversations.summary, written by the
-- background summary pass) into the existing `search_index` FTS5 table as a new
-- `kind = 'summary'` row, so a conversation surfaces in search by its gist — not
-- only by literal token overlap with a raw message. Mirrors the title triggers in
-- 20260530031640_message_search_index; message_id is NULL on a summary row (it
-- describes the whole conversation, like a title row).
--
-- Hand-authored trigger migration: SQL-only, NO snapshot.json (drizzle-kit
-- doesn't track FTS virtual tables / triggers). Ordered after the column-add
-- migration since it references conversations.summary.
--
-- No DELETE trigger is needed: the existing `search_index_conversations_ad`
-- already sweeps every row for a deleted conversation regardless of kind.

CREATE TRIGGER search_index_conv_summary_ai AFTER INSERT ON conversations
WHEN NEW.summary IS NOT NULL
BEGIN
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    VALUES (NEW.summary, NEW.user_id, NEW.id, NULL, 'summary');
END;
--> statement-breakpoint
-- Wipe-then-conditionally-reinsert so a set / rewrite / clear-to-NULL all
-- converge to "the current summary is what's indexed" — same shape as the title
-- AU trigger.
CREATE TRIGGER search_index_conv_summary_au AFTER UPDATE OF summary ON conversations
BEGIN
    DELETE FROM search_index WHERE kind = 'summary' AND conversation_id = NEW.id;
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    SELECT NEW.summary, NEW.user_id, NEW.id, NULL, 'summary'
    WHERE NEW.summary IS NOT NULL;
END;
