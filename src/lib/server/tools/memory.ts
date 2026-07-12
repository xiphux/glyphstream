/**
 * Memory tools — the model's write path for the persistent per-user
 * memory store, plus `recall_memory` for retrieval. The default read
 * path is implicit: every memory's content is inlined into the system
 * prompt via composeMemorySection so the model has the full index for
 * free. Once those bodies would exceed the budget the store is split into
 * tiers (see composeMemorySection's recallMode + selectMemoryTiers): the
 * highest-scored memories stay inlined in full, the rest become a compact
 * `[id] topic` index, and the model reaches an indexed body via
 * `recall_memory`: by id (pure SQLite, no embeddings) or by search query
 * (BM25 lexical, fused with embedding-cosine over the stored vectors only
 * when an `[embeddings]` model is configured). The split is budget-driven
 * and embeddings-independent; embeddings are a semantic enhancement to the
 * query path, not a prerequisite for recall.
 *
 * All three tools carry `category: 'personalization'`. The existing
 * per-conversation toggle that gates the persona prompt also seals
 * these — one switch closes every avenue that ships personal context
 * to the model. The filter happens at openaiToolDefinitions() time
 * (registry.ts), so when the toggle is off the model never sees these
 * tools advertised, can't "discover" them, and can't write.
 *
 * Wrong-id errors (foreign user's id, fabricated id, already-deleted
 * id) return `isError: true` rather than throwing — same recoverable
 * pattern as web_search's transport errors, so the model gets a tool
 * message it can apologize over instead of an aborted turn.
 */
import {
	createMemory,
	deleteMemory,
	listMemoriesWithEmbeddings,
	recordMemoryRecall,
	updateMemory,
	type MemoryWithEmbedding,
} from '../db/queries/memories';
import { bm25Rank, type ScoredChunk } from '../retrieval/bm25';
import { resolveRelevanceConfig } from '../retrieval/embeddings-config';
import { embedQuery, type RelevanceConfig } from '../retrieval/embed-rank';
import { fuseRankings } from '../retrieval/fusion';
import { cosineRank, decodeVector, type Vec } from '../retrieval/vector';
import {
	MEMORY_MAX_CONTENT_CHARS,
	MEMORY_MAX_TOPIC_CHARS,
	normalizeMemoryText,
} from '../memory/limits';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';

/** How many recalled memories to hand back to the model per query. */
const RECALL_TOP_K = 8;

/**
 * Shared parameter copy. Every tool definition is re-sent on every turn, so the
 * same sentence pasted into three tools is that sentence billed three times, for
 * the life of every conversation. Naming them once is both cheaper and the only
 * way they stay in sync.
 */
const CONTENT_PARAM_DESC = `Self-contained note — a sentence to a short paragraph, covering the fact and its useful nuance. Read in isolation, so it must not lean on surrounding context. Max ${MEMORY_MAX_CONTENT_CHARS} characters.`;

const ID_PARAM_DESC =
	'Memory id — the bracketed value shown beside the entry under "Saved memories".';

export const saveMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'save_memory',
			description:
				'Save a durable fact about the user, to persist across conversations. Use sparingly. Capture the texture around a fact, not the bare fact alone — a preference and the reason for it, working or communication style, standing context, durable stated interests. Good: "Prefers metric units, and is frustrated by imperial in technical docs — convert proactively." Not: anything tied to this one conversation, anything re-derivable from this thread, temporary state, or anything the user has not actually told you. Keep each memory to one coherent topic so it stays easy to update, and prefer updating an existing memory over saving a near-duplicate.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: CONTENT_PARAM_DESC },
					topic: {
						type: 'string',
						description: `Short label naming the subject — a few words, max ${MEMORY_MAX_TOPIC_CHARS} characters (e.g. "Dietary preferences", "Employer"). Used as the index entry when the store is too large to inline in full.`,
					},
				},
				required: ['content', 'topic'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Save memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseSaveArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const { id } = createMemory(ctx.userId, parsed.content, parsed.topic);
		return { content: JSON.stringify({ id, saved: true }) };
	},
};

export const updateMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'update_memory',
			description:
				'Correct or refine an existing memory in place. Prefer this over forget+save for edits — the memory keeps its id and the index ordering stays stable.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: ID_PARAM_DESC },
					content: { type: 'string', description: CONTENT_PARAM_DESC },
					topic: {
						type: 'string',
						description: `Short label naming the subject — a few words, max ${MEMORY_MAX_TOPIC_CHARS} characters. Re-supply it (adjusted if the edit changes the subject) so the index entry stays accurate.`,
					},
				},
				required: ['id', 'content', 'topic'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Update memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseUpdateArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const matched = updateMemory(ctx.userId, parsed.id, parsed.content, parsed.topic);
		if (!matched) return errorResult(`No memory with id "${parsed.id}".`);
		return { content: JSON.stringify({ id: parsed.id, updated: true }) };
	},
};

export const forgetMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'forget_memory',
			description:
				'Delete a saved memory by id. Use when the user retracts a fact, or when a memory has become wrong.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: ID_PARAM_DESC },
				},
				required: ['id'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Forget memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseIdArg(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const matched = deleteMemory(ctx.userId, parsed.id);
		if (!matched) return errorResult(`No memory with id "${parsed.id}".`);
		return { content: JSON.stringify({ id: parsed.id, forgotten: true }) };
	},
};

export const recallMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'recall_memory',
			// The system prompt's memory section already explains the inline/index
			// split to the model, in the same breath as showing it the index. Saying
			// it again here is the same explanation billed twice per turn.
			description:
				"Read saved memories that the system prompt shows only as an index entry, rather than in full. Expand specific entries by passing their ids, or search by meaning/keywords with `query`. Returns each match's full text, id, and topic.",
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							"Topic, question, or keywords describing the saved fact you need. Use when you don't already know which entries you want.",
					},
					ids: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Ids to expand in full, from the saved-memory index. Takes precedence over `query`.',
					},
				},
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Recall memory', icon: 'brain', category: 'personalization' },
	// Always advertised within the 'personalization' category (gated on the
	// per-conversation toggle via openaiToolDefinitions()). Not tied to
	// `[embeddings]`: the ids path is pure SQLite and the query path degrades to
	// BM25-only, so recall works without an embedding model — and the over-budget
	// index in the system prompt points the model here regardless.
	async execute(args, ctx): Promise<ToolExecution> {
		const parsed = parseRecallArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);

		const rows = listMemoriesWithEmbeddings(ctx.userId);
		if (rows.length === 0) return { content: JSON.stringify({ matches: [] }) };

		// ids path — return exactly the requested rows in full, no ranking. A
		// foreign or fabricated id simply isn't in `rows` (query is user-scoped).
		if ('ids' in parsed) {
			const wanted = new Set(parsed.ids);
			return finishRecall(
				ctx.userId,
				rows.filter((r) => wanted.has(r.id)),
			);
		}

		// Lexical leg — always, over ALL rows so a freshly-saved memory the
		// backfill worker hasn't embedded yet is still findable. Needs no vectors.
		//
		// Only POSITIVE-score entries are real lexical matches. `bm25Rank` returns
		// every doc — zero-score ones in index order — so feeding the raw ranking to
		// the fusion hands RRF a full lexical "opinion" that is really just creation
		// order, and it can outweigh a genuine semantic win. Concretely: ask
		// "what do I like to eat" with no literal term overlap, and the lexical leg
		// ranks the OLDEST memory first purely because it was saved first, which is
		// enough to cancel the dense leg's correct answer. (BM25's non-negative IDF
		// means even a ubiquitous term scores slightly above zero, so `> 0` is a
		// clean "has any lexical signal at all" test.)
		//
		// Same reasoning, and the same fix, as `retrieval/tool-search.ts` — this path
		// simply never got it.
		const rankings: ScoredChunk[][] = [
			bm25Rank(
				parsed.query,
				rows.map((r) => r.content),
			).filter((sc) => sc.score > 0),
		];
		// Dense leg — only when an embedding model is configured. Embeds the query
		// and cosines against the matching-model vectors; any failure (or no model)
		// degrades to BM25 alone, never errors the turn.
		const cfg = resolveRelevanceConfig();
		if (cfg) {
			const dense = await denseRank(parsed.query, rows, cfg, ctx.signal);
			if (dense) rankings.push(dense);
		}

		const fused = fuseRankings(rankings).slice(0, RECALL_TOP_K);
		return finishRecall(
			ctx.userId,
			fused.map((sc) => rows[sc.index]),
		);
	},
};

/**
 * Shape a set of resolved memory rows into the recall tool result and record the
 * hit. Both recall paths (ids and query) funnel through here so the
 * recall-frequency signal (`recordMemoryRecall`) is captured identically. Emits
 * id + topic + content — the topic lets the model correlate a result back to the
 * index line it expanded.
 *
 * The frequency bump is a non-essential side effect (phase-2 telemetry), so a
 * failing UPDATE must never sink the successful read the model actually asked
 * for — catch and log, mirroring the dense leg's "degrade, never error the turn"
 * stance rather than the write tools' (where the write IS the point).
 */
function finishRecall(userId: string, rows: MemoryWithEmbedding[]): ToolExecution {
	const matches = rows.map((r) => ({ id: r.id, topic: r.topic ?? null, content: r.content }));
	try {
		recordMemoryRecall(
			userId,
			matches.map((m) => m.id),
		);
	} catch (e) {
		console.warn('[memory] recording recall frequency failed (returning matches anyway):', e);
	}
	return { content: JSON.stringify({ matches }) };
}

/**
 * Rank memory rows by cosine of the query embedding against each row's stored
 * vector. Only rows whose `embeddingModel` matches the configured model are
 * comparable (different models → different vector spaces/dims). Returns
 * ScoredChunk indices in the full `rows` index space, or null on any failure so
 * the caller keeps the BM25 ranking.
 */
async function denseRank(
	query: string,
	rows: MemoryWithEmbedding[],
	cfg: RelevanceConfig,
	signal: AbortSignal,
): Promise<ScoredChunk[] | null> {
	try {
		const embedded = rows
			.map((r, index) => ({ index, row: r }))
			.filter((x) => x.row.embedding && x.row.embeddingModel === cfg.modelId);
		if (embedded.length === 0) return null;

		// Shared query-embed plumbing (prefix + truncation + timeout/abort), so the
		// recall query is capped exactly as the backfill capped the stored vectors.
		const qvec = await embedQuery(query, cfg, signal);
		if (!qvec) return null;

		const vecs = embedded.map((x) => decodeVector(x.row.embedding as Buffer) as Vec);
		// cosineRank indices are local to `embedded`; map them back to `rows`.
		return cosineRank(qvec, vecs).map((sc) => ({
			index: embedded[sc.index].index,
			score: sc.score,
		}));
	} catch (e) {
		console.warn('[memory] recall dense leg failed, falling back to BM25:', e);
		return null;
	}
}

/**
 * Recall accepts either `ids` (read specific entries) or `query` (search).
 * `ids` wins when both are present. Returns a discriminated union so the handler
 * can branch on `'ids' in parsed`.
 */
function parseRecallArgs(args: unknown): { ids: string[] } | { query: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `query` or `ids` field.' };
	}
	const a = args as { query?: unknown; ids?: unknown };
	if (a.ids !== undefined) {
		if (!Array.isArray(a.ids) || a.ids.some((x) => typeof x !== 'string')) {
			return { error: '`ids` must be an array of memory id strings.' };
		}
		const ids = (a.ids as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
		if (ids.length === 0) return { error: '`ids` must contain at least one memory id.' };
		return { ids };
	}
	if (typeof a.query !== 'string' || a.query.trim().length === 0) {
		return { error: 'Provide either `ids` (specific entries to read) or a non-empty `query`.' };
	}
	return { query: a.query.trim() };
}

function parseContentArg(args: unknown): { content: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `content` field.' };
	}
	const a = args as { content?: unknown };
	if (typeof a.content !== 'string') {
		return { error: 'Missing or non-string `content` argument.' };
	}
	// Normalize to the stored single-line form before the length check so the cap
	// counts real chars (shared with the dreaming pass — see normalizeMemoryText).
	const trimmed = normalizeMemoryText(a.content);
	if (trimmed.length === 0) return { error: '`content` must be non-empty.' };
	if (trimmed.length > MEMORY_MAX_CONTENT_CHARS) {
		return {
			error: `\`content\` exceeds ${MEMORY_MAX_CONTENT_CHARS} characters — keep each memory to a single focused fact or theme.`,
		};
	}
	return { content: trimmed };
}

function parseTopicArg(args: unknown): { topic: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `topic` field.' };
	}
	const a = args as { topic?: unknown };
	if (typeof a.topic !== 'string') {
		return { error: 'Missing or non-string `topic` argument.' };
	}
	const trimmed = normalizeMemoryText(a.topic);
	if (trimmed.length === 0) return { error: '`topic` must be non-empty.' };
	if (trimmed.length > MEMORY_MAX_TOPIC_CHARS) {
		return {
			error: `\`topic\` exceeds ${MEMORY_MAX_TOPIC_CHARS} characters — keep it to a few words.`,
		};
	}
	return { topic: trimmed };
}

function parseIdArg(args: unknown): { id: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with an `id` field.' };
	}
	const a = args as { id?: unknown };
	if (typeof a.id !== 'string' || a.id.length === 0) {
		return { error: 'Missing or empty `id` argument.' };
	}
	return { id: a.id };
}

function parseSaveArgs(args: unknown): { content: string; topic: string } | { error: string } {
	const contentResult = parseContentArg(args);
	if ('error' in contentResult) return contentResult;
	const topicResult = parseTopicArg(args);
	if ('error' in topicResult) return topicResult;
	return { content: contentResult.content, topic: topicResult.topic };
}

function parseUpdateArgs(
	args: unknown,
): { id: string; content: string; topic: string } | { error: string } {
	const idResult = parseIdArg(args);
	if ('error' in idResult) return idResult;
	const rest = parseSaveArgs(args);
	if ('error' in rest) return rest;
	return { id: idResult.id, content: rest.content, topic: rest.topic };
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

register(saveMemoryTool);
register(updateMemoryTool);
register(forgetMemoryTool);
register(recallMemoryTool);
