import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { ChatMessage, MessagePart, MessageRole } from '$lib/types/api';
import { getDb } from '../client';
import { conversations, messages } from '../schema';
import {
	decrementMediaForMessages,
	hardDeleteOrphanGeneratedMediaForMessages
} from './media';

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
	rawResponseJson?: string | null;
}

/**
 * Append a message under `parentMessageId` and update the conversation's
 * active_leaf_message_id to the new message. Returns the newly inserted row
 * shaped as a ChatMessage.
 *
 * v1 always appends to the active leaf, so the tree stays linear. v2 will
 * be able to call this with any `parentMessageId` to create branches.
 */
export function appendMessage(input: AppendInput): ChatMessage {
	const db = getDb();
	const id = randomUUID();
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
				rawResponseJson: input.rawResponseJson ?? null,
				createdAt: now
			})
			.run();

		tx.update(conversations)
			.set({ activeLeafMessageId: id, updatedAt: now })
			.where(eq(conversations.id, input.conversationId))
			.run();
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
		createdAt: now
	};
}

/**
 * Walk the active branch root → leaf and return messages in order.
 *
 * Loads all messages for the conversation, then traverses the parent chain
 * from `active_leaf_message_id` backwards. Orphaned messages (from prior
 * "edit = truncate" operations) are still in the DB but aren't reachable
 * from active_leaf, so they're simply ignored by the walk.
 *
 * For v1 we expect conversations to be small (tens, not thousands of
 * messages). When that stops being true we'll switch to a recursive CTE.
 */
export function walkActiveBranch(conversationId: string): ChatMessage[] {
	const db = getDb();
	const conv = db
		.select({ activeLeaf: conversations.activeLeafMessageId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.get();

	if (!conv?.activeLeaf) return [];

	const rows = db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.all();
	const byId = new Map(rows.map((r) => [r.id, r]));

	// Group by parent_message_id so we can compute sibling counts /
	// positions for messages on the active branch in O(N) instead of
	// O(N) per active-branch entry.
	const byParent = new Map<string | null, typeof rows>();
	for (const r of rows) {
		const key = r.parentMessageId ?? null;
		const list = byParent.get(key);
		if (list) list.push(r);
		else byParent.set(key, [r]);
	}
	for (const list of byParent.values()) {
		list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	const ordered: ChatMessage[] = [];
	let current = byId.get(conv.activeLeaf);
	while (current) {
		const siblings = byParent.get(current.parentMessageId ?? null) ?? [current];
		const siblingIds = siblings.map((s) => s.id);
		const msg = rowToChatMessage(current);
		msg.parentMessageId = current.parentMessageId;
		msg.siblingCount = siblings.length;
		msg.siblingPosition = siblingIds.indexOf(current.id) + 1;
		msg.siblingIds = siblingIds;
		ordered.push(msg);
		if (!current.parentMessageId) break;
		current = byId.get(current.parentMessageId);
	}
	return ordered.reverse();
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
	messageId: string
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
			createdAt: messages.createdAt
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.all();

	const childrenByParent = new Map<string, typeof rows>();
	for (const r of rows) {
		if (!r.parentId) continue;
		const list = childrenByParent.get(r.parentId);
		if (list) list.push(r);
		else childrenByParent.set(r.parentId, [r]);
	}

	// Walk down picking the most recent child at each step.
	let cursor = messageId;
	while (true) {
		const children = childrenByParent.get(cursor);
		if (!children || children.length === 0) break;
		children.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
		cursor = children[0].id;
	}

	const now = Date.now();
	db.update(conversations)
		.set({ activeLeafMessageId: cursor, updatedAt: now })
		.where(eq(conversations.id, conversationId))
		.run();
	return { newActiveLeaf: cursor };
}

/** Fetch a single message scoped to a conversation. Used by retry — the
 * server needs to look up the assistant message being retried + its
 * parent user message. Includes parentMessageId on the returned object
 * (the walk path doesn't, since order encodes parent→child there). */
export function getMessage(
	conversationId: string,
	messageId: string
): ChatMessage | null {
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
				id: input.editedMessageId
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
				id: input.parentMessageId
			};
		}
		return { ok: true, parentMessageId: candidate.id };
	}
	return { ok: true, parentMessageId: input.activeLeafMessageId };
}

/** Direct active_leaf override — used by retry to point at the parent user
 * message before re-dispatching, so walkActiveBranch builds the upstream
 * request from the right history. */
export function setActiveLeafMessageId(
	conversationId: string,
	messageId: string
): void {
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
 * `{ refusedReason: 'no-siblings' }` if the message has no siblings (deleting
 * it would just truncate the conversation, which is a different operation
 * intentionally NOT exposed through this endpoint).
 *
 * On success, returns the deleted message ids and the new active_leaf.
 * The active_leaf is reassigned to a sibling's deepest descendant *before*
 * the delete fires, so the FK's ON DELETE SET NULL doesn't accidentally
 * orphan the conversation. Media refs for the deleted set are decremented
 * before the delete too, because message_media's ON DELETE CASCADE would
 * otherwise drop the join rows out from under our ref-counting.
 */
export function deleteBranch(
	conversationId: string,
	messageId: string,
	userId: string
):
	| {
			deletedIds: string[];
			newActiveLeaf: string;
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
				createdAt: messages.createdAt
			})
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.all();

		const target = all.find((r) => r.id === messageId);
		if (!target) return null;

		// Sibling check: messages sharing the same parent_message_id (including
		// null for a root sibling). Refuse if there's no replacement — UI
		// already gates this but defense-in-depth.
		const siblings = all.filter((r) => r.parentId === target.parentId && r.id !== messageId);
		if (siblings.length === 0) {
			return { refusedReason: 'no-siblings' as const };
		}

		// Collect the subtree rooted at messageId (inclusive) via BFS.
		const childrenByParent = new Map<string, typeof all>();
		for (const r of all) {
			if (!r.parentId) continue;
			const list = childrenByParent.get(r.parentId);
			if (list) list.push(r);
			else childrenByParent.set(r.parentId, [r]);
		}
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

		// Pick the replacement sibling and walk down to its deepest descendant
		// (greatest created_at, ties broken lexically) — that becomes the new
		// active_leaf. Same shape as selectBranch's walk.
		const replacement = siblings[0];
		let cursor = replacement.id;
		while (true) {
			const kids = childrenByParent.get(cursor);
			if (!kids || kids.length === 0) break;
			const sorted = [...kids].sort(
				(a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)
			);
			cursor = sorted[0].id;
		}

		// Order matters:
		//   1. active_leaf reassign (so the FK's ON DELETE SET NULL
		//      doesn't orphan the conversation when its leaf gets dropped)
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
			.set({ activeLeafMessageId: cursor, updatedAt: now })
			.where(eq(conversations.id, conversationId))
			.run();

		const deletedIds = [...toDelete];
		const toUnlink = hardDeleteOrphanGeneratedMediaForMessages(deletedIds, userId);
		decrementMediaForMessages(deletedIds);

		tx.delete(messages)
			.where(and(eq(messages.conversationId, conversationId), inArray(messages.id, deletedIds)))
			.run();

		return { deletedIds, newActiveLeaf: cursor, toUnlink };
	});
}

export function truncateAtMessage(
	conversationId: string,
	messageId: string
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
		.set({ activeLeafMessageId: newLeaf, updatedAt: now })
		.where(eq(conversations.id, conversationId))
		.run();
	return { newActiveLeaf: newLeaf };
}

function rowToChatMessage(row: typeof messages.$inferSelect): ChatMessage {
	let parts: MessagePart[];
	try {
		parts = JSON.parse(row.contentJson) as MessagePart[];
		if (!Array.isArray(parts)) parts = [];
	} catch {
		parts = [];
	}
	return {
		id: row.id,
		role: row.role,
		parts,
		contentHtml: row.contentHtml,
		reasoningText: row.reasoningText,
		finishReason: row.finishReason,
		modelUsed: row.modelUsed,
		tokensIn: row.tokensIn,
		tokensOut: row.tokensOut,
		createdAt: row.createdAt
	};
}
