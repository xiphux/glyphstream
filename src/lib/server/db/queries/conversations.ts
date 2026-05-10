import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type {
	ConversationDetail,
	ConversationSummary,
	CustomModelParameters,
	ModelKind
} from '$lib/types/api';
import { getDb } from '../client';
import { conversations } from '../schema';
import { walkActiveBranch } from './messages';
import { decrementMediaForMessages, listMessageIdsForConversation } from './media';

interface CreateInput {
	userId: string;
	endpointId: string;
	modelId: string;
	modelKind: ModelKind | null;
	customModelId?: string | null;
	systemPrompt?: string | null;
	parameters?: CustomModelParameters | null;
	title?: string | null;
}

export function createConversation(input: CreateInput): ConversationDetail {
	const db = getDb();
	const id = randomUUID();
	const now = Date.now();
	db.insert(conversations)
		.values({
			id,
			userId: input.userId,
			endpointId: input.endpointId,
			modelId: input.modelId,
			modelKind: input.modelKind,
			customModelId: input.customModelId ?? null,
			systemPrompt: input.systemPrompt ?? null,
			parametersJson: input.parameters ? JSON.stringify(input.parameters) : null,
			title: input.title ?? null,
			activeLeafMessageId: null,
			createdAt: now,
			updatedAt: now,
			archivedAt: null
		})
		.run();
	return {
		id,
		title: input.title ?? null,
		modelId: input.modelId,
		modelKind: input.modelKind,
		endpointId: input.endpointId,
		customModelId: input.customModelId ?? null,
		systemPrompt: input.systemPrompt ?? null,
		parameters: input.parameters ?? null,
		activeLeafMessageId: null,
		createdAt: now,
		updatedAt: now,
		messages: []
	};
}

export function listConversations(userId: string): ConversationSummary[] {
	const db = getDb();
	return db
		.select({
			id: conversations.id,
			title: conversations.title,
			modelId: conversations.modelId,
			createdAt: conversations.createdAt,
			updatedAt: conversations.updatedAt
		})
		.from(conversations)
		.where(and(eq(conversations.userId, userId), isNull(conversations.archivedAt)))
		.orderBy(desc(conversations.updatedAt))
		.all();
}

export function listArchivedConversations(userId: string): ConversationSummary[] {
	const db = getDb();
	return db
		.select({
			id: conversations.id,
			title: conversations.title,
			modelId: conversations.modelId,
			createdAt: conversations.createdAt,
			updatedAt: conversations.updatedAt
		})
		.from(conversations)
		.where(and(eq(conversations.userId, userId), isNotNull(conversations.archivedAt)))
		.orderBy(desc(conversations.updatedAt))
		.all();
}

/**
 * Archive / unarchive flip the `archived_at` timestamp without touching
 * `updated_at` — archiving isn't a content change, and we want archived
 * conversations to keep sorting by their actual last-activity time so
 * "find that old Python chat I archived" works the way the user expects.
 */
export function archiveConversation(id: string, userId: string): boolean {
	const db = getDb();
	const res = db
		.update(conversations)
		.set({ archivedAt: Date.now() })
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.run();
	return res.changes > 0;
}

export function unarchiveConversation(id: string, userId: string): boolean {
	const db = getDb();
	const res = db
		.update(conversations)
		.set({ archivedAt: null })
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.run();
	return res.changes > 0;
}

/** Returns the conversation with active-branch messages. Null if not found OR not owned by `userId`. */
export function getConversationDetail(
	id: string,
	userId: string
): ConversationDetail | null {
	const db = getDb();
	const row = db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.get();
	if (!row) return null;

	return {
		id: row.id,
		title: row.title,
		modelId: row.modelId,
		modelKind: row.modelKind,
		endpointId: row.endpointId,
		customModelId: row.customModelId,
		systemPrompt: row.systemPrompt,
		parameters: parseParameters(row.parametersJson),
		activeLeafMessageId: row.activeLeafMessageId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		messages: walkActiveBranch(id)
	};
}

function parseParameters(json: string | null): CustomModelParameters | null {
	if (!json) return null;
	try {
		return JSON.parse(json) as CustomModelParameters;
	} catch {
		return null;
	}
}

/** Light fetch (no messages walk) — used when we just need to verify ownership and look up endpoint/model. */
export function getConversationMeta(
	id: string,
	userId: string
): {
	id: string;
	endpointId: string;
	modelId: string;
	modelKind: ModelKind | null;
	systemPrompt: string | null;
	parameters: CustomModelParameters | null;
	title: string | null;
	activeLeafMessageId: string | null;
} | null {
	const db = getDb();
	const row = db
		.select({
			id: conversations.id,
			endpointId: conversations.endpointId,
			modelId: conversations.modelId,
			modelKind: conversations.modelKind,
			systemPrompt: conversations.systemPrompt,
			parametersJson: conversations.parametersJson,
			title: conversations.title,
			activeLeafMessageId: conversations.activeLeafMessageId
		})
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.get();
	if (!row) return null;
	return {
		id: row.id,
		endpointId: row.endpointId,
		modelId: row.modelId,
		modelKind: row.modelKind,
		systemPrompt: row.systemPrompt,
		parameters: parseParameters(row.parametersJson),
		title: row.title,
		activeLeafMessageId: row.activeLeafMessageId
	};
}

/** Set conversation.title — used to auto-set from first message if empty. */
export function setConversationTitle(id: string, title: string): void {
	const db = getDb();
	db.update(conversations)
		.set({ title, updatedAt: Date.now() })
		.where(eq(conversations.id, id))
		.run();
}

/**
 * Delete a conversation and decrement ref counts for any media referenced
 * by its messages. The schema's FK cascade (conversations → messages →
 * message_media) drops the join rows but bypasses Drizzle, so without an
 * explicit decrement step `media.ref_count` would stay inflated forever
 * and the purger would never collect the underlying files.
 */
export function deleteConversation(id: string, userId: string): boolean {
	const db = getDb();
	return db.transaction((tx) => {
		// Ownership check first so we don't decrement on someone else's media.
		const owned = tx
			.select({ id: conversations.id })
			.from(conversations)
			.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
			.get();
		if (!owned) return false;

		const messageIds = listMessageIdsForConversation(id);
		decrementMediaForMessages(messageIds);

		tx.delete(conversations).where(eq(conversations.id, id)).run();
		return true;
	});
}
