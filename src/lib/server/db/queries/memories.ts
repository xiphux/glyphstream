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
 * via composeMemorySection (no retrieval round-trip); once the inlined index
 * would exceed a char budget AND an embedding model is configured, the bodies
 * are swapped for a `recall_memory` hint and the model retrieves on demand
 * against `embedding` (populated asynchronously by the backfill worker).
 */
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
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
 */
export function listMemoriesNeedingEmbedding(
	model: string,
	limit: number,
): Array<{ id: string; content: string }> {
	const db = getDb();
	return db
		.select({ id: memories.id, content: memories.content })
		.from(memories)
		.where(or(isNull(memories.embedding), ne(memories.embeddingModel, model)))
		.limit(limit)
		.all();
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

export function createMemory(userId: string, content: string): { id: string } {
	const db = getDb();
	const id = generateId();
	const now = Date.now();
	db.insert(memories)
		.values({
			id,
			userId,
			content,
			embedding: null,
			embeddingModel: null,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return { id };
}

/** Returns true iff a row matched (id existed for this user). */
export function updateMemory(userId: string, id: string, content: string): boolean {
	const db = getDb();
	const result = db
		.update(memories)
		// Null the stored vector so the backfill worker re-embeds the new
		// content — a stale embedding would recall the memory by its old text.
		.set({ content, updatedAt: Date.now(), embedding: null, embeddingModel: null })
		.where(and(eq(memories.userId, userId), eq(memories.id, id)))
		.run();
	return result.changes > 0;
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
 * prompt. Returns null when the list is empty so the caller can omit
 * the section header entirely — a "(no memories yet)" line would just
 * be noise; the tool descriptions already teach the model that
 * save_memory exists.
 *
 * Each row is rendered as `[<id>] <content>` so the model can pass the
 * id back to update_memory / forget_memory. The header text describes
 * what the index is and how to write to it.
 *
 * When `recallMode` is set (an embedding endpoint is configured and the
 * inlined bodies would exceed the budget — see `memoryInlineBudgetExceeded`),
 * the bodies are replaced with a one-liner pointing at the `recall_memory`
 * tool, so a large memory store doesn't blow a small context window. The
 * caller decides the mode; this just renders it.
 */
export function composeMemorySection(
	list: Memory[],
	opts: { recallMode?: boolean } = {},
): string | null {
	if (list.length === 0) return null;
	if (opts.recallMode) {
		const noun = list.length === 1 ? 'memory' : 'memories';
		return `The user has ${list.length} saved ${noun} (durable facts about them, carried across conversations). They are not all shown here — call recall_memory with a query to retrieve the ones relevant to the current topic. Each result is prefixed with its id in square brackets; pass that id to update_memory or forget_memory. To add a new memory, call save_memory.`;
	}
	const header =
		'Saved memories (durable facts about the user, carried across conversations). Each line is prefixed with its id in square brackets — pass that id to forget_memory or update_memory. To add a new memory, call save_memory.';
	const lines = list.map((m) => `[${m.id}] ${m.content}`);
	return `${header}\n\n${lines.join('\n')}`;
}

/**
 * Total chars of all memory bodies — the budget signal for the inline-vs-recall
 * switch. Once the inlined index would cross this threshold, the caller (a
 * request handler with an embedding model configured) flips `recallMode` so the
 * model retrieves on demand instead of carrying the whole index every turn.
 * ~4000 chars ≈ ~1k tokens: well under even an 8k local-model context, with
 * room for the rest of the prompt.
 */
export const MEMORY_INLINE_BUDGET_CHARS = 4000;

export function memoryInlineBudgetExceeded(list: Memory[]): boolean {
	let total = 0;
	for (const m of list) total += m.content.length;
	return total > MEMORY_INLINE_BUDGET_CHARS;
}
