import { and, asc, eq, isNull } from 'drizzle-orm';
import { generateId } from '../../util/id';
import type { CustomModel, CustomModelParameters, FeatureCategory } from '$lib/types/api';
import { getDb } from '../client';
import { customModels, media } from '../schema';
import { parseDisabledFeatures, parseModelParameters } from './json-columns';
import { linkAvatarMedia, unlinkAvatarMedia } from './media';

interface CreateInput {
	userId: string;
	name: string;
	description: string | null;
	baseEndpointId: string;
	baseModelId: string;
	systemPrompt: string | null;
	parameters: CustomModelParameters | null;
	/** Omit / pass [] for the historical default "all features on". */
	defaultDisabledFeatures?: FeatureCategory[];
}

interface UpdateInput {
	name?: string;
	description?: string | null;
	baseEndpointId?: string;
	baseModelId?: string;
	systemPrompt?: string | null;
	parameters?: CustomModelParameters | null;
	defaultDisabledFeatures?: FeatureCategory[];
}

function rowToCustomModel(row: typeof customModels.$inferSelect): CustomModel {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		baseEndpointId: row.baseEndpointId,
		baseModelId: row.baseModelId,
		systemPrompt: row.systemPrompt,
		parameters: parseModelParameters(row.parametersJson),
		defaultDisabledFeatures: parseDisabledFeatures(row.defaultDisabledFeaturesJson),
		avatarMediaId: row.avatarMediaId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

// Empty array stored as NULL so the DB shape matches conversations:
// a row that's never set defaults reads as NULL, not '[]'.
function encodeDisabledFeatures(list: FeatureCategory[]): string | null {
	return list.length > 0 ? JSON.stringify(list) : null;
}

export function listCustomModelsForUser(userId: string): CustomModel[] {
	const db = getDb();
	const rows = db
		.select()
		.from(customModels)
		.where(eq(customModels.userId, userId))
		.orderBy(asc(customModels.name))
		.all();
	return rows.map(rowToCustomModel);
}

export function getCustomModelForUser(id: string, userId: string): CustomModel | null {
	const db = getDb();
	const row = db
		.select()
		.from(customModels)
		.where(and(eq(customModels.id, id), eq(customModels.userId, userId)))
		.get();
	return row ? rowToCustomModel(row) : null;
}

export function createCustomModel(input: CreateInput): CustomModel {
	const db = getDb();
	const id = generateId();
	const now = Date.now();
	const defaultDisabledFeatures = input.defaultDisabledFeatures ?? [];
	db.insert(customModels)
		.values({
			id,
			userId: input.userId,
			name: input.name,
			description: input.description,
			baseEndpointId: input.baseEndpointId,
			baseModelId: input.baseModelId,
			systemPrompt: input.systemPrompt,
			parametersJson: input.parameters ? JSON.stringify(input.parameters) : null,
			defaultDisabledFeaturesJson: encodeDisabledFeatures(defaultDisabledFeatures),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return {
		id,
		name: input.name,
		description: input.description,
		baseEndpointId: input.baseEndpointId,
		baseModelId: input.baseModelId,
		systemPrompt: input.systemPrompt,
		parameters: input.parameters,
		defaultDisabledFeatures,
		// Avatars are never set at create time — the editor uploads or picks one
		// against an existing preset, so the single ref-counted write path
		// (`setCustomModelAvatar`) is the only thing that ever populates this.
		avatarMediaId: null,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Patch a custom model. Returns the updated row, or null if not found /
 * not owned. Existing conversations created with this preset are NOT
 * touched — their snapshot of system_prompt + parameters stays as it was
 * at chat-create time, matching how Claude/ChatGPT presets behave.
 */
export function updateCustomModel(
	id: string,
	userId: string,
	input: UpdateInput,
): CustomModel | null {
	const db = getDb();
	return db.transaction((tx) => {
		const existing = tx
			.select()
			.from(customModels)
			.where(and(eq(customModels.id, id), eq(customModels.userId, userId)))
			.get();
		if (!existing) return null;

		const patch: Partial<typeof customModels.$inferInsert> = { updatedAt: Date.now() };
		if (input.name !== undefined) patch.name = input.name;
		if (input.description !== undefined) patch.description = input.description;
		if (input.baseEndpointId !== undefined) patch.baseEndpointId = input.baseEndpointId;
		if (input.baseModelId !== undefined) patch.baseModelId = input.baseModelId;
		if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
		if (input.parameters !== undefined) {
			patch.parametersJson = input.parameters ? JSON.stringify(input.parameters) : null;
		}
		if (input.defaultDisabledFeatures !== undefined) {
			patch.defaultDisabledFeaturesJson = encodeDisabledFeatures(input.defaultDisabledFeatures);
		}

		tx.update(customModels).set(patch).where(eq(customModels.id, id)).run();
		const refreshed = tx.select().from(customModels).where(eq(customModels.id, id)).get();
		return refreshed ? rowToCustomModel(refreshed) : null;
	});
}

/**
 * Outcome of a `setCustomModelAvatar` call. Explicit rather than
 * `CustomModel | null` so the route can tell "no such preset" (404) from
 * "that media isn't yours / is tombstoned" (400) — collapsing them would make
 * a cross-user avatar id indistinguishable from a typo'd preset id.
 */
export type SetAvatarResult =
	{ ok: true; model: CustomModel } | { ok: false; reason: 'not_found' | 'media_not_found' };

/**
 * Set (or clear, with `mediaId = null`) a preset's avatar.
 *
 * The ONLY write path for `avatar_media_id` — deliberately not folded into
 * `updateCustomModel`, because every change here has to move a reference count
 * with it (`linkAvatarMedia` / `unlinkAvatarMedia`), and two ways to set the
 * column would be two places to get that bookkeeping wrong.
 *
 * Setting the avatar it already has is a no-op that still returns ok: the
 * ref-count helpers aren't idempotent (no join-table PK to absorb a repeat), so
 * a double-set would otherwise inflate the count and pin the media forever.
 */
export function setCustomModelAvatar(
	id: string,
	userId: string,
	mediaId: string | null,
): SetAvatarResult {
	const db = getDb();
	return db.transaction((tx): SetAvatarResult => {
		const existing = tx
			.select()
			.from(customModels)
			.where(and(eq(customModels.id, id), eq(customModels.userId, userId)))
			.get();
		if (!existing) return { ok: false, reason: 'not_found' };
		if (existing.avatarMediaId === mediaId) return { ok: true, model: rowToCustomModel(existing) };

		if (mediaId !== null) {
			// Scoped to the caller AND to a live row, in the same transaction that
			// takes the reference. The user-scoping is the multi-user isolation
			// invariant (an avatar id is user-supplied); the `hard_deleted_at`
			// check stops a preset adopting a tombstone whose bytes are gone.
			const row = tx
				.select({ id: media.id })
				.from(media)
				.where(and(eq(media.id, mediaId), eq(media.userId, userId), isNull(media.hardDeletedAt)))
				.get();
			if (!row) return { ok: false, reason: 'media_not_found' };
		}

		if (existing.avatarMediaId !== null) unlinkAvatarMedia(tx, existing.avatarMediaId);
		if (mediaId !== null) linkAvatarMedia(tx, mediaId);

		tx.update(customModels)
			.set({ avatarMediaId: mediaId, updatedAt: Date.now() })
			.where(eq(customModels.id, id))
			.run();
		const refreshed = tx.select().from(customModels).where(eq(customModels.id, id)).get();
		return refreshed
			? { ok: true, model: rowToCustomModel(refreshed) }
			: { ok: false, reason: 'not_found' };
	});
}

export function deleteCustomModel(id: string, userId: string): boolean {
	const db = getDb();
	return db.transaction((tx) => {
		// Read the avatar before the row goes, so the reference is released rather
		// than stranded. Skipping this would pin an uploaded avatar in the store
		// forever (ref_count never returns to zero, so the purger never sees it)
		// and keep it excluded from the conversation-delete orphan analysis on
		// behalf of a preset that no longer exists.
		const existing = tx
			.select({ avatarMediaId: customModels.avatarMediaId })
			.from(customModels)
			.where(and(eq(customModels.id, id), eq(customModels.userId, userId)))
			.get();
		const r = tx
			.delete(customModels)
			.where(and(eq(customModels.id, id), eq(customModels.userId, userId)))
			.run();
		if (r.changes === 0) return false;
		if (existing?.avatarMediaId) unlinkAvatarMedia(tx, existing.avatarMediaId);
		// Existing conversations.customModelId FK has ON DELETE SET NULL, so
		// historical chats keep working but lose the back-link to the preset.
		return true;
	});
}
