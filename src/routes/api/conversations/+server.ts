import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	createConversation,
	listConversations
} from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import {
	composePersonaSystemPrompt,
	getUserPreferences
} from '$lib/server/db/queries/user-preferences';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { isModelKind } from '$lib/types/api';
import type {
	CreateConversationRequest,
	CustomModelParameters,
	ModelKind
} from '$lib/types/api';
import {
	FeatureCategoryValidationError,
	validateDisabledFeatures
} from '$lib/server/util/feature-categories';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ conversations: listConversations(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<CreateConversationRequest>(request);

	// Resolve custom model first if supplied — its base endpoint/model wins
	// over any modelId in the body. Snapshot the system prompt + parameters
	// onto the conversation so future edits to the preset don't retroactively
	// change in-flight chats.
	let resolvedEndpointId: string;
	let resolvedModelId: string;
	let resolvedModelKind: ModelKind | null = null;
	let resolvedSystemPrompt: string | null = null;
	let resolvedParameters: CustomModelParameters | null = null;
	let resolvedCustomModelId: string | null = null;

	// modelKind is optional and validated identically whether a custom
	// model or a base model id was supplied — the caller forwards it so
	// the send dispatcher knows the chat/image/video path without
	// re-fetching upstream /v1/models. Resolve it once here.
	if (body.modelKind !== undefined) {
		if (!isModelKind(body.modelKind)) {
			throw error(400, `Invalid modelKind "${body.modelKind}"`);
		}
		resolvedModelKind = body.modelKind;
	}

	if (body.customModelId) {
		const cm = getCustomModelForUser(body.customModelId, locals.user.id);
		if (!cm) throw error(400, `Unknown custom model "${body.customModelId}"`);
		if (!getEndpoint(cm.baseEndpointId)) {
			throw error(
				400,
				`Custom model references unknown endpoint "${cm.baseEndpointId}" — has it been removed from config.toml?`
			);
		}
		resolvedEndpointId = cm.baseEndpointId;
		resolvedModelId = `${cm.baseEndpointId}::${cm.baseModelId}`;
		resolvedSystemPrompt = cm.systemPrompt;
		resolvedParameters = cm.parameters;
		resolvedCustomModelId = cm.id;
	} else {
		const modelId = body.modelId?.trim();
		if (!modelId) throw error(400, "'modelId' or 'customModelId' is required");

		const parsed = parseModelId(modelId);
		if (!parsed) {
			throw error(
				400,
				`Malformed model id "${modelId}" — must be "{endpoint_id}::{upstream_id}"`
			);
		}
		if (!getEndpoint(parsed.endpointId)) {
			throw error(400, `Unknown endpoint "${parsed.endpointId}" — not in config.toml`);
		}
		resolvedEndpointId = parsed.endpointId;
		resolvedModelId = modelId;
		// System prompt resolution order: explicit body value > composed
		// persona (from the user's name / aboutYou / customInstructions
		// preference fields) > null. The custom-model branch above always
		// snapshots from the preset, so this only matters when starting a
		// fresh chat against a base model directly.
		const explicit = body.systemPrompt?.trim();
		if (explicit) {
			resolvedSystemPrompt = explicit;
		} else {
			const prefs = getUserPreferences(locals.user.id);
			resolvedSystemPrompt = prefs ? composePersonaSystemPrompt(prefs) : null;
		}
	}

	let disabledFeatures;
	try {
		disabledFeatures = validateDisabledFeatures(body.disabledFeatures);
	} catch (e) {
		if (e instanceof FeatureCategoryValidationError) throw error(400, e.message);
		throw e;
	}

	const conv = createConversation({
		userId: locals.user.id,
		endpointId: resolvedEndpointId,
		modelId: resolvedModelId,
		modelKind: resolvedModelKind,
		systemPrompt: resolvedSystemPrompt,
		parameters: resolvedParameters,
		customModelId: resolvedCustomModelId,
		title: body.title?.trim() || null,
		disabledFeatures
	});
	return json({ conversation: conv }, { status: 201 });
};
