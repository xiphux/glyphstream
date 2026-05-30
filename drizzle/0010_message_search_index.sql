-- Full-text search index over conversation titles + message bodies.
--
-- One unified FTS5 virtual table covers both row kinds — title hits and
-- message hits surface from a single query and the UI distinguishes them
-- via the `kind` column. `message_id` is NULL on title rows.
--
-- Tokenizer is porter+unicode61 — stemming on top of Unicode word
-- segmentation. Good default for English-leaning prose; preserves accented
-- and non-Latin tokens so chats with French / Japanese / mathematical text
-- still match.
--
-- The `user_id`, `conversation_id`, `message_id`, `kind` columns are
-- UNINDEXED — they're SELECT-retrievable and WHERE-filterable but don't
-- become search terms. user_id filtering in WHERE is how we scope search
-- to the caller without bloating the FTS index with per-user tokens.
CREATE VIRTUAL TABLE search_index USING fts5(
    text,
    user_id UNINDEXED,
    conversation_id UNINDEXED,
    message_id UNINDEXED,
    kind UNINDEXED,
    tokenize = 'porter unicode61'
);
--> statement-breakpoint
-- --- Triggers maintaining the message-body rows -----------------------------
--
-- Text extraction: messages.content_json is a JSON array of MessagePart
-- objects. We index the concatenated text of every `{type:'text'}` part
-- (skipping image / video / reasoning / tool_call / tool_result parts —
-- they're either non-text or noisy machine output, not the conversation
-- content a user would search). COALESCE to '' handles messages with no
-- text parts (image-only assistant turns) — they get an empty FTS row
-- which simply never matches.
--
-- The user_id is pulled from the parent conversation since the messages
-- table doesn't carry it directly.

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
END;
--> statement-breakpoint
-- Streaming writes the assistant message row repeatedly as chunks arrive,
-- updating content_json each time. The UPDATE trigger re-indexes on every
-- chunk; FTS5 reindex cost is negligible at solo-user scale. If a
-- multi-tenant deployment ever surfaces this as a hot path, gate on a
-- "finalized" flag.
CREATE TRIGGER search_index_messages_au AFTER UPDATE OF content_json ON messages BEGIN
    DELETE FROM search_index WHERE kind = 'message' AND message_id = NEW.id;
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
END;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM search_index WHERE kind = 'message' AND message_id = OLD.id;
END;
--> statement-breakpoint
-- --- Triggers maintaining the conversation-title rows ----------------------
--
-- Titles are optional (NEW.title can be NULL during the create→first-message
-- window before the title-source state machine settles). We only emit a
-- title row when a non-NULL title is present, and the UPDATE trigger
-- always wipes-then-conditionally-reinserts so renaming from one value to
-- another / from NULL to a value / from a value to NULL all converge to
-- "the current state is what's indexed."

CREATE TRIGGER search_index_conversations_ai AFTER INSERT ON conversations
WHEN NEW.title IS NOT NULL
BEGIN
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    VALUES (NEW.title, NEW.user_id, NEW.id, NULL, 'title');
END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_au AFTER UPDATE OF title ON conversations BEGIN
    DELETE FROM search_index WHERE kind = 'title' AND conversation_id = NEW.id;
    INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
    SELECT NEW.title, NEW.user_id, NEW.id, NULL, 'title'
    WHERE NEW.title IS NOT NULL;
END;
--> statement-breakpoint
-- Conversation DELETE clears every search row for the conversation, not
-- just the title — the messages table's ON DELETE CASCADE will fire the
-- messages_ad trigger for each child message and clean those up too, but
-- doing the broad sweep here is a cheap belt-and-suspenders against any
-- future schema change that bypasses the message-level cascade.
CREATE TRIGGER search_index_conversations_ad AFTER DELETE ON conversations BEGIN
    DELETE FROM search_index WHERE conversation_id = OLD.id;
END;
--> statement-breakpoint
-- --- Backfill from existing rows --------------------------------------------

INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
SELECT
    COALESCE((SELECT group_concat(json_extract(value, '$.text'), ' ')
              FROM json_each(m.content_json)
              WHERE json_extract(value, '$.type') = 'text'), ''),
    c.user_id,
    m.conversation_id,
    m.id,
    'message'
FROM messages m
JOIN conversations c ON c.id = m.conversation_id;
--> statement-breakpoint
INSERT INTO search_index (text, user_id, conversation_id, message_id, kind)
SELECT title, user_id, id, NULL, 'title'
FROM conversations
WHERE title IS NOT NULL;
