/**
 * Memory tools — the model's write path for the persistent per-user
 * memory store, plus `recall_memory` for retrieval. The default read
 * path is implicit: every memory's content is inlined into the system
 * prompt via composeMemorySection so the model has the full index for
 * free. Once that index would exceed the budget AND an embedding model
 * is configured, the inlined bodies are swapped for a one-liner (see
 * composeMemorySection's recallMode) and the model reaches them via
 * `recall_memory` — hybrid BM25 + embedding-cosine over the stored
 * vectors (populated by the backfill worker in ../memory/).
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
	updateMemory,
	type MemoryWithEmbedding,
} from '../db/queries/memories';
import { bm25Rank, type ScoredChunk } from '../retrieval/bm25';
import { resolveRelevanceConfig } from '../retrieval/embeddings-config';
import { embedQuery, type RelevanceConfig } from '../retrieval/embed-rank';
import { fuseRankings } from '../retrieval/fusion';
import { cosineRank, decodeVector, type Vec } from '../retrieval/vector';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';

const MAX_CONTENT_CHARS = 500;

/** How many recalled memories to hand back to the model per query. */
const RECALL_TOP_K = 8;

export const saveMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'save_memory',
			description:
				'Save a standing fact about the user that should persist across conversations. Use sparingly. Good: stable preferences ("prefers metric units"), persistent identity ("works as a backend engineer at Acme"), durable interests, opinions the user has stated as their own. Bad: anything tied to a single conversation, anything re-derivable from earlier in this thread, temporary state ("is currently debugging X"), or things the user has not actually told you. Keep each memory one self-contained sentence — it is read in isolation, with no surrounding context. Prefer updating an existing memory over saving a near-duplicate.',
			parameters: {
				type: 'object',
				properties: {
					content: {
						type: 'string',
						description: `The memory text. One self-contained sentence, at most ${MAX_CONTENT_CHARS} characters.`,
					},
				},
				required: ['content'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Save memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseContentArg(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const { id } = createMemory(ctx.userId, parsed.content);
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
						description: `The new memory text. One self-contained sentence, at most ${MAX_CONTENT_CHARS} characters.`,
					},
				},
				required: ['id', 'content'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Update memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseIdAndContentArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const matched = updateMemory(ctx.userId, parsed.id, parsed.content);
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
				"Search the user's saved memories (durable facts about them, carried across conversations) for the ones relevant to the current topic. Use this when the full memory index is not already shown in the system prompt and a stored preference, fact, or detail about the user would help answer well. Returns the most relevant memories, each prefixed with its id in square brackets — pass that id to update_memory or forget_memory.",
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'What to look for — a topic, question, or keywords describing the kind of saved fact you need.',
					},
				},
				required: ['query'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Recall memory', icon: 'brain', category: 'personalization' },
	// Advertised only when an embedding model is configured (the same `[embeddings]`
	// signal fetch_url uses). The 'personalization' category gates it on the
	// per-conversation toggle via openaiToolDefinitions().
	isAvailable: () => resolveRelevanceConfig() !== undefined,
	async execute(args, ctx): Promise<ToolExecution> {
		const parsed = parseQueryArg(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const cfg = resolveRelevanceConfig();
		if (!cfg)
			return errorResult('Memory recall is unavailable — no embedding model is configured.');

		const rows = listMemoriesWithEmbeddings(ctx.userId);
		if (rows.length === 0) return { content: JSON.stringify({ matches: [] }) };

		// Lexical leg — always, over ALL rows so a freshly-saved memory the
		// backfill worker hasn't embedded yet is still findable.
		const rankings: ScoredChunk[][] = [
			bm25Rank(
				parsed.query,
				rows.map((r) => r.content),
			),
		];
		// Dense leg — embed the query and cosine against the matching-model
		// vectors. Any failure degrades to BM25 alone (never errors the turn).
		const dense = await denseRank(parsed.query, rows, cfg, ctx.signal);
		if (dense) rankings.push(dense);

		const fused = fuseRankings(rankings).slice(0, RECALL_TOP_K);
		const matches = fused.map((sc) => ({ id: rows[sc.index].id, content: rows[sc.index].content }));
		return { content: JSON.stringify({ matches }) };
	},
};

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

function parseQueryArg(args: unknown): { query: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `query` field.' };
	}
	const a = args as { query?: unknown };
	if (typeof a.query !== 'string' || a.query.trim().length === 0) {
		return { error: 'Missing or empty `query` argument.' };
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
	const trimmed = a.content.trim();
	if (trimmed.length === 0) return { error: '`content` must be non-empty.' };
	if (trimmed.length > MAX_CONTENT_CHARS) {
		return {
			error: `\`content\` exceeds ${MAX_CONTENT_CHARS} characters — keep memories to one sentence.`,
		};
	}
	return { content: trimmed };
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

function parseIdAndContentArgs(args: unknown): { id: string; content: string } | { error: string } {
	const idResult = parseIdArg(args);
	if ('error' in idResult) return idResult;
	const contentResult = parseContentArg(args);
	if ('error' in contentResult) return contentResult;
	return { id: idResult.id, content: contentResult.content };
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

register(saveMemoryTool);
register(updateMemoryTool);
register(forgetMemoryTool);
register(recallMemoryTool);
