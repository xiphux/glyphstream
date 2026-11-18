/**
 * Full-text search across a user's conversations. Hits the `search_index`
 * FTS5 virtual table (see migration 0010) maintained by triggers on
 * `messages.content_json` and `conversations.title`.
 *
 * Results are one row per conversation (a chat with many
 * matching messages surfaces once with its best-ranked snippet), ranked
 * by FTS5 `bm25`, and capped at the per-call `limit` — 30 by default.
 * No pagination for v1: refine the query if the top 30 isn't enough.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../client';
import type { SearchResult } from '#lib/types/api.js';
export type { SearchResult };

interface SearchOptions {
	/** Hard cap on returned rows. Default 30, max 100. */
	limit?: number;
	/** Optional freshness floor: only conversations whose `updated_at` is at or
	 *  after this epoch-ms cutoff. Omitted by the sidebar (no time filter); set by
	 *  the `search_conversations` agent tool's `time_range` param. */
	since?: number;
	/** Content seal for the model-facing tool path: when true, omit rows from
	 *  conversations marked `private`. Set by the `search_conversations` tool so a
	 *  private chat's content never surfaces to the model in another conversation.
	 *  Left false (default) by the sidebar — the user still finds private chats in
	 *  their own history search. */
	excludePrivate?: boolean;
	/** Leave this conversation out before the limit is applied: the tool's
	 *  own conversation, which the model already has. */
	excludeConversationId?: string;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
/** Rowids per user in `search_index`: user `ord` owns `[ord * USER_RANGE, (ord + 1) * USER_RANGE)`. */
const USER_RANGE = 2n ** 32n;

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

/**
 * Owner-scoped FTS over the user's messages/titles/summaries. Serves BOTH the
 * sidebar (the user searching their own history — always allowed) and the
 * `search_conversations` model tool. It intentionally does NOT filter by the
 * per-conversation `personalization` opt-out: that's a consumption gate on the
 * *reading* conversation (the tool is category-gated out of a personalization-off
 * chat), not a seal on the *source*. The "Private chat" content seal IS a
 * source-side seal, but it's applied on the *tool* path only via `excludePrivate`
 * — never here globally, or it would also hide private chats from the user's own
 * sidebar search, which should always show them all their history.
 */
export function searchConversations(
	userId: string,
	rawQuery: string,
	opts: SearchOptions = {},
): SearchResult[] {
	const match = buildFtsQuery(rawQuery);
	if (!match) return [];

	const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
	// Each filters the JOINed conversation row, not the FTS MATCH, and is appended
	// only when set, so the sidebar's unfiltered search is byte-for-byte unchanged.
	const sinceClause = opts.since != null ? sql`AND c.updated_at >= ${opts.since}` : sql``;
	const privateClause = opts.excludePrivate ? sql`AND c.private = 0` : sql``;
	const excludeClause =
		opts.excludeConversationId != null
			? sql`AND s.conversation_id != ${opts.excludeConversationId}`
			: sql``;

	// Two steps, because the limit is on conversations, not rows: ranking rows
	// and then collapsing them let one long thread that mentions the term in
	// every message fill the whole budget and hide every other match.
	//
	// Step 1 picks each conversation's best row: with MIN() as the only
	// aggregate, SQLite takes the bare `s.rowid` from the row that achieved it.
	// `rank` rather than `bm25(search_index)`, which can't be aggregated. Step 2
	// asks for snippet() on just those rows — the auxiliary functions only work
	// in the SELECT that runs the MATCH, so they can't be grouped either.
	//
	// The rowid range is what scopes the MATCH to the user: each user's rows
	// live in their own range (see migration *_search_index_user_ranges), which
	// FTS5 seeks to instead of producing every user's matches. `c.user_id` is
	// the ownership check proper; it costs nothing, as the join reads that row
	// anyway.
	//
	// Drizzle doesn't model FTS5 virtual tables, so both are raw SQL. Every value
	// is bound.
	const db = getDb();
	const owner = db.get<{ ord: number }>(
		sql`SELECT ord FROM search_index_owner WHERE user_id = ${userId}`,
	);
	if (!owner) return [];
	// BigInt here and in the second step's `rowid IN (…)`, because node:sqlite
	// binds every JS number as REAL, and FTS5 only applies an INTEGER rowid
	// bound: a REAL one is left to SQLite to filter after FTS5 has produced
	// every user's rows.
	const lo = BigInt(owner.ord) * USER_RANGE;
	const hi = lo + USER_RANGE - 1n;
	const best = db.all<{ rid: number; conversation_id: string; updated_at: number }>(sql`
		SELECT s.rowid AS rid, s.conversation_id, MIN(s.rank) AS best, c.updated_at
		FROM search_index s
		JOIN conversations c ON c.id = s.conversation_id
		WHERE search_index MATCH ${match}
			AND s.rowid BETWEEN ${lo} AND ${hi}
			AND c.user_id = ${userId}
			${sinceClause} ${privateClause} ${excludeClause}
		GROUP BY s.conversation_id
		ORDER BY best ASC, c.updated_at DESC
		LIMIT ${limit}
	`);
	if (best.length === 0) return [];

	const rows = db.all<{
		rid: number;
		conversation_id: string;
		conversation_title: string | null;
		conversation_summary: string | null;
		updated_at: number;
		kind: 'message' | 'title' | 'summary';
		message_id: string | null;
		snippet: string;
	}>(sql`
		SELECT
			s.rowid AS rid,
			s.conversation_id,
			s.message_id,
			s.kind,
			snippet(search_index, 0, ${MARK_OPEN}, ${MARK_CLOSE}, '…', 32) AS snippet,
			c.title AS conversation_title,
			c.summary AS conversation_summary,
			c.updated_at
		FROM search_index s
		JOIN conversations c ON c.id = s.conversation_id
		WHERE search_index MATCH ${match} AND s.rowid IN (${sql.join(
			best.map((b) => sql`${BigInt(b.rid)}`),
			sql`, `,
		)})
	`);
	const byRowid = new Map(rows.map((r) => [r.rid, r]));

	const out: SearchResult[] = [];
	for (const { rid } of best) {
		const r = byRowid.get(rid);
		if (!r) continue;
		out.push({
			conversationId: r.conversation_id,
			conversationTitle: r.conversation_title,
			updatedAt: r.updated_at,
			kind: r.kind,
			messageId: r.message_id,
			snippet: safeSnippet(r.snippet),
			summary: r.conversation_summary,
		});
	}
	return out;
}
