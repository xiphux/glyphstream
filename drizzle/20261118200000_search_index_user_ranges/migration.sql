-- Give each user their own rowid range in `search_index`, so a search reads only
-- the searcher's rows.
--
-- `user_id` is UNINDEXED, so `WHERE user_id = ? AND search_index MATCH ?` made
-- FTS5 produce every instance-wide match and then read each one's content row to
-- compare the owner: a common word cost 0.13-0.2s at 220k indexed rows whoever
-- searched, even a user with a few thousand rows of their own. FTS5 does push a
-- rowid range down into the MATCH, seeking each term's doclist to the range start
-- and stopping at its end. So every row is now numbered
--
--     rowid = ord * 2^32 + seq        (seq in 1 .. 2^32 - 1)
--
-- where `ord` is the owner's number in `search_index_owner`, and the search adds
-- `rowid BETWEEN ord * 2^32 AND ord * 2^32 + 2^32 - 1`.
--
-- Why not an indexed user column filtered in the MATCH: bm25 normalises by each
-- row's token count across ALL columns, so one extra token per row reorders
-- results, and porter stemming can fold two ids onto one token. A rowid range
-- adds no tokens: the table definition, tokenizer and every input to bm25 are
-- unchanged, so ranking and snippets are identical.
--
-- Inserts go through the `search_index_insert` view, whose INSTEAD OF trigger
-- assigns the rowid (one past the highest already in the owner's range, found
-- through `search_index_ref`'s primary key) and records the ref row, so the six
-- row-producing triggers share one copy of that logic. The delete triggers from
-- 20260802160000_fts_keyed_deletes are untouched: they delete by rowid through
-- `search_index_ref`, which still maps every row.
--
-- The rebuild re-reads messages, titles and summaries from their tables, keeping
-- each user's rows in their previous order so a tie in rank still resolves to
-- the same row.
--
-- Hand-authored: SQL-only, NO snapshot.json — drizzle-kit doesn't track FTS
-- virtual tables, views or triggers. See the CLAUDE.md note on this pattern.

CREATE TABLE search_index_owner (
    ord INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE
);
--> statement-breakpoint
INSERT INTO search_index_owner (user_id)
SELECT DISTINCT user_id FROM conversations ORDER BY user_id;
--> statement-breakpoint
CREATE TEMP TABLE search_index_rebuild AS
WITH src AS (
    SELECT
        COALESCE((SELECT group_concat(json_extract(value, '$.text'), ' ')
                  FROM json_each(m.content_json)
                  WHERE json_extract(value, '$.type') = 'text'), '') AS text,
        c.user_id,
        m.conversation_id,
        m.id AS message_id,
        'message' AS kind,
        (SELECT r.fts_rowid FROM search_index_ref r
         WHERE r.message_id = m.id AND r.kind = 'message') AS old_rowid
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    UNION ALL
    SELECT title, user_id, id, NULL, 'title',
        (SELECT r.fts_rowid FROM search_index_ref r
         WHERE r.conversation_id = conversations.id AND r.kind = 'title')
    FROM conversations WHERE title IS NOT NULL
    UNION ALL
    SELECT summary, user_id, id, NULL, 'summary',
        (SELECT r.fts_rowid FROM search_index_ref r
         WHERE r.conversation_id = conversations.id AND r.kind = 'summary')
    FROM conversations WHERE summary IS NOT NULL
)
SELECT
    o.ord * 4294967296 + row_number() OVER (
        PARTITION BY o.ord ORDER BY src.old_rowid IS NULL, src.old_rowid, src.conversation_id, src.message_id
    ) AS new_rowid,
    src.text, src.user_id, src.conversation_id, src.message_id, src.kind
FROM src
JOIN search_index_owner o ON o.user_id = src.user_id;
--> statement-breakpoint
DROP TRIGGER search_index_messages_ai;
--> statement-breakpoint
DROP TRIGGER search_index_messages_au;
--> statement-breakpoint
DROP TRIGGER search_index_conversations_ai;
--> statement-breakpoint
DROP TRIGGER search_index_conversations_au;
--> statement-breakpoint
DROP TRIGGER search_index_conv_summary_ai;
--> statement-breakpoint
DROP TRIGGER search_index_conv_summary_au;
--> statement-breakpoint
DROP TABLE search_index;
--> statement-breakpoint
DELETE FROM search_index_ref;
--> statement-breakpoint
-- Same definition as 20260530031640_message_search_index.
CREATE VIRTUAL TABLE search_index USING fts5(
    text,
    user_id UNINDEXED,
    conversation_id UNINDEXED,
    message_id UNINDEXED,
    kind UNINDEXED,
    tokenize = 'porter unicode61'
);
--> statement-breakpoint
-- Ascending rowid order appends to the FTS5 content b-tree instead of
-- scattering inserts across it.
INSERT INTO search_index (rowid, text, user_id, conversation_id, message_id, kind)
SELECT new_rowid, text, user_id, conversation_id, message_id, kind
FROM search_index_rebuild ORDER BY new_rowid;
--> statement-breakpoint
INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
SELECT new_rowid, kind, conversation_id, message_id FROM search_index_rebuild;
--> statement-breakpoint
DROP TABLE search_index_rebuild;
--> statement-breakpoint
INSERT INTO search_index (search_index) VALUES ('optimize');
--> statement-breakpoint

-- --- the single insert path ------------------------------------------------
--
-- A full range (2^32 - 1 rows, counting every re-index of an edited message)
-- is not handled. The next row takes the following owner's base rowid, which
-- none of their rows uses, so it lands in their range without leaking (the
-- search also checks the owner); the row after it computes that same rowid
-- again and its write fails.

CREATE VIEW search_index_insert AS
SELECT text, user_id, conversation_id, message_id, kind FROM search_index WHERE 0;
--> statement-breakpoint
CREATE TRIGGER search_index_insert_ii INSTEAD OF INSERT ON search_index_insert BEGIN
    INSERT OR IGNORE INTO search_index_owner (user_id) VALUES (NEW.user_id);
    INSERT INTO search_index (rowid, text, user_id, conversation_id, message_id, kind)
    SELECT
        COALESCE((SELECT r.fts_rowid FROM search_index_ref r
                  WHERE r.fts_rowid BETWEEN o.ord * 4294967296 AND o.ord * 4294967296 + 4294967295
                  ORDER BY r.fts_rowid DESC LIMIT 1),
                 o.ord * 4294967296) + 1,
        NEW.text, NEW.user_id, NEW.conversation_id, NEW.message_id, NEW.kind
    FROM search_index_owner o WHERE o.user_id = NEW.user_id;
    INSERT INTO search_index_ref (fts_rowid, kind, conversation_id, message_id)
    VALUES (last_insert_rowid(), NEW.kind, NEW.conversation_id, NEW.message_id);
END;
--> statement-breakpoint

-- --- message rows ----------------------------------------------------------

CREATE TRIGGER search_index_messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO search_index_insert (text, user_id, conversation_id, message_id, kind)
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
CREATE TRIGGER search_index_messages_au AFTER UPDATE OF content_json ON messages BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref
        WHERE message_id = NEW.id AND kind = 'message');
    DELETE FROM search_index_ref WHERE message_id = NEW.id AND kind = 'message';
    INSERT INTO search_index_insert (text, user_id, conversation_id, message_id, kind)
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

-- --- conversation title rows -----------------------------------------------

CREATE TRIGGER search_index_conversations_ai AFTER INSERT ON conversations
WHEN NEW.title IS NOT NULL
BEGIN
    INSERT INTO search_index_insert (text, user_id, conversation_id, message_id, kind)
    VALUES (NEW.title, NEW.user_id, NEW.id, NULL, 'title');
END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_au AFTER UPDATE OF title ON conversations BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref
        WHERE conversation_id = NEW.id AND kind = 'title');
    DELETE FROM search_index_ref WHERE conversation_id = NEW.id AND kind = 'title';
    INSERT INTO search_index_insert (text, user_id, conversation_id, message_id, kind)
    SELECT NEW.title, NEW.user_id, NEW.id, NULL, 'title'
    WHERE NEW.title IS NOT NULL;
END;
--> statement-breakpoint

-- --- conversation summary rows ---------------------------------------------

CREATE TRIGGER search_index_conv_summary_ai AFTER INSERT ON conversations
WHEN NEW.summary IS NOT NULL
BEGIN
    INSERT INTO search_index_insert (text, user_id, conversation_id, message_id, kind)
    VALUES (NEW.summary, NEW.user_id, NEW.id, NULL, 'summary');
END;
--> statement-breakpoint
CREATE TRIGGER search_index_conv_summary_au AFTER UPDATE OF summary ON conversations BEGIN
    DELETE FROM search_index WHERE rowid IN (
        SELECT fts_rowid FROM search_index_ref
        WHERE conversation_id = NEW.id AND kind = 'summary');
    DELETE FROM search_index_ref WHERE conversation_id = NEW.id AND kind = 'summary';
    INSERT INTO search_index_insert (text, user_id, conversation_id, message_id, kind)
    SELECT NEW.summary, NEW.user_id, NEW.id, NULL, 'summary'
    WHERE NEW.summary IS NOT NULL;
END;
