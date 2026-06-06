import { error } from '@sveltejs/kit';
import { getConversationDetail } from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';
import { getSiblingAssistants } from '$lib/server/db/queries/messages';
import { getInFlightSince } from '$lib/server/streaming/in-flight';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, parent }) => {
	// The (app) layout handles auth + loads the aggregated `models` list
	// shared by the per-turn picker and the sidebar favorites. Await it
	// so a redirect there beats our locals.user deref below.
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	const conversation = getConversationDetail(params.id, locals.user.id);
	if (!conversation) throw error(404, 'Conversation not found');

	// Whether a generation is running for this conversation right now,
	// per the server's in-flight registry — the source of truth the
	// chat page uses to restore the "Generating…" indicator after an
	// iOS suspension killed the client's fetch. Unix ms start time, or
	// null when nothing is in flight.
	const inFlightSince = getInFlightSince(params.id);

	// Friendly label for the assistant in message bubbles. Custom models
	// win because the user named them; otherwise we strip the verbose
	// "endpoint::owner/model" prefix down to just the recognizable slug.
	let assistantLabel = friendlyModelName(conversation.modelId);
	if (conversation.customModelId) {
		const cm = getCustomModelForUser(conversation.customModelId, locals.user.id);
		if (cm) assistantLabel = cm.name;
	}

	// Multi-model fan-out rehydration: when the active-branch tail is a user
	// message (the leaf was pinned there while N branches generated and the
	// user hasn't picked a winner yet), surface its assistant siblings so the
	// page can re-render the compare columns after a reload. Only a genuine
	// fan-out parks the leaf on a user message with assistant children —
	// normal sends and retries always advance the leaf onto the assistant.
	const branch = conversation.messages;
	const tail = branch[branch.length - 1];
	const fanoutSiblings =
		tail?.role === 'user' ? getSiblingAssistants(conversation.id, tail.id) : [];

	return { conversation, assistantLabel, inFlightSince, fanoutSiblings };
};
