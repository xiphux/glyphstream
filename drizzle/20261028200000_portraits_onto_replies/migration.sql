-- Avatar portraits move off the thread and onto the reply they were drawn from,
-- the way texting photos did (see `*_photos_onto_replies`).
--
-- A portrait used to be an assistant message of its own: a display-only image
-- hung under the reply describing the assistant. Re-drawing made a sibling, a
-- failed draw left an error-only message beside them, and a comparison parked
-- the thread on the description. Now each is a version in `message_images`
-- (kind 'portrait', no marker) on the description, and the thread holds only
-- the conversation.
--
-- For every portrait message: a version on its description (on show if it is
-- the conversation's face), its image linked to the description instead,
-- anything below it re-attached to the description, and the message itself
-- deleted — with the failed draws beside it. Leaves that pointed at a removed
-- message move to the description; a parked avatar comparison is over (its
-- candidates are versions, and the face stays what it was); queued draws land
-- as portraits. A no-op on a database with no portraits.
CREATE TEMP TABLE _portrait AS
SELECT
	m.id,
	m.conversation_id,
	m.parent_message_id AS reply_id,
	json_extract(m.content_json, '$[0].mediaId') AS media_id,
	m.model_used,
	m.created_at
FROM messages m
JOIN messages r ON r.id = m.parent_message_id AND r.role = 'assistant'
WHERE m.role = 'assistant'
	AND json_valid(m.content_json)
	AND json_array_length(m.content_json) = 1
	AND json_extract(m.content_json, '$[0].type') = 'image'
	AND json_extract(m.content_json, '$[0].displayOnly') = 1
	AND json_extract(m.content_json, '$[0].photo') IS NULL;
--> statement-breakpoint
-- Failed draws: an error-only reply under a reply, from an image draw. Other
-- failures can sit there too — a scheduled run interrupted by a restart leaves
-- its notice under whatever the leaf was — and stay. What marks a draw's is the
-- `sourceMediaId` key: an image generation's error part always carries one
-- (null for a portrait), a chat or scheduled run's never does. One hung under a
-- portrait goes to that portrait's description, since the portrait goes too.
CREATE TEMP TABLE _failed AS
SELECT
	m.id,
	coalesce((SELECT p.reply_id FROM _portrait p WHERE p.id = m.parent_message_id), m.parent_message_id)
		AS reply_id
FROM messages m
JOIN messages r ON r.id = m.parent_message_id AND r.role = 'assistant'
WHERE m.role = 'assistant'
	AND json_valid(m.content_json)
	AND json_array_length(m.content_json) = 1
	AND json_extract(m.content_json, '$[0].type') = 'error'
	AND json_type(m.content_json, '$[0].sourceMediaId') IS NOT NULL;
--> statement-breakpoint
-- Each removed message, and the description it was drawn from.
CREATE TEMP TABLE _removed AS
SELECT id, reply_id AS target FROM _portrait
UNION ALL
SELECT id, reply_id FROM _failed;
--> statement-breakpoint
-- Each portrait image's message links as they stand, so its ref count can be
-- moved by however many links it gains or loses below. Not recounted from
-- scratch: the count also holds the avatar's own reference (`linkAvatarMedia`),
-- which most of these images carry.
CREATE TEMP TABLE _links_before AS
SELECT media_id, count(*) AS n
FROM message_media
WHERE media_id IN (SELECT media_id FROM _portrait)
GROUP BY media_id;
--> statement-breakpoint
-- Queued draws land on the description as portraits. A comparison's keep
-- comparing — one id per description — so they share a pick, and none takes
-- the face before it.
UPDATE generation_jobs
SET origin = 'portrait',
	fanout_index = NULL,
	params_json = CASE
		WHEN origin = 'avatar_fanout' AND json_valid(params_json)
			THEN json_set(params_json, '$.compareId', 'migrated-' || anchor_message_id)
		ELSE params_json
	END
WHERE origin IN ('avatar', 'avatar_fanout');
--> statement-breakpoint
INSERT INTO message_images (
	id, user_id, conversation_id, message_id, kind, marker_index, media_id,
	model_id, error, shown_at, comparison_id, created_at
)
SELECT
	p.id,
	c.user_id,
	p.conversation_id,
	p.reply_id,
	'portrait',
	NULL,
	p.media_id,
	COALESCE(p.model_used, ''),
	NULL,
	CASE WHEN p.media_id = c.avatar_media_id THEN p.created_at END,
	NULL,
	p.created_at
FROM _portrait p
JOIN conversations c ON c.id = p.conversation_id
WHERE p.media_id IN (SELECT id FROM media);
--> statement-breakpoint
-- A description whose portraits don't include the face shows its newest —
-- marked, so a comparison drawn on it later doesn't take the stage (and the
-- face) before a pick.
UPDATE message_images
SET shown_at = created_at
WHERE id IN (SELECT id FROM _portrait)
	AND NOT EXISTS (
		SELECT 1 FROM message_images o
		WHERE o.message_id = message_images.message_id
			AND o.kind = 'portrait'
			AND o.shown_at IS NOT NULL
	)
	AND id = (
		SELECT o.id FROM message_images o
		WHERE o.message_id = message_images.message_id
			AND o.kind = 'portrait'
		ORDER BY o.created_at DESC, o.id DESC
		LIMIT 1
	);
--> statement-breakpoint
INSERT OR IGNORE INTO message_media (message_id, media_id)
SELECT p.reply_id, p.media_id
FROM _portrait p
JOIN media md ON md.id = p.media_id
WHERE p.id IN (SELECT id FROM message_images) AND md.deleted_at IS NULL;
--> statement-breakpoint
UPDATE messages
SET parent_message_id = (SELECT r.target FROM _removed r WHERE r.id = messages.parent_message_id)
WHERE parent_message_id IN (SELECT id FROM _removed) AND id NOT IN (SELECT id FROM _removed);
--> statement-breakpoint
UPDATE messages
SET compaction_resume_from_message_id = (
	SELECT r.target FROM _removed r WHERE r.id = messages.compaction_resume_from_message_id
)
WHERE compaction_resume_from_message_id IN (SELECT id FROM _removed);
--> statement-breakpoint
-- A parked avatar comparison — the only kind parked on a reply rather than on
-- the user's message — is over.
UPDATE conversations
SET fanout_parent_message_id = NULL
WHERE fanout_parent_message_id IN (SELECT id FROM _removed)
	OR fanout_parent_message_id IN (SELECT id FROM messages WHERE role = 'assistant');
--> statement-breakpoint
UPDATE conversations
SET active_leaf_message_id = (
	SELECT r.target FROM _removed r WHERE r.id = conversations.active_leaf_message_id
)
WHERE active_leaf_message_id IN (SELECT id FROM _removed);
--> statement-breakpoint
DELETE FROM message_media WHERE message_id IN (SELECT id FROM _removed);
--> statement-breakpoint
DELETE FROM generation_jobs WHERE anchor_message_id IN (SELECT id FROM _removed);
--> statement-breakpoint
DELETE FROM check_ins WHERE source_message_id IN (SELECT id FROM _removed);
--> statement-breakpoint
DELETE FROM messages WHERE id IN (SELECT id FROM _removed);
--> statement-breakpoint
-- Each portrait's image moved from its message to the description: move its
-- ref count by the change in its links.
UPDATE media
SET ref_count = MAX(
		ref_count
			- COALESCE((SELECT b.n FROM _links_before b WHERE b.media_id = media.id), 0)
			+ (SELECT count(*) FROM message_media mm WHERE mm.media_id = media.id),
		0
	),
	unreferenced_since = CASE
		WHEN MAX(
			ref_count
				- COALESCE((SELECT b.n FROM _links_before b WHERE b.media_id = media.id), 0)
				+ (SELECT count(*) FROM message_media mm WHERE mm.media_id = media.id),
			0
		) > 0 THEN NULL
		ELSE COALESCE(unreferenced_since, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
	END
WHERE id IN (SELECT media_id FROM _portrait) AND deleted_at IS NULL;
--> statement-breakpoint
DROP TABLE _portrait;
--> statement-breakpoint
DROP TABLE _failed;
--> statement-breakpoint
DROP TABLE _removed;
--> statement-breakpoint
DROP TABLE _links_before;
