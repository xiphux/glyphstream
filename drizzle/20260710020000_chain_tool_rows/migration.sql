-- Chain tool rows that were persisted as siblings under the same
-- assistant message into a linear chain.
--
-- Before (sibling shape — tool rows off-chain):
--   assistant (parent of both)
--   ├── tool_a  ← on branch
--   └── tool_b  ← OFF branch (walkActiveBranch skips it)
--
-- After (chain shape — all on branch):
--   assistant
--   └── tool_a
--       └── tool_b  ← leaf, walkActiveBranch traverses all
--
-- A tool row that has no tool siblings is left untouched (no re-parenting).
-- Re-running is idempotent: after chaining, each tool row has a unique
-- parent_message_id, so no group has sibling_count > 1.

WITH ordered_tools AS (
    SELECT
        id,
        parent_message_id,
        created_at,
        ROW_NUMBER() OVER (
            PARTITION BY parent_message_id
            ORDER BY created_at, id
        ) AS rn,
        COUNT(*) OVER (PARTITION BY parent_message_id) AS sibling_count
    FROM messages
    WHERE role = 'tool'
),
-- Select tool rows that have at least one sibling tool row under the same
-- parent and are NOT the first in their group (the first keeps its parent).
tool_chain AS (
    SELECT
        o1.id,
        o2.id AS new_parent_message_id
    FROM ordered_tools o1
    INNER JOIN ordered_tools o2
        ON o2.parent_message_id = o1.parent_message_id
        AND o2.rn = o1.rn - 1
    WHERE o1.rn > 1
    AND o1.sibling_count > 1
)
UPDATE messages
SET parent_message_id = (
    SELECT tc.new_parent_message_id
    FROM tool_chain tc
    WHERE tc.id = messages.id
)
WHERE EXISTS (
    SELECT 1 FROM tool_chain tc WHERE tc.id = messages.id
);
