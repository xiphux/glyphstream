import { eq, and, inArray } from 'drizzle-orm';
import { generateId } from '../../util/id';
import type { ChatMessage, MessagePart, MessageRole } from '$lib/types/api';
import { parseMessageParts } from './json-columns';
import { getDb } from '../client';
import { conversations, media, messages } from '../schema';
import { decrementMediaForMessages, hardDeleteOrphanGeneratedMediaForMessages } from './media';

interface AppendInput {
	conversationId: string;
	parentMessageId: string | null;
	role: MessageRole;
	parts: MessagePart[];
	contentHtml?: string | null;
	reasoningText?: string | null;
	finishReason?: string | null;
	modelUsed?: string | null;
	tokensIn?: number | null;
	tokensOut?: number | null;
	/** Generation wall-time in ms; see `messages.gen_ms` in schema.ts. */
	genMs?: number | null;
	rawResponseJson?: string | null;
	/** Set ONLY when appending a compaction summary: the id of the first
	 *  message kept verbatim after the summary. See messages.ts schema +
	 *  src/lib/chat-compaction.ts. Null/absent on ordinary appends. */
	compactionResumeFromMessageId?: string | null;
	/**
	 * Whether to point the conversation's active_leaf_message_id at the new
	 * message (default true). A multi-model fan-out sets this false: its N
	 * sibling assistant messages all hang off one shared user message, and
	 * the leaf must stay pinned at that user message (so every branch's
	 * history walk is identical) until the user picks a winner. Letting each
	 * concurrent append advance the leaf would make it ping-pong between
	 * branches and corrupt the others' upstream context.
	 */
	advanceActiveLeaf?: boolean;
}

/**
 * Append a message under `parentMessageId`. By default also points the
 * conversation's active_leaf_message_id at the new message; pass
 * `advanceActiveLeaf: false` to insert a sibling without moving the leaf
 * (fan-out). Returns the newly inserted row shaped as a ChatMessage.
 */
export function appendMessage(input: AppendInput): ChatMessage {
	const db = getDb();
	const id = generateId();
	const now = Date.now();

	db.transaction((tx) => {
		tx.insert(messages)
			.values({
				id,
				conversationId: input.conversationId,
				parentMessageId: input.parentMessageId,
				role: input.role,
				contentJson: JSON.stringify(input.parts),
				contentHtml: input.contentHtml ?? null,
				reasoningText: input.reasoningText ?? null,
				finishReason: input.finishReason ?? null,
				modelUsed: input.modelUsed ?? null,
				tokensIn: input.tokensIn ?? null,
				tokensOut: input.tokensOut ?? null,
				genMs: input.genMs ?? null,
				rawResponseJson: input.rawResponseJson ?? null,
				compactionResumeFromMessageId: input.compactionResumeFromMessageId ?? null,
				createdAt: now,
			})
			.run();

		if (input.advanceActiveLeaf ?? true) {
			tx.update(conversations)
				// Advancing the leaf off a parked fan-out resolves/abandons it
				// (a normal send, edit, or retry after the comparison), so clear
				// the marker. A no-op when none is set. Fan-out branches take the
				// else-branch below and leave it pinned.
				.set({ activeLeafMessageId: id, updatedAt: now, fanoutParentMessageId: null })
				.where(eq(conversations.id, input.conversationId))
				.run();
		} else {
			// Fan-out sibling: leave active_leaf pinned at the shared user
			// message, but still bump updated_at so the conversation sorts to
			// the top of the sidebar while branches stream in.
			tx.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, input.conversationId))
				.run();
		}
	});

	return {
		id,
		role: input.role,
		parts: input.parts,
		contentHtml: input.contentHtml ?? null,
		reasoningText: input.reasoningText ?? null,
		finishReason: input.finishReason ?? null,
		modelUsed: input.modelUsed ?? null,
		tokensIn: input.tokensIn ?? null,
		tokensOut: input.tokensOut ?? null,
		genMs: input.genMs ?? null,
		compactionResumeFromMessageId: input.compactionResumeFromMessageId ?? null,
		createdAt: now,
	};
}

/**
 * Replace the persisted parts JSON for an existing message. Used by the
 * MCP approval-resume flow to fill in a previously-pending tool_result
 * row with the actual execution output. Returns whether a row matched.
 */
export function updateMessageParts(
	messageId: string,
	conversationId: string,
	parts: MessagePart[],
): boolean {
	const db = getDb();
	const result = db
		.update(messages)
		.set({ contentJson: JSON.stringify(parts) })
		.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
		.run();
	return result.changes > 0;
}

/**
 * Walk the active branch root → leaf and return messages in order.
 *
 * Two-step load to keep the heavy columns (content_json, content_html,
 * reasoning_text, raw_response_json) bounded by the active branch length
 * rather than the whole conversation. Long-edited threads can carry 2-3x
 * the active-branch size in orphaned sibling subtrees; the previous
 * single-query load pulled all of their JSON for no consumer.
 *
 *   1. Skeleton scan of (id, parent_message_id, created_at) — every row
 *      in the conversation, but each is a few dozen bytes. Drives the
 *      sibling-grouping for branch-aware rendering and lets us walk the
 *      parent chain to compute the active-branch id list.
 *   2. Heavy fetch of full columns for just the active-branch ids.
 */
export function walkActiveBranch(conversationId: string): ChatMessage[] {
	const db = getDb();
	const conv = db
		.select({ activeLeaf: conversations.activeLeafMessageId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.get();

	if (!conv?.activeLeaf) return [];

	const skeletons = db
		.select({
			id: messages.id,
			parentMessageId: messages.parentMessageId,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.all();
	const skelById = new Map(skeletons.map((r) => [r.id, r]));

	// Group by parent_message_id so we can compute sibling counts /
	// positions for messages on the active branch in O(N) instead of
	// O(N) per active-branch entry.
	const byParent = new Map<string | null, typeof skeletons>();
	for (const r of skeletons) {
		const key = r.parentMessageId ?? null;
		const list = byParent.get(key);
		if (list) list.push(r);
		else byParent.set(key, [r]);
	}
	for (const list of byParent.values()) {
		list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	// Walk parent chain to collect the active-branch id list (leaf → root).
	const branchIds: string[] = [];
	let cursor = skelById.get(conv.activeLeaf);
	while (cursor) {
		branchIds.push(cursor.id);
		if (!cursor.parentMessageId) break;
		cursor = skelById.get(cursor.parentMessageId);
	}

	const heavyRows = db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), inArray(messages.id, branchIds)))
		.all();
	const heavyById = new Map(heavyRows.map((r) => [r.id, r]));

	const ordered: ChatMessage[] = [];
	for (const id of branchIds) {
		const row = heavyById.get(id);
		if (!row) continue;
		const siblings = byParent.get(row.parentMessageId ?? null) ?? [];
		const siblingIds = siblings.map((s) => s.id);
		const msg = rowToChatMessage(row);
		msg.parentMessageId = row.parentMessageId;
		msg.siblingCount = siblings.length || 1;
		msg.siblingPosition = siblingIds.indexOf(row.id) + 1 || 1;
		msg.siblingIds = siblingIds.length ? siblingIds : [row.id];
		ordered.push(msg);
	}
	return ordered.reverse();
}

/**
 * Index a flat list of conversation message rows by parent id, so
 * parent→children lookups are O(1). Rows with no parent (conversation
 * roots) are skipped — the map is keyed by a non-null parent id.
 */
export function buildChildrenByParent<T extends { id: string; parentId: string | null }>(
	rows: readonly T[],
): Map<string, T[]> {
	const byParent = new Map<string, T[]>();
	for (const r of rows) {
		if (!r.parentId) continue;
		const list = byParent.get(r.parentId);
		if (list) list.push(r);
		else byParent.set(r.parentId, [r]);
	}
	return byParent;
}

/**
 * Walk down from `startId` to the deepest descendant, choosing the most
 * recently created child at each step (ties broken lexically by id,
 * descending). Returns `startId` itself when it has no children.
 *
 * The tie-break is a contract, not an implementation detail: selectBranch
 * and deleteBranch must pick the *same* leaf for the same tree, or branch
 * selection after a delete becomes inconsistent.
 *
 * Exported for direct unit testing of the tie-break contract.
 */
export function deepestDescendant(
	startId: string,
	childrenByParent: ReadonlyMap<string, ReadonlyArray<{ id: string; createdAt: number }>>,
): string {
	let cursor = startId;
	for (;;) {
		const children = childrenByParent.get(cursor);
		if (!children || children.length === 0) break;
		const sorted = [...children].sort(
			(a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
		);
		cursor = sorted[0].id;
	}
	return cursor;
}

/**
 * Switch the conversation's active branch to the one containing
 * `messageId`. Walks down from the message to its deepest descendant
 * (greatest created_at, breaking ties lexically by id) and points
 * active_leaf at that descendant. If `messageId` is itself a leaf,
 * active_leaf is set directly to it.
 *
 * Returns the new active_leaf id, or null if `messageId` doesn't belong
 * to `conversationId`.
 */
export function selectBranch(
	conversationId: string,
	messageId: string,
): { newActiveLeaf: string } | null {
	const db = getDb();
	const target = db
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
		.get();
	if (!target) return null;

	const rows = db
		.select({
			id: messages.id,
			parentId: messages.parentMessageId,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.all();

	const cursor = deepestDescendant(messageId, buildChildrenByParent(rows));

	db.update(conversations)
		// Selecting a branch resolves any parked fan-out (the user picked a
		// winner / dismissed the comparison), so clear the marker too. A no-op
		// for ordinary sibling navigation, where it's already null.
		//
		// We deliberately do NOT bump `updated_at`: branch navigation is a view
		// change, not new activity, so it shouldn't reorder the sidebar's
		// newest-first Recents. (Matches ChatGPT / Claude / Gemini, where
		// switching between response variants leaves the conversation's
		// position in the list untouched.) Actual content changes — new
		// messages, edits, retries — still bump it through their own paths.
		.set({ activeLeafMessageId: cursor, fanoutParentMessageId: null })
		.where(eq(conversations.id, conversationId))
		.run();
	return { newActiveLeaf: cursor };
}

/** Fetch a single message scoped to a conversation. Used by retry — the
 * server needs to look up the assistant message being retried + its
 * parent user message. Includes parentMessageId on the returned object
 * (the walk path doesn't, since order encodes parent→child there). */
export function getMessage(conversationId: string, messageId: string): ChatMessage | null {
	const db = getDb();
	const row = db
		.select()
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
		.get();
	if (!row) return null;
	const msg = rowToChatMessage(row);
	msg.parentMessageId = row.parentMessageId;
	return msg;
}

/**
 * The assistant messages that hang directly off `parentUserMessageId`, in
 * creation order. During a multi-model fan-out these are the N sibling
 * responses rendered side by side; for a normal turn there's exactly one.
 *
 * Kept separate from `walkActiveBranch` (which only returns the active
 * branch) because the fan-out compare view needs *all* the siblings under
 * the shared user message at once — before the user has picked one to make
 * active. Each returned message carries its own `modelUsed` so the column
 * header can label which model produced it. Scoped to assistant rows so a
 * (future) tool message child can't leak into the column grid.
 */
export function getSiblingAssistants(
	conversationId: string,
	parentUserMessageId: string,
): ChatMessage[] {
	const db = getDb();
	const rows = db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.parentMessageId, parentUserMessageId),
				eq(messages.role, 'assistant'),
			),
		)
		.all();
	rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	const msgs = rows.map((row) => {
		const msg = rowToChatMessage(row);
		msg.parentMessageId = row.parentMessageId;
		return msg;
	});

	// Resolve each result's source image (split-attachments provenance) from its
	// output media row, in one batched lookup — so a reloaded split grid keeps
	// the per-result input thumbnail and regenerate re-rolls the right input.
	const outputMediaId = (m: ChatMessage): string | null => {
		const part = m.parts.find((p) => p.type === 'image' || p.type === 'video');
		return part && (part.type === 'image' || part.type === 'video') ? part.mediaId : null;
	};
	const outputIds = msgs.map(outputMediaId).filter((id): id is string => id !== null);
	if (outputIds.length > 0) {
		const srcRows = db
			.select({ id: media.id, src: media.sourceMediaId })
			.from(media)
			.where(inArray(media.id, outputIds))
			.all();
		const srcById = new Map(srcRows.map((r) => [r.id, r.src]));
		for (const m of msgs) {
			const out = outputMediaId(m);
			if (out) m.sourceMediaId = srcById.get(out) ?? null;
		}
	}
	return msgs;
}

/**
 * Walk up from `startMessageId` through parent links until we find the
 * first `role: 'user'` ancestor. Returns null if the chain doesn't
 * include one (which means the message is a root or descendant of a
 * non-user root — both shouldn't happen with our schema invariants).
 *
 * Powers retry: in a multi-iteration tool turn the chain is
 *   user → assistant_0 → tool_0 → assistant_1 → ...
 * and a retry click on any assistant in that chain needs to find the
 * single user message that started the turn so the new (regenerated)
 * assistant attaches as a sibling of assistant_0. The pre-PR2 retry
 * code assumed the assistant's immediate parent was the user message —
 * true for single-iteration turns, false here.
 *
 * Caps at 100 hops as a safety bound against ill-formed cycles
 * (shouldn't exist, but a runaway walk would loop forever).
 *
 * Single skeleton fetch of (id, parent, role) for the whole conversation
 * + in-memory walk. The N+1 form (one getMessage per hop) ran up to 100
 * round-trips per retry click on long tool turns.
 */
export function findUserMessageAncestor(
	conversationId: string,
	startMessageId: string,
): ChatMessage | null {
	const db = getDb();
	const rows = db
		.select({
			id: messages.id,
			parentMessageId: messages.parentMessageId,
			role: messages.role,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.all();
	const byId = new Map(rows.map((r) => [r.id, r]));

	const seen = new Set<string>();
	let cursor = byId.get(startMessageId);
	for (let hops = 0; hops < 100; hops++) {
		if (!cursor) return null;
		if (cursor.role === 'user') return getMessage(conversationId, cursor.id);
		if (!cursor.parentMessageId) return null;
		if (seen.has(cursor.parentMessageId)) return null; // cycle guard
		seen.add(cursor.parentMessageId);
		cursor = byId.get(cursor.parentMessageId);
	}
	return null;
}

/**
 * Resolve the parent for a newly-appended user message, given the
 * conversation's current active leaf and the optional client-provided
 * routing fields. Three cases the route handler needs to differentiate:
 *
 *   1. `editedMessageId` provided → the new message is a sibling of
 *      the edited one. Look up the edited message, copy its
 *      `parent_message_id` onto the new sibling. Critically handles
 *      the root-edit case where that parent is itself null (the new
 *      sibling becomes a fresh root, not a continuation of the
 *      current branch).
 *   2. `parentMessageId` provided (no `editedMessageId`) → caller has
 *      already resolved the parent and wants it used as-is. Validated
 *      to belong to this conversation.
 *   3. Neither → default "continue the current branch" append: parent
 *      is the active leaf.
 *
 * Empty-string variants of either field are treated as absent, matching
 * the route handler's pre-existing truthiness guard.
 *
 * Returns a discriminated result so the caller (the HTTP route) can map
 * misses to the appropriate 400. We deliberately don't throw SvelteKit's
 * `error()` from here — keeps this helper pure-ish and unit-testable
 * without the route-handler harness.
 */
export type ResolveParentResult =
	| { ok: true; parentMessageId: string | null }
	| { ok: false; reason: 'edited-message-not-found' | 'parent-message-not-found'; id: string };

export function resolveParentForUserMessage(input: {
	conversationId: string;
	activeLeafMessageId: string | null;
	editedMessageId?: string;
	parentMessageId?: string;
}): ResolveParentResult {
	if (typeof input.editedMessageId === 'string' && input.editedMessageId) {
		const edited = getMessage(input.conversationId, input.editedMessageId);
		if (!edited) {
			return {
				ok: false,
				reason: 'edited-message-not-found',
				id: input.editedMessageId,
			};
		}
		return { ok: true, parentMessageId: edited.parentMessageId ?? null };
	}
	if (typeof input.parentMessageId === 'string' && input.parentMessageId) {
		const candidate = getMessage(input.conversationId, input.parentMessageId);
		if (!candidate) {
			return {
				ok: false,
				reason: 'parent-message-not-found',
				id: input.parentMessageId,
			};
		}
		return { ok: true, parentMessageId: candidate.id };
	}
	return { ok: true, parentMessageId: input.activeLeafMessageId };
}

/** Direct active_leaf override — used by retry to point at the parent user
 * message before re-dispatching, so walkActiveBranch builds the upstream
 * request from the right history. */
export function setActiveLeafMessageId(conversationId: string, messageId: string): void {
	const db = getDb();
	db.update(conversations)
		.set({ activeLeafMessageId: messageId, updatedAt: Date.now() })
		.where(eq(conversations.id, conversationId))
		.run();
}

/**
 * "Edit" v1 behavior: set the conversation's active_leaf to the parent of
 * `messageId`, orphaning the descendants on what was the active branch.
 * Rows are NOT deleted — they remain reachable as alternate-branch siblings
 * once we wire the v2 branching UI. Returns the new active_leaf id (or null
 * if we just truncated to nothing).
 *
 * Returns null if `messageId` doesn't belong to `conversationId`.
 */
/**
 * Delete an alternate-branch sibling and its entire subtree of descendants.
 * Intended for the UI's "delete this branch" affordance — when the user has
 * created multiple branches via edit (or retry) and wants to discard one.
 *
 * Returns `null` if the message doesn't belong to the conversation, or
 * `{ refusedReason: 'no-siblings' }` only when the delete would strand the
 * active leaf — it sits inside the deleted subtree AND there's no sibling to
 * reassign it to (deleting the sole child of its parent — a truncate, a
 * different operation intentionally NOT exposed here). When the leaf lives
 * elsewhere (e.g. a parked fan-out pinned on the shared user message),
 * deleting a childless branch is allowed and the leaf is left untouched.
 *
 * On success, returns the deleted message ids and the resulting active_leaf —
 * reassigned to a sibling's deepest descendant *before* the delete fires (so
 * the FK's ON DELETE SET NULL can't orphan the conversation) only in that
 * leaf-in-subtree case; otherwise the leaf is unchanged. Media refs for the
 * deleted set are decremented before the delete too, because message_media's
 * ON DELETE CASCADE would otherwise drop the join rows out from under our
 * ref-counting.
 */
export function deleteBranch(
	conversationId: string,
	messageId: string,
	userId: string,
):
	| {
			deletedIds: string[];
			/** The active leaf after the delete. Unchanged (and null only for a
			 *  leaf-less conversation) when the leaf was outside the deleted
			 *  subtree — e.g. pruning a parked fan-out sibling leaves the leaf
			 *  pinned at the shared user message. */
			newActiveLeaf: string | null;
			/** Generated media whose only references were in the deleted
			 *  subtree. Caller unlinks the files post-commit; the rows
			 *  are already `hardDeletedAt`-stamped in the DB. */
			toUnlink: Array<{ id: string; storagePath: string }>;
	  }
	| { refusedReason: 'no-siblings' }
	| null {
	const db = getDb();
	return db.transaction((tx) => {
		// One-shot fetch of every row in the conversation: cheap (conversation
		// scoped) and lets us do parent/child lookups in memory without
		// chained queries.
		const all = tx
			.select({
				id: messages.id,
				parentId: messages.parentMessageId,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.all();

		const target = all.find((r) => r.id === messageId);
		if (!target) return null;

		// Siblings sharing this message's parent_message_id (null parent = root
		// siblings). Used both as the active-leaf replacement and in the refusal.
		const siblings = all.filter((r) => r.parentId === target.parentId && r.id !== messageId);

		// Collect the subtree rooted at messageId (inclusive) via BFS.
		const childrenByParent = buildChildrenByParent(all);
		const toDelete = new Set<string>([messageId]);
		const queue = [messageId];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			const kids = childrenByParent.get(cur);
			if (!kids) continue;
			for (const k of kids) {
				if (!toDelete.has(k.id)) {
					toDelete.add(k.id);
					queue.push(k.id);
				}
			}
		}

		const convRow = tx
			.select({
				leaf: conversations.activeLeafMessageId,
				fanoutParent: conversations.fanoutParentMessageId,
			})
			.from(conversations)
			.where(eq(conversations.id, conversationId))
			.get();
		const currentLeaf = convRow?.leaf ?? null;
		const leafInDeleted = currentLeaf != null && toDelete.has(currentLeaf);

		// Refuse ONLY when the delete would strand the active leaf: it sits inside
		// the deleted subtree AND there's no sibling to move it to (deleting the
		// sole child of its parent — that's a truncate, intentionally not exposed
		// here). When the leaf lives ELSEWHERE, deleting a childless sibling is
		// safe even with no DB sibling yet. The case that matters: a parked media
		// fan-out pinned at the shared user message where one branch has finished
		// and another is still generating (not yet a persisted sibling) — the user
		// prunes the finished dud while the leaf (and the marker) stay put, and the
		// in-flight branch repopulates the grid. The old blanket "no siblings →
		// refuse" wrongly blocked that, leaving a disabled delete button.
		if (leafInDeleted && siblings.length === 0) {
			return { refusedReason: 'no-siblings' as const };
		}

		// Reassign the leaf to a replacement sibling's deepest descendant ONLY when
		// the leaf was inside the deleted subtree (the sibling-nav case: you deleted
		// the branch you were viewing — guaranteed a sibling by the refusal above).
		// Otherwise the leaf is elsewhere (e.g. parked on the fan-out's user
		// message); leave it put so the grid survives the prune.
		const cursor = leafInDeleted
			? deepestDescendant(siblings[0].id, childrenByParent)
			: currentLeaf;
		// Clear the parked fan-out marker if its anchor user message is itself in
		// the delete set — otherwise the conversation UPDATE below (and the row
		// delete) would dangle / FK-error on it. The DB-level FK is NO ACTION
		// (drizzle-kit can't emit ON DELETE via ALTER TABLE ADD COLUMN), so the
		// app must null the reference explicitly, like selectBranch/truncate do.
		const clearFanoutMarker = convRow?.fanoutParent != null && toDelete.has(convRow.fanoutParent);

		// Order matters:
		//   1. active_leaf reassign — the active_leaf FK is ON DELETE SET NULL
		//      (genuine, from CREATE TABLE in 0000), so deleting the leaf row
		//      would null the pointer and leave the conversation with no current
		//      position. Move it to a valid replacement first instead of letting
		//      it go null. (The fanout-marker clear above is the NO-ACTION case —
		//      that FK was added by ALTER and the app must null it explicitly.)
		//   2. orphan-media hard-delete (must run BEFORE decrement; it
		//      compares each media's ref_count to its local link count
		//      inside the deletion set, and that comparison is only
		//      meaningful pre-decrement)
		//   3. ref-count decrement for the remaining (still-referenced)
		//      media — these stay in the DB but have one fewer link
		//   4. message delete (cascades to message_media via ON DELETE
		//      CASCADE, which is why we did the bookkeeping above)
		//
		// Step 2 is the new piece — branch-delete is "I rejected this
		// variant" so any media that exists ONLY on this branch should
		// go with it. Shared media (auto-attach into a follow-up
		// conversation, or the same image used across multiple branches
		// before this one) stays put because its ref_count is greater
		// than its local-to-this-deletion count.
		const now = Date.now();
		tx.update(conversations)
			.set({
				activeLeafMessageId: cursor,
				updatedAt: now,
				...(clearFanoutMarker ? { fanoutParentMessageId: null } : {}),
			})
			.where(eq(conversations.id, conversationId))
			.run();

		const deletedIds = [...toDelete];
		const toUnlink = hardDeleteOrphanGeneratedMediaForMessages(tx, deletedIds, userId);
		decrementMediaForMessages(tx, deletedIds);

		tx.delete(messages)
			.where(and(eq(messages.conversationId, conversationId), inArray(messages.id, deletedIds)))
			.run();

		return { deletedIds, newActiveLeaf: cursor, toUnlink };
	});
}

export function truncateAtMessage(
	conversationId: string,
	messageId: string,
): { newActiveLeaf: string | null } | null {
	const db = getDb();
	const target = db
		.select({ id: messages.id, parentId: messages.parentMessageId })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
		.get();
	if (!target) return null;

	const newLeaf = target.parentId;
	const now = Date.now();
	db.update(conversations)
		// Truncating moves the leaf and abandons any parked fan-out, so clear
		// the marker too (no-op when none is set).
		.set({ activeLeafMessageId: newLeaf, updatedAt: now, fanoutParentMessageId: null })
		.where(eq(conversations.id, conversationId))
		.run();
	return { newActiveLeaf: newLeaf };
}

function rowToChatMessage(row: typeof messages.$inferSelect): ChatMessage {
	return {
		id: row.id,
		role: row.role,
		parts: parseMessageParts(row.contentJson),
		contentHtml: row.contentHtml,
		reasoningText: row.reasoningText,
		finishReason: row.finishReason,
		modelUsed: row.modelUsed,
		tokensIn: row.tokensIn,
		tokensOut: row.tokensOut,
		genMs: row.genMs,
		compactionResumeFromMessageId: row.compactionResumeFromMessageId,
		createdAt: row.createdAt,
	};
}
