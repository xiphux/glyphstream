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

export const saveMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'save_memory',
			description:
				'Save a durable fact about the user that should persist across conversations. Use sparingly. Capture the useful texture around a fact, not just the bare fact — a preference and the reasoning behind it, working or communication style, standing context, durable interests or opinions the user has stated as their own. Good: "Prefers metric units, and gets frustrated when technical docs use imperial — worth converting proactively in engineering contexts"; "Backend engineer at Acme; works mostly in Go and dislikes heavy frameworks". Bad: anything tied to a single conversation, anything re-derivable from earlier in this thread, temporary state ("is currently debugging X"), or things the user has not actually told you. Write each memory as a self-contained note — a sentence up to a short paragraph — that reads correctly in isolation, with no surrounding context, and keep it to a single coherent topic so it stays easy to update. Prefer updating an existing memory over saving a near-duplicate.',
			parameters: {
				type: 'object',
				properties: {
					content: {
						type: 'string',
						description: `The memory text — a self-contained note, a sentence up to a short paragraph, capturing the fact and any useful nuance. It is read in isolation, so don't rely on surrounding context. At most ${MEMORY_MAX_CONTENT_CHARS} characters.`,
					},
					topic: {
						type: 'string',
						description: `A short label naming what this memory is about — a few words, at most ${MEMORY_MAX_TOPIC_CHARS} characters (e.g. "Dietary preferences", "Employer", "Kids' names"). Shown as the index entry when the store is too large to inline in full.`,
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
				'Replace the content of an existing memory in place when a stored fact needs to be corrected or refined. Prefer this over forget+save for edits — the memory keeps its id and the index ordering stays stable.',
			parameters: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description:
							'The id of the memory to update — the bracketed value shown next to the entry in "Saved memories".',
					},
					content: {
						type: 'string',
						description: `The new memory text — a self-contained note, a sentence up to a short paragraph, capturing the fact and any useful nuance. It is read in isolation, so don't rely on surrounding context. At most ${MEMORY_MAX_CONTENT_CHARS} characters.`,
					},
					topic: {
						type: 'string',
						description: `A short label naming what this memory is about — a few words, at most ${MEMORY_MAX_TOPIC_CHARS} characters. Re-supply it (adjusted if the edit changes the subject) so the index entry stays accurate.`,
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
				'Delete a saved memory by id. Use when the user explicitly retracts a fact, or when a memory has become wrong. The id is the bracketed value shown next to each entry in "Saved memories".',
			parameters: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description:
							'The id of the memory to forget — the bracketed value shown next to the entry in "Saved memories".',
					},
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
			description:
				"Read the user's saved memories (durable facts about them, carried across conversations) that aren't fully shown in the system prompt. When the store is large, only the highest-scored memories are shown in full; the rest appear as a `[id] topic` index — pass the ids of relevant-looking indexed entries in `ids` to read their full text, or pass a `query` to search by meaning/keywords. Returns matching memories, each with its id (pass it to update_memory or forget_memory) and topic.",
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							"What to look for — a topic, question, or keywords describing the kind of saved fact you need. Use when you don't already know which entries you want.",
					},
					ids: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Specific memory ids to read in full — the bracketed values from the saved-memory index. Use this to expand entries whose topic looks relevant. Takes precedence over `query`.',
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
		const rankings: ScoredChunk[][] = [
			bm25Rank(
				parsed.query,
				rows.map((r) => r.content),
			),
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
