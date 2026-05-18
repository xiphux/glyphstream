-- Best-effort prompt recovery for media generated before the 0005
-- schema split.
--
-- Background: 0005 added `prompt_full` and backfilled it from the
-- truncated `prompt_excerpt`, because legacy rows had no other
-- source of the original prompt on the media row itself. But the
-- *full* prompt does still exist for any legacy media whose source
-- conversation hasn't been deleted — it lives in the text part of
-- the user message that triggered the generation (the parent of
-- the assistant message that the media is linked to).
--
-- This migration walks that chain and rehydrates `prompt_full`:
--
--   media row
--     ←  message_media link
--          ←  assistant message (the turn that produced the image)
--               ←  parent user message (role='user')
--                    →  content_json
--                         →  first {type:'text'} part
--                              →  text (= the full prompt verbatim)
--
-- Recovery uses SQLite's `json_each` to find the *first text part*
-- inside the user message, not just the first part — image-edit
-- flows sometimes lead with an image attachment and the text comes
-- second. The ORDER BY pins down deterministic selection when a
-- media row is linked from multiple assistant messages (auto-attach
-- across conversations): take the earliest one, which is the
-- assistant turn that *originally* generated the image, not later
-- follow-ups that used it as input.
--
-- Eligibility (the outer WHERE):
--
--   - origin = 'generated' (uploads have no prompt; never had one).
--   - prompt_full IS NULL OR prompt_full = prompt_excerpt. The
--     second condition is the signature of 0005's excerpt-fallback:
--     those rows currently hold the truncated value and would
--     benefit from an upgrade if we can find one. Rows where
--     prompt_full ≠ prompt_excerpt have already been populated
--     with a real full prompt (e.g. by the persister post-0005)
--     and shouldn't be touched.
--
-- COALESCE preserves the existing value when the recovery subquery
-- yields NULL (conversation was already deleted before the library
-- model shipped, or the user message has no text parts) — the row
-- keeps its 0005 excerpt fallback rather than going back to NULL.
UPDATE media
SET prompt_full = COALESCE(
    (
        SELECT json_extract(part.value, '$.text')
        FROM messages assistant_msg
        JOIN message_media mm2 ON mm2.message_id = assistant_msg.id
        JOIN messages user_msg ON user_msg.id = assistant_msg.parent_message_id
        JOIN json_each(user_msg.content_json) part
        WHERE mm2.media_id = media.id
          AND user_msg.role = 'user'
          AND json_extract(part.value, '$.type') = 'text'
        ORDER BY assistant_msg.created_at ASC, part.key ASC
        LIMIT 1
    ),
    prompt_full,
    prompt_excerpt
)
WHERE origin = 'generated'
  AND (prompt_full IS NULL OR prompt_full = prompt_excerpt);
