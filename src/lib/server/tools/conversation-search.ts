/**
 * `search_conversations` — the model's read path into the user's PAST
 * conversations. Where `recall_memory` reads the curated, model-authored store of
 * durable facts, this searches full-fidelity raw message history: the same
 * owner-scoped FTS5 index the sidebar search uses (`searchConversations`), kept
 * live by triggers so a conversation is findable seconds after it happens.
 *
 * `category: 'personalization'` — the same per-conversation toggle that seals the
 * persona prompt + memory tools also seals this: past-conversation content is
 * personal context, so one switch closes every avenue that ships it to the model.
 * Always advertised within the category (no config to gate on, like
 * `recall_memory`); the registry-level category filter does the gating. Passes
 * `excludePrivate: true` so a "Private chat"'s raw messages are never returned to
 * the model here (the source-side content seal, paired with the summary gate).
 *
 * Bad-args return `isError: true` (recoverable) rather than throwing — same
 * pattern as the other tools. An empty query or zero matches is NOT an error: it
 * returns `{ results: [] }` so the model learns nothing was found.
 */
import { searchConversations } from '../db/queries/search';
import { getMessage } from '../db/queries/messages';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';

/** How much of a matched message to hand back per result. Long messages get a
 *  match-centered window (see excerptAround) so the hit is always visible. */
const TEXT_CAP = 800;
const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 25;

/** Freshness windows for the optional `time_range` param, in ms. */
const TIME_RANGES = ['day', 'week', 'month', 'year'] as const;
type TimeRange = (typeof TIME_RANGES)[number];
const RANGE_MS: Record<TimeRange, number> = {
	day: 24 * 60 * 60 * 1000,
	week: 7 * 24 * 60 * 60 * 1000,
	month: 30 * 24 * 60 * 60 * 1000,
	year: 365 * 24 * 60 * 60 * 1000,
};

/** Pure: a `time_range` enum → the `since` epoch-ms cutoff. `now` injected so the
 *  mapping is unit-testable. */
export function timeRangeToCutoff(range: TimeRange, now: number): number {
	return now - RANGE_MS[range];
}

export const searchConversationsTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'search_conversations',
			description:
				'Search this user\'s PAST conversations with you (full message history across all their threads) for something discussed before. Use when the user refers to earlier context you don\'t have in the current thread — "like we discussed", "the project I mentioned", "what did we decide about X" — instead of guessing. Returns {query, results} where each result is {conversationId, title, updatedAt, summary, text} — `summary` is a short gist of the whole conversation (may be null) and `text` is the matching message (or a match-centered excerpt of a long one). Distinct from recall_memory: that reads curated durable facts about the user; this searches raw conversation history. The current conversation is excluded (you already have it).',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'Search keywords — plain natural-language words to match in past messages.',
					},
					time_range: {
						type: 'string',
						enum: [...TIME_RANGES],
						description:
							'Optional recency filter — restrict to conversations last active within the past day/week/month/year. Use for time-scoped references ("last week", "recently").',
					},
					max_results: {
						type: 'integer',
						description: `How many conversations to return (1-${MAX_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS}).`,
						minimum: 1,
						maximum: MAX_MAX_RESULTS,
					},
				},
				required: ['query'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Search conversations', icon: 'search', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const { query, timeRange, maxResults } = parsed;

		const since = timeRange ? timeRangeToCutoff(timeRange, Date.now()) : undefined;
		// Over-fetch by one so excluding the current conversation can't shrink a full
		// page below the cap when the current chat happens to match.
		// `excludePrivate` is the content seal: a private chat's raw messages must
		// never surface to the model here, even from a personalization-on chat.
		const hits = searchConversations(ctx.userId, query, {
			since,
			limit: maxResults + 1,
			excludePrivate: true,
		});

		const tokens = query
			.trim()
			.split(/\s+/)
			.filter((t) => t.length > 0);
		const results = hits
			.filter((h) => h.conversationId !== ctx.conversationId)
			.slice(0, maxResults)
			.map((h) => ({
				conversationId: h.conversationId,
				title: h.conversationTitle,
				updatedAt: h.updatedAt,
				// The background-generated gist of the whole conversation (may be null
				// until the summary pass has run), so the model sees what it was about
				// alongside the specific matched excerpt.
				summary: h.summary,
				// Title/summary-only hits carry no message body — the title/summary IS
				// the content.
				text: h.messageId
					? excerptAround(messageText(h.conversationId, h.messageId), tokens)
					: null,
			}));

		return { content: JSON.stringify({ query, results }) };
	},
};

/** Join a message's `text` parts into one string; '' if the message is gone or
 *  carries only non-text parts (e.g. an image-only turn). */
function messageText(conversationId: string, messageId: string): string {
	const msg = getMessage(conversationId, messageId);
	if (!msg) return '';
	return msg.parts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('\n')
		.trim();
}

/**
 * Cap a matched message for the model. Short messages return whole; a long one
 * returns a `cap`-sized window centered on the earliest matching query token (so
 * the hit is visible even deep in a long message), elided with `…`. Falls back to
 * the head when no token is found (e.g. an FTS stemmed/near match).
 */
export function excerptAround(text: string, tokens: string[], cap = TEXT_CAP): string {
	if (text.length <= cap) return text;
	const lower = text.toLowerCase();
	let pos = -1;
	for (const t of tokens) {
		const i = lower.indexOf(t.toLowerCase());
		if (i >= 0 && (pos === -1 || i < pos)) pos = i;
	}
	if (pos === -1) return text.slice(0, cap).trimEnd() + '…';
	let start = Math.max(0, pos - Math.floor(cap / 2));
	const end = Math.min(text.length, start + cap);
	start = Math.max(0, end - cap); // pull the window back if we hit the tail
	return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

interface ParsedArgs {
	query: string;
	timeRange?: TimeRange;
	maxResults: number;
}

function parseArgs(args: unknown): ParsedArgs | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `query` field.' };
	}
	const a = args as { query?: unknown; time_range?: unknown; max_results?: unknown };

	// A missing/non-string query is a malformed call (error). An empty or
	// whitespace-only string is allowed — it falls through to a no-match
	// `{ results: [] }` (buildFtsQuery yields null → searchConversations returns
	// []), which reads as "nothing found" rather than an error the model must
	// apologize over.
	if (typeof a.query !== 'string') {
		return { error: 'Missing or non-string `query` argument.' };
	}

	let timeRange: TimeRange | undefined;
	if (a.time_range !== undefined) {
		if (typeof a.time_range !== 'string' || !TIME_RANGES.includes(a.time_range as TimeRange)) {
			return { error: `\`time_range\` must be one of: ${TIME_RANGES.join(', ')}.` };
		}
		timeRange = a.time_range as TimeRange;
	}

	let maxResults = DEFAULT_MAX_RESULTS;
	if (a.max_results !== undefined) {
		if (typeof a.max_results !== 'number' || !Number.isInteger(a.max_results)) {
			return { error: '`max_results` must be an integer.' };
		}
		maxResults = Math.min(Math.max(1, a.max_results), MAX_MAX_RESULTS);
	}

	return { query: a.query.trim(), timeRange, maxResults };
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

register(searchConversationsTool);
