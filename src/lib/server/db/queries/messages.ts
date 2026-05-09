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

	const ordered: ChatMessage[] = [];
	let current = byId.get(conv.activeLeaf);
	while (current) {
		ordered.push(rowToChatMessage(current));
		if (!current.parentMessageId) break;
		current = byId.get(current.parentMessageId);
	}
	return ordered.reverse();
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
