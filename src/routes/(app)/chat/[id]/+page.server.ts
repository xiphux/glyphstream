import { error } from '@sveltejs/kit';
import { getConversationDetail } from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
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

	return { conversation, assistantLabel };
};
