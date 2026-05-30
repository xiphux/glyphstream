import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { CustomModel, CustomModelParameters, FeatureCategory } from '$lib/types/api';
import { getDb } from '../client';
import { customModels } from '../schema';
import { parseDisabledFeatures, parseModelParameters } from './json-columns';

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
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
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
	const id = randomUUID();
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
			updatedAt: now
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
		createdAt: now,
		updatedAt: now
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
	input: UpdateInput
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

export function deleteCustomModel(id: string, userId: string): boolean {
	const db = getDb();
	const r = db
		.delete(customModels)
		.where(and(eq(customModels.id, id), eq(customModels.userId, userId)))
		.run();
	// Existing conversations.customModelId FK has ON DELETE SET NULL, so
	// historical chats keep working but lose the back-link to the preset.
	return r.changes > 0;
}
