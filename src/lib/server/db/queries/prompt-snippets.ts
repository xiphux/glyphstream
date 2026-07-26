import { and, asc, eq, sql } from 'drizzle-orm';
import { generateId } from '../../util/id';
import type { PromptSnippet, SnippetKind } from '$lib/types/api';
import { getDb, type Tx } from '../client';
import { promptSnippets } from '../schema';
import { parseSnippetKinds, parseSnippetTags } from './json-columns';

interface CreateInput {
	userId: string;
	name: string;
	body: string;
	/** Omit / pass [] for a generic snippet offered in every modality. */
	kinds?: SnippetKind[];
	tags?: string[];
}

interface UpdateInput {
	name?: string;
	body?: string;
	kinds?: SnippetKind[];
	tags?: string[];
}

function rowToPromptSnippet(row: typeof promptSnippets.$inferSelect): PromptSnippet {
	return {
		id: row.id,
		name: row.name,
		body: row.body,
		kinds: parseSnippetKinds(row.kinds),
		tags: parseSnippetTags(row.tags),
		usageCount: row.usageCount,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

// Empty array stored as NULL, matching encodeDisabledFeatures in
// custom-models.ts: a snippet that never set kinds reads as NULL, not '[]'.
function encodeList(list: readonly string[] | undefined): string | null {
	return list && list.length > 0 ? JSON.stringify(list) : null;
}

/**
 * All of a user's snippets, alphabetical by name.
 *
 * This is the raw order the settings page renders. Most-used-first ordering is
 * NOT applied here — the composer's autocomplete re-sorts by `usageCount` in
 * `filterSnippets` (`$lib/prompt-snippet-trigger`), which is the only consumer
 * that wants it.
 *
 * The `asc(id)` tiebreak is belt-and-braces: `uq_prompt_snippets_user_name`
 * already makes `name` unique per user, so no tie can occur today — but it
 * costs nothing and keeps the order deterministic if that constraint is ever
 * relaxed, since this list feeds a menu where reshuffling is user-visible.
 */
export function listPromptSnippetsForUser(userId: string): PromptSnippet[] {
	const db = getDb();
	const rows = db
		.select()
		.from(promptSnippets)
		.where(eq(promptSnippets.userId, userId))
		.orderBy(asc(promptSnippets.name), asc(promptSnippets.id))
		.all();
	return rows.map(rowToPromptSnippet);
}

export function getPromptSnippetForUser(id: string, userId: string): PromptSnippet | null {
	const db = getDb();
	const row = db
		.select()
		.from(promptSnippets)
		.where(and(eq(promptSnippets.id, id), eq(promptSnippets.userId, userId)))
		.get();
	return row ? rowToPromptSnippet(row) : null;
}

/** True when the user already has a snippet by this name. Pre-flight check for
 *  import so a duplicate reports as "skipped" instead of surfacing as a raw
 *  UNIQUE violation. */
export function promptSnippetExistsByName(userId: string, name: string): boolean {
	const db = getDb();
	const row = db
		.select({ id: promptSnippets.id })
		.from(promptSnippets)
		.where(and(eq(promptSnippets.userId, userId), eq(promptSnippets.name, name)))
		.get();
	return row !== undefined;
}

/**
 * Insert a snippet. Takes an optional `tx` so the bulk importer can write a
 * whole library inside one transaction — node:sqlite won't auto-promote a
 * nested `db.transaction()` to a SAVEPOINT, so a helper that opened its own
 * would throw when called from inside one.
 */
export function createPromptSnippet(input: CreateInput, tx?: Tx): PromptSnippet {
	const db = tx ?? getDb();
	const id = generateId();
	const now = Date.now();
	const kinds = input.kinds ?? [];
	const tags = input.tags ?? [];
	db.insert(promptSnippets)
		.values({
			id,
			userId: input.userId,
			name: input.name,
			body: input.body,
			kinds: encodeList(kinds),
			tags: encodeList(tags),
			usageCount: 0,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return {
		id,
		name: input.name,
		body: input.body,
		kinds,
		tags,
		usageCount: 0,
		createdAt: now,
		updatedAt: now,
	};
}

/** Patch a snippet. Returns the updated row, or null if not found / not owned.
 *  Already-sent messages are untouched — an inserted snippet is plain text in
 *  the message body, with no back-link to edit. */
export function updatePromptSnippet(
	id: string,
	userId: string,
	input: UpdateInput,
	tx?: Tx,
): PromptSnippet | null {
	const run = (t: Tx) => {
		const existing = t
			.select()
			.from(promptSnippets)
			.where(and(eq(promptSnippets.id, id), eq(promptSnippets.userId, userId)))
			.get();
		if (!existing) return null;

		const patch: Partial<typeof promptSnippets.$inferInsert> = { updatedAt: Date.now() };
		if (input.name !== undefined) patch.name = input.name;
		if (input.body !== undefined) patch.body = input.body;
		if (input.kinds !== undefined) patch.kinds = encodeList(input.kinds);
		if (input.tags !== undefined) patch.tags = encodeList(input.tags);

		t.update(promptSnippets).set(patch).where(eq(promptSnippets.id, id)).run();
		const refreshed = t.select().from(promptSnippets).where(eq(promptSnippets.id, id)).get();
		return refreshed ? rowToPromptSnippet(refreshed) : null;
	};
	return tx ? run(tx) : getDb().transaction(run);
}

export function deletePromptSnippet(id: string, userId: string): boolean {
	const db = getDb();
	const r = db
		.delete(promptSnippets)
		.where(and(eq(promptSnippets.id, id), eq(promptSnippets.userId, userId)))
		.run();
	return r.changes > 0;
}

/**
 * Bump a snippet's usage counter (drives most-used-first ordering). Incremented
 * in SQL rather than read-modify-write so two composers inserting at once can't
 * lose a count. Returns false when the id isn't the caller's, which the
 * fire-and-forget caller ignores — a lost count is not worth an error path.
 */
export function bumpSnippetUsage(id: string, userId: string): boolean {
	const db = getDb();
	const r = db
		.update(promptSnippets)
		.set({ usageCount: sql`${promptSnippets.usageCount} + 1` })
		.where(and(eq(promptSnippets.id, id), eq(promptSnippets.userId, userId)))
		.run();
	return r.changes > 0;
}
