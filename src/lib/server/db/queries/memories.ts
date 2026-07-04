/**
 * Memory rows are the model-driven "remember this across conversations"
 * surface. The model-facing CRUD (create/list/update/delete/recall) scopes
 * every WHERE by user_id so a tool call that fabricates a foreign id can never
 * reach another user's row — the UPDATE/DELETE simply matches zero rows and
 * the caller reports a recoverable error to the model. The two exceptions are
 * the embedding-backfill worker's helpers (`listMemoriesNeedingEmbedding`,
 * `setMemoryEmbedding`), which run cross-user by design — see their own notes.
 *
 * Read paths: small stores inline every row's `content` into the system prompt
 * via composeMemorySection (no retrieval round-trip); once the bodies would
 * exceed a char budget the store is split into tiers (`selectMemoryTiers` in
 * `../../memory/tiering`, scored by recency-decayed recall + freshness) — the
 * highest-scored memories stay inlined in full up to the budget, the rest are
 * shown as a compact `[id] topic` index, and the model reads an indexed body
 * back on demand via `recall_memory` — by id (no embeddings needed) or by query
 * (BM25 lexical, fused with `embedding`-cosine when a model is configured).
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { generateId } from '../../util/id';
import type { Memory } from '$lib/types/api';
import { getDb } from '../client';
import { memories } from '../schema';

export type { Memory };

/** A memory row with its persisted embedding blob (the recall read path). */
export interface MemoryWithEmbedding extends Memory {
	embedding: Buffer | null;
	embeddingModel: string | null;
}

/**
 * A single line of the over-budget memory index: the id, the model-authored
 * `topic` (null on rows predating the field), and a body `snippet` used as the
 * fallback label when `topic` is null. Deliberately omits the full body — the
 * index is what we inject *instead of* bodies once the store is over budget.
 */
export interface MemoryIndexRow {
	id: string;
	topic: string | null;
	snippet: string;
}

/**
 * A memory's ranking inputs for phase-2 tiering: the index fields plus the body
 * length and the recall/recency counters. Carries `len` (a `length(content)`)
 * rather than the body so ranking never materializes cold bodies. A structural
 * superset of `MemoryIndexRow`, so a cold-tier row is usable directly as an
 * index line. Scored by `selectMemoryTiers` in `../../memory/tiering`.
 */
export interface MemoryTierRow {
	id: string;
	topic: string | null;
	snippet: string;
	len: number;
	recallCount: number;
	lastRecalledAt: number | null;
	createdAt: number;
	updatedAt: number;
}

/**
 * List a user's memories oldest-first. The stable ordering matters
 * because the bracketed-id index injected into the system prompt
 * anchors the model — if turn-to-turn ordering drifts, the model can
 * cite ids that have moved beneath it.
 */
export function listMemoriesForUser(userId: string): Memory[] {
	const db = getDb();
	return db
		.select({
			id: memories.id,
			content: memories.content,
			createdAt: memories.createdAt,
			updatedAt: memories.updatedAt,
		})
		.from(memories)
		.where(eq(memories.userId, userId))
		.orderBy(asc(memories.createdAt))
		.all();
}

/**
 * Cheap size probe for a user's memory store: the row count and the total chars
 * of all bodies. Drives the inline-vs-recall switch in `composePersonaPrompt`
 * (`totalChars > MEMORY_INLINE_BUDGET_CHARS`) without pulling every body into the
 * request when the answer is "recall mode, just need the count" — a SQL
 * `count`/`sum` instead of materializing the rows.
 */
export function memoryStats(userId: string): { count: number; totalChars: number } {
	const db = getDb();
	const row = db
		.select({
			count: sql<number>`count(*)`,
			totalChars: sql<number>`coalesce(sum(length(${memories.content})), 0)`,
		})
		.from(memories)
		.where(eq(memories.userId, userId))
		.get();
	return { count: row?.count ?? 0, totalChars: row?.totalChars ?? 0 };
}

/**
 * The ranking rows for phase-2 tiering: one row per memory with its `topic`, a
 * body `snippet`, the body length `len`, and the recall/recency counters —
 * oldest-first (same stable-ordering rationale as `listMemoriesForUser`).
 * Selects `length(content)` and `substr(content,1,80)` but NOT the full body, so
 * ranking the store never materializes the cold bodies the tier split avoids.
 * `selectMemoryTiers` (`../../memory/tiering`) scores these; the cold subset is
 * rendered directly as the topic index (`MemoryTierRow` ⊃ `MemoryIndexRow`), and
 * the hot ids are re-fetched in full via `listMemoryBodies`. The `snippet` is
 * the fallback index label for rows whose `topic` is still null (pre-topic rows,
 * until phase-3 backfill).
 */
export function listMemoryTierRows(userId: string): MemoryTierRow[] {
	const db = getDb();
	return db
		.select({
			id: memories.id,
			topic: memories.topic,
			snippet: sql<string>`substr(${memories.content}, 1, 80)`,
			len: sql<number>`length(${memories.content})`,
			recallCount: memories.recallCount,
			lastRecalledAt: memories.lastRecalledAt,
			createdAt: memories.createdAt,
			updatedAt: memories.updatedAt,
		})
		.from(memories)
		.where(eq(memories.userId, userId))
		.orderBy(asc(memories.createdAt))
		.all();
}

/**
 * Full bodies for a specific set of the user's memories — the hot tier's ids,
 * resolved after `selectMemoryTiers` has ranked on metadata alone. Empty `ids` →
 * no query (`IN ()` is invalid). User-scoped per the isolation invariant (a
 * foreign id simply isn't returned); ordered createdAt for a stable inline
 * rendering.
 */
export function listMemoryBodies(userId: string, ids: string[]): Memory[] {
	if (ids.length === 0) return [];
	const db = getDb();
	return db
		.select({
			id: memories.id,
			content: memories.content,
			createdAt: memories.createdAt,
			updatedAt: memories.updatedAt,
		})
		.from(memories)
		.where(and(eq(memories.userId, userId), inArray(memories.id, ids)))
		.orderBy(asc(memories.createdAt))
		.all();
}

/**
 * Like `listMemoriesForUser` but also returns the persisted embedding + the
 * model that produced it. The recall tool ranks the rows whose `embeddingModel`
 * matches the currently-configured model (different models = different vector
 * spaces) and falls back to BM25 over `content` for the rest.
 */
export function listMemoriesWithEmbeddings(userId: string): MemoryWithEmbedding[] {
	const db = getDb();
	return (
		db
			.select({
				id: memories.id,
				content: memories.content,
				topic: memories.topic,
				createdAt: memories.createdAt,
				updatedAt: memories.updatedAt,
				embedding: memories.embedding,
				embeddingModel: memories.embeddingModel,
			})
			.from(memories)
			.where(eq(memories.userId, userId))
			.orderBy(asc(memories.createdAt))
			// `blob()` infers as `unknown` on this drizzle RC; node:sqlite hands back
			// a Buffer for a BLOB at runtime, so the narrow is sound.
			.all() as MemoryWithEmbedding[]
	);
}

/**
 * Rows whose stored embedding is missing or was produced by a different model
 * than the one currently configured — the backfill worker's work queue.
 *
 * Deliberately NOT user-scoped: this is a background worker that embeds every
 * user's memories, so the per-user read-isolation invariant (which guards
 * request-path reads) doesn't apply — same exemption the media purger relies on.
 *
 * A NULL `embedding` always implies a NULL `embedding_model` (we write the pair
 * together), so `isNull(embedding)` catches the never-embedded rows that the
 * `ne(embedding_model, ...)` clause can't (SQL `NULL != x` is NULL, not true).
 *
 * Run as two queries rather than one `OR`: the never-embedded leg
 * (`embedding IS NULL`) is served by the partial index `idx_memories_unembedded`
 * — so draining a backlog of fresh memories is an index scan, not a full scan —
 * and only when that leg under-fills the batch do we fall back to the
 * stale-model leg (`embedding_model != ?`, which `!=` makes unindexable). An
 * `OR` of the two would defeat the partial index entirely and scan every sweep.
 */
export function listMemoriesNeedingEmbedding(
	model: string,
	limit: number,
): Array<{ id: string; content: string }> {
	const db = getDb();
	const fresh = db
		.select({ id: memories.id, content: memories.content })
		.from(memories)
		.where(isNull(memories.embedding))
		.limit(limit)
		.all();
	if (fresh.length >= limit) return fresh;

	// Backlog of never-embedded rows didn't fill the batch — top up with rows
	// embedded by a now-superseded model (operator changed the embedding model).
	const stale = db
		.select({ id: memories.id, content: memories.content })
		.from(memories)
		.where(and(isNotNull(memories.embedding), ne(memories.embeddingModel, model)))
		.limit(limit - fresh.length)
		.all();
	return [...fresh, ...stale];
}

/**
 * Persist a computed embedding. Keyed by id alone (background worker, cross-
 * user) and does not bump `updatedAt` — an embedding refresh isn't a content
 * edit.
 *
 * Guarded on `expectedContent` to close a write-after-edit race: the worker
 * reads the content, then awaits a network embedding call, during which a
 * concurrent `update_memory` may change the content and null the vector (its
 * "re-embed me" signal). Without the guard we'd write the OLD text's vector
 * back under the NEW content AND stamp the current model — making the row
 * un-requeue-able and corrupting recall permanently. With it, the stale write
 * matches zero rows, the vector stays NULL, and the next sweep re-embeds the
 * new content. Returns true iff a row matched (content unchanged since read).
 */
export function setMemoryEmbedding(
	id: string,
	expectedContent: string,
	embedding: Buffer,
	embeddingModel: string,
): boolean {
	const db = getDb();
	const result = db
		.update(memories)
		.set({ embedding, embeddingModel })
		.where(and(eq(memories.id, id), eq(memories.content, expectedContent)))
		.run();
	return result.changes > 0;
}

/**
 * `topic` is the model-authored index label. The `save_memory` tool always
 * supplies one; it defaults to null here so internal/back-office callers (and
 * setup in tests) can create a row without one — those render via the snippet
 * fallback until the phase-3 dreaming pass backfills a real topic.
 */
export function createMemory(
	userId: string,
	content: string,
	topic: string | null = null,
): { id: string } {
	const db = getDb();
	const id = generateId();
	const now = Date.now();
	db.insert(memories)
		.values({
			id,
			userId,
			content,
			topic,
			embedding: null,
			embeddingModel: null,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return { id };
}

/**
 * Returns true iff a row matched (id existed for this user).
 *
 * `topic` is only written when provided: the `update_memory` tool re-supplies it
 * (renaming the index entry in the same edit), but a caller that omits it leaves
 * the existing topic untouched rather than clobbering it to null.
 */
export function updateMemory(
	userId: string,
	id: string,
	content: string,
	topic?: string | null,
): boolean {
	const db = getDb();
	const set: {
		content: string;
		updatedAt: number;
		embedding: null;
		embeddingModel: null;
		topic?: string | null;
	} = {
		content,
		// Null the stored vector so the backfill worker re-embeds the new
		// content — a stale embedding would recall the memory by its old text.
		updatedAt: Date.now(),
		embedding: null,
		embeddingModel: null,
	};
	if (topic !== undefined) set.topic = topic;
	const result = db
		.update(memories)
		.set(set)
		.where(and(eq(memories.userId, userId), eq(memories.id, id)))
		.run();
	return result.changes > 0;
}

/**
 * Record that these memories were surfaced by a `recall_memory` call: bump each
 * row's hit count and stamp the recall time. These two columns feed
 * `scoreMemory` (`../../memory/tiering`): the recency-decayed recall term is what
 * keeps a frequently-referenced memory in the always-inline (hot) tier. Recall
 * of an already-inlined memory doesn't happen (it's already in the prompt), so
 * its term decays and it sinks back to the index — the self-erasing property.
 * User-scoped like the rest of the model-facing path (a foreign id simply
 * matches zero rows). Does not touch `updatedAt` — a recall isn't a content edit.
 */
export function recordMemoryRecall(userId: string, ids: string[]): void {
	if (ids.length === 0) return;
	const db = getDb();
	db.update(memories)
		.set({ recallCount: sql`${memories.recallCount} + 1`, lastRecalledAt: Date.now() })
		.where(and(eq(memories.userId, userId), inArray(memories.id, ids)))
		.run();
}

/** Returns true iff a row matched (id existed for this user). */
export function deleteMemory(userId: string, id: string): boolean {
	const db = getDb();
	const result = db
		.delete(memories)
		.where(and(eq(memories.userId, userId), eq(memories.id, id)))
		.run();
	return result.changes > 0;
}

/**
 * Compose the "Saved memories" section appended to the persona system
 * prompt. Returns null when there's nothing to show so the caller can omit
 * the section header entirely — a "(no memories yet)" line would just
 * be noise; the tool descriptions already teach the model that
 * save_memory exists.
 *
 * Two renderings, chosen by `composePersonaPrompt`:
 *
 * - **Inline** (default, small stores): every row as `[<id>] <content>`, the
 *   full body in the prompt so nothing has to be recalled.
 * - **Tiered** (`recallMode`, over `MEMORY_INLINE_BUDGET_CHARS`): the hot tier
 *   (`list`, ranked by `selectMemoryTiers`) is inlined in full as
 *   `[<id>] <content>`, and the cold tail (`opts.index`) follows as
 *   `[<id>] <topic>` — topic only, so a large store still fits. The model reads a
 *   cold entry's full body back via `recall_memory` (by id, or by query). Cold
 *   rows with a null `topic` fall back to a content snippet. Needs no embedding
 *   model — recall-by-id is pure SQLite.
 *
 * In both cases the bracketed id is what the model passes to
 * update_memory / forget_memory (and, for a cold entry, recall_memory).
 */
export function composeMemorySection(
	list: Memory[],
	opts: { recallMode?: boolean; index?: MemoryIndexRow[] } = {},
): string | null {
	if (opts.recallMode) {
		const cold = opts.index ?? [];
		if (list.length === 0 && cold.length === 0) return null;

		// Defensive: no hot tier (nothing fit the budget) — pure topic index, the
		// phase-1 rendering. In practice a single body (≤500 chars) always fits a
		// 4000-char budget, so this branch is a safety net, not the common path.
		if (list.length === 0) {
			const header =
				'Saved memory index (durable facts about the user, carried across conversations). Only a short topic for each memory is shown here — the full text is not loaded. Call recall_memory with a list of ids to read the full text of specific entries, or with a query to find entries by meaning. Each line is prefixed with its id in square brackets — pass that id to recall_memory, update_memory, or forget_memory. To add a new memory, call save_memory.';
			const lines = cold.map((m) => `[${m.id}] ${m.topic ?? m.snippet}`);
			return `${header}\n\n${lines.join('\n')}`;
		}

		// Over budget: the highest-scored memories inline in full, the rest by topic.
		const header =
			'Saved memories (durable facts about the user, carried across conversations). The most relevant are shown in full first; any remaining ones are listed below by topic only. Each line is prefixed with its id in square brackets — pass that id to update_memory or forget_memory. To read the full text of a topic-only entry, call recall_memory with its id (or with a query to search by meaning). To add a new memory, call save_memory.';
		const hotBlock = list.map((m) => `[${m.id}] ${m.content}`).join('\n');
		if (cold.length === 0) return `${header}\n\n${hotBlock}`;
		const coldBlock =
			'More saved memories (topic only — call recall_memory with the id for the full text):\n' +
			cold.map((m) => `[${m.id}] ${m.topic ?? m.snippet}`).join('\n');
		return `${header}\n\n${hotBlock}\n\n${coldBlock}`;
	}
	if (list.length === 0) return null;
	const header =
		'Saved memories (durable facts about the user, carried across conversations). Each line is prefixed with its id in square brackets — pass that id to forget_memory or update_memory. To add a new memory, call save_memory.';
	const lines = list.map((m) => `[${m.id}] ${m.content}`);
	return `${header}\n\n${lines.join('\n')}`;
}

/**
 * The char budget for inlined memory bodies, serving two roles in
 * `composePersonaPrompt`: (1) the fast-path gate — when `memoryStats().totalChars`
 * is at or under it, the whole store inlines with no scoring; (2) over budget,
 * the capacity `selectMemoryTiers` greedy-fills the hot (inline-in-full) tier
 * against, the remainder spilling to the `[id] topic` index. Independent of
 * embeddings — recall-by-id needs none. ~4000 chars ≈ ~1k tokens: well under even
 * an 8k local-model context, with room for the rest of the prompt.
 */
export const MEMORY_INLINE_BUDGET_CHARS = 4000;
