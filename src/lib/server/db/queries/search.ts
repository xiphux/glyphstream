/**
 * Full-text search across a user's conversations. Hits the `search_index`
 * FTS5 virtual table (see migration 0010) maintained by triggers on
 * `messages.content_json` and `conversations.title`.
 *
 * Results are deduplicated to one row per conversation (a chat with many
 * matching messages surfaces once with its best-ranked snippet), ranked
 * by FTS5 `bm25`, and capped at the per-call `limit` — 30 by default.
 * No pagination for v1: refine the query if the top 30 isn't enough.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../client';

export interface SearchResult {
	conversationId: string;
	conversationTitle: string | null;
	updatedAt: number;
	/** `'message'` for body hits (with `messageId` set), `'title'` for title hits. */
	kind: 'message' | 'title';
	/** NULL for title hits — the row identifies the whole conversation, not a specific message. */
	messageId: string | null;
	/** FTS5 snippet with `<mark>...</mark>` wrapping the matched tokens. */
	snippet: string;
}

interface SearchOptions {
	/** Hard cap on returned rows. Default 30, max 100. */
	limit?: number;
	/** Optional freshness floor: only conversations whose `updated_at` is at or
	 *  after this epoch-ms cutoff. Omitted by the sidebar (no time filter); set by
	 *  the `search_conversations` agent tool's `time_range` param. */
	since?: number;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * Pure: convert a user-typed query string into FTS5 MATCH syntax that
 * can't accidentally hit a reserved operator or unbalanced quote.
 * Each whitespace-separated token becomes a quoted phrase (with internal
 * quotes escaped via FTS5's `""` doubling convention), tokens are AND-
 * joined (FTS5 default). Returns null when the input has no usable
 * tokens — the caller short-circuits with an empty result.
 *
 * Why phrase-quoting every token rather than stripping punctuation: FTS5
 * phrase syntax treats everything inside `"…"` as a literal sequence
 * passed to the tokenizer, so reserved chars (`*`, `(`, `^`, `:`, etc.)
 * are neutralized as a side effect — no per-char allowlist to maintain.
 */
export function buildFtsQuery(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// FTS5's snippet() doesn't HTML-escape the surrounding user text — we
// ask it for non-printing control characters as the highlight bracket
// (SOH  and STX , which can't appear in normal chat
// content) and then escape the whole snippet on the JS side before
// substituting real <mark> tags. Saves the client from having to do
// the escape itself with `{@html}`.
const MARK_OPEN = '';
const MARK_CLOSE = '';

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function safeSnippet(raw: string): string {
	return escapeHtml(raw)
		.replace(new RegExp(MARK_OPEN, 'g'), '<mark>')
		.replace(new RegExp(MARK_CLOSE, 'g'), '</mark>');
}

export function searchConversations(
	userId: string,
	rawQuery: string,
	opts: SearchOptions = {},
): SearchResult[] {
	const match = buildFtsQuery(rawQuery);
	if (!match) return [];

	const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
	// Optional freshness floor. A separate bound because it filters the JOINed
	// conversation row (c.updated_at), not the FTS MATCH — appended to the WHERE
	// below only when set, so the sidebar's unfiltered search is byte-for-byte
	// unchanged.
	const sinceClause = opts.since != null ? sql`AND c.updated_at >= ${opts.since}` : sql``;

	// One pass through the FTS table; snippet() and bm25() must be
	// invoked in the same SELECT as the MATCH (FTS5's auxiliary functions
	// don't survive being wrapped in a window function or CTE that
	// disrupts the aux context — `unable to use function snippet in the
	// requested context`). So we over-fetch — limit*3 rows ranked by
	// bm25 — and dedupe to one row per conversation on the application
	// side. At the v1 cap (30 × 3 = 90) and solo-user scale this is
	// cheaper than a second query.
	//
	// Drizzle doesn't model FTS5 virtual tables, so the whole statement
	// is one raw SQL call. Parameters are bound — userId, match, and
	// limit can't be SQL-injected.
	const db = getDb();
	const rows = db.all<{
		conversation_id: string;
		conversation_title: string | null;
		updated_at: number;
		kind: 'message' | 'title';
		message_id: string | null;
		snippet: string;
	}>(sql`
		SELECT
			s.conversation_id,
			s.message_id,
			s.kind,
			snippet(search_index, 0, ${MARK_OPEN}, ${MARK_CLOSE}, '…', 32) AS snippet,
			c.title AS conversation_title,
			c.updated_at
		FROM search_index s
		JOIN conversations c ON c.id = s.conversation_id
		WHERE s.user_id = ${userId} AND search_index MATCH ${match} ${sinceClause}
		ORDER BY bm25(search_index) ASC, c.updated_at DESC
		LIMIT ${limit * 3}
	`);

	const seen = new Set<string>();
	const out: SearchResult[] = [];
	for (const r of rows) {
		if (seen.has(r.conversation_id)) continue;
		seen.add(r.conversation_id);
		out.push({
			conversationId: r.conversation_id,
			conversationTitle: r.conversation_title,
			updatedAt: r.updated_at,
			kind: r.kind,
			messageId: r.message_id,
			snippet: safeSnippet(r.snippet),
		});
		if (out.length >= limit) break;
	}
	return out;
}
