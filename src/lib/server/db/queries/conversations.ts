import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { MAX_CONVERSATION_TITLE_LENGTH } from '$lib/types/api';
import type {
	ConversationDetail,
	ConversationSummary,
	CustomModelParameters,
	FeatureCategory,
	ModelKind,
} from '$lib/types/api';
import { getDb } from '../client';
import { conversations, messages } from '../schema';
import { reconcileOverviewAfterConversationDelete } from './users';
import { parseDisabledFeatures, parseMessageParts, parseModelParameters } from './json-columns';
import { walkActiveBranch } from './messages';
import {
	decrementMediaForMessages,
	hardDeleteOrphanGeneratedMediaForMessages,
	listMessageIdsForConversation,
} from './media';

/**
 * Maximum number of conversations returned by the sidebar listing queries.
 * The sidebar can't usefully show more than this — the FTS search modal
 * (`SearchModal`) covers the long tail. Same cap for active and archived
 * listings so both surfaces stay bounded.
 */
const SIDEBAR_CONVERSATION_LIMIT = 150;

export type TitleSource = 'fallback' | 'ai' | 'user';

interface CreateInput {
	userId: string;
	endpointId: string;
	modelId: string;
	modelKind: ModelKind | null;
	customModelId?: string | null;
	systemPrompt?: string | null;
	parameters?: CustomModelParameters | null;
	title?: string | null;
	disabledFeatures?: FeatureCategory[] | null;
	// "Private chat" content seal (see schema.ts). Set once at create time,
	// never mutated. Airgaps the conversation from the cross-conversation stores.
	private?: boolean;
}

export function createConversation(input: CreateInput): ConversationDetail {
	const db = getDb();
	const id = generateId();
	const now = Date.now();
	const disabledFeatures = input.disabledFeatures ?? [];
	const isPrivate = input.private ?? false;
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
			archivedAt: null,
			disabledFeaturesJson: disabledFeatures.length ? JSON.stringify(disabledFeatures) : null,
			private: isPrivate,
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
		messages: [],
		disabledFeatures,
		private: isPrivate,
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
			updatedAt: conversations.updatedAt,
			private: conversations.private,
		})
		.from(conversations)
		.where(and(eq(conversations.userId, userId), isNull(conversations.archivedAt)))
		.orderBy(desc(conversations.updatedAt))
		.limit(SIDEBAR_CONVERSATION_LIMIT)
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
			updatedAt: conversations.updatedAt,
			private: conversations.private,
		})
		.from(conversations)
		.where(and(eq(conversations.userId, userId), isNotNull(conversations.archivedAt)))
		.orderBy(desc(conversations.updatedAt))
		.limit(SIDEBAR_CONVERSATION_LIMIT)
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

/**
 * Update the model/endpoint/kind a conversation will use for its next turn.
 *
 * Touches ONLY routing fields. `system_prompt`, `parameters_json`, and
 * `custom_model_id` are intentionally preserved — switching *model* doesn't
 * change *persona*. If the conversation was created from a custom preset,
 * its persona stays even after you pivot to a different base model.
 *
 * Also bumps `updated_at` so the sidebar's newest-first ordering reflects
 * that the user just interacted with the conversation.
 *
 * Returns `true` on success, `false` if no row matched (wrong id or
 * ownership mismatch).
 */
export function updateConversationModel(
	id: string,
	userId: string,
	patch: { endpointId: string; modelId: string; modelKind: ModelKind | null },
): boolean {
	const db = getDb();
	const res = db
		.update(conversations)
		.set({
			endpointId: patch.endpointId,
			modelId: patch.modelId,
			modelKind: patch.modelKind,
			updatedAt: Date.now(),
		})
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.run();
	return res.changes > 0;
}

/**
 * Mark this conversation as having an unresolved multi-model fan-out parked
 * on `parentMessageId` (the shared user message). The page load reads this to
 * rehydrate the compare grid after a reload. Cleared when the fan-out resolves
 * (selectBranch on a pick / dismiss / continue).
 */
export function setFanoutParent(
	conversationId: string,
	userId: string,
	parentMessageId: string,
): void {
	getDb()
		.update(conversations)
		.set({ fanoutParentMessageId: parentMessageId })
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.run();
}

/** The parked fan-out's shared user-message id, or null when none / not owned. */
export function getFanoutParent(conversationId: string, userId: string): string | null {
	const row = getDb()
		.select({ p: conversations.fanoutParentMessageId })
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.get();
	return row?.p ?? null;
}

/** Returns the conversation with active-branch messages. Null if not found OR not owned by `userId`. */
export function getConversationDetail(id: string, userId: string): ConversationDetail | null {
	const db = getDb();
	const row = db
		.select({
			id: conversations.id,
			title: conversations.title,
			modelId: conversations.modelId,
			modelKind: conversations.modelKind,
			endpointId: conversations.endpointId,
			customModelId: conversations.customModelId,
			systemPrompt: conversations.systemPrompt,
			parametersJson: conversations.parametersJson,
			activeLeafMessageId: conversations.activeLeafMessageId,
			createdAt: conversations.createdAt,
			updatedAt: conversations.updatedAt,
			disabledFeaturesJson: conversations.disabledFeaturesJson,
			private: conversations.private,
		})
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
		parameters: parseModelParameters(row.parametersJson),
		activeLeafMessageId: row.activeLeafMessageId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		messages: walkActiveBranch(id),
		disabledFeatures: parseDisabledFeatures(row.disabledFeaturesJson),
		private: row.private,
	};
}

/** Light fetch (no messages walk) — used when we just need to verify ownership and look up endpoint/model. */
export function getConversationMeta(
	id: string,
	userId: string,
): {
	id: string;
	endpointId: string;
	modelId: string;
	modelKind: ModelKind | null;
	systemPrompt: string | null;
	parameters: CustomModelParameters | null;
	title: string | null;
	activeLeafMessageId: string | null;
	disabledFeatures: FeatureCategory[];
	private: boolean;
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
			activeLeafMessageId: conversations.activeLeafMessageId,
			disabledFeaturesJson: conversations.disabledFeaturesJson,
			private: conversations.private,
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
		parameters: parseModelParameters(row.parametersJson),
		title: row.title,
		activeLeafMessageId: row.activeLeafMessageId,
		disabledFeatures: parseDisabledFeatures(row.disabledFeaturesJson),
		private: row.private,
	};
}

/**
 * Replace the per-conversation feature opt-out list. Empty array → null in
 * the DB (canonical "all features on" state, matches absence). Scoped by
 * `userId` for ownership; returns true on success, false if no row matched
 * (404 / wrong owner). Doesn't bump `updated_at` — flipping a privacy
 * toggle isn't a content change and shouldn't reshuffle the sidebar.
 */
export function setDisabledFeatures(
	id: string,
	userId: string,
	features: FeatureCategory[],
): boolean {
	const db = getDb();
	const res = db
		.update(conversations)
		.set({
			disabledFeaturesJson: features.length ? JSON.stringify(features) : null,
		})
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.run();
	return res.changes > 0;
}

/**
 * Set conversation.title and update the `titleSource` provenance marker.
 * The source defaults to 'fallback' to preserve the original callsite
 * behavior (auto-set first-N-chars preview at message-create time).
 *
 * Callers that have just learned the *origin* of the title should pass the
 * appropriate source so the title-gen state machine reads correctly:
 *   - 'fallback' (default): truncated user text preview
 *   - 'ai': set by the task model
 *   - 'user': manual rename
 *
 * Prefer the more specific helpers (`setConversationTitleIfFallback`,
 * `renameConversation`) when you need precedence semantics; this raw setter
 * is unconditional (no title_source guard). Scoped by `userId` for ownership.
 */
export function setConversationTitle(
	id: string,
	userId: string,
	title: string,
	opts: { source?: TitleSource } = {},
): void {
	const db = getDb();
	db.update(conversations)
		.set({ title, titleSource: opts.source ?? 'fallback', updatedAt: Date.now() })
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.run();
}

/**
 * Conversations the background summary pass should (re)summarize this sweep:
 * never-summarized OR changed since their last summary (`updated_at >
 * summarized_at`), AND *settled* — no activity for `settleMs`, so we never
 * summarize a conversation mid-exchange — AND carrying a real exchange (≥2
 * messages; a lone user message has no gist worth indexing). Oldest-activity
 * first so the longest-stale get caught up first. Cross-user (background job);
 * includes archived conversations, matching what search already surfaces.
 *
 * Deliberately NOT filtered by the per-conversation `personalization` opt-out.
 * That toggle is a *consumption* gate (don't inject persona/memory/overview into
 * THIS chat, don't offer the personalization tools) — not a content seal: a
 * personalization-off chat still contributes to the user's own searchable history
 * + topic overview, which are only ever consumed by personalization-ON chats.
 *
 * It IS filtered by the per-conversation `private` flag — the content seal. A
 * private chat never gets summarized, so it produces no `summary` (no topic-overview
 * contribution, no kind='summary' FTS row). The paired seal on the read side is
 * `searchConversations({excludePrivate:true})` on the tool path (search.ts).
 */
export function listConversationsNeedingSummary(
	now: number,
	settleMs: number,
	limit: number,
): Array<{ id: string }> {
	const db = getDb();
	return db
		.select({ id: conversations.id })
		.from(conversations)
		.where(
			and(
				eq(conversations.private, false),
				or(
					isNull(conversations.summarizedAt),
					gt(conversations.updatedAt, conversations.summarizedAt),
				),
				lt(conversations.updatedAt, now - settleMs),
				sql`(select count(*) from ${messages} where ${messages.conversationId} = ${conversations.id}) >= 2`,
			),
		)
		.orderBy(asc(conversations.updatedAt))
		.limit(limit)
		.all();
}

/**
 * Every non-null conversation summary for a user, ordered `created_at ASC` — the
 * input to an overview rebuild. Creation order (stable across re-summarization,
 * unlike `summarized_at`) keeps the rebuilt overview from reshuffling each pass.
 */
export function listConversationSummariesForOverview(userId: string): string[] {
	const db = getDb();
	return db
		.select({ summary: conversations.summary })
		.from(conversations)
		.where(and(eq(conversations.userId, userId), isNotNull(conversations.summary)))
		.orderBy(asc(conversations.createdAt))
		.all()
		.map((r) => r.summary as string);
}

/**
 * Write a conversation's summary + advance its watermark. Deliberately does NOT
 * touch `updated_at`: the summary pass compares `updated_at > summarized_at` to
 * decide re-summarization, so bumping `updated_at` here would make every
 * conversation perpetually due (the same watermark trap as `restoreMemory`).
 * Cross-user (background job, keyed by the PK). `summary` may be null to stamp
 * the watermark for a conversation with nothing summarizable (e.g. image-only),
 * so it isn't reconsidered every sweep.
 */
export function setConversationSummary(
	id: string,
	summary: string | null,
	summarizedAt: number,
): void {
	const db = getDb();
	db.update(conversations).set({ summary, summarizedAt }).where(eq(conversations.id, id)).run();
}

/**
 * Lightweight read of just the title_source field — used to gate
 * AI title generation so we only fire on the *first* exchange in a
 * conversation. After the AI title lands the source becomes 'ai';
 * after a user rename it becomes 'user'; either of those means
 * "don't run title gen again." Returns null when the conversation
 * doesn't exist.
 */
export function getConversationTitleSource(id: string, userId: string): TitleSource | null {
	const db = getDb();
	const row = db
		.select({ titleSource: conversations.titleSource })
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.get();
	return row ? row.titleSource : null;
}

/**
 * Conditional UPDATE that only writes the AI-generated title when the
 * conversation still has a `'fallback'` source. The atomic
 * `WHERE title_source = 'fallback'` clause is the race-free guard against
 * overwriting a user-set title — if the user renamed between when the
 * task model started and finished, the conditional UPDATE matches 0
 * rows and the AI title is silently discarded.
 *
 * SQLite is single-writer, so this is genuinely atomic without locking.
 * Returns true when the row was updated, false otherwise (already AI,
 * already user-set, or conversation not found).
 */
export function setConversationTitleIfFallback(
	id: string,
	userId: string,
	aiTitle: string,
): boolean {
	const db = getDb();
	const res = db
		.update(conversations)
		.set({ title: aiTitle, titleSource: 'ai', updatedAt: Date.now() })
		.where(
			and(
				eq(conversations.id, id),
				eq(conversations.userId, userId),
				eq(conversations.titleSource, 'fallback'),
			),
		)
		.run();
	return res.changes > 0;
}

/**
 * User-initiated rename. Scoped by `userId` (ownership check) and validates
 * the trimmed title is 1-200 chars. Sets `titleSource = 'user'`, which
 * locks the title against any future AI overwrite via
 * setConversationTitleIfFallback. Returns false on ownership mismatch
 * (404) or no-op (already same title); validation errors throw so the
 * caller can surface them as 400.
 */
export class RenameValidationError extends Error {}

export function renameConversation(id: string, userId: string, newTitle: string): boolean {
	const trimmed = newTitle.trim();
	if (trimmed.length === 0) {
		throw new RenameValidationError('Title cannot be empty');
	}
	if (trimmed.length > MAX_CONVERSATION_TITLE_LENGTH) {
		throw new RenameValidationError(
			`Title cannot exceed ${MAX_CONVERSATION_TITLE_LENGTH} characters`,
		);
	}
	const db = getDb();
	const res = db
		.update(conversations)
		.set({ title: trimmed, titleSource: 'user', updatedAt: Date.now() })
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.run();
	return res.changes > 0;
}

/**
 * Read the first user message and first assistant response for a
 * conversation, used as input to the title generator. The "first
 * exchange" is identified structurally: the root user message (the one
 * with parent_message_id NULL) and any direct child of it that has role
 * 'assistant'. Title gen runs exactly once per conversation (gated by
 * title_source != 'fallback' check upstream), so we don't worry about
 * branching here — at title-gen time there is exactly one path.
 *
 * Returns null if the conversation has no messages yet (shouldn't happen
 * at call time, but defensive). `assistantParts` is null when only the
 * user message exists (multimodal in-flight: the asset hasn't landed).
 */
export interface FirstExchange {
	userText: string;
	userMediaKinds: ('image' | 'video')[];
	assistantText: string | null;
	assistantHasMedia: boolean;
}

export function getConversationFirstExchange(id: string, userId: string): FirstExchange | null {
	const db = getDb();
	// Ownership guard: this pivots on messages by conversation_id (messages
	// carry no user_id of their own), so confirm the conversation belongs to
	// `userId` before reading any of its messages.
	const owned = db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
		.get();
	if (!owned) return null;

	const rootUser = db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, id),
				isNull(messages.parentMessageId),
				eq(messages.role, 'user'),
			),
		)
		.orderBy(asc(messages.createdAt))
		.get();
	if (!rootUser) return null;

	const firstAssistant = db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, id),
				eq(messages.parentMessageId, rootUser.id),
				eq(messages.role, 'assistant'),
			),
		)
		.orderBy(asc(messages.createdAt))
		.get();

	const userParts = parseMessageParts(rootUser.contentJson);
	const userText = userParts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('');
	const userMediaKinds = userParts
		.map((p) => p.type)
		.filter((t): t is 'image' | 'video' => t === 'image' || t === 'video');

	let assistantText: string | null = null;
	let assistantHasMedia = false;
	if (firstAssistant) {
		const aParts = parseMessageParts(firstAssistant.contentJson);
		assistantText = aParts
			.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
			.map((p) => p.text)
			.join('');
		assistantHasMedia = aParts.some((p) => p.type === 'image' || p.type === 'video');
	}

	return { userText, userMediaKinds, assistantText, assistantHasMedia };
}

/**
 * Delete a conversation and decrement ref counts for any media referenced
 * by its messages. The schema's FK cascade (conversations → messages →
 * message_media) drops the join rows but bypasses Drizzle, so without an
 * explicit decrement step `media.ref_count` would stay inflated and the
 * purger (or, for generated media, the explicit delete path) wouldn't
 * know to collect them.
 *
 * When `deleteMedia` is true, also hard-deletes generated media that
 * would orphan as a result — i.e. media whose only references are in
 * this conversation. Uploaded media is unaffected regardless (it
 * follows the purger's own auto-sweep schedule under the library
 * model). Returns the list of disk paths the caller should unlink
 * *after* the DB transaction commits; unlinking inside the txn would
 * mean a rolled-back transaction could leave files deleted from disk
 * but still referenced from the DB.
 *
 * Caller is responsible for actually unlinking the returned paths via
 * the MediaStore — see the DELETE handler in
 * src/routes/api/conversations/[id]/+server.ts.
 */
export function deleteConversation(
	id: string,
	userId: string,
	opts: { deleteMedia?: boolean } = {},
): { ok: boolean; toUnlink: Array<{ id: string; storagePath: string }> } {
	const db = getDb();
	return db.transaction((tx) => {
		// Ownership check first so we don't decrement on someone else's media.
		// Grab `summary` too: if this conversation contributed to the user's topic
		// overview, we reconcile it after the delete.
		const owned = tx
			.select({ id: conversations.id, summary: conversations.summary })
			.from(conversations)
			.where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
			.get();
		if (!owned) return { ok: false, toUnlink: [] };

		// Order matters: identify-and-mark orphan media FIRST (while
		// ref_counts still reflect the pre-decrement state — the orphan
		// detection compares ref_count to local link count), then decrement,
		// then cascade-delete the conversation.
		const messageIds = listMessageIdsForConversation(id);
		const toUnlink = opts.deleteMedia
			? hardDeleteOrphanGeneratedMediaForMessages(tx, messageIds, userId)
			: [];
		decrementMediaForMessages(tx, messageIds);

		tx.delete(conversations).where(eq(conversations.id, id)).run();
		// A summarized conversation fed the topic overview — drop its topics from it
		// (clear if it was the last summarized one, else re-flag for rebuild).
		if (owned.summary !== null) reconcileOverviewAfterConversationDelete(userId, tx);
		return { ok: true, toUnlink };
	});
}
