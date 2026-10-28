-- Texting photos move off the thread and onto the reply that sent them.
--
-- A developed photo used to be an assistant message of its own: an image part
-- stamped `photo: { sourceMessageId, index }`, hung under the reply (or under
-- the photo before it, in a chain). Re-developing made a sibling, a failed
-- attempt left an error-only message beside them, and a comparison parked the
-- thread on the anchor. Now each is a version in `message_images`, on the
-- reply, and the thread holds only the conversation.
--
-- For every photo message: a version on its reply (on show if it was on the
-- active branch), its image linked to the reply instead, anything below it
-- re-attached to the nearest message above that isn't a photo, and the
-- message itself deleted — with the failed draws beside it. Leaves, parked
-- comparisons and queued draws that pointed at a removed message are moved
-- or cleared. A no-op on a database with no photos.
CREATE TEMP TABLE _photo AS
SELECT
	m.id,
	m.conversation_id,
	m.parent_message_id AS parent_id,
	json_extract(m.content_json, '$[0].mediaId') AS media_id,
	json_extract(m.content_json, '$[0].photo.sourceMessageId') AS reply_id,
	json_extract(m.content_json, '$[0].photo.index') AS marker_index,
	m.model_used,
	m.created_at
FROM messages m
WHERE m.role = 'assistant'
	AND json_valid(m.content_json)
	AND json_extract(m.content_json, '$[0].type') = 'image'
	AND json_extract(m.content_json, '$[0].photo.sourceMessageId') IS NOT NULL;
--> statement-breakpoint
-- Failed draws beside the photos: under a photo, or under a message a photo
-- also hangs under.
CREATE TEMP TABLE _failed AS
SELECT m.id, m.parent_message_id AS parent_id
FROM messages m
WHERE m.role = 'assistant'
	AND json_valid(m.content_json)
	AND json_array_length(m.content_json) = 1
	AND json_extract(m.content_json, '$[0].type') = 'error'
	AND (
		m.parent_message_id IN (SELECT id FROM _photo)
		OR m.parent_message_id IN (SELECT parent_id FROM _photo)
	);
--> statement-breakpoint
-- Each removed message, and the nearest message above it that stays.
CREATE TEMP TABLE _removed AS
WITH RECURSIVE up(id, target) AS (
	SELECT id, parent_id FROM _photo
	UNION ALL
	SELECT up.id, p.parent_id FROM up JOIN _photo p ON p.id = up.target
)
SELECT id, target FROM up WHERE target IS NULL OR target NOT IN (SELECT id FROM _photo);
--> statement-breakpoint
INSERT INTO _removed (id, target)
SELECT f.id, COALESCE((SELECT r.target FROM _removed r WHERE r.id = f.parent_id), f.parent_id)
FROM _failed f;
--> statement-breakpoint
-- The photos on show: the ones on their conversation's active branch.
CREATE TEMP TABLE _shown AS
WITH RECURSIVE b(id, parent_id) AS (
	SELECT m.id, m.parent_message_id
	FROM conversations c
	JOIN messages m ON m.id = c.active_leaf_message_id
	WHERE c.id IN (SELECT conversation_id FROM _photo)
	UNION ALL
	SELECT m.id, m.parent_message_id FROM messages m JOIN b ON m.id = b.parent_id
)
SELECT id FROM b WHERE id IN (SELECT id FROM _photo);
--> statement-breakpoint
-- Each photo image's message links as they stand, so its ref count can be
-- moved by however many links it gains or loses below. Not recounted from
-- scratch: the count also holds references `message_media` doesn't, an
-- avatar's among them (`linkAvatarMedia`).
CREATE TEMP TABLE _links_before AS
SELECT media_id, count(*) AS n
FROM message_media
WHERE media_id IN (SELECT media_id FROM _photo)
GROUP BY media_id;
--> statement-breakpoint
-- Queued draws of a photo now land on its reply: a comparison's as plain photo
-- draws (each kept as a version), and every one anchored on the reply.
UPDATE generation_jobs
SET origin = 'photo',
	fanout_index = NULL,
	anchor_message_id = json_extract(params_json, '$.photo.sourceMessageId')
WHERE origin IN ('photo', 'avatar_fanout')
	AND json_valid(params_json)
	AND json_extract(params_json, '$.photo.sourceMessageId') IN (SELECT id FROM messages);
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
	'photo',
	p.marker_index,
	p.media_id,
	COALESCE(p.model_used, ''),
	NULL,
	CASE WHEN p.id IN (SELECT id FROM _shown) THEN p.created_at END,
	NULL,
	p.created_at
FROM _photo p
JOIN conversations c ON c.id = p.conversation_id
JOIN messages r ON r.id = p.reply_id AND r.conversation_id = p.conversation_id
WHERE p.media_id IN (SELECT id FROM media) AND p.marker_index IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO message_media (message_id, media_id)
SELECT p.reply_id, p.media_id
FROM _photo p
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
-- A photo comparison parked on its anchor is over: its candidates are versions.
UPDATE conversations
SET fanout_parent_message_id = NULL
WHERE fanout_parent_message_id IN (SELECT id FROM _removed)
	OR fanout_parent_message_id IN (SELECT parent_id FROM _photo);
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
-- Each photo's image moved from its message to the reply: move its ref count
-- by the change in its links.
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
WHERE id IN (SELECT media_id FROM _photo) AND deleted_at IS NULL;
--> statement-breakpoint
DROP TABLE _photo;
--> statement-breakpoint
DROP TABLE _failed;
--> statement-breakpoint
DROP TABLE _removed;
--> statement-breakpoint
DROP TABLE _shown;
--> statement-breakpoint
DROP TABLE _links_before;
