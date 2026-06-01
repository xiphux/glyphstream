/**
 * Memory rows are the model-driven "remember this across conversations"
 * surface. All CRUD here scopes every WHERE by user_id so a tool call
 * that fabricates a foreign id can never reach another user's row — the
 * UPDATE/DELETE simply matches zero rows and the caller reports a
 * recoverable error to the model.
 *
 * Browse-mode MVP: every row's `content` is inlined into the system
 * prompt via composeMemorySection, so the model always has the full
 * index without a retrieval round-trip. `embedding` + `embeddingModel`
 * are the phase-2 hook — NULL until a future backfill populates them.
 */
import { and, asc, eq } from 'drizzle-orm';
import { generateId } from '../../util/id';
import type { Memory } from '$lib/types/api';
import { getDb } from '../client';
import { memories } from '../schema';

export type { Memory };

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
		.set({ content, updatedAt: Date.now() })
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
 * TODO(phase-2): when an embedding endpoint is configured and the
 * memory budget exceeds a threshold, swap the inline bodies for a
 * one-liner pointing at a recall_memory(query) tool.
 */
export function composeMemorySection(list: Memory[]): string | null {
	if (list.length === 0) return null;
	const header =
		'Saved memories (durable facts about the user, carried across conversations). Each line is prefixed with its id in square brackets — pass that id to forget_memory or update_memory. To add a new memory, call save_memory.';
	const lines = list.map((m) => `[${m.id}] ${m.content}`);
	return `${header}\n\n${lines.join('\n')}`;
}
