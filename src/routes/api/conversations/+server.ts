import { error, json } from '@sveltejs/kit';
import {
	createConversation,
	listConversations
} from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import { getEndpoint, parseModelId } from '$lib/server/endpoints/registry';
import type {
	CreateConversationRequest,
	CustomModelParameters,
	ModelKind
} from '$lib/types/api';
import type { RequestHandler } from './$types';

const VALID_KINDS: readonly ModelKind[] = ['chat', 'embedding', 'image', 'video'];

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	return json({ conversations: listConversations(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let body: CreateConversationRequest;
	try {
		body = (await request.json()) as CreateConversationRequest;
	} catch {
		throw error(400, 'Request body must be JSON');
	}

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
		// Caller still tells us the kind so the dispatcher knows which path
		// to take; the picker has it on hand and forwarding it saves a
		// re-fetch of upstream /v1/models on the server.
		if (body.modelKind !== undefined) {
			if (!(VALID_KINDS as readonly string[]).includes(body.modelKind)) {
				throw error(400, `Invalid modelKind "${body.modelKind}"`);
			}
			resolvedModelKind = body.modelKind;
		}
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
		// System prompt resolution order: explicit body value > user-level
		// default preference > null. The custom-model branch above always
		// snapshots from the preset, so this only matters when starting a
		// fresh chat against a base model directly.
		const explicit = body.systemPrompt?.trim();
		if (explicit) {
			resolvedSystemPrompt = explicit;
		} else {
			const prefs = getUserPreferences(locals.user.id);
			const def = prefs?.systemPrompt.trim();
			resolvedSystemPrompt = def ? def : null;
		}
		if (body.modelKind !== undefined) {
			if (!(VALID_KINDS as readonly string[]).includes(body.modelKind)) {
				throw error(400, `Invalid modelKind "${body.modelKind}"`);
			}
			resolvedModelKind = body.modelKind;
		}
	}

	const conv = createConversation({
		userId: locals.user.id,
		endpointId: resolvedEndpointId,
		modelId: resolvedModelId,
		modelKind: resolvedModelKind,
		systemPrompt: resolvedSystemPrompt,
		parameters: resolvedParameters,
		customModelId: resolvedCustomModelId,
		title: body.title?.trim() || null
	});
	return json({ conversation: conv }, { status: 201 });
};
