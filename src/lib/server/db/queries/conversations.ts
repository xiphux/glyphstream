import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ConversationDetail, ConversationSummary, ModelKind } from '$lib/types/api';
import { getDb } from '../client';
import { conversations } from '../schema';
import { walkActiveBranch } from './messages';

interface CreateInput {
	userId: string;
	endpointId: string;
	modelId: string;
	modelKind: ModelKind | null;
	customModelId?: string | null;
	systemPrompt?: string | null;
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
		activeLeafMessageId: row.activeLeafMessageId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		messages: walkActiveBranch(id)
	};
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
			title: conversations.title,
			activeLeafMessageId: conversations.activeLeafMessageId
		})
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.get();
	return row ?? null;
}

/** Set conversation.title — used to auto-set from first message if empty. */
export function setConversationTitle(id: string, title: string): void {
	const db = getDb();
	db.update(conversations)
		.set({ title, updatedAt: Date.now() })
		.where(eq(conversations.id, id))
		.run();
}

export function deleteConversation(id: string, userId: string): boolean {
	const db = getDb();
	const r = db
		.delete(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.run();
	return r.changes > 0;
}
