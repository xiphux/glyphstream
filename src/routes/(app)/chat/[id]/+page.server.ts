import { error } from '@sveltejs/kit';
import { getConversationDetail } from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import { listUpstreamModels } from '$lib/server/endpoints/client';
import { ConfigError } from '$lib/server/endpoints/config';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';
import { normalizeUpstreamModel } from '$lib/server/endpoints/models';
import { listEndpoints } from '$lib/server/endpoints/registry';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const conversation = getConversationDetail(params.id, locals.user.id);
	if (!conversation) throw error(404, 'Conversation not found');

	// Friendly label for the assistant in message bubbles. Custom models
	// win because the user named them; otherwise we strip the verbose
	// "endpoint::owner/model" prefix down to just the recognizable slug.
	let assistantLabel = friendlyModelName(conversation.modelId);
	if (conversation.customModelId) {
		const cm = getCustomModelForUser(conversation.customModelId, locals.user.id);
		if (cm) assistantLabel = cm.name;
	}

	// Aggregated model list for the per-turn picker in the composer. Mirrors
	// the new-chat page's loader so the picker has options on first paint
	// — a misconfigured endpoint or unreachable upstream silently degrades
	// to `[]` for that endpoint (not a hard failure), since the typical
	// case is "keep chatting with the existing model" and the picker is
	// only material when the user *wants* to switch.
	let endpoints;
	try {
		endpoints = listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			return { conversation, assistantLabel, models: [] };
		}
		throw e;
	}
	const modelResults = await Promise.all(
		endpoints.map(async (endpoint) => {
			try {
				const upstream = await listUpstreamModels(endpoint);
				return upstream.map((m) => normalizeUpstreamModel(endpoint, m));
			} catch {
				return [];
			}
		})
	);

	return { conversation, assistantLabel, models: modelResults.flat() };
};
