import { error, json } from '@sveltejs/kit';
import {
	createConversation,
	listConversations
} from '$lib/server/db/queries/conversations';
import { getEndpoint, parseModelId } from '$lib/server/endpoints/registry';
import type { CreateConversationRequest } from '$lib/types/api';
import type { RequestHandler } from './$types';

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

	const modelId = body.modelId?.trim();
	if (!modelId) throw error(400, "'modelId' is required");

	const parsed = parseModelId(modelId);
	if (!parsed) {
		throw error(400, `Malformed model id "${modelId}" — must be "{endpoint_id}::{upstream_id}"`);
	}
	const endpoint = getEndpoint(parsed.endpointId);
	if (!endpoint) {
		throw error(400, `Unknown endpoint "${parsed.endpointId}" — not in config.toml`);
	}

	const conv = createConversation({
		userId: locals.user.id,
		endpointId: parsed.endpointId,
		modelId,
		systemPrompt: body.systemPrompt?.trim() || null,
		customModelId: body.customModelId ?? null,
		title: body.title?.trim() || null
	});
	return json({ conversation: conv }, { status: 201 });
};
