import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { ChatMessage, MessagePart, MessageRole } from '$lib/types/api';
import { getDb } from '../client';
import { conversations, messages } from '../schema';

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
