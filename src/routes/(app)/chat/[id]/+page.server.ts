import { error, redirect } from '@sveltejs/kit';
import { CONVERSATION_MISSING_NOTICE } from '$lib/notices';
import { getConversationDetail } from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';
import { getFanoutRecoveryState } from '$lib/server/messages/fanout-recovery';
import { getInFlightSince } from '$lib/server/streaming/in-flight';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, parent }) => {
	// The (app) layout handles auth + loads the aggregated `models` list
	// shared by the per-turn picker and the sidebar favorites. Await it
	// so a redirect there beats our locals.user deref below.
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	const conversation = getConversationDetail(params.id, locals.user.id);
	// Send the user home rather than 404, and let the new-chat page raise a
	// toast. A 404 here is a dead end in the standalone PWA — no back button,
	// no chrome, nothing to tap — and the most common way to reach one is a
	// stale OS notification for a conversation deleted on another device.
	if (!conversation) throw redirect(302, `/?notice=${CONVERSATION_MISSING_NOTICE}`);

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

	// Multi-model fan-out recovery: a conversation with an unresolved fan-out
	// carries an explicit marker (fanout_parent_message_id, set by .../prepare,
	// cleared on pick/dismiss). When it points at the current active leaf, the
	// page rebuilds the compare grid from the persisted branches + the count
	// still generating — so a reload mid-fan-out (iOS suspended the PWA) shows
	// the completed images plus "generating" placeholders, and the poll fills
	// the rest in as they land. The explicit marker means a retry/truncate
	// parked on a user message can't masquerade as a fan-out.
	const fanout = getFanoutRecoveryState(
		conversation.id,
		locals.user.id,
		conversation.activeLeafMessageId,
	);

	return { conversation, assistantLabel, inFlightSince, fanout };
};
