import { error } from '@sveltejs/kit';
import { getConversationDetail, getFanoutParent } from '$lib/server/db/queries/conversations';
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

	// Multi-model fan-out rehydration: a conversation with an unresolved
	// fan-out carries an explicit marker (fanout_parent_message_id, set by
	// .../prepare, cleared on pick/dismiss). When it points at the current
	// active leaf, surface that user message's assistant siblings so the page
	// re-renders the compare grid after a reload. The explicit marker (vs.
	// guessing from "tail is a user message with N children") means a retry or
	// truncate parked on a user message can't masquerade as a fan-out, and a
	// single surviving branch is still surfaced.
	const fanoutParent = getFanoutParent(conversation.id);
	const fanoutSiblings =
		fanoutParent && fanoutParent === conversation.activeLeafMessageId
			? getSiblingAssistants(conversation.id, fanoutParent)
			: [];

	return { conversation, assistantLabel, inFlightSince, fanoutSiblings };
};
