-- Seed `model_stats_daily` / `model_user_usage` from the history that still
-- exists, so the stats page doesn't open with every model looking unused.
--
-- USAGE ONLY. What can be counted reliably from surviving rows is that a model
-- was used: chat turns, tokens, generated media, favourites still standing, and
-- who used what last. Verdicts are deliberately NOT backfilled — a retry is
-- structurally indistinguishable from any other sibling, and a trashed media
-- row doesn't record whether the user deleted it or swept it up with a
-- conversation — and live rows are survivorship-biased besides: the rejected
-- branches are exactly the ones that were deleted. Those counters start at
-- zero on deploy. Undercounting is the expected direction: deleted
-- conversations and branches took their history with them.
--
-- Stored model ids are `endpoint::upstream`; rows whose id carries no `::`
-- (code-interpreter `run_python` outputs, uploads) name no model and are
-- skipped. Days are UTC, matching `statsDay()`.

-- A chat reply: an assistant row with a model, not a tool-loop step, not an
-- error sibling, and not a media generation's output (those carry a
-- message_media link to a generated row from the same model, and are counted
-- from `media` below). One per turn, counted on the turn's LAST row. A
-- 'tool_calls' row is usually an intermediate tool-loop step — its tool
-- results lead on to the next assistant row — but it ends the turn when
-- nothing follows them: a reply that also reacted with an emoji, a Stop during
-- tool execution, the loop's safety bound. (A turn halted for approval and
-- never resumed looks the same, and is counted too.)
INSERT INTO model_stats_daily (day, endpoint_id, model_id, metric, count, sum)
SELECT
	strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch'),
	substr(m.model_used, 1, instr(m.model_used, '::') - 1),
	substr(m.model_used, instr(m.model_used, '::') + 2),
	'turn',
	count(*),
	coalesce(sum(m.tokens_out), 0)
FROM messages m
WHERE m.role = 'assistant'
	AND instr(m.model_used, '::') > 1
	AND (
		coalesce(m.finish_reason, '') <> 'tool_calls'
		OR NOT EXISTS (
			SELECT 1 FROM messages t
			JOIN messages a
				ON a.conversation_id = t.conversation_id
				AND a.parent_message_id = t.id
				AND a.role = 'assistant'
			WHERE t.conversation_id = m.conversation_id
				AND t.parent_message_id = m.id
				AND t.role = 'tool'
		)
	)
	AND m.content_json NOT LIKE '%"type":"error"%'
	AND NOT EXISTS (
		SELECT 1 FROM message_media mm
		JOIN media md ON md.id = mm.media_id
		WHERE mm.message_id = m.id AND md.origin = 'generated' AND md.source_model = m.model_used
	)
GROUP BY 1, 2, 3;
--> statement-breakpoint
INSERT INTO model_stats_daily (day, endpoint_id, model_id, metric, count, sum)
SELECT
	strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch'),
	substr(m.model_used, 1, instr(m.model_used, '::') - 1),
	substr(m.model_used, instr(m.model_used, '::') + 2),
	metric.name,
	count(*),
	CASE metric.name WHEN 'speed_tokens' THEN sum(m.tokens_out) ELSE sum(m.gen_ms) END
FROM messages m
CROSS JOIN (SELECT 'speed_tokens' AS name UNION ALL SELECT 'speed_ms') metric
WHERE m.role = 'assistant'
	AND instr(m.model_used, '::') > 1
	AND m.tokens_out > 0
	AND m.gen_ms > 0
	AND m.content_json NOT LIKE '%"type":"error"%'
	AND NOT EXISTS (
		SELECT 1 FROM message_media mm
		JOIN media md ON md.id = mm.media_id
		WHERE mm.message_id = m.id AND md.origin = 'generated' AND md.source_model = m.model_used
	)
GROUP BY 1, 2, 3, 4;
--> statement-breakpoint
-- Every generated output, trashed or not: it was generated either way.
INSERT INTO model_stats_daily (day, endpoint_id, model_id, metric, count, sum)
SELECT
	strftime('%Y-%m-%d', created_at / 1000, 'unixepoch'),
	substr(source_model, 1, instr(source_model, '::') - 1),
	substr(source_model, instr(source_model, '::') + 2),
	'generated',
	count(*),
	0
FROM media
WHERE origin = 'generated' AND instr(source_model, '::') > 1
GROUP BY 1, 2, 3;
--> statement-breakpoint
-- Favourites still standing on live rows, on the day they were starred.
INSERT INTO model_stats_daily (day, endpoint_id, model_id, metric, count, sum)
SELECT
	strftime('%Y-%m-%d', favorited_at / 1000, 'unixepoch'),
	substr(source_model, 1, instr(source_model, '::') - 1),
	substr(source_model, instr(source_model, '::') + 2),
	'favorited',
	count(*),
	0
FROM media
WHERE origin = 'generated'
	AND instr(source_model, '::') > 1
	AND favorited_at IS NOT NULL
	AND deleted_at IS NULL
GROUP BY 1, 2, 3;
--> statement-breakpoint
-- Last use per (model, user), from replies and generations alike. The UNION
-- feeds one GROUP BY so a model used both ways gets its single latest stamp.
INSERT INTO model_user_usage (endpoint_id, model_id, user_id, last_used_at)
SELECT
	substr(model, 1, instr(model, '::') - 1),
	substr(model, instr(model, '::') + 2),
	user_id,
	max(at)
FROM (
	SELECT m.model_used AS model, c.user_id AS user_id, m.created_at AS at
	FROM messages m
	JOIN conversations c ON c.id = m.conversation_id
	WHERE m.role = 'assistant' AND instr(m.model_used, '::') > 1
	UNION ALL
	SELECT source_model, user_id, created_at
	FROM media
	WHERE origin = 'generated' AND instr(source_model, '::') > 1
)
GROUP BY 1, 2, 3;
